'use strict';

/*
 * 3.0 accessibility checker: what goes ON the screens (docs/accessibility.md).
 *
 *   contrast      WCAG 2.2 SC 1.4.3 (AA): 4.5:1, or 3:1 for large text — for every slide, sign,
 *                 slide-kind template and widget whose text and colours the server knows
 *   text size     ISO 9241-303 minimum character height for the workspace's (or the screen's)
 *                 viewing distance (lib/a11y/legibility.js)
 *   flashing      WCAG 2.3.1 general and red flash thresholds, on videos and GIFs (lib/a11y/flash.js)
 *   captions      WCAG 1.2.2: a video with an audio track and no subtitle track
 *   text in image a soft note on pictures that look like they are mostly words (no OCR)
 *
 * Every finding is { code, severity: 'error'|'warning'|'note', values, fix?, where?, text? }: a code
 * the dashboard turns into a plain sentence and a "how to fix", the numbers behind it, and — where
 * there is one — a fix the dashboard can apply through the product's ordinary edit endpoints.
 *
 * ⚠️ TENANCY. Everything is computed for ONE workspace from rows that carry that workspace_id. A
 * deck or slide may NAME any content id (it is a string in a JSON document the editor wrote); the
 * photo grid behind slide text is looked up only within the deck's own workspace, so a foreign id is
 * "could not check", never another tenant's picture measured and described.
 */

const C = require('./contrast');
const L = require('./legibility');
const { checkSlide } = require('./slides');
const { checkWidget } = require('./widgets');
const media = require('./media');
const signs = require('../sign-templates');

const DEFAULTS = Object.freeze({ viewing_distance_m: L.DEFAULT_DISTANCE_M, screen_diagonal_in: L.DEFAULT_DIAGONAL_IN, block_on_errors: false });
const LIMITS = Object.freeze({ distance: [0.3, 100], diagonal: [7, 400] });
const REPORT_TTL_MS = 60 * 1000;
const MAX_ROWS = 2000;

/* ---------------------------------------------------------------- settings */

function getSettings(db, workspaceId) {
  let r = null;
  // A database without the table (a test fixture with its own schema) simply has the defaults.
  try { r = db.prepare('SELECT * FROM a11y_settings WHERE workspace_id = ?').get(workspaceId); } catch { r = null; }
  if (!r) return { ...DEFAULTS };
  return {
    viewing_distance_m: Number(r.viewing_distance_m) || DEFAULTS.viewing_distance_m,
    screen_diagonal_in: Number(r.screen_diagonal_in) || DEFAULTS.screen_diagonal_in,
    block_on_errors: !!r.block_on_errors,
  };
}

const inRange = (v, [lo, hi]) => Number.isFinite(v) && v >= lo && v <= hi;

function validateSettings(current, body) {
  const b = body && typeof body === 'object' ? body : {};
  const out = { ...current };
  if (b.viewing_distance_m !== undefined) {
    const v = Number(b.viewing_distance_m);
    if (!inRange(v, LIMITS.distance)) return { ok: false, error: `viewing_distance_m must be between ${LIMITS.distance[0]} and ${LIMITS.distance[1]}` };
    out.viewing_distance_m = Math.round(v * 10) / 10;
  }
  if (b.screen_diagonal_in !== undefined) {
    const v = Number(b.screen_diagonal_in);
    if (!inRange(v, LIMITS.diagonal)) return { ok: false, error: `screen_diagonal_in must be between ${LIMITS.diagonal[0]} and ${LIMITS.diagonal[1]}` };
    out.screen_diagonal_in = Math.round(v);
  }
  if (b.block_on_errors !== undefined) out.block_on_errors = b.block_on_errors === true;
  return { ok: true, settings: out };
}

