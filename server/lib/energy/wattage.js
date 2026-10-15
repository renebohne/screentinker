'use strict';

/*
 * Energy & carbon (docs/energy.md): how many watts a screen draws when it is lit, and in standby.
 *
 * ⚠️ AN ESTIMATE, NEVER A MEASUREMENT. No player can read the panel's power meter, so every figure
 * here is a datasheet value, a formula, or a number somebody typed. Each answer carries `source`
 * so the report can say which of its screens are estimated and how, and an ESG appendix can repeat
 * it. The resolution order is the whole design:
 *
 *   1. override   a number the operator entered for this screen (or for its group, which writes the
 *                 same per-screen rows). The only figure that can come from a real meter reading.
 *   2. datasheet  the panel model matched in ./panels.json — manufacturer datasheets, each entry
 *                 citing the page its numbers were read from. No entry is invented: a model we
 *                 could not find a published figure for is simply absent.
 *   3. size       the panel's diagonal (EDID physical size, or the size printed in the model number)
 *                 through the EU energy-label formula, at an assumed efficiency (see below).
 *   4. default    the workspace's default, or the built-in default panel size through the same
 *                 formula. Flagged loudly: it means "we know nothing about this screen".
 *
 * Standby falls through the same ladder independently: an override, the datasheet, a workspace
 * default, else 0.5 W, the standby figure every curated panel that publishes one gives.
 */

const panels = require('./panels.json');
const { parseEdid } = require('../edid');

/*
 * EU energy label for electronic displays, Commission Delegated Regulation (EU) 2019/2013, Annex II:
 *
 *   EEI = (P_measured + 1) / (3 × [90 × tanh(0.025 + 0.0035 × (A − 11)) + 4] + 3 + corr_l)
 *
 * corr_l is 0 for televisions and monitors and 0.00062 × (lum − 500) × A for signage, lum being the
 * panel's peak white luminance. We do not know a screen's luminance, so corr_l is taken as 0 (a
 * 500 cd/m² panel); the brightness a signage panel actually runs at is absorbed into the assumed EEI.
 *
 * with A the viewing surface area in dm². Inverted, a panel of area A at efficiency index EEI draws
 *
 *   P = EEI × (3 × [90 × tanh(0.025 + 0.0035 × (A − 11)) + 4] + 3) − 1
 *
 * ⚠️ THE EEI IS AN ASSUMPTION and it is the single biggest one in this module. Signage panels run
 * far brighter than the televisions the label was calibrated on (typically 350-700 cd/m² against
 * ~250, and 2,500+ for window-facing panels), so they sit at the inefficient end of the scale. The
 * default is calibrated against the datasheet entries in ./panels.json (see `calibration` there and
 * docs/energy.md) rather than picked: it is the median EEI those published figures imply.
 */
const ASSUMED_EEI = panels.calibration && Number.isFinite(panels.calibration.median_eei)
  ? panels.calibration.median_eei : 1.0;
const CALIBRATION_SAMPLES = (panels.calibration && panels.calibration.samples) || 0;
const DEFAULT_DIAGONAL_IN = 55;      // the size a "we know nothing" screen is assumed to be
const DEFAULT_STANDBY_W = 0.5;       // what every curated panel with a standby figure publishes; docs/energy.md
const MIN_W = 0.1, MAX_W = 5000;     // an override outside this is a typo, not a panel

/** Viewing area in dm² of a 16:9 panel of this diagonal in inches. */
function areaDm2FromDiagonal(inches, aspectW = 16, aspectH = 9) {
  const diagCm = inches * 2.54;
  const k = diagCm / Math.hypot(aspectW, aspectH);
  return (k * aspectW * k * aspectH) / 100;
}

/** The EU-label on-mode power for a viewing area (dm²) at an efficiency index. */
function euLabelWatts(areaDm2, eei = ASSUMED_EEI) {
  const ref = 3 * (90 * Math.tanh(0.025 + 0.0035 * (areaDm2 - 11)) + 4) + 3;
  return Math.max(1, Math.round((eei * ref - 1) * 10) / 10);
}

