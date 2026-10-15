'use strict';

/*
 * 3.0 display-link mirrors (lib/mirrors.js), at the socket: what ANY player — including an old one
 * that knows nothing about mirrors — gets when one display link is open in more than one place.
 *
 *   - a second install opening the link while the display is live becomes a MIRROR (its own device
 *     row and token), and the original is NOT evicted;
 *   - the same install reconnecting is still today's eviction, and makes no mirror;
 *   - the same install reopening comes back as the same mirror, even with the original offline;
 *   - a mirror's payload is the original's (minus the per-site secrets), and a push to the original
 *     reaches the mirror;
 *   - removing a mirror tells it so; removing the original removes its mirrors;
 *   - a full plan refuses the mirror with a reason; a link cannot be minted on a mirror; the owning
 *     fingerprint never leaves the server;
 *   - two live sockets of ONE identity alternating stop after a burst (ping-pong guard).
 *
 * Also the pure helpers (location line, ping-pong verdict).
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');
const { startServer, sleep, waitFor } = require('./helpers/web-player-e2e');

let srv;
before(async () => { srv = await startServer('mirrors'); });
after(() => { if (srv) srv.stop(); });

const db = (sql, ...a) => {
  const D = require('better-sqlite3');
  const d = new D(path.join(srv.dataDir, 'db', 'remote_display.db'));
  try { return /^\s*select/i.test(sql) ? d.prepare(sql).all(...a) : d.prepare(sql).run(...a); } finally { d.close(); }
};

/** A player socket that stays open. `events` collects everything the server says to it. */
function player(payload, { ua } = {}) {
  return new Promise((resolve) => {
    const sock = ioClient(`${srv.base}/device`, {
      transports: ['websocket'], reconnection: false, forceNew: true,
      extraHeaders: ua ? { 'User-Agent': ua } : undefined,
    });
    const p = { sock, events: [], registered: null, closed: false };
    sock.onAny((ev, d) => p.events.push([ev, d]));
    sock.on('disconnect', () => { p.closed = true; });
    sock.on('connect', () => sock.emit('device:register', { device_info: {}, client_type: 'player', ...payload }));
    sock.on('device:registered', (d) => { p.registered = d; resolve(p); });
    for (const ev of ['device:throttled', 'device:auth-error', 'device:mirror-refused']) sock.on(ev, () => setTimeout(() => resolve(p), 100));
    setTimeout(() => resolve(p), 6000);
  });
}
const heartbeat = (p) => p.sock.emit('device:heartbeat', { device_id: p.registered.device_id });
const got = (p, ev) => p.events.filter((e) => e[0] === ev).map((e) => e[1]);
const fp = () => 'fp-' + crypto.randomBytes(6).toString('hex');
const close = (...ps) => ps.forEach((p) => { try { p.sock.close(); } catch { /* */ } });

async function playlistWith(name) {
  const pl = await srv.api('POST', '/playlists', { name });
  return pl;
}

describe('lib/mirrors helpers', () => {
  test('describeLocation names the browser, the system and the address', () => {
    const m = require('../lib/mirrors');
    assert.equal(m.describeLocation('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0', '::ffff:10.0.0.5'), 'Firefox on Windows · 10.0.0.5');
    assert.equal(m.describeLocation('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36', '127.0.0.1'), 'Chrome on Linux · 127.0.0.1');
    assert.equal(m.describeLocation('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', null), 'Safari on macOS');
    assert.equal(m.describeLocation('', ''), 'Browser');
  });
  test('the ping-pong verdict refuses only after a burst of live evictions', () => {
    const m = require('../lib/mirrors');
    m._resetDuels();
    const t0 = 1e12;
    for (let i = 0; i < m.DUEL_LIMIT - 1; i++) m.noteEviction('dev-x', t0 + i * 1000);
    assert.equal(m.pingPongVerdict('dev-x', t0 + 10000).refuse, false);
    m.noteEviction('dev-x', t0 + 11000);
    assert.equal(m.pingPongVerdict('dev-x', t0 + 12000).refuse, true);
    assert.equal(m.pingPongVerdict('dev-x', t0 + m.DUEL_WINDOW_MS + 20000).refuse, false, 'forgotten after the window');
    assert.equal(m.pingPongVerdict('dev-y', t0).refuse, false, 'per device');
  });
});

