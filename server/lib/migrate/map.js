'use strict';

/*
 * Pure mapping helpers for lib/migrate: times, recurrence and geometry from another CMS into the
 * shapes ScreenTinker's engine actually evaluates. No database, no network — tested on their own.
 *
 * ⚠️ WHAT THE SCHEDULE ENGINE CAN EXPRESS (services/scheduler.js isScheduleActiveAt), and therefore
 * what an imported schedule is reduced to:
 *   - start_time / end_time are WALL-CLOCK "YYYY-MM-DDTHH:MM" in the schedule's own IANA zone;
 *   - no recurrence: one absolute window;
 *   - recurrence FREQ=DAILY | WEEKLY;BYDAY=.. | MONTHLY (on the start's day of month), with the start
 *     DATE as the first day, recurrence_end as the last (inclusive), and a SAME-DAY time-of-day window;
 *   - INTERVAL is not evaluated by the engine (the calendar draws DAILY intervals, the screens do not).
 * Everything else is lossy, and each loss is said in the job report rather than guessed:
 *   - an overnight recurring window (22:00 -> 02:00) is split into two schedules, the second on the
 *     following weekdays, so it plays exactly as before;
 *   - "every 2 weeks" becomes "every week" (said);
 *   - hourly / per-minute recurrence, "the 2nd Tuesday of the month", and yearly rules cannot be
 *     expressed: the schedule is skipped with the reason;
 *   - a recurring event whose single occurrence spans several days is cut to its time-of-day window.
 */

const DOW = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const p2 = (n) => (n < 10 ? '0' : '') + n;

