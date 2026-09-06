'use strict';

/**
 * Data Sources & Integrations REST API Routes for ScreenTinker.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db } = require('../db/database');
const { syncDataSource, withFetchSlot } = require('../lib/data-sources/service');
const { resolveIcalData } = require('../lib/data-sources/ical-resolver');
const { requireWorkspaceWrite, canWrite } = require('../lib/permissions');

const SUPPORTED_TYPES = new Set(['ical']);

// Helper to generate a clean URL-friendly slug
function toSlug(str) {
  return String(str || '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '_')
    .replace(/^_|_$/g, '') || 'source';
}

function sanitizeConfigForRole(cfg, req) {
  if (!cfg || typeof cfg !== 'object') return {};
  if (canWrite(req)) return cfg;
  const safe = { ...cfg };
  if (safe.url) {
    try {
      const u = new URL(safe.url);
      if (u.search) u.search = '?***';
      if (u.username) u.username = '***';
      if (u.password) u.password = '***';
      safe.url = u.toString();
    } catch (_) {
      safe.url = '***';
    }
  }
  if (safe.ics_data) safe.ics_data = '[redacted]';
  if (safe.raw_data) safe.raw_data = '[redacted]';
  if (safe.raw_ics) safe.raw_ics = '[redacted]';
  return safe;
}

// ─── GET /api/data-sources (List all in current workspace) ─────────────────────
router.get('/', (req, res) => {
  const wsId = req.workspaceId;
  const rows = db.prepare(`
    SELECT id, workspace_id, slug, name, type, config, cached_data, last_fetched_at, last_status, last_error, created_at, updated_at
    FROM data_sources
    WHERE workspace_id = ?
    ORDER BY name ASC
  `).all(wsId);

  const parsed = rows.map(r => {
    let cfg = {};
    try { cfg = JSON.parse(r.config); } catch (_) {}
    let data = null;
    try { data = JSON.parse(r.cached_data || 'null'); } catch (_) {}
    return {
      ...r,
      config: sanitizeConfigForRole(cfg, req),
      data,
    };
  });

  res.json(parsed);
});

// ─── GET /api/data-sources/:id (Get single data source with live preview) ──────
router.get('/:id', (req, res) => {
  const wsId = req.workspaceId;
  const row = db.prepare('SELECT * FROM data_sources WHERE id = ? AND workspace_id = ?').get(req.params.id, wsId);
  if (!row) {
    return res.status(404).json({ error: 'Data source not found' });
  }

  let config = {};
  try { config = JSON.parse(row.config); } catch (_) {}

  let data = null;
  try { data = JSON.parse(row.cached_data || 'null'); } catch (_) {}

  res.json({
    ...row,
    config: sanitizeConfigForRole(config, req),
    data,
  });
});

// ─── POST /api/data-sources/test (Test connection & preview live data) ─────────
router.post('/test', requireWorkspaceWrite, async (req, res, next) => {
  const { type, config } = req.body || {};
  if (!type || !config) {
    return res.status(400).json({ error: 'Type and config are required' });
  }

  if (!SUPPORTED_TYPES.has(type)) {
    return res.status(400).json({ error: `Unsupported data source type: ${type}` });
  }

  let parsedConfig = config;
  if (typeof config === 'string') {
    try { parsedConfig = JSON.parse(config); }
    catch (_) { return res.status(400).json({ error: 'Config must be valid JSON' }); }
  }
  if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) {
    return res.status(400).json({ error: 'Config must be an object' });
  }

  try {
    let previewData = null;
    if (type === 'ical') {
      previewData = await withFetchSlot(() => resolveIcalData(parsedConfig));
    }

    res.json({
      status: 'ok',
      preview: previewData,
    });
  } catch (err) {
    // Do NOT leak the raw upstream error to the caller: it can betray internal topology or
    // distinguish "connection refused" from "DNS failed", which aids SSRF reconnaissance.
    // Log the detail server-side and surface only a generic message.
    console.warn(`[data-sources] Test failed for type "${type}": ${err.message}`);
    res.status(422).json({
      status: 'error',
      error: 'Could not fetch or parse the data source. Check the URL and try again.',
    });
  }
});

// ─── POST /api/data-sources (Create new data source) ───────────────────────────
router.post('/', requireWorkspaceWrite, (req, res) => {
  const wsId = req.workspaceId;
  const { name, type, config, slug: customSlug } = req.body || {};

  if (!name || !type || !config) {
    return res.status(400).json({ error: 'Name, type, and config are required' });
  }

  if (!SUPPORTED_TYPES.has(type)) {
    return res.status(400).json({ error: `Unsupported data source type: ${type}` });
  }

  let parsedConfig = config;
  if (typeof config === 'string') {
    try { parsedConfig = JSON.parse(config); }
    catch (_) { return res.status(400).json({ error: 'Config must be valid JSON' }); }
  }
  if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) {
    return res.status(400).json({ error: 'Config must be an object' });
  }

  const cleanName = String(name).trim();
  let cleanSlug = customSlug ? toSlug(customSlug) : toSlug(cleanName);

  // Ensure slug uniqueness in workspace
  let uniqueSlug = cleanSlug;
  let counter = 1;
  while (db.prepare('SELECT 1 FROM data_sources WHERE workspace_id = ? AND slug = ?').get(wsId, uniqueSlug)) {
    uniqueSlug = `${cleanSlug}_${counter++}`;
  }

  const id = `ds_${crypto.randomUUID()}`;
  const configJson = JSON.stringify(parsedConfig);
  const nowSec = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO data_sources (id, workspace_id, slug, name, type, config, last_fetched_at, last_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?)
  `).run(id, wsId, uniqueSlug, cleanName, type, configJson, nowSec, nowSec);

  // Trigger initial sync in background
  const newRow = db.prepare('SELECT * FROM data_sources WHERE id = ?').get(id);
  syncDataSource(newRow, true).catch(err => {
    console.warn(`[data-sources] background initial sync failed for ${id}:`, err.message);
  });

  res.status(201).json({
    status: 'ok',
    id,
    slug: uniqueSlug,
    name: cleanName,
    type,
    config: parsedConfig,
    data: null,
  });
});

// ─── PUT /api/data-sources/:id (Update data source) ────────────────────────────
router.put('/:id', requireWorkspaceWrite, (req, res) => {
  const wsId = req.workspaceId;
  const { name, config, slug: customSlug } = req.body || {};

  const existing = db.prepare('SELECT * FROM data_sources WHERE id = ? AND workspace_id = ?').get(req.params.id, wsId);
  if (!existing) {
    return res.status(404).json({ error: 'Data source not found' });
  }

  const cleanName = name ? String(name).trim() : existing.name;
  let cleanSlug = customSlug ? toSlug(customSlug) : existing.slug;

  if (cleanSlug !== existing.slug) {
    const collision = db.prepare('SELECT 1 FROM data_sources WHERE workspace_id = ? AND slug = ? AND id != ?').get(wsId, cleanSlug, req.params.id);
    if (collision) {
      return res.status(409).json({ error: `Slug "${cleanSlug}" is already taken in this workspace` });
    }
  }

  let configJson = existing.config;
  let parsedConfig = null;
  if (config !== undefined) {
    parsedConfig = config;
    if (typeof config === 'string') {
      try { parsedConfig = JSON.parse(config); }
      catch (_) { return res.status(400).json({ error: 'Config must be valid JSON' }); }
    }
    if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) {
      return res.status(400).json({ error: 'Config must be an object' });
    }
    configJson = JSON.stringify(parsedConfig);
  } else {
    try { parsedConfig = JSON.parse(configJson); } catch (_) {}
  }

  const nowSec = Math.floor(Date.now() / 1000);

  db.prepare(`
    UPDATE data_sources
    SET name = ?, slug = ?, config = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ?
  `).run(cleanName, cleanSlug, configJson, nowSec, req.params.id, wsId);

  // Trigger refresh with new config in background
  const updatedRow = db.prepare('SELECT * FROM data_sources WHERE id = ?').get(req.params.id);
  syncDataSource(updatedRow, true).catch(err => {
    console.warn(`[data-sources] background update sync failed for ${req.params.id}:`, err.message);
  });

  let existingData = null;
  try { existingData = JSON.parse(existing.cached_data || 'null'); } catch (_) {}

  res.json({
    status: 'ok',
    id: req.params.id,
    slug: cleanSlug,
    name: cleanName,
    type: existing.type,
    config: parsedConfig,
    data: existingData,
  });
});

// ─── POST /api/data-sources/:id/refresh (Force refresh) ─────────────────────────
router.post('/:id/refresh', requireWorkspaceWrite, async (req, res, next) => {
  try {
    const wsId = req.workspaceId;
    const row = db.prepare('SELECT * FROM data_sources WHERE id = ? AND workspace_id = ?').get(req.params.id, wsId);
    if (!row) {
      return res.status(404).json({ error: 'Data source not found' });
    }

    const synced = await syncDataSource(row, true);
    res.json({
      status: 'ok',
      last_status: synced.last_status,
      last_error: synced.last_error,
      last_fetched_at: synced.last_fetched_at,
      data: synced.data,
    });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /api/data-sources/:id (Delete data source) ─────────────────────────
router.delete('/:id', requireWorkspaceWrite, (req, res) => {
  const wsId = req.workspaceId;
  const result = db.prepare('DELETE FROM data_sources WHERE id = ? AND workspace_id = ?').run(req.params.id, wsId);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Data source not found' });
  }

  res.json({ success: true, message: 'Data source deleted' });
});

module.exports = router;
