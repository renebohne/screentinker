'use strict';

/*
 * 3.0 screen share — who may start, stop and configure a share, against the REAL server with a
 * real Socket.IO device (routes/screen-share.js, routes/screen-share-guest.js, the deviceSocket
 * hooks). The relay itself is pinned in screen-share.test.js; a real browser in -e2e.test.js.
 *
 *   - editor+ can start; a workspace_viewer cannot; another tenant cannot even see the screen
 *   - only screens that DECLARE remote.screen_share are offered, and only while online
 *   - one share at a time; an editor can stop (kick) a share; the time limit is reported
 *   - the meeting-room code: off by default, admin-only switch, pushed to the screen, single-use,
 *     generic failure, rate-limited, gone when switched off; a guest join is audited
 *   - the screen's Socket.IO disconnect ends the share for the sharer
 *   - the workspace switch is admin-only and ends shares in progress
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const ioClient = require('socket.io-client');
const { freePort } = require('./helpers/free-port');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, BASE, DATA_DIR, LOG;
const U = {};
let DEV, DEV_OLD, DEV_OTHER;
const TOK = 'devtok_' + crypto.randomBytes(12).toString('hex');
const TOK_OLD = 'devtok_' + crypto.randomBytes(12).toString('hex');
const sockets = [];

const dbRun = (fn) => { const r = new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db')); try { return fn(r); } finally { r.close(); } };
const run = (sql, ...a) => dbRun((d) => d.prepare(sql).run(...a));
const get = (sql, ...a) => dbRun((d) => d.prepare(sql).get(...a));

async function call(who, method, p, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) { headers.Authorization = `Bearer ${U[who].token}`; headers['X-Workspace-Id'] = U[who].ws; }
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}

async function register(name) {
  const r = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${name}-${Date.now()}@share.test`, password: 'Passw0rd123', name }),
  });
  const b = await r.json();
  assert.equal(r.status, 201, JSON.stringify(b));
  U[name] = { token: b.token, id: b.user.id, ws: b.current_workspace_id };
}

/** A device on the real /device namespace, recording what the server sends it. */
function connectDevice(id, token, capabilities) {
  return new Promise((resolve, reject) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(sock);
    sock.got = [];
    sock.onAny((ev, data) => sock.got.push({ ev, data }));
    const t = setTimeout(() => reject(new Error('register timeout ' + id)), 8000);
    sock.on('connect', () => sock.emit('device:register', { device_id: id, device_token: token, capabilities, device_info: { app_version: 'test' } }));
    sock.on('device:registered', () => { clearTimeout(t); resolve(sock); });
    sock.on('device:auth-error', (e) => { clearTimeout(t); reject(new Error('auth ' + JSON.stringify(e))); });
  });
}
async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await sleep(40);
  }
}
const lastCode = (sock) => [...sock.got].reverse().find((g) => g.ev === 'device:screenshare-code');

function wsClient(p) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(BASE.replace(/^http/, 'ws') + p);
    s.msgs = [];
    s.on('message', (d) => s.msgs.push(JSON.parse(d.toString())));
    s.closed = new Promise((r) => s.on('close', r));
    s.on('open', () => resolve(s));
    s.on('error', reject);
  });
}

let devSock;

before(async () => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-share-routes-'));
  LOG = path.join(DATA_DIR, 'server.log');
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', SCREEN_SHARE_MAX_MINUTES: '30' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    try { up = (await fetch(BASE + '/api/status')).ok; } catch { /* booting */ }
    if (!up) await sleep(250);
  }
  if (!up) throw new Error('server did not boot: ' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  await register('owner');      // first user: platform admin + admin of their own workspace
  await register('editor');
  await register('viewer');
  await register('outsider');   // their own workspace, nothing in ours
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')", U.owner.ws, U.editor.id);
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')", U.owner.ws, U.viewer.id);
  U.editor.ws = U.owner.ws; U.viewer.ws = U.owner.ws;
  DEV = crypto.randomUUID(); DEV_OLD = crypto.randomUUID(); DEV_OTHER = crypto.randomUUID();
  const ins = "INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, device_token) VALUES (?, ?, ?, ?, ?, 'offline', ?)";
  run(ins, DEV, U.owner.id, U.owner.ws, 'Boardroom', crypto.randomUUID().slice(0, 6), TOK);
  run(ins, DEV_OLD, U.owner.id, U.owner.ws, 'Old TV', crypto.randomUUID().slice(0, 6), TOK_OLD);
  run(ins, DEV_OTHER, U.outsider.id, U.outsider.ws, 'Their TV', crypto.randomUUID().slice(0, 6), 'devtok_' + crypto.randomBytes(12).toString('hex'));
  devSock = await connectDevice(DEV, TOK, ['playback.video', 'remote.screen_share']);
  await connectDevice(DEV_OLD, TOK_OLD, ['playback.video', 'remote.talk']);
});

