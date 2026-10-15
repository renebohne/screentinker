'use strict';

/*
 * Campaigns (docs/layouts-and-campaigns.md, part 3): a playlist whose items can be WHOLE LAYOUTS.
 *
 *   layout A (each zone playing its own content) for 30 s -> a full-screen video -> layout B for 20 s
 *   -> loop
 *
 * ─── The data model (additive) ───────────────────────────────────────────────────────────────
 *
 *   playlist_items.layout_ref_id      a "layout item": this row shows that layout for duration_sec.
 *                                     content_id / widget_id / child_playlist_id stay NULL. It takes
 *                                     dayparts, a play window, play_when and log_play like any item.
 *   playlist_item_zone_sources        (item_id, zone_id, playlist_id): zone Z of that layout item
 *                                     plays playlist P. A zone WITHOUT a row plays the "zone-bound
 *                                     items": this playlist's own rows whose zone_id is that zone.
 *                                     Those rows belong to the layout, not to the sequence.
 *
 * Why not JSON on the item: a source playlist being published must republish every campaign that
 * shows it (as a nested child does), deleting one must be refused while a campaign uses it, and a
 * zone removed from the layout must take its source with it. All three are a query or a foreign key
 * on a table, and a scan-and-parse on JSON.
 *
 * ─── What is stored, and what is sent ─────────────────────────────────────────────────────────
 *
 * buildSnapshotItems (routes/playlists.js) turns each layout item into a MARKER in the flat list
 * (it survives nesting exactly like an ordinary item). At the top level the list then becomes:
 *
 *   published_snapshot   the FALLBACK — a plain flat list every player in the field already plays
 *                        (fallbackOf below). Everything that reads published_snapshot (old players,
 *                        triggers, offline pinning, the BrightSign/Tizen/webOS/Roku/Pi players, the
 *                        e-ink renderer) keeps working on ordinary items and never sees a marker.
 *   published_campaign   the STRUCTURE (campaignOf below), NULL for every playlist without a layout
 *                        item — so nothing changes for them.
 *
 * At payload time a player that declares `layout.campaign` also gets `campaign` (payloadCampaign):
 * the steps, each layout step carrying its layout (in the screen's orientation version) and the
 * processed item list of each zone. Every other player gets exactly the fallback in `assignments`.
 *
 * ─── THE FALLBACK, exactly ───────────────────────────────────────────────────────────────────
 *
 * In order, for each step:
 *   - a full-screen item: as is.
 *   - a layout item: the items of ITS MAIN ZONE (the zone marked main, else the largest), played
 *     full screen, each for its own duration. If that zone has nothing, the largest zone that has
 *     something. If no zone has anything, the step contributes nothing. Each copied item gets the
 *     layout item's play window intersected with its own, and the layout item's dayparts / play_when
 *     when it has none of its own. Its zone is cleared.
 *   - a layout item whose layout was deleted: nothing (it is skipped, here and in the campaign).
 */

const MARK = '__layout';
const GEOM_AREA = (z) => (Number(z.width_percent) || 0) * (Number(z.height_percent) || 0);

function isMarker(it) { return !!(it && typeof it === 'object' && it[MARK]); }
function hasMarkers(list) { return Array.isArray(list) && list.some(isMarker); }

// Stamps are local "YYYY-MM-DDTHH:MM": lexical order is time order.
const later = (a, b) => (!a ? b || null : !b ? a : (a > b ? a : b));
const earlier = (a, b) => (!a ? b || null : !b ? a : (a < b ? a : b));

/** The main zone of a zone list: marked, else largest, else the first. */
function mainZone(zones) { return require('./playlist-layout').mainZone(zones); }