function saveSettings(db, workspaceId, s, userId) {
  db.prepare(`INSERT INTO a11y_settings (workspace_id, viewing_distance_m, screen_diagonal_in, block_on_errors, updated_by, updated_at)
              VALUES (?,?,?,?,?,strftime('%s','now'))
              ON CONFLICT(workspace_id) DO UPDATE SET viewing_distance_m = excluded.viewing_distance_m,
                screen_diagonal_in = excluded.screen_diagonal_in, block_on_errors = excluded.block_on_errors,
                updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(workspaceId, s.viewing_distance_m, s.screen_diagonal_in, s.block_on_errors ? 1 : 0, userId || null);
  invalidate(workspaceId);
}

/** Validate one screen's overrides; null clears one. */
function validateScreen(body) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  for (const [k, lim] of [['viewing_distance_m', LIMITS.distance], ['screen_diagonal_in', LIMITS.diagonal]]) {
    if (b[k] === undefined) continue;
    if (b[k] === null || b[k] === '') { out[k] = null; continue; }
    const v = Number(b[k]);
    if (!inRange(v, lim)) return { ok: false, error: `${k} must be between ${lim[0]} and ${lim[1]}, or null` };
    out[k] = k === 'viewing_distance_m' ? Math.round(v * 10) / 10 : Math.round(v);
  }
  return { ok: true, values: out };
}

/* ---------------------------------------------------------------- viewing geometry */

/** EDID physical size (cm) → diagonal inches, when the panel reports something believable. */
function edidDiagonal(hex) {
  if (!hex) return null;
  try {
    const e = require('../edid').parseEdid(hex);
    const w = e && Number(e.widthCm), h = e && Number(e.heightCm);
    // Many TVs report 0, or an aspect ratio (16x9) in these bytes; projectors report nothing useful.
    if (!(w >= 20 && w <= 900 && h >= 10 && h <= 900)) return null;
    return Math.hypot(w, h) / 2.54;
  } catch { return null; }
}

function makeView(distanceM, diagonalIn, pxW, pxH, extra = {}) {
  const g = L.screenSize(diagonalIn, pxW, pxH);
  return { distanceM, diagonalIn: Math.round(diagonalIn), widthMm: g.widthMm, heightMm: g.heightMm, pxW: g.pxW, pxH: g.pxH, ...extra };
}

function deviceView(d, settings) {
  const portrait = (d.orientation || '').startsWith('portrait');
  let pxW = Number(d.screen_width) || null, pxH = Number(d.screen_height) || null;
  if (!pxW || !pxH) { pxW = portrait ? 1080 : 1920; pxH = portrait ? 1920 : 1080; }
  const diag = Number(d.a11y_screen_diagonal_in) || edidDiagonal(d.hardware_edid) || settings.screen_diagonal_in;
  const dist = Number(d.a11y_viewing_distance_m) || settings.viewing_distance_m;
  return makeView(dist, diag, pxW, pxH, { device_id: d.id, device_name: d.name });
}

function defaultView(settings) {
  return makeView(settings.viewing_distance_m, settings.screen_diagonal_in, 1920, 1080);
}

/** Of several screens, the one on which text looks smallest — the one a check must pass on. */
function worstView(views, settings) {
  if (!views.length) return defaultView(settings);
  return views.slice().sort((a, b) => (Math.min(a.widthMm, a.heightMm) / a.distanceM) - (Math.min(b.widthMm, b.heightMm) / b.distanceM))[0];
}

const DEVICE_COLS = 'id, name, orientation, screen_width, screen_height, hardware_edid, a11y_viewing_distance_m, a11y_screen_diagonal_in, playlist_id';

/* ---------------------------------------------------------------- single sources */

function contentRow(db, workspaceId, id) {
  return db.prepare('SELECT * FROM content WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
}

/** imageGrid for slide checks, scoped to the workspace. */
function gridResolver(db, workspaceId) {
  return (contentId) => {
    const c = typeof contentId === 'string' ? contentRow(db, workspaceId, contentId) : null;
    if (!c) return { unknown: 'image' };
    return media.gridState(c);
  };
}

function templateSlide(widget) {
  try {
    let cfg = widget.config;
    if (typeof cfg === 'string') cfg = JSON.parse(cfg || '{}');
    const store = require('../templates/store');
    const render = require('../templates/render');
    const installed = store.getInstalled(cfg.template);
    if (!installed) return null;
    const env = store.loadPackage(installed.sha256);
    if (!env || env.manifest.kind !== 'slide') return null;
    return render.buildSlideConfig(env, render.lenientValues(env.manifest, cfg.values, { files: env.files }));
  } catch { return null; }
}

const TEXTY_NAME = /\b(menu|poster|flyer|leaflet|notice|announcement|schedule|timetable|price|prices|pricelist|hours|opening|agenda|infographic|newsletter|bulletin|slide|page[ _-]?\d+|screenshot)\b/i;

function checkContent(db, c, view) {
  const issues = [];
  const mime = String(c.mime_type || '');
  const youtube = /youtube\.com|youtu\.be/i.test(String(c.remote_url || ''));
  if (youtube) {
    if (!c.captions_enabled) issues.push({ code: 'youtube_captions_off', severity: 'warning', values: {}, fix: { kind: 'youtube_captions' } });
    return issues;
  }
  if (media.isAnimated(c)) {
    const st = media.videoState(c);
    if (st.state === 'pending') issues.push({ code: 'media_pending', severity: 'note', values: {} });
    else if (st.state === 'remote') issues.push({ code: 'media_remote', severity: 'note', values: {} });
    else if (st.state === 'failed') issues.push({ code: 'media_unchecked', severity: 'note', values: { why: st.error === 'not_local' ? 'not_local' : 'unreadable' } });
    else {
      const r = st.result;
      if (r.flash && r.flash.general.fails) issues.push({ code: 'flashing', severity: 'error', values: { per_sec: r.flash.general.flashes_per_sec, at_sec: r.flash.general.at_sec } });
      if (r.flash && r.flash.red.fails) issues.push({ code: 'red_flashing', severity: 'error', values: { per_sec: r.flash.red.flashes_per_sec, at_sec: r.flash.red.at_sec } });
      if (r.truncated) issues.push({ code: 'flash_partial', severity: 'note', values: { analysed_sec: r.analysed_sec } });
      if (/^video\//i.test(mime) && r.has_audio && !c.subtitle_url && !r.embedded_subtitles) {
        issues.push({ code: 'no_captions', severity: 'error', values: {}, fix: { kind: 'captions' } });
      }
    }
    return issues;
  }
  if (/^image\//i.test(mime) && TEXTY_NAME.test(String(c.filename || ''))) {
    issues.push({ code: 'text_in_image', severity: 'note', values: { kind: 'image' } });
  }
  if (/^application\/pdf$/i.test(mime)) issues.push({ code: 'text_in_image', severity: 'note', values: { kind: 'pdf' } });
  return issues;
}

function checkWidgetRow(db, w, view) {
  return checkWidget(w, view, { imageGrid: gridResolver(db, w.workspace_id), templateSlide });
}

function parseDoc(deck) {
  try { return JSON.parse(deck.doc || '{"slides":[]}'); } catch { return { slides: [] }; }
}

function checkDeckRow(db, deck, view) {
  const doc = require('../slide-deck').normalizeDeck(parseDoc(deck));
  const grid = gridResolver(db, deck.workspace_id);
  const out = [];
  doc.slides.forEach((s, i) => {
    for (const f of checkSlide({ template: s.template, fields: s.fields }, view, { imageGrid: grid })) {
      out.push({ ...f, where: { ...(f.where || {}), slide_index: i, slide_id: s.id, slide_name: s.name } });
    }
  });
  return out;
}

/* ---------------------------------------------------------------- summaries */

function tally(issues) {
  const t = { errors: 0, warnings: 0, notes: 0 };
  for (const i of issues) {
    if (i.severity === 'error') t.errors++;
    else if (i.severity === 'warning') t.warnings++;
    else t.notes++;
  }
  t.pending = issues.some((i) => i.code === 'media_pending');
  return t;
}

const SEV = { error: 0, warning: 1, note: 2 };
const sortIssues = (list) => list.slice().sort((a, b) => (SEV[a.severity] - SEV[b.severity]));
const sourceOrder = (a, b) => (b.errors - a.errors) || (b.warnings - a.warnings) || (b.notes - a.notes) || String(a.name).localeCompare(String(b.name));

/* ---------------------------------------------------------------- a playlist */

/**
 * Every item a playlist plays (nested playlists followed, 5 deep), checked on the worst of the
 * screens that show it. Deck widgets are attributed to their deck so a fix goes to the source.
 */
function checkPlaylist(db, workspaceId, playlistId) {
  const settings = getSettings(db, workspaceId);
  const devices = db.prepare(`SELECT ${DEVICE_COLS} FROM devices WHERE workspace_id = ? AND playlist_id = ?`).all(workspaceId, playlistId);
  const view = worstView(devices.map((d) => deviceView(d, settings)), settings);
  /*
   * 3.0 playlist layouts: an item in a ZONE is drawn smaller than the screen, so its text is too.
   * When the playlist chose a layout, each item is checked on the part of the screen its zone covers
   * (its own zone, or the main zone for one without) — the full-screen assumption could only pass
   * text that is too small. Cheap and one-sided: a playlist without a layout is checked as before.
   */
  const zoneViews = new Map();
  let mainZoneId = null;
  try {
    const own = db.prepare('SELECT layout_id FROM playlists WHERE id = ? AND workspace_id = ?').get(playlistId, workspaceId);
    const lay = own && own.layout_id ? require('../playlist-layout').loadLayout(db, own.layout_id) : null;
    if (lay && lay.zones.length > 1) {
      mainZoneId = (require('../playlist-layout').mainZone(lay.zones) || {}).id || null;
      for (const z of lay.zones) {
        const fw = Math.max(0.01, (Number(z.width_percent) || 100) / 100), fh = Math.max(0.01, (Number(z.height_percent) || 100) / 100);
        zoneViews.set(z.id, { ...view, widthMm: view.widthMm * fw, heightMm: view.heightMm * fh, pxW: Math.round(view.pxW * fw), pxH: Math.round(view.pxH * fh) });
      }
    }
  } catch (_) { /* pre-migration schema: full screen */ }
  const viewFor = (zoneId) => zoneViews.get(zoneId || mainZoneId) || view;
  const deckOf = deckWidgetIndex(db, workspaceId);
  const sources = [];
  const seen = new Set();
  const visit = (pid, depth, parentZone = null) => {
    if (depth > 5 || seen.has('p:' + pid)) return;
    seen.add('p:' + pid);
    const pl = db.prepare('SELECT id FROM playlists WHERE id = ? AND workspace_id = ?').get(pid, workspaceId);
    if (!pl) return;
    for (const it of db.prepare('SELECT content_id, widget_id, child_playlist_id, zone_id FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order').all(pid)) {
      const view = viewFor(it.zone_id || parentZone);
      if (it.content_id && !seen.has('c:' + it.content_id)) {
        seen.add('c:' + it.content_id);
        const c = contentRow(db, workspaceId, it.content_id);
        if (c) pushSource(sources, { type: 'content', id: c.id, name: c.filename, mime_type: c.mime_type }, checkContent(db, c, view));
      }
      if (it.widget_id) {
        const deckId = deckOf.get(it.widget_id);
        if (deckId) {
          if (seen.has('d:' + deckId)) continue;
          seen.add('d:' + deckId);
          const deck = db.prepare('SELECT * FROM slide_decks WHERE id = ? AND workspace_id = ?').get(deckId, workspaceId);
          if (deck) pushSource(sources, { type: 'slide_deck', id: deck.id, name: deck.name }, checkDeckRow(db, deck, view));
          continue;
        }
        if (seen.has('w:' + it.widget_id)) continue;
        seen.add('w:' + it.widget_id);
        const w = db.prepare('SELECT * FROM widgets WHERE id = ? AND workspace_id = ?').get(it.widget_id, workspaceId);
        if (w) pushSource(sources, { type: 'widget', id: w.id, name: w.name, widget_type: w.widget_type }, checkWidgetRow(db, w, view));
      }
      if (it.child_playlist_id) visit(it.child_playlist_id, depth + 1, it.zone_id || parentZone);
    }
  };
  visit(playlistId, 0);
  return finishSources(sources, view);
}

function pushSource(list, src, issues) {
  list.push({ ...src, issues: sortIssues(issues), ...tally(issues) });
}

function finishSources(sources, view) {
  sources.sort(sourceOrder);
  const totals = sources.reduce((t, s) => ({ errors: t.errors + s.errors, warnings: t.warnings + s.warnings, notes: t.notes + s.notes }), { errors: 0, warnings: 0, notes: 0 });
  return { view: publicView(view), sources, ...totals, pending: sources.some((s) => s.pending) };
}

function publicView(v) {
  return { distance_m: v.distanceM, diagonal_in: v.diagonalIn, width_px: v.pxW, height_px: v.pxH, device_id: v.device_id || null, device_name: v.device_name || null };
}

/** widget id → deck id, for every widget a deck has published or a sign created. */
function deckWidgetIndex(db, workspaceId) {
  const m = new Map();
  for (const d of db.prepare('SELECT id, doc, published_widget_ids FROM slide_decks WHERE workspace_id = ?').all(workspaceId)) {
    let ids = [];
    try { ids = JSON.parse(d.published_widget_ids || '[]'); } catch { ids = []; }
    for (const s of parseDoc(d).slides || []) if (s && s.widget_id) ids.push(s.widget_id);
    for (const id of ids) if (typeof id === 'string') m.set(id, d.id);
  }
  return m;
}

function checkDeck(db, workspaceId, deckId) {
  const settings = getSettings(db, workspaceId);
  const deck = db.prepare('SELECT * FROM slide_decks WHERE id = ? AND workspace_id = ?').get(deckId, workspaceId);
  if (!deck) return null;
  let devices = [];
  if (deck.playlist_id) devices = db.prepare(`SELECT ${DEVICE_COLS} FROM devices WHERE workspace_id = ? AND playlist_id = ?`).all(workspaceId, deck.playlist_id);
  const view = worstView(devices.map((d) => deviceView(d, settings)), settings);
  const sources = [];
  pushSource(sources, { type: 'slide_deck', id: deck.id, name: deck.name }, checkDeckRow(db, deck, view));
  return finishSources(sources, view);
}

function checkOne(db, workspaceId, type, id) {
  const settings = getSettings(db, workspaceId);
  const view = defaultView(settings);
  const sources = [];
  if (type === 'content') {
    const c = contentRow(db, workspaceId, id);
    if (!c) return null;
    pushSource(sources, { type, id: c.id, name: c.filename, mime_type: c.mime_type }, checkContent(db, c, view));
  } else if (type === 'widget') {
    const w = db.prepare('SELECT * FROM widgets WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
    if (!w) return null;
    pushSource(sources, { type, id: w.id, name: w.name, widget_type: w.widget_type }, checkWidgetRow(db, w, view));
  } else if (type === 'slide_deck') {
    return checkDeck(db, workspaceId, id);
  } else if (type === 'playlist') {
    const pl = db.prepare('SELECT id FROM playlists WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
    if (!pl) return null;
    return checkPlaylist(db, workspaceId, id);
  } else return null;
  return finishSources(sources, view);
}

/* ---------------------------------------------------------------- the workspace report */

const cache = new Map(); // workspaceId → { at, report }

function invalidate(workspaceId) { if (workspaceId) cache.delete(workspaceId); else cache.clear(); }

function workspaceReport(db, workspaceId, { useCache = true } = {}) {
  const hit = cache.get(workspaceId);
  if (useCache && hit && Date.now() - hit.at < REPORT_TTL_MS) return hit.report;

  const settings = getSettings(db, workspaceId);
  const devices = db.prepare(`SELECT ${DEVICE_COLS} FROM devices WHERE workspace_id = ? ORDER BY name`).all(workspaceId);
  const viewOfDevice = new Map(devices.map((d) => [d.id, deviceView(d, settings)]));
  const dflt = defaultView(settings);

  // Which screens show what (direct items of the playlist each screen plays).
  const screensOf = new Map(); // 'c:id' / 'w:id' → [deviceId]
  const playlistsOf = new Map(); // 'c:id' / 'w:id' → Set(playlistId)
  for (const r of db.prepare(`SELECT pi.playlist_id, pi.content_id, pi.widget_id FROM playlist_items pi
                              JOIN playlists p ON p.id = pi.playlist_id WHERE p.workspace_id = ?`).all(workspaceId)) {
    const k = r.content_id ? 'c:' + r.content_id : r.widget_id ? 'w:' + r.widget_id : null;
    if (!k) continue;
    if (!playlistsOf.has(k)) playlistsOf.set(k, new Set());
    playlistsOf.get(k).add(r.playlist_id);
  }
  const devicesOn = new Map(); // playlistId → [deviceId]
  for (const d of devices) if (d.playlist_id) (devicesOn.get(d.playlist_id) || devicesOn.set(d.playlist_id, []).get(d.playlist_id)).push(d.id);
  for (const [k, pls] of playlistsOf) {
    const ids = [...pls].flatMap((pid) => devicesOn.get(pid) || []);
    if (ids.length) screensOf.set(k, [...new Set(ids)]);
  }
  const viewFor = (k) => worstView((screensOf.get(k) || []).map((id) => viewOfDevice.get(id)).filter(Boolean), settings);

  const deckOf = deckWidgetIndex(db, workspaceId);
  const sources = [];
  const widgetTally = new Map();

  for (const c of db.prepare('SELECT * FROM content WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?').all(workspaceId, MAX_ROWS)) {
    const issues = checkContent(db, c, viewFor('c:' + c.id));
    if (issues.length) pushSource(sources, { type: 'content', id: c.id, name: c.filename, mime_type: c.mime_type, screens: (screensOf.get('c:' + c.id) || []).length }, issues);
  }
  for (const w of db.prepare('SELECT * FROM widgets WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT ?').all(workspaceId, MAX_ROWS)) {
    if (deckOf.has(w.id)) continue; // reported on its deck, where the fix belongs
    const issues = checkWidgetRow(db, w, viewFor('w:' + w.id));
    widgetTally.set(w.id, tally(issues));
    if (issues.length) pushSource(sources, { type: 'widget', id: w.id, name: w.name, widget_type: w.widget_type, screens: (screensOf.get('w:' + w.id) || []).length }, issues);
  }
  const deckTally = new Map();
  for (const d of db.prepare('SELECT * FROM slide_decks WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT ?').all(workspaceId, MAX_ROWS)) {
    // A deck is seen on the screens of every playlist its widgets are in.
    const ks = [...deckOf].filter(([, did]) => did === d.id).map(([wid]) => 'w:' + wid);
    const devs = [...new Set(ks.flatMap((k) => screensOf.get(k) || []))];
    const view = worstView(devs.map((id) => viewOfDevice.get(id)).filter(Boolean), settings);
    const issues = checkDeckRow(db, d, view);
    deckTally.set(d.id, tally(issues));
    if (issues.length) pushSource(sources, { type: 'slide_deck', id: d.id, name: d.name, screens: devs.length }, issues);
  }

  sources.sort(sourceOrder);

  // Playlist roll-ups for the badges: the sum over the items it plays directly.
  const bySource = new Map(sources.map((s) => [`${s.type}:${s.id}`, s]));
  const playlists = {};
  for (const [k, pls] of playlistsOf) {
    let t = null;
    if (k.startsWith('c:')) t = bySource.get('content:' + k.slice(2));
    else {
      const wid = k.slice(2);
      const did = deckOf.get(wid);
      t = did ? deckTally.get(did) : widgetTally.get(wid);
    }
    if (!t || !(t.errors || t.warnings)) continue;
    for (const pid of pls) {
      const p = playlists[pid] || (playlists[pid] = { errors: 0, warnings: 0 });
      p.errors += t.errors; p.warnings += t.warnings;
    }
  }

  const counts = sources.reduce((a, s) => ({ errors: a.errors + s.errors, warnings: a.warnings + s.warnings, notes: a.notes + s.notes }), { errors: 0, warnings: 0, notes: 0 });
  const report = {
    settings,
    defaults: DEFAULTS,
    view: publicView(dflt),
    counts,
    pending: sources.filter((s) => s.pending).length,
    sources,
    playlists,
    screens: devices.map((d) => {
      const v = viewOfDevice.get(d.id);
      return {
        id: d.id, name: d.name,
        viewing_distance_m: d.a11y_viewing_distance_m == null ? null : Number(d.a11y_viewing_distance_m),
        screen_diagonal_in: d.a11y_screen_diagonal_in == null ? null : Number(d.a11y_screen_diagonal_in),
        edid_diagonal_in: edidDiagonal(d.hardware_edid) ? Math.round(edidDiagonal(d.hardware_edid)) : null,
        effective: publicView(v),
      };
    }),
    generated_at: Math.floor(Date.now() / 1000),
  };
  cache.set(workspaceId, { at: Date.now(), report });
  return report;
}

/** The compact per-id form the dashboard badges use. */
function badgesFrom(report) {
  const out = { content: {}, widgets: {}, decks: {}, playlists: report.playlists || {} };
  for (const s of report.sources) {
    if (!(s.errors || s.warnings)) continue;
    const bucket = s.type === 'content' ? out.content : s.type === 'widget' ? out.widgets : out.decks;
    bucket[s.id] = { errors: s.errors, warnings: s.warnings };
  }
  return out;
}

/* ---------------------------------------------------------------- publishing */

/**
 * The optional "block publishing when there are accessibility errors" policy. Null when publishing
 * may go ahead; otherwise what to refuse with. Off (null) unless the workspace switched it on.
 *
 * ⚠️ A video still being checked BLOCKS under the policy (code accessibility_pending): the policy's
 * promise is that nothing with a known-dangerous flash rate goes out, and "we have not looked yet"
 * cannot keep it. The check takes seconds to a few minutes; the message says to try again shortly.
 */
function publishGate(db, workspaceId, type, id) {
  if (!workspaceId) return null;
  const settings = getSettings(db, workspaceId);
  if (!settings.block_on_errors) return null;
  const res = type === 'slide_deck' ? checkDeck(db, workspaceId, id) : checkPlaylist(db, workspaceId, id);
  if (!res) return null;
  if (res.errors) {
    return {
      status: 409, code: 'accessibility_errors',
      error: `This has ${res.errors} accessibility ${res.errors === 1 ? 'error' : 'errors'}, and this workspace does not publish with accessibility errors. Open Accessibility to see and fix them.`,
      check: res,
    };
  }
  if (res.pending) {
    return {
      status: 409, code: 'accessibility_pending',
      error: 'A video in this is still being checked for flashing and captions. Try again in a minute.',
      check: res,
    };
  }
  return null;
}

/* ---------------------------------------------------------------- Make a sign */

/**
 * The Make-a-sign fill step's check: the sign as it will be built (whose colours are always made
 * readable, see sign-templates themeOf) plus whether the COLOURS THE PERSON CHOSE needed changing —
 * that is what the Simple view tells them about, with the colour the sign really uses as the fix.
 */
function checkSign(db, workspaceId, body) {
  const b = body && typeof body === 'object' ? body : {};
  const tpl = signs.getTemplate(b.template);
  if (!tpl) return null;
  const brand = require('../brand-kit').getKit(db, workspaceId);
  const built = signs.buildSign(tpl.id, b.values || {}, { aspect: b.aspect, brand });
  const settings = getSettings(db, workspaceId);
  const portrait = built.aspect === '9:16';
  const view = makeView(settings.viewing_distance_m, settings.screen_diagonal_in, portrait ? 1080 : 1920, portrait ? 1920 : 1080);
  const issues = checkSlide(built.slide, view, { imageGrid: gridResolver(db, workspaceId) });
  const theme = signs.themeOf(built.values.bg, built.values.accent, built.values.extra);
  const chosen = [];
  const acc = C.parseHex(built.values.accent);
  const accField = tpl.fields.find((f) => f.key === 'accent');
  // A design's OWN default accent is part of the design (some are deliberately decorative and the
  // sign uses the ink for words); only a colour somebody picked, or a brand colour, is reported.
  const isDefault = accField && C.parseHex(accField.default) && C.toHex(C.parseHex(accField.default)) === (acc && C.toHex(acc));
  if (acc && accField && !isDefault) {
    const ratio = C.contrast(acc, theme.bg);
    if (ratio < C.AA_NORMAL) chosen.push({ key: 'accent', color: C.toHex(acc), ratio: Math.round(ratio * 100) / 100, suggested: theme.accent });
  }
  return { issues: sortIssues(issues), chosen, ...tally(issues), view: publicView(view) };
}

module.exports = {
  DEFAULTS, LIMITS,
  getSettings, validateSettings, saveSettings, validateScreen,
  deviceView, defaultView, worstView, edidDiagonal,
  checkContent, checkWidgetRow, checkDeckRow, checkPlaylist, checkDeck, checkOne, checkSign,
  workspaceReport, badgesFrom, invalidate, publishGate, tally,
};
