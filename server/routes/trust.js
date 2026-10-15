'use strict';

/*
 * "Your data, provably" (docs/trust.md): the data handling report, the outbound connections ledger,
 * complete exports and the organization's "delete everything".
 *
 * Mounted at /api/trust, JWT only, resolveTenancy (config/api-surface.js): no API token reaches any
 * of it — an export is everything an organization has, and deletion is its end.
 *
 *   who                       what
 *   platform admin            ?scope=instance on the report and the ledger; the public-page toggle
 *   org owner / org admin     their organization's report and ledger; an organization export
 *   org owner only            schedule "delete everything"; cancel it (a platform admin may cancel too)
 *   anyone signed in          their own personal export
 *
 * The public pieces — the /trust page, its JSON, and the export download (whose key is the
 * credential, because a browser download cannot carry an Authorization header) — are mounted in
 * server.js with their own rate limits, from the handlers exported at the bottom of this file.
 */

const express = require('express');
const router = express.Router();
router.use(require('../lib/backstop-limiter'));
const fs = require('fs');
const { db } = require('../db/database');
const { isOrgAdmin } = require('../lib/permissions');
const { auditFromReq, audit } = require('../lib/audit');
const appSettings = require('../lib/app-settings');
const report = require('../lib/trust/report');
const exporter = require('../lib/trust/export');
const deletion = require('../lib/trust/org-deletion');

const PUBLIC_SETTING = 'trust_public_enabled';

const isInstance = (req) => req.query.scope === 'instance';
function denyInstance(req, res) {
  if (!req.isPlatformAdmin) { res.status(403).json({ error: 'Platform admin only' }); return true; }
  return false;
}
function denyOrg(req, res) {
  if (!req.organizationId) { res.status(400).json({ error: 'No organization' }); return true; }
  if (!isOrgAdmin(req)) { res.status(403).json({ error: 'Organization owners and admins only' }); return true; }
  return false;
}

/* ───────────── data handling report ───────────── */

router.get('/report', (req, res) => {
  if (isInstance(req)) {
    if (denyInstance(req, res)) return;
    const r = report.build({ db });
    r.public_page = appSettings.getBool(PUBLIC_SETTING, false);
    return res.json(r);
  }
  if (denyOrg(req, res)) return;
  const r = report.build({ db, orgId: req.organizationId });
  r.can_delete = req.orgRole === 'org_owner';
  res.json(r);
});

/* ───────────── outbound connections ledger ───────────── */

