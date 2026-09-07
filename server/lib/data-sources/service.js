'use strict';

/**
 * Universal Data Sources Service for ScreenTinker.
 *
 * Handles fetching, caching, refreshing, and evaluating data sources.
 */

const { db } = require('../../db/database');
const { resolveIcalData } = require('./ical-resolver');

// Bound how many remote calendar feeds may be in flight at once across the whole
// process. Data source syncs (and `/test`) can fire several fetches near-simultaneously;
// without a cap a single busy workspace could exhaust sockets/descriptors against
// third-party calendar hosts.
const FETCH_CONCURRENCY = 4;
let activeFetches = 0;
const fetchWaiters = [];

async function withFetchSlot(fn) {
  if (activeFetches >= FETCH_CONCURRENCY) {
    await new Promise((resolve) => fetchWaiters.push(resolve));
  } else {
    activeFetches += 1;
  }
  try {
    return await fn();
  } finally {
    const next = fetchWaiters.shift();
    if (next) {
      // Hand the slot directly to the next waiter without decrementing/re-incrementing
      next();
    } else {
      activeFetches -= 1;
    }
  }
}

let pollTimer = null;
let ioInstance = null;

/**
 * Periodically poll and sync all due data sources across all workspaces.
 */
function pollDueDataSources() {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const rows = db.prepare('SELECT id, workspace_id, slug, name, type, config, last_fetched_at, last_status FROM data_sources').all();
    for (const row of rows) {
      let config = {};
      try { config = JSON.parse(row.config || '{}'); } catch (_) {}
      const intervalMin = Math.max(1, parseInt(config.interval_min, 10) || 15);
      const isDue = !row.last_fetched_at || (nowSec - row.last_fetched_at >= intervalMin * 60);
      if (isDue) {
        syncDataSource(row.id, true).catch(err => {
          console.warn(`[data-sources] background sync error for '${row.slug}':`, err.message);
        });
      }
    }
  } catch (e) {
    console.warn('[data-sources] pollDueDataSources error:', e.message);
  }
}

function startDataSourcesPoller(socketIo, intervalMs = 60000) {
  if (pollTimer) return;
  if (socketIo) ioInstance = socketIo;
  const initial = setTimeout(pollDueDataSources, 5000);
  initial.unref?.();
  pollTimer = setInterval(pollDueDataSources, intervalMs);
  pollTimer.unref?.();
}

function stopDataSourcesPoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Fetch and refresh a data source by ID or row object.
 *
 * @param {string|object} sourceOrId ID or row from data_sources table
 * @param {boolean} [force=false] Force refresh ignoring cache interval
 * @returns {Promise<object>} Updated data source row with parsed cached_data
 */
