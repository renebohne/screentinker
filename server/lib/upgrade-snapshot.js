'use strict';

/*
 * A database snapshot on the first boot of a NEW VERSION, before any schema or migration runs.
 *
 * Until 3.0 only scripts/upgrade.sh and the instance updater took a backup; a `git pull && restart`,
 * a `docker compose pull`, or a hand-copied release booted straight into the per-boot migration
 * loop with nothing to go back to, and only four of the one-time migrations snapshotted for
 * themselves. This makes "every version change has a restore point" true however the code arrived.
 *
 * - The last booted version lives in a sidecar file next to the database, not in the database: it
 *   must be readable before schema.sql runs, and a 2.x database has nowhere to have stored it. So a
 *   2.6 install has no sidecar, and its first 3.0 boot always snapshots.
 * - A brand-new install (no database file before open) takes no snapshot; there is nothing to save.
 * - Only the newest KEEP snapshots are kept, so a busy upgrade cadence cannot fill the disk.
 * - A failed snapshot stops the boot, like the existing pre-migration snapshot: migrating without a
 *   way back is exactly what this exists to prevent. ST_SKIP_UPGRADE_SNAPSHOT=1 opts out.
 */

const fs = require('fs');
const path = require('path');

const KEEP = 3;
const PREFIX = 'remote_display.pre-upgrade-';
const SIDECAR = '.last-boot-version';

function truthy(v) { return ['1', 'true', 'yes'].includes(String(v || '').toLowerCase()); }

function readLastVersion(dbDir) {
  try { return fs.readFileSync(path.join(dbDir, SIDECAR), 'utf8').trim() || null; } catch { return null; }
}

function writeLastVersion(dbDir, version) {
  try { fs.writeFileSync(path.join(dbDir, SIDECAR), version + '\n'); } catch (e) {
    console.warn(`[boot] Could not record the booted version (${e.message}); the next boot will snapshot again.`);
  }
}

function pruneSnapshots(dbDir, keep = KEEP) {
  let names = [];
  try { names = fs.readdirSync(dbDir).filter((n) => n.startsWith(PREFIX) && n.endsWith('.db')).sort(); } catch { return []; }
  const doomed = names.slice(0, Math.max(0, names.length - keep));
  for (const n of doomed) { try { fs.unlinkSync(path.join(dbDir, n)); } catch { /* best effort */ } }
  return doomed;
}

/**
 * @param {object} o
 * @param {object} o.db           open database handle (for the WAL checkpoint)
 * @param {string} o.dbPath       database file
 * @param {boolean} o.existedBefore whether the file existed before this process opened it
 * @param {string} o.version      the version now booting (server/version.js)
 * @param {function} o.copy       copyFileBytes (lib/fsutil) - exFAT-safe copy
 * @returns {string|null} the snapshot path, or null when none was needed
 */
function snapshotOnVersionChange({ db, dbPath, existedBefore, version, copy, env = process.env, exit = (c) => process.exit(c) }) {
  if (!dbPath || dbPath === ':memory:' || String(dbPath).startsWith('file:')) return null;
  const dbDir = path.dirname(dbPath);
  if (!version || version === '0.0.0') return null; // unknown version: nothing reliable to compare
  const last = readLastVersion(dbDir);
  if (last === version) return null;
  if (!existedBefore) { writeLastVersion(dbDir, version); return null; }
  if (truthy(env.ST_SKIP_UPGRADE_SNAPSHOT)) {
    console.warn(`[boot] Version change ${last || '(pre-3.0)'} -> ${version}: snapshot skipped (ST_SKIP_UPGRADE_SNAPSHOT=1).`);
    writeLastVersion(dbDir, version);
    return null;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const from = String(last || 'pre-3.0').replace(/[^0-9A-Za-z.-]/g, '_');
  const snap = path.join(dbDir, `${PREFIX}${ts}-from-${from}.db`);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    copy(dbPath, snap);
  } catch (e) {
    console.error(`[boot] Version change ${last || '(pre-3.0)'} -> ${version}, but the pre-upgrade snapshot failed: ${e.message}`);
    console.error('[boot] Not migrating without a restore point. Free disk space or fix permissions in ' + dbDir);
    console.error('[boot] (ST_SKIP_UPGRADE_SNAPSHOT=1 boots without one.)');
    exit(1);
    return null;
  }
  console.warn(`[boot] Version change ${last || '(pre-3.0)'} -> ${version}: database snapshot ${snap}`);
  console.warn(`[boot]   To roll back: stop the server, reinstall ${last || 'the previous release'}, cp "${snap}" "${dbPath}".`);
  pruneSnapshots(dbDir);
  writeLastVersion(dbDir, version);
  return snap;
}

module.exports = { snapshotOnVersionChange, pruneSnapshots, readLastVersion, KEEP, PREFIX, SIDECAR };
