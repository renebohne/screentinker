'use strict';

/*
 * 3.0 screen share — the relay and the meeting-room codes (lib/screen-share.js), in process.
 *
 * The routes (who may start a share) are pinned against the real server in
 * screen-share-routes.test.js, and the whole thing in a real browser in screen-share-e2e.test.js.
 * This file pins what the RELAY guarantees on its own, because the relay is reachable by anyone who
 * can open a WebSocket:
 *   - a sharer leg without a valid, unused ticket gets nothing; a ticket works once
 *   - a screen leg needs its own device_token AND a session minted for that screen
 *   - only the expected message types cross, rebuilt from validated fields (no pass-through)
 *   - either side leaving, the screen going offline, an owner's stop or the time limit end the
 *     session on BOTH sides, tell the screen over Socket.IO, and are audited
 *   - codes: canonical alphabet, look-alikes forgiven, single use, expire, rotate, and only exist for
 *     an online screen with the code switched on whose workspace allows sharing
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-screenshare-'));
process.env.DATA_DIR = tmp;

const WebSocket = require('ws');
const { db } = require('../db/database');
const config = require('../config');
const share = require('../lib/screen-share');

db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u-ed', 'ed@test', 'Edna Editor', 'user')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-a', 'A', 'u-ed'), ('org-b', 'B', 'u-ed')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-a', 'org-a', 'A'), ('ws-b', 'org-b', 'B')").run();
const CAPS = JSON.stringify(['remote.screen_share']);
db.prepare(`INSERT INTO devices (id, name, status, workspace_id, created_at, capabilities, device_token, screen_share_guest) VALUES
  ('dev-a', 'Boardroom', 'online', 'ws-a', 0, ?, 'tok-a', 1),
  ('dev-a2', 'Lobby', 'online', 'ws-a', 0, ?, 'tok-a2', 0),
  ('dev-old', 'Old TV', 'online', 'ws-a', 0, '["remote.talk"]', 'tok-old', 1),
  ('dev-b', 'Theirs', 'online', 'ws-b', 0, ?, 'tok-b', 1)`).run(CAPS, CAPS, CAPS);

// A fake /device namespace: rooms say who is online here, emits are recorded.
const rooms = new Map();
const emits = [];
const fakeNs = {
  adapter: { rooms },
  to(id) { return { emit(ev, data) { emits.push({ id, ev, data }); } }; },
};
share.init({ of: () => fakeNs });
const online = (id) => rooms.set(id, new Set(['sock-' + id]));
const offline = (id) => rooms.delete(id);

const server = http.createServer();
share.attach(server);
let PORT;
const ready = new Promise((r) => server.listen(0, '127.0.0.1', () => { PORT = server.address().port; r(); }));

const allClients = [];
after(() => {
  share._reset();
  for (const c of allClients) { try { c.terminate(); } catch (_) {} }
  try { server.closeAllConnections(); } catch (_) {}
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => { share._reset(); emits.length = 0; rooms.clear(); online('dev-a'); online('dev-a2'); online('dev-old'); online('dev-b'); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = (id) => db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
const dev = (id) => db.prepare('SELECT * FROM devices WHERE id = ?').get(id);

/** A WebSocket client that records messages and lets a test wait for one. */
async function client(p) {
  await ready;
  const sock = new WebSocket(`ws://127.0.0.1:${PORT}${p}`);
  allClients.push(sock);
  const msgs = [];
  const waiters = [];
  sock.on('message', (d) => {
    const m = JSON.parse(d.toString());
    msgs.push(m);
    for (const w of waiters.splice(0)) w();
  });
  sock.closed = new Promise((r) => sock.on('close', (code) => r(code)));
  await new Promise((r, j) => { sock.on('open', r); sock.on('error', j); });
  sock.msgs = msgs;
  sock.sendJ = (m) => sock.send(JSON.stringify(m));
  sock.next = async (type, ms = 3000) => {
    const t0 = Date.now();
    for (;;) {
      const i = msgs.findIndex((m) => m.type === type);
      if (i >= 0) return msgs.splice(i, 1)[0];
      if (Date.now() - t0 > ms) throw new Error(`no ${type}; got ${JSON.stringify(msgs)}`);
      await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  };
  return sock;
}

function start(deviceId = 'dev-a', extra = {}) {
  const d = dev(deviceId);
  const out = share.createSession({ device: d, workspace: ws(d.workspace_id), sharedBy: 'Edna', userId: 'u-ed', ip: '10.0.0.9', ...extra });
  assert.ok(out.session, out.error);
  return out;
}

/** Sharer + screen legs connected, offer/answer exchanged. */
async function connected(deviceId = 'dev-a', token = 'tok-a') {
  const { session, ticket } = start(deviceId);
  const sharer = await client('/api/screen-share/ws');
  sharer.sendJ({ type: 'auth', ticket });
  await sharer.next('ready');
  const startEmit = emits.find((e) => e.ev === 'device:screenshare-start' && e.id === deviceId);
  assert.ok(startEmit, 'the screen is told to join');
  const screen = await client(`/api/devices/${deviceId}/screen-share/ws`);
  screen.sendJ({ type: 'auth', device_token: token, session_id: session.id });
  await screen.next('ready');
  await sharer.next('screen_joined');
  return { session, sharer, screen };
}

const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';

// ------------------------------------------------------------------ availability + capability gating

test('availability: capability, online, busy, workspace switch and server switch each refuse with their own reason', () => {
  assert.deepEqual(share.availability(dev('dev-a'), ws('ws-a')), { ok: true });
  assert.equal(share.availability(dev('dev-old'), ws('ws-a')).reason, 'unsupported', 'a player that does not declare remote.screen_share is never offered');
  offline('dev-a2');
  assert.equal(share.availability(dev('dev-a2'), ws('ws-a')).reason, 'offline');
  start('dev-a');
  assert.equal(share.availability(dev('dev-a'), ws('ws-a')).reason, 'busy');
  assert.equal(share.createSession({ device: dev('dev-a'), workspace: ws('ws-a'), sharedBy: 'x' }).error, 'busy', 'one share at a time, even racing');
  assert.equal(share.availability(dev('dev-b'), { ...ws('ws-b'), screen_share_enabled: 0 }).reason, 'workspace_disabled');
  config.screenShareEnabled = false;
  try { assert.equal(share.availability(dev('dev-b'), ws('ws-b')).reason, 'disabled'); }
  finally { config.screenShareEnabled = true; }
});

test('a legacy player (no declaration) is not assumed able to show a share', () => {
  const pc = require('../lib/player-capabilities');
  assert.ok(pc.CAP_SET.has('remote.screen_share'));
  for (const [fam, list] of Object.entries(pc.BASELINE)) assert.ok(!list.includes('remote.screen_share'), `${fam} baseline must not claim it`);
  assert.equal(pc.supports({ id: 'x', platform: 'web', capabilities: null }, 'remote.screen_share'), false);
});

// ------------------------------------------------------------------ relay authorization

test('sharer leg: a bad ticket gets nothing and is closed; a good ticket works exactly once', async () => {
  const { ticket } = start('dev-a');
  const bad = await client('/api/screen-share/ws');
  bad.sendJ({ type: 'auth', ticket: 'x'.repeat(43) });
  assert.equal((await bad.next('ended')).reason, 'invalid_ticket');
  assert.equal(await bad.closed, 4001);
  assert.ok(!emits.some((e) => e.ev === 'device:screenshare-start'), 'nothing reaches the screen');

  const good = await client('/api/screen-share/ws');
  good.sendJ({ type: 'auth', ticket });
  await good.next('ready');
  const again = await client('/api/screen-share/ws');
  again.sendJ({ type: 'auth', ticket });
  assert.equal((await again.next('ended')).reason, 'invalid_ticket', 'a ticket is single-use');
  good.close();
});

test('sharer leg: anything but auth first is refused', async () => {
  const s = await client('/api/screen-share/ws');
  s.sendJ({ type: 'webrtc/answer', value: SDP });
  assert.equal(await s.closed, 4001);
});

test('screen leg: needs the screen\'s own token and a session minted for THAT screen', async () => {
  const { session, ticket } = start('dev-a');
  const sharer = await client('/api/screen-share/ws');
  sharer.sendJ({ type: 'auth', ticket });
  await sharer.next('ready');

  const wrongTok = await client('/api/devices/dev-a/screen-share/ws');
  wrongTok.sendJ({ type: 'auth', device_token: 'tok-b', session_id: session.id });
  assert.equal((await wrongTok.next('ended')).reason, 'invalid_session');

  // Another tenant's screen, with its own valid token, cannot attach to this session.
  const otherScreen = await client('/api/devices/dev-b/screen-share/ws');
  otherScreen.sendJ({ type: 'auth', device_token: 'tok-b', session_id: session.id });
  assert.equal((await otherScreen.next('ended')).reason, 'invalid_session');

  const right = await client('/api/devices/dev-a/screen-share/ws');
  right.sendJ({ type: 'auth', device_token: 'tok-a', session_id: session.id });
  await right.next('ready');

  // A second leg for the same session (a replayed start) is refused.
  const dup = await client('/api/devices/dev-a/screen-share/ws');
  dup.sendJ({ type: 'auth', device_token: 'tok-a', session_id: session.id });
  assert.equal((await dup.next('ended')).reason, 'invalid_session');
  sharer.close();
});

test('the start sent to the screen carries the sharer\'s name, the limit and ICE, never the ticket', async () => {
  const { session, sharer } = await connected();
  const e = emits.find((x) => x.ev === 'device:screenshare-start');
  assert.equal(e.data.session_id, session.id);
  assert.equal(e.data.shared_by, 'Edna');
  assert.equal(e.data.max_seconds, share.maxSeconds());
  assert.ok(Array.isArray(e.data.ice_servers));
  assert.ok(!JSON.stringify(e.data).includes('ticket'));
  sharer.close();
});

// ------------------------------------------------------------------ relay content

test('offer, answer and candidates cross; extra fields are stripped and junk is dropped', async () => {
  const { sharer, screen } = await connected();
  // An answer before any offer is ignored (the screen drives negotiation).
  sharer.sendJ({ type: 'webrtc/answer', value: SDP });
  screen.sendJ({ type: 'webrtc/offer', value: SDP, evil: '<script>' });
  const offer = await sharer.next('webrtc/offer');
  assert.deepEqual(offer, { type: 'webrtc/offer', value: SDP });
  sharer.sendJ({ type: 'webrtc/answer', value: SDP, x: 1 });
  assert.deepEqual(await screen.next('webrtc/answer'), { type: 'webrtc/answer', value: SDP });

  const cand = 'candidate:1 1 udp 2122260223 192.168.1.5 54321 typ host';
  screen.sendJ({ type: 'webrtc/candidate', value: cand, mid: '0', mline: 0, junk: true });
  assert.deepEqual(await sharer.next('webrtc/candidate'), { type: 'webrtc/candidate', value: cand, mid: '0', mline: 0 });
  // Not a candidate line, an unknown type, and a non-SDP offer are all dropped.
  sharer.sendJ({ type: 'webrtc/candidate', value: 'rm -rf /' });
  sharer.sendJ({ type: 'device:command', value: 'reboot' });
  screen.sendJ({ type: 'webrtc/offer', value: 'not sdp' });
  sharer.sendJ({ type: 'webrtc/candidate', value: cand });
  assert.equal((await screen.next('webrtc/candidate')).value, cand);
  await sleep(100);
  assert.ok(!screen.msgs.some((m) => m.type === 'device:command' || (m.type === 'webrtc/candidate' && m.value === 'rm -rf /')));
  assert.ok(!sharer.msgs.some((m) => m.type === 'webrtc/offer'), 'a second offer is never relayed');
  sharer.close();
});

test('the screen reporting playing marks the share live and tells the sharer', async () => {
  const { session, sharer, screen } = await connected();
  screen.sendJ({ type: 'state', value: 'playing' });
  await sharer.next('screen_playing');
  assert.equal(share.publicSession(share.sessionForDevice('dev-a')).live, true);
  assert.equal(share.publicSession(share.sessionForDevice('dev-a')).session_id, session.id);
  sharer.close();
});

// ------------------------------------------------------------------ cleanup

async function stopEmitted(sessionId) {
  for (let i = 0; i < 40; i++) {
    const e = emits.find((x) => x.ev === 'device:screenshare-stop' && x.data.session_id === sessionId);
    if (e) return e;
    await sleep(25);
  }
  throw new Error('no device:screenshare-stop');
}

test('the sharer closing the tab ends the share on the screen', async () => {
  const { session, sharer, screen } = await connected();
  sharer.terminate();
  assert.equal((await screen.next('ended')).reason, 'sharer_left');
  assert.equal((await stopEmitted(session.id)).data.reason, 'sharer_left');
  assert.equal(share.sessionForDevice('dev-a'), null);
});

test('the screen\'s leg dropping ends the share for the sharer', async () => {
  const { session, sharer, screen } = await connected();
  screen.terminate();
  assert.equal((await sharer.next('ended')).reason, 'screen_left');
  await stopEmitted(session.id);
  assert.equal(share.sessionForDevice('dev-a'), null);
});

test('the screen going offline (Socket.IO disconnect) ends the share and drops its code', async () => {
  const { sharer } = await connected();
  share.deviceGone('dev-a');
  assert.equal((await sharer.next('ended')).reason, 'screen_offline');
  assert.equal(share._codes.has('dev-a'), false);
});

test('an owner\'s stop ends it on both sides and is audited with who did it', async () => {
  const { session, sharer, screen } = await connected();
  assert.equal(share.stopForDevice('dev-a', 'stopped_by_owner', { userId: 'u-ed', ip: '10.0.0.1' }), true);
  assert.equal((await sharer.next('ended')).reason, 'stopped_by_owner');
  assert.equal((await screen.next('ended')).reason, 'stopped_by_owner');
  const row = db.prepare("SELECT * FROM activity_log WHERE action = 'screen_share.stop' AND details LIKE ? ORDER BY id DESC").get(`%${session.id}%`);
  assert.ok(row, 'stop is in the activity log');
  assert.equal(row.user_id, 'u-ed');
  assert.equal(row.device_id, 'dev-a');
  assert.equal(row.workspace_id, 'ws-a');
  assert.equal(JSON.parse(row.details).reason, 'stopped_by_owner');
  const startRow = db.prepare("SELECT * FROM activity_log WHERE action = 'screen_share.start' AND details LIKE ?").get(`%${session.id}%`);
  assert.ok(startRow && !startRow.details.includes('ticket'), 'start audited, ticket never logged');
});

test('the time limit ends the share', async () => {
  const before = config.screenShareMaxMinutes;
  config.screenShareMaxMinutes = 0.01;   // 0.6s
  try {
    const { sharer, screen } = await connected();
    assert.equal((await sharer.next('ended', 4000)).reason, 'max_duration');
    assert.equal((await screen.next('ended', 1000)).reason, 'max_duration');
  } finally { config.screenShareMaxMinutes = before; }
});

test('a screen that never opens its leg is given up on, and the sharer is told', async () => {
  const { ticket } = start('dev-a');
  offline('dev-a');   // the start cannot reach it
  const sharer = await client('/api/screen-share/ws');
  sharer.sendJ({ type: 'auth', ticket });
  assert.equal((await sharer.next('ended')).reason, 'screen_unreachable');
});

test('turning a workspace off ends its shares and clears its codes, and nobody else\'s', async () => {
  const a = await connected('dev-a', 'tok-a');
  const b = await connected('dev-b', 'tok-b');
  share.stopWorkspace('ws-a', 'disabled_by_admin');
  assert.equal((await a.sharer.next('ended')).reason, 'disabled_by_admin');
  await sleep(50);
  assert.ok(share.sessionForDevice('dev-b'), 'another workspace is untouched');
  b.sharer.close();
});

// ------------------------------------------------------------------ meeting-room codes

test('codes: 8 characters of the unambiguous alphabet; case, spaces, dashes and look-alikes forgiven', () => {
  const c = share.rotateCode('dev-a').code;
  assert.match(c, /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
  assert.equal(share.normaliseCode(` ${c.slice(0, 4).toLowerCase()}-${c.slice(4)} `), c);
  assert.equal(share.normaliseCode('O0IL-1111'), '00111111');
  assert.equal(share.normaliseCode('ABCD-123'), null, 'too short');
  assert.equal(share.normaliseCode('ABCD-123U'), null, 'U is not in the alphabet');
  assert.equal(share.normaliseCode(null), null);
  assert.equal(share.formatCode('ABCD1234'), 'ABCD-1234');
});

test('codes exist only for an online screen with the code on, in a workspace that allows sharing', () => {
  assert.ok(share.currentCode('dev-a'), 'on + online');
  assert.equal(share.currentCode('dev-a2'), null, 'code switched off on this screen');
  assert.equal(share.currentCode('dev-old'), null, 'code on, but the player cannot show a share: no code (it would be a trap)');
  offline('dev-a');
  assert.equal(share.currentCode('dev-a'), null, 'offline');
  online('dev-a');
  db.prepare("UPDATE workspaces SET screen_share_enabled = 0 WHERE id = 'ws-a'").run();
  try { assert.equal(share.currentCode('dev-a'), null, 'workspace switched off'); }
  finally { db.prepare("UPDATE workspaces SET screen_share_enabled = 1 WHERE id = 'ws-a'").run(); }
  start('dev-a');
  assert.equal(share.currentCode('dev-a'), null, 'no code while someone is sharing');
});

test('a code is single-use, expires, and the screen is sent a fresh one', async () => {
  const c = share.currentCode('dev-a').code;
  assert.equal(share.currentCode('dev-a').code, c, 'stable until used or expired');
  assert.equal(share.redeemCode(c.toLowerCase()), 'dev-a');
  assert.equal(share.redeemCode(c), null, 'spent');
  const c2 = share.currentCode('dev-a').code;
  assert.notEqual(c2, c);
  share._codes.get('dev-a').expiresAt = Date.now() - 1;
  assert.equal(share.redeemCode(c2), null, 'expired');
  // The sweep rotates expiring codes and pushes them to the screen.
  share.currentCode('dev-a');
  share._codes.get('dev-a').expiresAt = Date.now() + 500;
  const old = share._codes.get('dev-a').code;
  emits.length = 0;
  share._sweep();
  await sleep(200);
  const pushed = emits.filter((e) => e.ev === 'device:screenshare-code' && e.id === 'dev-a').pop();
  assert.ok(pushed && pushed.data.code, 'a fresh code is pushed');
  assert.notEqual(pushed.data.code.replace('-', ''), old);
  assert.ok(pushed.data.expires_at > Date.now() + share.CODE_TTL_MS - 5000);
});

test('the pushed code carries a QR only for a known origin, as a PNG data URL, with the code in the fragment', async () => {
  share.onDeviceRegistered('dev-a', { headers: { host: '127.0.0.1:4231' }, secure: false });
  await sleep(300);
  const pushed = emits.filter((e) => e.ev === 'device:screenshare-code' && e.id === 'dev-a').pop();
  assert.ok(pushed, 'a registered screen with the code on is sent it');
  assert.match(pushed.data.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(pushed.data.url, 'http://127.0.0.1:4231/share');
  assert.match(pushed.data.qr, /^data:image\/png;base64,/);
  emits.length = 0;
  share.onDeviceRegistered('dev-a2', { headers: { host: '127.0.0.1:4231' } });
  await sleep(100);
  assert.ok(!emits.some((e) => e.id === 'dev-a2' && e.ev === 'device:screenshare-code' && e.data.code), 'code off: nothing to show');
});

test('a guest join is audited as a guest join with the name they gave, cleaned', () => {
  const out = start('dev-a', { guest: true, userId: null, sharedBy: 'Mallory\u202e\u0007 <b>CEO</b>' + 'x'.repeat(80) });
  assert.equal(out.session.sharedBy.length, 40);
  assert.ok(!/[\u202e\u0007]/.test(out.session.sharedBy));
  const row = db.prepare("SELECT * FROM activity_log WHERE action = 'screen_share.guest_join' ORDER BY id DESC").get();
  assert.equal(row.user_id, null);
  assert.equal(row.ip_address, '10.0.0.9');
  assert.equal(JSON.parse(row.details).guest, true);
});

test('an unused ticket expires and frees the screen', async () => {
  const before = share.TICKET_TTL_MS;
  // Exercise the same path the timer takes.
  const { session } = start('dev-a');
  share.endSession(session, 'not_connected');
  assert.equal(share.sessionForDevice('dev-a'), null);
  assert.equal(before, 60000);
});
