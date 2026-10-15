'use strict';

/*
 * Experiments: the facts a result is computed from (docs/experiments.md).
 *
 *   exposure   what each screen ACTUALLY played, per variant per hour — from proof-of-play
 *              (play_logs), not from what was scheduled. A screen that was off, or a variant whose
 *              file never downloaded, shows up as no exposure instead of being assumed.
 *   outcomes   per location per hour: imported sales (lib/experiments/sales.js) and CSV uploads,
 *              stored as aggregates; QR scans and audience counts are read live from their own
 *              tables, which are already aggregate.
 *
 * ⚠️ EXPOSURE IS COPIED OUT OF play_logs, BECAUSE play_logs DOES NOT KEEP IT. Raw plays are pruned
 * after PLAY_LOG_RETENTION_DAYS, and the hourly rollup that survives them keys on content_id only —
 * a widget's plays (every sign, every slide) roll up into one anonymous bucket. So each refresh
 * recomputes the hours raw still covers and keeps the hours it no longer does.
 *
 * ⚠️ TENANCY. Plays are matched on play_logs.workspace_id — the workspace the play happened in —
 * like every proof-of-play report (lib/play-report.js), and only for the experiment's own screens.
 */

const { db } = require('../../db/database');
const core = require('./core');
const sales = require('./sales');
const { UserFacingError } = require('../data-sources/http');

const HOUR = 3600;
const DAY = 86400;
const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_CSV_ROWS = 50000;

const hourOf = (t) => Math.floor(t / HOUR) * HOUR;

/* ─── time zones ────────────────────────────────────────────────────────────────────────────── */

const fmtCache = new Map();
function formatter(zone) {
  if (fmtCache.has(zone)) return fmtCache.get(zone);
  let f;
  try {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hour12: false });
  } catch { f = formatter('UTC'); }
  fmtCache.set(zone, f);
  return f;
}
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** { day: 'YYYY-MM-DD', hour, weekday } of an epoch second in `zone`. */
function localInfo(epochSec, zone = 'UTC') {
  const parts = formatter(zone || 'UTC').formatToParts(new Date(epochSec * 1000));
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return { day: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour) % 24, weekday: WEEKDAYS[o.weekday] ?? 0 };
}

/** The epoch second at which local `day` `hour`:00 begins in `zone` (DST-correct to the hour). */
function zonedToUtc(day, hour, zone = 'UTC') {
  const [y, m, d] = day.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d, hour) / 1000;
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const li = localInfo(guess, zone);
    const [ly, lm, ld] = li.day.split('-').map(Number);
    const seen = Date.UTC(ly, lm - 1, ld, li.hour) / 1000;
    const diff = target - seen;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

