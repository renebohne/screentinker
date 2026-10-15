'use strict';

/*
 * Experiments: who sees which variant (docs/experiments.md).
 *
 * Two assignment modes, and they answer different questions:
 *
 *   location  each LOCATION (all the screens in one store) shows one variant for the whole test.
 *             Right when outcomes are per store (sales per location). Locations, not screens, are
 *             the unit: two screens in one shop showing different versions would make that shop's
 *             sales a mixture nobody can attribute.
 *   time      every screen shows every variant, taking turns by hour block. Right for a single
 *             site, where there is nothing to compare across.
 *
 * ⚠️ STABLE. A location's variant is decided once, at start, and persisted (experiment_units).
 * Nothing recomputes it: a screen added later, a renamed location or a restart must never move a
 * store from A to B halfway through, or its sales would be split across both arms.
 *
 * ⚠️ BALANCED. Locations are put in strata of N (sorted by their before-period baseline when there
 * is one, so a busy store is matched with other busy stores) and each stratum gets a random
 * permutation of the variants. Arm sizes then differ by at most one, and the arms are comparable
 * in size of store, which is the confounder that matters most.
 *
 * ⚠️ TIME MODE ROTATES WITH THE WEEKDAY. variant = (hourBlock + weekday) mod N. Without the
 * weekday term variant A would own 9-10 a.m. every day of the test, and "B sold more" would mean
 * "the afternoon sells more". With it, each variant gets every hour block on some weekdays and
 * equal hours on every weekday.
 *
 * The randomness is seeded by the experiment id, so the same inputs give the same assignment —
 * testable, and reproducible when someone asks why their store got B.
 */

const crypto = require('crypto');

/** mulberry32 — a small, good-enough PRNG; seeded so assignments are reproducible. */
function rng(seedText) {
  let a = crypto.createHash('sha256').update(String(seedText)).digest().readUInt32LE(0);
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * A location key for a screen: its location label (case- and space-insensitive), or the screen
 * itself when it has none — an unlabelled screen is its own location.
 */
function locationKeyOf(device) {
  const label = String(device && device.location_label || '').trim().replace(/\s+/g, ' ');
  if (label) return { key: 'loc:' + label.toLowerCase().slice(0, 120), label: label.slice(0, 120) };
  return { key: 'dev:' + device.id, label: String(device.name || device.id).slice(0, 120) };
}

/** Group screens into locations. → [{ key, label, device_ids }] sorted by label. */
function unitsFromDevices(devices) {
  const map = new Map();
  for (const d of devices || []) {
    if (!d || !d.id) continue;
    const { key, label } = locationKeyOf(d);
    if (!map.has(key)) map.set(key, { key, label, device_ids: [] });
    map.get(key).device_ids.push(d.id);
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

/**
 * Location mode: { unitKey -> variant index }, balanced (counts differ by ≤ 1) and stratified on
 * `baseline` (unitKey -> number) when given.
 */
function assignLocations(units, nVariants, seed, baseline = null) {
  const rand = rng(`exp-loc:${seed}`);
  const sorted = units.slice().sort((a, b) => {
    const ba = baseline && Number.isFinite(baseline[a.key]) ? baseline[a.key] : -1;
    const bb = baseline && Number.isFinite(baseline[b.key]) ? baseline[b.key] : -1;
    return (bb - ba) || a.key.localeCompare(b.key);
  });
  const out = {};
  const counts = new Array(nVariants).fill(0);
  for (let i = 0; i < sorted.length; i += nVariants) {
    const stratum = sorted.slice(i, i + nVariants);
    let order = shuffle([...Array(nVariants).keys()], rand);
    // A partial last stratum takes the variants that have fewest so far (ties broken by the
    // permutation), so the arms never differ by more than one.
    if (stratum.length < nVariants) order = order.slice().sort((x, y) => counts[x] - counts[y]);
    stratum.forEach((u, j) => { out[u.key] = order[j]; counts[order[j]]++; });
  }
  return out;
}

/* ─── time mode ─────────────────────────────────────────────────────────────────────────────── */

const BLOCK_HOURS = [1, 2, 3, 4];

/** Which variant plays at a local (weekday 0=Sun, hour 0-23). */
function timeVariantAt(weekday, hour, nVariants, blockHours = 1) {
  return (Math.floor(hour / blockHours) + weekday) % nVariants;
}

const hh = (h) => (h >= 24 ? '24:00' : `${String(h).padStart(2, '0')}:00`);

/**
 * The schedule blocks (playlist_item_schedules shape: { days, start, end }) for variant k.
 * Consecutive hours are merged into one block, and weekdays with identical hour sets share one.
 */
function timeBlocks(k, nVariants, blockHours = 1) {
  const byPattern = new Map();
  for (let w = 0; w < 7; w++) {
    const ranges = [];
    let open = null;
    for (let h = 0; h < 24; h++) {
      const on = timeVariantAt(w, h, nVariants, blockHours) === k;
      if (on && open === null) open = h;
      if (!on && open !== null) { ranges.push([open, h]); open = null; }
    }
    if (open !== null) ranges.push([open, 24]);
    const sig = ranges.map((r) => r.join('-')).join(',');
    if (!ranges.length) continue;
    if (!byPattern.has(sig)) byPattern.set(sig, { days: [], ranges });
    byPattern.get(sig).days.push(w);
  }
  const blocks = [];
  for (const { days, ranges } of byPattern.values()) {
    for (const [s, e] of ranges) blocks.push({ days: days.slice(), start: hh(s), end: hh(e), start_date: null, end_date: null });
  }
  return blocks;
}

const toMin = (t) => (t === '24:00' ? 1440 : Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)));
const fromMin = (m) => (m >= 1440 ? '24:00' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);

/** An overnight block (start > end) as same-day pieces: [{ days, s, e }] in minutes. */
function pieces(b) {
  const s = toMin(b.start), e = toMin(b.end);
  if (s < e) return [{ days: b.days, s, e }];
  // 22:00-02:00 on Monday is Monday 22-24 and Tuesday 00-02.
  return [{ days: b.days, s, e: 1440 }, ...(e > 0 ? [{ days: b.days.map((d) => (d + 1) % 7), s: 0, e }] : [])];
}

const laterDate = (a, b) => (!a ? b || null : !b ? a : a >= b ? a : b);
const earlierDate = (a, b) => (!a ? b || null : !b ? a : a <= b ? a : b);

/**
 * The item's own schedule blocks AND the variant's turn: pairwise intersection, because a block
 * list means "any of these". An item with no blocks is always on, so the turn alone applies.
 */
function intersectBlocks(own, turn) {
  if (!own || !own.length) return turn.map((b) => ({ ...b, days: b.days.slice() }));
  const out = [];
  for (const a of own) {
    for (const pa of pieces(a)) {
      for (const b of turn) {
        for (const pb of pieces(b)) {
          const days = pa.days.filter((d) => pb.days.includes(d));
          const s = Math.max(pa.s, pb.s), e = Math.min(pa.e, pb.e);
          if (!days.length || s >= e) continue;
          const sd = laterDate(a.start_date, b.start_date), ed = earlierDate(a.end_date, b.end_date);
          if (sd && ed && sd > ed) continue;
          out.push({ days: [...new Set(days)].sort(), start: fromMin(s), end: fromMin(e), start_date: sd, end_date: ed });
        }
      }
    }
  }
  return out;
}

module.exports = {
  rng, shuffle, locationKeyOf, unitsFromDevices, assignLocations,
  BLOCK_HOURS, timeVariantAt, timeBlocks, intersectBlocks,
};
