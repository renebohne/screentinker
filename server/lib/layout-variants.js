'use strict';

/*
 * Orientation variants of a layout (docs/layouts-and-campaigns.md, "Portrait and 4:3 versions").
 *
 * Zones are percentages, so a layout already scales to any RESOLUTION; what it cannot survive is a
 * different SHAPE. A 16:9 menu board drawn on a portrait screen squashes three side-by-side columns
 * into slivers. A layout may therefore carry a portrait version and a 4:3-ish ("square") version:
 * the SAME zones — same ids, so every playlist item bound to a zone plays in that zone in every
 * version — with their own x/y/w/h.
 *
 * ⚠️ WHY A SEPARATE TABLE (layout_zone_variants) AND NOT layout_zones COLUMNS. Every payload builds
 * its zone list with `SELECT * FROM layout_zones`; eight new columns there would put eight new
 * fields into every screen's payload, variant or not. A side table changes nothing for a layout
 * without versions: the payload is byte-identical (test/layout-variants.test.js proves it), and a
 * screen that gets a version simply receives different numbers in the same fields. Players need no
 * change at all.
 *
 * The SCREEN decides which version it gets, at payload time, from what it really is: the dashboard
 * orientation setting and the resolution the player reported (canvasVariant below). A version the
 * layout does not have falls back to the default geometry — today's behaviour.
 */

const VARIANTS = ['portrait', 'square'];
const GEOM = ['x_percent', 'y_percent', 'width_percent', 'height_percent'];

/*
 * The shape of the canvas a screen draws on.
 *
 *   - a portrait orientation turns a landscape panel (the player rotates its output), so its
 *     reported 1920x1080 is a 1080x1920 canvas; a panel that already reports a portrait size is not
 *     turned twice (some players report the size after rotation);
 *   - a landscape setting on a panel that reports a portrait size is a natively portrait panel;
 *   - no reported size: assume 16:9, so the orientation setting alone decides.
 *
 * aspect < 0.8 -> 'portrait' (9:16 is 0.56, 3:4 is 0.75); 0.8..1.45 -> 'square' (1:1, 5:4, 4:3 = 1.33);
 * anything wider -> null, the default geometry (16:10 is 1.6, 16:9 is 1.78).
 */
function canvasVariant(device) {
  if (!device) return null;
  let w = Number(device.screen_width);
  let h = Number(device.screen_height);
  if (!(w > 0 && h > 0)) { w = 16; h = 9; }
  let aspect = w / h;
  if (/^portrait/.test(String(device.orientation || '')) && aspect > 1) aspect = 1 / aspect;
  if (aspect < 0.8) return 'portrait';
  if (aspect <= 1.45) return 'square';
  return null;
}

/** The variant a preview drawn at `orientation` shows (the dashboard's landscape/portrait toggle). */
function orientationVariant(orientation) {
  return /^portrait/.test(String(orientation || '')) ? 'portrait' : null;
}

function hasTable(db) {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'layout_zone_variants'").get(); }
  catch (_) { return false; }
}

/** { zone_id: { portrait: {x,y,w,h}, square: {...} } } for one layout. */
function variantsOf(db, layoutId) {
  const out = {};
  if (!layoutId || !hasTable(db)) return out;
  for (const r of db.prepare('SELECT zone_id, variant, x_percent, y_percent, width_percent, height_percent FROM layout_zone_variants WHERE layout_id = ?').all(layoutId)) {
    (out[r.zone_id] = out[r.zone_id] || {})[r.variant] = { x_percent: r.x_percent, y_percent: r.y_percent, width_percent: r.width_percent, height_percent: r.height_percent };
  }
  return out;
}

/** Which versions a layout has (for the layouts list and the editor). */
function variantNames(db, layoutId) {
  if (!layoutId || !hasTable(db)) return [];
  return db.prepare('SELECT DISTINCT variant FROM layout_zone_variants WHERE layout_id = ? ORDER BY variant').all(layoutId).map((r) => r.variant);
}

