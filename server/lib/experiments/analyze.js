'use strict';

/*
 * Experiments: from exposure + outcomes to a verdict (docs/experiments.md, "How the result is
 * worked out"). The statistics live in stats.js; this file decides WHICH numbers are compared.
 *
 * ⚠️ AN HOUR COUNTS FOR A VARIANT ONLY IF THAT VARIANT WAS THE ONLY ONE ON SCREEN. For per-location
 * outcomes (sales, CSV) the unit is a location-hour, and it is attributed to variant v only when
 * the location's screens played v — and nothing else — during that hour and the `attribution_hours`
 * before it. A sale at 10:20 after B played 9:00-10:00 and A from 10:00 is ambiguous; it is left
 * out rather than guessed. Hours with no play at all (screens off, store closed) are left out too:
 * the rate is per EXPOSURE-hour.
 *
 * ⚠️ LOCATION MODE COMPARES STORES WITH EACH OTHER, SO STORE SIZE IS THE CONFOUNDER. With a
 * before-period imported, each location-hour is divided by what that location normally does at
 * that hour of the week, so the comparison is "B's stores beat their own normal by more than A's
 * did". Without one, the raw rates are compared and the result says so.
 *
 * QR scans are per variant (each has its own link), not per location; audience counts are
 * attributed to the item on screen by the player itself. Both skip the location-hour rule.
 */

const core = require('./core');
const data = require('./data');
const stats = require('./stats');

const HOUR = data.HOUR;
const DAY = data.DAY;

/** Fold exposure rows to location-hours: Map(`${unit}|${h}`) → Map(variant → plays). */
function exposureByUnitHour(rows, deviceUnit) {
  const m = new Map();
  for (const r of rows) {
    const u = deviceUnit.get(r.device_id);
    if (!u || !(r.plays > 0)) continue;
    const key = `${u}|${r.hour_utc}`;
    if (!m.has(key)) m.set(key, new Map());
    const v = m.get(key);
    v.set(r.variant, (v.get(r.variant) || 0) + r.plays);
  }
  return m;
}

/**
 * The location-hours that count, with their variant: [{ unit, h, k }].
 * Clean = exactly one variant played in [h - W hours, h].
 */
function cleanCells(byUnitHour, attributionHours = 0) {
  const out = [];
  for (const [key, vmap] of byUnitHour) {
    const [unit, hs] = key.split('|');
    const h = Number(hs);
    const seen = new Set(vmap.keys());
    for (let w = 1; w <= attributionHours; w++) {
      const prev = byUnitHour.get(`${unit}|${h - w * HOUR}`);
      if (prev) for (const k of prev.keys()) seen.add(k);
    }
    if (seen.size !== 1) continue;
    out.push({ unit, h, k: [...seen][0] });
  }
  return out;
}

/**
 * Before-period baseline per location: Map(unit → { byHow: Map(weekday*24+hour → mean), mean }).
 * Only hours inside the imported before-period count, zero-filled (an hour with no sales sold 0).
 */
function baselines(exp, outcomes, units, zones, coverage) {
  const out = new Map();
  if (!exp.start_at || !coverage || coverage.from == null) return out;
  const from = Math.max(coverage.from, exp.start_at - (exp.config.baseline_days || 0) * DAY);
  const to = Math.min(exp.start_at, coverage.to);
  if (to - from < DAY) return out;
  for (const u of units) {
    const zone = zones.get(u.unit_key);
    const sums = new Map();
    let total = 0, n = 0;
    for (let h = Math.ceil(from / HOUR) * HOUR; h < to; h += HOUR) {
      const v = outcomes.get(`${u.unit_key}|${h}`) || 0;
      const li = data.localInfo(h, zone);
      const how = li.weekday * 24 + li.hour;
      const s = sums.get(how) || { v: 0, n: 0 };
      s.v += v; s.n++;
      sums.set(how, s);
      total += v; n++;
    }
    const byHow = new Map([...sums].map(([how, s]) => [how, s.v / s.n]));
    out.set(u.unit_key, { byHow, mean: n ? total / n : 0, per_day: n ? (total / n) * 24 : 0 });
  }
  return out;
}

