'use strict';

/*
 * The ENABLEMENT half of triggers, and the push that makes the offline guarantee true.
 *
 * ⚠️ Why this file exists: a QA pass found that nothing anywhere wrote trigger_secret or the accept
 * flags. deviceSocket.js read them and projected them to the player, the player consumed them, the
 * dashboard displayed their diagnostics — and no route ever set them. So on any system configured
 * through the product the secret was NULL, evaluate() answered bad_secret to every payload, and no
 * listener bound. The feature was inert, behind a green suite, because every test drove the
 * resolver directly with a secret it supplied itself.
 *
 * The second half is delivery: creating a trigger used to reach devices only on their next
 * reconnect. For a panel that has been up for weeks that is never — so the definition sat in the
 * database looking configured while the screen knew nothing and its media was never pinned.
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
let proc, BASE, DATA_DIR, jwt, workspaceId, deviceId, playlistId, PORT;

const J = (tok, body, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trig-enable-'));
  const LOG = path.join(DATA_DIR, 'server.log');
  const logFd = fs.openSync(LOG, 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  const reg = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `enable${Date.now()}@example.com`, password: 'Passw0rd123', name: 'Enable',
  }))).json();
  jwt = reg.token; workspaceId = reg.current_workspace_id;

  const pl = await (await fetch(BASE + '/api/playlists', J(jwt, { name: 'Alarm loop' }))).json();
  playlistId = pl.id;

  const Database = require('better-sqlite3');
  const raw = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  deviceId = crypto.randomUUID();
  raw.prepare('INSERT INTO devices (id, name, workspace_id, status) VALUES (?, ?, ?, ?)')
    .run(deviceId, 'Lobby', workspaceId, 'offline');
  const owner = raw.prepare('SELECT user_id FROM playlists WHERE id = ?').get(playlistId);
  raw.prepare('UPDATE playlists SET published_snapshot = ?, user_id = COALESCE(user_id, ?) WHERE id = ?')
    .run(JSON.stringify([{ content_id: 'seed', filename: 'Evac', filepath: 'uploads/evac.mp4' }]),
         owner && owner.user_id, playlistId);
  raw.close();
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

const dbHandle = () => new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db'));

/*
 * A REAL device socket. Asserting on the database instead would prove that the trigger RESOLVES,
 * which is true whether or not anything was ever sent — and that is exactly the mistake this file
 * exists to stop making. Mutating out the push left a database-only assertion green.
 */
function provision() {
  const code = String(crypto.randomInt(100000, 1000000));
  return new Promise((resolve, reject) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sock.on('connect', () => sock.emit('device:register', { pairing_code: code }));
    sock.on('device:registered', (d) => { try { sock.close(); } catch { /* */ } resolve({ id: d.device_id, token: d.device_token }); });
    sock.on('connect_error', (e) => reject(e));
    setTimeout(() => reject(new Error('provision timeout')), 15000);
  });
}
function openRegistered(dev) {
  return new Promise((resolve, reject) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sock.on('connect', () => sock.emit('device:register', {
      device_id: dev.id, device_token: dev.token, device_info: { app_version: 'test' } }));
    sock.on('device:registered', () => resolve(sock));
    sock.on('device:auth-error', () => reject(new Error('auth-error')));
    setTimeout(() => reject(new Error('register timeout')), 15000);
  });
}
/**
 * Wait for a playlist-update SATISFYING a predicate, not merely the next one.
 *
 * ⚠️ Registration itself emits an update, so a bare `once` handler armed before the API call
 * captures that instead and the assertion then examines the wrong payload — which is how this test
 * first "failed": the push had arrived, just second. Matching on content removes the race.
 */
function waitForUpdate(sock, predicate, ms = 6000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { sock.off('device:playlist-update', h); resolve(null); }, ms);
    function h(p) {
      if (!predicate || predicate(p)) { clearTimeout(t); sock.off('device:playlist-update', h); resolve(p); }
    }
    sock.on('device:playlist-update', h);
  });
}
const hasTrigger = (tok) => (p) => (p && p.triggers || []).some((x) => x.match_token === tok);

/*
 * A published playlist of pinnable media, per test.
 *
 * ⚠️ Each test gets its OWN. The publish test republishes its target, and publishPlaylist rebuilds
 * published_snapshot from the real playlist_items table — which these fixtures do not populate — so
 * sharing one playlist let an earlier test empty the snapshot out from under a later one, which
 * then hit the empty-playlist guard. (That the guard caught it is the system working; the shared
 * fixture was the bug.)
 */
function publishedPlaylist(name) {
  const raw = dbHandle();
  const id = crypto.randomUUID();
  const owner = raw.prepare('SELECT user_id FROM playlists WHERE id = ?').get(playlistId);
  raw.prepare('INSERT INTO playlists (id, name, workspace_id, user_id, published_snapshot) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, workspaceId, owner && owner.user_id,
         JSON.stringify([{ content_id: 'seed-' + name, filename: 'Evac', filepath: 'uploads/evac.mp4' }]));
  raw.close();
  return id;
}