/** The EEI a measured power implies for an area — used to calibrate ASSUMED_EEI (and by its test). */
function impliedEei(watts, areaDm2) {
  const ref = 3 * (90 * Math.tanh(0.025 + 0.0035 * (areaDm2 - 11)) + 4) + 3;
  return (watts + 1) / ref;
}

/*
 * Physical size from the EDID. Bytes 21-22 are the image size in whole centimetres; the first
 * detailed timing carries it in millimetres, which is better when it is there. ⚠️ Many televisions
 * write nonsense here — 0x0 (unknown), or an aspect ratio instead of a size (16x9 "cm"), or 160x90
 * for every model — so anything under 20 cm or over 400 cm wide is ignored rather than believed.
 */
function sizeFromEdid(raw) {
  if (!raw) return null;
  let e = null;
  try { e = parseEdid(raw); } catch { e = null; }
  if (!e) return null;
  let wCm = null, hCm = null;
  const dtd = e.detailedTimings && e.detailedTimings[0];
  if (dtd && dtd.widthMm > 0 && dtd.heightMm > 0) { wCm = dtd.widthMm / 10; hCm = dtd.heightMm / 10; }
  else if (e.widthCm > 0 && e.heightCm > 0) { wCm = e.widthCm; hCm = e.heightCm; }
  if (!wCm || !hCm || wCm < 20 || wCm > 400 || hCm < 10 || hCm > 400) return null;
  const diagIn = Math.round(Math.hypot(wCm, hCm) / 2.54);
  return { areaDm2: (wCm * hCm) / 100, diagonal_in: diagIn, monitor_name: e.monitorName || null };
}

/*
 * The diagonal printed in a model number. Only for naming schemes we can state as a rule, because a
 * wrong guess here is worse than "unknown": Samsung signage (QM55B, QB43B, OM55B, QH65C, QE50T...),
 * LG signage/TV (55UH5J, 49UH5F, 86UL3J, 55SM5KE...), Philips professional (55BDL4050D, 10BDL4551T),
 * Sharp/NEC MultiSync (ME551, MA551, P555 — the "55" after the series letters), Sony Bravia
 * Professional (FW-55BZ35L), iiyama ProLite (LH5560UHS — the first two digits).
 */
const SIZE_PATTERNS = [
  /\b(?:Q[MBHEP]|OM|OH|VM|VH)(\d{2,3})[A-Z]/i,       // Samsung short model (QM55B, OM55B)
  /\bLH(\d{2,3})(?:Q[MBHE]|OM|OH|VM|VH)/i,            // Samsung order code (LH55QMBEBGCXEN)
  /\b(\d{2,3})(?:UH|UL|UM|UN|SM|SE|XS|XE|VM|VL|VH|UR|TC|EJ|WS)\d?[A-Z0-9]/i, // LG
  /\b(\d{2,3})BDL\d/i,                                // Philips professional
  /\bM[AE]?(\d{2})1\b|\b[MPCVE](\d{2})5\b/i,           // Sharp/NEC MultiSync (ME551, MA551, P555, C651)
  /\bFW-?(\d{2,3})[A-Z]/i,                            // Sony Bravia Professional
  /\bL[HE](\d{2})\d{2}/i,                             // iiyama ProLite
];
function sizeFromModel(model) {
  if (!model || typeof model !== 'string') return null;
  for (const re of SIZE_PATTERNS) {
    const m = re.exec(model);
    const n = m && Number(m[1] || m[2]);
    if (n && n >= 10 && n <= 120) return { diagonal_in: n, areaDm2: areaDm2FromDiagonal(n) };
  }
  return null;
}

