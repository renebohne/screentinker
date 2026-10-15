'use strict';

/*
 * Experiments (lib/experiments, docs/experiments.md): /api/experiments.
 *
 * JWT only (config/api-surface.js): a test switches what screens show and reads a store's sales
 * through a saved POS credential, which is a person's decision from the dashboard. Everything is
 * scoped to the caller's current workspace; reading needs membership, changing needs an editor —
 * a workspace_viewer can look at results and nothing else.
 */

const express = require('express');
const router = express.Router();
// Abuse backstop (lib/backstop-limiter.js): already counted app-wide; here so this router is never unguarded.
router.use(require('../lib/backstop-limiter'));
const { db } = require('../db/database');
const { resourceAccess, denyReadOnly } = require('../lib/tenancy');
const { auditFromReq } = require('../lib/audit');
const core = require('../lib/experiments/core');
const resolve = require('../lib/experiments/resolve');
const data = require('../lib/experiments/data');
const analyze = require('../lib/experiments/analyze');

function access(req, res, { write = false } = {}) {
  if (!req.workspaceId) { res.status(403).json({ error: 'No workspace context' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (write && denyReadOnly(req, res)) return null;
  if (write && !ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') { res.status(403).json({ error: 'Read-only access' }); return null; }
  return ctx;
}

function loadOr404(req, res) {
  const exp = core.load(req.params.id, req.workspaceId);
  if (!exp) { res.status(404).json({ error: 'Experiment not found' }); return null; }
  return exp;
}

/** Map a thrown error to a response. ExperimentError carries its own status and code. */
function sendError(res, e) {
  if (e && e.name === 'ExperimentError') return res.status(e.status).json({ error: e.message, code: e.code });
  if (e && e.name === 'ReleaseError') return res.status(e.status || 409).json({ error: e.message, code: e.code });
  console.error('[experiments]', e && e.stack ? e.stack : e);
  return res.status(500).json({ error: 'Something went wrong with this experiment.' });
}

/** What the dashboard shows. `original` (raw playlist rows) and internal refs stay on the server. */
function present(exp) {
  const pl = exp.playlist_id ? db.prepare('SELECT name FROM playlists WHERE id = ?').get(exp.playlist_id) : null;
  return {
    id: exp.id, name: exp.name, status: exp.status, mode: exp.mode,
    playlist_id: exp.playlist_id, playlist_name: pl ? pl.name : null, slot_item_id: exp.slot_item_id,
    variants: exp.variants.map((v) => ({ label: v.label, kind: v.kind, id: v.id, name: v.name, qr_link_id: v.qr_link_id || null })),
    config: exp.config,
    start_at: exp.start_at, end_at: exp.end_at, planned_end_at: exp.planned_end_at,
    winner: exp.winner, notice: exp.notice,
    sales: { synced_at: exp.sales_synced_at, synced_to: exp.sales_synced_to, error: exp.sales_error, currency: exp.sales_currency },
    created_at: exp.created_at, updated_at: exp.updated_at,
  };
}

router.get('/', (req, res) => {
  if (!access(req, res)) return;
  const rows = db.prepare('SELECT * FROM experiments WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200').all(req.workspaceId);
  res.json(rows.map((r) => present(core.hydrate(r))));
});

/** Everything the create wizard picks from, in one call, all of it this workspace's. */
router.get('/options', (req, res) => {
  if (!access(req, res)) return;
  const ws = req.workspaceId;
  const playlists = db.prepare('SELECT id, name, smart_rules FROM playlists WHERE workspace_id = ? ORDER BY name LIMIT 500').all(ws)
    .filter((p) => !p.smart_rules && !require('../lib/corporate/guard').governanceOf(db, p.id).kind)
    .map((p) => ({ id: p.id, name: p.name }));
  const content = db.prepare("SELECT id, filename AS name, mime_type FROM content WHERE workspace_id = ? AND COALESCE(is_active, 1) = 1 ORDER BY created_at DESC LIMIT 500").all(ws);
  const widgets = db.prepare("SELECT id, name, widget_type FROM widgets WHERE workspace_id = ? AND widget_type != 'slide' ORDER BY name LIMIT 500").all(ws);
  const decks = db.prepare('SELECT id, name FROM slide_decks WHERE workspace_id = ? AND playlist_id IS NOT NULL ORDER BY updated_at DESC LIMIT 500').all(ws);
  const qrLinks = db.prepare('SELECT id, name FROM qr_links WHERE workspace_id = ? ORDER BY name LIMIT 500').all(ws);
  const sources = db.prepare("SELECT id, name, type FROM data_sources WHERE workspace_id = ? AND type IN ('square','shopify') ORDER BY name").all(ws);
  let approvals = false;
  try { approvals = require('../lib/release-policy').approvalRequired(db, ws); } catch { approvals = false; }
  res.json({ playlists, content, widgets, decks, qr_links: qrLinks, data_sources: sources, approvals });
});

/** The items of a playlist that can be tested, and the locations its screens are in. */
router.get('/slot', (req, res) => {
  if (!access(req, res)) return;
  const pl = db.prepare('SELECT id FROM playlists WHERE id = ? AND workspace_id = ?').get(String(req.query.playlist_id || ''), req.workspaceId);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });
  const items = db.prepare(`SELECT pi.id, pi.content_id, pi.widget_id, pi.play_when, pi.experiment_id, COALESCE(c.filename, w.name) AS name
      FROM playlist_items pi LEFT JOIN content c ON c.id = pi.content_id LEFT JOIN widgets w ON w.id = pi.widget_id
     WHERE pi.playlist_id = ? AND pi.child_playlist_id IS NULL AND (pi.content_id IS NOT NULL OR pi.widget_id IS NOT NULL)
     ORDER BY pi.sort_order`).all(pl.id)
    .map((r) => ({ id: r.id, name: r.name || '', kind: r.content_id ? 'content' : 'widget', ref_id: r.content_id || r.widget_id, has_condition: !!r.play_when, busy: !!r.experiment_id }));
  const units = require('../lib/experiments/assign').unitsFromDevices(core.screensFor(req.workspaceId, pl.id));
  const deviceIds = units.flatMap((u) => u.device_ids);
  res.json({ items, units: units.map((u) => ({ key: u.key, label: u.label, screens: u.device_ids.length })), screens: deviceIds.length, audience: data.hasAudience(req.workspaceId, deviceIds) });
});

router.get('/:id', (req, res) => {
  if (!access(req, res)) return;
  const exp = loadOr404(req, res); if (!exp) return;
  const units = core.unitsOf(exp.id).map((u) => ({ unit_key: u.unit_key, label: u.label, screens: u.device_ids.length, variant: u.variant,
    square_location_id: u.square_location_id, shopify_location_id: u.shopify_location_id }));
  res.json({ ...present(exp), units });
});

router.get('/:id/results', (req, res) => {
  if (!access(req, res)) return;
  const exp = loadOr404(req, res); if (!exp) return;
  try { res.json(analyze.results(exp)); } catch (e) { sendError(res, e); }
});

router.post('/', (req, res) => {
  if (!access(req, res, { write: true })) return;
  try {
    const exp = core.create(req.workspaceId, req.user && req.user.id, req.body || {});
    auditFromReq(req, 'experiment.created', { experiment_id: exp.id, name: exp.name, mode: exp.mode, variants: exp.variants.length });
    res.status(201).json(present(exp));
  } catch (e) { sendError(res, e); }
});

router.put('/:id', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const exp = loadOr404(req, res); if (!exp) return;
  try { res.json(present(core.update(exp, req.body || {}))); } catch (e) { sendError(res, e); }
});

/** Map each location to its Square / Shopify location. Allowed until the test is over. */
router.put('/:id/units', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const exp = loadOr404(req, res); if (!exp) return;
  try {
    const units = core.setUnitMapping(exp, req.body && req.body.units);
    res.json(units.map((u) => ({ unit_key: u.unit_key, label: u.label, screens: u.device_ids.length, variant: u.variant, square_location_id: u.square_location_id, shopify_location_id: u.shopify_location_id })));
  } catch (e) { sendError(res, e); }
});

