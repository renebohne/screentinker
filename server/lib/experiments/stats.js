'use strict';

/*
 * Experiments: the statistics (docs/experiments.md, "How the result is worked out").
 *
 * The input is a list of CELLS, each one variant's share of one cluster:
 *   { cluster, variant, value, weight }
 *     value   the outcome (sales units, revenue, scans, …) summed over the cell's exposure-hours
 *     weight  what the outcome is divided by: exposure-hours, or — location mode with a before-period
 *             baseline — the outcome the location would have been EXPECTED to produce in those same
 *             hours, so the rate becomes an index (1.0 = business as usual for that store)
 * A variant's rate is Σvalue / Σweight, and lift is rate(B) / rate(control) − 1.
 *
 * ⚠️ THE CONFIDENCE INTERVAL IS A CLUSTER BOOTSTRAP, NOT A t-TEST ON HOURS.
 *
 * Hours are not independent: a busy Saturday makes every Saturday hour busy, and a store that sells
 * a lot sells a lot every day. Treating 300 hours as 300 independent observations produces an
 * interval far too narrow — "likely real" verdicts on noise. So we resample whole CLUSTERS:
 *   time mode      a cluster is a day; both variants played that day, so a resampled day carries
 *                  both arms with it (a paired bootstrap — day-to-day swings cancel out)
 *   location mode  a cluster is a location; each location is in one arm only, so locations are
 *                  resampled within their own arm (a stratified bootstrap)
 * Percentile interval from 2,000 resamples, seeded so the same data always gives the same answer.
 * Welch's t is the textbook alternative; it assumes the ratio is roughly normal, which for a ratio
 * of two sums over a handful of stores it is not, and the bootstrap needs no such assumption.
 *
 * Sample guidance: the interval narrows roughly with √n, so the days still needed to make it as
 * narrow as the lift being looked for are estimated from how wide it is now. An estimate, and
 * labelled as one.
 */

const { rng } = require('./assign');

const RESAMPLES = 2000;
const Z95 = 1.959964;

function sumBy(cells) {
  const v = new Map();
  for (const c of cells) {
    const r = v.get(c.variant) || { value: 0, weight: 0 };
    r.value += c.value; r.weight += c.weight;
    v.set(c.variant, r);
  }
  return v;
}

