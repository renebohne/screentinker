'use strict';

/*
 * Image operations, off the main thread.
 *
 * WHY THIS EXISTS: image-ops-core is pure JavaScript, so unlike the native sharp it replaced —
 * which handed work to a libvips threadpool — its CPU cost lands on whatever thread calls it. A
 * 12MP photo measures at ~1.0s of solid, uninterruptible main-thread work. That is not a slow
 * upload, it is a stalled event loop: no heartbeats, no socket traffic, nothing. lib/thumbnail-
 * backfill.js walks an entire content library at boot, so in-process it reproduces #240 exactly
 * (blocked loop -> missed heartbeats -> panels marked offline -> reconnect churn), arriving from
 * our own maintenance. The same reasoning already moved this file's video branch from
 * execFileSync to execFile; this is that fix for the image branch.
 *
 * The work is therefore hosted on a worker thread and this module is the only entry point.
 *
 * ONE JOB AT A TIME, deliberately. Decoding holds a full RGBA bitmap — a 12MP photo is ~48MB — so
 * letting jobs overlap multiplies peak memory by the queue depth, which is exactly the wrong
 * failure on the small targets this whole change is meant to reach. Serialized, the ceiling is one
 * image regardless of how many uploads land at once. It also costs nothing in throughput: the work
 * is CPU-bound, and a single busy worker already saturates the core it runs on.
 *
 * The worker is unref'd while idle so it never holds the process open — scripts/backfill-rotation-
 * dims.js is a CLI that must exit, and `node --test` would otherwise hang forever — and ref'd only
 * while a job is in flight, so an in-progress thumbnail cannot be cut short by the process exiting.
 */

const path = require('path');

const WORKER_PATH = path.join(__dirname, 'image-ops-worker.js');
const IDLE_SHUTDOWN_MS = 60_000;   // release the decoder heap (jimp + the WASM codecs) when quiet

let worker = null;
let idleTimer = null;
let inFlight = null;               // { id, resolve, reject } — at most one, by design
let inlineOnly = false;            // set if a worker cannot be created at all; see runInline
let nextId = 1;
const queue = [];

function clearIdleTimer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function scheduleIdleShutdown() {
  clearIdleTimer();
  if (!worker || inFlight || queue.length) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (worker && !inFlight && !queue.length) { const w = worker; worker = null; w.terminate(); }
  }, IDLE_SHUTDOWN_MS);
  idleTimer.unref?.();
}

// Reject everything outstanding. Called when the worker dies underneath us — a crash means OOM or
// a bug, not a bad image (image-ops-worker catches decode failures and replies normally), so there
// is nothing to usefully retry and callers already treat a rejection as "no metadata".
function failAll(reason) {
  const dead = [inFlight, ...queue].filter(Boolean);
  inFlight = null;
  queue.length = 0;
  for (const job of dead) job.reject(new Error(reason));
}

/*
 * ⚠️ BOUNDED, BECAUSE THE INPUT IS AN UPLOAD. A hostile image (a decompression bomb the header
 * check cannot see, a pathological codec input) used to be able to grow this worker without limit
 * or spin it forever, and with ONE job at a time a spinning worker stalls every thumbnail after it.
 * resourceLimits caps the JS heap (the worker dies with ERR_WORKER_OUT_OF_MEMORY rather than the
 * process), and a per-job timeout terminates the worker, rejects that one job, and lets pump()
 * start a fresh worker for the rest. A 12 MP photo is ~1 s; the timeout is far beyond any real one.
 */
const WORKER_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 64 };
let jobTimeoutMs = 60_000;
let jobTimer = null;
function clearJobTimer() {
  if (jobTimer) { clearTimeout(jobTimer); jobTimer = null; }
}

function ensureWorker() {
  if (worker) return worker;
  const { Worker } = require('worker_threads');
  const w = new Worker(WORKER_PATH, { resourceLimits: WORKER_RESOURCE_LIMITS });
  worker = w;
  w.unref();
  // Every handler checks it is still the CURRENT worker: a timed-out generation's late events
  // must not fail the jobs of the worker that replaced it.
  w.on('message', (msg) => {
    if (worker !== w) return;
    const job = inFlight;
    if (!job || job.id !== msg.id) return;   // a reply from a terminated generation; ignore
    clearJobTimer();
    inFlight = null;
    if (msg.ok) job.resolve(msg.result); else job.reject(new Error(msg.error));
    pump();
  });
  w.on('error', (err) => {
    if (worker !== w) return;
    clearJobTimer();
    worker = null;
    failAll(`image worker failed: ${err.message}`);
  });
  w.on('exit', (code) => {
    if (worker !== w) return;
    clearJobTimer();
    worker = null;
    if (inFlight || queue.length) failAll(`image worker exited (code ${code})`);
  });
  return w;
}