describe('display-link mirrors at the socket', () => {
  test('a second install becomes a mirror; the original is not evicted; both get the same content', async () => {
    const d = (await srv.api('POST', '/devices/web-player', { name: 'Hall' }));
    const X = d.device.id, key = d.enrol_key;
    const a = await player({ enrol_key: key, fingerprint: fp() });
    assert.equal(a.registered && a.registered.device_id, X, 'the first opening is the display');
    const b = await player({ enrol_key: key, fingerprint: fp() }, { ua: 'Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/131.0' });
    assert.ok(b.registered, 'the second opening registered');
    const M = b.registered.device_id;
    assert.notEqual(M, X, 'as a different display row');
    assert.ok(b.registered.device_token && b.registered.device_token !== a.registered.device_token, 'with its own token');
    await sleep(500);
    assert.equal(a.closed, false, 'the original was NOT evicted');
    const row = db('SELECT name, mirror_of, mirror_location, workspace_id, user_id FROM devices WHERE id = ?', M)[0];
    assert.equal(row.mirror_of, X);
    assert.equal(row.name, 'Hall (mirror 1)');
    assert.match(row.mirror_location, /^Firefox on Windows · /);
    const orig = db('SELECT workspace_id, user_id FROM devices WHERE id = ?', X)[0];
    assert.equal(row.workspace_id, orig.workspace_id, 'in the original\'s workspace');

    // Detail: the original lists it, the mirror names the original; the fingerprint stays home.
    const det = await srv.api('GET', `/devices/${X}`);
    assert.equal(det.mirrors.length, 1);
    assert.equal(det.mirrors[0].id, M);
    const mdet = await srv.api('GET', `/devices/${M}`);
    assert.equal(mdet.mirror_source.id, X);
    assert.equal(mdet.mirror_fingerprint, undefined);
    const list = await srv.api('GET', '/devices');
    assert.ok(list.some((x) => x.id === M && x.mirror_of === X), 'the list carries mirror_of');
    assert.ok(list.every((x) => x.mirror_fingerprint === undefined), 'and never the fingerprint');

    // A push to the original reaches both, with the same items.
    const content = await srv.upload(path.join(__dirname, 'fixtures', 'media', 'clip-3s.webm'), 'video/webm');
    const pl = await playlistWith('Hall loop');
    await srv.api('POST', `/playlists/${pl.id}/items`, { content_id: content.id });
    await srv.api('POST', `/playlists/${pl.id}/publish`);
    const before = [got(a, 'device:playlist-update').length, got(b, 'device:playlist-update').length];
    await srv.api('POST', `/playlists/${pl.id}/assign`, { device_id: X });
    assert.ok(await waitFor(() => got(a, 'device:playlist-update').length > before[0] && got(b, 'device:playlist-update').length > before[1], 10000), 'both were pushed');
    const pa = got(a, 'device:playlist-update').at(-1), pb = got(b, 'device:playlist-update').at(-1);
    assert.deepEqual(pb.assignments.map((x) => x.content_id), [content.id], 'the mirror plays the original\'s playlist');
    assert.deepEqual(pa.assignments.map((x) => x.content_id), [content.id]);
    assert.equal(pb.mirror_of, X);
    assert.equal(pb.trigger_config, null, 'no LAN trigger secret on a mirror');
    assert.equal(pb.local_api, null, 'no local API secret on a mirror');
    assert.equal(pb.wall_config, null);

    // The same install reopening (no stored identity, or the stored mirror one) is the same mirror.
    const fpB = db('SELECT mirror_fingerprint FROM devices WHERE id = ?', M)[0].mirror_fingerprint;
    close(b);
    await sleep(300);
    const b2 = await player({ enrol_key: key, fingerprint: fpB });
    assert.equal(b2.registered.device_id, M, 'same mirror, from the link alone');
    close(b2);
    await sleep(300);
    const b3 = await player({ enrol_key: key, fingerprint: fpB, device_id: M, device_token: b2.registered.device_token });
    assert.equal(b3.registered.device_id, M, 'same mirror, with its stored identity');
    // ...even when the original is off: a mirror never turns into the original.
    close(a);
    await sleep(500);
    close(b3);
    await sleep(300);
    const b4 = await player({ enrol_key: key, fingerprint: fpB });
    assert.equal(b4.registered.device_id, M);
    assert.equal(db('SELECT COUNT(*) AS n FROM devices WHERE mirror_of = ?', X)[0].n, 1, 'still one mirror row');
    close(b4);

    // Removing the mirror tells it; removing the original takes its mirrors with it.
    const b5 = await player({ enrol_key: key, fingerprint: fpB });
    await srv.api('DELETE', `/devices/${M}`);
    assert.ok(await waitFor(() => got(b5, 'device:mirror-removed').length === 1 && got(b5, 'device:unpaired').length === 1, 5000), 'the mirror heard it was removed');
    const ev = b5.events.map((e) => e[0]);
    assert.ok(ev.indexOf('device:mirror-removed') < ev.indexOf('device:unpaired'), 'before the generic unpaired');
    close(b5);
    const a2 = await player({ enrol_key: key, fingerprint: fp() });
    const c = await player({ enrol_key: key, fingerprint: fp() });
    const M2 = c.registered.device_id;
    assert.notEqual(M2, X);
    await srv.api('DELETE', `/devices/${X}`);
    assert.equal(db('SELECT COUNT(*) AS n FROM devices WHERE id IN (?, ?)', X, M2)[0].n, 0, 'original and mirror gone');
    assert.ok(await waitFor(() => got(c, 'device:mirror-removed').length === 1, 5000));
    close(a2, c);
  });

  test('the same install reconnecting is still an eviction, never a mirror', async () => {
    const d = await srv.api('POST', '/devices/web-player', { name: 'Kiosk' });
    const f = fp();
    const a = await player({ enrol_key: d.enrol_key, fingerprint: f });
    await sleep(3000);   // past the session-settle window
    const a2 = await player({ enrol_key: d.enrol_key, fingerprint: f });
    assert.equal(a2.registered.device_id, d.device.id);
    assert.ok(await waitFor(() => a.closed, 3000), 'the old socket of the same install was replaced');
    assert.equal(db('SELECT COUNT(*) AS n FROM devices WHERE mirror_of = ?', d.device.id)[0].n, 0);
    close(a, a2);
  });

  test('with the original closed, another install opening the link IS the display (no mirror)', async () => {
    const d = await srv.api('POST', '/devices/web-player', { name: 'Handover' });
    const a = await player({ enrol_key: d.enrol_key, fingerprint: fp() });
    close(a);
    await sleep(800);
    const b = await player({ enrol_key: d.enrol_key, fingerprint: fp() });
    assert.equal(b.registered.device_id, d.device.id);
    assert.equal(db('SELECT COUNT(*) AS n FROM devices WHERE mirror_of = ?', d.device.id)[0].n, 0);
    close(b);
  });

  test('a full plan refuses the mirror and says why; the original plays on', async () => {
    const d = await srv.api('POST', '/devices/web-player', { name: 'Full' });
    const a = await player({ enrol_key: d.enrol_key, fingerprint: fp() });
    heartbeat(a);
    const plans = db('SELECT DISTINCT plan_id FROM users').map((r) => r.plan_id).filter(Boolean);
    const old = plans.map((id) => db('SELECT id, max_devices FROM plans WHERE id = ?', id)[0]);
    const n = db('SELECT COUNT(*) AS n FROM devices')[0].n;
    for (const id of plans) db('UPDATE plans SET max_devices = ? WHERE id = ?', n, id);
    try {
      const b = await player({ enrol_key: d.enrol_key, fingerprint: fp() });
      assert.equal(b.registered, null, 'not registered');
      const r = got(b, 'device:mirror-refused')[0];
      assert.equal(r && r.reason, 'mirror_limit');
      assert.match(r.error, /plan/);
      assert.equal(got(b, 'device:throttled')[0].reason, 'mirror_limit', 'old players get a reason they already honour');
      assert.equal(db('SELECT COUNT(*) AS n FROM devices WHERE mirror_of = ?', d.device.id)[0].n, 0);
      assert.equal(a.closed, false, 'the original plays on');
      close(b);
    } finally {
      for (const p of old) db('UPDATE plans SET max_devices = ? WHERE id = ?', p.max_devices, p.id);
      close(a);
    }
  });

  test('a display link is never minted on a mirror', async () => {
    const d = await srv.api('POST', '/devices/web-player', { name: 'Linkless' });
    const a = await player({ enrol_key: d.enrol_key, fingerprint: fp() });
    const b = await player({ enrol_key: d.enrol_key, fingerprint: fp() });
    const M = b.registered.device_id;
    await assert.rejects(srv.api('POST', `/devices/${M}/enrol-key`), /409/);
    close(a, b);
  });

  test('two live sockets of ONE identity alternating are stopped after a burst (ping-pong guard)', async () => {
    const d = await srv.api('POST', '/devices/web-player', { name: 'Twin tabs' });
    const f = fp();
    const opened = [];
    let refused = null;
    for (let i = 0; i < 9 && !refused; i++) {
      const p = await player({ enrol_key: d.enrol_key, fingerprint: f });
      opened.push(p);
      if (p.registered) heartbeat(p);
      const th = got(p, 'device:throttled')[0];
      if (th && th.reason === 'display_open_elsewhere') refused = { i, th };
      await sleep(2700);   // past session settle; under the burst reconnect throttle
    }
    assert.ok(refused, 'the alternation was stopped');
    assert.ok(refused.i >= 6, 'only after a burst, not on the first duplicate: ' + refused.i);
    assert.ok(refused.th.retry_after_ms >= 60000);
    close(...opened);
  });
});