function norm(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

/*
 * Match a device to a curated panel entry. Every candidate string the device has told us about is
 * tried against each entry's `match` keys (normalised, prefix match so a regional suffix such as
 * QM55B-T or LH55QMBEBGCXEN still finds QM55B). Longest key wins, so QM55B beats QM55.
 */
function panelFor(candidates) {
  const keys = candidates.filter(Boolean).map(norm).filter((k) => k.length >= 4);
  if (!keys.length) return null;
  let best = null, bestLen = 0;
  for (const p of panels.panels || []) {
    for (const m of p.match || []) {
      const mk = norm(m);
      if (mk.length < 4 || mk.length <= bestLen) continue;
      if (keys.some((k) => k.startsWith(mk) || k.includes(mk))) { best = p; bestLen = mk.length; }
    }
  }
  return best;
}

function validWatts(v) { return typeof v === 'number' && Number.isFinite(v) && v >= MIN_W && v <= MAX_W; }

/**
 * Resolve one screen's wattage.
 *
 * @param {object} device   a devices row (hardware_model, hardware_edid) + optional attached_display
 * @param {object|null} override   energy_device_settings row
 * @param {object|null} wsSettings energy_settings row (default_on_watts / default_standby_watts)
 * @returns {{on_watts, standby_watts, source, standby_source, detail, diagonal_in}}
 */
function resolveWatts(device, override, wsSettings) {
  const d = device || {};
  const edid = sizeFromEdid(d.hardware_edid);
  const candidates = [d.hardware_model, edid && edid.monitor_name, d.attached_display];
  const panel = panelFor(candidates);
  let on = null, source = null, detail = null, diag = null;

  if (override && validWatts(override.on_watts)) {
    on = override.on_watts; source = 'override';
  } else if (panel && validWatts(panel.on_watts)) {
    on = panel.on_watts; source = 'datasheet'; detail = `${panel.manufacturer} ${panel.model}`; diag = panel.diagonal_in || null;
  } else {
    const size = edid || sizeFromModel(d.hardware_model) || sizeFromModel(edid && edid.monitor_name) || sizeFromModel(d.attached_display);
    if (size) {
      on = euLabelWatts(size.areaDm2); source = 'size'; diag = size.diagonal_in;
      detail = `${size.diagonal_in}"`;
    } else if (wsSettings && validWatts(wsSettings.default_on_watts)) {
      on = wsSettings.default_on_watts; source = 'workspace_default';
    } else {
      on = euLabelWatts(areaDm2FromDiagonal(DEFAULT_DIAGONAL_IN)); source = 'default'; diag = DEFAULT_DIAGONAL_IN;
      detail = `${DEFAULT_DIAGONAL_IN}"`;
    }
  }

  let standby = null, standbySource = null;
  if (override && typeof override.standby_watts === 'number' && override.standby_watts >= 0 && override.standby_watts <= MAX_W) {
    standby = override.standby_watts; standbySource = 'override';
  } else if (source !== 'override' && panel && typeof panel.standby_watts === 'number') {
    standby = panel.standby_watts; standbySource = 'datasheet';
  } else if (wsSettings && typeof wsSettings.default_standby_watts === 'number' && wsSettings.default_standby_watts >= 0) {
    standby = wsSettings.default_standby_watts; standbySource = 'workspace_default';
  } else {
    standby = DEFAULT_STANDBY_W; standbySource = 'default';
  }
  // Standby above on-power is a data-entry slip; never let "savings" go negative because of it.
  if (standby > on) standby = on;
  return { on_watts: on, standby_watts: standby, source, standby_source: standbySource, detail, diagonal_in: diag,
    panel_source_url: source === 'datasheet' && panel ? panel.source_url || null : null };
}

module.exports = {
  resolveWatts, euLabelWatts, impliedEei, areaDm2FromDiagonal, sizeFromEdid, sizeFromModel, panelFor, validWatts,
  ASSUMED_EEI, CALIBRATION_SAMPLES, DEFAULT_DIAGONAL_IN, DEFAULT_STANDBY_W, MIN_W, MAX_W,
};
