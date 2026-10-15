'use strict';

/*
 * Energy & carbon (docs/energy.md): how long each screen's panel was lit, what that is estimated to
 * have cost in kWh and CO2e, and what the power schedules saved.
 *
 * ⚠️ ESTIMATES, NOT METERING. Nothing here reads a power meter. The on-time is observed (sampled
 * every minute from what the server knows about each screen); the watts and the grid intensity are
 * looked up (./wattage.js, ./carbon.js). Every figure the report prints carries how it was derived.
 *
 * MEASURING ON-TIME. Once a minute, on the server that owns the screens (never for a scale-out
 * replica's copied workspace: LOCAL_ROWS_SQL, like every other sweep), each screen is put in one of
 *
 *   on          lit
 *   sched_off   dark because its power schedule says so (this is the "saved" time)
 *   panel_off   dark for another reason the player told us about (the OS turned the display off,
 *               a panel report said standby)
 *   offline     the player is not connected: we do not know, and do not count it as either
 *
 * and the seconds since the previous sample are credited to that state. The evidence, best first:
 *   1. a fresh panel report (HDMI-CEC / RS-232 / DDC power state, ≤15 min old) — lib/screen-verify;
 *   2. the power schedule, when the player can obey one (display.power_schedule) — it evaluates the
 *      same windows locally (lib/power-window.js), so the server reaches the same answer;
 *   3. the player's own display_off event since it last connected (Android, Pi, Windows, Tizen);
 *   4. otherwise: online means lit. Seconds decided this way are counted as INFERRED and the report
 *      shows their share, because "the player is online" is not proof the panel is.
 *
 * Seconds are credited per elapsed time, capped at MAX_CREDIT_SEC: a stalled loop or a restart can
 * never inject hours of invented on-time. A gap longer than the cap is simply missing data, and the
 * report's coverage figure shows it.
 *
 * STORAGE: two compact tables (database.js), both written by the same sample:
 *   energy_hourly  per screen per UTC hour, on / sched_off / panel_off seconds, only while online.
 *                  Kept HOURLY_RETENTION_DAYS (35): it feeds the hour-of-day profile and the
 *                  what-if suggestions, which only need the last four weeks.
 *   energy_daily   per screen per LOCAL day, the same plus offline and inferred seconds and the
 *                  watts in force. Kept DAILY_RETENTION_DAYS (400): a year's ESG report plus a month.
 * A year of hourly rows for a 1,000-screen fleet would be ~9M rows for no question anybody asks; the
 * daily table answers every period report at 1/24th of the size.
 */

const { LOCAL_ROWS_SQL } = require('../replica-proxy');
const { chunkedDelete, yieldTick } = require('../chunked-prune');
const PowerWindow = require('../power-window');
const { powerScheduleForDevice } = require('../device-power-schedule');
const { effectiveDeviceTz, isDefaultZone } = require('../device-timezone');
const playerCapabilities = require('../player-capabilities');
const iv = require('./intervals');
const wattage = require('./wattage');
const carbon = require('./carbon');

function dbOf() { return require('../../db/database').db; }
function cfg() {
  const c = require('../../config');
  return {
    hourlyDays: (c.energy && c.energy.hourlyRetentionDays) || 35,
    dailyDays: (c.energy && c.energy.dailyRetentionDays) || 400,
    batch: c.statusLogPruneBatch || 2000,
  };
}

const MAX_CREDIT_SEC = 180;            // three missed ticks; beyond that it is a gap, not on-time
const PANEL_FRESH_SEC = 15 * 60;       // the same freshness screen verification uses
const WATTS_TTL_MS = 10 * 60 * 1000;   // resolved wattage is re-read at most every ten minutes
const CHUNK = 500;                     // screens per write transaction; yields between chunks

const STATES = ['on', 'sched_off', 'panel_off', 'offline'];

/* ============================== classification (pure) ============================== */

/**
 * One screen's state at one instant.
 *
 * @param {object} device      devices row (status)
 * @param {number} nowSec
 * @param {object} ev          { panel:{power,at}|null, display:{power,at}|null, schedOff:boolean, scheduleSupported:boolean }
 * @returns {{state:string, inferred:boolean}}
 */