test('⚠️ a device has NO trigger secret until one is set — the feature is off by default', () => {
  const raw = dbHandle();
  const d = raw.prepare('SELECT trigger_secret, triggers_accept_http, triggers_accept_udp FROM devices WHERE id = ?').get(deviceId);
  raw.close();
  assert.equal(d.trigger_secret, null, 'a device must not ship with a usable trigger credential');
  assert.ok(!d.triggers_accept_http && !d.triggers_accept_udp, 'both doors must default closed');
});

test('rotating generates a secret, returns it once, and marks it set', async () => {
  const r = await fetch(BASE + `/api/devices/${deviceId}/trigger-secret`, J(jwt, { rotate: true }));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.match(body.secret, /^[0-9a-f]{32}$/, 'a generated secret must be CSPRNG hex');
  const raw = dbHandle();
  assert.equal(raw.prepare('SELECT trigger_secret FROM devices WHERE id = ?').get(deviceId).trigger_secret, body.secret);
  raw.close();
});

test('a too-short secret is refused — this is guessable offline with no lockout', async () => {
  const r = await fetch(BASE + `/api/devices/${deviceId}/trigger-secret`, J(jwt, { secret: 'short' }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /16-128/);
});

test('a secret containing a space is refused — the wire format is space-separated', async () => {
  const r = await fetch(BASE + `/api/devices/${deviceId}/trigger-secret`, J(jwt, { secret: 'has a space in it xx' }));
  assert.equal(r.status, 400);
});

test('the accept flags and ports round-trip', async () => {
  const r = await fetch(BASE + `/api/devices/${deviceId}/trigger-config`, J(jwt, {
    accept_http: true, accept_udp: true, http_port: 8079, udp_port: 7847, multicast_group: '239.255.42.1',
  }));
  assert.equal(r.status, 200);
  const c = (await r.json()).trigger_config;
  assert.equal(c.accept_http, true);
  assert.equal(c.accept_udp, true);
  assert.equal(c.http_port, 8079);
  assert.equal(c.multicast_group, '239.255.42.1');
  assert.equal(c.secret_set, true, 'the config response must say whether a secret exists...');
  assert.equal(c.secret, undefined, '...without ever echoing the secret itself');
});

test('a privileged port is refused — binding below 1024 needs root', async () => {
  const r = await fetch(BASE + `/api/devices/${deviceId}/trigger-config`, J(jwt, { http_port: 80 }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /1024-65534/);
});

test('⚠️ a non-multicast group is refused — joinGroup would silently never receive', async () => {
  // A unicast address fails joinGroup, and the failure looks exactly like "the integrator never
  // sent anything" — which is the single confusion the diagnostics exist to remove.
  for (const bad of ['192.168.1.10', '240.0.0.1', 'not-an-ip', '223.255.255.255']) {
    const r = await fetch(BASE + `/api/devices/${deviceId}/trigger-config`, J(jwt, { multicast_group: bad }));
    assert.equal(r.status, 400, `${bad} was accepted as a multicast group`);
  }
  const ok = await fetch(BASE + `/api/devices/${deviceId}/trigger-config`, J(jwt, { multicast_group: '224.0.0.9' }));
  assert.equal(ok.status, 200, 'the bottom of 224.0.0.0/4 must be allowed');
});

test('⚠️ a clear-all token may not shadow a trigger token', async () => {
  /*
   * evaluate() checks clearAllToken BEFORE iterating the device's triggers, so a collision makes
   * that trigger permanently unfirable on this device — and nothing logs, because from the
   * resolver's point of view the token matched. A silently unfirable emergency overlay is the
   * worst failure this feature has.
   */
  const t = await (await fetch(BASE + '/api/triggers', J(jwt, {
    name: 'Evacuate', match_token: 'EVAC_SHADOW', clear_token: 'EVAC_SHADOW_CLR',
    mode: 'until_cleared', target_kind: 'playlist', target_ref: playlistId, source_udp: true,
  }))).json();
  assert.ok(t.id, 'setup trigger was not created');

  for (const tok of ['EVAC_SHADOW', 'EVAC_SHADOW_CLR']) {
    const r = await fetch(BASE + `/api/devices/${deviceId}/trigger-config`, J(jwt, { clear_all_token: tok }));
    assert.equal(r.status, 400, `clear_all_token "${tok}" was allowed to shadow a trigger`);
    assert.match((await r.json()).error, /shadow|already used/);
  }
  const ok = await fetch(BASE + `/api/devices/${deviceId}/trigger-config`, J(jwt, { clear_all_token: 'ALLSTOP' }));
  assert.equal(ok.status, 200, 'a non-colliding clear-all token must be accepted');
});

test('⚠️ creating a trigger PUSHES it and its media to a CONNECTED device, immediately', async () => {
  /*
   * The offline guarantee is only true if the definition and the target playlist's content reach
   * the device BEFORE anything goes wrong. Creating a trigger used to reach devices only on their
   * next reconnect — for a panel up for weeks, never: the definition sat in the database looking
   * configured while the screen knew nothing and its media was never pinned.
   *
   * ⚠️ This watches the SOCKET, not the database. An earlier version of this test asserted that
   * triggersForDevice() resolved the new row, which is true whether or not anything was ever sent —
   * commenting out the push left it green. Delivery is the property; delivery has to be asserted.
   */
  const dev = await provision();
  const sock = await openRegistered(dev);
  try {
    // Give the device the same published playlist as a trigger target.
    const raw = dbHandle();
    raw.prepare('UPDATE devices SET workspace_id = ? WHERE id = ?').run(workspaceId, dev.id);
    raw.close();

    const seen = waitForUpdate(sock, hasTrigger('FIRE_PUSH'));
    const t = await (await fetch(BASE + '/api/triggers', J(jwt, {
      name: 'Fire', match_token: 'FIRE_PUSH', mode: 'until_cleared',
      target_kind: 'playlist', target_ref: publishedPlaylist('fire-push'), source_udp: true,
      assignments: [{ target_type: 'device', target_id: dev.id }],
    }))).json();
    assert.ok(t.id, `trigger was not created: ${JSON.stringify(t)}`);

    const payload = await seen;
    assert.ok(payload, 'no playlist-update reached the device when the trigger was created');
    const mine = (payload.triggers || []).find((x) => x.match_token === 'FIRE_PUSH');
    assert.ok(mine, 'the pushed payload does not carry the new trigger');
    assert.ok(Array.isArray(mine.items) && mine.items.length,
      'the trigger arrived with no items — nothing to cache locally, nothing to play offline');
    assert.equal(mine.items[0].filepath, 'uploads/evac.mp4',
      'the target playlist was not resolved inline, so the device cannot pin the content');
  } finally { try { sock.close(); } catch { /* */ } }
});

test('⚠️ publishing a playlist reaches a device that holds it only as a TRIGGER target', async () => {
  /*
   * pushToDevices selected `WHERE playlist_id = ?` only, so a screen referencing a playlist solely
   * through a trigger was never in the set. The operator swaps the evacuation notice, publishes,
   * sees "Published" — and every panel keeps firing the OLD items with the old asset still pinned.
   */
  const dev = await provision();
  const sock = await openRegistered(dev);
  try {
    const raw = dbHandle();
    raw.prepare('UPDATE devices SET workspace_id = ?, playlist_id = NULL WHERE id = ?').run(workspaceId, dev.id);
    raw.close();

    const targetOnly = publishedPlaylist('target-only');
    await (await fetch(BASE + '/api/triggers', J(jwt, {
      name: 'Target only', match_token: 'TGT_ONLY', mode: 'once',
      target_kind: 'playlist', target_ref: targetOnly, source_udp: true,
      assignments: [{ target_type: 'device', target_id: dev.id }],
    }))).json();
    await waitForUpdate(sock, hasTrigger('TGT_ONLY'));   // the create push

    // Any further update proves the publish fan-out reached a trigger-only device.
    const seen = waitForUpdate(sock, null);
    const pub = await fetch(BASE + `/api/playlists/${targetOnly}/publish`, J(jwt, {}));
    assert.equal(pub.status, 200, 'publish failed');
    assert.ok(await seen,
      'publishing the target playlist did not reach a device that only references it via a trigger');
  } finally { try { sock.close(); } catch { /* */ } }
});

test('the device row carries the trigger config the player needs to bind its listeners', () => {
  const raw = dbHandle();
  const d = raw.prepare(`SELECT trigger_secret, triggers_accept_udp, trigger_clear_all_token
                           FROM devices WHERE id = ?`).get(deviceId);
  raw.close();
  assert.ok(d.trigger_secret, 'without a secret every payload is rejected as bad_secret');
  assert.equal(d.triggers_accept_udp, 1);
  assert.equal(d.trigger_clear_all_token, 'ALLSTOP');
});

test('⚠️ deleting a trigger still reaches the devices that were showing it', async () => {
  // The affected set has to be read BEFORE the row goes — trigger_assignments cascades, so
  // afterwards there is nothing left to ask, and the device would keep a definition that no longer
  // exists anywhere in the dashboard (and keep its media pinned forever).
  const t = await (await fetch(BASE + '/api/triggers', J(jwt, {
    name: 'Temp', match_token: 'TEMP_DEL', mode: 'once',
    target_kind: 'playlist', target_ref: publishedPlaylist('temp-del'), source_udp: true,
    assignments: [{ target_type: 'device', target_id: deviceId }],
  }))).json();
  assert.ok(t.id, `setup trigger was not created: ${JSON.stringify(t)}`);
  const raw = dbHandle();
  const { devicesForTrigger } = require('../lib/device-triggers');
  assert.ok(devicesForTrigger(raw, t.id).includes(deviceId),
    `the trigger is not resolved for the device it was assigned to: ${JSON.stringify(devicesForTrigger(raw, t.id))}`);
  raw.close();

  const d = await fetch(BASE + '/api/triggers/' + t.id, J(jwt, undefined, 'DELETE'));
  assert.equal(d.status, 200);

  const raw2 = dbHandle();
  const gone = raw2.prepare('SELECT COUNT(*) n FROM trigger_assignments WHERE trigger_id = ?').get(t.id).n;
  raw2.close();
  assert.equal(gone, 0, 'assignments did not cascade');
});
