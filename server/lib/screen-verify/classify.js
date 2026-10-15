'use strict';

/*
 * Screen verification: the DECISIONS, kept pure so every rule is tested without a socket, a
 * database or a decoder. Input is the small metric objects lib/screen-verify/frame-metrics.js
 * produces; output is a verdict and, for the state machine, the actions to take.
 *
 * ⚠️ THE GOVERNING RULE IS "BE WRONG IN THE QUIET DIRECTION". An operator who is paged about a
 * healthy screen learns to mute the pages, which leaves them worse off than having no verification
 * at all. So every check below has an explicit list of things it refuses to judge, and "I cannot
 * tell" is always an available answer (verdict 'unknown') that changes nothing.
 *
 * What each check refuses to judge, and why:
 *
 *   blank       - a HOLD item (hold://blank is a deliberate black screen)
 *               - an item whose own reference image is just as flat (a black slide on purpose)
 *               - the player's privacy frame (a tiny all-black capture sent while a visitor is
 *                 using an interactive page — see sendBlankFrame in the web player and
 *                 WebSocketService.blankFrame on Android: both 160x90)
 *               - the web player's "could not capture this" card (dark navy, text)
 *   frozen      - a single-item playlist of a still (an image or a widget is MEANT not to move)
 *               - a still image during its own duration: the frames must stay identical for longer
 *                 than the longest item in the loop before it counts
 *               - anything the player is showing that is not in the screen's playlist (a trigger,
 *                 an emergency message, an override): we do not know how long that is meant to last
 *               - holds, live streams, YouTube, animated GIFs
 *   unexpected  - everything except a FULL-SCREEN IMAGE with a reference thumbnail on disk.
 *                 Zones, walls, widgets, live streams, YouTube and video are excluded: a widget has
 *                 no fixed appearance, a wall panel shows a slice, and a video is not one frame.
 *               - the first seconds of an item and the moment it is due to end (transitions)
 *               - a frame that still resembles the PREVIOUS item (the screen is a beat behind)
 */

const { GRID_W, GRID_H } = require('./frame-metrics');

const CHECKS = ['blank', 'frozen', 'unexpected', 'panel_off'];
const SENSITIVITIES = ['low', 'normal', 'high'];

/*
 * Per-sensitivity thresholds. "high" catches more and is wrong more often; "low" only speaks up
 * when it is certain. Numbers were set against the synthetic and real-sign fixtures in
 * test/screen-verify.test.js — change one and that file tells you what moved.
 */
const SENS = Object.freeze({
  low:    { blankStd: 3,  blankEdge: 0.001, blankDom: 0.97, sameMaxDiff: 6,  sameHam: 3, unexpectedNcc: 0.05, freezeMinFrames: 4 },
  normal: { blankStd: 6,  blankEdge: 0.003, blankDom: 0.93, sameMaxDiff: 10, sameHam: 5, unexpectedNcc: 0.2,  freezeMinFrames: 3 },
  high:   { blankStd: 10, blankEdge: 0.006, blankDom: 0.85, sameMaxDiff: 14, sameHam: 8, unexpectedNcc: 0.35, freezeMinFrames: 3 },
});

function sens(level) { return SENS[level] || SENS.normal; }

/* ------------------------------------------------------------------ the expected item */

/**
 * What KIND of thing an item is, for the purpose of judging a frame of it.
 * `item` is { mime_type, remote_url, widget_id } (any may be missing).
 */
function itemKind(item) {
  if (!item) return 'none';
  if (item.widget_id && !item.mime_type) return 'widget';
  const m = String(item.mime_type || '').toLowerCase();
  if (m === 'application/x-st-hold') return 'hold';
  if (m === 'video/hls' || m === 'video/rtsp' || m === 'video/hdmi-in' || m === 'video/youtube') return 'live';
  if (m === 'image/gif') return 'animated';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return item.remote_url ? 'live' : 'video';
  if (item.widget_id) return 'widget';
  return 'other';
}

