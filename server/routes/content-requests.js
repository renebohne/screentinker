'use strict';

/*
 * Content requests — the WORKSPACE side: request forms (admins and editors make them) and the
 * requests that arrive through them (lib/content-requests.js, docs/content-requests.md).
 *
 * JWT only, with tenancy (config/api-surface.js): a form decides who outside the workspace may put
 * things in front of a reviewer, which is a signed-in person's decision, not an API token's. Every
 * lookup is by id AND req.workspaceId, so another workspace's form or request is a 404, never a 403
 * that confirms it exists. Viewers read; writes need the editor role (denyReadOnly on each).
 */

const express = require('express');
const router = express.Router();
// Abuse backstop (lib/backstop-limiter.js): already counted app-wide; here so this router is never unguarded.
router.use(require('../lib/backstop-limiter'));
const { db } = require('../db/database');
const { requireWorkspaceRead, requireWorkspaceWrite } = require('../lib/permissions');
const { denyReadOnly } = require('../lib/tenancy');
const { auditFromReq } = require('../lib/audit');
const cr = require('../lib/content-requests');

function fail(res, e) {
  if (require('../lib/corporate/guard').send(res, e)) return undefined;
  if (e && (e.name === 'RequestError' || e.name === 'ApprovalError' || e.name === 'ReleaseError')) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code || null, ...(e.extra || {}) });
  }
  console.error('[requests]', e && e.message);
  return res.status(500).json({ error: 'Something went wrong' });
}

function requireWs(req, res, next) {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  next();
}
router.use(requireWs);

function loadForm(req, res) {
  const f = cr.getForm(req.params.id, req.workspaceId);
  if (!f) { res.status(404).json({ error: 'Form not found' }); return null; }
  return f;
}

// ─── what a form can be set up with ─────────────────────────────────────────────────────────

router.get('/options', requireWorkspaceRead, (req, res) => {
  const devices = db.prepare('SELECT id, name FROM devices WHERE workspace_id = ? ORDER BY name COLLATE NOCASE').all(req.workspaceId);
  const groups = db.prepare('SELECT id, name, playlist_id FROM device_groups WHERE workspace_id = ? ORDER BY name COLLATE NOCASE').all(req.workspaceId);
  const playlists = db.prepare('SELECT id, name FROM playlists WHERE workspace_id = ? AND (is_auto_generated IS NULL OR is_auto_generated = 0) ORDER BY name COLLATE NOCASE').all(req.workspaceId);
  const folders = db.prepare('SELECT id, name FROM content_folders WHERE workspace_id = ? ORDER BY name COLLATE NOCASE').all(req.workspaceId);
  res.json({
    devices, groups, playlists, folders,
    email_available: cr.emailConfigured(),
    sso_available: !!cr.ssoProviderFor(req.workspaceId),
    max_mb: Math.max(1, Math.floor(require('../config').maxFileSize / 1048576)),
  });
});

// ─── forms ───────────────────────────────────────────────────────────────────────────────────

router.get('/forms', requireWorkspaceRead, (req, res) => {
  res.json(cr.listForms(req.workspaceId).map(cr.adminForm));
});

router.post('/forms', requireWorkspaceWrite, (req, res) => {
  if (denyReadOnly(req, res)) return;
  try {
    const f = cr.createForm(req.workspaceId, req.body || {}, req.user.id);
    auditFromReq(req, 'request_form:created', { form_id: f.id, title: f.title, access_mode: f.access_mode });
    res.status(201).json(cr.adminForm(f));
  } catch (e) { fail(res, e); }
});

router.get('/forms/:id', requireWorkspaceRead, (req, res) => {
  const f = loadForm(req, res);
  if (f) res.json(cr.adminForm(f));
});

router.put('/forms/:id', requireWorkspaceWrite, (req, res) => {
  if (denyReadOnly(req, res)) return;
  const f = loadForm(req, res);
  if (!f) return;
  try {
    const out = cr.updateForm(f, req.body || {});
    auditFromReq(req, 'request_form:updated', { form_id: f.id, status: out.status, access_mode: out.access_mode });
    res.json(cr.adminForm(out));
  } catch (e) { fail(res, e); }
});

router.post('/forms/:id/rotate', requireWorkspaceWrite, (req, res) => {
  if (denyReadOnly(req, res)) return;
  const f = loadForm(req, res);
  if (!f) return;
  const out = cr.rotateCode(f);
  auditFromReq(req, 'request_form:link_rotated', { form_id: f.id });
  res.json(cr.adminForm(out));
});

router.delete('/forms/:id', requireWorkspaceWrite, (req, res) => {
  if (denyReadOnly(req, res)) return;
  const f = loadForm(req, res);
  if (!f) return;
  cr.deleteForm(f);
  auditFromReq(req, 'request_form:deleted', { form_id: f.id, title: f.title });
  res.json({ ok: true });
});

// ─── requests ────────────────────────────────────────────────────────────────────────────────

router.get('/requests', requireWorkspaceRead, (req, res) => {
  const status = ['pending', 'approved', 'published', 'rejected', 'cancelled', 'all'].includes(req.query.status) ? req.query.status : 'pending';
  res.json(cr.listRequests(req.workspaceId, { status, formId: typeof req.query.form === 'string' ? req.query.form : null }));
});

router.get('/requests/:id', requireWorkspaceRead, (req, res) => {
  const r = cr.getRequest(req.params.id, req.workspaceId);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  res.json(cr.requestDetail(r, req));
});

router.post('/requests/:id/approve', requireWorkspaceWrite, async (req, res) => {
  if (denyReadOnly(req, res)) return;
  try { res.json(await cr.approveRequest(req, req.params.id, req.body || {})); } catch (e) { fail(res, e); }
});

router.post('/requests/:id/reject', requireWorkspaceWrite, (req, res) => {
  if (denyReadOnly(req, res)) return;
  try { res.json(cr.rejectRequest(req, req.params.id, req.body || {})); } catch (e) { fail(res, e); }
});

// Retry the screens an approved request did not reach (a playlist had unpublished changes, say).
router.post('/requests/:id/publish', requireWorkspaceWrite, async (req, res) => {
  if (denyReadOnly(req, res)) return;
  try { res.json(await cr.publishRequest(req, req.params.id)); } catch (e) { fail(res, e); }
});

module.exports = router;
