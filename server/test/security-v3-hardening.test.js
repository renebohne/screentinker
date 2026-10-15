'use strict';

/*
 * 3.0 access-control hardening, against a real server process:
 *  - a read-only member cannot create a web-player display or pair a screen;
 *  - a device's default_content_id must be content its workspace may show (like layout_id);
 *  - a workspace_admin cannot demote an org owner's direct membership row;
 *  - group/workspace talk-stop needs write access to the scope before it deletes the shared stream;
 *  - an open dashboard socket re-resolves its session before a write, and a member removed from a
 *    workspace stops receiving that workspace's live events.
 *
 * go2rtc is a stub HTTP server here: it only records the DELETEs, which is what talk-stop does.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');
const { freePort } = require('./helpers/free-port');

const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'st-sec3-'));
const DATA_DIR = path.join(TMP, 'data');
let BASE, proc, sqlite, go2rtcStub;
const go2rtcDeletes = [];
const U = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(who, method, p, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (who && who.token) headers.Authorization = `Bearer ${who.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, text, json };
}

function connect(who) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE + '/dashboard', { auth: { token: who.token }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

before(async () => {
  go2rtcStub = http.createServer((req, res) => {
    if (req.method === 'DELETE') go2rtcDeletes.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
  });
  await new Promise((r) => go2rtcStub.listen(0, '127.0.0.1', r));

  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const logFd = fs.openSync(path.join(TMP, 'server.log'), 'w');
  const env = { ...process.env };
  delete env.DISABLE_REGISTRATION;
  Object.assign(env, {
    DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
    JWT_SECRET: 'sec3-' + crypto.randomBytes(24).toString('hex'),
    GO2RTC_URL: `http://127.0.0.1:${go2rtcStub.address().port}`,
  });
  proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await fetch(BASE + '/api/status')).ok; } catch { /* booting */ }
    if (!up) await sleep(250);
  }
  if (!up) throw new Error('server did not boot; see ' + path.join(TMP, 'server.log'));

  let n = 0;
  const reg = async (email, createOrg) => {
    const r = await api(null, 'POST', '/api/auth/register', { email, password: 'Passw0rd123!', createOrg }, { 'X-Forwarded-For': `192.0.2.${++n}` });
    assert.equal(r.status, 201, `register ${email}: ${r.text}`);
    return { token: r.json.token, id: r.json.user.id, ws: r.json.current_workspace_id };
  };
  U.platform = await reg('platform@sec3.local', true);   // first user is platform_admin; kept out of the way
  U.owner = await reg('owner@sec3.local', true);
  U.other = await reg('other@sec3.local', true);
  U.wsAdmin = await reg('wsadmin@sec3.local', false);
  U.editor = await reg('editor@sec3.local', false);
  U.viewer = await reg('viewer@sec3.local', false);

  const Database = require('better-sqlite3');
  sqlite = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  sqlite.pragma('busy_timeout = 5000');
  const add = sqlite.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)');
  add.run(U.owner.ws, U.wsAdmin.id, 'workspace_admin');
  add.run(U.owner.ws, U.editor.id, 'workspace_editor');
  add.run(U.owner.ws, U.viewer.id, 'workspace_viewer');
  for (const k of ['wsAdmin', 'editor', 'viewer']) U[k].headers = { 'X-Workspace-Id': U.owner.ws };
});

after(() => {
  try { if (proc) proc.kill('SIGKILL'); } catch { /* */ }
  try { if (sqlite) sqlite.close(); } catch { /* */ }
  try { if (go2rtcStub) go2rtcStub.close(); } catch { /* */ }
  if (!process.env.KEEP_TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } }
});

const as = (who, method, p, body) => api(who, method, p, body, who.headers || {});

test('a read-only member cannot create a web-player display or pair a screen', async () => {
  const before = sqlite.prepare('SELECT COUNT(*) AS n FROM devices WHERE workspace_id = ?').get(U.owner.ws).n;
  const wp = await as(U.viewer, 'POST', '/api/devices/web-player', { name: 'viewer screen' });
  assert.equal(wp.status, 403, wp.text);
  const pair = await as(U.viewer, 'POST', '/api/provision/pair', { pairing_code: '123456' });
  assert.equal(pair.status, 403, pair.text);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM devices WHERE workspace_id = ?').get(U.owner.ws).n, before);
  // An editor still can.
  const ok = await as(U.editor, 'POST', '/api/devices/web-player', { name: 'editor screen' });
  assert.equal(ok.status, 201, ok.text);
  U.deviceId = ok.json.device.id;
});