/** Stills: kinds that are meant to look the same for their whole duration. */
function isStillKind(kind) { return kind === 'image' || kind === 'widget' || kind === 'animated' || kind === 'other'; }

/* ------------------------------------------------------------------ single-frame checks */

/**
 * Is this a real capture of the screen at all?
 *   'privacy'      the player deliberately sent a blank frame (interactive session in progress)
 *   'placeholder'  the web player could not read the media and drew its status card instead
 *   null           judge it
 */
function captureLimitation(m) {
  if (!m) return 'invalid';
  if (m.width < 200 || m.height < 100) return 'privacy';
  // The web player's fallback card: a #111827 fill with a few lines of text on it.
  if (m.dom && m.dom.frac >= 0.7 && m.edge > 0 && colourNear(m.dom.rgb, [17, 24, 39], 10)) return 'placeholder';
  return null;
}

function colourNear(a, b, tol) {
  return Array.isArray(a) && Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
}

/** 'black' | 'white' | 'solid' when the frame shows nothing, else null. */
function blankKind(m, level) {
  const s = sens(level);
  if (!m) return null;
  if (m.std >= s.blankStd || m.edge >= s.blankEdge) return null;
  if (!m.dom || m.dom.frac < s.blankDom) return null;
  if (m.mean < 24) return 'black';
  if (m.mean > 232) return 'white';
  return 'solid';
}

/** Largest per-cell luma difference between two grids. */
function maxCellDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 255;
  let mx = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > mx) mx = d; }
  return mx;
}

function hamming(h1, h2) {
  if (typeof h1 !== 'string' || typeof h2 !== 'string' || h1.length !== h2.length) return 64;
  let d = 0;
  for (let i = 0; i < h1.length; i += 2) {
    let x = parseInt(h1.slice(i, i + 2), 16) ^ parseInt(h2.slice(i, i + 2), 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/**
 * Do two frames show the same picture? JPEG noise and a re-encode must say yes; a ticking clock,
 * a changed price or a new slide must say no — so the test is the WORST cell, not the average.
 */
function sameFrame(a, b, level) {
  const s = sens(level);
  return hamming(a.hash, b.hash) <= s.sameHam && maxCellDiff(a.grid, b.grid) < s.sameMaxDiff;
}

/* ------------------------------------------------------------------ resemblance to a reference */

/** 64x36 -> 32x18 by 2x2 averaging: a little blur makes the comparison forgiving of alignment. */
function halfGrid(grid) {
  const w = GRID_W / 2, h = GRID_H / 2;
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * 2) * GRID_W + x * 2;
      out[y * w + x] = (grid[i] + grid[i + 1] + grid[i + GRID_W] + grid[i + GRID_W + 1]) / 4;
    }
  }
  return out;
}

/** The 32x18 grid a frame's HISTORY keeps (a quarter of the memory; enough to see a clock tick). */
function shrinkGrid(grid) {
  if (!grid || grid.length !== GRID_W * GRID_H) return grid;
  return Uint8Array.from(halfGrid(grid), (v) => Math.round(v));
}

