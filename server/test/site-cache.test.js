'use strict';

/*
 * 3.0 site cache (lib/site-cache, routes/site-caches.js, routes/site-cache-node.js; docs/site-cache.md).
 *
 * In process, against a real database and a real cache node on a loopback port:
 *   - screen tokens: minted by the origin, checked by the box; tampering, expiry, another cache's key
 *   - capability gating: a player that does not declare net.site_cache gets a byte-identical payload
 *   - the pre-warm manifest is exactly the assigned screens' own payload digests
 *   - TENANCY: workspace B's digest is refused by workspace A's box (by the box AND by the origin),
 *     even with a valid screen token; a token for a screen the box does not serve is refused
 *   - integrity: bytes that do not hash to their name are never kept or served; a scrub finds rot
 *   - revoking (rotating) the box's token stops it serving
 *   - the dashboard routes: admin only, viewer refused, no secret ever listed, no cross-workspace ids
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-sitecache-' + crypto.randomBytes(4).toString('hex'));
process.env.JWT_SECRET = 'test-secret-sitecache';
process.env.NODE_ENV = 'test';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const config = require('../config');
const setupDeviceSocket = require('../ws/deviceSocket');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const tokens = require('../lib/site-cache/tokens');
const origin = require('../lib/site-cache/origin');
const { SiteCacheNode } = require('../lib/site-cache/node');

const O = 'o-sc', WA = 'ws-sc-a', WB = 'ws-sc-b';
const ADMIN = 'u-sc-admin', VIEWER = 'u-sc-viewer', EDITOR = 'u-sc-editor', BADMIN = 'u-sc-badmin';
const GA = 'g-sc-a';
const DA1 = 'd-sc-a1', DA2 = 'd-sc-a2', DA3 = 'd-sc-a3', DB1 = 'd-sc-b1';
const CAPABLE = JSON.stringify(['playback.video', 'playback.image', 'offline.cache', 'net.site_cache']);

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const files = {};
function mkContent(id, ws, bytes, { digest = true, claim = null } = {}) {
  const name = `${crypto.randomUUID()}.png`;
  fs.mkdirSync(config.contentDir, { recursive: true });
  fs.writeFileSync(path.join(config.contentDir, name), bytes);
  const d = claim || (digest ? sha(bytes) : null);
  db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, byte_digest)
              VALUES (?, ?, ?, ?, ?, 'image/png', ?, ?)`).run(id, ADMIN, ws, `${id}.png`, name, bytes.length, d);
  files[id] = { bytes, sha: sha(bytes), name };
}
function mkPlaylist(id, ws, contentIds) {
  const items = contentIds.map((cid, i) => ({ content_id: cid, widget_id: null, filename: `${cid}.png`, mime_type: 'image/png',
    filepath: files[cid].name, duration_sec: 10, sort_order: i }));
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, status, published_snapshot) VALUES (?, ?, ?, ?, 'published', ?)")
    .run(id, ADMIN, ws, id, JSON.stringify(items));
}
function mkDevice(id, ws, playlist, caps, owner = ADMIN) {
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, playlist_id, playlist_source, capabilities) VALUES (?, ?, ?, ?, ?, ?, 'device', ?)")
    .run(id, owner, ws, id, crypto.randomUUID().slice(0, 6), playlist, caps);
}

let build, app, server, base;
before(async () => {
  setupDeviceSocket(new Server(http.createServer()));
  build = setupDeviceSocket.buildPlaylistPayload;
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, 'scadmin@t.local', 'x', 'user'), (?, 'scview@t.local', 'x', 'user'), (?, 'scedit@t.local', 'x', 'user'), (?, 'scb@t.local', 'x', 'user')")
    .run(ADMIN, VIEWER, EDITOR, BADMIN);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(O, 'Org', ADMIN);
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('o-sc-b', 'Other org', ?)").run(BADMIN);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(WA, O, 'Campus A');
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES (?, 'o-sc-b', 'Tenant B')").run(WB);
  db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin'), (?, ?, 'workspace_viewer'),
              (?, ?, 'workspace_editor'), (?, ?, 'workspace_admin')`).run(WA, ADMIN, WA, VIEWER, WA, EDITOR, WB, BADMIN);

  mkContent('c-sc-a1', WA, crypto.randomBytes(3000));
  mkContent('c-sc-a2', WA, crypto.randomBytes(2000), { digest: false });   // a legacy row: hashed lazily
  mkContent('c-sc-b1', WB, crypto.randomBytes(1500));
  mkPlaylist('p-sc-a', WA, ['c-sc-a1', 'c-sc-a2']);
  mkPlaylist('p-sc-b', WB, ['c-sc-b1']);
  mkDevice(DA1, WA, 'p-sc-a', CAPABLE);
  mkDevice(DA2, WA, 'p-sc-a', null);              // an old player: declares nothing
  mkDevice(DA3, WA, 'p-sc-a', CAPABLE);           // capable, but on no cache
  mkDevice(DB1, WB, 'p-sc-b', CAPABLE, BADMIN);
  db.prepare('INSERT INTO device_groups (id, name, user_id, workspace_id) VALUES (?, ?, ?, ?)').run(GA, 'Lobby', ADMIN, WA);
  db.prepare('INSERT INTO device_group_members (device_id, group_id) VALUES (?, ?), (?, ?)').run(DA1, GA, DA2, GA);

  app = express();
  app.use(express.json());
  app.use('/api/site-cache/node', require('../routes/site-cache-node'));
  app.use('/api/site-caches', requireAuth, resolveTenancy, require('../routes/site-caches'));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { try { server.close(); } catch { /* */ } });

