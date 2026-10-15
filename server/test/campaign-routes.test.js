'use strict';

/*
 * 3.0 campaigns over HTTP (docs/layouts-and-campaigns.md): adding a layout item, its zone sources,
 * the editor's view of it, publish/discard, deleting what it uses — and the refusals: another
 * workspace's layout or playlist, a playlist that already plays in a layout, a zone playlist being
 * deleted while a campaign shows it.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { freePort } = require('./helpers/free-port');

let BASE, proc;
const DATA_DIR = path.join(os.tmpdir(), 'st-campaign-http-' + crypto.randomBytes(4).toString('hex'));
const S = {};

async function jfetch(p, opts = {}) {
  const res = await fetch(BASE + p, opts);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const H = (jwt) => ({ Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' });
const get = (p, jwt = S.jwt) => jfetch(p, { headers: H(jwt) });
const post = (p, obj, jwt = S.jwt) => jfetch(p, { method: 'POST', headers: H(jwt), body: JSON.stringify(obj) });
const put = (p, obj, jwt = S.jwt) => jfetch(p, { method: 'PUT', headers: H(jwt), body: JSON.stringify(obj) });
const del = (p, jwt = S.jwt) => jfetch(p, { method: 'DELETE', headers: H(jwt) });
const dbq = () => new Database(path.join(DATA_DIR, 'db', 'remote_display.db'), { readonly: true });

async function register(email) {
  const r = await jfetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test12345', name: email }) });
  assert.ok(r.body && r.body.token, JSON.stringify(r.body));
  return r.body.token;
}

before(async () => {
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const fd = fs.openSync(DATA_DIR + '.log', 'w');
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', fd, fd],
  });
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE + '/api/status')).ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(DATA_DIR + '.log', 'utf8').slice(-2000));
  S.jwt = await register('camp-a@test.local');
  S.jwt2 = await register('camp-b@test.local');
  S.A = (await post('/api/layouts', { name: 'A', zones: [{ name: 'Main', width_percent: 70, height_percent: 100 }, { name: 'Side', x_percent: 70, width_percent: 30, height_percent: 100 }] })).body;
  S.foreignLayout = (await post('/api/layouts', { name: 'F', zones: [{ name: 'X' }] }, S.jwt2)).body;
  S.foreignPlaylist = (await post('/api/playlists', { name: 'Theirs' }, S.jwt2)).body.id;
  S.widget = (await post('/api/widgets', { name: 'Clock', widget_type: 'clock', config: {} })).body.id;
  S.menu = (await post('/api/playlists', { name: 'Menu' })).body.id;
  await post(`/api/playlists/${S.menu}/items`, { widget_id: S.widget });
  await post(`/api/playlists/${S.menu}/publish`, {});
  S.pl = (await post('/api/playlists', { name: 'Campaign' })).body.id;
  S.main = S.A.zones.find((z) => z.name === 'Main').id;
  S.side = S.A.zones.find((z) => z.name === 'Side').id;
});
after(() => { try { proc.kill(); } catch { /* */ } });

test('refusals: another tenant\'s layout or playlist, a zone of another layout, bad durations', async () => {
  assert.equal((await post(`/api/playlists/${S.pl}/items`, { layout_ref_id: S.foreignLayout.id })).status, 403);
  assert.equal((await post(`/api/playlists/${S.pl}/items`, { layout_ref_id: 'nope' })).status, 404);
  assert.equal((await post(`/api/playlists/${S.pl}/items`, { layout_ref_id: S.A.id, zone_sources: { [S.main]: S.foreignPlaylist } })).status, 403);
  assert.equal((await post(`/api/playlists/${S.pl}/items`, { layout_ref_id: S.A.id, zone_sources: { [S.foreignLayout.zones[0].id]: S.menu } })).status, 400);
  assert.equal((await post(`/api/playlists/${S.pl}/items`, { layout_ref_id: S.A.id, duration_sec: 0 })).status, 400);
  assert.equal((await post(`/api/playlists/${S.pl}/items`, { layout_ref_id: S.A.id, content_id: 'x' })).status, 400);
  // The other tenant cannot add to this playlist at all.
  assert.equal((await post(`/api/playlists/${S.pl}/items`, { layout_ref_id: S.foreignLayout.id }, S.jwt2)).status, 403);
  const db = dbq();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(S.pl).n, 0, 'nothing was written');
  db.close();
});

test('a playlist that plays IN a layout cannot also switch layouts, and the reverse', async () => {
  const p = (await post('/api/playlists', { name: 'Zoned' })).body.id;
  assert.equal((await put(`/api/playlists/${p}`, { layout_id: S.A.id })).status, 200);
  const r = await post(`/api/playlists/${p}/items`, { layout_ref_id: S.A.id });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'CAMPAIGN_HAS_LAYOUT');
});