async function syncDataSource(sourceOrId, force = false) {
  const row = typeof sourceOrId === 'string'
    ? db.prepare('SELECT * FROM data_sources WHERE id = ?').get(sourceOrId)
    : sourceOrId;

  if (!row) {
    throw new Error('Data source not found');
  }

  let config = {};
  try {
    config = JSON.parse(row.config || '{}');
  } catch (_) {}

  const intervalMin = Math.max(1, parseInt(config.interval_min, 10) || 15);
  const nowSec = Math.floor(Date.now() / 1000);

  // Return existing cache if not expired and not forced
  if (!force && row.cached_data && row.last_status === 'ok' && (nowSec - row.last_fetched_at < intervalMin * 60)) {
    let parsedData = null;
    try { parsedData = JSON.parse(row.cached_data); } catch (_) {}
    return {
      ...row,
      data: parsedData,
    };
  }

  try {
    let resolvedData = null;

    if (row.type === 'ical') {
      resolvedData = await withFetchSlot(() => resolveIcalData(config));
    } else {
      throw new Error(`Unsupported data source type: ${row.type}`);
    }

    const cachedJson = JSON.stringify(resolvedData);
    const dataChanged = !row.cached_data || cachedJson !== row.cached_data;

    if (dataChanged) {
      // Data changed: update cached data and advance updated_at
      db.prepare(`
        UPDATE data_sources
        SET cached_data = ?, last_fetched_at = ?, last_status = 'ok', last_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(cachedJson, nowSec, nowSec, row.id);

      // Find dependent widgets in this workspace and advance their updated_at revision
      try {
        const slugLower = (row.slug || '').toLowerCase();
        const candidateWidgets = db.prepare(`
          SELECT id, config FROM widgets
          WHERE workspace_id = ?
        `).all(row.workspace_id);

        const dependentWidgets = candidateWidgets.filter(w => {
          if (!w.config) return false;
          const cfg = w.config.toLowerCase();
          return (
            cfg.includes(`{{ds:${slugLower}`) ||
            cfg.includes(`"slug":"${slugLower}"`)
          );
        });

        if (dependentWidgets.length > 0) {
          const widgetIds = dependentWidgets.map(w => w.id);
          const placeholders = widgetIds.map(() => '?').join(',');
          db.prepare(`UPDATE widgets SET updated_at = ? WHERE id IN (${placeholders})`).run(nowSec, ...widgetIds);

          // Push the revision change to all displays currently playing any of these widgets
          const io = ioInstance || global.__deviceIo;
          const deviceNs = io?.of?.('/device');
          if (deviceNs) {
            const { buildPlaylistPayload } = require('../../ws/deviceSocket');
            const commandQueue = require('../command-queue');
            const { devicesPlayingWidget } = require('../devices-playing');

            const affectedDeviceIds = new Set();
            for (const wId of widgetIds) {
              for (const dId of devicesPlayingWidget(wId)) {
                affectedDeviceIds.add(dId);
              }
            }

            for (const devId of affectedDeviceIds) {
              commandQueue.queueOrEmitPlaylistUpdate(deviceNs, devId, buildPlaylistPayload);
            }
          }
        }
      } catch (bumpErr) {
        console.warn(`[data-sources] Could not push updates for dependent widgets: ${bumpErr.message}`);
      }
    } else {
      // Data did not change: update heartbeat/fetch timestamp only, do not defeat immutable cache
      db.prepare(`
        UPDATE data_sources
        SET last_fetched_at = ?, last_status = 'ok', last_error = NULL
        WHERE id = ?
      `).run(nowSec, row.id);
    }

    return {
      ...row,
      cached_data: cachedJson,
      last_fetched_at: nowSec,
      last_status: 'ok',
      last_error: null,
      updated_at: dataChanged ? nowSec : row.updated_at,
      data: resolvedData,
    };
  } catch (err) {
    console.warn(`[data-sources] Sync failed for "${row.name}" (${row.id}): ${err.message}`);

    // Never update updated_at on error: an upstream outage must not defeat the player's immutable cache
    db.prepare(`
      UPDATE data_sources
      SET last_status = 'error', last_error = ?, last_fetched_at = ?
      WHERE id = ?
    `).run(err.message, nowSec, row.id);

    // If we have stale cached data, return it with error status so displays keep showing something
    let staleData = null;
    if (row.cached_data) {
      try { staleData = JSON.parse(row.cached_data); } catch (_) {}
    }

    return {
      ...row,
      last_status: 'error',
      last_error: err.message,
      data: staleData,
    };
  }
}

/**
 * Get all data sources for a workspace mapped by slug synchronously from cache.
 *
 * @param {string} workspaceId Workspace ID
 * @returns {Record<string, object>} Object of slug -> dictionary data
 */
function getWorkspaceDataMapSync(workspaceId) {
  if (!workspaceId) return {};

  const rows = db.prepare('SELECT slug, cached_data FROM data_sources WHERE workspace_id = ?').all(workspaceId);
  const map = {};

  for (const r of rows) {
    try {
      const data = r.cached_data ? JSON.parse(r.cached_data) : {};
      map[r.slug] = data;
      map[r.slug.toLowerCase()] = data;
    } catch (_) {}
  }

  return map;
}

/**
 * Get all data sources for a workspace mapped by slug.
 *
 * @param {string} workspaceId Workspace ID
 * @returns {Promise<Map<string, object>>} Map of slug -> dictionary data
 */
async function getWorkspaceDataMap(workspaceId) {
  if (!workspaceId) return new Map();

  const rows = db.prepare('SELECT * FROM data_sources WHERE workspace_id = ?').all(workspaceId);
  const map = new Map();

  for (const r of rows) {
    try {
      const synced = await syncDataSource(r, false);
      if (synced && synced.data) {
        map.set(r.slug, synced.data);
      }
    } catch (_) {}
  }

  return map;
}

module.exports = {
  syncDataSource,
  getWorkspaceDataMap,
  getWorkspaceDataMapSync,
  withFetchSlot,
  pollDueDataSources,
  startDataSourcesPoller,
  stopDataSourcesPoller,
};
