'use strict';

/*
 * 3.0 campaigns (lib/campaign.js, docs/layouts-and-campaigns.md): a playlist whose items can be
 * whole layouts.
 *
 *   - the stored structure and the FALLBACK, exactly as documented;
 *   - payload shape: a player that declares layout.campaign gets `campaign`; one that does not gets
 *     exactly the fallback and no new field at all;
 *   - zone sources (a playlist per zone, or the zone-bound items), their checks, and the republish
 *     when a source playlist is published;
 *   - edges: a layout item inside a nested playlist, a deleted layout, a wall, a portrait screen;
 *   - "What will this screen show?" and its timeline understand campaign steps.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-campaign-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const setupDeviceSocket = require('../ws/deviceSocket');
const playlists = require('../routes/playlists');
const camp = require('../lib/campaign');
const sim = require('../lib/device-simulate');

let io, srv;
const W = {};
const uid = (p) => `${p}-${crypto.randomUUID()}`;
const CAPS = JSON.stringify(['playback.video', 'playback.image', 'playback.widget', 'playback.zones', 'layout.campaign']);

function content(name, mime) {
  const id = uid('c');
  db.prepare('INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, duration_sec) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, W.user, W.ws, name, `/uploads/${id}.bin`, mime, mime.startsWith('video/') ? 15 : null);
  return id;
}
function layout(name, zones, ws = W.ws) {
  const id = uid('L');
  db.prepare('INSERT INTO layouts (id, user_id, workspace_id, name, width, height) VALUES (?, ?, ?, ?, 1920, 1080)').run(id, W.user, ws, name);
  const z = {};
  zones.forEach(([n, x, y, w, h], i) => {
    const zid = uid('z');
    db.prepare('INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(zid, id, n, x, y, w, h, i);
    z[n] = zid;
  });
  return { id, zones: z };
}
function playlist(name, ws = W.ws) {
  const id = uid('pl');
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, status) VALUES (?, ?, ?, ?, 'draft')").run(id, W.user, ws, name);
  return id;
}
let order = 0;
function item(pl, cols) {
  const r = db.prepare(`INSERT INTO playlist_items (playlist_id, content_id, widget_id, child_playlist_id, zone_id, sort_order, duration_sec, layout_ref_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(pl, cols.content || null, null, cols.child || null, cols.zone || null, ++order, cols.dur || 10, cols.layout || null);
  for (const [zid, pid] of Object.entries(cols.sources || {})) db.prepare('INSERT INTO playlist_item_zone_sources (item_id, zone_id, playlist_id) VALUES (?, ?, ?)').run(r.lastInsertRowid, zid, pid);
  if (cols.days) db.prepare("INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time) VALUES (?, ?, ?, '09:00', '17:00')").run(uid('s'), r.lastInsertRowid, cols.days);
  return r.lastInsertRowid;
}
function device(name, cols = {}) {
  const id = uid('d');
  db.prepare(`INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, playlist_id, playlist_source, capabilities, orientation, wall_id, reported_timezone)
              VALUES (?, ?, ?, ?, ?, 'online', ?, 'device', ?, ?, ?, 'UTC')`)
    .run(id, W.user, W.ws, name, crypto.randomBytes(3).toString('hex'), cols.playlist, cols.caps === undefined ? CAPS : cols.caps, cols.orientation || 'landscape', cols.wall || null);
  return id;
}
const payload = (id) => setupDeviceSocket.buildPlaylistPayloadUnchecked(id);
const snap = (pl) => JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(pl).published_snapshot);
const stored = (pl) => JSON.parse(db.prepare('SELECT published_campaign FROM playlists WHERE id = ?').get(pl).published_campaign || 'null');

before(() => {
  W.user = uid('u');
  db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run(W.user, `${W.user}@x.test`, 'C', 'x');
  W.org = uid('o');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(W.org, 'Org', W.user);
  W.ws = uid('ws'); W.ws2 = uid('ws');
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?), (?, ?, ?)').run(W.ws, W.org, 'A', W.ws2, W.org, 'B');
  srv = http.createServer(); io = new Server(srv); setupDeviceSocket(io);

  W.img1 = content('menu1.jpg', 'image/jpeg');
  W.img2 = content('menu2.jpg', 'image/jpeg');
  W.side = content('side.jpg', 'image/jpeg');
  W.video = content('promo.mp4', 'video/mp4');
  W.top = content('top.jpg', 'image/jpeg');
  W.A = layout('Layout A', [['Main', 0, 0, 70, 100], ['Side', 70, 0, 30, 100]]);
  W.B = layout('Layout B', [['Top', 0, 0, 100, 50], ['Bottom', 0, 50, 100, 50]]);
  // The menu playlist plays in A's main zone.
  W.M = playlist('Menu');
  item(W.M, { content: W.img1, dur: 8 });
  item(W.M, { content: W.img2, dur: 8 });
  playlists.publishPlaylist(W.M, null);
  // The campaign: A for 30 s (Main = Menu, Side = its bound item) -> full-screen video -> B for 20 s.
  W.P = playlist('Campaign');
  W.stepA = item(W.P, { layout: W.A.id, dur: 30, sources: { [W.A.zones.Main]: W.M } });
  item(W.P, { content: W.side, zone: W.A.zones.Side, dur: 12 });
  item(W.P, { content: W.video, dur: 15 });
  item(W.P, { layout: W.B.id, dur: 20, days: '1,2,3,4,5' });
  item(W.P, { content: W.top, zone: W.B.zones.Top, dur: 6 });
  playlists.publishPlaylist(W.P, null);
});
after(() => { try { io.close(); } catch { /* */ } });