/** A location's zone: its first screen's (the screen's reported zone, else its set one, else UTC). */
function unitZones(units) {
  const ids = [...new Set(units.flatMap((u) => u.device_ids))];
  const zones = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of db.prepare(`SELECT id, reported_timezone, timezone FROM devices WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk)) {
      zones.set(r.id, r.reported_timezone || r.timezone || 'UTC');
    }
  }
  const out = new Map();
  for (const u of units) out.set(u.unit_key, (u.device_ids.map((id) => zones.get(id)).find(Boolean)) || 'UTC');
  return out;
}

/* ─── exposure ──────────────────────────────────────────────────────────────────────────────── */

/** Which variant a played content/widget id belongs to. */
function refIndex(exp) {
  const m = new Map();
  exp.variants.forEach((v, k) => { for (const id of v.refs || []) if (!m.has(id)) m.set(id, k); });
  return m;
}

function refreshExposure(exp, now = core.nowSec()) {
  if (!exp.start_at) return 0;
  const units = core.unitsOf(exp.id);
  const devices = [...new Set(units.flatMap((u) => u.device_ids))];
  if (!devices.length) return 0;
  const until = Math.min(now, exp.end_at || now);
  // Hours the prune has already deleted can no longer be recomputed: keep what we stored for them.
  // raw_floor_hour is exact — the prune deletes whole hours and raises it first (services/play-rollup).
  let rawFloorHour = 0;
  try { rawFloorHour = (db.prepare('SELECT raw_floor_hour FROM play_log_rollup_state WHERE id = 1').get() || {}).raw_floor_hour || 0; } catch { rawFloorHour = 0; }
  const from = Math.max(hourOf(exp.start_at), rawFloorHour);
  if (from > until) return 0;
  const refs = refIndex(exp);
  const ids = [...refs.keys()];
  if (!ids.length) return 0;
  const agg = new Map();
  for (let i = 0; i < devices.length; i += 400) {
    const chunk = devices.slice(i, i + 400);
    const rows = db.prepare(`
      SELECT device_id, content_id, widget_id, (started_at / ${HOUR}) * ${HOUR} AS h,
             COUNT(*) AS plays, COALESCE(SUM(duration_sec), 0) AS seconds
        FROM play_logs
       WHERE workspace_id = ? AND started_at >= ? AND started_at <= ?
         AND device_id IN (${chunk.map(() => '?').join(',')})
         AND (content_id IN (${ids.map(() => '?').join(',')}) OR widget_id IN (${ids.map(() => '?').join(',')}))
       GROUP BY device_id, content_id, widget_id, h`).all(exp.workspace_id, Math.max(exp.start_at, from), until, ...chunk, ...ids, ...ids);
    for (const r of rows) {
      const k = refs.has(r.widget_id) ? refs.get(r.widget_id) : refs.get(r.content_id);
      if (k === undefined) continue;
      const key = `${r.device_id}|${r.h}|${k}`;
      const a = agg.get(key) || { device_id: r.device_id, h: r.h, k, plays: 0, seconds: 0 };
      a.plays += r.plays; a.seconds += r.seconds;
      agg.set(key, a);
    }
  }
  db.transaction(() => {
    db.prepare('DELETE FROM experiment_exposure WHERE experiment_id = ? AND hour_utc >= ?').run(exp.id, from);
    const ins = db.prepare('INSERT INTO experiment_exposure (experiment_id, device_id, hour_utc, variant, plays, seconds) VALUES (?, ?, ?, ?, ?, ?)');
    for (const a of agg.values()) ins.run(exp.id, a.device_id, a.h, a.k, a.plays, a.seconds);
  })();
  return agg.size;
}

/* ─── sales import ──────────────────────────────────────────────────────────────────────────── */

const importing = new Set();

function dataSourceConfig(workspaceId, id) {
  const row = db.prepare("SELECT id, type, config FROM data_sources WHERE id = ? AND workspace_id = ? AND type IN ('square','shopify')").get(id, workspaceId);
  if (!row) return null;
  const { decryptSecrets, fieldsForDataSource } = require('../plugins/secrets');
  let config = {};
  try { config = decryptSecrets(JSON.parse(row.config || '{}'), fieldsForDataSource(row.type)); } catch { config = {}; }
  return { id: row.id, type: row.type, config };
}

/**
 * Import sales for every Square/Shopify source the test names. Incremental: from two hours before
 * the last import (late-closing orders) to now; the first import also fetches the before-period.
 * → { ok, error?, hours }
 */
async function importSales(exp, { now = core.nowSec(), ctx = {} } = {}) {
  const all = [exp.config.outcome, ...(exp.config.secondary || [])];
  if (!all.some((o) => o && o.source === 'sales')) return { ok: false, error: 'This test is not measured on sales.' };
  if (importing.has(exp.id)) return { ok: false, error: 'An import is already running for this test.' };
  importing.add(exp.id);
  try {
    const anchor = exp.start_at || now;
    const baseFrom = hourOf(anchor - (exp.config.baseline_days || 0) * DAY);
    const firstFrom = exp.sales_from != null ? Math.min(exp.sales_from, baseFrom) : baseFrom;
    let from = exp.sales_synced_to ? Math.max(baseFrom, exp.sales_synced_to - 2 * HOUR) : baseFrom;
    if (exp.sales_from != null && baseFrom < exp.sales_from) from = baseFrom;   // a longer before-period than last time
    const to = Math.min(now, exp.end_at || now);
    if (from >= to) return { ok: true, hours: 0 };
    const units = core.unitsOf(exp.id);
    let currency = exp.sales_currency || null;
    const rows = [];   // { source, metric, unit_key, hour_utc, value }
    for (const dsId of exp.config.sales.data_source_ids || []) {
      const ds = dataSourceConfig(exp.workspace_id, dsId);
      if (!ds) throw new UserFacingError('A sales data source used by this test was deleted.', 'config');
      const col = ds.type === 'square' ? 'square_location_id' : 'shopify_location_id';
      const mapped = units.filter((u) => u[col]);
      if (!mapped.length) continue;
      const posIds = [...new Set(mapped.map((u) => u[col]))];
      const buckets = new Map();
      for (let a = from; a < to; a += 7 * DAY) {
        const b = Math.min(to, a + 7 * DAY);
        const res = ds.type === 'square'
          ? await sales.importSquare(ds.config, { locationIds: posIds, fromSec: a, toSec: b, items: exp.config.sales.items, ctx })
          : await sales.importShopify(ds.config, { fromSec: a, toSec: b, items: exp.config.sales.items, ctx });
        if (res.currency && !currency) currency = res.currency;
        for (const [key, v] of res.buckets) {
          const prev = buckets.get(key);
          if (prev) { prev.orders += v.orders; prev.units += v.units; prev.revenue += v.revenue; } else buckets.set(key, { ...v });
        }
      }
      for (const v of buckets.values()) {
        for (const u of mapped) {
          if (u[col] !== '*' && u[col] !== String(v.location)) continue;
          for (const metric of ['units', 'revenue', 'orders']) rows.push({ source: ds.type, metric, unit_key: u.unit_key, hour_utc: v.hour_utc, value: v[metric] });
        }
      }
    }
    db.transaction(() => {
      db.prepare("DELETE FROM experiment_outcomes WHERE experiment_id = ? AND source IN ('square','shopify') AND hour_utc >= ? AND hour_utc < ?").run(exp.id, from, to);
      const ins = db.prepare(`INSERT INTO experiment_outcomes (experiment_id, source, metric, unit_key, hour_utc, value) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (experiment_id, source, metric, unit_key, hour_utc) DO UPDATE SET value = experiment_outcomes.value + excluded.value`);
      for (const r of rows) ins.run(exp.id, r.source, r.metric, r.unit_key, r.hour_utc, r.value);
      db.prepare(`UPDATE experiments SET sales_from = ?, sales_synced_to = ?, sales_synced_at = ?, sales_error = NULL, sales_currency = ? WHERE id = ?`)
        .run(Math.min(firstFrom, from), to, now, currency, exp.id);
    })();
    return { ok: true, hours: rows.length };
  } catch (e) {
    // Only an operator-facing message is stored and shown; anything else stays generic (it could
    // describe the network, and a token never appears in one of ours — pos-common.js).
    const msg = e && e.name === 'UserFacingError' ? e.userMessage : 'The sales import failed. Try again later.';
    if (!(e && e.name === 'UserFacingError')) console.warn(`[experiments] sales import failed for ${exp.id}: ${e && e.code ? e.code : 'error'}`);
    db.prepare('UPDATE experiments SET sales_error = ?, sales_synced_at = ? WHERE id = ?').run(msg, now, exp.id);
    return { ok: false, error: msg };
  } finally {
    importing.delete(exp.id);
  }
}

/* ─── CSV upload ────────────────────────────────────────────────────────────────────────────── */

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delim = (s.split(/\r?\n/, 1)[0].match(/;/g) || []).length > (s.split(/\r?\n/, 1)[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') { inQ = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
      if (rows.length > MAX_CSV_ROWS + 1) break;
      continue;
    }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Validate an outcomes CSV: location, date (YYYY-MM-DD), hour (0-23, the location's local time),
 * value (a number ≥ 0). All or nothing: any bad row → { errors: [{ row, message }] } and nothing is
 * stored. → { rows: [{ unit_key, hour_utc, value }] }
 */
function validateCsv(exp, text) {
  if (typeof text !== 'string' || !text.trim()) return { errors: [{ row: 0, message: 'The file is empty.' }] };
  if (Buffer.byteLength(text, 'utf8') > MAX_CSV_BYTES) return { errors: [{ row: 0, message: 'The file is larger than 2 MB. Upload fewer days at a time.' }] };
  const table = parseCsv(text);
  if (table.length > MAX_CSV_ROWS + 1) return { errors: [{ row: 0, message: `The file has more than ${MAX_CSV_ROWS} rows. Upload fewer days at a time.` }] };
  const head = (table[0] || []).map((h) => String(h).trim().toLowerCase());
  const col = (names) => head.findIndex((h) => names.includes(h));
  const ci = { location: col(['location', 'store', 'site']), date: col(['date', 'day']), hour: col(['hour']), value: col(['value', 'amount', 'count', 'sales']) };
  const missing = Object.entries(ci).filter(([k, i]) => i < 0 && k !== 'location').map(([k]) => k);
  if (missing.length) return { errors: [{ row: 1, message: `The first row must name the columns: location, date, hour, value (missing: ${missing.join(', ')}).` }] };
  const units = core.unitsOf(exp.id);
  const zones = unitZones(units);
  const byName = new Map();
  for (const u of units) {
    for (const n of [u.unit_key, u.label, u.square_location_id, u.shopify_location_id]) if (n) byName.set(String(n).trim().toLowerCase(), u);
  }
  const errors = [];
  const out = new Map();
  for (let i = 1; i < table.length && errors.length < 20; i++) {
    const r = table[i];
    const n = i + 1;
    const locRaw = ci.location >= 0 ? String(r[ci.location] || '').trim() : '';
    let unit = locRaw ? byName.get(locRaw.toLowerCase()) : null;
    if (!locRaw && units.length === 1) unit = units[0];
    if (!unit) { errors.push({ row: n, message: locRaw ? `"${locRaw.slice(0, 60)}" is not one of this test's locations.` : 'The location is missing.' }); continue; }
    const date = String(r[ci.date] || '').trim();
    const dm = DATE_RE.exec(date);
    if (!dm || Number(dm[2]) < 1 || Number(dm[2]) > 12 || Number(dm[3]) < 1 || Number(dm[3]) > 31) { errors.push({ row: n, message: 'The date must look like 2026-10-14.' }); continue; }
    const hourText = String(r[ci.hour] || '').trim();
    const hour = /^\d{1,2}(:00)?$/.test(hourText) ? parseInt(hourText, 10) : NaN;
    if (!(hour >= 0 && hour <= 23)) { errors.push({ row: n, message: 'The hour must be a whole number from 0 to 23.' }); continue; }
    const valueText = String(r[ci.value] || '').trim().replace(/^\$|€|£/g, '');
    const value = /^-?\d+(\.\d+)?$/.test(valueText) ? Number(valueText) : NaN;
    if (!Number.isFinite(value) || value < 0 || value > 1e12) { errors.push({ row: n, message: 'The value must be a number of zero or more (use . for decimals).' }); continue; }
    const hourUtc = zonedToUtc(date, hour, zones.get(unit.unit_key));
    const key = `${unit.unit_key}|${hourUtc}`;
    if (out.has(key)) { errors.push({ row: n, message: 'This location and hour appear twice in the file.' }); continue; }
    out.set(key, { unit_key: unit.unit_key, hour_utc: hourUtc, value });
  }
  if (errors.length) return { errors };
  if (!out.size) return { errors: [{ row: 0, message: 'The file has no rows under its header.' }] };
  return { rows: [...out.values()] };
}

