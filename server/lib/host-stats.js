'use strict';

/*
 * The machine this server runs on, for Platform → Overview: disk, CPU and memory of the WHOLE host
 * (lib/host-probe.js is this process only, for the NOC strip and mesh heartbeats — kept separate so
 * neither changes the other's numbers).
 *
 * ⚠️ NULL WHEN A PROBE CANNOT ANSWER, never 0, as in host-probe.js: "0 B free" from a failed statfs
 * would send an operator running for a bigger drive.
 *
 * CPU is a percentage of the whole machine between two readings of os.cpus(). The first request
 * takes two readings 250 ms apart; after that each request compares against the previous one, so a
 * page polling every 10 s sees the average over those 10 s rather than a 250 ms spike.
 */

const fs = require('node:fs');
const os = require('node:os');
const config = require('../config');

let lastCpu = null; // { idle, total, at }

function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus() || []) {
    const t = c.times || {};
    idle += t.idle || 0;
    total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
  }
  return { idle, total, at: Date.now() };
}

function pctBetween(a, b) {
  const total = b.total - a.total;
  const idle = b.idle - a.idle;
  if (!(total > 0)) return null;
  return Math.max(0, Math.min(100, Math.round((1 - idle / total) * 1000) / 10));
}

async function cpuPct() {
  if (!lastCpu || Date.now() - lastCpu.at > 10 * 60 * 1000) {
    lastCpu = cpuTimes();
    await new Promise((r) => setTimeout(r, 250));
  }
  const now = cpuTimes();
  const pct = pctBetween(lastCpu, now);
  lastCpu = now;
  return pct;
}

/** Linux: MemAvailable counts reclaimable cache as free, which is what "how much is left" means. */
function memAvailable() {
  try {
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) return Number(m[1]) * 1024;
  } catch (e) { /* not Linux */ }
  const f = os.freemem();
  return f > 0 ? f : null;
}

function diskOf(dir) {
  try {
    const s = fs.statfsSync(dir);
    const free = Number(s.bavail) * Number(s.bsize);
    const total = Number(s.blocks) * Number(s.bsize);
    if (!(total > 0) || !Number.isFinite(free)) return null;
    return { free, total };
  } catch (e) { return null; }
}

function deviceOf(dir) { try { return fs.statSync(dir).dev; } catch (e) { return null; } }

function fileSize(p) { try { return fs.statSync(p).size; } catch (e) { return 0; } }

/** Disk and memory warnings only — synchronous and cheap, for GET /api/admin/overview. */
function warningsNow() {
  const out = [];
  const dirs = [['data', config.dataDir]];
  const upDev = deviceOf(config.uploadsDir);
  if (upDev != null && upDev !== deviceOf(config.dataDir)) dirs.push(['uploads', config.uploadsDir]);
  for (const [role, dir] of dirs) {
    const d = diskOf(dir);
    if (d && (d.free / d.total < 0.10 || d.free < 2 * 1024 ** 3)) out.push({ kind: 'disk_low', role, free: d.free, total: d.total });
  }
  const total = os.totalmem();
  const avail = memAvailable();
  if (total && avail != null && avail / total < 0.10) out.push({ kind: 'mem_low', available: avail, total });
  return out;
}

/** One reading. Every number is a number or null. */
async function sample() {
  let cpu = null;
  try { cpu = await cpuPct(); } catch (e) { cpu = null; }
  const cores = (os.cpus() || []).length || null;
  const load = typeof os.loadavg === 'function' && process.platform !== 'win32' ? os.loadavg().map((x) => Math.round(x * 100) / 100) : null;

  const memTotal = os.totalmem() || null;
  const memAvail = memAvailable();
  let rss = null;
  try { rss = process.memoryUsage.rss(); } catch (e) { rss = null; }

  // The data folder always; the uploads folder too when it is on a different filesystem
  // (UPLOADS_DIR on a separate volume is common, and it is the one that fills up).
  const disks = [];
  const data = diskOf(config.dataDir);
  if (data) disks.push({ role: 'data', path: config.dataDir, ...data });
  const upDev = deviceOf(config.uploadsDir);
  if (upDev != null && upDev !== deviceOf(config.dataDir)) {
    const up = diskOf(config.uploadsDir);
    if (up) disks.push({ role: 'uploads', path: config.uploadsDir, ...up });
  }
  const db = fileSize(config.dbPath) + fileSize(config.dbPath + '-wal');

  const warnings = [];
  for (const d of disks) {
    if (d.free / d.total < 0.10 || d.free < 2 * 1024 ** 3) warnings.push({ kind: 'disk_low', role: d.role, free: d.free, total: d.total });
  }
  if (memTotal && memAvail != null && memAvail / memTotal < 0.10) warnings.push({ kind: 'mem_low', available: memAvail, total: memTotal });

  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    cpu: { pct: cpu, cores, load, model: ((os.cpus() || [])[0] || {}).model || null },
    memory: { total: memTotal, available: memAvail, process_rss: rss },
    disks,
    db_bytes: db || null,
    uptime: { host_sec: Math.round(os.uptime()), process_sec: Math.round(process.uptime()) },
    warnings,
  };
}

/** Test hook. */
function _reset() { lastCpu = null; }

// cpuTimes/pctBetween: lib/video-variants.js measures its own window with them, so its pause-while-busy
// check never moves the baseline this module's own CPU figure is measured from.
module.exports = { sample, warningsNow, _reset, _pctBetween: pctBetween, cpuTimes, pctBetween };