test('the stored structure: three steps, each zone with its own items', () => {
  const c = stored(W.P);
  assert.equal(c.v, 1);
  assert.deepEqual(c.steps.map((s) => s.type), ['layout', 'item', 'layout']);
  assert.equal(c.steps[0].layout_id, W.A.id);
  assert.equal(c.steps[0].duration_sec, 30);
  assert.deepEqual(c.steps[0].zones[W.A.zones.Main].map((x) => x.content_id), [W.img1, W.img2], 'the zone plays the chosen playlist');
  assert.deepEqual(c.steps[0].zones[W.A.zones.Side].map((x) => x.content_id), [W.side], 'a zone without a source plays its bound items');
  for (const x of c.steps[0].zones[W.A.zones.Main]) assert.equal(x.zone_id, W.A.zones.Main);
  assert.equal(c.steps[1].item.content_id, W.video);
  assert.equal(c.steps[2].duration_sec, 20);
  assert.ok(Array.isArray(c.steps[2].schedules) && c.steps[2].schedules.length, 'a layout item keeps its dayparts');
  assert.deepEqual(c.steps[2].zones[W.B.zones.Bottom], [], 'an empty zone is empty, not missing');
});

test('THE FALLBACK, exactly: full-screen items as they are, each layout as its main zone full screen', () => {
  const s = snap(W.P);
  assert.deepEqual(s.map((x) => x.content_id), [W.img1, W.img2, W.video, W.top]);
  for (const x of s) assert.equal(x.zone_id, null, 'full screen');
  assert.deepEqual(s.map((x) => x.sort_order), [0, 1, 2, 3], 'renumbered');
  assert.deepEqual(s.map((x) => x.duration_sec), [8, 8, 15, 6], 'each item keeps its own duration');
  assert.ok(s[3].schedules && s[3].schedules.length, "a copied item takes the layout item's dayparts when it has none");
  assert.equal(s.some((x) => camp.isMarker(x) || x.layout_ref_id !== undefined), false, 'nothing an old player cannot parse');
});

