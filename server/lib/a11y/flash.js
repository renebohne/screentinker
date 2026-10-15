'use strict';

/*
 * Flash detection: WCAG 2.3.1 "Three Flashes or Below Threshold", on frames sampled by ffmpeg.
 *
 * ⚠️ THE DEFINITIONS, VERBATIM IN SPIRIT (WCAG 2.2, "general flash and red flash thresholds"):
 *   - a FLASH is a pair of opposing changes in relative luminance of 10% or more of the maximum
 *     (i.e. ≥ 0.10 on WCAG's 0-1 scale) where the darker state is below 0.80;
 *   - a RED FLASH is a pair of opposing transitions involving a saturated red: R/(R+G+B) ≥ 0.8 and a
 *     change in (R − G − B) × 320 of more than 20 (negative values clamped to zero);
 *   - content fails when there are MORE THAN THREE flashes (so more than six transitions) in any
 *     one-second period over a large enough area.
 *
 * "Large enough area" is 25% of a 10° visual field, which WCAG approximates as 341×256 px on a
 * 1024×768 screen — exactly one ninth of the frame. So every frame is reduced to a 48×27 grid and
 * we follow the mean of each 3×3 cell (one ninth each), the four quadrants and the whole frame.
 * Flashing confined to less than a ninth of the picture is not counted; flashing anywhere that big
 * is. On a large screen seen from a few metres a ninth of the frame is MORE than 10° of view, so on
 * signage this errs towards finding flashes, which is the safe direction.
 *
 * Transitions are found with hysteresis: from the last turning point the series has to move 0.10
 * the other way before it counts, so a slow fade, film grain or compression shimmer never does.
 *
 * Pure: the frames come in as raw RGB buffers. lib/a11y/media-worker.js runs ffmpeg and feeds them.
 */

const GRID_W = 48;
const GRID_H = 27;
const FRAME_BYTES = GRID_W * GRID_H * 3;
const LUM_STEP = 0.1;
const DARK_LIMIT = 0.8;
const RED_STEP = 20;
const MAX_TRANSITIONS_PER_SEC = 6; // three flashes

const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }

/** Regions as [x0, y0, x1, y1) in grid cells. */
function regions() {
  const out = [];
  const cw = GRID_W / 3, ch = GRID_H / 3;
  for (let ry = 0; ry < 3; ry++) for (let rx = 0; rx < 3; rx++) out.push([rx * cw, ry * ch, (rx + 1) * cw, (ry + 1) * ch]);
  const hw = GRID_W / 2, hh = Math.floor(GRID_H / 2);
  out.push([0, 0, hw, hh], [hw, 0, GRID_W, hh], [0, hh, hw, GRID_H], [hw, hh, GRID_W, GRID_H]);
  out.push([0, 0, GRID_W, GRID_H]);
  return out;
}
const REGIONS = regions();

/** One hysteresis tracker: counts turning points of at least `step`, with an optional dark rule. */
class Tracker {
  constructor(step, darkLimit) {
    this.step = step; this.dark = darkLimit;
    this.dir = 0; this.peak = null; this.trough = null;
    this.times = [];
  }
  push(v, t) {
    if (this.peak == null) { this.peak = v; this.trough = v; return; }
    if (this.dir >= 0) {
      if (v > this.peak) this.peak = v;
      if (this.peak - v >= this.step && (this.dark == null || v < this.dark)) {
        this.times.push(t); this.dir = -1; this.trough = v; return;
      }
    }
    if (this.dir <= 0) {
      if (v < this.trough) this.trough = v;
      if (v - this.trough >= this.step && (this.dark == null || this.trough < this.dark)) {
        this.times.push(t); this.dir = 1; this.peak = v;
      }
    }
  }
}

/** The most transitions inside any one-second window, and when that window starts. */
function worstSecond(times) {
  let best = 0, at = null;
  for (let i = 0, j = 0; i < times.length; i++) {
    // Half-open second, with a hair of tolerance: frame times are n/fps in floating point, and a
    // steady 3 Hz flash must not become "four" because 35/30 − 5/30 came out as 0.9999999999.
    while (times[i] - times[j] >= 1 - 1e-6) j++;
    const n = i - j + 1;
    if (n > best) { best = n; at = times[j]; }
  }
  return { transitions: best, at };
}

class FlashDetector {
  constructor(fps) {
    this.fps = fps;
    this.frame = 0;
    this.lum = REGIONS.map(() => new Tracker(LUM_STEP, DARK_LIMIT));
    this.red = REGIONS.map(() => new Tracker(RED_STEP, null));
    this.cellLum = new Float64Array(GRID_W * GRID_H);
    this.cellRed = new Float64Array(GRID_W * GRID_H);
  }

  /** One frame of exactly FRAME_BYTES of packed RGB. */
  push(buf) {
    const t = this.frame++ / this.fps;
    for (let p = 0, o = 0; p < GRID_W * GRID_H; p++, o += 3) {
      const r = LIN[buf[o]], g = LIN[buf[o + 1]], b = LIN[buf[o + 2]];
      this.cellLum[p] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const sum = r + g + b;
      this.cellRed[p] = sum > 0 && r / sum >= 0.8 ? Math.max(0, (r - g - b) * 320) : 0;
    }
    REGIONS.forEach((rg, k) => {
      let sl = 0, sr = 0, n = 0;
      for (let y = Math.floor(rg[1]); y < Math.ceil(rg[3]); y++) {
        for (let x = Math.floor(rg[0]); x < Math.ceil(rg[2]); x++) { const p = y * GRID_W + x; sl += this.cellLum[p]; sr += this.cellRed[p]; n++; }
      }
      this.lum[k].push(sl / n, t);
      this.red[k].push(sr / n, t);
    });
  }

  result() {
    const pick = (trackers) => trackers.map((tr) => worstSecond(tr.times)).sort((a, b) => b.transitions - a.transitions)[0];
    const g = pick(this.lum);
    const r = pick(this.red);
    return {
      frames: this.frame,
      seconds: Math.round((this.frame / this.fps) * 10) / 10,
      general: { flashes_per_sec: Math.floor(g.transitions / 2), at_sec: g.at == null ? null : Math.round(g.at * 10) / 10, fails: g.transitions > MAX_TRANSITIONS_PER_SEC },
      red: { flashes_per_sec: Math.floor(r.transitions / 2), at_sec: r.at == null ? null : Math.round(r.at * 10) / 10, fails: r.transitions > MAX_TRANSITIONS_PER_SEC },
    };
  }
}

module.exports = { FlashDetector, GRID_W, GRID_H, FRAME_BYTES, MAX_TRANSITIONS_PER_SEC, worstSecond, Tracker };
