'use strict';

/*
 * One run of text against what is behind it: contrast (WCAG 1.4.3) and size for the viewing
 * distance (lib/a11y/legibility.js). Shared by the slide checker and the widget checker, so a
 * sentence about "white on yellow" means the same thing wherever it appears.
 *
 * A background is one of:
 *   { rgb: [r,g,b] }                 a solid colour, exactly known
 *   { range: [lo, hi], approx: true } the luminance spread of the photo under the text (10th and
 *                                    90th percentile of the sampled cells), after any dim scrim
 *   { unknown: 'video' | 'image' | 'transparent' | 'html' | 'pending' }  nothing we can measure
 *
 * ⚠️ AN UNKNOWN BACKGROUND IS A NOTE, NEVER A PASS AND NEVER AN ERROR. Text over a video or over an
 * image we could not read might be perfectly legible; saying "fine" would be a lie and saying
 * "error" would train people to ignore the report. "We could not check this" is the true answer.
 */

const C = require('./contrast');
const L = require('./legibility');

const round2 = (n) => Math.round(n * 100) / 100;
/** An achromatic colour of a given relative luminance — what a suggestion is computed against. */
function greyOf(lum) {
  // Inverse of the sRGB transfer, one channel.
  const c = lum <= 0.0031308 ? lum * 12.92 : 1.055 * lum ** (1 / 2.4) - 0.055;
  const v = Math.round(Math.min(1, Math.max(0, c)) * 255);
  return [v, v, v];
}

/**
 * @param {object} run  { text, color, opacity, weight, fontMm, bg }
 * @param {object} view { distanceM }
 * @returns {Array<object>} issues: { code, severity, values, fix? }
 */
function checkRun(run, view) {
  const out = [];
  const fg = C.parseHex(run.color);
  const opacity = Number.isFinite(run.opacity) ? run.opacity : 1;
  const deg = L.fontDegrees(run.fontMm, view.distanceM);
  const large = C.isLarge(deg, run.weight);
  const need = C.required(large);

  // ---- contrast
  if (fg && run.bg && run.bg.rgb) {
    const seen = C.blend(fg, run.bg.rgb, opacity);
    const ratio = C.contrast(seen, run.bg.rgb);
    if (ratio < need) {
      // The suggestion is for the colour itself; if the shortfall is the element's opacity, the
      // suggestion is the colour at full opacity (and the fix sets opacity to 1 as well).
      const suggested = C.suggest(fg, run.bg.rgb, need);
      out.push({
        code: 'contrast', severity: 'error',
        values: { ratio: round2(ratio), required: need, large, fg: C.toHex(fg), bg: C.toHex(run.bg.rgb), opacity, suggested },
        fix: suggested ? { kind: 'color', color: suggested, opacity: opacity < 1 ? 1 : undefined } : null,
      });
    }
  } else if (fg && run.bg && run.bg.range) {
    const lt = C.luminance(fg);
    const [lo, hi] = run.bg.range;
    // The cell closest in brightness to the text is the one that reads worst.
    const worstBg = lt >= hi ? hi : lt <= lo ? lo : (lt - lo < hi - lt ? lo : hi);
    const mix = (lb) => opacity * lt + (1 - opacity) * lb;
    const inside = lt > lo && lt < hi;
    const ratio = inside ? 1 : C.ratioOfLuminances(mix(worstBg), worstBg);
    if (ratio < need) {
      const suggested = C.suggest(fg, greyOf(worstBg), need);
      out.push({
        code: 'contrast_image', severity: inside ? 'warning' : 'error',
        values: { ratio: round2(ratio), required: need, large, fg: C.toHex(fg), bg_range: [round2(lo), round2(hi)], suggested, dim: run.bg.dim || 0 },
        fix: { kind: 'dim', dim: Math.min(0.85, Math.max(0.45, (run.bg.dim || 0) + 0.3)), color: suggested },
      });
    }
  } else if (fg && run.bg && run.bg.unknown) {
    out.push({ code: 'contrast_unverified', severity: 'note', values: { why: run.bg.unknown, fg: C.toHex(fg) } });
  }

  // ---- size
  if (Number.isFinite(run.fontMm) && run.fontMm > 0) {
    const a = L.assess(run.fontMm, view.distanceM);
    if (a.level !== 'ok') {
      out.push({
        code: 'text_small', severity: a.level,
        values: { arcmin: a.arcmin, cap_mm: a.capMm, font_mm: a.fontMm, min_font_mm: a.minFontMm, distance_m: view.distanceM },
        fix: { kind: 'size', scale: Math.min(4, Math.ceil((a.minFontMm / a.fontMm) * 100) / 100) },
      });
    }
  }
  return out;
}

module.exports = { checkRun, greyOf };
