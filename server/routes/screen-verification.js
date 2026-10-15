'use strict';

/*
 * Screen verification (lib/screen-verify, docs/screen-verification.md).
 *
 * Reads are for any member of the workspace, viewers included: knowing a screen is showing a
 * blank frame is exactly what a view-only member is there for. Writes:
 *   - settings: a workspace admin (or an org admin acting as one) — they decide how often every
 *     screen is asked for a screenshot and who gets paged, which is not an editor's call
 *   - "check now": anyone who may change things (not a viewer)
 *
 * Every read is scoped twice: the stored rows carry the workspace they were written in, AND the
 * device must still be in this workspace. A screen moved elsewhere takes none of its history along.
 */

const express = require('express');
const router = express.Router();
router.use(require('../lib/backstop-limiter'));
const { db } = require('../db/database');
const { resourceAccess, denyReadOnly } = require('../lib/tenancy');
const { auditFromReq } = require('../lib/audit');
const cl = require('../lib/screen-verify/classify');
const sv = require('../lib/screen-verify');

function access(req, res, { admin = false } = {}) {
  if (!req.workspaceId) { res.status(403).json({ error: 'No workspace context' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (admin && !ctx.actingAs && ctx.workspaceRole !== 'workspace_admin') {
    res.status(403).json({ error: 'Only a workspace admin can change screen verification.', code: 'VERIFY_ADMIN_REQUIRED' }); return null;
  }
  return ctx;
}

function deviceInWorkspace(req, res) {
  const d = db.prepare('SELECT * FROM devices WHERE id = ? AND workspace_id = ?').get(String(req.params.id || ''), req.workspaceId);
  if (!d) { res.status(404).json({ error: 'Screen not found' }); return null; }
  return d;
}

function stateRow(deviceId) {
  return db.prepare('SELECT * FROM screen_verification_state WHERE device_id = ?').get(deviceId) || null;
}

function presentIncident(r) {
  let detail = null;
  try { detail = r.detail ? JSON.parse(r.detail) : null; } catch { detail = null; }
  return {
    id: r.id, device_id: r.device_id, device_name: r.device_name, kind: r.kind, detail,
    opened_at: r.opened_at, confirmed_at: r.confirmed_at, resolved_at: r.resolved_at, resolved_reason: r.resolved_reason,
    observations: r.observations,
  };
}

/** How many of this workspace's alert channels would hear about a screen problem. */
function channelSummary(workspaceId) {
  const rows = db.prepare('SELECT events, enabled FROM alert_channels WHERE workspace_id = ?').all(workspaceId);
  let subscribed = 0;
  for (const r of rows) {
    let ev = [];
    try { ev = JSON.parse(r.events || '[]'); } catch { ev = []; }
    if (r.enabled && Array.isArray(ev) && ev.includes('screen_problem')) subscribed++;
  }
  return { total: rows.length, subscribed };
}

router.get('/settings', (req, res) => {
  if (!access(req, res)) return;
  const s = sv.settingsFor(req.workspaceId);
  res.json({ ...s, checks: cl.CHECKS, sensitivities: cl.SENSITIVITIES, channels: channelSummary(req.workspaceId) });
});

router.put('/settings', (req, res) => {
  if (denyReadOnly(req, res)) return;
  if (!access(req, res, { admin: true })) return;
  const { fields, error } = cl.normaliseSettings(req.body);
  if (error) return res.status(400).json({ error });
  const cols = Object.keys(fields);
  if (!cols.length) return res.status(400).json({ error: 'Nothing to change.' });
  db.prepare('INSERT OR IGNORE INTO screen_verification_settings (workspace_id) VALUES (?)').run(req.workspaceId);
  db.prepare(`UPDATE screen_verification_settings SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_by = @uid, updated_at = strftime('%s','now') WHERE workspace_id = @ws`)
    .run({ ...fields, uid: req.user.id, ws: req.workspaceId });
  sv.invalidateSettings(req.workspaceId);
  auditFromReq(req, 'screen_verification.settings', { fields: cols, ...fields });
  const s = sv.settingsFor(req.workspaceId);
  res.json({ ...s, checks: cl.CHECKS, sensitivities: cl.SENSITIVITIES, channels: channelSummary(req.workspaceId) });
});

/** Every screen in the workspace, as its badge shows it. */
router.get('/states', (req, res) => {
  if (!access(req, res)) return;
  const settings = sv.settingsFor(req.workspaceId);
  const devices = db.prepare('SELECT * FROM devices WHERE workspace_id = ?').all(req.workspaceId);
  const rows = new Map(db.prepare(`SELECT s.* FROM screen_verification_state s JOIN devices d ON d.id = s.device_id
    WHERE d.workspace_id = ? AND s.workspace_id = d.workspace_id`).all(req.workspaceId).map((r) => [r.device_id, r]));
  res.json({ enabled: settings.enabled, states: devices.map((d) => sv.presentState(d, rows.get(d.id) || null, settings)) });
});

/** One screen: its state and its recent incidents. */
router.get('/devices/:id', (req, res) => {
  if (!access(req, res)) return;
  const d = deviceInWorkspace(req, res); if (!d) return;
  const settings = sv.settingsFor(req.workspaceId);
  const incidents = db.prepare(`SELECT i.*, ? AS device_name FROM screen_verification_incidents i
    WHERE i.device_id = ? AND i.workspace_id = ? AND i.confirmed_at IS NOT NULL ORDER BY i.opened_at DESC LIMIT 20`)
    .all(d.name, d.id, req.workspaceId);
  res.json({ ...sv.presentState(d, stateRow(d.id), settings), incidents: incidents.map(presentIncident) });
});

/** Ask the screen for a verification screenshot now. */
router.post('/devices/:id/check', (req, res) => {
  if (denyReadOnly(req, res)) return;
  if (!access(req, res)) return;
  const d = deviceInWorkspace(req, res); if (!d) return;
  if (!sv.settingsFor(req.workspaceId).enabled) return res.status(409).json({ error: 'Screen verification is switched off for this workspace.', code: 'VERIFY_DISABLED' });
  if (!require('../lib/player-capabilities').supports(d, 'remote.screenshot')) {
    return res.status(409).json({ error: 'This screen cannot take screenshots, so it cannot be checked.', code: 'VERIFY_NO_CAPTURE' });
  }
  const r = sv.requestNow(d.id);
  if (r === 'too_soon') return res.status(429).json({ error: 'A check was just requested. Try again in a few seconds.' });
  if (r === 'not_connected') return res.status(409).json({ error: 'The screen is not connected.', code: 'VERIFY_NOT_CONNECTED' });
  res.json({ ok: true });
});

/** Confirmed incidents across the workspace, newest first. */
router.get('/incidents', (req, res) => {
  if (!access(req, res)) return;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const open = req.query.open === '1';
  const rows = db.prepare(`SELECT i.*, d.name AS device_name FROM screen_verification_incidents i
      JOIN devices d ON d.id = i.device_id
    WHERE i.workspace_id = ? AND d.workspace_id = i.workspace_id AND i.confirmed_at IS NOT NULL
      ${open ? 'AND i.resolved_at IS NULL' : ''}
    ORDER BY i.opened_at DESC LIMIT ?`).all(req.workspaceId, limit);
  res.json(rows.map(presentIncident));
});

module.exports = router;