function classify(device, nowSec, ev = {}) {
  if (!device || device.status !== 'online') return { state: 'offline', inferred: false };
  const { panel, display, schedOff, scheduleSupported } = ev;
  if (panel && panel.power && nowSec - (panel.at || 0) <= PANEL_FRESH_SEC) {
    if (panel.power === 'on') return { state: 'on', inferred: false };
    return { state: schedOff ? 'sched_off' : 'panel_off', inferred: false };
  }
  const displayOff = !!(display && display.power === 'off');
  // A schedule the player cannot obey darkens nothing: the panel stays lit, so it is "on".
  if (schedOff && scheduleSupported) return { state: 'sched_off', inferred: !displayOff };
  if (displayOff) return { state: 'panel_off', inferred: false };
  return { state: 'on', inferred: !display };
}

/* ============================== settings ============================== */

function workspaceSettings(db, workspaceId) {
  if (!workspaceId) return null;
  try { return db.prepare('SELECT * FROM energy_settings WHERE workspace_id = ?').get(workspaceId) || null; } catch { return null; }
}

function deviceOverride(db, deviceId, workspaceId) {
  try { return db.prepare('SELECT * FROM energy_device_settings WHERE device_id = ? AND workspace_id = ?').get(deviceId, workspaceId) || null; } catch { return null; }
}

function latestAttachedDisplay(db, deviceId) {
  try {
    const r = db.prepare('SELECT attached_display FROM device_telemetry WHERE device_id = ? AND attached_display IS NOT NULL ORDER BY reported_at DESC LIMIT 1').get(deviceId);
    return r ? r.attached_display : null;
  } catch { return null; }
}

const wattsCache = new Map();   // deviceId -> { at, ws, value }
function invalidate(deviceId) { if (deviceId) wattsCache.delete(deviceId); else wattsCache.clear(); }

/** The screen's resolved wattage (cached), with its source. */
function wattsFor(db, device, wsSettings, nowMs = Date.now()) {
  const c = wattsCache.get(device.id);
  if (c && c.ws === device.workspace_id && nowMs - c.at < WATTS_TTL_MS) return c.value;
  const dev = { ...device, attached_display: device.attached_display !== undefined ? device.attached_display : latestAttachedDisplay(db, device.id) };
  const value = wattage.resolveWatts(dev, deviceOverride(db, device.id, device.workspace_id), wsSettings);
  if (wattsCache.size > 20000) wattsCache.clear();
  wattsCache.set(device.id, { at: nowMs, ws: device.workspace_id, value });
  return value;
}

/*
 * The zone that says where a screen IS. An operator-set zone is a statement about the screen; a
 * reported one is only believed when it is not an OS image default — Raspberry Pi OS reports
 * Europe/London from anywhere (lib/device-timezone.js), which would bill a Chicago screen at the
 * British grid.
 */
function locationZone(device) {
  if (device.timezone && device.timezone !== 'UTC') return device.timezone;
  return isDefaultZone(device.reported_timezone) ? null : device.reported_timezone;
}

function intensityFor(db, device, wsSettings) {
  const ov = deviceOverride(db, device.id, device.workspace_id);
  return carbon.resolveIntensity({ deviceCountry: ov && ov.country, deviceTz: locationZone(device), wsSettings });
}

/* ============================== sampling ============================== */

let lastTickSec = 0;
let running = false;
let timer = null;
let lastPruneMs = 0;

function scheduleOffFor(db, device, nowMs) {
  let sched = null;
  try { sched = powerScheduleForDevice(db, device.id); } catch { sched = null; }
  const schedOff = !!(sched && sched.enabled && PowerWindow.isOff(sched, new Date(nowMs)));
  return { schedOff, scheduleSupported: schedOff ? playerCapabilities.supports(device, 'display.power_schedule') : false };
}

function liveEvidence(deviceId) {
  try { return require('../screen-verify').powerEvidence(deviceId) || {}; } catch { return {}; }
}