const tokenOf = (u, ws = WA) => generateToken(db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(u), ws);
async function call(method, p, body, user = ADMIN, ws = WA) {
  const r = await fetch(base + '/api/site-caches' + p, {
    method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenOf(user, ws), 'X-Workspace-Id': ws },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await r.json(); } catch { /* */ }
  return { status: r.status, body: json };
}

/* ──────────────────────────────────────────────────────────── tokens ── */

test('screen tokens: verify round-trip; tampering, expiry, another cache, another key all fail', () => {
  const key = 'k'.repeat(64);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const t = tokens.mintPlayerToken(key, { cacheId: 'cache-1', deviceId: 'dev-1', exp });
  assert.deepEqual(tokens.verifyPlayerToken(key, t, { cacheId: 'cache-1' }), { deviceId: 'dev-1', exp });
  assert.equal(tokens.verifyPlayerToken(key, t, { cacheId: 'cache-2' }), null, 'minted for another cache');
  assert.equal(tokens.verifyPlayerToken('other-key', t, { cacheId: 'cache-1' }), null, 'another cache\'s key');
  assert.equal(tokens.verifyPlayerToken(key, t.replace('dev-1', 'dev-2'), { cacheId: 'cache-1' }), null, 'the device swapped');
  assert.equal(tokens.verifyPlayerToken(key, t.replace(`.${exp}.`, `.${exp + 999999}.`), { cacheId: 'cache-1' }), null, 'expiry extended');
  assert.equal(tokens.verifyPlayerToken(key, t, { cacheId: 'cache-1', nowSec: exp + 1 }), null, 'expired');
  for (const junk of ['', 'stc1', 'stc1.a.b.c.d.e', 'x'.repeat(500), null, 42]) assert.equal(tokens.verifyPlayerToken(key, junk), null);
  assert.throws(() => tokens.mintPlayerToken(key, { cacheId: 'a.b', deviceId: 'd', exp }), /id shape/);
});

test('lan_url: scheme, host and port only', () => {
  assert.equal(origin.validateLanUrl('http://10.0.0.5:8088').url, 'http://10.0.0.5:8088');
  assert.equal(origin.validateLanUrl('https://cache.school.lan/').url, 'https://cache.school.lan');
  for (const bad of ['', 'ftp://x', 'http://u:p@10.0.0.5', 'http://10.0.0.5/path', 'http://10.0.0.5/?q=1', 'not a url']) {
    assert.ok(origin.validateLanUrl(bad).error, bad);
  }
});

/* ──────────────────────────────────────────────────────── payload + manifest ── */