const pct = (x) => (x == null ? null : Math.round(x * 1000) / 10);

/**
 * Cells for one outcome. → { cells, perVariant: [{ value, weight, exposure_hours, location_days }],
 *   adjusted, notes }
 */
function cellsFor(exp, outcome, ctx) {
  const { units, zones, deviceUnit, byUnitHour, clean, now } = ctx;
  const mode = exp.mode;
  const n = exp.variants.length;
  const per = Array.from({ length: n }, () => ({ value: 0, weight: 0, exposure_hours: 0, unitDays: new Set() }));
  const cells = [];
  const notes = [];
  let adjusted = false;
  const clusterOf = (unit, h) => (mode === 'time' ? data.localInfo(h, zones.get(unit)).day : unit);
  const end = Math.min(now, exp.end_at || now);

  if (outcome.source === 'sales' || outcome.source === 'csv') {
    const outcomes = data.outcomeMap(exp.id, outcome);
    const coverage = outcome.source === 'sales'
      ? { from: exp.sales_from, to: exp.sales_synced_to || 0 }
      : null;
    const has = (key, h) => (coverage ? h >= coverage.from && h + HOUR <= coverage.to : outcomes.has(key));
    const base = mode === 'location' ? baselines(exp, outcomes, units, zones, coverage || csvCoverage(outcomes)) : new Map();
    adjusted = mode === 'location' && base.size > 0 && [...base.values()].some((b) => b.mean > 0);
    if (mode === 'location' && !adjusted) notes.push('no_baseline');
    for (const c of clean) {
      const key = `${c.unit}|${c.h}`;
      if (!has(key, c.h)) continue;
      const value = outcomes.get(key) || 0;
      let weight = 1;
      if (adjusted) {
        const b = base.get(c.unit);
        if (!b || !(b.mean > 0)) continue;   // a location with no before-period sales cannot be indexed
        const li = data.localInfo(c.h, zones.get(c.unit));
        const expct = b.byHow.get(li.weekday * 24 + li.hour);
        weight = expct > 0 ? expct : b.mean;
      }
      cells.push({ cluster: clusterOf(c.unit, c.h), variant: c.k, value, weight });
      const p = per[c.k];
      p.value += value; p.weight += weight; p.exposure_hours++;
      p.unitDays.add(`${c.unit}|${data.localInfo(c.h, zones.get(c.unit)).day}`);
    }
    return { cells, per, adjusted, notes, baselines: base };
  }

  if (outcome.source === 'qr') {
    const scans = data.qrMap(exp, exp.start_at, end);
    // Exposure-hours per variant per hour, across locations.
    const expo = new Map();
    for (const c of ctx.anyExposure) {
      const key = `${c.k}|${c.h}`;
      expo.set(key, (expo.get(key) || 0) + 1);
    }
    const firstZone = zones.values().next().value || 'UTC';
    const byDay = new Map();   // `${day}|${k}` → { value, weight }
    for (const [key, w] of expo) {
      const [k, h] = key.split('|').map(Number);
      const day = data.localInfo(h, firstZone).day;
      const dk = `${day}|${k}`;
      const r = byDay.get(dk) || { day, k, value: 0, weight: 0 };
      r.value += scans.get(key) || 0; r.weight += w;
      byDay.set(dk, r);
      per[k].exposure_hours += w;
    }
    // Scans in hours the variant was not on screen still belong to it (a phone scanned later).
    for (const [key, s] of scans) {
      if (expo.has(key)) continue;
      const [k, h] = key.split('|').map(Number);
      const dk = `${data.localInfo(h, firstZone).day}|${k}`;
      if (byDay.has(dk)) byDay.get(dk).value += s;
    }
    for (const r of byDay.values()) {
      if (!exp.variants[r.k].qr_link_id) continue;
      cells.push({ cluster: r.day, variant: r.k, value: r.value, weight: r.weight });
      per[r.k].value += r.value; per[r.k].weight += r.weight;
    }
    return { cells, per, adjusted: false, notes: exp.variants.some((v) => !v.qr_link_id) ? ['qr_missing_link'] : [], baselines: new Map() };
  }

  // audience: impressions per on-screen hour, or average look length (dwell seconds per look).
  const rows = data.audienceRows(exp, [...deviceUnit.keys()], exp.start_at, end);
  for (const r of rows) {
    const unit = deviceUnit.get(r.device_id);
    if (!unit) continue;
    const value = outcome.metric === 'dwell' ? r.dwell_sec : r.impressions;
    const weight = outcome.metric === 'dwell' ? r.looks : r.observed_ms / 3600000;
    if (!(weight > 0)) continue;
    cells.push({ cluster: clusterOf(unit, r.h), variant: r.k, value, weight });
    per[r.k].value += value; per[r.k].weight += weight;
  }
  if (!rows.length) notes.push('no_audience');
  return { cells, per, adjusted: false, notes, baselines: new Map() };
}

