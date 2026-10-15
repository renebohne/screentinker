'use strict';

/*
 * Experiments: definition, validation and the lifecycle (docs/experiments.md).
 *
 *   draft ──start──▶ running ──end date / End now──▶ ended ──Roll out──▶ rolled_out
 *                       │                              (control back on screen, results kept)
 *                       ├──Stop──▶ stopped  (same as ended, but on purpose before the end date)
 *                       └──Roll out winner──▶ rolled_out
 *
 * ⚠️ RESOLVED AT PUBLISH TIME INTO ORDINARY PLAYLIST ROWS. PLAYERS LEARN NOTHING NEW.
 *
 * Starting a test rewrites one playlist slot into N rows, one per variant, and publishes:
 *   time mode      each row gets playlist_item_schedules blocks for its turns (the existing
 *                  dayparting every player already evaluates offline)
 *   location mode  each row gets play_when { type:'screens', ids } — evaluated on the SERVER when a
 *                  screen's payload is built, and stripped before it is sent, exactly like the
 *                  weather and area conditions (lib/local-conditions.js). The control row says
 *                  'not_in' the other variants' screens, so a screen added mid-test shows the
 *                  control instead of a gap.
 * Ending rewrites it back from `original` — the slot row and its schedule blocks as they were — and
 * publishes again. Rolling out writes the winner's content into that same row.
 *
 * ⚠️ NEVER PUBLISHES SOMEBODY ELSE'S DRAFT. Publishing is all-or-nothing per playlist, so starting
 * a test on a playlist with unpublished edits would push those edits to screens as a side effect.
 * Start and roll-out refuse until the playlist is published; an automatic end that finds a draft
 * restores the rows and leaves the publish to the person editing (status notice says so).
 *
 * ⚠️ APPROVALS. In a workspace that reviews changes before they reach screens, starting a test is
 * a change nobody reviewed, so it is refused with an explanation. Restoring the original slot (stop,
 * end) is not a new change and is allowed through.
 */

const crypto = require('crypto');
const { db } = require('../../db/database');
const assign = require('./assign');

const MAX_VARIANTS = 4;
const MIN_VARIANTS = 2;
const NAME_MAX = 120;
const LABELS = ['A', 'B', 'C', 'D'];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OUTCOMES = {
  sales: ['units', 'revenue', 'orders'],
  qr: ['scans'],
  audience: ['impressions', 'dwell'],
  csv: ['value'],
};

class ExperimentError extends Error {
  constructor(message, status = 400, code = 'EXPERIMENT_INVALID') {
    super(message);
    this.name = 'ExperimentError';
    this.status = status;
    this.code = code;
  }
}
const fail = (msg, status, code) => { throw new ExperimentError(msg, status, code); };

const parse = (text, fallback) => { try { const v = JSON.parse(text); return v == null ? fallback : v; } catch { return fallback; } };
const nowSec = () => Math.floor(Date.now() / 1000);

function load(id, workspaceId) {
  if (!ID_RE.test(String(id || '')) || !workspaceId) return null;
  const row = db.prepare('SELECT * FROM experiments WHERE id = ? AND workspace_id = ?').get(String(id), workspaceId);
  return row ? hydrate(row) : null;
}

function hydrate(row) {
  return { ...row, variants: parse(row.variants, []), config: parse(row.config, {}), original: parse(row.original, null) };
}

function unitsOf(expId) {
  return db.prepare('SELECT * FROM experiment_units WHERE experiment_id = ? ORDER BY label').all(expId)
    .map((u) => ({ ...u, device_ids: parse(u.device_ids, []) }));
}

/* ─── validation ────────────────────────────────────────────────────────────────────────────── */