function isZone(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** An instant (ms, Date, or ISO with Z/offset) as wall clock in `tz`: "YYYY-MM-DDTHH:MM". */
function wallClock(instant, tz) {
  const ms = instant instanceof Date ? instant.getTime() : typeof instant === 'number' ? instant : Date.parse(String(instant));
  if (!Number.isFinite(ms)) return null;
  const { _localParts } = require('../schedule-eval');
  const L = _localParts(ms, isZone(tz) ? tz : 'UTC');
  return `${L.y}-${p2(L.mo)}-${p2(L.day)}T${p2(Math.floor(L.min / 60))}:${p2(L.min % 60)}`;
}

/**
 * A time string that is ALREADY wall clock ("2026-10-14 09:30:00", "2026-10-14T09:30") as the
 * engine's stamp. One carrying Z or an offset is an instant and is converted into `tz` instead.
 */
function stamp(s, tz) {
  const v = String(s == null ? '' : s).trim();
  if (!v) return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(v)) return wallClock(v, tz);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(v);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4] || '00'}:${m[5] || '00'}`;
}

/** "YYYY-MM-DD" + n days. */
function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Reduce one source schedule to ScreenTinker schedule rows.
 *
 * input: { start, end (stamps), timezone, recurrence: null | { freq, interval, byDay:[0-6], until:'YYYY-MM-DD',
 *          byMonthDayOrdinal (e.g. "2nd Tuesday": true) } }
 * returns { rows: [{ start_time, end_time, timezone, recurrence, recurrence_end }], notes: [string], skip: string|null }
 */
function scheduleRows({ start, end, timezone, recurrence }) {
  const notes = [];
  const tz = isZone(timezone) ? timezone : 'UTC';
  if (timezone && !isZone(timezone)) notes.push(`Unknown time zone "${String(timezone).slice(0, 40)}"; UTC was used.`);
  if (!start || !end) return { rows: [], notes, skip: 'It has no start or end time.' };
  if (end < start && !recurrence) return { rows: [], notes, skip: 'It ends before it starts.' };

  if (!recurrence || !recurrence.freq) {
    return { rows: [{ start_time: start, end_time: end, timezone: tz, recurrence: null, recurrence_end: null }], notes, skip: null };
  }

  const freq = String(recurrence.freq).toUpperCase();
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) {
    const what = { HOURLY: 'every hour', MINUTELY: 'every few minutes', YEARLY: 'every year' }[freq] || `"${freq.toLowerCase()}"`;
    return { rows: [], notes, skip: `It repeats ${what}, which ScreenTinker schedules cannot express. Recreate it by hand.` };
  }
  if (recurrence.byMonthDayOrdinal) {
    return { rows: [], notes, skip: 'It repeats on an nth weekday of the month, which ScreenTinker schedules cannot express. Recreate it by hand.' };
  }
  const interval = Math.max(1, Number(recurrence.interval) || 1);
  if (interval > 1) notes.push(`It repeated every ${interval} ${freq === 'DAILY' ? 'days' : freq === 'WEEKLY' ? 'weeks' : 'months'}; ScreenTinker repeats it every ${freq === 'DAILY' ? 'day' : freq === 'WEEKLY' ? 'week' : 'month'}.`);

  const startDate = start.slice(0, 10), startHM = start.slice(11, 16);
  let endHM = end.slice(11, 16);
  const spanDays = Math.round((Date.parse(`${end.slice(0, 10)}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000);
  if (spanDays > 1 || (spanDays === 1 && endHM > startHM)) {
    notes.push('Each occurrence lasted more than a day; it now plays its daily time window only.');
  }
  let until = recurrence.until ? String(recurrence.until).slice(0, 10) : null;
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) until = null;

  let byDay = Array.isArray(recurrence.byDay) ? [...new Set(recurrence.byDay.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : null;
  if (freq === 'WEEKLY' && (!byDay || !byDay.length)) byDay = [new Date(`${startDate}T00:00:00Z`).getUTCDay()];
  if (freq === 'MONTHLY') byDay = null;
  const rule = (days) => (freq === 'WEEKLY' || (freq === 'DAILY' && days && days.length && days.length < 7)
    ? `FREQ=WEEKLY;BYDAY=${[...days].sort((a, b) => a - b).map((d) => DOW[d]).join(',')}` : `FREQ=${freq}`);

  // A whole-day window ("00:00" to "00:00") is the whole day, not an empty one.
  if (endHM === startHM && spanDays >= 1) endHM = '23:59';

  if (endHM >= startHM) {
    return {
      rows: [{ start_time: start, end_time: `${startDate}T${endHM}`, timezone: tz, recurrence: rule(byDay), recurrence_end: until }],
      notes, skip: null,
    };
  }
  // Overnight: today's part to midnight, then the morning after on the FOLLOWING days.
  notes.push('It ran past midnight; it was split into an evening and an early-morning schedule.');
  if (freq === 'MONTHLY') {
    return { rows: [{ start_time: start, end_time: `${startDate}T23:59`, timezone: tz, recurrence: 'FREQ=MONTHLY', recurrence_end: until }],
      notes: notes.concat('The early-morning part of a monthly overnight schedule could not be kept.'), skip: null };
  }
  const nextDays = byDay ? byDay.map((d) => (d + 1) % 7) : null;
  const next = addDays(startDate, 1);
  return {
    rows: [
      { start_time: start, end_time: `${startDate}T23:59`, timezone: tz, recurrence: rule(byDay), recurrence_end: until },
      { start_time: `${next}T00:00`, end_time: `${next}T${endHM}`, timezone: tz, recurrence: rule(nextDays), recurrence_end: until ? addDays(until, 1) : null },
    ],
    notes, skip: null,
  };
}

/** Pixel rectangle on a W x H canvas -> clamped percentages (two decimals). */
function zonePercent({ left, top, width, height }, W, H) {
  const cw = Number(W) > 0 ? Number(W) : 1920, ch = Number(H) > 0 ? Number(H) : 1080;
  const r = (v) => Math.round(v * 100) / 100;
  const clamp = (v) => Math.min(100, Math.max(0, v));
  const x = clamp((Number(left) || 0) / cw * 100), y = clamp((Number(top) || 0) / ch * 100);
  const w = Math.min(100 - x, clamp((Number(width) || cw) / cw * 100));
  const h = Math.min(100 - y, clamp((Number(height) || ch) / ch * 100));
  return { x_percent: r(x), y_percent: r(y), width_percent: r(Math.max(0.5, w)), height_percent: r(Math.max(0.5, h)) };
}

/** A name from a source system, bounded and with control characters removed. */
function cleanName(s, fallback = 'Untitled') {
  const v = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return v || fallback;
}

/** Positive whole seconds, or null. */
function seconds(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.min(86400, Math.round(n)) : null;
}

/** Media kind from a MIME type or a file name. */
function kindOf(mimeOrName) {
  const s = String(mimeOrName || '').toLowerCase();
  if (/^image\/|\.(jpe?g|png|gif|webp|bmp|svg|avif)$/.test(s)) return 'image';
  if (/^video\/|\.(mp4|m4v|mov|webm|mkv|avi|mpe?g|wmv)$/.test(s)) return 'video';
  if (/^audio\/|\.(mp3|wav|m4a|aac|ogg|flac)$/.test(s)) return 'audio';
  return null;
}

module.exports = { scheduleRows, wallClock, stamp, addDays, zonePercent, cleanName, seconds, kindOf, isZone, DOW };
