'use strict';

/*
 * 3.0 accessibility checker (lib/a11y, docs/accessibility.md).
 *
 * Mounted JWT-only with resolveTenancy (config/api-surface.js), so every handler acts on the
 * caller's ACTIVE workspace and nothing else. No handler takes a workspace id from the request, and
 * every id in a path is looked up together with req.workspaceId: another workspace's id is a 404,
 * exactly like an id that does not exist.
 *
 *   GET  /                          the workspace report (any member: it is read-only)
 *   GET  /badges                    the compact per-id form the dashboard badges use
 *   GET  /check/:type/:id           one playlist / slide_deck / content / widget, + whether the
 *                                   publish policy would refuse it (the pre-publish warning)
 *   POST /check/sign                a Make-a-sign sign as it will be built (read-only, like preview)
 *   GET  /settings · PUT /settings  viewing distance, screen size, block policy (PUT: admin)
 *   PUT  /screens/:id               one screen's own distance / size (admin)
 *   GET  /stt · PUT /stt            the speech-to-text endpoint for captions (PUT: admin; key never returned)
 *   POST /captions/:id              start "Generate captions" (editor)
 *   GET  /captions/:id              the job's state
 *   GET  /captions/:id/vtt          the current caption text, for editing
 *   PUT  /captions/:id/vtt          save edited captions (editor)
 *
 * The one-click colour fixes are NOT here: the dashboard applies them through the deck and widget
 * endpoints, so drafts, review, corporate locks and history all apply exactly as for a hand edit.
 */

const express = require('express');
const router = express.Router();
router.use(require('../lib/backstop-limiter'));
const { db } = require('../db/database');
const a11y = require('../lib/a11y');
const captions = require('../lib/a11y/captions');
const { canRead, canWrite, canAdmin } = require('../lib/permissions');
const { denyReadOnly } = require('../lib/tenancy');
const { auditFromReq } = require('../lib/audit');

const TYPES = new Set(['playlist', 'slide_deck', 'content', 'widget']);

function requireWs(req, res) {
  if (!req.workspaceId) { res.status(403).json({ error: 'No workspace context' }); return false; }
  if (!canRead(req)) { res.status(403).json({ error: 'Workspace access required' }); return false; }
  return true;
}
function requireWrite(req, res) {
  if (!requireWs(req, res)) return false;
  if (denyReadOnly(req, res)) return false;
  if (!canWrite(req)) { res.status(403).json({ error: 'Workspace editor or admin required' }); return false; }
  return true;
}
function requireAdmin(req, res) {
  if (!requireWs(req, res)) return false;
  if (denyReadOnly(req, res)) return false;
  if (!canAdmin(req)) { res.status(403).json({ error: 'Workspace admin required' }); return false; }
  return true;
}

router.get('/', (req, res) => {
  if (!requireWs(req, res)) return;
  // Fresh, like the freshness page: it is opened right after its own fixes.
  const report = a11y.workspaceReport(db, req.workspaceId, { useCache: false });
  res.json({ ...report, can_write: canWrite(req), can_admin: canAdmin(req), stt: captions.getStt(db, req.workspaceId) });
});

router.get('/badges', (req, res) => {
  if (!requireWs(req, res)) return;
  res.json(a11y.badgesFrom(a11y.workspaceReport(db, req.workspaceId)));
});

router.get('/check/:type/:id', (req, res) => {
  if (!requireWs(req, res)) return;
  const type = String(req.params.type);
  if (!TYPES.has(type)) return res.status(400).json({ error: `type must be one of ${[...TYPES].join(', ')}` });
  const out = a11y.checkOne(db, req.workspaceId, type, String(req.params.id));
  if (!out) return res.status(404).json({ error: 'Not found' });
  const gate = type === 'playlist' || type === 'slide_deck' ? a11y.publishGate(db, req.workspaceId, type, String(req.params.id)) : null;
  res.json({ ...out, block: gate ? { code: gate.code, error: gate.error } : null, policy: a11y.getSettings(db, req.workspaceId).block_on_errors });
});

router.post('/check/sign', (req, res) => {
  if (!requireWs(req, res)) return;
  const out = a11y.checkSign(db, req.workspaceId, req.body);
  if (!out) return res.status(400).json({ error: 'Unknown template' });
  res.json(out);
});

router.get('/settings', (req, res) => {
  if (!requireWs(req, res)) return;
  res.json({ ...a11y.getSettings(db, req.workspaceId), defaults: a11y.DEFAULTS, limits: a11y.LIMITS });
});

router.put('/settings', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const current = a11y.getSettings(db, req.workspaceId);
  const v = a11y.validateSettings(current, req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  a11y.saveSettings(db, req.workspaceId, v.settings, req.user.id);
  auditFromReq(req, 'accessibility_settings_updated', { workspace_id: req.workspaceId, before: current, after: v.settings });
  res.json(v.settings);
});