let stmts = null;
function prepared(db) {
  if (stmts && stmts.db === db) return stmts;
  stmts = {
    db,
    hourly: db.prepare(`INSERT INTO energy_hourly (device_id, workspace_id, hour, on_sec, sched_off_sec, panel_off_sec)
        VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id, workspace_id, hour) DO UPDATE SET
        on_sec = MIN(3600, on_sec + excluded.on_sec),
        sched_off_sec = MIN(3600, sched_off_sec + excluded.sched_off_sec),
        panel_off_sec = MIN(3600, panel_off_sec + excluded.panel_off_sec)`),
    daily: db.prepare(`INSERT INTO energy_daily (device_id, workspace_id, day, on_sec, sched_off_sec, panel_off_sec, offline_sec, inferred_sec, on_watts, standby_watts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id, workspace_id, day) DO UPDATE SET
        on_sec = MIN(90000, on_sec + excluded.on_sec),
        sched_off_sec = MIN(90000, sched_off_sec + excluded.sched_off_sec),
        panel_off_sec = MIN(90000, panel_off_sec + excluded.panel_off_sec),
        offline_sec = MIN(90000, offline_sec + excluded.offline_sec),
        inferred_sec = MIN(90000, inferred_sec + excluded.inferred_sec),
        on_watts = excluded.on_watts, standby_watts = excluded.standby_watts`),
  };
  return stmts;
}

/**
 * Credit [fromSec, toSec) to one screen in one state. Exported for the accounting tests: every
 * split, cap and table write the sampler does goes through here.
 */
function credit(db, device, state, inferred, fromSec, toSec, watts) {
  const s = prepared(db);
  const tz = effectiveDeviceTz(device);
  for (const p of iv.splitSpan(fromSec, toSec, tz)) {
    const on = state === 'on' ? p.sec : 0;
    const so = state === 'sched_off' ? p.sec : 0;
    const po = state === 'panel_off' ? p.sec : 0;
    const off = state === 'offline' ? p.sec : 0;
    if (state !== 'offline') s.hourly.run(device.id, device.workspace_id, p.hour, on, so, po);
    s.daily.run(device.id, device.workspace_id, p.day, on, so, po, off, inferred ? p.sec : 0,
      watts ? watts.on_watts : null, watts ? watts.standby_watts : null);
  }
}

function sampleDevices(db) {
  return db.prepare(`SELECT d.id, d.workspace_id, d.status, d.timezone, d.reported_timezone, d.capabilities, d.platform,
      d.client_type, d.android_version, d.power_source, d.hardware_model, d.hardware_edid
    FROM devices d
    WHERE d.workspace_id IS NOT NULL AND d.status != 'provisioning' AND ${LOCAL_ROWS_SQL('d')}`).all();
}

/**
 * One sample. Elapsed-time credit since the previous one, capped; the first call only sets the
 * baseline. Never stacks (a slow tick makes the next one credit more, up to the cap).
 */
async function tick(nowMs = Date.now(), { db = dbOf() } = {}) {
  if (running) return 0;
  const now = Math.floor(nowMs / 1000);
  if (!lastTickSec) { lastTickSec = now; return 0; }
  const elapsed = now - lastTickSec;
  lastTickSec = now;
  if (elapsed <= 0) return 0;
  const from = now - Math.min(elapsed, MAX_CREDIT_SEC);
  running = true;
  let n = 0;
  try {
    const devices = sampleDevices(db);
    const wsCache = new Map();
    for (let i = 0; i < devices.length; i += CHUNK) {
      const slice = devices.slice(i, i + CHUNK);
      db.transaction(() => {
        for (const d of slice) {
          if (!wsCache.has(d.workspace_id)) wsCache.set(d.workspace_id, workspaceSettings(db, d.workspace_id));
          const ws = wsCache.get(d.workspace_id);
          const ev = d.status === 'online' ? { ...liveEvidence(d.id), ...scheduleOffFor(db, d, nowMs) } : {};
          const c = classify(d, now, ev);
          credit(db, d, c.state, c.inferred, from, now, wattsFor(db, d, ws, nowMs));
          n += 1;
        }
      })();
      if (i + CHUNK < devices.length) await yieldTick();
    }
  } finally { running = false; }
  if (nowMs - lastPruneMs > 6 * 3600 * 1000) { lastPruneMs = nowMs; prune(nowMs, { db }).catch(() => {}); }
  return n;
}

/* ============================== retention ============================== */

async function prune(nowMs = Date.now(), { db = dbOf() } = {}) {
  const c = cfg();
  const hourCut = Math.floor(nowMs / 1000) - c.hourlyDays * 86400;
  const dayCut = new Date(nowMs - c.dailyDays * 86400 * 1000).toISOString().slice(0, 10);
  const delH = db.prepare('DELETE FROM energy_hourly WHERE rowid IN (SELECT rowid FROM energy_hourly WHERE hour < ? LIMIT ?)');
  const delD = db.prepare('DELETE FROM energy_daily WHERE rowid IN (SELECT rowid FROM energy_daily WHERE day < ? LIMIT ?)');
  const h = (await chunkedDelete((lim) => delH.run(hourCut, lim).changes, { batch: c.batch })).deleted;
  const d = (await chunkedDelete((lim) => delD.run(dayCut, lim).changes, { batch: c.batch })).deleted;
  return { hourly: h, daily: d };
}

