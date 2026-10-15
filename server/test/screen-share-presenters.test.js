'use strict';

/*
 * 3.0 screen share — SEVERAL PEOPLE AT ONCE on one screen (lib/screen-share.js rooms,
 * routes/screen-share.js /multi /spotlight /presenters, docs/screen-share.md), against the REAL
 * server with real Socket.IO screens and real signalling WebSockets:
 *
 *   - off (the default): exactly today's one-at-a-time behaviour
 *   - on: slot accounting up to the platform limit; the meeting-room code stays on screen while a
 *     slot is free and is SPENT by every join (a new one at once); none when full; back on leave;
 *     guests and editors take slots alike; nameless guests are numbered
 *   - control: the owner (editor+) and the FIRST presenter may spotlight / remove; another guest is
 *     refused; viewers and other tenants are refused; a removed guest cannot rejoin with their code
 *   - layout: device:screenshare-layout names the spotlighted session and the ONE session whose
 *     sound plays, per screen
 *   - capability fallback: a mirror that cannot tile shows one presenter (the first, then the
 *     spotlighted one); the others are told "this screen shows one presenter at a time"
 *   - mirrors x presenters: one leg per presenter per screen, within the per-share target limit
 *   - the switch turned off mid-share keeps everyone and admits nobody new; the platform limit
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
const sockets = [];
const opened = [];
const CAPS = ['playback.video', 'remote.screen_share'];
const TILES = ['playback.video', 'remote.screen_share', 'remote.screen_share_tiles'];

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
    body: JSON.stringify({ email: `${name}-${Date.now()}@presenters.test`, password: 'Passw0rd123', name }),
  });
  const b = await r.json();
  assert.equal(r.status, 201, JSON.stringify(b));
  U[name] = { token: b.token, id: b.user.id, ws: b.current_workspace_id };
}

function connectDevice(dev, capabilities = TILES) {
  return new Promise((resolve, reject) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(sock);
    sock.got = [];
    sock.onAny((ev, data) => sock.got.push({ ev, data }));
    const t = setTimeout(() => reject(new Error('register timeout ' + dev.id)), 8000);
    sock.on('connect', () => sock.emit('device:register', { device_id: dev.id, device_token: dev.token, capabilities, device_info: { app_version: 'test' } }));
    sock.on('device:registered', () => { clearTimeout(t); dev.sock = sock; resolve(sock); });
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
const last = (s, type) => s.msgs.filter((m) => m.type === type).pop();

function lastCode(dev) {
  const got = dev.sock.got.filter((g) => g.ev === 'device:screenshare-code');
  return got.length ? got[got.length - 1].data.code : undefined;
}
function lastLayout(dev) {
  const got = dev.sock.got.filter((g) => g.ev === 'device:screenshare-layout');
  return got.length ? got[got.length - 1].data : undefined;
}
const startsFor = (dev) => dev.sock.got.filter((g) => g.ev === 'device:screenshare-start').map((g) => g.data);

const mkDevice = (name, owner, extra = {}) => {
  const d = { id: crypto.randomUUID(), token: 'devtok_' + crypto.randomBytes(12).toString('hex'), name };
  run(`INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, device_token, mirror_of, screen_share_guest, screen_share_multi)
       VALUES (?, ?, ?, ?, ?, 'offline', ?, ?, ?, ?)`,
  d.id, U[owner].id, U[owner].ws, name, crypto.randomUUID().slice(0, 6), d.token, extra.mirror_of || null, extra.guest ? 1 : 0, extra.multi ? 1 : 0);
  return d;
};

// Every guest from its own address, so the per-address join limit is not what a test measures.
let ipN = 10;
async function guestJoin(code, body = {}) {
  ipN++;
  const r = await fetch(BASE + '/api/share/join', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.9.0.${ipN}` },
    body: JSON.stringify({ code, ...body }),
  });
  return { status: r.status, body: await r.json() };
}

// Open the sharer socket of every leg; returns the legs with ._sharer.
async function openLegs(legs) {
  for (const l of legs) {
    l._sharer = await ws('/api/screen-share/ws');
    l._sharer.send(JSON.stringify({ type: 'auth', ticket: l.ticket }));
    await waitFor(() => has(l._sharer, 'ready'), 4000, 'sharer leg ready');
  }
  return legs;
}
// The screen side of one session (a player opening its leg).
async function screenLeg(dev, sessionId) {
  const s = await ws(`/api/devices/${dev.id}/screen-share/ws`);
  s.send(JSON.stringify({ type: 'auth', device_token: dev.token, session_id: sessionId }));
  await waitFor(() => has(s, 'ready') || has(s, 'ended'), 4000, 'screen leg answer');
  return s;
}

async function newCode(dev, notThis) {
  return waitFor(() => { const c = lastCode(dev); return c && c !== notThis ? c : null; }, 4000, 'a new code on ' + dev.name);
}

const status = async (dev, who = 'owner') => (await call(who, 'GET', `/api/screen-share/devices/${dev.id}`)).body;

before(async () => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-share-presenters-'));
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
  await register('owner');      // first user: the platform admin on a self-hosted server
  await register('editor');
  await register('viewer');
  await register('outsider');
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')", U.owner.ws, U.editor.id);
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')", U.owner.ws, U.viewer.id);
  U.editor.ws = U.owner.ws; U.viewer.ws = U.owner.ws;
});

after(async () => {
  for (const s of opened) { try { s.terminate(); } catch { /* */ } }
  for (const s of sockets) { try { s.close(); } catch { /* */ } }
  if (proc) await new Promise((r) => { proc.once('exit', r); proc.kill('SIGKILL'); });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('off (the default): one share at a time, no code while it runs — exactly as before', async () => {
  const D = mkDevice('Huddle', 'owner', { guest: true });
  await connectDevice(D);
  const code = await newCode(D);
  const st = await status(D);
  assert.equal(st.multi.enabled, false);
  assert.equal(st.multi.supported, true, 'this player can tile');
  assert.equal(st.multi.slots, 1);
  const a = await guestJoin(code, { name: 'Ann' });
  assert.equal(a.status, 201);
  await waitFor(() => lastCode(D) === null, 4000, 'no code while the one slot is taken');
  const ed = await call('editor', 'POST', `/api/screen-share/devices/${D.id}`, {});
  assert.equal(ed.status, 409);
  assert.equal(ed.body.reason, 'busy');
  await call('owner', 'DELETE', `/api/screen-share/devices/${D.id}`);
  await newCode(D, code);
  D.sock.close();
});

