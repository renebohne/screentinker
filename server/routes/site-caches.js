'use strict';

/*
 * Site caches (lib/site-cache, docs/site-cache.md) — Displays → Site caches.
 *
 * JWT only (config/api-surface.js): creating one mints a credential that downloads this workspace's
 * media, which is a signed-in admin's act, not an integration's. Reading needs workspace membership;
 * every change needs a workspace admin (or an org admin acting as one), and a viewer is refused
 * before anything else.
 */

const express = require('express');
const router = express.Router();
router.use(require('../lib/backstop-limiter'));
const { db } = require('../db/database');
const { resourceAccess, denyReadOnly } = require('../lib/tenancy');
const { auditFromReq } = require('../lib/audit');
const origin = require('../lib/site-cache/origin');

function access(req, res, { write = false } = {}) {
  if (!req.workspaceId) { res.status(403).json({ error: 'No workspace context' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (write) {
    if (denyReadOnly(req, res)) return null;
    if (!ctx.actingAs && ctx.workspaceRole !== 'workspace_admin') {
      res.status(403).json({ error: 'Only a workspace admin can change site caches.', code: 'SITE_CACHE_ADMIN_REQUIRED' }); return null;
    }
  }
  return ctx;
}
function load(req, res) {
  const row = db.prepare('SELECT * FROM site_caches WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) { res.status(404).json({ error: 'Site cache not found' }); return null; }
  return row;
}

/* Re-send payloads so screens learn (or forget) their cache now rather than on their next refresh. */
function push(req, deviceIds) {
  try {
    const io = req.app && req.app.get('io');
    if (!io || !deviceIds || !deviceIds.length) return;
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    const ns = io.of('/device');
    for (const id of new Set(deviceIds)) commandQueue.queueOrEmitPlaylistUpdate(ns, id, buildPlaylistPayload);
  } catch (e) {
    console.warn(`[site-cache] re-push failed: ${e && e.message}`);
  }
}

/** What to paste on the box. The token appears here and in the create/rotate response, never again. */
function setup(req, token) {
  let base = '';
  try { base = require('../lib/public-origin').publicOrigin(req) || ''; } catch (_) { base = ''; }
  return {
    token,
    origin: base,
    env: `SITE_CACHE_FOR=${base}\nSITE_CACHE_TOKEN=${token}`,
  };
}

router.get('/', (req, res) => {
  if (!access(req, res)) return;
  res.json(db.prepare('SELECT * FROM site_caches WHERE workspace_id = ? ORDER BY name').all(req.workspaceId).map((r) => origin.present(db, r)));
});

router.get('/:id', (req, res) => {
  if (!access(req, res)) return;
  const row = load(req, res); if (!row) return;
  res.json(origin.present(db, row));
});

router.post('/', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const { fields, error } = origin.normaliseInput(req.body, null);
  if (error) return res.status(400).json({ error });
  const count = db.prepare('SELECT COUNT(*) AS n FROM site_caches WHERE workspace_id = ?').get(req.workspaceId).n;
  if (count >= 100) return res.status(400).json({ error: 'This workspace already has 100 site caches.' });
  const { row, token } = origin.createCache(db, { workspaceId: req.workspaceId, name: fields.name, lanUrl: fields.lan_url, userId: req.user.id });
  auditFromReq(req, 'site_cache.create', { site_cache_id: row.id, name: row.name, lan_url: row.lan_url });
  res.status(201).json({ ...origin.present(db, row), setup: setup(req, token) });
});

router.put('/:id', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const row = load(req, res); if (!row) return;
  const { fields, error } = origin.normaliseInput(req.body, row);
  if (error) return res.status(400).json({ error });
  const cols = Object.keys(fields);
  if (cols.length) {
    db.prepare(`UPDATE site_caches SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = strftime('%s','now') WHERE id = @id`).run({ ...fields, id: row.id });
  }
  origin.forget(row.id);
  auditFromReq(req, 'site_cache.update', { site_cache_id: row.id, fields: cols });
  // The address or the on/off switch reaches every screen's payload.
  if (cols.includes('lan_url') || cols.includes('enabled')) push(req, origin.devicesForCache(db, { ...row, enabled: 1 }));
  res.json(origin.present(db, db.prepare('SELECT * FROM site_caches WHERE id = ?').get(row.id)));
});

router.post('/:id/rotate-token', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const row = load(req, res); if (!row) return;
  const token = origin.rotateSecrets(db, row.id);
  auditFromReq(req, 'site_cache.rotate_token', { site_cache_id: row.id, name: row.name });
  // New key: screens need tokens signed with it.
  push(req, origin.devicesForCache(db, row));
  res.json({ ...origin.present(db, db.prepare('SELECT * FROM site_caches WHERE id = ?').get(row.id)), setup: setup(req, token) });
});

router.put('/:id/assignments', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const row = load(req, res); if (!row) return;
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const r = origin.setAssignments(db, row, { device_ids: b.device_ids, group_ids: b.group_ids });
  if (r.error) return res.status(400).json({ error: r.error });
  auditFromReq(req, 'site_cache.assign', {
    site_cache_id: row.id,
    devices: Array.isArray(b.device_ids) ? b.device_ids.length : 0,
    groups: Array.isArray(b.group_ids) ? b.group_ids.length : 0,
  });
  push(req, r.devices);
  res.json(origin.present(db, db.prepare('SELECT * FROM site_caches WHERE id = ?').get(row.id)));
});

router.delete('/:id', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const row = load(req, res); if (!row) return;
  const affected = origin.devicesForCache(db, row);
  db.prepare('DELETE FROM site_caches WHERE id = ?').run(row.id);
  origin.forget(row.id);
  auditFromReq(req, 'site_cache.delete', { site_cache_id: row.id, name: row.name });
  push(req, affected);
  res.json({ success: true });
});

module.exports = router;
