'use strict';

/*
 * Is the text big enough for the distance people read it from?
 *
 * ⚠️ THE RULE, AND WHERE IT COMES FROM (docs/accessibility.md has the long version).
 * Legibility depends on the ANGLE a letter subtends at the eye, not on its pixel size: a 40px line
 * is huge on a phone and unreadable on a 4K wall across a hall. So we work out the physical height of
 * a capital letter on the actual screen and the angle it makes at the viewing distance, and compare
 * that with two published numbers:
 *
 *   16 arcminutes — the MINIMUM character height for reading tasks in ISO 9241-303:2011 (and
 *                   ANSI/HFES 100-2007, which uses the same figure; 20-22' is "preferred"). In plain
 *                   terms: cap height ≥ distance / 215. Below this we WARN.
 *   10 arcminutes — twice the 5' letter of the 20/20 Snellen line, i.e. what a person with 20/40
 *                   vision (the usual driving standard; many older viewers are there) can just make
 *                   out at all. Below this the text is unreadable for a large share of any audience:
 *                   that is an ERROR.
 *
 * The often-quoted signage rule of thumb "letter height ≥ distance / 200" is ≈17', i.e. the same
 * place as the ISO minimum.
 *
 * ⚠️ WHAT WE CAN AND CANNOT KNOW. Physical size comes from, in order: the screen's own override,
 * its EDID (when the panel reports a believable size), the workspace default. The cap height is
 * taken as 0.7 em, which is right for the bundled sans faces (Inter 0.73, Archivo 0.70) and close
 * for most others. Pixel-sized widget text assumes the widget fills the screen at the panel's CSS
 * resolution — a widget in a small zone is smaller than that, never larger, so the check can only
 * err towards passing text it should not.
 */

const CAP_RATIO = 0.7;
const WARN_ARCMIN = 16;
const ERROR_ARCMIN = 10;
const MM_PER_IN = 25.4;

const DEFAULT_DISTANCE_M = 3;
const DEFAULT_DIAGONAL_IN = 55;

/** Physical width and height (mm) of a screen with this diagonal and pixel shape (16:9 if unknown). */
function screenSize(diagonalIn, pxW, pxH) {
  const d = Number(diagonalIn) > 0 ? Number(diagonalIn) : DEFAULT_DIAGONAL_IN;
  let w = Number(pxW) > 0 ? Number(pxW) : 1920;
  let h = Number(pxH) > 0 ? Number(pxH) : 1080;
  const diagPx = Math.hypot(w, h);
  const mmPerPx = (d * MM_PER_IN) / diagPx;
  return { widthMm: w * mmPerPx, heightMm: h * mmPerPx, pxW: w, pxH: h };
}

/** The angle (arcminutes) an object `mm` tall subtends at `distanceM`. */
function arcmin(mm, distanceM) {
  const d = (Number(distanceM) > 0 ? Number(distanceM) : DEFAULT_DISTANCE_M) * 1000;
  return (2 * Math.atan(mm / (2 * d)) * 180 / Math.PI) * 60;
}

/** The angle (degrees) a font size subtends — what lib/a11y/contrast.isLarge compares. */
function fontDegrees(fontMm, distanceM) {
  return arcmin(fontMm, distanceM) / 60;
}

/** The smallest font size (mm) whose capitals reach `target` arcminutes at this distance. */
function minFontMm(distanceM, target = WARN_ARCMIN) {
  const d = (Number(distanceM) > 0 ? Number(distanceM) : DEFAULT_DISTANCE_M) * 1000;
  const cap = 2 * d * Math.tan((target / 60) * Math.PI / 180 / 2);
  return cap / CAP_RATIO;
}

/**
 * The verdict for one run of text.
 * @returns {{ level: 'ok'|'warning'|'error', arcmin, capMm, fontMm, minFontMm }}
 */
function assess(fontMm, distanceM) {
  const capMm = fontMm * CAP_RATIO;
  const a = arcmin(capMm, distanceM);
  const level = a < ERROR_ARCMIN ? 'error' : a < WARN_ARCMIN ? 'warning' : 'ok';
  return {
    level,
    arcmin: Math.round(a * 10) / 10,
    capMm: Math.round(capMm * 10) / 10,
    fontMm: Math.round(fontMm * 10) / 10,
    minFontMm: Math.round(minFontMm(distanceM) * 10) / 10,
  };
}

module.exports = {
  CAP_RATIO, WARN_ARCMIN, ERROR_ARCMIN, DEFAULT_DISTANCE_M, DEFAULT_DIAGONAL_IN,
  screenSize, arcmin, fontDegrees, minFontMm, assess,
};
