'use strict';

/*
 * "Switch to ScreenTinker": import another signage CMS's media, playlists, layouts, schedules and
 * screens into a workspace (docs/migrate.md, routes/migrate.js).
 *
 *   connect  createJob()   the person picks a vendor and gives a key / server address, or uploads the
 *                          vendor's export (or a zip of media + CSV). A job row is written and the
 *                          SCAN runs in the background: the adapter lists everything it can read.
 *   scan     -> 'scanned'  job.scan holds counts, the catalog, and what cannot be mapped and why.
 *   run      startRun()    the person chooses what to bring over and where; the RUN runs in the
 *                          background (lib/migrate/apply.js) with progress on the row.
 *   finish   -> 'done' | 'stopped' (storage allowance) | 'failed' | 'cancelled' | 'interrupted'
 *
 * ⚠️ THE SOURCE CREDENTIAL. Kept in this process's memory for the job, and — so a restart or a
 * storage stop can be resumed without asking again — encrypted (lib/secretbox) on the job row with
 * a hard expiry (CRED_TTL_SEC). It is deleted from both the moment the job is done, failed or
 * cancelled, when it expires, and when the workspace goes. It is never returned by any route,
 * never written to a log, an audit line or the report. An uploaded export file follows the same
 * rule (UPLOAD_TTL_SEC).
 *
 * ⚠️ ONE JOB AT A TIME PER WORKSPACE, MAX_RUNNING ON THE INSTANCE. A job that would exceed either
 * waits in 'queued'. A restart never resumes a run by itself: jobs that were running come back as
 * 'interrupted', and the person presses Resume (re-running is safe: lib/migrate/apply.js is
 * idempotent by source id).
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../../db/database');
const config = require('../../config');
const secretbox = require('../secretbox');
const { audit } = require('../audit');
const vendors = require('./vendors');
const { applyCatalog, StopImport } = require('./apply');

const CRED_TTL_SEC = 3 * 60 * 60;
const UPLOAD_TTL_SEC = 24 * 60 * 60;
const MAX_RUNNING = 2;
const ACTIVE = ['scanning', 'queued', 'running'];
const TERMINAL = ['done', 'failed', 'cancelled'];

const memCreds = new Map();     // jobId -> credential object (never persisted in the clear)
const running = new Map();      // jobId -> { stop: boolean }
const queue = [];               // jobIds waiting for a run slot

function uploadDir() { return path.join(config.dataDir, 'migrate-uploads'); }
function nowSec() { return Math.floor(Date.now() / 1000); }

function get(id) { return db.prepare('SELECT * FROM migration_jobs WHERE id = ?').get(String(id)) || null; }
function getIn(workspaceId, id) {
  return db.prepare('SELECT * FROM migration_jobs WHERE id = ? AND workspace_id = ?').get(String(id), workspaceId) || null;
}

function save(id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE migration_jobs SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => (fields[k] !== null && typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k])), nowSec(), id);
}

/* ------------------------------------------------------------------ credentials */

function holdCredential(jobId, cred) {
  memCreds.set(jobId, cred);
  save(jobId, { cred_enc: secretbox.encrypt(JSON.stringify(cred)), cred_expires_at: nowSec() + CRED_TTL_SEC });
}

function credentialFor(job) {
  if (memCreds.has(job.id)) return memCreds.get(job.id);
  if (!job.cred_enc || !job.cred_expires_at || job.cred_expires_at < nowSec()) return null;
  try { const c = JSON.parse(secretbox.decrypt(job.cred_enc) || 'null'); if (c) memCreds.set(job.id, c); return c; }
  catch { return null; }
}

/** Delete the credential and any uploaded file. Safe to call more than once. */
function forget(jobId) {
  memCreds.delete(jobId);
  const job = get(jobId);
  if (!job) return;
  if (job.upload_path) removeUpload(job.upload_path);
  db.prepare('UPDATE migration_jobs SET cred_enc = NULL, cred_expires_at = NULL, upload_path = NULL WHERE id = ?').run(jobId);
  // A finished job keeps its summary and report, not the catalog: that held the source's file
  // addresses (some vendors hand out signed URLs), which nothing needs once the job is over.
  if (TERMINAL.includes(job.status) && job.scan) {
    try {
      const sc = JSON.parse(job.scan);
      if (sc && sc.catalog) { delete sc.catalog; db.prepare('UPDATE migration_jobs SET scan = ? WHERE id = ?').run(JSON.stringify(sc), jobId); }
    } catch { /* leave it */ }
  }
}