let cacheA, nodeTokenA, cacheB, nodeTokenB;
describe('origin: payload gating and the manifest', () => {
  let oldBefore, capableBefore;
  before(() => {
    oldBefore = JSON.stringify(build(DA2));
    capableBefore = build(DA1);
    const a = origin.createCache(db, { workspaceId: WA, name: 'Campus A', lanUrl: 'http://10.0.0.5:8088', userId: ADMIN });
    cacheA = a.row; nodeTokenA = a.token;
    const b = origin.createCache(db, { workspaceId: WB, name: 'Tenant B', lanUrl: 'http://10.9.0.5:8088', userId: BADMIN });
    cacheB = b.row; nodeTokenB = b.token;
    assert.equal(origin.setAssignments(db, cacheA, { group_ids: [GA] }).error, undefined);
    assert.equal(origin.setAssignments(db, cacheB, { device_ids: [DB1] }).error, undefined);
  });

  test('an old player (no net.site_cache) gets a byte-identical payload with a cache assigned', () => {
    assert.equal(capableBefore.site_cache, undefined, 'nothing before a cache is assigned');
    const after = build(DA2);
    assert.equal(after.site_cache, undefined);
    assert.equal(JSON.stringify(after), oldBefore, 'the payload of an un-updated player did not change by one byte');
  });

  test('a capable player on the cache gets the address, a token for itself, and per-item digests', () => {
    const p = build(DA1);
    assert.ok(p.site_cache, 'site_cache present');
    assert.equal(p.site_cache.url, 'http://10.0.0.5:8088');
    assert.deepEqual(Object.keys(p.site_cache.files), ['c-sc-a1'], 'only rows with a known digest; the legacy row waits for its hash');
    assert.deepEqual(p.site_cache.files['c-sc-a1'], { sha256: files['c-sc-a1'].sha, size: 3000 });
    const who = tokens.verifyPlayerToken(origin.fetchKeyOf(cacheA), p.site_cache.token, { cacheId: cacheA.id });
    assert.equal(who.deviceId, DA1, 'the token names this screen');
    assert.equal(p.site_cache.expires_at % 86400, 0, 'expiry bucketed to the day so the payload is stable');
    assert.equal(JSON.stringify(build(DA1).site_cache), JSON.stringify(p.site_cache), 'two builds, same bytes');
    assert.ok(!('site_cache' in p.assignments[0]), 'nothing added to the items (no fingerprint change)');
    assert.equal(build(DA3).site_cache, undefined, 'a capable screen on no cache gets nothing');
  });

  test('the manifest is exactly the assigned screens\' payload digests, and the legacy row is hashed lazily', async () => {
    let m = origin.manifestFor(db, cacheA).manifest;
    assert.deepEqual(Object.keys(m.devices).sort(), [DA1, DA2].sort(), 'group members only; DA3 is not on the cache');
    assert.deepEqual(m.devices[DA1], [files['c-sc-a1'].sha]);
    assert.deepEqual(m.files.map((f) => f.sha256), [files['c-sc-a1'].sha]);
    assert.ok(!m.files.some((f) => f.sha256 === files['c-sc-b1'].sha), 'tenant B\'s file is never in A\'s manifest');
    for (let i = 0; i < 50 && !origin._digestIdle(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(db.prepare("SELECT byte_digest FROM content WHERE id = 'c-sc-a2'").get().byte_digest, files['c-sc-a2'].sha);
    origin.forget(cacheA.id);
    m = origin.manifestFor(db, cacheA).manifest;
    assert.deepEqual(m.devices[DA1], [files['c-sc-a1'].sha, files['c-sc-a2'].sha].sort());
    assert.equal(m.files.length, 2);
  });

  test('device beats group; a disabled cache serves nobody; assignments refuse another workspace\'s ids', () => {
    assert.match(origin.setAssignments(db, cacheA, { group_ids: [GA], device_ids: [DB1] }).error, /not in this workspace/);
    assert.match(origin.setAssignments(db, cacheB, { device_ids: [DA1] }).error, /not in this workspace/);
    // A cross-tenant row written behind the API's back is still ignored on read.
    db.prepare('INSERT INTO site_cache_assignments (id, site_cache_id, workspace_id, device_id) VALUES (?, ?, ?, ?)').run('rogue', cacheB.id, WB, DA3);
    assert.equal(origin.cacheForDevice(db, DA3), null, 'a cache from workspace B never serves an A screen');
    db.prepare("DELETE FROM site_cache_assignments WHERE id = 'rogue'").run();
    const off = origin.createCache(db, { workspaceId: WA, name: 'Off', lanUrl: 'http://10.0.0.6:8088', userId: ADMIN }).row;
    db.prepare('UPDATE site_caches SET enabled = 0 WHERE id = ?').run(off.id);
    origin.setAssignments(db, db.prepare('SELECT * FROM site_caches WHERE id = ?').get(off.id), { device_ids: [DA1] });
    assert.equal(origin.cacheForDevice(db, DA1), null, 'direct row to a disabled cache means none, not the group\'s');
    db.prepare('DELETE FROM site_caches WHERE id = ?').run(off.id);
    assert.equal(origin.cacheForDevice(db, DA1).id, cacheA.id, 'back to the group\'s cache');
    origin.forgetAll();
  });
});

/* ──────────────────────────────────────────────────────── the box ── */

describe('the cache node: pre-warm, entitlement, integrity, revocation', () => {
  let node, nodeBase, dir;
  const tokenFor = (deviceId, key = origin.fetchKeyOf(db.prepare('SELECT * FROM site_caches WHERE id = ?').get(cacheA.id)), cacheId = cacheA.id) =>
    tokens.mintPlayerToken(key, { cacheId, deviceId, exp: Math.floor(Date.now() / 1000) + 3600 });
  const get = (s, token, headers = {}) => fetch(`${nodeBase}/cache/${s}`, { headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers } });

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-scnode-'));
    node = new SiteCacheNode({ origin: base, token: nodeTokenA, port: 0, host: '127.0.0.1', dir, maxBytes: 0, minFreeBytes: 0, pollSeconds: 3600 }, { log: () => {} });
    await node.start();
    await node.sync();
    nodeBase = `http://127.0.0.1:${node.port}`;
  });
  after(async () => { await node.stop(); });

  test('pre-warmed both files, verified, and reported its status to the origin', async () => {
    assert.ok(node.isHeld(files['c-sc-a1'].sha) && node.isHeld(files['c-sc-a2'].sha));
    assert.equal(node.stats.bytes_from_origin, 5000);
    const row = db.prepare('SELECT * FROM site_caches WHERE id = ?').get(cacheA.id);
    assert.equal(row.files_held, 2); assert.equal(row.files_wanted, 2);
    assert.ok(row.last_seen_at && row.last_sync_at);
  });

  test('serves a held file to an entitled screen, with ranges, and counts the hit', async () => {
    const t = tokenFor(DA1);
    const r = await get(files['c-sc-a1'].sha, t);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.equal(r.headers.get('x-st-cache'), 'hit');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), files['c-sc-a1'].bytes);
    const part = await get(files['c-sc-a1'].sha, t, { Range: 'bytes=10-19' });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 10-19/3000');
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), files['c-sc-a1'].bytes.subarray(10, 20));
    assert.equal(node.stats.hits, 1, 'a mid-file range is not a second hit');
    const pre = await fetch(`${nodeBase}/cache/${files['c-sc-a1'].sha}`, { method: 'OPTIONS', headers: { 'Access-Control-Request-Private-Network': 'true' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
    assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
  });

  test('TENANCY: another tenant\'s digest is refused even with a valid token, by the box and by the origin', async () => {
    const bSha = files['c-sc-b1'].sha;
    assert.equal((await get(bSha, tokenFor(DA1))).status, 404, 'the box: not in this screen\'s entitlement');
    // A token for B's screen signed with A's key: A's box does not serve B's screens at all.
    assert.equal((await get(files['c-sc-a1'].sha, tokenFor(DB1))).status, 404);
    // B's own key cannot open A's box.
    const bKey = origin.fetchKeyOf(cacheB);
    assert.equal((await get(files['c-sc-a1'].sha, tokenFor(DB1, bKey, cacheB.id))).status, 401);
    assert.equal((await get(files['c-sc-a1'].sha, tokenFor(DA1, bKey, cacheA.id))).status, 401);
    // The origin's blob door: A's box token cannot pull B's file by guessing its digest.
    const blob = await fetch(`${base}/api/site-cache/node/blob/${bSha}`, { headers: { Authorization: 'Bearer ' + nodeTokenA } });
    assert.equal(blob.status, 404);
    const own = await fetch(`${base}/api/site-cache/node/blob/${bSha}`, { headers: { Authorization: 'Bearer ' + nodeTokenB } });
    assert.equal(own.status, 200, 'B\'s box gets B\'s file');
    assert.equal((await fetch(`${base}/api/site-cache/node/manifest`)).status, 401, 'no token, no manifest');
    assert.equal((await fetch(`${base}/api/site-cache/node/manifest`, { headers: { Authorization: 'Bearer stcn_' + 'x'.repeat(40) } })).status, 401);
  });

  test('no token, a junk token, an expired token: 401; a digest nobody holds: 404', async () => {
    assert.equal((await get(files['c-sc-a1'].sha)).status, 401);
    assert.equal((await get(files['c-sc-a1'].sha, 'stc1.junk')).status, 401);
    const key = origin.fetchKeyOf(db.prepare('SELECT * FROM site_caches WHERE id = ?').get(cacheA.id));
    const expired = tokens.mintPlayerToken(key, { cacheId: cacheA.id, deviceId: DA1, exp: Math.floor(Date.now() / 1000) - 5 });
    assert.equal((await get(files['c-sc-a1'].sha, expired)).status, 401);
    assert.equal((await get('0'.repeat(64), tokenFor(DA1))).status, 404);
    assert.equal((await get('../state.json', tokenFor(DA1))).status, 404);
    const health = await (await fetch(`${nodeBase}/healthz`)).json();
    assert.equal(health.ok, true);
    assert.ok(!JSON.stringify(health).includes(files['c-sc-a1'].sha), 'health names no file');
  });

  test('INTEGRITY: a download that does not hash to its digest is discarded, never served', async () => {
    // The origin row claims a digest its bytes do not have (corrupted at rest, or lying).
    const real = crypto.randomBytes(1200);
    const claimed = sha(Buffer.from('something else entirely'));
    mkContent('c-sc-bad', WA, real, { claim: claimed });
    const items = JSON.parse(db.prepare("SELECT published_snapshot FROM playlists WHERE id = 'p-sc-a'").get().published_snapshot);
    items.push({ content_id: 'c-sc-bad', widget_id: null, filename: 'bad.png', mime_type: 'image/png', filepath: files['c-sc-bad'].name, duration_sec: 10, sort_order: 9 });
    db.prepare("UPDATE playlists SET published_snapshot = ? WHERE id = 'p-sc-a'").run(JSON.stringify(items));
    origin.forgetAll();
    // Corrupt the length too? No: same length as claimed is irrelevant — the digest is what decides.
    db.prepare("UPDATE content SET file_size = ? WHERE id = 'c-sc-bad'").run(real.length);
    await node.sync();
    assert.equal(node.isHeld(claimed), false, 'never moved into the store');
    assert.match(node.lastError || '', /sha256/);
    const r = await get(claimed, tokenFor(DA1));
    assert.equal(r.status, 503, 'entitled but not held: warming, never the wrong bytes');
    assert.equal(r.headers.get('x-st-cache'), 'warming');
    assert.equal(fs.readdirSync(path.join(dir, 'tmp')).length, 0, 'the bad staging file is gone');
  });

  test('a scrub finds a held file that rotted on disk and deletes it', async () => {
    const s = files['c-sc-a1'].sha;
    fs.writeFileSync(node.blobPath(s), crypto.randomBytes(3000));
    for (let i = 0; i < 4 && node.isHeld(s); i++) await node.scrubOne();
    assert.equal(node.isHeld(s), false);
    await node.sync();   // and the next round fetches a good copy again
    assert.equal(node.isHeld(s), true);
    assert.deepEqual(fs.readFileSync(node.blobPath(s)), files['c-sc-a1'].bytes);
  });

  test('rotating the token stops the old box serving anything', async () => {
    const t = tokenFor(DA1);
    origin.rotateSecrets(db, cacheA.id);
    node.etag = null;
    await node.sync();
    assert.equal(node.fetchKey, null);
    assert.equal((await get(files['c-sc-a1'].sha, t)).status, 401);
    assert.match(node.lastError, /token/);
  });
});