/** Bilinear sample of a reference grid at normalized (u, v) in [0,1]. */
function sampleRef(grid, u, v) {
  const x = Math.max(0, Math.min(GRID_W - 1, u * GRID_W - 0.5));
  const y = Math.max(0, Math.min(GRID_H - 1, v * GRID_H - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(GRID_W - 1, x0 + 1), y1 = Math.min(GRID_H - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = grid[y0 * GRID_W + x0], b = grid[y0 * GRID_W + x1], c = grid[y1 * GRID_W + x0], d = grid[y1 * GRID_W + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/*
 * Where does frame point (u, v) land in the reference image, for a given way of fitting it?
 * Returns null when the point is outside the image (a letterbox bar, which is not compared).
 */
function mapPoint(u, v, frameAspect, refAspect, fit) {
  if (fit === 'fill') return [u, v];
  const wider = refAspect > frameAspect;
  if (fit === 'cover') {
    // The image overflows on its long side and is cropped to the middle.
    return wider ? [0.5 + (u - 0.5) * (frameAspect / refAspect), v] : [u, 0.5 + (v - 0.5) * (refAspect / frameAspect)];
  }
  // contain: the image fits on its long side and the rest is bars.
  if (wider) {
    const hf = frameAspect / refAspect;
    const rv = 0.5 + (v - 0.5) / hf;
    return rv < 0 || rv > 1 ? null : [u, rv];
  }
  const wf = refAspect / frameAspect;
  const ru = 0.5 + (u - 0.5) / wf;
  return ru < 0 || ru > 1 ? null : [ru, v];
}

function unrotate(p, rot) {
  if (!p) return null;
  if (rot === 90) return [p[1], 1 - p[0]];
  if (rot === 270) return [1 - p[1], p[0]];
  return p;
}

/**
 * How much does the frame resemble the reference? Zero-mean normalized correlation of luma over
 * the cells the image covers, maximised over three fits and three rotations — the comparison
 * does not know how the item is fitted or whether the panel is mounted portrait, and trying them
 * all can only make "unexpected" LESS likely, which is the safe direction.
 *
 * Returns { score: -1..1, fit, rotation } or null when the question cannot be asked (either image
 * has too little structure for correlation to mean anything).
 */
function resemblance(frame, ref) {
  if (!frame || !ref || !frame.grid || !ref.grid) return null;
  if (frame.std < 8 || ref.std < 8) return null;
  const fg = halfGrid(frame.grid);
  const fw = GRID_W / 2, fh = GRID_H / 2;
  const frameAspect = frame.width / frame.height;
  let best = null;
  for (const rotation of [0, 90, 270]) {
    const refAspect = rotation ? ref.height / ref.width : ref.width / ref.height;
    for (const fit of ['contain', 'cover', 'fill']) {
      const xs = [], ys = [];
      for (let y = 0; y < fh; y++) {
        for (let x = 0; x < fw; x++) {
          const p = unrotate(mapPoint((x + 0.5) / fw, (y + 0.5) / fh, frameAspect, refAspect, fit), rotation);
          if (!p) continue;
          xs.push(fg[y * fw + x]);
          ys.push(sampleRef(ref.grid, p[0], p[1]));
        }
      }
      if (xs.length < fw * fh * 0.3) continue;
      const score = ncc(xs, ys);
      if (score == null) continue;
      if (!best || score > best.score) best = { score: Math.round(score * 1000) / 1000, fit, rotation };
    }
  }
  return best;
}

function ncc(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  if (saa < n * 4 || sbb < n * 4) return null;   // under ~2 levels of spread: nothing to correlate
  return sab / Math.sqrt(saa * sbb);
}

/* ------------------------------------------------------------------ one frame, in context */

/**
 * The verdict for ONE frame, before persistence is considered.
 *
 * ctx: {
 *   level,                       sensitivity
 *   checks: Set of enabled checks
 *   current: { kind, key, startedMs, durationSec, fullScreen, wall, inPlaylist } | null
 *   reference: metrics of the current item's reference image | null
 *   previousReference: metrics of the item before it | null
 *   nowMs
 * }
 * Returns { verdict: 'ok' | 'blank' | 'unexpected' | 'unknown', detail }.
 * Freeze is not decided here — it needs history; see evaluateFreeze.
 */
function judgeFrame(m, ctx = {}) {
  const level = ctx.level || 'normal';
  const checks = ctx.checks || new Set(CHECKS);
  const lim = captureLimitation(m);
  if (lim) return { verdict: 'unknown', detail: { reason: lim } };
  const cur = ctx.current || null;

  if (checks.has('blank')) {
    const bk = blankKind(m, level);
    if (bk) {
      if (cur && cur.kind === 'hold') return { verdict: 'ok', detail: { reason: 'hold_item' } };
      // The item is itself this flat (a black slide on purpose): what is on screen is correct.
      if (ctx.reference && blankKind(ctx.reference, 'high') === bk) return { verdict: 'ok', detail: { reason: 'flat_by_design' } };
      return { verdict: 'blank', detail: { kind: bk, mean: m.mean, std: m.std, edge: m.edge } };
    }
  }

  if (checks.has('unexpected') && cur && ctx.reference && unexpectedEligible(cur, ctx.nowMs)) {
    const r = resemblance(m, ctx.reference);
    if (r) {
      const thr = sens(level).unexpectedNcc;
      if (r.score < thr) {
        const prev = ctx.previousReference ? resemblance(m, ctx.previousReference) : null;
        if (prev && prev.score >= thr) return { verdict: 'ok', detail: { reason: 'previous_item' } };
        return { verdict: 'unexpected', detail: { score: r.score, threshold: thr, item: cur.key } };
      }
      return { verdict: 'ok', detail: { score: r.score } };
    }
  }
  return { verdict: 'ok', detail: {} };
}

function unexpectedEligible(cur, nowMs) {
  if (!cur || cur.kind !== 'image' || !cur.fullScreen || cur.wall) return false;
  if (!cur.startedMs || !nowMs) return false;
  const age = nowMs - cur.startedMs;
  if (age < 4000) return false;                                  // still transitioning in
  if (cur.durationSec > 0 && age > cur.durationSec * 1000 - 1500) return false;   // about to leave, or already gone
  return true;
}

/* ------------------------------------------------------------------ frozen */

/**
 * Has the picture stopped while it should be moving?
 *
 * history: oldest-first [{ at (ms), metrics: {grid, hash}, itemKey }]
 * ctx: {
 *   level,
 *   persistSec,                 the workspace's "must persist for" window
 *   playlist: { visualItems, maxDurationSec } | null   (the screen's own loop)
 *   current: { kind, key, inPlaylist, durationSec } | null
 *   startsDuring(fromMs, toMs): how many play_starts the player reported in that span
 * }
 * Returns { frozen: false } or { frozen: true, sinceMs, frames, reason }.
 */
function evaluateFreeze(history, ctx = {}) {
  const level = ctx.level || 'normal';
  const s = sens(level);
  if (!Array.isArray(history) || history.length < 2) return { frozen: false };

  // The run of identical frames ending at the newest one.
  const last = history[history.length - 1];
  let start = history.length - 1;
  while (start > 0 && sameFrame(history[start - 1].metrics, last.metrics, level)) start--;
  const run = history.slice(start);
  if (run.length < s.freezeMinFrames) return { frozen: false };
  const spanMs = last.at - run[0].at;
  const persistMs = Math.max(60, ctx.persistSec || 600) * 1000;
  if (spanMs < persistMs) return { frozen: false };

  const cur = ctx.current || null;
  if (cur && (cur.kind === 'hold' || cur.kind === 'live')) return { frozen: false };

  /*
   * ⚠️ SAMPLING CAN ALIAS. Screenshots are minutes apart and a loop is seconds long, so a healthy
   * two-item loop can be caught on the same item several times running. Each capture is therefore
   * labelled with the item the player said was on screen AT THAT MOMENT, and only that label is
   * evidence; "the player started other items in between" is not, because that is exactly what an
   * aliased healthy loop also looks like.
   *
   * (A) Captures labelled with DIFFERENT items all show the same picture: the player moved on and
   *     the screen did not.
   */
  const keys = new Set(run.map((r) => r.itemKey).filter(Boolean));
  if (keys.size >= 2) {
    return { frozen: true, sinceMs: run[0].at, frames: run.length, reason: 'player_advanced' };
  }
  const started = typeof ctx.startsDuring === 'function' ? ctx.startsDuring(run[0].at, last.at) : 0;

  // Something we cannot time (a trigger, an emergency, an override) — stay quiet.
  if (!cur || !cur.inPlaylist) return { frozen: false };

  const pl = ctx.playlist || null;
  // (B) A loop of several items has sat on one picture for longer than any of them lasts, AND the
  //     player has reported starting nothing since — it is stuck, not merely sampled unluckily.
  if (pl && pl.visualItems >= 2) {
    const needMs = Math.max(persistMs, ((pl.maxDurationSec || 0) * 1.5 + 60) * 1000);
    if (spanMs >= needMs && started === 0) return { frozen: true, sinceMs: run[0].at, frames: run.length, reason: 'not_advancing' };
    return { frozen: false };
  }

  // (C) A lone video that has shown one frame for twice its length. Never at "low": a video that
  // is genuinely one long still (a looped title card) is rare, but it is the case that is wrong.
  if (cur.kind === 'video' && level !== 'low') {
    const needMs = Math.max(persistMs, (cur.durationSec || 0) * 2 * 1000);
    if (spanMs >= needMs) return { frozen: true, sinceMs: run[0].at, frames: run.length, reason: 'video_still' };
  }
  // A single still item: meant to look like this. Not a freeze, however long it lasts.
  return { frozen: false };
}

/* ------------------------------------------------------------------ persistence and resolve */

/*
 * The per-screen state machine. ONE open incident per screen at a time, because the badge can
 * show one thing; when the problem changes (blank -> frozen) the old incident closes as 'changed'
 * and a new one opens.
 *
 * state: { open: { kind, openedAt, confirmedAt, count, goodStreak } | null }
 * obs:   { kind: null | check, scope: 'frame' | 'panel', at (sec), since (sec, optional), detail }
 *        kind null = a good observation for that scope; obs.unknown = no verdict (ignored).
 * cfg:   { persistSec }
 *
 * Returns { state, actions: [{ type: 'open'|'confirm'|'resolve'|'discard', kind, reason }] }.
 *
 * Rules (the reason "one bad frame never pages anyone"):
 *   - a problem must be seen at least twice AND span persistSec before it is CONFIRMED; only a
 *     confirmed incident is shown as the screen's state or sent to an alert channel
 *   - a single good observation discards an unconfirmed suspicion
 *   - a confirmed incident needs TWO good observations in a row to resolve (one good frame between
 *     two bad ones is a flap, not a fix)
 *   - frame observations never touch a panel_off incident and vice versa: a screenshot is taken
 *     from the player, not the panel, so it cannot prove the panel is on
 */
function step(state, obs, cfg = {}) {
  const s = { open: state && state.open ? { ...state.open } : null };
  const actions = [];
  if (!obs || obs.unknown) return { state: s, actions };
  const persist = Math.max(60, cfg.persistSec || 600);
  const now = obs.at;
  const scopeOf = (kind) => (kind === 'panel_off' ? 'panel' : 'frame');

  if (obs.kind) {
    if (s.open && s.open.kind === obs.kind) {
      s.open.count++;
      s.open.goodStreak = 0;
      s.open.lastSeenAt = now;
    } else {
      if (s.open) {
        // A panel that is off explains whatever the frames show; a frame problem does not
        // replace a panel_off incident.
        if (s.open.kind === 'panel_off' && scopeOf(obs.kind) === 'frame') return { state: s, actions };
        actions.push(s.open.confirmedAt ? { type: 'resolve', kind: s.open.kind, reason: 'changed' } : { type: 'discard', kind: s.open.kind });
      }
      const openedAt = Number.isFinite(obs.since) && obs.since <= now ? obs.since : now;
      // A freeze is only REPORTED once its own evidence spans the window, so it counts as seen
      // repeatedly already; everything else starts at one sighting.
      s.open = { kind: obs.kind, openedAt, confirmedAt: null, count: obs.kind === 'frozen' ? 2 : 1, goodStreak: 0, lastSeenAt: now };
      actions.push({ type: 'open', kind: obs.kind });
    }
    if (!s.open.confirmedAt && s.open.count >= 2 && now - s.open.openedAt >= persist) {
      s.open.confirmedAt = now;
      actions.push({ type: 'confirm', kind: s.open.kind });
    }
    return { state: s, actions };
  }

  // A good observation — only for the scope it came from.
  if (!s.open || scopeOf(s.open.kind) !== (obs.scope || 'frame')) return { state: s, actions };
  if (!s.open.confirmedAt) {
    actions.push({ type: 'discard', kind: s.open.kind });
    s.open = null;
    return { state: s, actions };
  }
  s.open.goodStreak = (s.open.goodStreak || 0) + 1;
  if (s.open.goodStreak >= 2) {
    actions.push({ type: 'resolve', kind: s.open.kind, reason: 'recovered' });
    s.open = null;
  }
  return { state: s, actions };
}

/* ------------------------------------------------------------------ settings */

const DEFAULTS = Object.freeze({
  enabled: true,
  cadence_minutes: 30,
  sensitivity: 'normal',
  persist_minutes: 10,
  alert_checks: ['blank', 'frozen', 'panel_off'],
});

/** Validate a settings body. Returns { fields } or { error }. Unknown keys are ignored. */
function normaliseSettings(body) {
  const b = body || {};
  const out = {};
  if (b.enabled !== undefined) out.enabled = b.enabled ? 1 : 0;
  if (b.cadence_minutes !== undefined) {
    const n = Number(b.cadence_minutes);
    // 0 = never ask for a screenshot; only judge the ones that arrive anyway.
    if (!Number.isInteger(n) || (n !== 0 && (n < 5 || n > 1440))) return { error: 'cadence_minutes must be 0 (off) or 5-1440' };
    out.cadence_minutes = n;
  }
  if (b.sensitivity !== undefined) {
    if (!SENSITIVITIES.includes(b.sensitivity)) return { error: `sensitivity must be one of: ${SENSITIVITIES.join(', ')}` };
    out.sensitivity = b.sensitivity;
  }
  if (b.persist_minutes !== undefined) {
    const n = Number(b.persist_minutes);
    if (!Number.isInteger(n) || n < 2 || n > 240) return { error: 'persist_minutes must be 2-240' };
    out.persist_minutes = n;
  }
  if (b.alert_checks !== undefined) {
    if (!Array.isArray(b.alert_checks)) return { error: `alert_checks must be an array of: ${CHECKS.join(', ')}` };
    const bad = b.alert_checks.find((c) => !CHECKS.includes(c));
    if (bad !== undefined) return { error: `unknown check: ${String(bad).slice(0, 40)}` };
    out.alert_checks = JSON.stringify([...new Set(b.alert_checks)]);
  }
  return { fields: out };
}

/** A stored row (or none) as the settings object everything else reads. */
function presentSettings(row) {
  if (!row) return { ...DEFAULTS, alert_checks: [...DEFAULTS.alert_checks], is_default: true };
  let checks = DEFAULTS.alert_checks;
  try { const v = JSON.parse(row.alert_checks); if (Array.isArray(v)) checks = v.filter((c) => CHECKS.includes(c)); } catch { /* default */ }
  return {
    enabled: !!row.enabled,
    cadence_minutes: Number.isInteger(row.cadence_minutes) ? row.cadence_minutes : DEFAULTS.cadence_minutes,
    sensitivity: SENSITIVITIES.includes(row.sensitivity) ? row.sensitivity : DEFAULTS.sensitivity,
    persist_minutes: Number.isInteger(row.persist_minutes) ? row.persist_minutes : DEFAULTS.persist_minutes,
    alert_checks: checks,
    updated_at: row.updated_at || null,
    is_default: false,
  };
}

module.exports = {
  CHECKS, SENSITIVITIES, SENS, DEFAULTS,
  itemKind, isStillKind, captureLimitation, blankKind, sameFrame, maxCellDiff, hamming,
  resemblance, judgeFrame, shrinkGrid, unexpectedEligible, evaluateFreeze, step, normaliseSettings, presentSettings,
};