function zonesOf(db, layoutId) {
  try { return db.prepare('SELECT id, x_percent, y_percent, width_percent, height_percent, sort_order, is_main FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(layoutId); }
  catch (_) { return db.prepare('SELECT id, x_percent, y_percent, width_percent, height_percent, sort_order FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(layoutId); }
}

/** The fields of a step that gate it, copied from the marker. */
function gateFields(m) {
  const out = {};
  if (m.play_from) out.play_from = m.play_from;
  if (m.play_until) out.play_until = m.play_until;
  if (Array.isArray(m.schedules) && m.schedules.length) out.schedules = m.schedules;
  if (m.play_when) out.play_when = m.play_when;
  if (m.log_play === 0) out.log_play = 0;
  return out;
}

/** The flat list old players get (see THE FALLBACK above). Unchanged when there is no marker. */
function fallbackOf(db, items) {
  if (!hasMarkers(items)) return items;
  const out = [];
  for (const it of items) {
    if (!isMarker(it)) { out.push(it); continue; }
    const m = it[MARK];
    const zones = zonesOf(db, m.layout_id);
    if (!zones.length) continue;   // layout deleted: skipped
    const has = (z) => Array.isArray(m.zones[z.id]) && m.zones[z.id].length;
    let pick = mainZone(zones);
    if (!pick || !has(pick)) pick = zones.slice().sort((a, b) => GEOM_AREA(b) - GEOM_AREA(a)).find(has) || null;
    if (!pick) continue;
    for (const z of m.zones[pick.id]) {
      const c = { ...z, zone_id: null };
      const from = later(it.play_from, z.play_from);
      const until = earlier(it.play_until, z.play_until);
      if (from) c.play_from = from; else delete c.play_from;
      if (until) c.play_until = until; else delete c.play_until;
      if ((!c.schedules || !c.schedules.length) && Array.isArray(it.schedules) && it.schedules.length) c.schedules = it.schedules;
      if (!c.play_when && it.play_when) c.play_when = it.play_when;
      out.push(c);
    }
  }
  out.forEach((x, i) => { x.sort_order = i; });
  return out;
}

/** The stored structure, or null when the list has no layout item. */
function campaignOf(items) {
  if (!hasMarkers(items)) return null;
  const steps = [];
  for (const it of items) {
    if (!it) continue;
    if (isMarker(it)) {
      const m = it[MARK];
      steps.push({ type: 'layout', layout_id: m.layout_id, duration_sec: Number(it.duration_sec) || 10, ...gateFields(it), zones: m.zones });
    } else {
      if (it.widget_type === 'transition') continue;   // a transition widget is never a step of its own
      steps.push({ type: 'item', item: it });
    }
  }
  return steps.length ? { v: 1, steps } : null;
}

/**
 * The `campaign` a capable screen receives. `processList(items)` is the payload builder's own
 * per-item pipeline (revision refresh, unsupported-media strip, weather/area filter, file URLs,
 * data-source bag), so a zone item is treated exactly as the same item in a playlist would be.
 * Layout steps whose layout no longer exists are skipped. Null when nothing playable is left.
 */
function payloadCampaign(db, campaign, device, processList) {
  if (!campaign || !Array.isArray(campaign.steps)) return null;
  const pl = require('./playlist-layout');
  const variant = require('./layout-variants').canvasVariant(device);
  const steps = [];
  for (const s of campaign.steps) {
    if (!s) continue;
    if (s.type === 'layout') {
      const layout = pl.layoutForPayload(db, s.layout_id, variant);
      if (!layout || !layout.zones.length) continue;
      const zones = {};
      let any = false;
      for (const z of layout.zones) {
        const list = processList(Array.isArray(s.zones && s.zones[z.id]) ? s.zones[z.id].map((x) => ({ ...x })) : []);
        if (list.length) { zones[z.id] = list; any = true; }
      }
      const { zones: _z, layout_id: _l, ...rest } = s;   // eslint-disable-line no-unused-vars
      steps.push({ ...rest, layout_id: layout.id, layout, zones, ...(any ? {} : { empty: true }) });
    } else if (s.type === 'item' && s.item) {
      const list = processList([{ ...s.item }]);
      if (list.length) steps.push({ type: 'item', item: list[0] });
    }
  }
  return steps.length ? { v: 1, steps } : null;
}

/** Every item a campaign can put on screen (for offline pinning and the site cache). */
function campaignItems(campaign) {
  const out = [];
  if (!campaign || !Array.isArray(campaign.steps)) return out;
  for (const s of campaign.steps) {
    if (s && s.type === 'item' && s.item) out.push(s.item);
    if (s && s.type === 'layout' && s.zones) for (const k of Object.keys(s.zones)) for (const it of s.zones[k] || []) out.push(it);
  }
  return out;
}

/**
 * Zone source checks. A source playlist must be in the same workspace, not the campaign itself,
 * not a head office playlist, and must hold neither nested playlists nor layout items: a zone plays
 * a plain list (one level, like nesting — and refused by TYPE, so no cycle can be built).
 * @returns {{status:number,error:string}|null}
 */
function zoneSourceRefusal(db, campaignPlaylistId, sourceId, workspaceId) {
  if (!sourceId || typeof sourceId !== 'string') return { status: 400, error: 'zone source must be a playlist id' };
  if (sourceId === campaignPlaylistId) return { status: 400, error: 'a playlist cannot play inside its own layout item' };
  const p = db.prepare('SELECT id, name, workspace_id, corporate FROM playlists WHERE id = ?').get(sourceId);
  if (!p) return { status: 404, error: 'Zone playlist not found' };
  if (p.workspace_id !== workspaceId) return { status: 403, error: 'Zone playlist is not in this playlist\'s workspace' };
  if (p.corporate) return { status: 400, error: 'A head office playlist cannot play inside a zone' };
  const nested = db.prepare('SELECT 1 FROM playlist_items WHERE playlist_id = ? AND (child_playlist_id IS NOT NULL OR layout_ref_id IS NOT NULL) LIMIT 1').get(sourceId);
  if (nested) return { status: 400, error: `"${p.name}" contains other playlists or layouts, so it cannot play inside a zone. A zone plays a plain list.` };
  return null;
}

/** item_id -> { zone_id: playlist_id } for these rows. */
function sourcesFor(db, itemIds) {
  const out = new Map();
  if (!itemIds.length) return out;
  try {
    for (let i = 0; i < itemIds.length; i += 500) {
      const chunk = itemIds.slice(i, i + 500);
      for (const r of db.prepare(`SELECT item_id, zone_id, playlist_id FROM playlist_item_zone_sources WHERE item_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk)) {
        if (!out.has(r.item_id)) out.set(r.item_id, {});
        out.get(r.item_id)[r.zone_id] = r.playlist_id;
      }
    }
  } catch (_) { /* pre-migration schema */ }
  return out;
}

/** Replace one layout item's zone sources ({zone_id: playlist_id|null}), validated. Throws {status,error}. */
function writeSources(db, item, sources, workspaceId) {
  if (sources === undefined) return;
  if (sources === null || typeof sources !== 'object' || Array.isArray(sources) || Object.keys(sources).length > 100) {
    throw Object.assign(new Error('zone_sources must be an object of zone id -> playlist id (or null)'), { status: 400 });
  }
  const zoneIds = new Set(db.prepare('SELECT id FROM layout_zones WHERE layout_id = ?').all(item.layout_ref_id).map((r) => r.id));
  const rows = [];
  for (const [zid, pid] of Object.entries(sources)) {
    if (!zoneIds.has(zid)) throw Object.assign(new Error('zone_sources names a zone that is not in this layout'), { status: 400 });
    if (pid === null || pid === '') continue;
    const bad = zoneSourceRefusal(db, item.playlist_id, pid, workspaceId);
    if (bad) throw Object.assign(new Error(bad.error), { status: bad.status });
    rows.push([zid, pid]);
  }
  db.prepare('DELETE FROM playlist_item_zone_sources WHERE item_id = ?').run(item.id);
  const ins = db.prepare('INSERT INTO playlist_item_zone_sources (item_id, zone_id, playlist_id) VALUES (?, ?, ?)');
  for (const [zid, pid] of rows) ins.run(item.id, zid, pid);
}

/** Campaign playlists (published) that show `playlistId` in a zone — for the republish fan-out. */
function campaignsUsing(db, playlistId) {
  try {
    return db.prepare(`SELECT DISTINCT pi.playlist_id AS id FROM playlist_item_zone_sources s
                         JOIN playlist_items pi ON pi.id = s.item_id WHERE s.playlist_id = ?`).all(playlistId).map((r) => r.id);
  } catch (_) { return []; }
}

module.exports = {
  MARK, isMarker, hasMarkers, fallbackOf, campaignOf, payloadCampaign, campaignItems,
  zoneSourceRefusal, sourcesFor, writeSources, campaignsUsing, zonesOf,
};