router.get('/outbound', (req, res) => {
  const days = [7, 30, 90, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  let rows;
  try { require('../lib/outbound-ledger').flush(); } catch (_) { /* the last minute is optional */ }
  if (isInstance(req)) {
    if (denyInstance(req, res)) return;
    rows = db.prepare(`
      SELECT host, feature, category, scope, SUM(count) AS count, SUM(bytes_in) AS bytes_in, SUM(bytes_out) AS bytes_out,
             SUM(errors) AS errors, MIN(first_seen) AS first_seen, MAX(last_seen) AS last_seen,
             COUNT(DISTINCT NULLIF(organization_id, '')) AS organizations, COUNT(DISTINCT day) AS days_seen
        FROM outbound_ledger WHERE day >= ? GROUP BY host, feature ORDER BY last_seen DESC LIMIT 2000`).all(since);
  } else {
    if (denyOrg(req, res)) return;
    rows = db.prepare(`
      SELECT host, feature, category, scope, SUM(count) AS count, SUM(bytes_in) AS bytes_in, SUM(bytes_out) AS bytes_out,
             SUM(errors) AS errors, MIN(first_seen) AS first_seen, MAX(last_seen) AS last_seen, COUNT(DISTINCT day) AS days_seen
        FROM outbound_ledger WHERE day >= ? AND organization_id = ? GROUP BY host, feature ORDER BY last_seen DESC LIMIT 2000`).all(since, req.organizationId);
  }
  res.json({ days, since, rows });
});

/* ───────────── the public /trust page toggle ───────────── */

router.get('/public', (req, res) => {
  if (denyInstance(req, res)) return;
  const r = report.build({ db });
  res.json({ enabled: appSettings.getBool(PUBLIC_SETTING, false), preview: report.publicView(r) });
});

router.put('/public', (req, res) => {
  if (denyInstance(req, res)) return;
  const enabled = !!(req.body && req.body.enabled === true);
  appSettings.setBool(PUBLIC_SETTING, enabled);
  auditFromReq(req, 'trust.public_page', { enabled });
  res.json({ enabled });
});

/* ───────────── exports ───────────── */

router.get('/exports', (req, res) => {
  const mine = db.prepare("SELECT * FROM data_exports WHERE kind = 'user' AND user_id = ? ORDER BY created_at DESC LIMIT 10").all(req.user.id);
  const org = req.organizationId && isOrgAdmin(req)
    ? db.prepare("SELECT * FROM data_exports WHERE kind = 'org' AND organization_id = ? ORDER BY created_at DESC LIMIT 10").all(req.organizationId)
    : [];
  res.json({
    personal: mine.map(exporter.publicJob),
    organization: org.map(exporter.publicJob),
    limits: { per_day: exporter.MAX_PER_DAY, link_minutes: exporter.LINK_TTL_MIN, kept_hours: exporter.TTL_HOURS },
  });
});

router.post('/exports', (req, res) => {
  const kind = req.body && req.body.kind;
  if (kind !== 'org' && kind !== 'user') return res.status(400).json({ error: 'kind must be "org" or "user"' });
  if (kind === 'org' && denyOrg(req, res)) return;
  // A break-glass or support session is a synthetic identity with no account row: it may look
  // around, it may not walk out with everything.
  if (['recovery', 'support'].includes(req.user.auth_provider) || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(req.user.id)) {
    return res.status(403).json({ error: 'Not available to this session' });
  }
  try {
    const id = exporter.request({ db, kind, orgId: kind === 'org' ? req.organizationId : null, userId: req.user.id });
    auditFromReq(req, kind === 'org' ? 'trust.export_org_requested' : 'trust.export_personal_requested', { export_id: id, organization_id: kind === 'org' ? req.organizationId : undefined });
    res.status(202).json(exporter.publicJob(db.prepare('SELECT * FROM data_exports WHERE id = ?').get(id)));
  } catch (e) {
    if (e instanceof exporter.ExportError) return res.status(e.status).json({ error: e.message, code: e.code });
    throw e;
  }
});

/** May this request's user download (or re-link) this export? Re-checked on every download. */
function mayAccess(job, userId, role) {
  if (!job) return false;
  const { isPlatformRole } = require('../middleware/auth');
  if (job.kind === 'user') return job.user_id === userId;
  if (isPlatformRole(role)) return true;
  const om = db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?').get(job.organization_id, userId);
  return !!om && (om.role === 'org_owner' || om.role === 'org_admin');
}

router.post('/exports/:id/link', (req, res) => {
  const job = db.prepare('SELECT * FROM data_exports WHERE id = ?').get(String(req.params.id));
  if (!job || !mayAccess(job, req.user.id, req.user.role)) return res.status(404).json({ error: 'Export not found' });
  try {
    const { key, expires_at } = exporter.link(db, job);
    res.json({ url: `/api/public/trust-export/${encodeURIComponent(job.id)}?key=${encodeURIComponent(key)}`, expires_at });
  } catch (e) {
    if (e instanceof exporter.ExportError) return res.status(e.status).json({ error: e.message, code: e.code });
    throw e;
  }
});

/* ───────────── delete everything ───────────── */

router.get('/org-deletion', (req, res) => {
  if (denyOrg(req, res)) return;
  const p = deletion.pending(db, req.organizationId);
  res.json({ scheduled: !!p, execute_after: p ? p.execute_after : null, requested_at: p ? p.requested_at : null, grace_days: deletion.GRACE_DAYS, can_delete: req.orgRole === 'org_owner' });
});

router.post('/org-deletion', (req, res) => {
  if (!req.organizationId) return res.status(400).json({ error: 'No organization' });
  // The owner, and only the owner: an org admin cannot end the organization, and neither can a
  // platform admin from here (they have Platform -> Organizations, which is immediate and audited).
  if (req.orgRole !== 'org_owner') return res.status(403).json({ error: 'Only an organization owner can delete it' });
  if (!req.body || req.body.understand !== true) return res.status(400).json({ error: 'Confirm that you understand this deletes everything.' });
  try {
    const r = deletion.schedule({ db, orgId: req.organizationId, userId: req.user.id, confirmName: req.body.confirm_name });
    auditFromReq(req, 'trust.org_deletion_scheduled', { organization_id: req.organizationId, execute_after: r.execute_after });
    res.status(202).json({ scheduled: true, ...r });
  } catch (e) {
    if (e instanceof deletion.DeletionError) return res.status(e.status).json({ error: e.message, code: e.code });
    throw e;
  }
});

router.delete('/org-deletion', (req, res) => {
  if (!req.organizationId) return res.status(400).json({ error: 'No organization' });
  if (req.orgRole !== 'org_owner' && !req.isPlatformAdmin) return res.status(403).json({ error: 'Only an organization owner can cancel this' });
  try {
    deletion.cancel({ db, orgId: req.organizationId });
    auditFromReq(req, 'trust.org_deletion_cancelled', { organization_id: req.organizationId });
    res.json({ scheduled: false });
  } catch (e) {
    if (e instanceof deletion.DeletionError) return res.status(e.status).json({ error: e.message, code: e.code });
    throw e;
  }
});

/* ───────────── public handlers (mounted in server.js) ───────────── */

/** GET /api/public/trust — the public facts, or 404 while the page is switched off. */
function publicJson(req, res) {
  if (!appSettings.getBool(PUBLIC_SETTING, false)) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'public, max-age=300');
  res.json(report.publicView(report.build({ db })));
}

