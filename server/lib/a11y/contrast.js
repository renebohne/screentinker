'use strict';

/*
 * Colour contrast, exactly as WCAG 2.x defines it.
 *
 *   relative luminance  L = 0.2126 R + 0.7152 G + 0.0722 B, each channel linearised from sRGB
 *   contrast ratio      (L1 + 0.05) / (L2 + 0.05), L1 the lighter
 *   AA                  4.5:1 for normal text, 3:1 for large text (SC 1.4.3)
 *
 * ⚠️ THE 0.03928 / 0.04045 QUESTION. WCAG 2.x's text says 0.03928, sRGB's own spec says 0.04045.
 * The two differ only for channel values 11 and 12 (out of 255) and the difference in the ratio is
 * below the fourth decimal. We use 0.04045 (the sRGB value, which WCAG's editors acknowledge is the
 * correct one); the published reference pairs in the tests come out the same either way.
 *
 * Pure functions, no I/O: the rest of lib/a11y and the browser-facing fix suggestions both lean on
 * these, and the tests check them against the published reference values.
 */

const AA_NORMAL = 4.5;
const AA_LARGE = 3;

/** '#RGB' / '#RRGGBB' (case-insensitive) → [r, g, b] 0-255, or null. Alpha forms are refused. */
function parseHex(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return m[1].split('').map((c) => parseInt(c + c, 16));
  return null;
}

function toHex(rgb) {
  return '#' + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function linear(c8) {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an [r,g,b] (0-255) or a hex string. 0 (black) … 1 (white). */
function luminance(c) {
  const rgb = Array.isArray(c) ? c : parseHex(c);
  if (!rgb) return null;
  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

/** Contrast between two luminances. */
function ratioOfLuminances(a, b) {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Contrast ratio between two colours (hex or rgb arrays); null when either is not a colour. */
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  if (la == null || lb == null) return null;
  return ratioOfLuminances(la, lb);
}

/** `fg` painted at `alpha` over `bg` (both rgb arrays): what the eye actually receives. */
function blend(fg, bg, alpha) {
  const a = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 1));
  return fg.map((v, i) => v * a + bg[i] * (1 - a));
}

/*
 * The threshold a run of text needs: 3:1 if it is "large", 4.5:1 otherwise.
 *
 * WCAG's "large" is 18pt, or 14pt bold — 24 and 18.67 CSS px. On a screen across a room that rule
 * cannot be applied in pixels: a 24px line on a 4K panel seen from 6 m is tiny, while 20px on a
 * phone at arm's length is not. The CSS reference pixel is DEFINED as an angle (0.0213°, one pixel
 * seen at 28 inches), so the honest translation is to compare the text's angular size with the
 * angle 24px / 18.67px subtend: that is what "18pt" meant to WCAG's authors in the first place.
 * The caller computes the angle (lib/a11y/legibility.js); this only applies the rule.
 */
const REF_PX_DEG = 0.0213;
const LARGE_DEG = 24 * REF_PX_DEG;        // ≈ 0.511°
const LARGE_BOLD_DEG = 18.67 * REF_PX_DEG; // ≈ 0.398°

function isLarge(fontDeg, weight) {
  if (!Number.isFinite(fontDeg)) return false;
  return fontDeg >= (Number(weight) >= 700 ? LARGE_BOLD_DEG : LARGE_DEG);
}

function required(large) { return large ? AA_LARGE : AA_NORMAL; }

/* ---------------------------------------------------------------- suggestions */

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

/*
 * The colour nearest to `fg` (same hue and saturation, only lightness moved) that reaches `target`
 * against `bg`. Both directions are tried — darker and lighter — and the one that needs the smaller
 * change wins, so a brand colour keeps its character instead of collapsing to black or white.
 *
 * ⚠️ A small margin over the target (0.05) so a colour that rounds to exactly 4.50 on the server
 * cannot read as 4.49 after a browser's colour input rounds it. Returns null only if neither end
 * reaches the target, which cannot happen for target ≤ 4.58 (black and white bracket every bg).
 */
function suggest(fg, bg, target = AA_NORMAL) {
  const f = Array.isArray(fg) ? fg : parseHex(fg);
  const b = Array.isArray(bg) ? bg : parseHex(bg);
  if (!f || !b) return null;
  const want = target + 0.05;
  const lb = luminance(b);
  if (ratioOfLuminances(luminance(f), lb) >= want) return toHex(f);
  const [h, s, l0] = rgbToHsl(f);
  const tryDir = (dir) => {
    // Binary search on lightness between the current value and the end of this direction.
    let lo = l0, hi = dir > 0 ? 1 : 0;
    const ok = (l) => ratioOfLuminances(luminance(hslToRgb([h, s, l]).map(Math.round)), lb) >= want;
    if (!ok(hi)) return null;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) hi = mid; else lo = mid;
    }
    return { l: hi, d: Math.abs(hi - l0) };
  };
  const up = tryDir(1);
  const down = tryDir(-1);
  const best = [up, down].filter(Boolean).sort((x, y) => x.d - y.d)[0];
  if (!best) return null;
  return toHex(hslToRgb([h, s, best.l]).map(Math.round));
}

/** White or black, whichever reads better on `bg` — the fallback when there is no colour to keep. */
function bestInk(bg) {
  const b = Array.isArray(bg) ? bg : parseHex(bg);
  if (!b) return '#FFFFFF';
  return contrast([255, 255, 255], b) >= contrast([0, 0, 0], b) ? '#FFFFFF' : '#000000';
}

module.exports = {
  AA_NORMAL, AA_LARGE, LARGE_DEG, LARGE_BOLD_DEG, REF_PX_DEG,
  parseHex, toHex, luminance, ratioOfLuminances, contrast, blend, isLarge, required, suggest, bestInk,
};