function removeUpload(p) {
  const { resolveWithin } = require('../safe-path');
  const abs = resolveWithin(uploadDir(), path.basename(String(p)));
  if (abs) { try { fs.rmSync(abs, { force: true }); } catch { /* gone */ } }
}

/** Expired credentials and uploads go, jobs left running by a dead process become 'interrupted'. */
function sweep() {
  const t = nowSec();
  for (const j of db.prepare(`SELECT id FROM migration_jobs WHERE (cred_enc IS NOT NULL AND cred_expires_at < ?)
      OR (upload_path IS NOT NULL AND updated_at < ?) OR (status IN ('done','failed','cancelled') AND (cred_enc IS NOT NULL OR upload_path IS NOT NULL))`)
    .all(t, t - UPLOAD_TTL_SEC)) {
    if (!running.has(j.id)) forget(j.id);
  }
  // Uploads with no job pointing at them (a crash between write and insert).
  try {
    const dir = uploadDir();
    const known = new Set(db.prepare('SELECT upload_path FROM migration_jobs WHERE upload_path IS NOT NULL').all().map((r) => path.basename(r.upload_path)));
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const abs = path.join(dir, f);
      const st = fs.statSync(abs);
      if (!known.has(f) && Date.now() - st.mtimeMs > 60 * 60 * 1000) fs.rmSync(abs, { force: true });
    }
  } catch { /* best effort */ }
}

let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  try {
    db.prepare(`UPDATE migration_jobs SET status = 'interrupted', error = 'The server restarted during the import. Resume to carry on.'
      WHERE status IN ('running','queued')`).run();
    db.prepare(`UPDATE migration_jobs SET status = 'failed', error = 'The server restarted during the scan. Start again.' WHERE status = 'scanning'`).run();
    sweep();
    const t = setInterval(() => { try { sweep(); } catch { /* next time */ } }, 10 * 60 * 1000);
    t.unref?.();
  } catch (e) { console.warn('[migrate] boot sweep failed:', e && e.name); }
}

/* ------------------------------------------------------------------ public shape */

/** A job as a route returns it: never the credential, never the upload path. */
function view(job) {
  if (!job) return null;
  const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
  const scan = parse(job.scan, null);
  return {
    id: job.id,
    vendor: job.vendor,
    vendor_name: (vendors.get(job.vendor) || {}).name || job.vendor,
    source_label: job.source_label || '',
    status: job.status,
    summary: scan ? scan.summary : null,
    unmapped: scan ? scan.unmapped || [] : [],
    options: parse(job.options, null),
    progress: parse(job.progress, null),
    report: parse(job.report, null),
    error: job.error || null,
    can_resume: ['stopped', 'interrupted', 'failed'].includes(job.status) && !!scan && (!!credentialFor(job) || vendors.get(job.vendor)?.mode === 'none'),
    needs_credentials: ['stopped', 'interrupted', 'failed'].includes(job.status) && !!scan && !credentialFor(job),
    created_at: job.created_at,
    updated_at: job.updated_at,
    finished_at: job.finished_at,
  };
}