test('add a layout item with zone sources; the editor sees it; publish, preview and discard carry it', async () => {
  const r = await post(`/api/playlists/${S.pl}/items`, { layout_ref_id: S.A.id, duration_sec: 25, zone_sources: { [S.main]: S.menu } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  S.item = r.body.id;
  assert.equal(r.body.layout.name, 'A');
  assert.deepEqual(r.body.zone_sources, { [S.main]: S.menu });
  await post(`/api/playlists/${S.pl}/items`, { widget_id: S.widget, zone_id: S.side });
  await post(`/api/playlists/${S.pl}/items`, { widget_id: S.widget });
  // Setting a layout on it now is refused (it is a campaign).
  assert.equal((await put(`/api/playlists/${S.pl}`, { layout_id: S.A.id })).body.code, 'CAMPAIGN_HAS_LAYOUT');
  const g = await get(`/api/playlists/${S.pl}`);
  const li = g.body.items.find((x) => x.id === S.item);
  assert.equal(li.filename, 'A');
  assert.deepEqual(li.zone_source_names, { [S.main]: 'Menu' });
  assert.deepEqual(g.body.campaign_screens, [], 'no screen plays it yet');
  // The preview player gets the campaign, as a capable screen would.
  const pv = await get(`/api/playlists/${S.pl}/preview-payload`);
  assert.deepEqual(pv.body.campaign.steps.map((s) => s.type), ['layout', 'item']);
  assert.equal(pv.body.assignments.length, 2, 'the fallback: the menu (main zone) + the full-screen widget');

  assert.equal((await post(`/api/playlists/${S.pl}/publish`, {})).status, 200);
  // Edit the zones (a draft), then discard: the published zones come back.
  assert.equal((await put(`/api/playlists/${S.pl}/items/${S.item}`, { zone_sources: { [S.main]: null } })).status, 200);
  let db = dbq();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM playlist_item_zone_sources WHERE item_id = ?').get(S.item).n, 0);
  db.close();
  assert.equal((await post(`/api/playlists/${S.pl}/discard`, {})).status, 200);
  db = dbq();
  const restored = db.prepare('SELECT id, layout_ref_id FROM playlist_items WHERE playlist_id = ? AND layout_ref_id IS NOT NULL').get(S.pl);
  assert.equal(restored.layout_ref_id, S.A.id);
  assert.equal(db.prepare('SELECT playlist_id FROM playlist_item_zone_sources WHERE item_id = ?').get(restored.id).playlist_id, S.menu);
  db.close();
  S.item = restored.id;
  // Swapping content into a layout item, or zone sources on an ordinary item, is refused.
  assert.equal((await put(`/api/playlists/${S.pl}/items/${S.item}`, { content_id: 'x' })).status, 400);
  const plain = (await get(`/api/playlists/${S.pl}`)).body.items.find((x) => !x.layout_ref_id);
  assert.equal((await put(`/api/playlists/${S.pl}/items/${plain.id}`, { zone_sources: {} })).status, 400);
  // Duplicate keeps the layout and its zones.
  const dup = await post(`/api/playlists/${S.pl}/items/${S.item}/duplicate`, {});
  assert.equal(dup.status, 201);
  db = dbq();
  assert.equal(db.prepare('SELECT layout_ref_id FROM playlist_items WHERE id = ?').get(dup.body.id).layout_ref_id, S.A.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM playlist_item_zone_sources WHERE item_id = ?').get(dup.body.id).n, 1);
  db.close();
  await del(`/api/playlists/${S.pl}/items/${dup.body.id}`);
});

test('a zone playlist cannot be deleted while a campaign shows it, and cannot itself take a layout item', async () => {
  const r = await del(`/api/playlists/${S.menu}`);
  assert.equal(r.status, 409);
  assert.ok(r.body.used_by.includes('Campaign'));
  const nested = await post(`/api/playlists/${S.menu}/items`, { layout_ref_id: S.A.id });
  assert.equal(nested.status, 400);
  assert.equal(nested.body.code, 'CAMPAIGN_IN_ZONE');
});

test('deleting the layout removes its layout items and republishes the campaign', async () => {
  await post(`/api/playlists/${S.pl}/publish`, {});
  let db = dbq();
  assert.ok(db.prepare('SELECT published_campaign FROM playlists WHERE id = ?').get(S.pl).published_campaign);
  db.close();
  assert.equal((await del(`/api/layouts/${S.A.id}`)).status, 200);
  db = dbq();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE layout_ref_id = ?').get(S.A.id).n, 0);
  assert.equal(db.prepare('SELECT published_campaign FROM playlists WHERE id = ?').get(S.pl).published_campaign, null);
  db.close();
});
