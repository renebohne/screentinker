'use strict';

/*
 * 3.0 multi share — one person's screen on several screens at once (lib/screen-share.js createShare,
 * routes/screen-share.js POST/DELETE /shares, GET /groups/:id), against the REAL server with real
 * Socket.IO screens and real signalling WebSockets:
 *
 *   - every screen the sharer names (or a group's) must be theirs to edit — a viewer, or one id from
 *     another tenant, refuses the WHOLE request and leaves nothing behind
 *   - screens that cannot take it (no receiver, offline) are skipped and named, never silently dropped
 *   - the limit (SCREEN_SHARE_MAX_TARGETS) refuses, with nothing created
 *   - per-leg isolation: each screen has its own ticket and session; one screen's token or session
 *     cannot attach to another's leg, and signalling never crosses between legs
 *   - a screen that disconnects drops out alone; the owner can stop one screen or all of them
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
const D = {};      // name -> { id, token, sock }
const sockets = [];
const opened = [];

const dbRun = (fn) => { const r = new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db')); try { return fn(r); } finally { r.close(); } };
const run = (sql, ...a) => dbRun((d) => d.prepare(sql).run(...a));
const all = (sql, ...a) => dbRun((d) => d.prepare(sql).all(...a));

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
    body: JSON.stringify({ email: `${name}-${Date.now()}@multi.test`, password: 'Passw0rd123', name }),
  });
  const b = await r.json();
  assert.equal(r.status, 201, JSON.stringify(b));
  U[name] = { token: b.token, id: b.user.id, ws: b.current_workspace_id };
}

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

async function waitFor(fn, ms = 4000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(40);
  }
}

function ws(p) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(BASE.replace(/^http/, 'ws') + p);
    opened.push(s);
    s.msgs = [];
    s.on('message', (d) => s.msgs.push(JSON.parse(d.toString())));
    s.closed = new Promise((r) => s.on('close', r));
    s.on('open', () => resolve(s));
    s.on('error', reject);
  });
}
const has = (s, type) => s.msgs.find((m) => m.type === type);

// Both legs of one screen up: the sharer's (ticket) then the screen's (device token + session).
async function connectLeg(leg, dev) {
  const sharer = await ws('/api/screen-share/ws');
  sharer.send(JSON.stringify({ type: 'auth', ticket: leg.ticket }));
  await waitFor(() => has(sharer, 'ready'), 4000, 'sharer ready');
  const screen = await ws(`/api/devices/${dev.id}/screen-share/ws`);
  screen.send(JSON.stringify({ type: 'auth', device_token: dev.token, session_id: leg.session_id }));
  await waitFor(() => has(screen, 'ready'), 4000, 'screen ready');
  return { sharer, screen };
}

const stopAll = async () => {
  for (const name of Object.keys(D)) await call('owner', 'DELETE', `/api/screen-share/devices/${D[name].id}`);
};

let GROUP, GROUP_OTHER;

before(async () => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-share-multi-'));
  LOG = path.join(DATA_DIR, 'server.log');
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', SCREEN_SHARE_MAX_TARGETS: '3' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    try { up = (await fetch(BASE + '/api/status')).ok; } catch { /* booting */ }
    if (!up) await sleep(250);
  }
  if (!up) throw new Error('server did not boot: ' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  await register('owner');
  await register('editor');
  await register('viewer');
  await register('outsider');
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')", U.owner.ws, U.editor.id);
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')", U.owner.ws, U.viewer.id);
  U.editor.ws = U.owner.ws; U.viewer.ws = U.owner.ws;

  const ins = "INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, device_token) VALUES (?, ?, ?, ?, ?, 'offline', ?)";
  const mk = (name, owner) => {
    const d = { id: crypto.randomUUID(), token: 'devtok_' + crypto.randomBytes(12).toString('hex'), name };
    run(ins, d.id, U[owner].id, U[owner].ws, name, crypto.randomUUID().slice(0, 6), d.token);
    D[name] = d;
    return d;
  };
  for (const n of ['A', 'B', 'C', 'E']) mk(n, 'owner');
  mk('OLD', 'owner');       // online, but its player has no receiver
  mk('OFF', 'owner');       // can show a share, but is offline
  mk('THEIRS', 'outsider');
  for (const n of ['A', 'B', 'C', 'E']) D[n].sock = await connectDevice(D[n].id, D[n].token, ['playback.video', 'remote.screen_share']);
  D.OLD.sock = await connectDevice(D.OLD.id, D.OLD.token, ['playback.video']);
  D.THEIRS.sock = await connectDevice(D.THEIRS.id, D.THEIRS.token, ['playback.video', 'remote.screen_share']);
  // OFF declared the capability once, then went away.
  run("UPDATE devices SET capabilities = ? WHERE id = ?", JSON.stringify(['playback.video', 'remote.screen_share']), D.OFF.id);

  GROUP = crypto.randomUUID();
  GROUP_OTHER = crypto.randomUUID();
  run('INSERT INTO device_groups (id, user_id, workspace_id, name) VALUES (?, ?, ?, ?)', GROUP, U.owner.id, U.owner.ws, 'Lobby');
  run('INSERT INTO device_groups (id, user_id, workspace_id, name) VALUES (?, ?, ?, ?)', GROUP_OTHER, U.outsider.id, U.outsider.ws, 'Theirs');
  for (const n of ['A', 'B', 'OLD']) run('INSERT INTO device_group_members (device_id, group_id) VALUES (?, ?)', D[n].id, GROUP);
  run('INSERT INTO device_group_members (device_id, group_id) VALUES (?, ?)', D.THEIRS.id, GROUP_OTHER);
});

