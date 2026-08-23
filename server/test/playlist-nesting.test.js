'use strict';

/*
 * Playlists of playlists, phase 1 (stateless). See docs/playlist-nesting-design.md.
 *
 * The design decision these tests pin: nesting is expanded in buildSnapshotItems() and NOWHERE
 * else, so `published_snapshot` stays a FLAT ordered array and no player learns what nesting is.
 * Industry research across 17 vendors found the flatten-vs-runtime split is decided by whether the
 * nested playlist has a CURSOR ("play N of the child per parent rotation") — a cursor is stateful
 * across parent loops and cannot be flattened. Phase 1 is deliberately stateless, so it flattens.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');
const { freePort } = require('./helpers/free-port');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, BASE, DATA_DIR, jwt, workspaceId, PORT, contentId;

const J = (t, b, m = 'POST') => ({
  method: m,
  headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
  ...(b === undefined ? {} : { body: JSON.stringify(b) }),
});
const api = async (p, ...a) => { const r = await fetch(BASE + p, ...a); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const newPlaylist = async (name) => (await api('/api/playlists', J(jwt, { name }))).body;
const addContent = (pl, dur = 10) => api(`/api/playlists/${pl}/items`, J(jwt, { content_id: contentId, duration_sec: dur }));
const addChild = (pl, child) => api(`/api/playlists/${pl}/items`, J(jwt, { child_playlist_id: child }));
const publish = (pl) => api(`/api/playlists/${pl}/publish`, J(jwt, {}));
const dbHandle = () => new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db'));
const snapshot = (pl) => {
  const raw = dbHandle();
  const row = raw.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(pl);
  raw.close();
  return row && row.published_snapshot ? JSON.parse(row.published_snapshot) : null;
};

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-'));
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
    email: `nest${Date.now()}@example.com`, password: 'Passw0rd123', name: 'Nest',
  }))).json();
  jwt = reg.token; workspaceId = reg.current_workspace_id;

  // A real content row so items have a filepath — the thing pinning and the trigger guard key on.
  const raw = dbHandle();
  contentId = crypto.randomUUID();
  const u = raw.prepare('SELECT id FROM users LIMIT 1').get();
  raw.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, duration_sec)
               VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(contentId, u.id, workspaceId, 'clip.mp4', 'uploads/clip.mp4', 'video/mp4', 10);
  raw.close();
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

test('⚠️ a child playlist is FLATTENED into the parent snapshot — the player never sees nesting', async () => {
  const child = await newPlaylist('child'); const parent = await newPlaylist('parent');
  await addContent(child.id); await addContent(child.id);
  await addContent(parent.id); await addChild(parent.id, child.id);
  await publish(child.id);
  assert.equal((await publish(parent.id)).status, 200);

  const snap = snapshot(parent.id);
  assert.equal(snap.length, 3, 'expected 1 own item + 2 expanded from the child');
  assert.ok(snap.every((i) => !i.child_playlist_id),
    'a child reference survived into the snapshot — the player would have to understand nesting');
  assert.ok(snap.every((i) => i.filepath),
    'expanded items lost their filepath, so offline pinning and the trigger guard would both miss them');
});

test('expansion preserves ORDER — the child lands where the reference sat', async () => {
  const child = await newPlaylist('c-order'); const parent = await newPlaylist('p-order');
  await addContent(child.id, 55);
  await addContent(parent.id, 11);
  await addChild(parent.id, child.id);
  await addContent(parent.id, 22);
  await publish(child.id); await publish(parent.id);
  assert.deepEqual(snapshot(parent.id).map((i) => i.duration_sec), [11, 55, 22]);
});

test('⚠️ depth is capped at 1, and the error NAMES the playlist', async () => {
  // Enforced by TYPE at creation, not by traversal at publish — which is also what makes A→B→A
  // unconstructible, so this feature has no cycle detector and needs none.
  const a = await newPlaylist('A'); const b = await newPlaylist('B'); const c = await newPlaylist('C');
  await addContent(c.id);
  assert.equal((await addChild(b.id, c.id)).status, 201, 'one level must be allowed');
  const deep = await addChild(a.id, b.id);
  assert.equal(deep.status, 400, 'two levels were allowed');
  assert.match(deep.body.error, /only nest one level/);
  assert.match(deep.body.error, /"C"/, 'the error must name the offending grandchild');
});

test('⚠️ the reverse direction is refused too — a child cannot take a child', async () => {
  // Without this, A (already inside B) could take C, giving B→A→C: two levels built from the far end.
  const outer = await newPlaylist('outer'); const mid = await newPlaylist('mid'); const leaf = await newPlaylist('leaf');
  await addContent(mid.id); await addContent(leaf.id);
  await addChild(outer.id, mid.id);
  const r = await addChild(mid.id, leaf.id);
  assert.equal(r.status, 400, 'a playlist already used as a child was allowed to take a child');
  assert.match(r.body.error, /already used inside "outer"/);
});

test('a playlist cannot contain itself', async () => {
  const p = await newPlaylist('self');
  const r = await addChild(p.id, p.id);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /cannot contain itself/);
});

test('an item is content, a widget, or a child — not two of them', async () => {
  const p = await newPlaylist('mixed'); const c = await newPlaylist('mixed-child');
  await addContent(c.id);
  const r = await api(`/api/playlists/${p.id}/items`, J(jwt, { content_id: contentId, child_playlist_id: c.id }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not more than one/);
});

test('a child from another workspace is refused', async () => {
  const other = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `nest2${Date.now()}@example.com`, password: 'Passw0rd123', name: 'Other',
  }))).json();
  const foreign = await (await fetch(BASE + '/api/playlists', J(other.token, { name: 'foreign' }))).json();
  const mine = await newPlaylist('mine');
  const r = await addChild(mine.id, foreign.id);
  assert.ok(r.status === 403 || r.status === 404, `expected a refusal, got ${r.status}`);
});

test('⚠️ publishing is refused while a nested reference expands to nothing', async () => {
  /*
   * "Three or more 'empty' nested playlists in succession may fail to skip, resulting in a black
   * screen. Affected: Samsung Tizen, BrightSign XD (8.5.47)." We ship BrightSign. The vendor's own
   * workaround lives in the operator's head; this puts it in the product.
   */
  const empty = await newPlaylist('empty-one'); const parent = await newPlaylist('p-empty');
  await addContent(parent.id);
  await addChild(parent.id, empty.id);
  const r = await publish(parent.id);
  assert.equal(r.status, 400, 'an empty nested playlist was published');
  assert.match(r.body.error, /"empty-one"/, 'the error must name which child is empty');
  assert.match(r.body.error, /black screen/);

  await addContent(empty.id);
  assert.equal((await publish(parent.id)).status, 200, 'filling the child must unblock the publish');
});