function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch((e) => console.warn(`[energy] sample failed: ${e && e.message}`)); }, 60 * 1000);
  if (timer.unref) timer.unref();
  // First pass soon after boot: sets the baseline, and prunes a table that grew while we were down.
  prune().catch(() => {});
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }

/* ============================== reporting ============================== */

const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const kwhOf = (sec, watts) => ((Number(sec) || 0) / 3600) * (Number(watts) || 0) / 1000;

/** Every screen of the workspace with the figures the report applies to it. */
function deviceContext(db, workspaceId, nowMs = Date.now()) {
  const ws = workspaceSettings(db, workspaceId);
  const devices = db.prepare(`SELECT id, name, workspace_id, status, timezone, reported_timezone, capabilities, platform, client_type,
      android_version, power_source, hardware_model, hardware_edid FROM devices WHERE workspace_id = ?`).all(workspaceId);
  const groups = new Map();
  for (const g of db.prepare(`SELECT m.device_id, g.id, g.name FROM device_group_members m JOIN device_groups g ON g.id = m.group_id
      WHERE g.workspace_id = ? ORDER BY g.id`).all(workspaceId)) {
    if (!groups.has(g.device_id)) groups.set(g.device_id, []);
    groups.get(g.device_id).push({ id: g.id, name: g.name });
  }
  const map = new Map();
  for (const d of devices) {
    map.set(d.id, { device: d, watts: wattsFor(db, d, ws, nowMs), intensity: intensityFor(db, d, ws), groups: groups.get(d.id) || [] });
  }
  return { ws, map };
}

/*
 * One screen's figures over some rows. Watts: the screen's CURRENT resolution when it still exists
 * (so correcting a wattage corrects the history it is applied to — a report is a recalculation, not
 * a ledger), else the snapshot written with the rows (a removed screen still used what it used).
 */
function figures(sums, ctx, wsSettings) {
  const on = ctx ? ctx.watts.on_watts : sums.snap_on;
  const sb = ctx ? ctx.watts.standby_watts : sums.snap_sb;
  const g = ctx ? ctx.intensity.g_per_kwh : carbon.resolveIntensity({ wsSettings }).g_per_kwh;
  const kwhOn = kwhOf(sums.on_sec, on);
  const kwhSb = kwhOf(sums.sched_off_sec + sums.panel_off_sec, sb);
  const saved = kwhOf(sums.sched_off_sec, Math.max(0, (on || 0) - (sb || 0)));
  return { kwh_on: kwhOn, kwh_standby: kwhSb, kwh: kwhOn + kwhSb, kg: carbon.kgCo2e(kwhOn + kwhSb, g), saved_kwh: saved, saved_kg: carbon.kgCo2e(saved, g), on, sb, g };
}

function emptySums() { return { on_sec: 0, sched_off_sec: 0, panel_off_sec: 0, offline_sec: 0, inferred_sec: 0, snap_on: null, snap_sb: null }; }
function addRow(s, r) {
  s.on_sec += r.on_sec; s.sched_off_sec += r.sched_off_sec; s.panel_off_sec += r.panel_off_sec;
  s.offline_sec += r.offline_sec; s.inferred_sec += r.inferred_sec;
  if (r.on_watts != null) s.snap_on = r.on_watts;
  if (r.standby_watts != null) s.snap_sb = r.standby_watts;
}

function shiftDay(day, n) { return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10); }