/* ──────────────────────────────────────────────────────── dashboard routes ── */

describe('routes: who can do what', () => {
  test('a viewer and an editor can read but not create; an admin creates and gets the token once', async () => {
    assert.equal((await call('POST', '/', { name: 'X', lan_url: 'http://10.0.0.9:8088' }, VIEWER)).status, 403);
    assert.equal((await call('POST', '/', { name: 'X', lan_url: 'http://10.0.0.9:8088' }, EDITOR)).status, 403);
    assert.equal((await call('POST', '/', { name: 'X', lan_url: 'http://10.0.0.9/path' })).status, 400);
    const c = await call('POST', '/', { name: 'Library', lan_url: 'http://10.0.0.9:8088' });
    assert.equal(c.status, 201);
    assert.match(c.body.setup.token, /^stcn_/);
    assert.match(c.body.setup.env, /SITE_CACHE_TOKEN=stcn_/);
    const list = await call('GET', '/', undefined, VIEWER);
    assert.equal(list.status, 200);
    const text = JSON.stringify(list.body);
    assert.ok(!text.includes(c.body.setup.token) && !/token_hash|fetch_key/.test(text), 'no secret is ever listed');
    assert.ok(list.body.some((x) => x.id === c.body.id && x.online === false));
    // Assign: a group of this workspace yes, another workspace's screen no.
    assert.equal((await call('PUT', `/${c.body.id}/assignments`, { device_ids: [DB1] })).status, 400);
    const a = await call('PUT', `/${c.body.id}/assignments`, { device_ids: [DA3] });
    assert.equal(a.status, 200);
    assert.deepEqual(a.body.assignments.device_ids, [DA3]);
    assert.equal((await call('PUT', `/${c.body.id}/assignments`, { device_ids: [] }, VIEWER)).status, 403);
    // Workspace B's admin cannot see or touch it.
    assert.equal((await call('GET', `/${c.body.id}`, undefined, BADMIN, WB)).status, 404);
    assert.equal((await call('DELETE', `/${c.body.id}`, undefined, BADMIN, WB)).status, 404);
    const rot = await call('POST', `/${c.body.id}/rotate-token`);
    assert.equal(rot.status, 200);
    assert.notEqual(rot.body.setup.token, c.body.setup.token);
    assert.equal((await call('DELETE', `/${c.body.id}`)).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM site_cache_assignments WHERE device_id = ?').get(DA3).n, 0, 'assignments went with it');
    const audit = db.prepare("SELECT action FROM activity_log WHERE action LIKE 'site_cache.%'").all().map((r) => r.action);
    for (const a2 of ['site_cache.create', 'site_cache.assign', 'site_cache.rotate_token', 'site_cache.delete']) assert.ok(audit.includes(a2), a2);
  });

  test('a deleted workspace takes its caches with it; a moved screen leaves its assignment behind', () => {
    const { deleteWorkspaceCascade } = require('../lib/user-deletion');
    const tmp = 'ws-sc-tmp';
    db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(tmp, O, 'Tmp');
    const c = origin.createCache(db, { workspaceId: tmp, name: 'Tmp', lanUrl: 'http://10.0.0.7:8088', userId: ADMIN }).row;
    deleteWorkspaceCascade(db, { workspaceId: tmp, unlink: () => ({ unlinked: false }) });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM site_caches WHERE id = ?').get(c.id).n, 0);

    const fresh = origin.createCache(db, { workspaceId: WA, name: 'Move', lanUrl: 'http://10.0.0.8:8088', userId: ADMIN }).row;
    origin.setAssignments(db, fresh, { device_ids: [DA3] });
    require('../lib/device-move').moveDevices(db, [db.prepare('SELECT * FROM devices WHERE id = ?').get(DA3)], WB);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM site_cache_assignments WHERE device_id = ?').get(DA3).n, 0);
    assert.equal(origin.cacheForDevice(db, DA3), null);
  });
});
