'use strict';

/*
 * 3.0 screen share on display-link MIRRORS (lib/mirrors.js: the same display link open somewhere
 * else). A mirror shows everything its display shows, so every way of starting a share to a display
 * reaches its mirrors too — not only the multi share (POST /shares), but the dashboard's one-screen
 * "Share my screen" (POST /devices/:id) and the meeting-room code (POST /api/share/join) — and the
 * meeting-room code itself shows on the mirrors. Against the REAL server with real Socket.IO screens:
 *
 *   - the one-screen start and the guest join hand back one leg per place (display first), keep
 *     their old top-level fields (the display's own leg), and share_id === session_id
 *   - a mirror that is offline, busy, cannot show a share or sits in another tenant is left out,
 *     never a reason to refuse; the display being unavailable still refuses as before
 *   - the code reaches the mirrors (also one that connects after it was issued), rotates on them,
 *     and goes when the display goes; a guest with it reaches the display and its mirrors
 *   - stop: the owner's stop on the display ends its mirrors' legs; a mirror disconnecting or being
 *     removed drops only its own leg
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

const dbRun = (fn) => { const r = new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db')); try { return fn(r); } finally { r.close(); } };
const run = (sql, ...a) => dbRun((d) => d.prepare(sql).run(...a));

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
    body: JSON.stringify({ email: `${name}-${Date.now()}@mirrors.test`, password: 'Passw0rd123', name }),
  });
  const b = await r.json();
  assert.equal(r.status, 201, JSON.stringify(b));
  U[name] = { token: b.token, id: b.user.id, ws: b.current_workspace_id };
}

function connectDevice(dev, capabilities = CAPS) {
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

async function connectLeg(leg, dev) {
  const sharer = await ws('/api/screen-share/ws');
  sharer.send(JSON.stringify({ type: 'auth', ticket: leg.ticket }));
  await waitFor(() => has(sharer, 'ready'), 4000, 'sharer ready');
  const screen = await ws(`/api/devices/${dev.id}/screen-share/ws`);
  screen.send(JSON.stringify({ type: 'auth', device_token: dev.token, session_id: leg.session_id }));
  await waitFor(() => has(screen, 'ready'), 4000, 'screen ready');
  return { sharer, screen };
}

// The latest meeting-room code a screen was told (null = told to show none; undefined = never told).
function lastCode(dev) {
  const all = dev.sock.got.filter((g) => g.ev === 'device:screenshare-code');
  return all.length ? all[all.length - 1].data.code : undefined;
}

const mkDevice = (name, owner, extra = {}) => {
  const d = { id: crypto.randomUUID(), token: 'devtok_' + crypto.randomBytes(12).toString('hex'), name };
  run(`INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, device_token, mirror_of, screen_share_guest)
       VALUES (?, ?, ?, ?, ?, 'offline', ?, ?, ?)`,
  d.id, U[owner].id, U[owner].ws, name, crypto.randomUUID().slice(0, 6), d.token, extra.mirror_of || null, extra.guest ? 1 : 0);
  return d;
};

const sessionOf = async (dev) => (await call('owner', 'GET', `/api/screen-share/devices/${dev.id}`)).body.session;

before(async () => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-share-mirrors-'));
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
  await register('outsider');
});

after(async () => {
  for (const s of opened) { try { s.terminate(); } catch { /* */ } }
  for (const s of sockets) { try { s.close(); } catch { /* */ } }
  if (proc) await new Promise((r) => { proc.once('exit', r); proc.kill('SIGKILL'); });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('"Share my screen" on a display reaches its mirrors; unavailable mirrors are skipped, never refused', async () => {
  const D = mkDevice('Display 2', 'owner');
  const M1 = mkDevice('Display 2 (mirror 1)', 'owner', { mirror_of: D.id });
  const M2 = mkDevice('Display 2 (mirror 2)', 'owner', { mirror_of: D.id });          // offline
  run('UPDATE devices SET capabilities = ? WHERE id = ?', JSON.stringify(CAPS), M2.id);   // it could, once
  const OLD = mkDevice('Display 2 (mirror 3)', 'owner', { mirror_of: D.id });         // no receiver
  const STRAY = mkDevice('stray', 'outsider', { mirror_of: D.id });                    // another tenant
  await connectDevice(D);
  await connectDevice(M1);
  await connectDevice(OLD, ['playback.video']);
  await connectDevice(STRAY);

  const r = await call('owner', 'POST', `/api/screen-share/devices/${D.id}`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // The old shape, unchanged: the display's own leg at the top level.
  for (const k of ['session_id', 'ticket', 'ws_path', 'ice_servers', 'max_seconds', 'screen_name']) assert.ok(k in r.body, k);
  assert.equal(r.body.screen_name, 'Display 2');
  // Added: the share and one leg per place, the display first.
  assert.equal(r.body.share_id, r.body.session_id, 'a one-display share keeps share_id === session_id');
  assert.deepEqual(r.body.legs.map((l) => l.device_id), [D.id, M1.id]);
  assert.equal(r.body.legs[0].ticket, r.body.ticket);
  assert.deepEqual(Object.fromEntries(r.body.skipped.map((s) => [s.name, s.reason])), {
    'Display 2 (mirror 2)': 'offline', 'Display 2 (mirror 3)': 'unsupported',
  });
  assert.ok(!JSON.stringify(r.body).includes(STRAY.id), 'never a screen of another tenant');

  const legD = await connectLeg(r.body.legs[0], D);
  const legM = await connectLeg(r.body.legs[1], M1);
  await waitFor(() => M1.sock.got.find((g) => g.ev === 'device:screenshare-start' && g.data.session_id === r.body.legs[1].session_id), 4000, 'the mirror told to show the share');
  const st = await sessionOf(D);
  assert.equal(st.share_id, r.body.share_id);
  assert.equal(st.screens, 1, 'still one display to the card');
  assert.equal(st.mirrors, 1);

  // The owner's stop on the display ends it on the mirror too.
  const stop = await call('owner', 'DELETE', `/api/screen-share/devices/${D.id}`);
  assert.deepEqual(stop.body, { stopped: true });
  await waitFor(() => has(legD.sharer, 'ended') && has(legM.sharer, 'ended'), 4000, 'both legs ended');
  assert.equal(has(legM.sharer, 'ended').reason, 'stopped_by_owner');
  assert.ok(M1.sock.got.find((g) => g.ev === 'device:screenshare-stop' && g.data.session_id === r.body.legs[1].session_id));
  assert.equal(await sessionOf(M1), null);

  // A mirror busy with a share of its own is skipped; the display still gets this one.
  const own = await call('owner', 'POST', `/api/screen-share/devices/${M1.id}`, {});
  assert.equal(own.status, 201);
  assert.deepEqual(own.body.legs.map((l) => l.device_id), [M1.id], 'a mirror has no mirrors');
  const again = await call('owner', 'POST', `/api/screen-share/devices/${D.id}`, {});
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.deepEqual(again.body.legs.map((l) => l.device_id), [D.id]);
  assert.equal(again.body.skipped.find((s) => s.id === M1.id).reason, 'busy');
  // ...and the owner's stop on the display leaves the mirror's own, different share alone.
  await call('owner', 'DELETE', `/api/screen-share/devices/${D.id}`);
  assert.ok(await sessionOf(M1), 'the mirror\'s own share goes on');
  await call('owner', 'DELETE', `/api/screen-share/devices/${M1.id}`);

  // The display itself unavailable: refused exactly as before, whatever its mirrors could do.
  D.sock.close();
  await waitFor(async () => (await call('owner', 'GET', `/api/screen-share/devices/${D.id}`)).body.reason === 'offline', 4000, 'display offline');
  const off = await call('owner', 'POST', `/api/screen-share/devices/${D.id}`, {});
  assert.equal(off.status, 409);
  assert.equal(off.body.reason, 'offline');
  assert.equal(await sessionOf(M1), null, 'nothing started on the mirror');
  for (const d of [M1, OLD, STRAY]) d.sock.close();
});

test('the target limit counts mirrors: the display always, then mirrors up to the limit', async () => {
  const D = mkDevice('Wall', 'owner');
  const ms = [1, 2, 3].map((n) => mkDevice(`Wall (mirror ${n})`, 'owner', { mirror_of: D.id }));
  await connectDevice(D);
  for (const m of ms) await connectDevice(m);
  const r = await call('owner', 'POST', `/api/screen-share/devices/${D.id}`, {});
  assert.equal(r.status, 201);
  assert.equal(r.body.legs.length, 3, 'SCREEN_SHARE_MAX_TARGETS=3');
  assert.equal(r.body.legs[0].device_id, D.id);
  assert.deepEqual(r.body.skipped.map((s) => s.reason), ['too_many_targets']);
  await call('owner', 'DELETE', `/api/screen-share/devices/${D.id}`);
  for (const d of [D, ...ms]) d.sock.close();
});

test('the meeting-room code shows on the mirrors too; a guest with it reaches the display and its mirrors', async () => {
  const D = mkDevice('Boardroom', 'owner', { guest: true });
  const M = mkDevice('Boardroom (mirror 1)', 'owner', { mirror_of: D.id });
  const LATE = mkDevice('Boardroom (mirror 2)', 'owner', { mirror_of: D.id });
  await connectDevice(D);
  await connectDevice(M);
  const code = await waitFor(() => lastCode(D), 4000, 'the display shows a code');
  await waitFor(() => lastCode(M) === code, 4000, 'the mirror shows the same code');
  const payload = M.sock.got.filter((g) => g.ev === 'device:screenshare-code').pop().data;
  assert.match(payload.url, /\/share$/);
  assert.ok(payload.expires_at > Date.now());

  // A mirror that connects while the code is live gets it at once, not at the next rotation.
  await connectDevice(LATE);
  await waitFor(() => lastCode(LATE) === code, 4000, 'the late mirror shows the code');

  // The mirror page has no switch of its own: the code is the display's.
  const mst = await call('owner', 'GET', `/api/screen-share/devices/${M.id}`);
  assert.equal(mst.body.guest_enabled, true);
  assert.equal(mst.body.mirror_of, D.id);
  const toggle = await call('owner', 'PUT', `/api/screen-share/devices/${M.id}/guest`, { enabled: false });
  assert.equal(toggle.status, 409);
  assert.equal(toggle.body.reason, 'mirror');

  // A guest types the code read off a mirror.
  const j = await fetch(BASE + '/api/share/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'Erin' }) });
  const jb = await j.json();
  assert.equal(j.status, 201, JSON.stringify(jb));
  assert.equal(jb.screen_name, 'Boardroom');
  assert.equal(jb.share_id, jb.session_id);
  assert.equal(jb.legs.length, 3);
  assert.equal(jb.legs[0].ticket, jb.ticket);
  assert.ok(jb.legs.every((l) => !('device_id' in l)), 'a guest is told no device ids');
  assert.equal(jb.skipped, undefined, 'nor which screens were left out');
  // The guest's page opens one sharer socket per leg (MultiShareSender); each screen is told.
  for (const l of jb.legs) {
    l._sharer = await ws('/api/screen-share/ws');
    l._sharer.send(JSON.stringify({ type: 'auth', ticket: l.ticket }));
    await waitFor(() => has(l._sharer, 'ready'), 4000, 'guest leg ready');
  }
  for (const d of [D, M, LATE]) {
    const start = await waitFor(() => d.sock.got.find((g) => g.ev === 'device:screenshare-start'), 4000, d.name + ' told to show the guest share');
    assert.equal(start.data.shared_by, 'Erin');
    assert.equal(start.data.guest, true);
  }
  // While the share runs, nobody offers a code; the code was spent.
  await waitFor(() => lastCode(D) === null && lastCode(M) === null && lastCode(LATE) === null, 4000, 'no code anywhere while busy');
  const reuse = await fetch(BASE + '/api/share/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  assert.equal(reuse.status, 404);

  // The mirror drops off: only its leg ends.
  const mLeg = jb.legs.find((l) => M.sock.got.some((g) => g.ev === 'device:screenshare-start' && g.data.session_id === l.session_id));
  M.sock.close();
  await waitFor(() => has(mLeg._sharer, 'ended'), 4000, 'the mirror leg ended');
  assert.equal(has(mLeg._sharer, 'ended').reason, 'screen_offline');
  const others = jb.legs.filter((l) => l !== mLeg);
  assert.ok(others.every((l) => !has(l._sharer, 'ended')), 'the display and the other mirror go on');

  // A mirror that connects mid-share shows no code (and joins the share: the guest's page is
  // handed its leg over a socket it already has open).
  const MID = mkDevice('Boardroom (mirror 3)', 'owner', { mirror_of: D.id });
  await connectDevice(MID);
  await waitFor(() => lastCode(MID) === null, 4000, 'the mid-share mirror told: no code');
  const addMid = await waitFor(() => others.map((l) => has(l._sharer, 'add_leg')).find(Boolean), 4000, 'the guest handed the new mirror\'s leg');
  const midLeg = { _sharer: await ws('/api/screen-share/ws') };
  midLeg._sharer.send(JSON.stringify({ type: 'auth', ticket: addMid.leg.ticket }));
  await waitFor(() => has(midLeg._sharer, 'ready'), 4000, 'mid leg ready');
  others.push(midLeg);

  // The guest stops: everything ends, and ONE fresh code comes back on the display and its mirrors.
  for (const l of others) l._sharer.send(JSON.stringify({ type: 'stop' }));
  await waitFor(() => lastCode(D) && lastCode(D) !== code && lastCode(LATE) === lastCode(D) && lastCode(MID) === lastCode(D), 4000, 'a fresh code on the display and the mirrors');
  await sleep(300);
  assert.ok(lastCode(D) !== code && lastCode(LATE) === lastCode(D) && lastCode(MID) === lastCode(D), 'settled on one new code');
  const spent = await fetch(BASE + '/api/share/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  assert.equal(spent.status, 404, 'the redeemed code is refused after the share too');
  MID.sock.close();

  // A share on one mirror alone leaves the display free, but its code is replaced (now and after).
  const shown = lastCode(D);
  const solo = await call('owner', 'POST', `/api/screen-share/devices/${LATE.id}`, {});
  assert.equal(solo.status, 201);
  await waitFor(() => lastCode(LATE) === null && lastCode(D) && lastCode(D) !== shown, 4000, 'a new code on the display; none on the busy mirror');
  const during = lastCode(D);
  await call('owner', 'DELETE', `/api/screen-share/devices/${LATE.id}`);
  await waitFor(() => lastCode(D) !== during && lastCode(LATE) === lastCode(D), 4000, 'a new code again after the mirror\'s share');

  // Rotation reaches the mirror.
  const before = lastCode(D);
  run('UPDATE devices SET screen_share_guest = 1 WHERE id = ?', D.id);
  const rot = await call('owner', 'PUT', `/api/screen-share/devices/${D.id}/guest`, { enabled: true });
  assert.equal(rot.status, 200);
  await waitFor(() => lastCode(D) !== before && lastCode(LATE) === lastCode(D), 4000, 'the rotated code on the mirror');
  // Switched off: gone from the mirror as well.
  await call('owner', 'PUT', `/api/screen-share/devices/${D.id}/guest`, { enabled: false });
  await waitFor(() => lastCode(D) === null && lastCode(LATE) === null, 4000, 'code off everywhere');
  // On again, then the display drops off: the mirror stops offering a code nobody can use.
  await call('owner', 'PUT', `/api/screen-share/devices/${D.id}/guest`, { enabled: true });
  await waitFor(() => lastCode(LATE) && lastCode(LATE) === lastCode(D), 4000, 'code back');
  D.sock.close();
  await waitFor(() => lastCode(LATE) === null, 4000, 'the mirror drops the display\'s code');
  LATE.sock.close();
});

test('removing a mirror mid-share ends its leg; the display goes on', async () => {
  const D = mkDevice('Reception', 'owner');
  const M = mkDevice('Reception (mirror 1)', 'owner', { mirror_of: D.id });
  await connectDevice(D);
  await connectDevice(M);
  const r = await call('owner', 'POST', `/api/screen-share/devices/${D.id}`, {});
  assert.equal(r.body.legs.length, 2);
  const legD = await connectLeg(r.body.legs[0], D);
  const legM = await connectLeg(r.body.legs[1], M);
  const del = await call('owner', 'DELETE', `/api/devices/${M.id}`);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  await waitFor(() => has(legM.sharer, 'ended'), 4000, 'the removed mirror\'s leg ended');
  await sleep(200);
  assert.equal(has(legD.sharer, 'ended'), undefined, 'the display keeps the share');
  const st = await sessionOf(D);
  assert.equal(st.screens, 1);
  assert.equal(st.mirrors, 0);
  await call('owner', 'DELETE', `/api/screen-share/devices/${D.id}`);
  D.sock.close();
});

/*
 * A mirror that connects WHILE its display is being shared to joins the share: the server mints a
 * leg and hands it to the sharer over the sharer's open socket ({type:'add_leg'}). Only a mirror of
 * a display the share was started for, in its workspace, within the target limit, and nothing the
 * sharer sends can add a screen.
 */
test('a mirror that connects mid-share joins it; nothing else can be added; the limit holds', async () => {
  const D = mkDevice('Atrium', 'owner');
  const X = mkDevice('Café', 'owner');
  const MX = mkDevice('Café (mirror 1)', 'owner', { mirror_of: X.id });
  const M = mkDevice('Atrium (mirror 1)', 'owner', { mirror_of: D.id });
  const M2 = mkDevice('Atrium (mirror 2)', 'owner', { mirror_of: D.id });
  const M3 = mkDevice('Atrium (mirror 3)', 'owner', { mirror_of: D.id });
  const STRAY = mkDevice('stray', 'outsider', { mirror_of: D.id });
  await connectDevice(D);
  await connectDevice(X);
  const r = await call('owner', 'POST', `/api/screen-share/devices/${D.id}`, {});
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.legs.map((l) => l.device_id), [D.id], 'no mirror open yet');
  const legD = await connectLeg(r.body.legs[0], D);
  const adds = () => legD.sharer.msgs.filter((m) => m.type === 'add_leg');

  // The mirror connects: the sharer is handed a leg for it, and that leg works like any other.
  await connectDevice(M);
  const add = await waitFor(() => adds()[0], 4000, 'add_leg for the mirror');
  assert.equal(add.share_id, r.body.share_id);
  assert.equal(add.leg.device_id, M.id);
  assert.equal(add.leg.screen_name, 'Atrium (mirror 1)');
  const legM = await connectLeg(add.leg, M);
  const start = await waitFor(() => M.sock.got.find((g) => g.ev === 'device:screenshare-start' && g.data.session_id === add.leg.session_id), 4000, 'the mirror told to show it');
  assert.equal(start.data.shared_by, 'owner');
  assert.equal((await sessionOf(D)).mirrors, 1);

  // Not a mirror of a display in this share, or not in this workspace: not added.
  await connectDevice(MX);
  await connectDevice(STRAY);
  // The sharer cannot name a screen: whatever it sends, nothing is added.
  legD.sharer.send(JSON.stringify({ type: 'add_leg', device_id: X.id, leg: { device_id: X.id } }));
  legD.sharer.send(JSON.stringify({ type: 'add', device_id: MX.id }));
  await sleep(500);
  assert.equal(adds().length, 1, 'only the real mirror was ever added');
  for (const d of [X, MX]) assert.equal(await sessionOf(d), null, d.name + ' untouched');
  assert.equal((await call('outsider', 'GET', `/api/screen-share/devices/${STRAY.id}`)).body.session, null, 'stray untouched');
  // A periodic re-register of a screen already in the share adds nothing.
  M.sock.emit('device:register', { device_id: M.id, device_token: M.token, capabilities: CAPS, device_info: { app_version: 'test' } });
  await sleep(400);
  assert.equal(adds().length, 1);

  // The mirror drops and comes back: it rejoins with a new leg.
  M.sock.close();
  await waitFor(() => has(legM.sharer, 'ended'), 4000, 'the mirror\'s leg ended');
  await connectDevice(M);
  const again = await waitFor(() => adds()[1], 4000, 'add_leg again on reconnect');
  assert.equal(again.leg.device_id, M.id);
  assert.notEqual(again.leg.session_id, add.leg.session_id);
  await connectLeg(again.leg, M);

  // The limit (3): one more mirror fits, the next is skipped and the sharer is told.
  await connectDevice(M2);
  await waitFor(() => adds()[2], 4000, 'the second mirror joins');
  await connectDevice(M3);
  const skipped = await waitFor(() => legD.sharer.msgs.find((m) => m.type === 'leg_skipped'), 4000, 'leg_skipped');
  assert.equal(skipped.screen_name, 'Atrium (mirror 3)');
  assert.equal(skipped.reason, 'too_many_targets');
  assert.equal(adds().length, 3);
  assert.equal(await sessionOf(M3), null);

  await call('owner', 'DELETE', `/api/screen-share/devices/${D.id}`);
  for (const d of [D, X, MX, M, M2, M3, STRAY]) d.sock.close();
});

test('a guest share takes in a mirror that connects mid-share, without device ids', async () => {
  const D = mkDevice('Studio', 'owner', { guest: true });
  const M = mkDevice('Studio (mirror 1)', 'owner', { mirror_of: D.id });
  await connectDevice(D);
  const code = await waitFor(() => lastCode(D), 4000, 'a code');
  const j = await fetch(BASE + '/api/share/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'Gus' }) });
  const jb = await j.json();
  assert.equal(j.status, 201);
  assert.equal(jb.legs.length, 1);
  const sharer = await ws('/api/screen-share/ws');
  sharer.send(JSON.stringify({ type: 'auth', ticket: jb.ticket }));
  await waitFor(() => has(sharer, 'ready'));
  await connectDevice(M);
  const add = await waitFor(() => has(sharer, 'add_leg'), 4000, 'add_leg to the guest');
  assert.ok(!('device_id' in add.leg), 'no device id for a guest');
  await waitFor(() => lastCode(M) === null, 4000, 'no code on the mirror while it is in the share');
  const s2 = await ws('/api/screen-share/ws');
  s2.send(JSON.stringify({ type: 'auth', ticket: add.leg.ticket }));
  const st = await waitFor(() => M.sock.got.find((g) => g.ev === 'device:screenshare-start'), 4000, 'the mirror shows the guest share');
  assert.equal(st.data.guest, true);
  assert.equal(st.data.shared_by, 'Gus');
  sharer.send(JSON.stringify({ type: 'stop' }));
  s2.send(JSON.stringify({ type: 'stop' }));
  await waitFor(() => lastCode(D) && lastCode(D) !== code && lastCode(M) === lastCode(D), 4000, 'one new code for both');
  D.sock.close(); M.sock.close();
});