function list(workspaceId, limit = 20) {
  return db.prepare('SELECT * FROM migration_jobs WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(workspaceId, limit).map(view);
}

function activeIn(workspaceId) {
  return db.prepare(`SELECT id FROM migration_jobs WHERE workspace_id = ? AND status IN (${ACTIVE.map(() => '?').join(',')}) LIMIT 1`)
    .get(workspaceId, ...ACTIVE) || null;
}

/* ------------------------------------------------------------------ connect + scan */

class MigrateError extends Error {
  constructor(message, status = 400, code = 'bad_request') { super(message); this.name = 'MigrateError'; this.status = status; this.code = code; }
}

/**
 * Validate the connect form for a vendor and start the scan. `cred` is the vendor's fields (for a
 * file vendor, `{ upload_path }` of a file already written into uploadDir()).
 * Resolves the job view. Throws MigrateError for anything the person can fix.
 */
async function createJob({ workspaceId, userId, vendor, cred, uploadName = null }) {
  boot();
  const adapter = vendors.get(vendor);
  if (!adapter) throw new MigrateError('Unknown source system.');
  if (activeIn(workspaceId)) throw new MigrateError('An import is already running in this workspace. Wait for it to finish or cancel it.', 409, 'busy');
  const checked = adapter.checkCredentials(cred || {});   // throws MigrateError-ish { userMessage }
  const id = uuidv4();
  db.prepare(`INSERT INTO migration_jobs (id, workspace_id, user_id, vendor, source_label, status, upload_path)
    VALUES (?, ?, ?, ?, ?, 'scanning', ?)`)
    .run(id, workspaceId, userId || null, vendor, String(checked.label || uploadName || '').slice(0, 200), checked.upload_path ? path.basename(checked.upload_path) : null);
  holdCredential(id, checked.cred);
  audit('migration_connect', { userId, workspaceId, details: { job_id: id, vendor } });
  // The scan runs in the background; the client polls GET /jobs/:id.
  setImmediate(() => { scan(id).catch(() => { /* recorded on the row */ }); });
  return view(get(id));
}

async function scan(id) {
  const job = get(id);
  if (!job) return;
  const adapter = vendors.get(job.vendor);
  let session = null;
  try {
    session = await adapter.open(credentialFor(job), { uploadDir: uploadDir(), job });
    const catalog = await session.scan();
    // Cancelled while the vendor was being read: the cancel already settled the row.
    if ((get(id) || {}).status !== 'scanning') return;
    const summary = {
      media: (catalog.media || []).length,
      playlists: (catalog.playlists || []).length,
      layouts: (catalog.layouts || []).length,
      schedules: (catalog.schedules || []).length,
      screens: (catalog.screens || []).length,
      groups: (catalog.groups || []).length,
      bytes: (catalog.media || []).reduce((a, m) => a + (Number(m.size) || 0), 0),
    };
    save(id, {
      status: 'scanned',
      source_account: String(catalog.account || job.source_label || '').slice(0, 300),
      source_label: String(catalog.label || job.source_label || '').slice(0, 200),
      scan: { summary, unmapped: (catalog.unmapped || []).slice(0, 500), catalog },
      error: null,
    });
  } catch (e) {
    if ((get(id) || {}).status !== 'scanning') return;
    save(id, { status: 'failed', error: safeMessage(e), finished_at: nowSec() });
    forget(id);
  } finally {
    if (session && session.close) { try { await session.close(); } catch { /* best effort */ } }
  }
}

function safeMessage(e) {
  if (e && (e.name === 'MigrateHttpError' || e.name === 'MigrateError' || e.userMessage)) return String(e.userMessage || e.message).slice(0, 300);
  console.warn(`[migrate] unexpected failure (${(e && e.name) || 'error'})`);
  return 'The import failed unexpectedly. Try again; anything already imported is kept and will not be duplicated.';
}

/* ------------------------------------------------------------------ run */

/** Start (or resume) the import of a scanned job with the chosen options. */
function startRun({ workspaceId, id, options, userId, cred = null }) {
  boot();
  const job = getIn(workspaceId, id);
  if (!job) throw new MigrateError('Import not found.', 404, 'not_found');
  if (!['scanned', 'stopped', 'interrupted', 'failed'].includes(job.status) || !job.scan) {
    throw new MigrateError(job.status === 'done' ? 'This import is finished. Start a new one to import again (nothing is duplicated).' : 'This import cannot be started now.', 409, 'bad_state');
  }
  const busy = activeIn(workspaceId);
  if (busy && busy.id !== id) throw new MigrateError('Another import is running in this workspace.', 409, 'busy');
  const adapter = vendors.get(job.vendor);
  // A file source's "credential" names an upload on disk: it only ever comes from the upload route,
  // never from a request body, or one workspace could point a resume at another's upload.
  if (cred && adapter.mode === 'api') {
    const checked = adapter.checkCredentials(cred);
    holdCredential(id, checked.cred);
  }
  if (!credentialFor(get(id))) {
    throw new MigrateError(adapter.mode === 'file' ? 'The uploaded file has expired. Upload it again.' : 'Enter the key again to resume (it is only kept for a few hours).', 409, 'needs_credentials');
  }
  const prev = (() => { try { return JSON.parse(job.options || 'null'); } catch { return null; } })();
  const opts = sanitizeOptions(options || prev || {}, workspaceId);
  save(id, { status: 'queued', options: opts, error: null, user_id: userId || job.user_id });
  audit('migration_run', { userId, workspaceId, details: { job_id: id, vendor: job.vendor, resume: job.status !== 'scanned' } });
  queue.push(id);
  pump();
  return view(get(id));
}

function sanitizeOptions(o, workspaceId) {
  const out = {};
  for (const k of ['media', 'playlists', 'layouts', 'schedules', 'screens', 'publish']) out[k] = o[k] !== false;
  if (o.folder_id === 'root') out.folder_id = 'root';
  else if (o.folder_id) {
    const f = db.prepare('SELECT id FROM content_folders WHERE id = ? AND workspace_id = ?').get(String(o.folder_id), workspaceId);
    if (!f) throw new MigrateError('That folder is not in this workspace.');
    out.folder_id = f.id;
  }
  if (o.folder_name) out.folder_name = String(o.folder_name).slice(0, 100);
  return out;
}

function pump() {
  while (running.size < MAX_RUNNING && queue.length) {
    const id = queue.shift();
    const job = get(id);
    if (!job || job.status !== 'queued') continue;
    const flag = { stop: false };
    running.set(id, flag);
    runJob(id, flag).finally(() => { running.delete(id); pump(); });
  }
}

async function runJob(id, flag) {
  const job = get(id);
  const adapter = vendors.get(job.vendor);
  let session = null;
  let progress = { phase: 'connecting', done: 0, total: 0, failed: 0 };
  save(id, { status: 'running', progress });
  let lastWrite = 0;
  try {
    session = await adapter.open(credentialFor(job), { uploadDir: uploadDir(), job });
    const scanData = JSON.parse(job.scan);
    const report = await applyCatalog({
      job: get(id),
      catalog: { ...scanData.catalog, vendorName: adapter.name },
      session,
      options: JSON.parse(job.options || '{}'),
      userId: job.user_id,
      shouldStop: () => flag.stop,
      onProgress: (p) => {
        progress = p;
        // Every item would be one write per file; a few a second is plenty for a progress bar.
        if (Date.now() - lastWrite > 400) { lastWrite = Date.now(); save(id, { progress }); }
      },
    });
    report.unmapped = (scanData.unmapped || []).length;
    save(id, { status: 'done', progress: { ...progress, phase: 'done' }, report, finished_at: nowSec() });
    forget(id);
    audit('migration_done', { userId: job.user_id, workspaceId: job.workspace_id, details: { job_id: id, vendor: job.vendor, created: report.created, failed: report.failed.length } });
  } catch (e) {
    if (e instanceof StopImport && e.reason === 'cancelled') {
      save(id, { status: 'cancelled', progress, report: e.report || null, finished_at: nowSec() });
      forget(id);
    } else if (e instanceof StopImport) {
      // Storage: keep the credential (until it expires) so freeing space and pressing Resume works.
      save(id, { status: 'stopped', progress, report: e.report || null, error: 'The storage allowance ran out. Free some space or raise the limit, then resume.' });
    } else {
      save(id, { status: 'failed', progress, error: safeMessage(e), finished_at: nowSec() });
    }
  } finally {
    if (session && session.close) { try { await session.close(); } catch { /* best effort */ } }
  }
}

/** Cancel a scan, a queued job or a running one (it stops between items). */
function cancel(workspaceId, id) {
  const job = getIn(workspaceId, id);
  if (!job) throw new MigrateError('Import not found.', 404, 'not_found');
  const flag = running.get(id);
  if (flag) { flag.stop = true; return view(job); }
  const qi = queue.indexOf(id);
  if (qi >= 0) queue.splice(qi, 1);
  if (!TERMINAL.includes(job.status)) save(id, { status: 'cancelled', finished_at: nowSec() });
  forget(id);
  return view(get(id));
}

/** Wait for a job to settle (tests). */
async function _settle(id, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const j = get(id);
    if (j && !ACTIVE.includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 15));
  }
  return get(id);
}

function _reset() { memCreds.clear(); queue.length = 0; }

module.exports = {
  createJob, startRun, cancel, list, view, get, getIn, sweep, boot, uploadDir, forget, credentialFor,
  MigrateError, CRED_TTL_SEC, UPLOAD_TTL_SEC,
  _settle, _reset, _memCreds: memCreds,
};