test('the switch: workspace admins only, on the display, and only "several" where the player can tile', async () => {
  const D = mkDevice('Switchy', 'owner');
  const OLD = mkDevice('Old TV', 'owner');
  const M = mkDevice('Switchy (mirror)', 'owner', { mirror_of: D.id });
  await connectDevice(D);
  await connectDevice(OLD, CAPS);
  assert.equal((await call('editor', 'PUT', `/api/screen-share/devices/${D.id}/multi`, { enabled: true })).status, 403);
  assert.equal((await call('viewer', 'PUT', `/api/screen-share/devices/${D.id}/multi`, { enabled: true })).status, 403);
  assert.equal((await call('outsider', 'PUT', `/api/screen-share/devices/${D.id}/multi`, { enabled: true })).status, 403);
  const mirror = await call('owner', 'PUT', `/api/screen-share/devices/${M.id}/multi`, { enabled: true });
  assert.equal(mirror.status, 409);
  assert.equal(mirror.body.reason, 'mirror');
  const on = await call('owner', 'PUT', `/api/screen-share/devices/${D.id}/multi`, { enabled: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.slots, 4);
  const row = all("SELECT details FROM activity_log WHERE action = 'screen_share.multi_toggle' AND device_id = ?", D.id);
  assert.equal(row.length, 1);
  // A mirror reports its display's switch.
  const ms = await status(M);
  assert.equal(ms.multi.enabled, true);
  // A player that cannot tile: the switch can be on, but it stays one at a time.
  await call('owner', 'PUT', `/api/screen-share/devices/${OLD.id}/multi`, { enabled: true });
  const os1 = await status(OLD);
  assert.equal(os1.multi.supported, false);
  assert.equal(os1.multi.slots, 1);
  const s1 = await call('owner', 'POST', `/api/screen-share/devices/${OLD.id}`, {});
  assert.equal(s1.status, 201);
  const s2 = await call('editor', 'POST', `/api/screen-share/devices/${OLD.id}`, {});
  assert.equal(s2.status, 409, 'a screen that cannot tile takes one presenter');
  await call('owner', 'DELETE', `/api/screen-share/devices/${OLD.id}`);
  D.sock.close(); OLD.sock.close();
});

test('slots: the code stays while a slot is free, every join spends it, none when full, back on leave', async () => {
  const D = mkDevice('Boardroom', 'owner', { guest: true, multi: true });
  await connectDevice(D);
  const c1 = await newCode(D);

  // Guest 1 (no name -> "Guest 1"), with sound.
  const g1 = await guestJoin(c1, { audio: true });
  assert.equal(g1.status, 201, JSON.stringify(g1.body));
  await openLegs(g1.body.legs);
  const c2 = await newCode(D, c1);
  assert.notEqual(c2, c1, 'the code was spent and replaced at once');
  assert.equal((await guestJoin(c1)).status, 404, 'the spent code is refused');

  // Guest 2 with the code read off the screen after the first join.
  const g2 = await guestJoin(c2, {});
  assert.equal(g2.status, 201);
  await openLegs(g2.body.legs);
  const c3 = await newCode(D, c2);

  // An editor from the dashboard takes a slot the same way (and spends the code).
  const ed = await call('editor', 'POST', `/api/screen-share/devices/${D.id}`, {});
  assert.equal(ed.status, 201, JSON.stringify(ed.body));
  await openLegs(ed.body.legs);
  const c4 = await newCode(D, c3);
  assert.equal((await guestJoin(c3)).status, 404, 'the editor\'s join spent that code');

  // The fourth fills the room: no code at all.
  const g4 = await guestJoin(c4, { name: 'Dana', audio: true });
  assert.equal(g4.status, 201);
  await openLegs(g4.body.legs);
  await waitFor(() => lastCode(D) === null, 4000, 'no code while full');
  const fifth = await call('owner', 'POST', `/api/screen-share/devices/${D.id}`, {});
  assert.equal(fifth.status, 409);
  assert.equal(fifth.body.reason, 'busy');

  // The screen was told to show each one, and the presenters list is first-come first.
  await waitFor(() => startsFor(D).length === 4, 4000, 'four starts on the screen');
  assert.deepEqual(startsFor(D).map((s) => s.shared_by), ['Guest 1', 'Guest 2', 'editor', 'Dana']);
  const st = await status(D);
  assert.equal(st.presenters.length, 4);
  assert.equal(st.presenters[0].first, true);
  assert.equal(st.presenters[0].shared_by, 'Guest 1');
  assert.ok(st.presenters.every((p) => !('ticket' in p) && !('ip' in p)));

  // Whose sound plays: the most recent presenter who shared sound (Dana), in this screen's ids.
  const danaSession = startsFor(D).find((s) => s.shared_by === 'Dana').session_id;
  const g1Session = startsFor(D).find((s) => s.shared_by === 'Guest 1').session_id;
  await waitFor(() => lastLayout(D) && lastLayout(D).audio === danaSession && lastLayout(D).count === 4, 4000, 'Dana\'s sound');
  assert.equal(lastLayout(D).spotlight, null);

  // Someone leaves: a fresh code comes back.
  g2.body.legs[0]._sharer.send(JSON.stringify({ type: 'stop' }));
  const c5 = await newCode(D, null);
  assert.ok(![c1, c2, c3, c4].includes(c5));
  // Dana leaves: Guest 1 (the other one with sound) is heard now.
  g4.body.legs[0]._sharer.send(JSON.stringify({ type: 'stop' }));
  await waitFor(() => lastLayout(D) && lastLayout(D).audio === g1Session, 4000, 'Guest 1\'s sound');

  // Everyone leaves: content again, and a new code.
  await call('owner', 'DELETE', `/api/screen-share/devices/${D.id}`);
  const after = await newCode(D, c5);
  assert.ok(after);
  assert.equal((await status(D)).presenters.length, 0);
  D.sock.close();
});

test('control: the owner and the first presenter may spotlight and remove; another guest may not', async () => {
  const D = mkDevice('Classroom', 'owner', { guest: true, multi: true });
  await connectDevice(D);
  const a = await guestJoin(await newCode(D), { name: 'Ada' });
  await openLegs(a.body.legs);
  const boCodeUsed = await newCode(D, null);
  const b = await guestJoin(boCodeUsed, { name: 'Bo' });
  await openLegs(b.body.legs);
  const A = a.body.legs[0]._sharer, B = b.body.legs[0]._sharer;

  // Each page learns who is in the room; only Ada (first) may control it.
  const roomA = await waitFor(() => { const m = last(A, 'room'); return m && m.presenters.length === 2 ? m : null; }, 4000, 'room state for Ada');
  const roomB = await waitFor(() => { const m = last(B, 'room'); return m && m.presenters.length === 2 ? m : null; }, 4000, 'room state for Bo');
  assert.equal(roomA.can_control, true);
  assert.equal(roomA.first, true);
  assert.equal(roomB.can_control, false);
  assert.equal(roomA.screen_name, 'Classroom');
  const adaId = roomA.you, boId = roomB.you;
  assert.notEqual(adaId, boId);
  const ids = [adaId, boId, ...roomA.presenters.map((p) => p.id)];
  assert.ok(ids.every((id) => !a.body.legs.concat(b.body.legs).some((l) => l.session_id === id)), 'opaque ids, never session ids');

  // Bo (a guest, not first) tries to remove Ada and to spotlight himself: refused, nothing changes.
  B.send(JSON.stringify({ type: 'room', action: 'remove', target: adaId }));
  B.send(JSON.stringify({ type: 'room', action: 'spotlight', target: boId }));
  await waitFor(() => has(B, 'room_refused'), 4000, 'Bo refused');
  await sleep(200);
  assert.ok(!has(A, 'ended'), 'Ada still presenting');
  assert.ok(!lastLayout(D) || !lastLayout(D).spotlight);

  // Ada spotlights Bo: the screen is told which of ITS sessions fills it.
  const boSession = startsFor(D).find((s) => s.shared_by === 'Bo').session_id;
  A.send(JSON.stringify({ type: 'room', action: 'spotlight', target: boId }));
  await waitFor(() => lastLayout(D) && lastLayout(D).spotlight === boSession, 4000, 'Bo spotlighted');
  assert.equal((await status(D)).presenters.find((p) => p.shared_by === 'Bo').spotlight, true);
  const spot = all("SELECT details FROM activity_log WHERE action = 'screen_share.spotlight' AND device_id = ?", D.id);
  assert.ok(spot.length >= 1);
  A.send(JSON.stringify({ type: 'room', action: 'spotlight', target: null }));
  await waitFor(() => lastLayout(D) && lastLayout(D).spotlight === null, 4000, 'back to tiles');

  // Ada removes Bo. Bo's page is told why; his code was spent, so it cannot bring him back.
  A.send(JSON.stringify({ type: 'room', action: 'remove', target: boId }));
  await waitFor(() => has(B, 'ended'), 4000, 'Bo removed');
  assert.equal(has(B, 'ended').reason, 'removed');
  const rm = all("SELECT details FROM activity_log WHERE action = 'screen_share.presenter_remove' AND device_id = ?", D.id);
  assert.equal(rm.length, 1);
  assert.equal(JSON.parse(rm[0].details).shared_by, 'Bo');
  const back = await guestJoin(boCodeUsed, { name: 'Bo' });
  assert.equal(back.status, 404, 'the code Bo joined with cannot bring him back');
  const c = await waitFor(() => lastCode(D), 4000, 'a code on screen (a slot is free)');
  assert.ok(c, 'a slot is free again: a code is on screen');

  // The owner from the dashboard: viewers and other tenants are refused.
  const c2 = await guestJoin(c, { name: 'Cy' });
  await openLegs(c2.body.legs);
  const st = await status(D);
  const cy = st.presenters.find((p) => p.shared_by === 'Cy');
  assert.equal((await call('viewer', 'PUT', `/api/screen-share/devices/${D.id}/spotlight`, { share_id: cy.share_id })).status, 403);
  assert.equal((await call('outsider', 'PUT', `/api/screen-share/devices/${D.id}/spotlight`, { share_id: cy.share_id })).status, 403);
  assert.equal((await call('viewer', 'DELETE', `/api/screen-share/devices/${D.id}/presenters/${cy.share_id}`)).status, 403);
  assert.equal((await call('outsider', 'DELETE', `/api/screen-share/devices/${D.id}/presenters/${cy.share_id}`)).status, 403);
  assert.equal((await call('owner', 'PUT', `/api/screen-share/devices/${D.id}/spotlight`, { share_id: 'nope' })).status, 404);
  const sp = await call('editor', 'PUT', `/api/screen-share/devices/${D.id}/spotlight`, { share_id: cy.share_id });
  assert.equal(sp.status, 200);
  const del = await call('editor', 'DELETE', `/api/screen-share/devices/${D.id}/presenters/${cy.share_id}`);
  assert.equal(del.status, 200);
  await waitFor(() => has(c2.body.legs[0]._sharer, 'ended'), 4000, 'Cy removed');
  assert.equal((await call('owner', 'DELETE', `/api/screen-share/devices/${D.id}/presenters/${cy.share_id}`)).status, 404);
  assert.ok(!has(A, 'ended'), 'Ada untouched throughout');

  // A signed-in presenter who is NOT first may control (they could from the dashboard anyway).
  const ed = await call('editor', 'POST', `/api/screen-share/devices/${D.id}`, {});
  await openLegs(ed.body.legs);
  const E = ed.body.legs[0]._sharer;
  const roomE = await waitFor(() => { const m = last(E, 'room'); return m && m.presenters.length === 2 ? m : null; }, 4000, 'room for the editor');
  assert.equal(roomE.first, false);
  assert.equal(roomE.can_control, true);
  // The first presenter leaves: the next one in becomes first.
  A.send(JSON.stringify({ type: 'stop' }));
  await waitFor(() => { const m = last(E, 'room'); return m && m.presenters.length === 1 && m.first; }, 4000, 'the editor is first now');
  await call('owner', 'DELETE', `/api/screen-share/devices/${D.id}`);
  D.sock.close();
});

test('turning the switch off mid-share keeps everyone and lets nobody new in', async () => {
  const D = mkDevice('Lab', 'owner', { guest: true, multi: true });
  await connectDevice(D);
  const a = await guestJoin(await newCode(D), { name: 'A' });
  await openLegs(a.body.legs);
  const b = await guestJoin(await newCode(D, null), { name: 'B' });
  await openLegs(b.body.legs);
  await newCode(D, null);
  await call('owner', 'PUT', `/api/screen-share/devices/${D.id}/multi`, { enabled: false });
  await waitFor(() => lastCode(D) === null, 4000, 'no code: the room is over its one slot');
  assert.equal((await status(D)).presenters.length, 2, 'both still presenting');
  assert.ok(!has(a.body.legs[0]._sharer, 'ended') && !has(b.body.legs[0]._sharer, 'ended'));
  assert.equal((await call('editor', 'POST', `/api/screen-share/devices/${D.id}`, {})).status, 409);
  a.body.legs[0]._sharer.send(JSON.stringify({ type: 'stop' }));
  await sleep(300);
  assert.equal(lastCode(D), null, 'still one presenter: still full');
  b.body.legs[0]._sharer.send(JSON.stringify({ type: 'stop' }));
  await newCode(D, null);
  D.sock.close();
});

test('the platform limit: Admin sets 1-4, platform admins only', async () => {
  assert.equal((await call('editor', 'PUT', '/api/admin/screen-share', { max_presenters: 2 })).status, 403);
  assert.equal((await call('owner', 'PUT', '/api/admin/screen-share', { max_presenters: 5 })).status, 400);
  assert.equal((await call('owner', 'PUT', '/api/admin/screen-share', { max_presenters: 2 })).status, 200);
  assert.equal((await call('owner', 'GET', '/api/admin/screen-share')).body.max_presenters, 2);
  const D = mkDevice('Two only', 'owner', { guest: true, multi: true });
  await connectDevice(D);
  assert.equal((await status(D)).multi.slots, 2);
  const a = await call('owner', 'POST', `/api/screen-share/devices/${D.id}`, {});
  const b = await call('editor', 'POST', `/api/screen-share/devices/${D.id}`, {});
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  assert.equal((await call('owner', 'POST', `/api/screen-share/devices/${D.id}`, {})).status, 409);
  await call('owner', 'DELETE', `/api/screen-share/devices/${D.id}`);
  assert.equal((await call('owner', 'PUT', '/api/admin/screen-share', { max_presenters: 4 })).status, 200);
  D.sock.close();
});

test('mirrors x presenters: one leg per presenter per screen; a mirror that cannot tile shows one, follows the spotlight', async () => {
  const D = mkDevice('Atrium', 'owner', { guest: true, multi: true });
  const MT = mkDevice('Atrium (mirror, tiles)', 'owner', { mirror_of: D.id });
  const MS = mkDevice('Atrium (mirror, one at a time)', 'owner', { mirror_of: D.id });
  await connectDevice(D);
  await connectDevice(MT);
  await connectDevice(MS, CAPS);

  // First presenter: display + both mirrors.
  const a = await guestJoin(await newCode(D), { name: 'First' });
  assert.equal(a.body.legs.length, 3);
  await openLegs(a.body.legs);
  // Second presenter: display + the tiling mirror; the other is told it shows one at a time.
  const b = await guestJoin(await newCode(D, null), { name: 'Second' });
  assert.equal(b.status, 201);
  assert.equal(b.body.legs.length, 2);
  await openLegs(b.body.legs);
  const note = await waitFor(() => b.body.legs.map((l) => has(l._sharer, 'leg_skipped')).find(Boolean), 4000, 'single-presenter notice');
  assert.equal(note.reason, 'single_presenter');
  assert.equal(note.screen_name, 'Atrium (mirror, one at a time)');
  assert.equal(startsFor(MT).length, 2, 'the tiling mirror shows both');
  assert.equal(startsFor(MS).length, 1, 'the other shows the first only');
  assert.equal(startsFor(MS)[0].shared_by, 'First');

  // The owner spotlights the second presenter: the one-at-a-time mirror switches over — the first
  // presenter's leg there ends, the second presenter's page is handed a leg for it.
  const st = await status(D);
  const second = st.presenters.find((p) => p.shared_by === 'Second');
  const firstMsLeg = startsFor(MS)[0].session_id;
  await call('owner', 'PUT', `/api/screen-share/devices/${D.id}/spotlight`, { share_id: second.share_id });
  const firstMsSharer = a.body.legs.find((l) => l.session_id === firstMsLeg)._sharer;
  await waitFor(() => has(firstMsSharer, 'ended'), 4000, 'first presenter off the single mirror');
  assert.equal(has(firstMsSharer, 'ended').reason, 'spotlight_changed');
  const add = await waitFor(() => b.body.legs.map((l) => has(l._sharer, 'add_leg')).find(Boolean), 4000, 'second presenter handed the mirror');
  assert.ok(!('device_id' in add.leg), 'a guest is told no device ids');
  const s2 = await ws('/api/screen-share/ws');
  s2.send(JSON.stringify({ type: 'auth', ticket: add.leg.ticket }));
  await waitFor(() => startsFor(MS).length === 2 && startsFor(MS)[1].shared_by === 'Second', 4000, 'the single mirror shows the second presenter');
  // The others are untouched: the first presenter still on the display and the tiling mirror.
  assert.ok(a.body.legs.filter((l) => l.session_id !== firstMsLeg).every((l) => !has(l._sharer, 'ended')));
  // Layout on the tiling mirror names ITS session of the spotlighted presenter.
  const mtSecond = startsFor(MT).find((s) => s.shared_by === 'Second').session_id;
  await waitFor(() => lastLayout(MT) && lastLayout(MT).spotlight === mtSecond, 4000, 'tiling mirror spotlight');

  // The second presenter leaves: the single mirror goes back to the first presenter.
  for (const l of b.body.legs) l._sharer.send(JSON.stringify({ type: 'stop' }));
  s2.send(JSON.stringify({ type: 'stop' }));
  const back = await waitFor(() => a.body.legs.map((l) => has(l._sharer, 'add_leg')).find(Boolean), 4000, 'first presenter handed the mirror back');
  assert.ok(back.leg.ticket);
  await call('owner', 'DELETE', `/api/screen-share/devices/${D.id}`);
  await sleep(200);
  for (const d of [D, MT, MS]) d.sock.close();
});

test('the per-share target limit holds per presenter (display + mirrors <= SCREEN_SHARE_MAX_TARGETS)', async () => {
  const D = mkDevice('Hall', 'owner', { multi: true });
  const ms = [1, 2, 3].map((n) => mkDevice(`Hall (mirror ${n})`, 'owner', { mirror_of: D.id }));
  await connectDevice(D);
  for (const m of ms) await connectDevice(m);
  const a = await call('owner', 'POST', `/api/screen-share/devices/${D.id}`, {});
  const b = await call('editor', 'POST', `/api/screen-share/devices/${D.id}`, {});
  for (const r of [a, b]) {
    assert.equal(r.status, 201);
    assert.equal(r.body.legs.length, 3, 'display + 2 mirrors (limit 3)');
    assert.equal(r.body.skipped.length, 1);
    assert.equal(r.body.skipped[0].reason, 'too_many_targets');
  }
  // Each tiling mirror reached carries one leg per presenter that reached it.
  await openLegs(a.body.legs); await openLegs(b.body.legs);
  await waitFor(() => startsFor(D).length === 2, 4000, 'both on the display');
  await call('owner', 'DELETE', `/api/screen-share/devices/${D.id}`);
  for (const d of [D, ...ms]) d.sock.close();
});

test('multi share POST /shares: a full display is skipped and its mirrors do not let the share in', async () => {
  assert.equal((await call('owner', 'PUT', '/api/admin/screen-share', { max_presenters: 1 })).status, 200);
  const D = mkDevice('Full', 'owner', { multi: true });
  const M = mkDevice('Full (mirror)', 'owner', { mirror_of: D.id });
  const E = mkDevice('Free', 'owner');
  await connectDevice(D); await connectDevice(M); await connectDevice(E);
  const first = await call('owner', 'POST', `/api/screen-share/devices/${D.id}`, {});
  assert.equal(first.status, 201);
  const multi = await call('editor', 'POST', '/api/screen-share/shares', { device_ids: [D.id, E.id] });
  assert.equal(multi.status, 201, JSON.stringify(multi.body));
  assert.deepEqual(multi.body.legs.map((l) => l.device_id), [E.id], 'only the free screen');
  assert.ok(multi.body.skipped.some((s) => s.id === D.id && s.reason === 'busy'));
  await call('owner', 'DELETE', `/api/screen-share/devices/${D.id}`);
  await call('owner', 'DELETE', `/api/screen-share/devices/${E.id}`);
  for (const d of [D, M, E]) d.sock.close();
  assert.equal((await call('owner', 'PUT', '/api/admin/screen-share', { max_presenters: 4 })).status, 200);
});