/** The slot: a content or widget row of an ordinary playlist in this workspace. */
function checkSlot(workspaceId, playlistId, itemId) {
  if (!ID_RE.test(String(playlistId || ''))) fail('Choose the playlist the test runs in.');
  const pl = db.prepare('SELECT id, name, workspace_id, smart_rules, status FROM playlists WHERE id = ? AND workspace_id = ?').get(String(playlistId), workspaceId);
  if (!pl) fail('Playlist not found', 404, 'EXPERIMENT_NOT_FOUND');
  if (pl.smart_rules) fail('A smart playlist chooses its own items, so one of them cannot be tested. Use an ordinary playlist.');
  const g = require('../corporate/guard').governanceOf(db, pl.id);
  if (g.kind) fail('This playlist is governed by head office. Experiments run on a store\'s own playlists only.', 409, 'EXPERIMENT_CORPORATE');
  const id = Number(itemId);
  if (!Number.isInteger(id) || id <= 0) fail('Choose the item in the playlist the variants replace.');
  const item = db.prepare('SELECT * FROM playlist_items WHERE id = ? AND playlist_id = ?').get(id, pl.id);
  if (!item) fail('That item is not in this playlist any more.', 404, 'EXPERIMENT_NOT_FOUND');
  if (item.slot_id) fail('A head office slot cannot be tested.');
  if (item.child_playlist_id) fail('Choose a single item, not a nested playlist.');
  // 3.0 campaigns: a layout item is a whole screen of zones; test an item inside one of its zones.
  if (item.layout_ref_id) fail('Choose a single item, not a layout. To test something inside a layout, test the item in its zone.');
  if (item.experiment_id) {
    const other = db.prepare("SELECT 1 FROM experiments WHERE id = ? AND status = 'running'").get(item.experiment_id);
    if (other) fail('Another experiment is already running on this item.', 409, 'EXPERIMENT_BUSY');
  }
  return { playlist: pl, item };
}

/**
 * A variant: { kind: 'content'|'widget'|'deck', id, label?, qr_link_id? } → the resolved form
 * { label, kind, id, name, ref: { content_id | widget_id | child_playlist_id }, refs: [ids played],
 *   duration, qr_link_id }.
 */
