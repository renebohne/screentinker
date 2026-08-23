'use strict';

/*
 * "Add this content to every screen in the group."
 *
 * ⚠️ Members of a group that shares a playlist all resolve to the SAME playlist, so a loop over
 * DEVICES inserts the item once per member: add one image to a group of three screens and it
 * appears three times in a row. Pre-existing — the old copy-on-assign gave every member an
 * identical `playlist_id` too, so the loop was already writing to one playlist N times — and the
 * inheritance resolver does not change it. The fix is to insert once per DISTINCT playlist.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, BASE, DATA_DIR, jwt, workspaceId, PORT, contentId;

const J = (t, b, m = 'POST') => ({
  method: m,
  headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
  ...(b === undefined ? {} : { body: JSON.stringify(b) }),
});
const api = async (p, ...a) => { const r = await fetch(BASE + p, ...a); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const dbHandle = () => new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db'));

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gcf-'));
  const logFd = fs.openSync(path.join(DATA_DIR, 'server.log'), 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot');

  const reg = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `gcf${Date.now()}@example.com`, password: 'Passw0rd123', name: 'GCF',
  }))).json();
  jwt = reg.token; workspaceId = reg.current_workspace_id;

  const raw = dbHandle();
  contentId = crypto.randomUUID();
  const u = raw.prepare('SELECT id FROM users LIMIT 1').get();
  raw.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, duration_sec)
               VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(contentId, u.id, workspaceId, 'clip.mp4', 'uploads/clip.mp4', 'video/mp4', 10);
  raw.close();
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

test('⚠️ adding content to a group inserts it ONCE, not once per member', async () => {
  const raw = dbHandle();
  const u = raw.prepare('SELECT id FROM users LIMIT 1').get();
  const devIds = ['a', 'b', 'c'].map((n) => {
    const d = crypto.randomUUID();
    raw.prepare('INSERT INTO devices (id, user_id, workspace_id, name, pairing_code) VALUES (?, ?, ?, ?, ?)')
      .run(d, u.id, workspaceId, `screen-${n}`, crypto.randomUUID().slice(0, 6));
    return d;
  });
  raw.close();

  const group = (await api('/api/groups', J(jwt, { name: 'lobby' }))).body;
  const shared = (await api('/api/playlists', J(jwt, { name: 'lobby playlist' }))).body;
  assert.equal((await api(`/api/groups/${group.id}/assign-playlist`, J(jwt, { playlist_id: shared.id }))).status, 200);
  for (const d of devIds) {
    assert.equal((await api(`/api/groups/${group.id}/devices`, J(jwt, { device_id: d }))).status, 201);
  }

  assert.equal((await api(`/api/groups/${group.id}/assign-content`, J(jwt, { content_id: contentId }))).status, 200);

  const raw2 = dbHandle();
  const rows = raw2.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ? AND content_id = ?')
    .get(shared.id, contentId);
  const extras = raw2.prepare('SELECT COUNT(*) AS n FROM playlists WHERE is_auto_generated = 1').get();
  raw2.close();

  assert.equal(rows.n, 1,
    'three members all resolve to the group playlist, so a per-DEVICE loop inserted the same item '
    + 'three times — the operator adds one image and gets three in a row');
  assert.equal(extras.n, 0,
    'no member should have been given a private auto-generated playlist: they inherit the group\'s');
});

test('the group playlist is never copied onto member rows', async () => {
  const raw = dbHandle();
  const u = raw.prepare('SELECT id FROM users LIMIT 1').get();
  const d = crypto.randomUUID();
  raw.prepare('INSERT INTO devices (id, user_id, workspace_id, name, pairing_code) VALUES (?, ?, ?, ?, ?)')
    .run(d, u.id, workspaceId, 'solo', crypto.randomUUID().slice(0, 6));
  raw.close();

  const group = (await api('/api/groups', J(jwt, { name: 'atrium' }))).body;
  const pl = (await api('/api/playlists', J(jwt, { name: 'atrium playlist' }))).body;
  const j1 = await api(`/api/groups/${group.id}/devices`, J(jwt, { device_id: d }));
  const j2 = await api(`/api/groups/${group.id}/assign-playlist`, J(jwt, { playlist_id: pl.id }));
  assert.equal(j1.status, 201, JSON.stringify(j1.body));
  assert.equal(j2.status, 200, JSON.stringify(j2.body));

  const raw2 = dbHandle();
  const row = raw2.prepare('SELECT playlist_id, playlist_source FROM devices WHERE id = ?').get(d);
  const resolved = raw2.prepare('SELECT playlist_id FROM device_resolved_playlist WHERE device_id = ?').get(d);
  raw2.close();

  assert.equal(row.playlist_id, null, 'assign-playlist wrote to a device row; it should write only the group');
  assert.equal(row.playlist_source, null);
  assert.equal(resolved.playlist_id, pl.id, 'the member must still resolve to the group playlist');
});