after(async () => {
  for (const s of opened) { try { s.terminate(); } catch { /* */ } }
  for (const s of sockets) { try { s.close(); } catch { /* */ } }
  if (proc) await new Promise((r) => { proc.once('exit', r); proc.kill('SIGKILL'); });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('one share on two screens: one leg per screen, one share id, each screen told separately', async () => {
  const r = await call('editor', 'POST', '/api/screen-share/shares', { device_ids: [D.A.id, D.B.id] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.legs.length, 2);
  assert.deepEqual(r.body.legs.map((l) => l.device_id), [D.A.id, D.B.id]);
  assert.notEqual(r.body.legs[0].session_id, r.body.legs[1].session_id);
  assert.notEqual(r.body.legs[0].ticket, r.body.legs[1].ticket);
  assert.deepEqual(r.body.skipped, []);
  const [la, lb] = r.body.legs;
  const A = await connectLeg(la, D.A);
  await connectLeg(lb, D.B);
  // Each screen got ITS session, with the sharer's name for its own badge.
  for (const [dev, leg] of [[D.A, la], [D.B, lb]]) {
    const start = await waitFor(() => dev.sock.got.find((g) => g.ev === 'device:screenshare-start' && g.data.session_id === leg.session_id));
    assert.equal(start.data.shared_by, 'editor');
  }
  const st = await call('viewer', 'GET', `/api/screen-share/devices/${D.A.id}`);
  assert.equal(st.body.session.share_id, r.body.share_id);
  assert.equal(st.body.session.screens, 2);
  assert.equal(st.body.max_targets, 3);
  // Audit: one start row per screen, all naming the share.
  const rows = all("SELECT details FROM activity_log WHERE action = 'screen_share.start'").map((x) => JSON.parse(x.details || '{}'));
  assert.equal(rows.filter((d) => d.share_id === r.body.share_id).length, 2);

  // Per-leg isolation: A's offer reaches A's sharer only.
  A.screen.send(JSON.stringify({ type: 'webrtc/offer', value: 'v=0\r\nA-only' }));
  await waitFor(() => A.sharer.msgs.find((m) => m.type === 'webrtc/offer'));
  assert.equal(A.sharer.msgs.find((m) => m.type === 'webrtc/offer').value, 'v=0\r\nA-only');
  await stopAll();
});

test('a screen cannot attach to another screen\'s leg of the same share', async () => {
  const r = await call('editor', 'POST', '/api/screen-share/shares', { device_ids: [D.A.id, D.B.id] });
  assert.equal(r.status, 201);
  const [la, lb] = r.body.legs;
  const s1 = await ws('/api/screen-share/ws');
  s1.send(JSON.stringify({ type: 'auth', ticket: la.ticket }));
  const s2 = await ws('/api/screen-share/ws');
  s2.send(JSON.stringify({ type: 'auth', ticket: lb.ticket }));
  await waitFor(() => has(s1, 'ready') && has(s2, 'ready'));
  // B, with its own valid token, tries A's session: refused.
  const wrong = await ws(`/api/devices/${D.B.id}/screen-share/ws`);
  wrong.send(JSON.stringify({ type: 'auth', device_token: D.B.token, session_id: la.session_id }));
  await wrong.closed;
  assert.equal(has(wrong, 'ended').reason, 'invalid_session');
  // A's URL with B's token: refused too.
  const wrong2 = await ws(`/api/devices/${D.A.id}/screen-share/ws`);
  wrong2.send(JSON.stringify({ type: 'auth', device_token: D.B.token, session_id: la.session_id }));
  await wrong2.closed;
  assert.equal(has(wrong2, 'ended').reason, 'invalid_session');
  // A ticket is single-use: reusing A's ticket for a second sharer socket is refused.
  const again = await ws('/api/screen-share/ws');
  again.send(JSON.stringify({ type: 'auth', ticket: la.ticket }));
  await again.closed;
  assert.equal(has(again, 'ended').reason, 'invalid_ticket');
  await stopAll();
});

test('a viewer, or one screen from another tenant in the list, refuses the whole share and leaves nothing behind', async () => {
  const v = await call('viewer', 'POST', '/api/screen-share/shares', { device_ids: [D.A.id] });
  assert.equal(v.status, 403);
  const mixed = await call('editor', 'POST', '/api/screen-share/shares', { device_ids: [D.A.id, D.THEIRS.id] });
  assert.equal(mixed.status, 403);
  const ghost = await call('editor', 'POST', '/api/screen-share/shares', { device_ids: [D.A.id, crypto.randomUUID()] });
  assert.equal(ghost.status, 404);
  const outsider = await call('outsider', 'POST', '/api/screen-share/shares', { device_ids: [D.A.id] });
  assert.equal(outsider.status, 403);
  for (const n of ['A', 'THEIRS']) {
    const st = await call(n === 'A' ? 'owner' : 'outsider', 'GET', `/api/screen-share/devices/${D[n].id}`);
    assert.equal(st.body.session, null, `${n} must not be left busy`);
  }
  const none = await call('editor', 'POST', '/api/screen-share/shares', {});
  assert.equal(none.status, 400);
});

test('screens that cannot take it are skipped and named; none at all is a 409 with the reasons', async () => {
  const r = await call('editor', 'POST', '/api/screen-share/shares', { device_ids: [D.A.id, D.OLD.id, D.OFF.id] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.legs.map((l) => l.device_id), [D.A.id]);
  const why = Object.fromEntries(r.body.skipped.map((s) => [s.name, s.reason]));
  assert.deepEqual(why, { OLD: 'unsupported', OFF: 'offline' });
  // A is busy now: a second share including it skips it.
  const busy = await call('editor', 'POST', '/api/screen-share/shares', { device_ids: [D.A.id, D.OLD.id] });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.reason, 'none_available');
  assert.deepEqual(busy.body.skipped.map((s) => s.reason).sort(), ['busy', 'unsupported']);
  await stopAll();
});

test('more screens than SCREEN_SHARE_MAX_TARGETS: refused with the limit, nothing created', async () => {
  const r = await call('editor', 'POST', '/api/screen-share/shares', { device_ids: [D.A.id, D.B.id, D.C.id, D.E.id] });
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'too_many_targets');
  assert.equal(r.body.max_targets, 3);
  assert.match(r.body.error, /upload/);
  for (const n of ['A', 'B', 'C', 'E']) {
    assert.equal((await call('owner', 'GET', `/api/screen-share/devices/${D[n].id}`)).body.session, null);
  }
  // Duplicates are one screen, not two.
  const dup = await call('editor', 'POST', '/api/screen-share/shares', { device_ids: [D.A.id, D.A.id, D.B.id, D.B.id, D.C.id] });
  assert.equal(dup.status, 201);
  assert.equal(dup.body.legs.length, 3);
  await stopAll();
});

test('a group: its members that can show it, the rest named; viewers and other tenants refused', async () => {
  const info = await call('viewer', 'GET', `/api/screen-share/groups/${GROUP}`);
  assert.equal(info.status, 200);
  assert.equal(info.body.can_share, false);
  assert.deepEqual(info.body.screens.map((s) => [s.name, s.ok]).sort(), [['A', true], ['B', true], ['OLD', false]]);
  assert.equal(info.body.screens.find((s) => s.name === 'OLD').reason, 'unsupported');
  assert.equal((await call('outsider', 'GET', `/api/screen-share/groups/${GROUP}`)).status, 403);
  assert.equal((await call('viewer', 'POST', '/api/screen-share/shares', { group_id: GROUP })).status, 403);
  assert.equal((await call('editor', 'POST', '/api/screen-share/shares', { group_id: GROUP_OTHER })).status, 403);

  const r = await call('editor', 'POST', '/api/screen-share/shares', { group_id: GROUP });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.legs.map((l) => l.device_id).sort(), [D.A.id, D.B.id].sort());
  assert.deepEqual(r.body.skipped.map((s) => s.name), ['OLD']);
  await stopAll();
});

test('one screen disconnecting drops out alone; the owner can stop one screen, then all', async () => {
  const r = await call('editor', 'POST', '/api/screen-share/shares', { device_ids: [D.A.id, D.B.id, D.C.id] });
  assert.equal(r.status, 201);
  const legs = {};
  for (const l of r.body.legs) legs[l.device_id] = await connectLeg(l, Object.values(D).find((d) => d.id === l.device_id));

  // C's player drops off Socket.IO: only C's leg ends.
  D.C.sock.close();
  await waitFor(() => has(legs[D.C.id].sharer, 'ended'), 6000, 'C ended');
  assert.equal(has(legs[D.C.id].sharer, 'ended').reason, 'screen_offline');
  assert.equal(has(legs[D.A.id].sharer, 'ended'), undefined);
  assert.equal((await call('owner', 'GET', `/api/screen-share/devices/${D.A.id}`)).body.session.screens, 2);

  // The owner stops B only.
  const one = await call('owner', 'DELETE', `/api/screen-share/devices/${D.B.id}`);
  assert.deepEqual(one.body, { stopped: true });
  await waitFor(() => has(legs[D.B.id].sharer, 'ended'));
  assert.equal(has(legs[D.B.id].sharer, 'ended').reason, 'stopped_by_owner');
  assert.equal(has(legs[D.A.id].sharer, 'ended'), undefined, 'A still showing');

  // Stop-all: a viewer and another tenant cannot; an editor can.
  assert.equal((await call('viewer', 'DELETE', `/api/screen-share/shares/${r.body.share_id}`)).status, 403);
  assert.equal((await call('outsider', 'DELETE', `/api/screen-share/shares/${r.body.share_id}`)).status, 404);
  assert.equal((await call('editor', 'DELETE', `/api/screen-share/shares/${crypto.randomUUID()}`)).status, 404);
  const allStop = await call('editor', 'DELETE', `/api/screen-share/shares/${r.body.share_id}`);
  assert.deepEqual(allStop.body, { stopped: 1 });
  await waitFor(() => has(legs[D.A.id].sharer, 'ended'));
  assert.ok(D.A.sock.got.find((g) => g.ev === 'device:screenshare-stop' && g.data.session_id === r.body.legs[0].session_id));
  // C reconnects for any later test.
  D.C.sock = await connectDevice(D.C.id, D.C.token, ['playback.video', 'remote.screen_share']);
});

test('the one-screen API is unchanged and its share id is its session id', async () => {
  const r = await call('editor', 'POST', `/api/screen-share/devices/${D.E.id}`, {});
  assert.equal(r.status, 201);
  const st = await call('owner', 'GET', `/api/screen-share/devices/${D.E.id}`);
  assert.equal(st.body.session.share_id, r.body.session_id);
  assert.equal(st.body.session.screens, 1);
  assert.equal(st.body.platform, 'web');
  const stop = await call('editor', 'DELETE', `/api/screen-share/shares/${r.body.session_id}`);
  assert.deepEqual(stop.body, { stopped: 1 });
});

/*
 * 3.0 display-link mirrors (lib/mirrors.js): a share to a display also reaches the places its link
 * is open (expandShareTargets). A mirror is best-effort: one the sharer cannot reach is left out,
 * never a reason to refuse the share to the display that was asked for.
 */
test('a share to a display also reaches its mirrors; an unreachable mirror is skipped, not refused', async () => {
  const ins = "INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, device_token, mirror_of) VALUES (?, ?, ?, ?, ?, 'offline', ?, ?)";
  const M = { id: crypto.randomUUID(), token: 'devtok_' + crypto.randomBytes(12).toString('hex'), name: 'C (mirror 1)' };
  run(ins, M.id, U.owner.id, U.owner.ws, M.name, crypto.randomUUID().slice(0, 6), M.token, D.C.id);
  D.CM = M;
  // A row naming C as its original from ANOTHER tenant cannot happen through the socket; if it did,
  // it must not get the share, nor sink the share to C.
  const X = crypto.randomUUID();
  run(ins, X, U.outsider.id, U.outsider.ws, 'stray', crypto.randomUUID().slice(0, 6), 'devtok_' + crypto.randomBytes(12).toString('hex'), D.C.id);
  M.sock = await connectDevice(M.id, M.token, ['playback.video', 'remote.screen_share']);

  const r = await call('editor', 'POST', '/api/screen-share/shares', { device_ids: [D.C.id] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.legs.map((l) => l.device_id), [D.C.id, M.id], 'the display, then its mirror');
  assert.ok(!r.body.legs.some((l) => l.device_id === X), 'never a screen the sharer cannot reach');
  const leg = r.body.legs[1];
  await connectLeg(leg, M);
  await waitFor(() => M.sock.got.find((g) => g.ev === 'device:screenshare-start' && g.data.session_id === leg.session_id), 4000, 'the mirror told to show the share');
  await stopAll();
  run('DELETE FROM devices WHERE id = ?', X);
});