/** Totals only — used for the previous-period comparison, the org rollup and the Simple line. */
function totals(db, workspaceId, start, end, context = null) {
  const ctx = context || deviceContext(db, workspaceId);
  const rows = db.prepare(`SELECT device_id, on_sec, sched_off_sec, panel_off_sec, offline_sec, inferred_sec, on_watts, standby_watts
    FROM energy_daily WHERE workspace_id = ? AND day >= ? AND day <= ?`).all(workspaceId, start, end);
  const per = new Map();
  for (const r of rows) { if (!per.has(r.device_id)) per.set(r.device_id, emptySums()); addRow(per.get(r.device_id), r); }
  const t = { kwh: 0, kg: 0, saved_kwh: 0, saved_kg: 0, on_sec: 0, sched_off_sec: 0, screens: per.size };
  for (const [id, s] of per) {
    const f = figures(s, ctx.map.get(id), ctx.ws);
    t.kwh += f.kwh; t.kg += f.kg; t.saved_kwh += f.saved_kwh; t.saved_kg += f.saved_kg;
    t.on_sec += s.on_sec; t.sched_off_sec += s.sched_off_sec;
  }
  return { kwh: r2(t.kwh), kg_co2e: r2(t.kg), saved_kwh: r2(t.saved_kwh), saved_kg_co2e: r2(t.saved_kg), on_hours: r1(t.on_sec / 3600), screens: t.screens };
}

/**
 * The full report for a period of LOCAL days [start, end] (YYYY-MM-DD, inclusive).
 */
function report(db, workspaceId, { start, end, nowMs = Date.now() } = {}) {
  const ctx = deviceContext(db, workspaceId, nowMs);
  const rows = db.prepare(`SELECT device_id, day, on_sec, sched_off_sec, panel_off_sec, offline_sec, inferred_sec, on_watts, standby_watts
    FROM energy_daily WHERE workspace_id = ? AND day >= ? AND day <= ? ORDER BY day`).all(workspaceId, start, end);

  const per = new Map();
  const dayRows = new Map();
  for (const r of rows) {
    if (!per.has(r.device_id)) per.set(r.device_id, emptySums());
    addRow(per.get(r.device_id), r);
    if (!dayRows.has(r.day)) dayRows.set(r.day, []);
    dayRows.get(r.day).push(r);
  }

  const byDevice = [];
  const T = { kwh: 0, kwh_on: 0, kwh_standby: 0, kg: 0, saved_kwh: 0, saved_kg: 0, on_sec: 0, sched_off_sec: 0, panel_off_sec: 0, offline_sec: 0, inferred_sec: 0 };
  const watts_sources = {};
  const intensity_sources = {};
  for (const [id, s] of per) {
    const c = ctx.map.get(id);
    const f = figures(s, c, ctx.ws);
    T.kwh += f.kwh; T.kwh_on += f.kwh_on; T.kwh_standby += f.kwh_standby; T.kg += f.kg; T.saved_kwh += f.saved_kwh; T.saved_kg += f.saved_kg;
    T.on_sec += s.on_sec; T.sched_off_sec += s.sched_off_sec; T.panel_off_sec += s.panel_off_sec; T.offline_sec += s.offline_sec; T.inferred_sec += s.inferred_sec;
    const wsrc = c ? c.watts.source : 'snapshot';
    watts_sources[wsrc] = (watts_sources[wsrc] || 0) + 1;
    const isrc = c ? c.intensity.source : 'world';
    intensity_sources[isrc] = (intensity_sources[isrc] || 0) + 1;
    byDevice.push({
      device_id: id, name: c ? c.device.name : null, removed: !c,
      groups: c ? c.groups.map((g) => g.name) : [],
      on_hours: r1(s.on_sec / 3600), sched_off_hours: r1(s.sched_off_sec / 3600), panel_off_hours: r1(s.panel_off_sec / 3600),
      offline_hours: r1(s.offline_sec / 3600), inferred_share: s.on_sec + s.sched_off_sec + s.panel_off_sec
        ? r2(s.inferred_sec / (s.on_sec + s.sched_off_sec + s.panel_off_sec)) : 0,
      on_watts: f.on, standby_watts: f.sb, watts_source: wsrc, watts_detail: c ? c.watts.detail : null,
      g_per_kwh: f.g, intensity_source: isrc, country: c ? c.intensity.country : null,
      kwh: r2(f.kwh), kg_co2e: r2(f.kg), saved_kwh: r2(f.saved_kwh), saved_kg_co2e: r2(f.saved_kg),
    });
  }
  byDevice.sort((a, b) => b.kwh - a.kwh);

  // Groups: a screen in two groups counts in both, so these rows are not meant to be summed.
  const groupAgg = new Map();
  for (const d of byDevice) {
    const c = ctx.map.get(d.device_id);
    for (const g of (c ? c.groups : [])) {
      if (!groupAgg.has(g.id)) groupAgg.set(g.id, { group_id: g.id, name: g.name, screens: 0, kwh: 0, kg_co2e: 0, saved_kwh: 0 });
      const a = groupAgg.get(g.id);
      a.screens += 1; a.kwh += d.kwh; a.kg_co2e += d.kg_co2e; a.saved_kwh += d.saved_kwh;
    }
  }
  const byGroup = [...groupAgg.values()].map((g) => ({ ...g, kwh: r2(g.kwh), kg_co2e: r2(g.kg_co2e), saved_kwh: r2(g.saved_kwh) }))
    .sort((a, b) => b.kwh - a.kwh);

  const byDay = [];
  for (let day = start; day <= end; day = shiftDay(day, 1)) {
    const list = dayRows.get(day) || [];
    let kwh = 0, kg = 0, saved = 0;
    for (const r of list) {
      const s = emptySums(); addRow(s, r);
      const f = figures(s, ctx.map.get(r.device_id), ctx.ws);
      kwh += f.kwh; kg += f.kg; saved += f.saved_kwh;
    }
    byDay.push({ day, kwh: r2(kwh), kg_co2e: r2(kg), saved_kwh: r2(saved) });
    if (byDay.length > 400) break;
  }

  const days = iv.daysInclusive(start, end);
  const prevEnd = shiftDay(start, -1);
  const prevStart = shiftDay(start, -days);
  const previous = { start: prevStart, end: prevEnd, ...totals(db, workspaceId, prevStart, prevEnd, ctx) };

  const observed = T.on_sec + T.sched_off_sec + T.panel_off_sec;
  return {
    period: { start, end, days },
    totals: {
      kwh: r2(T.kwh), kwh_on: r2(T.kwh_on), kwh_standby: r2(T.kwh_standby), kg_co2e: r2(T.kg),
      saved_kwh: r2(T.saved_kwh), saved_kg_co2e: r2(T.saved_kg),
      on_hours: r1(T.on_sec / 3600), sched_off_hours: r1(T.sched_off_sec / 3600), panel_off_hours: r1(T.panel_off_sec / 3600),
      offline_hours: r1(T.offline_sec / 3600), inferred_share: observed ? r2(T.inferred_sec / observed) : 0,
      screens: per.size,
    },
    previous,
    by_device: byDevice,
    by_group: byGroup,
    by_day: byDay,
    watts_sources, intensity_sources,
    settings: publicSettings(ctx.ws),
    grid_source: carbon.SOURCE,
  };
}