function onJobTimeout() {
  jobTimer = null;
  const job = inFlight;
  if (!job) return;
  inFlight = null;
  const w = worker;
  worker = null;                       // detach first: its exit must not touch the queue
  if (w) w.terminate().catch(() => {});
  job.reject(Object.assign(new Error(`image job timed out after ${jobTimeoutMs}ms`), { code: 'IMAGE_TIMEOUT' }));
  pump();                              // the next job gets a fresh worker
}

function pump() {
  if (inFlight) return;
  if (!queue.length) { worker?.unref(); scheduleIdleShutdown(); return; }
  clearIdleTimer();
  inFlight = queue.shift();
  const w = ensureWorker();
  w.ref();   // a job is running: hold the process open until it finishes
  clearJobTimer();
  jobTimer = setTimeout(onJobTimeout, jobTimeoutMs);
  jobTimer.unref?.();
  w.postMessage(inFlight.job);
}

// Last resort: if worker_threads cannot give us a thread at all, do the work in-process rather
// than refuse to thumbnail. Stalls the loop — that is the bug this module exists to avoid — so it
// is announced rather than silent.
async function runInline(job) {
  const core = require('./image-ops-core');
  if (job.op === 'metadata') return core.metadata(job.src);
  if (job.op === 'cutout') return core.cutout(job.src, job.dest, job.opts);
  if (job.op === 'frameMetrics') return core.frameMetrics(job.src);
  if (job.op === 'luminanceGrid') return core.luminanceGrid(job.src, job.cols);
  if (job.op === 'measureAndThumbnail') return core.measureAndThumbnail(job.src, job.dest, job.width, job.quality);
  return core.writeThumbnail(job.src, job.dest, job.width, job.quality);
}

function submit(job) {
  if (inlineOnly) return runInline(job);
  job.id = nextId++;
  return new Promise((resolve, reject) => {
    try {
      ensureWorker();
    } catch (err) {
      inlineOnly = true;
      console.warn(`[image-ops] no worker thread (${err.message}) — decoding in-process, which blocks the event loop`);
      return resolve(runInline(job));
    }
    queue.push({ id: job.id, job, resolve, reject });
    pump();
  });
}

/* Display dimensions, shaped like the sharp metadata callers destructure. See image-ops-core. */
function metadata(src) {
  return submit({ op: 'metadata', src });
}

/* Write a JPEG thumbnail `width` px wide, aspect preserved. Rotation is implicit in the decode. */
function writeThumbnail(src, dest, width, quality = 70) {
  return submit({ op: 'writeThumbnail', src, dest, width, quality });
}

/*
 * Both of the above from ONE decode -> { width, height, orientation, thumbnailWritten,
 * thumbnailError }. Prefer this wherever both are wanted: a decode here is the full ~1s of a 12MP
 * photo, not sharp's cheap header parse, so the pair costs double. See image-ops-core.
 */
function measureAndThumbnail(src, dest, width, quality = 70) {
  return submit({ op: 'measureAndThumbnail', src, dest, width, quality });
}

/* Drop the worker now rather than waiting out the idle timer. For shutdown paths and tests. */
async function shutdown() {
  clearIdleTimer();
  clearJobTimer();
  const w = worker;
  worker = null;
  if (w) await w.terminate();
  // The exit handler ignores a detached worker, so fail what was outstanding here (as it used to).
  if (inFlight || queue.length) failAll('image worker exited (shutdown)');
}

/* Tests only: shorten the per-job timeout. Returns the previous value. */
function _setJobTimeoutMs(ms) { const prev = jobTimeoutMs; jobTimeoutMs = ms; return prev; }

/*
 * Key a flat backdrop out of `src` and write the trimmed result to `destPath` as a PNG with alpha.
 * See image-ops-core.cutout for why this belongs off the main thread.
 */
function cutout(src, dest, opts) {
  return submit({ op: 'cutout', src, dest, opts: opts || {} });
}

/*
 * Screen verification metrics for one frame (lib/screen-verify/frame-metrics.js). `src` is a path
 * or a Buffer of image bytes. Shares the one-job-at-a-time queue: a capture is small next to an
 * upload, and the caller (lib/screen-verify) bounds how many it ever has waiting here.
 */
function frameMetrics(src) {
  return submit({ op: 'frameMetrics', src });
}

/*
 * 3.0 accessibility: a photo's luminance as a small grid (image-ops-core.luminanceGrid), so text laid
 * over it can be checked. Best-effort callers check pending() first: this shares the one queue.
 */
function luminanceGrid(src, cols = 64) {
  return submit({ op: 'luminanceGrid', src, cols });
}

/* How many jobs are queued or running, so a best-effort caller can back off instead of piling on. */
function pending() {
  return queue.length + (inFlight ? 1 : 0);
}

module.exports = { metadata, writeThumbnail, measureAndThumbnail, cutout, frameMetrics, luminanceGrid, pending, shutdown, _setJobTimeoutMs };