router.put('/screens/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const d = db.prepare('SELECT id FROM devices WHERE id = ? AND workspace_id = ?').get(String(req.params.id), req.workspaceId);
  if (!d) return res.status(404).json({ error: 'Not found' });
  const v = a11y.validateScreen(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const sets = [], args = [];
  if (v.values.viewing_distance_m !== undefined) { sets.push('a11y_viewing_distance_m = ?'); args.push(v.values.viewing_distance_m); }
  if (v.values.screen_diagonal_in !== undefined) { sets.push('a11y_screen_diagonal_in = ?'); args.push(v.values.screen_diagonal_in); }
  if (sets.length) db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`).run(...args, d.id, req.workspaceId);
  a11y.invalidate(req.workspaceId);
  auditFromReq(req, 'accessibility_screen_updated', { workspace_id: req.workspaceId, device_id: d.id, ...v.values });
  const row = db.prepare('SELECT a11y_viewing_distance_m, a11y_screen_diagonal_in FROM devices WHERE id = ?').get(d.id);
  res.json({ id: d.id, viewing_distance_m: row.a11y_viewing_distance_m, screen_diagonal_in: row.a11y_screen_diagonal_in });
});

/* ---------------------------------------------------------------- speech-to-text settings */

router.get('/stt', (req, res) => {
  if (!requireWs(req, res)) return;
  res.json({ ...captions.getStt(db, req.workspaceId), can_admin: canAdmin(req) });
});

router.put('/stt', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const before = captions.getStt(db, req.workspaceId);
  const out = captions.saveStt(db, req.workspaceId, req.body);
  if (!out.ok) return res.status(400).json({ error: out.error });
  // The base URL and model are recorded; the key never is, only whether one is set.
  auditFromReq(req, 'stt_settings_updated', {
    workspace_id: req.workspaceId,
    before: { base_url: before.base_url, model: before.model, has_key: before.has_key },
    after: { base_url: out.settings.base_url, model: out.settings.model, has_key: out.settings.has_key },
  });
  res.json(out.settings);
});

/* ---------------------------------------------------------------- captions */

/** The content row, only if it is in the active workspace (else the response is sent). */
function contentInWs(req, res) {
  const c = db.prepare('SELECT * FROM content WHERE id = ? AND workspace_id = ?').get(String(req.params.id), req.workspaceId);
  if (!c) { res.status(404).json({ error: 'Not found' }); return null; }
  return c;
}
/** Head office's media is written only by its corporate authors (the subtitle upload's own rule). */
function corporateWritable(req, res, c) {
  const guard = require('../lib/corporate/guard');
  try { guard.assertMediaWritable(req, 'content', c.id); return true; } catch (e) {
    if (guard.send(res, e, req)) return false;
    throw e;
  }
}

router.get('/captions/:id', (req, res) => {
  if (!requireWs(req, res)) return;
  const c = contentInWs(req, res);
  if (!c) return;
  const job = captions.jobState(c.id);
  res.json({
    job: job && job.workspace_id === req.workspaceId ? { status: job.status, error: job.error, started_at: job.started_at, finished_at: job.finished_at } : null,
    has_subtitle: !!c.subtitle_url, subtitle_lang: c.subtitle_lang || null,
    stt_configured: captions.getStt(db, req.workspaceId).configured,
  });
});

router.post('/captions/:id', (req, res) => {
  if (!requireWrite(req, res)) return;
  const c = contentInWs(req, res);
  if (!c) return;
  if (!corporateWritable(req, res, c)) return;
  const lang = req.body && typeof req.body.lang === 'string' && /^[a-z]{2,3}$/i.test(req.body.lang) ? req.body.lang : null;
  const out = captions.start(db, { content: c, workspaceId: req.workspaceId, lang, actorReq: { user: req.user, workspaceId: req.workspaceId, ip: req.ip } });
  if (out.status !== 202) return res.status(out.status).json({ error: out.error, code: out.code });
  auditFromReq(req, 'captions_requested', { workspace_id: req.workspaceId, content_id: c.id });
  res.status(202).json({ job: { status: out.job.status, started_at: out.job.started_at } });
});

router.get('/captions/:id/vtt', (req, res) => {
  if (!requireWs(req, res)) return;
  const c = contentInWs(req, res);
  if (!c) return;
  res.json({ vtt: captions.readVtt(c), lang: c.subtitle_lang || null });
});

router.put('/captions/:id/vtt', (req, res) => {
  if (!requireWrite(req, res)) return;
  const c = contentInWs(req, res);
  if (!c) return;
  if (!corporateWritable(req, res, c)) return;
  if (!/^video\//i.test(c.mime_type || '') || c.remote_url) return res.status(400).json({ error: 'Captions belong to an uploaded video.' });
  const vtt = captions.normalizeEdited(req.body && req.body.vtt);
  if (!vtt) return res.status(400).json({ error: 'These captions could not be read. Each caption needs a time line like 00:00:01.000 --> 00:00:04.000 and some words.' });
  const lang = req.body && typeof req.body.lang === 'string' && /^[a-z]{2,3}$/i.test(req.body.lang) ? req.body.lang : null;
  const row = captions.attachVtt(db, c.id, vtt, lang);
  a11y.invalidate(req.workspaceId);
  auditFromReq(req, 'captions_edited', { workspace_id: req.workspaceId, content_id: c.id });
  res.json({ vtt, subtitle_url: row.subtitle_url, subtitle_lang: row.subtitle_lang });
});

module.exports = router;