test('an OLD player gets exactly the fallback and no new field; a capable one also gets the campaign', () => {
  const plain = playlist('Plain');
  item(plain, { content: W.img1 });
  playlists.publishPlaylist(plain, null);
  const oldOnPlain = device('old-plain', { playlist: plain, caps: null });
  const old = device('old', { playlist: W.P, caps: null });
  const capable = device('new', { playlist: W.P });
  const po = payload(old);
  assert.equal('campaign' in po, false);
  assert.deepEqual(Object.keys(po).sort(), Object.keys(payload(oldOnPlain)).sort(), 'the same fields as any playlist');
  assert.deepEqual(po.assignments.map((x) => x.content_id), [W.img1, W.img2, W.video, W.top]);
  const pc = payload(capable);
  assert.deepEqual(pc.assignments.map((x) => x.content_id), po.assignments.map((x) => x.content_id), 'assignments stay the fallback');
  assert.deepEqual(pc.campaign.steps.map((s) => s.type), ['layout', 'item', 'layout']);
  const a = pc.campaign.steps[0];
  assert.equal(a.layout.id, W.A.id);
  assert.deepEqual(a.layout.zones.map((z) => z.name), ['Main', 'Side']);
  assert.equal(a.layout.zones.some((z) => 'is_main' in z), false);
  assert.deepEqual(a.zones[W.A.zones.Main].map((x) => x.content_id), [W.img1, W.img2]);
  assert.ok(a.zones[W.A.zones.Main][0].content_rev !== undefined, 'zone items went through the payload pipeline');
  assert.equal(pc.campaign.steps[2].zones[W.B.zones.Bottom], undefined, 'empty zones are left out');
  // A playlist without layout items: a capable player gets nothing new either.
  const newOnPlain = device('new-plain', { playlist: plain });
  assert.equal('campaign' in payload(newOnPlain), false);
});

test('a portrait capable screen gets the portrait version of a layout step', () => {
  require('../lib/layout-variants').writeZoneVariants(db, W.A.id, [
    { id: W.A.zones.Main, variants: { portrait: { x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 70 } } },
    { id: W.A.zones.Side, variants: { portrait: { x_percent: 0, y_percent: 70, width_percent: 100, height_percent: 30 } } },
  ]);
  try {
    const d = device('portrait', { playlist: W.P, orientation: 'portrait' });
    const step = payload(d).campaign.steps[0];
    assert.equal(step.layout.variant, 'portrait');
    assert.equal(step.layout.zones.find((z) => z.id === W.A.zones.Side).y_percent, 70);
    assert.equal(payload(device('land', { playlist: W.P })).campaign.steps[0].layout.variant, undefined);
  } finally {
    db.prepare('DELETE FROM layout_zone_variants WHERE layout_id = ?').run(W.A.id);
  }
});

test('a wall member plays the fallback even when it declares the capability', () => {
  const wall = uid('w');
  db.prepare('INSERT INTO video_walls (id, user_id, workspace_id, name, playlist_id) VALUES (?, ?, ?, ?, ?)').run(wall, W.user, W.ws, 'Wall', W.P);
  const d = device('wall-member', { playlist: W.P, wall });
  db.prepare('INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row) VALUES (?, ?, 0, 0)').run(wall, d);
  assert.equal('campaign' in payload(d), false);
});

test('publishing a zone\'s playlist republishes the campaign that shows it', () => {
  const before = stored(W.P).steps[0].zones[W.A.zones.Main].length;
  const extra = content('menu3.jpg', 'image/jpeg');
  item(W.M, { content: extra });
  playlists.publishPlaylist(W.M, null);
  const after = stored(W.P).steps[0].zones[W.A.zones.Main];
  assert.equal(after.length, before + 1);
  assert.equal(after[after.length - 1].content_id, extra);
});

test('zone sources are checked: not itself, not another workspace, not a playlist holding playlists or layouts', () => {
  const it = { id: W.stepA, playlist_id: W.P, layout_ref_id: W.A.id };
  const err = (src) => { try { camp.writeSources(db, it, src, W.ws); return null; } catch (e) { return e.status; } };
  assert.equal(err({ [W.A.zones.Main]: W.P }), 400, 'itself');
  const foreign = playlist('Foreign', W.ws2);
  assert.equal(err({ [W.A.zones.Main]: foreign }), 403);
  const nesting = playlist('Nests');
  item(nesting, { child: W.M });
  assert.equal(err({ [W.A.zones.Main]: nesting }), 400);
  assert.equal(err({ [W.B.zones.Top]: W.M }), 400, 'a zone of another layout');
  assert.equal(err({ [W.A.zones.Main]: 'nope' }), 404);
  // Unchanged after every refusal.
  assert.deepEqual(camp.sourcesFor(db, [W.stepA]).get(W.stepA), { [W.A.zones.Main]: W.M });
});