after(async () => {
  for (const s of sockets) { try { s.close(); } catch { /* */ } }
  if (proc) await new Promise((r) => { proc.once('exit', r); proc.kill('SIGKILL'); });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('status advertises the feature; the card answers per screen with the right reason', async () => {
  const st = await call(null, 'GET', '/api/status');
  assert.equal(st.body.features.screen_share, true);
  const ok = await call('editor', 'GET', `/api/screen-share/devices/${DEV}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.available, true);
  assert.equal(ok.body.supported, true);
  assert.equal(ok.body.can_share, true);
  assert.equal(ok.body.can_admin, false);
  assert.equal(ok.body.guest_enabled, false, 'meeting-room code is off by default');
  assert.equal(ok.body.max_seconds, 1800);
  const old = await call('editor', 'GET', `/api/screen-share/devices/${DEV_OLD}`);
  assert.equal(old.body.supported, false);
  assert.equal(old.body.reason, 'unsupported');
  const v = await call('viewer', 'GET', `/api/screen-share/devices/${DEV}`);
  assert.equal(v.status, 200);
  assert.equal(v.body.can_share, false, 'a viewer sees the card but may not share');
});

test('tenancy: another workspace cannot see, start, stop or configure our screen', async () => {
  for (const [m, p, b] of [
    ['GET', `/api/screen-share/devices/${DEV}`],
    ['POST', `/api/screen-share/devices/${DEV}`, {}],
    ['DELETE', `/api/screen-share/devices/${DEV}`],
    ['PUT', `/api/screen-share/devices/${DEV}/guest`, { enabled: true }],
    ['PUT', `/api/screen-share/workspace/${U.owner.ws}`, { enabled: false }],
  ]) {
    const r = await call('outsider', m, p, b);
    assert.equal(r.status, 403, `${m} ${p} -> ${r.status}`);
  }
  const anon = await call(null, 'POST', `/api/screen-share/devices/${DEV}`, {});
  assert.equal(anon.status, 401);
});

test('a viewer cannot start, stop or configure; an editor cannot flip the admin switches', async () => {
  assert.equal((await call('viewer', 'POST', `/api/screen-share/devices/${DEV}`, {})).status, 403);
  assert.equal((await call('viewer', 'DELETE', `/api/screen-share/devices/${DEV}`)).status, 403);
  assert.equal((await call('viewer', 'PUT', `/api/screen-share/devices/${DEV}/guest`, { enabled: true })).status, 403);
  assert.equal((await call('editor', 'PUT', `/api/screen-share/devices/${DEV}/guest`, { enabled: true })).status, 403);
  assert.equal((await call('editor', 'PUT', `/api/screen-share/workspace/${U.owner.ws}`, { enabled: false })).status, 403);
  assert.equal(get('SELECT screen_share_guest AS g FROM devices WHERE id = ?', DEV).g, 0);
});

test('capability gating: a screen that does not declare it cannot be shared to', async () => {
  const r = await call('editor', 'POST', `/api/screen-share/devices/${DEV_OLD}`, {});
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'unsupported');
});

test('an editor starts a share; the screen is told only after the sharer connects; one at a time; the owner can kick', async () => {
  const r = await call('editor', 'POST', `/api/screen-share/devices/${DEV}`, { audio: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.ticket && r.body.session_id);
  assert.equal(r.body.ws_path, '/api/screen-share/ws');
  assert.ok(Array.isArray(r.body.ice_servers));
  assert.equal(r.body.screen_name, 'Boardroom');
  assert.ok(!devSock.got.some((g) => g.ev === 'device:screenshare-start'), 'nothing reaches the screen until the sharer connects');

  const busy = await call('owner', 'POST', `/api/screen-share/devices/${DEV}`, {});
  assert.equal(busy.status, 409);
  assert.equal(busy.body.reason, 'busy');

  const sharer = await wsClient('/api/screen-share/ws');
  sharer.send(JSON.stringify({ type: 'auth', ticket: r.body.ticket }));
  const startEv = await waitFor(() => devSock.got.find((g) => g.ev === 'device:screenshare-start'));
  assert.equal(startEv.data.session_id, r.body.session_id);
  assert.equal(startEv.data.shared_by, 'editor');
  assert.equal(startEv.data.audio, true);

  // The screen joins its leg with its token (first message, not the URL).
  const screen = await wsClient(`/api/devices/${DEV}/screen-share/ws`);
  screen.send(JSON.stringify({ type: 'auth', device_token: TOK, session_id: r.body.session_id }));
  await waitFor(() => screen.msgs.find((m) => m.type === 'ready'));

  const card = await call('viewer', 'GET', `/api/screen-share/devices/${DEV}`);
  assert.equal(card.body.session.shared_by, 'editor');
  assert.ok(!JSON.stringify(card.body).includes(r.body.ticket), 'the ticket is never shown again');

  const kick = await call('owner', 'DELETE', `/api/screen-share/devices/${DEV}`);
  assert.deepEqual(kick.body, { stopped: true });
  assert.equal((await waitFor(() => sharer.msgs.find((m) => m.type === 'ended'))).reason, 'stopped_by_owner');
  await waitFor(() => devSock.got.find((g) => g.ev === 'device:screenshare-stop' && g.data.session_id === r.body.session_id));
  const audit = get("SELECT * FROM activity_log WHERE action = 'screen_share.stop' AND details LIKE ?", `%${r.body.session_id}%`);
  assert.equal(audit.user_id, U.owner.id);
  assert.equal(audit.device_id, DEV);
  const startAudit = get("SELECT * FROM activity_log WHERE action = 'screen_share.start' AND details LIKE ?", `%${r.body.session_id}%`);
  assert.equal(startAudit.user_id, U.editor.id);
});

test('meeting-room code: admin switch, pushed to the screen, single-use, generic failure, audited guest', async () => {
  devSock.got.length = 0;
  const on = await call('owner', 'PUT', `/api/screen-share/devices/${DEV}/guest`, { enabled: true });
  assert.deepEqual(on.body, { guest_enabled: true });
  const pushed = await waitFor(() => { const c = lastCode(devSock); return c && c.data.code ? c : null; });
  assert.match(pushed.data.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.match(pushed.data.url, /\/share$/);
  assert.match(pushed.data.qr || '', /^data:image\/png;base64,/);
  assert.ok(get("SELECT 1 AS x FROM activity_log WHERE action = 'screen_share.guest_toggle' AND device_id = ?", DEV));
  // No API hands the code out — not even to an admin.
  const card = await call('owner', 'GET', `/api/screen-share/devices/${DEV}`);
  assert.ok(!JSON.stringify(card.body).includes(pushed.data.code.replace('-', '')));
  assert.ok(!JSON.stringify(card.body).includes(pushed.data.code));

  const wrong = await call(null, 'POST', '/api/share/join', { code: 'ZZZZ-ZZZZ', name: 'Eve' });
  assert.equal(wrong.status, 404);
  assert.equal(wrong.body.reason, 'invalid_code');

  const join = await call(null, 'POST', '/api/share/join', { code: pushed.data.code.toLowerCase(), name: '  Gail \u0007Guest ' });
  assert.equal(join.status, 201, JSON.stringify(join.body));
  assert.ok(join.body.ticket);
  assert.equal(join.body.screen_name, 'Boardroom');
  // Spent: the same code again fails with the same generic answer.
  const again = await call(null, 'POST', '/api/share/join', { code: pushed.data.code });
  assert.equal(again.status, 404);
  assert.equal(again.body.reason, 'invalid_code');
  // While busy the screen shows no code.
  await waitFor(() => { const c = lastCode(devSock); return c && c.data.code === null; });

  const sharer = await wsClient('/api/screen-share/ws');
  sharer.send(JSON.stringify({ type: 'auth', ticket: join.body.ticket }));
  const st = await waitFor(() => devSock.got.find((g) => g.ev === 'device:screenshare-start' && g.data.session_id === join.body.session_id));
  assert.equal(st.data.shared_by, 'Gail Guest');
  assert.equal(st.data.guest, true);
  const card2 = await call('editor', 'GET', `/api/screen-share/devices/${DEV}`);
  assert.equal(card2.body.session.guest, true);
  const audit = get("SELECT * FROM activity_log WHERE action = 'screen_share.guest_join' AND details LIKE ?", `%${join.body.session_id}%`);
  assert.equal(audit.user_id, null);
  assert.ok(audit.ip_address);

  // Ending the share brings a NEW code back to the screen.
  devSock.got.length = 0;
  sharer.close();
  await waitFor(() => devSock.got.find((g) => g.ev === 'device:screenshare-stop'));
  const fresh = await waitFor(() => { const c = lastCode(devSock); return c && c.data.code ? c : null; });
  assert.notEqual(fresh.data.code, pushed.data.code);

  // Switching the code off clears it from the screen and it stops working.
  devSock.got.length = 0;
  await call('owner', 'PUT', `/api/screen-share/devices/${DEV}/guest`, { enabled: false });
  await waitFor(() => { const c = lastCode(devSock); return c && c.data.code === null; });
  const dead = await call(null, 'POST', '/api/share/join', { code: fresh.data.code });
  assert.equal(dead.status, 404);
});

test('the screen dropping off Socket.IO ends the share for the sharer', async () => {
  const tok = 'devtok_' + crypto.randomBytes(12).toString('hex');
  const id = crypto.randomUUID();
  run("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, device_token) VALUES (?, ?, ?, 'Huddle', ?, 'offline', ?)", id, U.owner.id, U.owner.ws, crypto.randomUUID().slice(0, 6), tok);
  const sock = await connectDevice(id, tok, ['remote.screen_share']);
  const r = await call('editor', 'POST', `/api/screen-share/devices/${id}`, {});
  assert.equal(r.status, 201);
  const sharer = await wsClient('/api/screen-share/ws');
  sharer.send(JSON.stringify({ type: 'auth', ticket: r.body.ticket }));
  await waitFor(() => sock.got.find((g) => g.ev === 'device:screenshare-start'));
  sock.close();
  assert.equal((await waitFor(() => sharer.msgs.find((m) => m.type === 'ended'))).reason, 'screen_offline');
  const card = await call('editor', 'GET', `/api/screen-share/devices/${id}`);
  assert.equal(card.body.session, null);
  assert.equal(card.body.reason, 'offline');
});

test('the workspace switch is admin-only, ends shares in progress, and blocks new ones', async () => {
  const r = await call('editor', 'POST', `/api/screen-share/devices/${DEV}`, {});
  assert.equal(r.status, 201);
  const sharer = await wsClient('/api/screen-share/ws');
  sharer.send(JSON.stringify({ type: 'auth', ticket: r.body.ticket }));
  await waitFor(() => sharer.msgs.find((m) => m.type === 'ready'));
  const off = await call('owner', 'PUT', `/api/screen-share/workspace/${U.owner.ws}`, { enabled: false });
  assert.deepEqual(off.body, { enabled: false });
  assert.equal((await waitFor(() => sharer.msgs.find((m) => m.type === 'ended'))).reason, 'disabled_by_admin');
  const blocked = await call('editor', 'POST', `/api/screen-share/devices/${DEV}`, {});
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.reason, 'workspace_disabled');
  const ws = await call('owner', 'GET', `/api/screen-share/workspace/${U.owner.ws}`);
  assert.equal(ws.body.enabled, false);
  assert.equal((await call('owner', 'PUT', `/api/screen-share/workspace/${U.owner.ws}`, { enabled: true })).body.enabled, true);
});

test('the guest join is rate-limited per address', async () => {
  let limited = false;
  for (let i = 0; i < 14 && !limited; i++) {
    const r = await call(null, 'POST', '/api/share/join', { code: 'ABCD-EFGH' });
    if (r.status === 429) limited = true;
    else assert.equal(r.status, 404);
  }
  assert.ok(limited, 'guessing codes is throttled');
});

test('the share page is served under the strict dashboard CSP', async () => {
  const r = await fetch(BASE + '/share');
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp.split(';').find((d) => d.trim().startsWith('script-src')) || '', /unsafe-inline/);
  const html = await r.text();
  assert.match(html, /<script type="module" src="\/js\/share-page\.js"><\/script>/);
  const js = await fetch(BASE + '/player/screen-share.js');
  assert.equal(js.status, 200);
  assert.match(await js.text(), /window\.STScreenShare = STScreenShare/);
});