function storeCsv(exp, rows) {
  db.transaction(() => {
    const ins = db.prepare(`INSERT INTO experiment_outcomes (experiment_id, source, metric, unit_key, hour_utc, value) VALUES (?, 'csv', 'value', ?, ?, ?)
      ON CONFLICT (experiment_id, source, metric, unit_key, hour_utc) DO UPDATE SET value = excluded.value`);
    for (const r of rows) ins.run(exp.id, r.unit_key, r.hour_utc, r.value);
  })();
}

/* ─── reading for the analysis ──────────────────────────────────────────────────────────────── */

/** Exposure rows: [{ device_id, hour_utc, variant, plays, seconds }]. */
function exposureRows(expId) {
  return db.prepare('SELECT device_id, hour_utc, variant, plays, seconds FROM experiment_exposure WHERE experiment_id = ?').all(expId);
}

/** Location-hour outcome map for a sales/csv metric: Map(`${unit}|${hour}`) → value. */
function outcomeMap(expId, outcome) {
  const sources = outcome.source === 'csv' ? ['csv'] : ['square', 'shopify'];
  const metric = outcome.source === 'csv' ? 'value' : outcome.metric;
  const m = new Map();
  for (const r of db.prepare(`SELECT unit_key, hour_utc, SUM(value) AS v FROM experiment_outcomes
      WHERE experiment_id = ? AND metric = ? AND source IN (${sources.map(() => '?').join(',')}) GROUP BY unit_key, hour_utc`).all(expId, metric, ...sources)) {
    m.set(`${r.unit_key}|${r.hour_utc}`, r.v);
  }
  return m;
}

