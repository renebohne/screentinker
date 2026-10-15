'use strict';

/*
 * Energy & carbon (docs/energy.md): the time arithmetic, and nothing else. Pure, no database.
 *
 * Two buckets, deliberately keyed differently:
 *
 *   hourly  keyed by the UTC hour (epoch seconds of the hour's start). UTC has no DST, so an hour
 *           can never be counted twice in autumn or skipped in spring, and two screens in different
 *           zones share one key space. Reading it in local time is the report's job.
 *   daily   keyed by the SCREEN'S local calendar date (YYYY-MM-DD in its effective zone). A monthly
 *           ESG figure is "what did the shop's screens use in March", and March is the shop's March,
 *           not the server's. A local day around a DST change is 23 or 25 hours long, which is the
 *           truth, and the per-second credit below cannot over- or under-count it.
 *
 * Every credited span is split at UTC hour boundaries AND at the screen's local midnight, so a span
 * that straddles either lands in the right buckets in proportion.
 */

const HOUR = 3600;

/** UTC hour start (epoch s) of an instant (epoch s). */
function hourOf(sec) { return Math.floor(sec / HOUR) * HOUR; }

const dayFmtCache = new Map();
function dayFormatter(tz) {
  const key = tz || 'UTC';
  let f = dayFmtCache.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-CA', { timeZone: key, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      // An unknown zone is a screen we cannot place in time: bucket it in UTC rather than drop it.
      f = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
    }
    if (dayFmtCache.size > 500) dayFmtCache.clear();
    dayFmtCache.set(key, f);
  }
  return f;
}

/** The local calendar date (YYYY-MM-DD) of an instant in a zone; UTC when the zone is unknown. */
function localDay(sec, tz) {
  const parts = dayFormatter(tz).formatToParts(new Date(sec * 1000));
  const p = {};
  for (const x of parts) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

const hourFmtCache = new Map();
/** The local wall-clock hour (0-23) and weekday (0=Sun) of an instant in a zone. */
function localHour(sec, tz) {
  const key = tz || 'UTC';
  let f = hourFmtCache.get(key);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: key, hour: '2-digit', hourCycle: 'h23', weekday: 'short' }); }
    catch { f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: '2-digit', hourCycle: 'h23', weekday: 'short' }); }
    if (hourFmtCache.size > 500) hourFmtCache.clear();
    hourFmtCache.set(key, f);
  }
  const p = {};
  for (const x of f.formatToParts(new Date(sec * 1000))) p[x.type] = x.value;
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hour: parseInt(p.hour, 10) % 24, dow: DOW[p.weekday] ?? 0 };
}

/*
 * Split [fromSec, toSec) into pieces that each sit inside one UTC hour AND one local day.
 *
 * Local midnight is found by asking for the local date at each hour boundary rather than by
 * computing an offset: a zone with a half-hour offset (Asia/Kolkata) or a DST change has its
 * midnight inside a UTC hour, so the piece is further split there by a binary search on the date.
 * Returns [{ hour, day, sec }] with the seconds summing exactly to toSec - fromSec.
 */
function splitSpan(fromSec, toSec, tz) {
  const out = [];
  if (!(toSec > fromSec)) return out;
  let t = Math.floor(fromSec);
  const end = Math.floor(toSec);
  while (t < end) {
    const hourEnd = Math.min(hourOf(t) + HOUR, end);
    const dayAtStart = localDay(t, tz);
    const dayAtEnd = localDay(hourEnd - 1, tz);
    if (dayAtStart === dayAtEnd) {
      out.push({ hour: hourOf(t), day: dayAtStart, sec: hourEnd - t });
      t = hourEnd;
      continue;
    }
    // Local midnight falls inside this UTC hour: find the first second of the new day.
    let lo = t, hi = hourEnd - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (localDay(mid, tz) === dayAtStart) lo = mid + 1; else hi = mid;
    }
    out.push({ hour: hourOf(t), day: dayAtStart, sec: lo - t });
    t = lo;
  }
  return out;
}

/** Days between two YYYY-MM-DD strings, inclusive. */
function daysInclusive(startDay, endDay) {
  const a = Date.parse(`${startDay}T00:00:00Z`);
  const b = Date.parse(`${endDay}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function isDay(s) { return typeof s === 'string' && DAY_RE.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)); }

/*
 * Does a local {hour, dow} fall inside a what-if window? Same half-open [start, end) semantics and
 * the same overnight rule as lib/power-window.js: a 22-6 window anchors to the day it STARTED, so
 * "weekdays 22:00-06:00" covers Saturday 03:00 and not Saturday 23:00.
 */
function hourInWindow({ hour, dow }, { start, end, days }) {
  const listed = (d) => !days || days.includes(d);
  if (start === end) return false;
  if (start < end) return listed(dow) && hour >= start && hour < end;
  if (hour >= start) return listed(dow);
  if (hour < end) return listed((dow + 6) % 7);
  return false;
}

module.exports = { HOUR, hourOf, localDay, localHour, splitSpan, daysInclusive, isDay, hourInWindow };