/*
 * What-if: "turning these screens off in this window would save about X kWh a year".
 *
 * From the last LOOKBACK days of hourly rows: the seconds each screen was LIT inside the window (in
 * its own local time), scaled to a year, times (on − standby) watts. Only lit time counts, so a
 * screen already asleep in that window — by schedule or otherwise — suggests nothing. Screens are
 * proposed by the group a power schedule would be set on (lowest group id, the same tie-break as
 * lib/device-power-schedule.js) and individually when they are in no group.
 */
const LOOKBACK_DAYS = 28;
function suggestions(db, workspaceId, { start = 22, end = 6, days = null, nowMs = Date.now(), minKwh = 1 } = {}) {
  const ctx = deviceContext(db, workspaceId, nowMs);
  const since = iv.hourOf(Math.floor(nowMs / 1000)) - LOOKBACK_DAYS * 86400;
  const rows = db.prepare('SELECT device_id, hour, on_sec FROM energy_hourly WHERE workspace_id = ? AND hour >= ? AND on_sec > 0')
    .all(workspaceId, since);
  const per = new Map();   // id -> { sec, first }
  for (const r of rows) {
    const c = ctx.map.get(r.device_id);
    if (!c) continue;
    const p = per.get(r.device_id) || { sec: 0, first: r.hour };
    p.first = Math.min(p.first, r.hour);
    // The hour's midpoint, so a half-hour zone (Asia/Kolkata) lands in the hour it mostly covers.
    if (iv.hourInWindow(iv.localHour(r.hour + 1800, effectiveDeviceTz(c.device)), { start, end, days })) p.sec += r.on_sec;
    per.set(r.device_id, p);
  }
  const nowSec = Math.floor(nowMs / 1000);
  const buckets = new Map();
  let fleetKwh = 0, fleetKg = 0;
  for (const [id, p] of per) {
    if (!p.sec) continue;
    const c = ctx.map.get(id);
    const covered = Math.min(LOOKBACK_DAYS, Math.max(1, Math.ceil((nowSec - p.first) / 86400)));
    const yearSec = (p.sec / covered) * 365;
    const kwh = kwhOf(yearSec, Math.max(0, c.watts.on_watts - c.watts.standby_watts));
    const kg = carbon.kgCo2e(kwh, c.intensity.g_per_kwh);
    fleetKwh += kwh; fleetKg += kg;
    const g = c.groups[0] || null;
    const key = g ? `g:${g.id}` : `d:${id}`;
    if (!buckets.has(key)) buckets.set(key, { group_id: g ? g.id : null, name: g ? g.name : c.device.name, devices: [], kwh_per_year: 0, kg_co2e_per_year: 0, lit_hours_per_week: 0 });
    const b = buckets.get(key);
    b.devices.push({ id, name: c.device.name });
    b.kwh_per_year += kwh; b.kg_co2e_per_year += kg; b.lit_hours_per_week += (p.sec / covered) * 7 / 3600;
  }
  const list = [...buckets.values()]
    .map((b) => ({ ...b, kwh_per_year: r1(b.kwh_per_year), kg_co2e_per_year: r1(b.kg_co2e_per_year), lit_hours_per_week: r1(b.lit_hours_per_week) }))
    .filter((b) => b.kwh_per_year >= minKwh)
    .sort((a, b) => b.kwh_per_year - a.kwh_per_year)
    .slice(0, 20);
  return { window: { start, end, days }, lookback_days: LOOKBACK_DAYS, fleet: { kwh_per_year: r1(fleetKwh), kg_co2e_per_year: r1(fleetKg) }, suggestions: list };
}