function rateOf(agg, variant) {
  const r = agg.get(variant);
  return r && r.weight > 0 ? r.value / r.weight : null;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Bootstrap the lift of `variant` over `control`.
 * → { lift, low, high, p_better, clusters: { control, variant }, paired } or null when either arm
 *   has nothing to measure.
 */
function bootstrapLift(cells, variant, control = 0, { resamples = RESAMPLES, seed = 'exp' } = {}) {
  const relevant = cells.filter((c) => c.variant === variant || c.variant === control);
  const byCluster = new Map();
  for (const c of relevant) {
    if (!byCluster.has(c.cluster)) byCluster.set(c.cluster, []);
    byCluster.get(c.cluster).push(c);
  }
  const point = sumBy(relevant);
  const r0 = rateOf(point, control), r1 = rateOf(point, variant);
  if (r0 == null || r1 == null || r0 === 0) return null;
  const lift = r1 / r0 - 1;

  const clusters = [...byCluster.entries()];
  const hasBoth = (list) => list.some((c) => c.variant === control) && list.some((c) => c.variant === variant);
  const paired = clusters.some(([, list]) => hasBoth(list));
  const nControl = clusters.filter(([, l]) => l.some((c) => c.variant === control)).length;
  const nVariant = clusters.filter(([, l]) => l.some((c) => c.variant === variant)).length;

  const rand = rng(`exp-boot:${seed}:${variant}`);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const lifts = [];
  const arm0 = clusters.filter(([, l]) => l.some((c) => c.variant === control));
  const arm1 = clusters.filter(([, l]) => l.some((c) => c.variant === variant));
  for (let i = 0; i < resamples; i++) {
    let v0 = 0, w0 = 0, v1 = 0, w1 = 0;
    const take = (list) => {
      for (const c of list) {
        if (c.variant === control) { v0 += c.value; w0 += c.weight; } else { v1 += c.value; w1 += c.weight; }
      }
    };
    if (paired) {
      for (let j = 0; j < clusters.length; j++) take(pick(clusters)[1]);
    } else {
      for (let j = 0; j < arm0.length; j++) take(pick(arm0)[1]);
      for (let j = 0; j < arm1.length; j++) take(pick(arm1)[1]);
    }
    if (w0 > 0 && w1 > 0 && v0 > 0) lifts.push((v1 / w1) / (v0 / w0) - 1);
  }
  lifts.sort((a, b) => a - b);
  // A resample can be degenerate (no control sales at all); too many of those and there is no
  // interval worth printing.
  if (lifts.length < resamples * 0.5) return { lift, low: null, high: null, p_better: null, clusters: { control: nControl, variant: nVariant }, paired };
  return {
    lift,
    low: quantile(lifts, 0.025),
    high: quantile(lifts, 0.975),
    p_better: lifts.filter((x) => x > 0).length / lifts.length,
    clusters: { control: nControl, variant: nVariant },
    paired,
  };
}

/**
 * Welch's t on per-cluster rates, reported beside the bootstrap for people who want the textbook
 * number. Not used for the verdict (see the header).
 */
function welch(cells, variant, control = 0) {
  const per = (v) => {
    const m = new Map();
    for (const c of cells) {
      if (c.variant !== v) continue;
      const r = m.get(c.cluster) || { value: 0, weight: 0 };
      r.value += c.value; r.weight += c.weight;
      m.set(c.cluster, r);
    }
    return [...m.values()].filter((r) => r.weight > 0).map((r) => r.value / r.weight);
  };
  const a = per(control), b = per(variant);
  if (a.length < 2 || b.length < 2) return null;
  const mean = (x) => x.reduce((s, y) => s + y, 0) / x.length;
  const vari = (x, m) => x.reduce((s, y) => s + (y - m) ** 2, 0) / (x.length - 1);
  const ma = mean(a), mb = mean(b), va = vari(a, ma), vb = vari(b, mb);
  const se = Math.sqrt(va / a.length + vb / b.length);
  if (!(se > 0) || ma === 0) return null;
  const df = (va / a.length + vb / b.length) ** 2 / ((va / a.length) ** 2 / (a.length - 1) + (vb / b.length) ** 2 / (b.length - 1));
  return { t: (mb - ma) / se, df, diff: mb - ma, low: (mb - ma - Z95 * se) / ma, high: (mb - ma + Z95 * se) / ma };
}

/** Minimum clusters before any verdict at all: a week of days, or three locations per arm. */
const MIN_DAYS = 7;
const MIN_LOCATIONS_PER_ARM = 3;
const MAX_MORE_DAYS = 180;

/**
 * How many more days until the 95% interval is about as narrow as `target` (a fraction, 0.1 = 10%).
 * The half-width shrinks with √(days): days_needed = days · (half / target)². null when unknown.
 */
function moreDaysNeeded({ low, high, days, target }) {
  if (low == null || high == null || !(days > 0) || !(target > 0)) return null;
  const half = (high - low) / 2;
  if (half <= target) return 0;
  const need = Math.ceil(days * (half / target) ** 2) - days;
  return Math.min(Math.max(need, 1), MAX_MORE_DAYS + 1);
}

/**
 * The verdict for one variant against control.
 * → { state: 'better'|'worse'|'no_difference'|'not_enough', more_days, ... }
 *   better / worse     the 95% interval excludes zero
 *   no_difference      enough data and the interval spans zero but is narrower than min_lift
 *   not_enough         too little data, or an interval too wide to rule out a min_lift effect
 */
function verdict(res, { mode, days, minLift = 0.1 }) {
  if (!res) return { state: 'not_enough', reason: 'no_data', more_days: null };
  const enoughClusters = mode === 'time'
    ? days >= MIN_DAYS
    : res.clusters.control >= MIN_LOCATIONS_PER_ARM && res.clusters.variant >= MIN_LOCATIONS_PER_ARM;
  const target = Math.max(Math.abs(res.lift), minLift);
  const more = moreDaysNeeded({ low: res.low, high: res.high, days, target });
  if (!enoughClusters) {
    const reason = mode === 'time' ? 'few_days' : 'few_locations';
    const moreDays = mode === 'time' ? Math.max(MIN_DAYS - days, more || 0) : more;
    return { state: 'not_enough', reason, more_days: moreDays };
  }
  if (res.low == null) return { state: 'not_enough', reason: 'unstable', more_days: more };
  if (res.low > 0) return { state: 'better', more_days: 0 };
  if (res.high < 0) return { state: 'worse', more_days: 0 };
  if ((res.high - res.low) / 2 <= minLift) return { state: 'no_difference', more_days: 0 };
  return { state: 'not_enough', reason: 'wide', more_days: more };
}

module.exports = { RESAMPLES, MIN_DAYS, MIN_LOCATIONS_PER_ARM, MAX_MORE_DAYS, sumBy, rateOf, bootstrapLift, welch, moreDaysNeeded, verdict, quantile };