test('⚠️ republishing an UNCHANGED playlist writes nothing — the restart must be change-triggered', async () => {
  /*
   * A child edit changes every ancestor's flattened items, so the player's structural fingerprint
   * changes and every screen showing an ancestor restarts at item 1 (#234, estate-wide). This is
   * the mitigation BrightSign ships as CONTENT_DATA_FEED_UNCHANGED: if the resolved snapshot is
   * byte-identical, do not write and do not push.
   */
  const child = await newPlaylist('c-nochange'); const parent = await newPlaylist('p-nochange');
  await addContent(child.id); await addContent(parent.id); await addChild(parent.id, child.id);
  await publish(child.id); await publish(parent.id);

  const raw = dbHandle();
  const before = raw.prepare('SELECT updated_at, published_snapshot FROM playlists WHERE id = ?').get(parent.id);
  raw.close();
  await sleep(1100);                       // updated_at has 1-second resolution
  assert.equal((await publish(parent.id)).status, 200);
  const raw2 = dbHandle();
  const after = raw2.prepare('SELECT updated_at, published_snapshot FROM playlists WHERE id = ?').get(parent.id);
  raw2.close();
  assert.equal(after.published_snapshot, before.published_snapshot, 'the snapshot changed with no edit');
  assert.equal(after.updated_at, before.updated_at,
    'an unchanged republish bumped updated_at, which would push and restart every screen');
});

test('⚠️ publishing a CHILD reaches a device that only holds the PARENT', async () => {
  /*
   * A nested child is nobody's playlist_id, so the base-playlist query cannot see those devices.
   * This is the THIRD time this shape has bitten: pushToDevices missed trigger-target devices, and
   * the trigger routes pushed nothing at all. Asserted over a real socket, because asserting on the
   * database would prove resolution rather than delivery.
   */
  const child = await newPlaylist('c-push'); const parent = await newPlaylist('p-push');
  await addContent(child.id); await addContent(parent.id); await addChild(parent.id, child.id);
  await publish(child.id); await publish(parent.id);

  const code = String(crypto.randomInt(100000, 1000000));
  const dev = await new Promise((res, rej) => {
    const s = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    s.on('connect', () => s.emit('device:register', { pairing_code: code }));
    s.on('device:registered', (d) => { s.close(); res({ id: d.device_id, token: d.device_token }); });
    setTimeout(() => rej(new Error('provision timeout')), 15000);
  });
  await api('/api/provision/pair', J(jwt, { pairing_code: code, name: 'Nest panel' }));
  await api(`/api/playlists/${parent.id}/assign`, J(jwt, { device_id: dev.id }));

  const sock = await new Promise((res, rej) => {
    const s = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    s.on('connect', () => s.emit('device:register', { device_id: dev.id, device_token: dev.token, device_info: { app_version: 't' } }));
    s.on('device:registered', () => res(s));
    setTimeout(() => rej(new Error('register timeout')), 15000);
  });
  try {
    const seen = new Promise((res) => {
      const t = setTimeout(() => res(null), 6000);
      sock.on('device:playlist-update', (p) => {
        if ((p.assignments || []).some((a) => a.duration_sec === 77)) { clearTimeout(t); res(p); }
      });
    });
    await addContent(child.id, 77);        // edit the CHILD only
    await publish(child.id);
    const payload = await seen;
    assert.ok(payload, 'publishing the child never reached a device that only holds the parent');
  } finally { try { sock.close(); } catch { /* */ } }
});