test('default_content_id must be content this device\'s workspace may show', async () => {
  const ins = sqlite.prepare("INSERT INTO content (id, user_id, workspace_id, filename, mime_type) VALUES (?, ?, ?, 'x.png', 'image/png')");
  const mine = crypto.randomUUID(), foreign = crypto.randomUUID();
  ins.run(mine, U.owner.id, U.owner.ws);
  ins.run(foreign, U.other.id, U.other.ws);
  const bad = await as(U.editor, 'PUT', `/api/devices/${U.deviceId}`, { default_content_id: foreign });
  assert.equal(bad.status, 400, bad.text);
  const missing = await as(U.editor, 'PUT', `/api/devices/${U.deviceId}`, { default_content_id: 'no-such-content' });
  assert.equal(missing.status, 400);
  const good = await as(U.editor, 'PUT', `/api/devices/${U.deviceId}`, { default_content_id: mine });
  assert.equal(good.status, 200, good.text);
  const cleared = await as(U.editor, 'PUT', `/api/devices/${U.deviceId}`, { default_content_id: null });
  assert.equal(cleared.status, 200, cleared.text);
});

test('a workspace_admin cannot demote the org owner\'s direct membership row; the owner can change theirs', async () => {
  const ownerRow = sqlite.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(U.owner.ws, U.owner.id);
  assert.ok(ownerRow, 'the owner has a direct row in their workspace');
  const r = await as(U.wsAdmin, 'PUT', `/api/workspaces/${U.owner.ws}/members/${U.owner.id}`, { role: 'workspace_viewer' });
  assert.equal(r.status, 403, r.text);
  assert.equal(sqlite.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(U.owner.ws, U.owner.id).role, ownerRow.role);
  const ok = await api(U.owner, 'PUT', `/api/workspaces/${U.owner.ws}/members/${U.editor.id}`, { role: 'workspace_editor' });
  assert.equal(ok.status, 200, ok.text);
});

test('talk-stop on a workspace scope needs write access there before the shared stream is deleted', async () => {
  const outsider = await connect(U.other);    // no access to the owner's workspace at all
  const viewer = await connect(U.viewer);     // read-only there
  const editor = await connect(U.editor);
  go2rtcDeletes.length = 0;
  outsider.emit('dashboard:group-talk-stop', { scope: { kind: 'workspace', id: U.owner.ws } });
  viewer.emit('dashboard:group-talk-stop', { scope: { kind: 'workspace', id: U.owner.ws } });
  await sleep(400);
  assert.equal(go2rtcDeletes.length, 0, 'no stream deleted for a caller without write access');
  editor.emit('dashboard:group-talk-stop', { scope: { kind: 'workspace', id: U.owner.ws } });
  for (let i = 0; i < 20 && !go2rtcDeletes.length; i++) await sleep(100);
  assert.equal(go2rtcDeletes.length, 1, 'an editor may stop it');
  for (const s of [outsider, viewer, editor]) s.close();
});

test('an open socket re-resolves its session before a write: a revoked session is refused and disconnected', async () => {
  const s = await connect(U.editor);
  const send = () => new Promise((r) => s.emit('dashboard:device-command', { device_id: U.deviceId, type: 'reboot' }, r));
  const first = await send();
  assert.notEqual(first.reason, 'forbidden', 'allowed while the session is live: ' + JSON.stringify(first));
  const gone = new Promise((r) => s.on('disconnect', r));
  sqlite.prepare('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?').run(U.editor.id);
  // The refusal disconnects the socket first, so the ack may never arrive: the disconnect is the answer.
  let second = null;
  s.emit('dashboard:device-command', { device_id: U.deviceId, type: 'reboot' }, (a) => { second = a; });
  assert.equal(await gone, 'io server disconnect');
  assert.ok(second === null || second.reason === 'forbidden', JSON.stringify(second));
});

test('a member removed from a workspace stops receiving its live events on an already-open socket', async () => {
  const s = await connect(U.viewer);
  const seen = [];
  s.on('dashboard:device-added', (d) => seen.push(d.name));
  const rm = await api(U.owner, 'DELETE', `/api/workspaces/${U.owner.ws}/members/${U.viewer.id}`);
  assert.equal(rm.status, 200, rm.text);
  const created = await api(U.owner, 'POST', '/api/devices/web-player', { name: 'after-removal' });
  assert.equal(created.status, 201, created.text);
  await sleep(500);
  assert.deepEqual(seen, [], 'the removed member got no event from the workspace');
  s.close();
});