/** QR scans per variant per hour, only of this workspace's links. Map(`${variant}|${hour}`) → n. */
function qrMap(exp, from, to) {
  const m = new Map();
  exp.variants.forEach((v, k) => {
    if (!v.qr_link_id) return;
    for (const r of db.prepare(`SELECT (s.at / ${HOUR}) * ${HOUR} AS h, COUNT(*) AS n FROM qr_scans s JOIN qr_links l ON l.id = s.link_id
        WHERE s.link_id = ? AND l.workspace_id = ? AND s.at >= ? AND s.at < ? GROUP BY h`).all(v.qr_link_id, exp.workspace_id, from, to)) {
      m.set(`${k}|${r.h}`, (m.get(`${k}|${r.h}`) || 0) + r.n);
    }
  });
  return m;
}

const DWELL_MID_SEC = [1, 3.5, 10, 22.5, 45, 90];

/** Audience per device-hour per variant: [{ device_id, h, k, impressions, observed_ms, looks, dwell_sec }]. */
function audienceRows(exp, deviceIds, from, to) {
  const refs = refIndex(exp);
  const ids = [...refs.keys()];
  if (!ids.length || !deviceIds.length) return [];
  const out = [];
  try {
    for (let i = 0; i < deviceIds.length; i += 400) {
      const chunk = deviceIds.slice(i, i + 400);
      for (const r of db.prepare(`SELECT device_id, item_id, (bucket_start / ${HOUR}) * ${HOUR} AS h,
            SUM(impressions) AS impressions, SUM(observed_ms) AS observed_ms,
            SUM(d0) AS d0, SUM(d1) AS d1, SUM(d2) AS d2, SUM(d3) AS d3, SUM(d4) AS d4, SUM(d5) AS d5
          FROM audience_buckets WHERE workspace_id = ? AND bucket_start >= ? AND bucket_start < ?
           AND device_id IN (${chunk.map(() => '?').join(',')}) AND item_id IN (${ids.map(() => '?').join(',')})
          GROUP BY device_id, item_id, h`).all(exp.workspace_id, from, to, ...chunk, ...ids)) {
        const k = refs.get(r.item_id);
        if (k === undefined) continue;
        const d = [r.d0, r.d1, r.d2, r.d3, r.d4, r.d5];
        out.push({ device_id: r.device_id, h: r.h, k, impressions: r.impressions || 0, observed_ms: r.observed_ms || 0,
          looks: d.reduce((s, x) => s + (x || 0), 0), dwell_sec: d.reduce((s, x, j) => s + (x || 0) * DWELL_MID_SEC[j], 0) });
      }
    }
  } catch (_) { return []; }   // audience tables absent on a build without them
  return out;
}

/** Is there any audience data for these screens at all (so the option is worth offering)? */
function hasAudience(workspaceId, deviceIds) {
  if (!deviceIds.length) return false;
  try {
    const chunk = deviceIds.slice(0, 400);
    return !!db.prepare(`SELECT 1 FROM audience_buckets WHERE workspace_id = ? AND device_id IN (${chunk.map(() => '?').join(',')}) LIMIT 1`).get(workspaceId, ...chunk);
  } catch { return false; }
}

module.exports = {
  HOUR, DAY, localInfo, zonedToUtc, unitZones, refIndex, refreshExposure, importSales, dataSourceConfig,
  parseCsv, validateCsv, storeCsv, exposureRows, outcomeMap, qrMap, audienceRows, hasAudience, MAX_CSV_ROWS,
};
