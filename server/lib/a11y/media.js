'use strict';

/*
 * The expensive half of the accessibility checks: reading media files. Two kinds of result, both
 * cached per content revision in `a11y_media_checks`:
 *
 *   video  — videos and animated GIFs: audio track present?, embedded subtitles?, and the WCAG 2.3.1
 *            flash counts (lib/a11y/flash.js), from a worker thread driving ffmpeg
 *            (lib/a11y/media-worker.js).
 *   grid   — photos used behind slide text: a small luminance grid (image-ops luminanceGrid on the
 *            shared image worker), so text over the photo can be checked.
 *
 * ⚠️ NOTHING HERE EVER WAITS FOR A RESULT ON A REQUEST. A report or a publish check asks for what
 * is cached; anything missing is queued and reported as "still being checked". A one-hour video
 * must not hold a dashboard request open, and a publish must not be slower because a check is due.
 *
 * ⚠️ BOUNDED. One video job at a time (ffmpeg decoding is the most expensive thing this server
 * does besides transcoding, and it competes with the event loop for the CPU), a capped queue, at most
 * MAX_SECONDS of any video analysed, and a hard per-job timeout that terminates the worker thread
 * (its ffmpeg dies with the pipe). Photos go through the image worker only when it is idle.
 *
 * ⚠️ ONLY LOCAL BYTES. A remote URL is never fetched for a check: that would be the server making
 * requests on an operator's behalf to an address the operator typed, for a report. Content stored in
 * an external bucket and not present locally is "could not check", said plainly.
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');

const FPS = 30;
const MAX_SECONDS = 600;
const JOB_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_QUEUE = 200;
const GRID_MAX_BYTES = 25 * 1024 * 1024;
const WORKER_PATH = path.join(__dirname, 'media-worker.js');

let dbRef = null;
function db() { return dbRef || (dbRef = require('../../db/database').db); }
/** Tests: run against another handle. */
function _setDb(d) { dbRef = d; }

const isAnimated = (c) => /^video\//i.test(c.mime_type || '') || /^image\/gif$/i.test(c.mime_type || '');

/** The file on this server's disk for a content row, or null (remote, missing, outside contentDir). */
function localFile(c) {
  if (!c || c.remote_url || !c.filepath) return null;
  const base = path.resolve(config.contentDir);
  const p = path.resolve(base, path.basename(String(c.filepath)));
  if (!p.startsWith(base + path.sep)) return null;
  try { return fs.statSync(p).isFile() ? p : null; } catch { return null; }
}

function rowFor(contentId, kind) {
  return db().prepare('SELECT * FROM a11y_media_checks WHERE content_id = ? AND kind = ?').get(contentId, kind);
}

function save(c, kind, status, result, error) {
  db().prepare(`INSERT INTO a11y_media_checks (content_id, kind, rev, workspace_id, status, result, error, checked_at)
                VALUES (?,?,?,?,?,?,?,strftime('%s','now'))
                ON CONFLICT(content_id, kind) DO UPDATE SET rev = excluded.rev, workspace_id = excluded.workspace_id,
                  status = excluded.status, result = excluded.result, error = excluded.error, checked_at = excluded.checked_at`)
    .run(c.id, kind, Number(c.updated_at) || 0, c.workspace_id || null, status, result == null ? null : JSON.stringify(result), error || null);
}

/* ---------------------------------------------------------------- the video worker */

let worker = null;
let inFlight = null;     // { id, content, resolve }
let jobTimer = null;
let nextId = 1;
const queue = [];        // content rows
const queuedKeys = new Set();

function key(c) { return `${c.id}:${Number(c.updated_at) || 0}`; }

function ensureWorker() {
  if (worker) return worker;
  const { Worker } = require('worker_threads');
  const w = new Worker(WORKER_PATH, { resourceLimits: { maxOldGenerationSizeMb: 256 } });
  worker = w;
  w.on('message', (msg) => {
    if (worker !== w || !inFlight || inFlight.id !== msg.id) return;
    finishJob(msg.ok ? { ok: true, result: msg.result } : { ok: false, error: msg.error });
  });
  const dead = (why) => { if (worker !== w) return; worker = null; if (inFlight) finishJob({ ok: false, error: why }); };
  w.on('error', (e) => dead(`media worker failed: ${e.message}`));
  w.on('exit', (code) => dead(`media worker exited (${code})`));
  w.unref();
  return w;
}

// Release the thread when quiet; the next check starts a fresh one.
let idleTimer = null;
function scheduleIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (worker && !inFlight && !queue.length) { const w = worker; worker = null; w.terminate().catch(() => {}); }
  }, 60000);
  idleTimer.unref?.();
}

function finishJob(out) {
  if (jobTimer) { clearTimeout(jobTimer); jobTimer = null; }
  const job = inFlight;
  inFlight = null;
  if (!job) return;
  queuedKeys.delete(key(job.content));
  try {
    // Only record the result if the row still describes the same bytes: a replace while the job
    // ran would otherwise stamp the OLD file's verdict on the new revision.
    const now = db().prepare('SELECT id, updated_at, workspace_id FROM content WHERE id = ?').get(job.content.id);
    if (now && (Number(now.updated_at) || 0) === (Number(job.content.updated_at) || 0)) {
      if (out.ok) save(job.content, 'video', 'done', out.result, null);
      else save(job.content, 'video', 'failed', null, String(out.error || 'failed').slice(0, 300));
      require('./index').invalidate(now.workspace_id);
    }
  } catch (e) { console.warn('[a11y] could not store a media check:', e.message); }
  job.resolve(out);
  pump();
  if (!inFlight) scheduleIdle();
}