function csvCoverage(outcomes) {
  let from = null, to = null;
  for (const key of outcomes.keys()) {
    const h = Number(key.split('|')[1]);
    if (from == null || h < from) from = h;
    if (to == null || h + HOUR > to) to = h + HOUR;
  }
  return from == null ? null : { from, to };
}

/** Days the test has run (fractional), and distinct local days with exposure. */
function daysRun(exp, now) {
  if (!exp.start_at) return 0;
  return Math.max(0, (Math.min(now, exp.end_at || now) - exp.start_at) / DAY);
}

/* ─── guardrails ───────────────────────────────────────────────────────────────────────────── */

function guardrails(exp, ctx, primary, now) {
  const out = [];
  const n = exp.variants.length;
  const hours = new Array(n).fill(0);
  for (const c of ctx.anyExposure) hours[c.k]++;
  const running = daysRun(exp, now);
  hours.forEach((h, k) => { if (running >= 1 && h === 0) out.push({ code: 'no_exposure', variant: k }); });

  if (exp.mode === 'time') {
    // Each variant's share of exposure-hours on each local weekday.
    const byWd = Array.from({ length: 7 }, () => new Array(n).fill(0));
    for (const c of ctx.anyExposure) byWd[data.localInfo(c.h, ctx.zones.get(c.unit)).weekday][c.k]++;
    const rows = byWd.map((counts, wd) => ({ weekday: wd, hours: counts }));
    let worst = 0;
    for (const r of rows) {
      const tot = r.hours.reduce((s, x) => s + x, 0);
      if (tot < 4) continue;
      for (const x of r.hours) worst = Math.max(worst, Math.abs(x / tot - 1 / n));
    }
    out.push({ code: worst > 0.15 ? 'weekday_imbalance' : 'weekday_balanced', worst_pct: pct(worst), weekdays: rows });
    if (exp.config.attribution_hours >= exp.config.block_hours) out.push({ code: 'window_too_long' });
  } else {
    const base = primary && primary.baselines;
    if (base && base.size) {
      const arms = new Array(n).fill(null).map(() => []);
      for (const u of ctx.units) {
        const b = base.get(u.unit_key);
        if (b && u.variant != null) arms[u.variant].push(b.per_day);
      }
      const means = arms.map((a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null));
      const m0 = means[0];
      let worst = 0;
      for (const m of means) if (m0 > 0 && m != null) worst = Math.max(worst, Math.abs(m / m0 - 1));
      out.push({ code: worst > 0.25 ? 'baseline_imbalance' : 'baseline_balanced', worst_pct: pct(worst), arm_per_day: means });
    } else if (['sales', 'csv'].includes(exp.config.outcome.source)) {
      out.push({ code: 'no_baseline' });
    }
  }
  if (exp.sales_error) out.push({ code: 'sales_error', message: exp.sales_error });
  else if (exp.status === 'running' && [exp.config.outcome, ...(exp.config.secondary || [])].some((o) => o.source === 'sales')
    && (!exp.sales_synced_at || now - exp.sales_synced_at > 3 * HOUR)) out.push({ code: 'sales_stale', at: exp.sales_synced_at || null });
  return out;
}

/* ─── the result ───────────────────────────────────────────────────────────────────────────── */