/** A Square/Shopify source's locations, for the mapping. The token never leaves the server. */
router.get('/:id/pos-locations', async (req, res) => {
  if (!access(req, res, { write: true })) return;
  const exp = loadOr404(req, res); if (!exp) return;
  const dsId = String(req.query.data_source_id || '');
  if (!(exp.config.sales && exp.config.sales.data_source_ids || []).includes(dsId)) return res.status(404).json({ error: 'Data source not found' });
  const ds = data.dataSourceConfig(req.workspaceId, dsId);
  if (!ds) return res.status(404).json({ error: 'Data source not found' });
  const sales = require('../lib/experiments/sales');
  try {
    const locations = ds.type === 'square' ? await sales.squareLocations(ds.config) : await sales.shopifyLocations(ds.config);
    res.json({ type: ds.type, locations });
  } catch (e) {
    res.status(502).json({ error: e && e.name === 'UserFacingError' ? e.userMessage : 'Could not read the locations.' });
  }
});

/** Before-period sales per location, used to balance the assignment of big and small stores. */
function assignmentBaseline(exp) {
  const o = exp.config.outcome;
  if (exp.mode !== 'location' || !['sales', 'csv'].includes(o.source)) return null;
  const m = data.outcomeMap(exp.id, o);
  if (!m.size) return null;
  const out = {};
  for (const [key, v] of m) {
    const unit = key.slice(0, key.lastIndexOf('|'));
    out[unit] = (out[unit] || 0) + v;
  }
  return out;
}