/** GET /trust — the printable page, or 404 while it is switched off. */
function publicPage(sendFile) {
  return (req, res) => {
    if (!appSettings.getBool(PUBLIC_SETTING, false)) return res.status(404).send('Not found');
    sendFile(req, res);
  };
}

/** GET /api/public/trust-export/:id?key= — stream a ready export to the person who asked for it. */
function download(req, res) {
  const job = exporter.verifyKey(db, req.params.id, req.query.key);
  if (!job) return res.status(404).json({ error: 'This download link is not valid or has expired.' });
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(job.user_id);
  if (!user || !mayAccess(job, user.id, user.role)) return res.status(404).json({ error: 'This download link is not valid or has expired.' });
  const p = exporter.filePath(job);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'This download link is not valid or has expired.' });
  const date = new Date((job.finished_at || job.created_at) * 1000).toISOString().slice(0, 10);
  sendArchive(req, res, p, {
    name: `screentinker-${job.kind === 'org' ? 'organization' : 'personal'}-export-${date}.zip`,
    sha256: job.sha256,
    onFirstByte: () => {
      db.prepare('UPDATE data_exports SET downloads = downloads + 1 WHERE id = ?').run(job.id);
      audit(job.kind === 'org' ? 'trust.export_org_downloaded' : 'trust.export_personal_downloaded', {
        userId: job.user_id, ip: req.ip || null, details: { export_id: job.id, organization_id: job.organization_id || undefined },
      });
    },
  });
}

/*
 * Send an export archive, honouring one byte range.
 *
 * 3.0 (docs/move-server.md): another server pulling a large organization resumes an interrupted
 * transfer with `Range: bytes=N-` instead of starting again, and checks the whole file against
 * X-Export-SHA256 at the end. Only a single range is served (that is all a resume needs); anything
 * else is answered with the whole file, as a server without range support would. A download counts
 * (and is audited) once, when it starts from the first byte.
 */
function sendArchive(req, res, p, { name, sha256, onFirstByte }) {
  const size = fs.statSync(p).size;
  let start = 0, end = size - 1;
  const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || '').trim());
  if (m) {
    start = Number(m[1]);
    if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
    if (!Number.isSafeInteger(start) || start >= size || end < start) {
      res.set('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }
  }
  if (start === 0 && onFirstByte) onFirstByte();
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Type', 'application/zip');
  res.set('Accept-Ranges', 'bytes');
  if (sha256) res.set('X-Export-SHA256', sha256);
  res.set('Content-Disposition', `attachment; filename="${name}"`);
  res.set('Content-Length', String(end - start + 1));
  if (m) {
    res.status(206);
    res.set('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  fs.createReadStream(p, { start, end }).pipe(res);
}

module.exports = router;
module.exports.publicJson = publicJson;
module.exports.publicPage = publicPage;
module.exports.download = download;
module.exports.sendArchive = sendArchive;
module.exports.mayAccess = mayAccess;
module.exports.PUBLIC_SETTING = PUBLIC_SETTING;