function checkVariant(workspaceId, v, i) {
  if (!v || typeof v !== 'object') fail(`Variant ${LABELS[i]} is missing.`);
  const id = String(v.id || '');
  if (!ID_RE.test(id)) fail(`Choose what variant ${LABELS[i]} shows.`);
  const label = String(v.label || '').trim().slice(0, 40) || LABELS[i];
  const out = { label, kind: v.kind, id, name: '', ref: {}, refs: [], duration: null, qr_link_id: null };
  if (v.kind === 'content') {
    const c = db.prepare('SELECT id, filename, mime_type, duration_sec FROM content WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
    if (!c) fail(`Variant ${label}: that content is not in this workspace.`, 404, 'EXPERIMENT_NOT_FOUND');
    out.name = c.filename; out.ref = { content_id: c.id }; out.refs = [c.id];
    if (/^video\//.test(c.mime_type || '') && c.duration_sec > 0) out.duration = Math.ceil(c.duration_sec);
  } else if (v.kind === 'widget') {
    const w = db.prepare('SELECT id, name FROM widgets WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
    if (!w) fail(`Variant ${label}: that widget is not in this workspace.`, 404, 'EXPERIMENT_NOT_FOUND');
    out.name = w.name; out.ref = { widget_id: w.id }; out.refs = [w.id];
  } else if (v.kind === 'deck') {
    // A sign is a one-slide deck: it plays as that slide's widget. A longer deck plays as its
    // published playlist, nested in the slot.
    const d = db.prepare('SELECT id, name, playlist_id FROM slide_decks WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
    if (!d) fail(`Variant ${label}: that sign or slide deck is not in this workspace.`, 404, 'EXPERIMENT_NOT_FOUND');
    const pl = d.playlist_id && db.prepare('SELECT id FROM playlists WHERE id = ? AND workspace_id = ?').get(d.playlist_id, workspaceId);
    const widgets = pl ? db.prepare('SELECT widget_id FROM playlist_items WHERE playlist_id = ? AND widget_id IS NOT NULL ORDER BY sort_order').all(pl.id).map((r) => r.widget_id) : [];
    if (!widgets.length) fail(`Variant ${label}: publish "${d.name}" once before testing it.`);
    out.name = d.name;
    if (widgets.length === 1) out.ref = { widget_id: widgets[0] };
    else out.ref = { child_playlist_id: pl.id };
    out.refs = widgets;
  } else {
    fail(`Variant ${LABELS[i]}: choose content, a widget, or a sign.`);
  }
  if (v.qr_link_id) {
    const q = db.prepare('SELECT id FROM qr_links WHERE id = ? AND workspace_id = ?').get(String(v.qr_link_id), workspaceId);
    if (!q) fail(`Variant ${label}: that QR link is not in this workspace.`, 404, 'EXPERIMENT_NOT_FOUND');
    out.qr_link_id = q.id;
  }
  return out;
}

const clampNum = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

function checkOutcome(o, workspaceId) {
  if (!o || typeof o !== 'object' || !OUTCOMES[o.source]) fail('Choose what the test is judged on.');
  const metric = OUTCOMES[o.source].includes(o.metric) ? o.metric : OUTCOMES[o.source][0];
  return { source: o.source, metric };
}

function checkConfig(workspaceId, body, variants, mode) {
  const c = body.config && typeof body.config === 'object' ? body.config : {};
  const out = {
    block_hours: assign.BLOCK_HOURS.includes(Number(c.block_hours)) ? Number(c.block_hours) : 1,
    attribution_hours: Math.round(clampNum(c.attribution_hours, 0, 3, 0)),
    min_lift: clampNum(c.min_lift, 0.02, 0.5, 0.1),
    baseline_days: Math.round(clampNum(c.baseline_days, 0, 56, mode === 'location' ? 28 : 0)),
    outcome: checkOutcome(c.outcome, workspaceId),
    secondary: [],
    sales: { data_source_ids: [], items: [] },
    csv_label: String(c.csv_label || '').trim().slice(0, 60),
  };
  const seen = new Set([`${out.outcome.source}:${out.outcome.metric}`]);
  for (const s of Array.isArray(c.secondary) ? c.secondary.slice(0, 3) : []) {
    const o = checkOutcome(s, workspaceId);
    const k = `${o.source}:${o.metric}`;
    if (!seen.has(k)) { seen.add(k); out.secondary.push(o); }
  }
  const all = [out.outcome, ...out.secondary];
  if (all.some((o) => o.source === 'sales')) {
    const ids = Array.isArray(c.sales && c.sales.data_source_ids) ? c.sales.data_source_ids.map(String).slice(0, 2) : [];
    for (const id of ids) {
      const ds = db.prepare("SELECT id, type FROM data_sources WHERE id = ? AND workspace_id = ? AND type IN ('square','shopify')").get(id, workspaceId);
      if (!ds) fail('Choose a Square or Shopify data source from this workspace.', 404, 'EXPERIMENT_NOT_FOUND');
      if (!out.sales.data_source_ids.includes(ds.id)) out.sales.data_source_ids.push(ds.id);
    }
    if (!out.sales.data_source_ids.length) fail('Sales come from a Square or Shopify data source. Add one under Data sources first.');
    out.sales.items = require('./sales').normaliseItemFilter(c.sales && c.sales.items);
  }
  if (all.some((o) => o.source === 'qr') && !variants.some((v) => v.qr_link_id)) {
    fail('To compare QR scans, give each variant its own tracked QR link.');
  }
  if (mode === 'time' && out.attribution_hours >= out.block_hours) {
    fail('The sales window must be shorter than each turn, or every hour would mix two variants. Use longer turns or a shorter window.');
  }
  return out;
}

/** Create or (while a draft) replace the definition. */
function define(workspaceId, body, existing = null) {
  const name = String(body.name || '').trim().slice(0, NAME_MAX);
  if (!name) fail('Give the test a name.');
  const mode = body.mode === 'time' ? 'time' : 'location';
  const { playlist, item } = checkSlot(workspaceId, body.playlist_id, body.slot_item_id);
  const raw = Array.isArray(body.variants) ? body.variants : [];
  if (raw.length < MIN_VARIANTS || raw.length > MAX_VARIANTS) fail('A test compares 2 to 4 versions.');
  const variants = raw.map((v, i) => checkVariant(workspaceId, v, i));
  const refSig = variants.map((v) => JSON.stringify(v.ref));
  if (new Set(refSig).size !== refSig.length) fail('Each variant must show something different.');
  if (new Set(variants.map((v) => v.label.toLowerCase())).size !== variants.length) fail('Give each variant its own name.');
  // A nested deck in a playlist that is itself nested would be two levels deep (players support one).
  if (variants.some((v) => v.ref.child_playlist_id)
      && db.prepare('SELECT 1 FROM playlist_items WHERE child_playlist_id = ? LIMIT 1').get(playlist.id)) {
    fail('This playlist is inside another playlist, so a multi-slide deck cannot be added to it. Use a one-slide sign or a single item.');
  }
  if (mode === 'location' && item.play_when) {
    fail('This item already has a play condition. Remove it, or test by time of day instead.');
  }
  const config = checkConfig(workspaceId, body, variants, mode);
  let planned = null;
  if (body.planned_end_at != null && body.planned_end_at !== '') {
    planned = Math.floor(Number(body.planned_end_at));
    if (!Number.isFinite(planned) || planned <= nowSec()) fail('The end date must be in the future.');
  }
  return { name, mode, playlist, item, variants, config, planned_end_at: planned };
}

/* ─── screens and locations ─────────────────────────────────────────────────────────────────── */

/** The screens currently playing this playlist (directly, or with it nested), in this workspace. */
function screensFor(workspaceId, playlistId) {
  return db.prepare(`
    SELECT d.id, d.name, d.location_label, d.timezone, d.reported_timezone
      FROM devices d JOIN device_resolved_playlist r ON r.device_id = d.id
     WHERE d.workspace_id = ?
       AND (r.playlist_id = ? OR r.playlist_id IN (SELECT playlist_id FROM playlist_items WHERE child_playlist_id = ?))
     ORDER BY d.name`).all(workspaceId, playlistId, playlistId);
}

/** Refresh a draft's locations from its screens, keeping any POS mapping already chosen. */
function syncUnits(exp) {
  const prev = new Map(unitsOf(exp.id).map((u) => [u.unit_key, u]));
  const units = assign.unitsFromDevices(screensFor(exp.workspace_id, exp.playlist_id));
  db.transaction(() => {
    db.prepare('DELETE FROM experiment_units WHERE experiment_id = ?').run(exp.id);
    const ins = db.prepare('INSERT INTO experiment_units (experiment_id, unit_key, label, device_ids, square_location_id, shopify_location_id) VALUES (?, ?, ?, ?, ?, ?)');
    for (const u of units) {
      const p = prev.get(u.key);
      ins.run(exp.id, u.key, u.label, JSON.stringify(u.device_ids), p ? p.square_location_id : null, p ? p.shopify_location_id : null);
    }
  })();
  return unitsOf(exp.id);
}

const POS_ID_RE = /^(\*|online|[A-Za-z0-9_-]{1,64})$/;

/** Map locations to POS locations: [{ unit_key, square_location_id, shopify_location_id }]. */
function setUnitMapping(exp, list) {
  if (!Array.isArray(list)) fail('Send a list of locations.');
  const upd = db.prepare('UPDATE experiment_units SET square_location_id = ?, shopify_location_id = ? WHERE experiment_id = ? AND unit_key = ?');
  const norm = (v) => {
    const s = String(v == null ? '' : v).trim();
    if (!s) return null;
    const m = /(\d+)$/.exec(s);   // a pasted gid://shopify/Location/123 is the number at its end
    const x = /^gid:\/\//.test(s) && m ? m[1] : s;
    if (!POS_ID_RE.test(x)) fail('That does not look like a POS location id.');
    return x;
  };
  db.transaction(() => {
    for (const m of list.slice(0, 500)) {
      if (!m || typeof m.unit_key !== 'string') continue;
      upd.run(norm(m.square_location_id), norm(m.shopify_location_id), exp.id, m.unit_key);
    }
  })();
  return unitsOf(exp.id);
}

/* ─── persistence ───────────────────────────────────────────────────────────────────────────── */

function create(workspaceId, userId, body) {
  const d = define(workspaceId, body);
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO experiments (id, workspace_id, name, status, mode, playlist_id, slot_item_id, variants, config, planned_end_at, created_by)
    VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, workspaceId, d.name, d.mode, d.playlist.id, d.item.id, JSON.stringify(d.variants), JSON.stringify(d.config), d.planned_end_at, userId || null);
  const exp = load(id, workspaceId);
  syncUnits(exp);
  return load(id, workspaceId);
}

/** A draft can change anything; a started test only its name and end date. */
function update(exp, body) {
  if (exp.status === 'draft') {
    const d = define(exp.workspace_id, { ...body, name: body.name ?? exp.name });
    db.prepare(`UPDATE experiments SET name = ?, mode = ?, playlist_id = ?, slot_item_id = ?, variants = ?, config = ?, planned_end_at = ?, updated_at = strftime('%s','now') WHERE id = ?`)
      .run(d.name, d.mode, d.playlist.id, d.item.id, JSON.stringify(d.variants), JSON.stringify(d.config), d.planned_end_at, exp.id);
    const next = load(exp.id, exp.workspace_id);
    syncUnits(next);
    return next;
  }
  const name = body.name !== undefined ? String(body.name || '').trim().slice(0, NAME_MAX) : exp.name;
  if (!name) fail('Give the test a name.');
  let planned = exp.planned_end_at;
  if (body.planned_end_at !== undefined && exp.status === 'running') {
    planned = body.planned_end_at == null || body.planned_end_at === '' ? null : Math.floor(Number(body.planned_end_at));
    if (planned != null && (!Number.isFinite(planned) || planned <= nowSec())) fail('The end date must be in the future.');
  }
  const cfg = { ...exp.config };
  if (body.config && body.config.min_lift !== undefined) cfg.min_lift = clampNum(body.config.min_lift, 0.02, 0.5, cfg.min_lift);
  db.prepare("UPDATE experiments SET name = ?, planned_end_at = ?, config = ?, updated_at = strftime('%s','now') WHERE id = ?").run(name, planned, JSON.stringify(cfg), exp.id);
  return load(exp.id, exp.workspace_id);
}

function remove(exp) {
  if (exp.status === 'running') fail('Stop the test before deleting it.', 409, 'EXPERIMENT_RUNNING');
  // Children explicitly too: the FK cascade is declared, but a deleted test must not leave its
  // outcomes behind on any database that was opened without foreign_keys.
  db.transaction(() => {
    for (const tbl of ['experiment_outcomes', 'experiment_exposure', 'experiment_units']) db.prepare(`DELETE FROM ${tbl} WHERE experiment_id = ?`).run(exp.id);
    db.prepare('DELETE FROM experiments WHERE id = ?').run(exp.id);
  })();
  // Rows of a test that ended have already been restored; this only clears a stale marker.
  db.prepare('UPDATE playlist_items SET experiment_id = NULL WHERE experiment_id = ?').run(exp.id);
}

module.exports = {
  ExperimentError, fail, MAX_VARIANTS, LABELS, OUTCOMES,
  load, hydrate, unitsOf, define, checkVariant, create, update, remove, screensFor, syncUnits, setUnitMapping, parse, nowSec,
};