/** Month-to-date for the Simple view's one line. The month is the server's UTC month. */
function glance(db, workspaceId, nowMs = Date.now()) {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const t = totals(db, workspaceId, today.slice(0, 8) + '01', today);
  return { month: today.slice(0, 7), kwh: t.kwh, saved_kwh: t.saved_kwh, kg_co2e: t.kg_co2e, screens: t.screens };
}

/** Org rollup: one line per workspace of the organization, each with its own settings applied. */
function orgRollup(db, organizationId, { start, end }) {
  const wss = db.prepare('SELECT id, name FROM workspaces WHERE organization_id = ? ORDER BY name').all(organizationId);
  const out = [];
  const T = { kwh: 0, kg_co2e: 0, saved_kwh: 0, saved_kg_co2e: 0, screens: 0 };
  for (const w of wss) {
    const t = totals(db, w.id, start, end);
    out.push({ workspace_id: w.id, name: w.name, ...t });
    T.kwh += t.kwh; T.kg_co2e += t.kg_co2e; T.saved_kwh += t.saved_kwh; T.saved_kg_co2e += t.saved_kg_co2e; T.screens += t.screens;
  }
  return { period: { start, end, days: iv.daysInclusive(start, end) },
    totals: { kwh: r2(T.kwh), kg_co2e: r2(T.kg_co2e), saved_kwh: r2(T.saved_kwh), saved_kg_co2e: r2(T.saved_kg_co2e), screens: T.screens },
    workspaces: out };
}

/* ============================== settings writes ============================== */

function publicSettings(row) {
  return {
    country: (row && row.country) || null,
    grid_g_per_kwh: row && row.grid_g_per_kwh != null ? row.grid_g_per_kwh : null,
    default_on_watts: row && row.default_on_watts != null ? row.default_on_watts : null,
    default_standby_watts: row && row.default_standby_watts != null ? row.default_standby_watts : null,
  };
}

const numOrNull = (v) => (v === null || v === '' || v === undefined ? null : Number(v));

/** Validate a workspace settings body. Returns { ok, settings } or { ok:false, error }. */
function validateSettings(body = {}) {
  const s = {
    country: body.country ? String(body.country).toUpperCase() : null,
    grid_g_per_kwh: numOrNull(body.grid_g_per_kwh),
    default_on_watts: numOrNull(body.default_on_watts),
    default_standby_watts: numOrNull(body.default_standby_watts),
  };
  if (s.country && !carbon.isCountry(s.country)) return { ok: false, error: 'Unknown country' };
  if (s.grid_g_per_kwh !== null && !carbon.validIntensity(s.grid_g_per_kwh)) return { ok: false, error: 'Grid intensity must be between 0 and 2000 gCO2e/kWh' };
  if (s.default_on_watts !== null && !wattage.validWatts(s.default_on_watts)) return { ok: false, error: `Watts must be between ${wattage.MIN_W} and ${wattage.MAX_W}` };
  if (s.default_standby_watts !== null && !(Number.isFinite(s.default_standby_watts) && s.default_standby_watts >= 0 && s.default_standby_watts <= wattage.MAX_W)) return { ok: false, error: 'Standby watts out of range' };
  return { ok: true, settings: s };
}