test('a layout item inside a nested playlist makes its parent a campaign', () => {
  const child = playlist('Child with layout');
  item(child, { layout: W.B.id, dur: 25 });
  item(child, { content: W.top, zone: W.B.zones.Top });
  playlists.publishPlaylist(child, null);
  const parent = playlist('Parent');
  item(parent, { content: W.img1 });
  item(parent, { child });
  playlists.publishPlaylist(parent, null);
  const c = stored(parent);
  assert.deepEqual(c.steps.map((s) => s.type), ['item', 'layout']);
  assert.equal(c.steps[1].layout_id, W.B.id);
  assert.deepEqual(snap(parent).map((x) => x.content_id), [W.img1, W.top]);
});

test('a layout item whose layout was deleted is skipped — in the structure, the fallback, and an already stored campaign', () => {
  const L = layout('Doomed', [['X', 0, 0, 50, 100], ['Y', 50, 0, 50, 100]]);
  const P = playlist('Has doomed');
  item(P, { content: W.img1 });
  item(P, { layout: L.id, dur: 10 });
  item(P, { content: W.img2, zone: L.zones.X });
  playlists.publishPlaylist(P, null);
  const d = device('doomed', { playlist: P });
  assert.equal(payload(d).campaign.steps.length, 2);
  // The layout goes; the stored campaign still names it until a republish — the payload skips it.
  db.pragma('foreign_keys = OFF');
  try { db.prepare('DELETE FROM layout_zones WHERE layout_id = ?').run(L.id); db.prepare('DELETE FROM layouts WHERE id = ?').run(L.id); }
  finally { db.pragma('foreign_keys = ON'); }
  assert.deepEqual(payload(d).campaign.steps.map((s) => s.type), ['item']);
  playlists.publishPlaylist(P, null);
  assert.equal(stored(P), null, 'no layout item left: not a campaign any more');
  // The dangling layout row is skipped; the item that was bound to the deleted layout's zone is now
  // an ordinary item again (its zone no longer exists, so it plays full screen, like any orphan).
  assert.deepEqual(snap(P).map((x) => x.content_id), [W.img1, W.img2], 'the dangling row is skipped');
});

test('"What will this screen show?" lists the steps for a campaign screen, and says "fallback" for an old one', () => {
  const capable = device('sim-new', { playlist: W.P });
  const old = device('sim-old', { playlist: W.P, caps: null });
  // A Monday at noon (UTC; these screens report no zone): every step plays.
  const at = Date.parse('2026-03-09T12:00:00Z');
  const s = sim.simulate(capable, at);
  assert.equal(s.campaign.fallback, false);
  assert.deepEqual(s.campaign.steps.map((x) => [x.type, x.label]), [['layout', 'Layout A'], ['item', 'promo.mp4'], ['layout', 'Layout B']]);
  assert.equal(s.campaign.steps[2].plays, true);
  // Sunday: layout B's weekday daypart closes it.
  const sun = sim.simulate(capable, Date.parse('2026-03-08T12:00:00Z'));
  assert.equal(sun.campaign.steps[2].plays, false);
  assert.equal(sun.campaign.steps[2].reason, 'daypart');
  assert.deepEqual(sim.simulate(old, at).campaign, { fallback: true, steps: [] });
  // The timeline splits on the step's daypart, and names the steps that play.
  const tl = sim.timeline(capable, Date.parse('2026-03-09T00:00:00Z'), Date.parse('2026-03-10T00:00:00Z'));
  assert.ok(tl.segments.length >= 3, `segments: ${tl.segments.length}`);
  const noon = tl.segments.find((g) => Date.parse(g.from) <= at && (!g.to || Date.parse(g.to) > at));
  assert.deepEqual(noon.campaign, ['Layout A', 'promo.mp4', 'Layout B']);
  const night = tl.segments.find((g) => Date.parse(g.from) <= Date.parse('2026-03-09T20:00:00Z') && Date.parse(g.to) > Date.parse('2026-03-09T20:00:00Z'));
  assert.deepEqual(night.campaign, ['Layout A', 'promo.mp4']);
});

test('the site cache and offline pinning see every campaign item', () => {
  const items = camp.campaignItems(payload(device('cache', { playlist: W.P })).campaign);
  const ids = new Set(items.map((x) => x.content_id));
  for (const c of [W.img1, W.img2, W.side, W.video, W.top]) assert.ok(ids.has(c), c);
});