function pump() {
  if (inFlight || !queue.length) return;
  const c = queue.shift();
  const file = localFile(c);
  if (!file) {
    queuedKeys.delete(key(c));
    try { save(c, 'video', 'failed', null, 'not_local'); } catch { /* table missing in an odd test db */ }
    setImmediate(pump);
    return;
  }
  let w;
  try { w = ensureWorker(); } catch (e) {
    queuedKeys.delete(key(c));
    console.warn('[a11y] no worker thread for media checks:', e.message);
    return;
  }
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  inFlight = { id: nextId++, content: c, resolve, done };
  // ⚠️ NEVER ref'd, unlike the image worker: a check is best-effort and recomputed on the next
  // report, so it must not hold a CLI or a test process open, and a server is held open anyway.
  jobTimer = setTimeout(() => {
    jobTimer = null;
    const dying = worker;
    worker = null;   // detach first so its exit event does not double-finish
    if (dying) dying.terminate().catch(() => {});
    finishJob({ ok: false, error: 'timed out' });
  }, JOB_TIMEOUT_MS + 10000);
  jobTimer.unref?.();
  w.postMessage({ id: inFlight.id, op: 'video', path: file, fps: FPS, maxSec: MAX_SECONDS, timeoutMs: JOB_TIMEOUT_MS });
  // ⚠️ Again AFTER listeners and a post: attaching a 'message' listener re-refs the worker's port,
  // and a process that should exit then waits forever on it (found as two test files that hung).
  w.unref();
}

/** Queue a video/GIF check unless one for this revision is cached or already queued. */
function queueVideo(c) {
  if (!c || !isAnimated(c)) return false;
  const k = key(c);
  if (queuedKeys.has(k) || queue.length >= MAX_QUEUE) return false;
  const row = rowFor(c.id, 'video');
  if (row && Number(row.rev) === (Number(c.updated_at) || 0)) return false;
  queuedKeys.add(k);
  queue.push({ id: c.id, workspace_id: c.workspace_id, updated_at: c.updated_at, filepath: c.filepath, remote_url: c.remote_url, mime_type: c.mime_type });
  pump();
  return true;
}

/**
 * What is known about a video/GIF right now.
 * @returns {{ state: 'done', result } | { state: 'failed', error } | { state: 'pending' } | { state: 'remote' }}
 */
function videoState(c, { enqueue = true } = {}) {
  if (c.remote_url || !c.filepath) return { state: 'remote' };
  const row = rowFor(c.id, 'video');
  if (row && Number(row.rev) === (Number(c.updated_at) || 0)) {
    if (row.status === 'done') { try { return { state: 'done', result: JSON.parse(row.result) }; } catch { /* fall through */ } }
    return { state: 'failed', error: row.error || 'failed' };
  }
  if (enqueue) queueVideo(c);
  return { state: 'pending' };
}

/** Wait for the queue to drain (tests, and the CLI-ish callers that want an answer). */
async function drain(timeoutMs = 120000) {
  const until = Date.now() + timeoutMs;
  while ((inFlight || queue.length) && Date.now() < until) {
    if (inFlight) await Promise.race([inFlight.done, new Promise((r) => setTimeout(r, 200))]);
    else await new Promise((r) => setTimeout(r, 20));
  }
}

async function shutdown() {
  queue.length = 0;
  queuedKeys.clear();
  const w = worker;
  worker = null;
  if (jobTimer) { clearTimeout(jobTimer); jobTimer = null; }
  if (inFlight) { const j = inFlight; inFlight = null; j.resolve({ ok: false, error: 'shutdown' }); }
  if (w) await w.terminate();
}

/* ---------------------------------------------------------------- photo grids */

const gridsInFlight = new Set();

/**
 * The luminance grid of a photo behind slide text, if known. Queues the work when the image worker
 * is idle; otherwise reports 'pending' and tries again on the next check.
 * @returns {{ grid } | { unknown: 'pending'|'image' }}
 */
function gridState(c) {
  if (!c || !/^image\//i.test(c.mime_type || '') || /gif$/i.test(c.mime_type || '')) return { unknown: 'image' };
  const row = rowFor(c.id, 'grid');
  if (row && Number(row.rev) === (Number(c.updated_at) || 0)) {
    if (row.status === 'done') { try { return { grid: JSON.parse(row.result) }; } catch { /* recompute */ } }
    return { unknown: 'image' };
  }
  const file = localFile(c);
  if (!file) return { unknown: 'image' };
  if (Number(c.file_size) > GRID_MAX_BYTES) return { unknown: 'image' };
  const k = key(c);
  if (!gridsInFlight.has(k)) {
    const imageOps = require('../image-ops');
    if (imageOps.pending() < 2) {
      gridsInFlight.add(k);
      const snap = { id: c.id, workspace_id: c.workspace_id, updated_at: c.updated_at };
      imageOps.luminanceGrid(file).then((g) => {
        save(snap, 'grid', 'done', { w: g.w, h: g.h, lum: g.lum }, null);
      }).catch((e) => {
        try { save(snap, 'grid', 'failed', null, String(e && e.message || e).slice(0, 300)); } catch { /* ignore */ }
      }).finally(() => {
        gridsInFlight.delete(k);
        try { require('./index').invalidate(snap.workspace_id); } catch { /* ignore */ }
      });
    }
  }
  return { unknown: 'pending' };
}

function stats() {
  return { queued: queue.length, running: inFlight ? 1 : 0, grids: gridsInFlight.size };
}

module.exports = {
  FPS, MAX_SECONDS, isAnimated, localFile, queueVideo, videoState, gridState, drain, shutdown, stats, _setDb,
};