function compare(exp, outcome, ctx, now) {
  const r = cellsFor(exp, outcome, ctx);
  const days = exp.mode === 'time' ? new Set(r.cells.map((c) => c.cluster)).size : daysRun(exp, now);
  const variants = r.per.map((p, k) => ({
    variant: k,
    value: p.value,
    exposure_hours: p.exposure_hours,
    rate: p.weight > 0 ? p.value / p.weight : null,
    per_location_day: p.unitDays && p.unitDays.size ? p.value / p.unitDays.size : null,
  }));
  const comparisons = [];
  for (let k = 1; k < exp.variants.length; k++) {
    const res = stats.bootstrapLift(r.cells, k, 0, { seed: exp.id });
    const v = stats.verdict(res, { mode: exp.mode === 'time' || outcome.source === 'qr' ? 'time' : 'location', days: Math.floor(days), minLift: exp.config.min_lift || 0.1 });
    comparisons.push({
      variant: k,
      lift_pct: pct(res && res.lift), low_pct: pct(res && res.low), high_pct: pct(res && res.high),
      p_better: res && res.p_better != null ? Math.round(res.p_better * 1000) / 1000 : null,
      clusters: res ? res.clusters : null,
      welch: (() => { const w = stats.welch(r.cells, k, 0); return w ? { t: Math.round(w.t * 100) / 100, df: Math.round(w.df * 10) / 10, low_pct: pct(w.low), high_pct: pct(w.high) } : null; })(),
      verdict: v.state, reason: v.reason || null,
      more_days: v.more_days == null ? null : v.more_days > stats.MAX_MORE_DAYS ? 'many' : v.more_days,
    });
  }
  return { outcome, adjusted: r.adjusted, notes: r.notes, days: Math.round(days * 10) / 10, variants, comparisons, baselines: r.baselines };
}

/**
 * The whole result for the dashboard. Refreshes exposure first (cheap: one grouped query over the
 * test's own screens and hours).
 */
function results(exp, { now = core.nowSec(), refresh = true } = {}) {
  if (refresh && exp.status === 'running') {
    try { data.refreshExposure(exp, now); } catch (e) { console.warn(`[experiments] exposure refresh failed: ${e && e.message}`); }
  }
  const units = core.unitsOf(exp.id);
  const zones = data.unitZones(units);
  const deviceUnit = new Map();
  for (const u of units) for (const id of u.device_ids) deviceUnit.set(id, u.unit_key);
  const byUnitHour = exposureByUnitHour(data.exposureRows(exp.id), deviceUnit);
  const anyExposure = [];
  for (const [key, vmap] of byUnitHour) {
    const [unit, h] = key.split('|');
    for (const k of vmap.keys()) anyExposure.push({ unit, h: Number(h), k });
  }
  const clean = cleanCells(byUnitHour, exp.config.attribution_hours || 0);
  const ctx = { units, zones, deviceUnit, byUnitHour, clean, anyExposure, now };

  const primary = exp.start_at ? compare(exp, exp.config.outcome, ctx, now) : null;
  const secondary = exp.start_at ? (exp.config.secondary || []).map((o) => compare(exp, o, ctx, now)) : [];
  const plays = new Array(exp.variants.length).fill(0);
  for (const r of data.exposureRows(exp.id)) plays[r.variant] = (plays[r.variant] || 0) + r.plays;

  const unitOut = units.map((u) => {
    const b = primary && primary.baselines && primary.baselines.get(u.unit_key);
    return { unit_key: u.unit_key, label: u.label, screens: u.device_ids.length, variant: u.variant,
      square_location_id: u.square_location_id, shopify_location_id: u.shopify_location_id,
      baseline_per_day: b ? Math.round(b.per_day * 100) / 100 : null };
  });
  const strip = (c) => (c ? { ...c, baselines: undefined } : c);
  return {
    status: exp.status,
    days: Math.round(daysRun(exp, now) * 10) / 10,
    plays,
    currency: exp.sales_currency || null,
    sales: { synced_at: exp.sales_synced_at, synced_to: exp.sales_synced_to, error: exp.sales_error },
    primary: strip(primary),
    secondary: secondary.map(strip),
    guardrails: exp.start_at ? guardrails(exp, ctx, primary, now) : [],
    units: unitOut,
  };
}

module.exports = { results, cleanCells, exposureByUnitHour, baselines, cellsFor, compare };