function saveSettings(db, workspaceId, s, userId) {
  db.prepare(`INSERT INTO energy_settings (workspace_id, country, grid_g_per_kwh, default_on_watts, default_standby_watts, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(workspace_id) DO UPDATE SET country = excluded.country, grid_g_per_kwh = excluded.grid_g_per_kwh,
      default_on_watts = excluded.default_on_watts, default_standby_watts = excluded.default_standby_watts,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(workspaceId, s.country, s.grid_g_per_kwh, s.default_on_watts, s.default_standby_watts, userId || null);
  invalidate(null);
}

/** Validate a per-screen override body ({ on_watts, standby_watts, country }; null clears). */
function validateOverride(body = {}) {
  const o = { on_watts: numOrNull(body.on_watts), standby_watts: numOrNull(body.standby_watts), country: body.country ? String(body.country).toUpperCase() : null };
  if (o.on_watts !== null && !wattage.validWatts(o.on_watts)) return { ok: false, error: `Watts must be between ${wattage.MIN_W} and ${wattage.MAX_W}` };
  if (o.standby_watts !== null && !(Number.isFinite(o.standby_watts) && o.standby_watts >= 0 && o.standby_watts <= wattage.MAX_W)) return { ok: false, error: 'Standby watts out of range' };
  if (o.on_watts !== null && o.standby_watts !== null && o.standby_watts > o.on_watts) return { ok: false, error: 'Standby watts cannot exceed on watts' };
  if (o.country && !carbon.isCountry(o.country)) return { ok: false, error: 'Unknown country' };
  return { ok: true, override: o };
}

function saveOverride(db, workspaceId, deviceIds, o, userId) {
  const up = db.prepare(`INSERT INTO energy_device_settings (device_id, workspace_id, on_watts, standby_watts, country, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(device_id) DO UPDATE SET workspace_id = excluded.workspace_id, on_watts = excluded.on_watts,
      standby_watts = excluded.standby_watts, country = excluded.country, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
  const del = db.prepare('DELETE FROM energy_device_settings WHERE device_id = ?');
  db.transaction(() => {
    for (const id of deviceIds) {
      if (o.on_watts === null && o.standby_watts === null && o.country === null) del.run(id);
      else up.run(id, workspaceId, o.on_watts, o.standby_watts, o.country, userId || null);
      invalidate(id);
    }
  })();
}

/** The screens list for the settings table: each screen's resolved wattage and where it came from. */
function deviceList(db, workspaceId) {
  const ctx = deviceContext(db, workspaceId);
  const out = [];
  for (const [, c] of ctx.map) {
    const ov = deviceOverride(db, c.device.id, workspaceId);
    out.push({
      id: c.device.id, name: c.device.name, model: c.device.hardware_model || null, groups: c.groups,
      on_watts: c.watts.on_watts, standby_watts: c.watts.standby_watts, source: c.watts.source, standby_source: c.watts.standby_source,
      detail: c.watts.detail, source_url: c.watts.panel_source_url, diagonal_in: c.watts.diagonal_in,
      g_per_kwh: c.intensity.g_per_kwh, intensity_source: c.intensity.source, country: c.intensity.country,
      override: ov ? { on_watts: ov.on_watts, standby_watts: ov.standby_watts, country: ov.country } : null,
    });
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function _resetForTests() { lastTickSec = 0; running = false; lastPruneMs = Date.now(); wattsCache.clear(); stmts = null; }

module.exports = {
  classify, credit, tick, prune, start, stop, report, totals, suggestions, glance, orgRollup,
  workspaceSettings, publicSettings, validateSettings, saveSettings, validateOverride, saveOverride, deviceList, invalidate,
  MAX_CREDIT_SEC, LOOKBACK_DAYS, STATES, _resetForTests,
};