/**
 * Put `variant`'s geometry onto a loaded layout's zones, in place. Does NOTHING (not even add a
 * field) when the variant is null or the layout has no such version, so the default stays
 * byte-identical. When applied: the zones carry the version's numbers, `layout.variant` names it,
 * and width/height describe the version's canvas (a portrait version of 1920x1080 is 1080x1920).
 */
function applyVariant(db, layout, variant) {
  if (!layout || !variant || !VARIANTS.includes(variant) || !Array.isArray(layout.zones) || !layout.zones.length) return layout;
  if (!hasTable(db)) return layout;
  const rows = db.prepare('SELECT zone_id, x_percent, y_percent, width_percent, height_percent FROM layout_zone_variants WHERE layout_id = ? AND variant = ?').all(layout.id, variant);
  if (!rows.length) return layout;
  const by = new Map(rows.map((r) => [r.zone_id, r]));
  for (const z of layout.zones) {
    const r = by.get(z.id);
    if (!r) continue;   // a zone added after the version was made keeps its default place
    for (const k of GEOM) z[k] = r[k];
  }
  layout.variant = variant;
  const W = Number(layout.width) || 1920, H = Number(layout.height) || 1080;
  if (variant === 'portrait' && W > H) { layout.width = H; layout.height = W; }
  if (variant === 'square') { const s = Math.max(W, H); layout.width = s; layout.height = Math.round(s * 3 / 4); }
  return layout;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * A sensible STARTING arrangement for a version, from the default geometry — the person adjusts it
 * in the editor. Never final, so it aims for "nothing is broken" rather than "beautiful":
 *
 *   - a full-width banner (a ticker, a header) stays full width, at the same end of the screen, and
 *     keeps its height in PIXELS (a 10%-tall ticker on 1080 lines is 108px; on a 1920-line portrait
 *     canvas that is 5.6%), so it does not become a slab;
 *   - everything else lives in the band between the banners and is TRANSPOSED within it: what sat
 *     side by side now stacks top to bottom, in the same order, keeping each zone's share.
 *
 * Transposing a rectangle set inside a rectangle is a bijection, so zones that did not overlap
 * still do not, and nothing leaves the canvas (test/layout-variants.test.js checks both). The
 * square version uses the same rule with a milder banner rescale and no transpose — a 4:3 screen
 * is still landscape, so side-by-side zones stay side by side.
 *
 * @param {Array<{id, x_percent, y_percent, width_percent, height_percent}>} zones
 * @param {'portrait'|'square'} variant
 * @param {{width?:number,height?:number}} [canvas] the default canvas (1920x1080 when omitted)
 * @returns {Object<string,{x_percent,y_percent,width_percent,height_percent}>} by zone id
 */
function autoArrange(zones, variant, canvas = {}) {
  const out = {};
  const list = Array.isArray(zones) ? zones.filter((z) => z && z.id) : [];
  if (!list.length) return out;
  const W = Number(canvas.width) || 1920, H = Number(canvas.height) || 1080;
  // New canvas height in the default canvas's pixels-per-percent terms.
  const target = variant === 'portrait' ? { w: Math.min(W, H), h: Math.max(W, H) } : { w: Math.max(W, H), h: Math.round(Math.max(W, H) * 3 / 4) };
  const hScale = H / target.h;   // how a height in default-% becomes a height in new-% at the same pixels
  const g = (z) => ({ x: Number(z.x_percent) || 0, y: Number(z.y_percent) || 0, w: Number(z.width_percent) || 0, h: Number(z.height_percent) || 0 });

  const banners = list.filter((z) => g(z).w >= 95);
  const body = list.filter((z) => g(z).w < 95);
  // Banners split into the top stack and the bottom stack by which half their centre is in.
  const top = banners.filter((z) => g(z).y + g(z).h / 2 < 50).sort((a, b) => g(a).y - g(b).y);
  const bottom = banners.filter((z) => g(z).y + g(z).h / 2 >= 50).sort((a, b) => g(a).y - g(b).y);
  // Banner heights in the new canvas; never more than 40% of it between them.
  let bh = new Map(banners.map((z) => [z.id, g(z).h * hScale]));
  const total = [...bh.values()].reduce((a, b) => a + b, 0);
  if (total > 40) bh = new Map([...bh].map(([k, v]) => [k, v * 40 / total]));
  let y = 0;
  for (const z of top) { out[z.id] = { x_percent: 0, y_percent: r2(y), width_percent: 100, height_percent: r2(bh.get(z.id)) }; y += bh.get(z.id); }
  const bandTop = y;
  let yb = 100;
  for (const z of bottom.slice().reverse()) { yb -= bh.get(z.id); out[z.id] = { x_percent: 0, y_percent: r2(yb), width_percent: 100, height_percent: r2(bh.get(z.id)) }; }
  const bandBottom = yb;

  // The body's band in the DEFAULT layout: between the default banners (or the whole height).
  const oTop = top.length ? Math.max(...top.map((z) => g(z).y + g(z).h)) : 0;
  const oBot = bottom.length ? Math.min(...bottom.map((z) => g(z).y)) : 100;
  const oSpan = Math.max(1, oBot - oTop);
  const nSpan = Math.max(1, bandBottom - bandTop);
  for (const z of body) {
    const q = g(z);
    const ry = clamp((q.y - oTop) / oSpan, 0, 1);
    const rh = clamp(q.h / oSpan, 0, 1 - ry);
    const rx = clamp(q.x / 100, 0, 1);
    const rw = clamp(q.w / 100, 0, 1 - rx);
    let n;
    if (variant === 'portrait') {
      // Transpose within the band: x <- relative y, y <- relative x.
      n = { x: ry * 100, y: bandTop + rx * nSpan, w: rh * 100, h: rw * nSpan };
    } else {
      n = { x: rx * 100, y: bandTop + ry * nSpan, w: rw * 100, h: rh * nSpan };
    }
    const x = clamp(r2(n.x), 0, 100), yy = clamp(r2(n.y), 0, 100);
    out[z.id] = { x_percent: x, y_percent: yy, width_percent: clamp(r2(n.w), 0, r2(100 - x)), height_percent: clamp(r2(n.h), 0, r2(100 - yy)) };
  }
  return out;
}

/**
 * Write the versions sent with a layout save. `zones[i].variants` absent = leave that zone's
 * versions alone (an older editor); `{portrait: null}` removes one. Out-of-range numbers are
 * clamped into the canvas rather than refused: a stray 100.4 from a drag is not worth a 400.
 */
function writeZoneVariants(db, layoutId, zones) {
  if (!hasTable(db) || !Array.isArray(zones)) return;
  const del = db.prepare('DELETE FROM layout_zone_variants WHERE zone_id = ? AND variant = ?');
  const up = db.prepare(`INSERT INTO layout_zone_variants (zone_id, layout_id, variant, x_percent, y_percent, width_percent, height_percent)
                         VALUES (?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(zone_id, variant) DO UPDATE SET x_percent = excluded.x_percent, y_percent = excluded.y_percent,
                           width_percent = excluded.width_percent, height_percent = excluded.height_percent`);
  const own = db.prepare('SELECT 1 FROM layout_zones WHERE id = ? AND layout_id = ?');
  for (const z of zones) {
    if (!z || !z.id || !z.variants || typeof z.variants !== 'object') continue;
    if (!own.get(z.id, layoutId)) continue;   // never a version for another layout's zone
    for (const v of VARIANTS) {
      if (!(v in z.variants)) continue;
      const geo = z.variants[v];
      if (geo === null) { del.run(z.id, v); continue; }
      if (!geo || typeof geo !== 'object') continue;
      const x = clamp(Number(geo.x_percent) || 0, 0, 100);
      const y = clamp(Number(geo.y_percent) || 0, 0, 100);
      const w = clamp(Number(geo.width_percent) || 0, 1, 100 - x || 1);
      const h = clamp(Number(geo.height_percent) || 0, 1, 100 - y || 1);
      up.run(z.id, layoutId, v, x, y, w, h);
    }
  }
}

module.exports = { VARIANTS, canvasVariant, orientationVariant, variantsOf, variantNames, applyVariant, autoArrange, writeZoneVariants };