router.post('/:id/start', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const exp = loadOr404(req, res); if (!exp) return;
  try {
    const next = resolve.start(exp, req, { baseline: assignmentBaseline(exp) });
    auditFromReq(req, 'experiment.started', { experiment_id: exp.id, name: exp.name, playlist_id: exp.playlist_id, mode: exp.mode });
    res.json(present(next));
  } catch (e) { sendError(res, e); }
});

router.post('/:id/stop', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const exp = loadOr404(req, res); if (!exp) return;
  try {
    const next = resolve.finish(exp, req, { reason: 'stopped' });
    auditFromReq(req, 'experiment.stopped', { experiment_id: exp.id, name: exp.name });
    res.json(present(next));
  } catch (e) { sendError(res, e); }
});

router.post('/:id/rollout', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const exp = loadOr404(req, res); if (!exp) return;
  try {
    const k = req.body && req.body.variant;
    const next = resolve.rollOut(exp, k, req);
    auditFromReq(req, 'experiment.rolled_out', { experiment_id: exp.id, name: exp.name, variant: next.winner, label: next.variants[next.winner] && next.variants[next.winner].label });
    res.json(present(next));
  } catch (e) { sendError(res, e); }
});

router.post('/:id/import-sales', async (req, res) => {
  if (!access(req, res, { write: true })) return;
  const exp = loadOr404(req, res); if (!exp) return;
  try {
    const r = await data.importSales(exp);
    if (!r.ok) return res.status(r.error && /already running/.test(r.error) ? 409 : 502).json({ error: r.error });
    auditFromReq(req, 'experiment.sales_imported', { experiment_id: exp.id });
    res.json({ ok: true, experiment: present(core.load(exp.id, req.workspaceId)) });
  } catch (e) { sendError(res, e); }
});

router.post('/:id/outcomes/csv', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const exp = loadOr404(req, res); if (!exp) return;
  const v = data.validateCsv(exp, req.body && req.body.csv);
  if (v.errors) return res.status(400).json({ error: v.errors[0].message, errors: v.errors });
  data.storeCsv(exp, v.rows);
  auditFromReq(req, 'experiment.csv_uploaded', { experiment_id: exp.id, rows: v.rows.length });
  res.json({ ok: true, rows: v.rows.length });
});

router.delete('/:id', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const exp = loadOr404(req, res); if (!exp) return;
  try {
    core.remove(exp);
    auditFromReq(req, 'experiment.deleted', { experiment_id: exp.id, name: exp.name });
    res.json({ ok: true });
  } catch (e) { sendError(res, e); }
});

module.exports = router;
