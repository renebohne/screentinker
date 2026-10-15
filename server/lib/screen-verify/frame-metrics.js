'use strict';

/*
 * Screen verification: what a captured frame LOOKS like, as a handful of numbers.
 *
 * Pure arithmetic on an RGBA bitmap ({ data, width, height }), so it needs no decoder and is tested
 * against hand-built bitmaps where the right answer is known exactly. It runs inside the image-ops
 * worker (lib/image-ops-core.frameMetrics) and never on the event loop: a 1920x1080 frame is two
 * million pixels, and #240 is what happens when that much work lands on the main thread.
 *
 * Everything downstream (lib/screen-verify/classify.js) works on the SMALL outputs below, never on
 * pixels, so the comparisons are cheap enough to keep a short history per screen in memory:
 *
 *   mean, std     luma mean and standard deviation (0..255) over a ~160px-wide downsample
 *   colorStd      mean per-channel standard deviation, so a saturated flat colour is still flat
 *   edge          fraction of downsample pixels with a strong local gradient — text, borders,
 *                 anything drawn. A blank frame has essentially none; the sparsest real sign has
 *                 a few percent.
 *   dom           the most common colour (binned at 4 bits per channel; reported as the bin's
 *                 mean) and the fraction of pixels in it
 *   grid          64x36 luma means (Uint8Array, row-major) — the frame stretched to a fixed grid,
 *                 so frames of different sizes compare cell for cell
 *   hash          64-bit difference hash (16 hex chars), a coarse "same picture?" check
 *   width/height  of the source, so the comparator knows the real aspect ratio
 *
 * The 160px working size is deliberate: big enough that a line of 20px text on a 1080p screen
 * still registers as edges, small enough that the whole pass is a few milliseconds.
 */

const GRID_W = 64;
const GRID_H = 36;
const WORK_W = 160;
const EDGE_STEP = 24;   // a luma step this large between neighbours is "something drawn"

function luma(r, g, b) { return (r * 299 + g * 587 + b * 114) / 1000; }

/**
 * Box-average the bitmap into a w x h grid of luma (Float64Array) and, optionally, RGB.
 * Every source pixel lands in exactly one cell, so nothing is skipped however large the source.
 */
function boxDownsample(bitmap, w, h, withRgb) {
  const { data, width, height } = bitmap;
  const sum = new Float64Array(w * h);
  const cnt = new Uint32Array(w * h);
  const rgb = withRgb ? new Float64Array(w * h * 3) : null;
  for (let y = 0; y < height; y++) {
    const gy = Math.min(h - 1, Math.floor((y * h) / height));
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const gx = Math.min(w - 1, Math.floor((x * w) / width));
      const i = row + x * 4;
      const cell = gy * w + gx;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      sum[cell] += luma(r, g, b);
      cnt[cell]++;
      if (rgb) { rgb[cell * 3] += r; rgb[cell * 3 + 1] += g; rgb[cell * 3 + 2] += b; }
    }
  }
  for (let c = 0; c < w * h; c++) {
    const n = cnt[c] || 1;
    sum[c] /= n;
    if (rgb) { rgb[c * 3] /= n; rgb[c * 3 + 1] /= n; rgb[c * 3 + 2] /= n; }
  }
  return { luma: sum, rgb };
}

function dhash(grid, gw, gh) {
  // 9x8 means from the grid, then one bit per horizontal neighbour comparison.
  const cols = 9, rows = 8;
  const small = new Float64Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const x0 = Math.floor((x * gw) / cols), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * gw) / cols));
      const y0 = Math.floor((y * gh) / rows), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * gh) / rows));
      let s = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { s += grid[yy * gw + xx]; n++; }
      small[y * cols + x] = s / (n || 1);
    }
  }
  let hex = '';
  for (let y = 0; y < rows; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (small[y * cols + x] > small[y * cols + x + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** The metrics described at the top of this file. Throws only on a bitmap with no pixels. */
function metricsFromBitmap(bitmap) {
  const { width, height } = bitmap || {};
  if (!bitmap || !bitmap.data || !(width > 0) || !(height > 0)) throw new Error('empty bitmap');

  const workW = Math.min(WORK_W, width);
  const workH = Math.max(1, Math.min(height, Math.round((workW * height) / width)));
  const work = boxDownsample(bitmap, workW, workH, true);
  const n = workW * workH;

  let s = 0, s2 = 0;
  const cs = [0, 0, 0], cs2 = [0, 0, 0];
  const hist = new Map();
  for (let i = 0; i < n; i++) {
    const l = work.luma[i];
    s += l; s2 += l * l;
    const r = work.rgb[i * 3], g = work.rgb[i * 3 + 1], b = work.rgb[i * 3 + 2];
    cs[0] += r; cs[1] += g; cs[2] += b;
    cs2[0] += r * r; cs2[1] += g * g; cs2[2] += b * b;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = hist.get(key);
    if (bin) { bin[0]++; bin[1] += r; bin[2] += g; bin[3] += b; } else hist.set(key, [1, r, g, b]);
  }
  const mean = s / n;
  const std = Math.sqrt(Math.max(0, s2 / n - mean * mean));
  let colorStd = 0;
  for (let c = 0; c < 3; c++) { const m = cs[c] / n; colorStd += Math.sqrt(Math.max(0, cs2[c] / n - m * m)); }
  colorStd /= 3;

  // The mean colour of the fullest bin, not the bin's centre: JPEG nudges a flat colour across a
  // bin edge often enough (#111827's red lands at 15 or 17) that the centre is not a stable name.
  let dombin = null;
  for (const v of hist.values()) if (!dombin || v[0] > dombin[0]) dombin = v;
  const dom = { rgb: [Math.round(dombin[1] / dombin[0]), Math.round(dombin[2] / dombin[0]), Math.round(dombin[3] / dombin[0])], frac: dombin[0] / n };

  // Edge density: a pixel is an edge when it differs sharply from its right or lower neighbour.
  let edges = 0, considered = 0;
  for (let y = 0; y < workH - 1; y++) {
    for (let x = 0; x < workW - 1; x++) {
      const i = y * workW + x;
      const dx = Math.abs(work.luma[i] - work.luma[i + 1]);
      const dy = Math.abs(work.luma[i] - work.luma[i + workW]);
      if (dx + dy >= EDGE_STEP) edges++;
      considered++;
    }
  }
  const edge = considered ? edges / considered : 0;

  const g = boxDownsample(bitmap, GRID_W, GRID_H, false).luma;
  const grid = new Uint8Array(GRID_W * GRID_H);
  for (let i = 0; i < grid.length; i++) grid[i] = Math.max(0, Math.min(255, Math.round(g[i])));

  return {
    width, height,
    mean: round2(mean), std: round2(std), colorStd: round2(colorStd), edge: round4(edge),
    dom: { rgb: dom.rgb, frac: round4(dom.frac) },
    grid, hash: dhash(grid, GRID_W, GRID_H),
  };
}

function round2(v) { return Math.round(v * 100) / 100; }
function round4(v) { return Math.round(v * 10000) / 10000; }

module.exports = { metricsFromBitmap, GRID_W, GRID_H };
