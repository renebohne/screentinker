'use strict';

/*
 * Accessibility of a widget whose text and colours the server knows.
 *
 * Each widget type is described here as the RUNS OF TEXT its renderer draws (routes/widgets.js,
 * lib/menu-board.js): which config key holds the colour, which the background, how big the type is
 * and in what unit. The descriptions mirror the renderers' own defaults; when a renderer changes a
 * default, the matching line here is what keeps the report honest.
 *
 * ⚠️ WHAT IS NOT CHECKED, AND SAYS SO. A text widget is free HTML, a web page is somebody else's site,
 * a code template is author code: the server cannot see their colours, so they get a "could not check"
 * note rather than a pass. A clock or weather widget with a TRANSPARENT background sits on whatever
 * the layout puts under it, which is equally unknowable here.
 *
 * Units: `px` is CSS px of a widget filling the screen (legibility.js explains why that is the
 * generous assumption), `vmin` is % of the shorter screen side.
 */

const C = require('./contrast');
const { checkRun } = require('./text-check');
const { checkSlide, excerpt } = require('./slides');

function bgOf(v, dflt) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!s) return dflt == null ? { unknown: 'transparent' } : bgOf(dflt);
  if (s === 'transparent' || s === 'none') return { unknown: 'transparent' };
  const rgb = C.parseHex(s);
  // An 8-digit or named colour is not something this check parses: say so rather than guess.
  return rgb ? { rgb } : { unknown: 'transparent' };
}
const colorOf = (v, dflt) => (C.parseHex(v) ? C.toHex(C.parseHex(v)) : dflt);
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

/** The text runs a widget draws: [{ part, text, color, bg, opacity, weight, px? , vmin? }]. */
function runsOf(type, c) {
  c = c && typeof c === 'object' ? c : {};
  switch (type) {
    case 'clock': {
      const bg = bgOf(c.background, null);
      const size = num(c.font_size, 64);
      const runs = [{ part: 'time', key: 'color', text: '12:00', color: colorOf(c.color, '#FFFFFF'), bg, weight: 700, px: size }];
      if (c.show_date !== false) {
        runs.push({ part: 'date', key: 'date_color', text: 'date', color: colorOf(c.date_color, colorOf(c.color, '#FFFFFF')), bg,
          opacity: c.date_color ? 1 : 0.7, weight: 400, px: Math.max(8, num(c.date_font_size, Math.max(16, size / 3))) });
      }
      return runs;
    }
    case 'weather': {
      const bg = bgOf(c.background, null);
      const size = num(c.font_size, 48);
      const color = colorOf(c.color, '#FFFFFF');
      return [
        { part: 'temperature', key: 'color', text: '21°', color, bg, weight: 700, px: size },
        { part: 'location', key: 'color', text: 'location', color, bg, opacity: 0.7, weight: 400, px: Math.max(10, Math.round(size * 0.34)) },
        { part: 'description', key: 'color', text: 'description', color, bg, opacity: 0.6, weight: 400, px: Math.max(10, Math.round(size * 0.30)) },
      ];
    }
    case 'rss':
      return [{ part: 'ticker', key: 'color', text: 'headline', color: colorOf(c.color, '#FFFFFF'), bg: bgOf(c.background, '#000000'), weight: 400, px: num(c.font_size, 24) }];
    case 'menu-board': {
      const mb = require('../menu-board');
      const m = mb.normalise(c);
      const th = mb.THEMES[m.theme];
      // With a background photo the page lays a 78% wash of the theme colour over it: close to the
      // theme colour, but the photo can still lift or sink it a little. Checked against the wash.
      const bg = { rgb: C.parseHex(th.bg) };
      const s = m.font_scale;
      const runs = [
        m.title ? { part: 'title', key: 'accent', text: m.title, color: m.accent, bg, weight: 700, vmin: 7 * s } : null,
        m.subtitle ? { part: 'subtitle', text: m.subtitle, color: th.muted, bg, weight: 400, vmin: 2.6 * s } : null,
        { part: 'section', key: 'accent', text: 'section', color: m.accent, bg, weight: 700, vmin: 3.6 * s },
        { part: 'item', text: 'item', color: th.fg, bg, weight: 650, vmin: 2.7 * s },
        m.show_descriptions ? { part: 'description', text: 'description', color: th.muted, bg, weight: 400, vmin: 1.95 * s } : null,
        { part: 'tag', text: 'tag', color: th.muted, bg, weight: 700, vmin: 1.45 * s },
      ];
      return runs.filter(Boolean).map((r) => ({ ...r, color: colorOf(r.color, '#FFFFFF'), photo: !!m.background }));
    }
    case 'directory-board': {
      const light = c.theme === 'light';
      const bg = { rgb: C.parseHex(light ? '#f5f5f5' : '#1a1a2e') };
      return [{ part: 'entries', text: 'entries', color: light ? '#1A1A2E' : '#FFFFFF', bg, weight: 400 }];
    }
    default:
      return null;
  }
}

const UNCHECKABLE = new Set(['text', 'webpage', 'social', 'cloud-doc', 'bi-dashboard']);

/**
 * @param {object} widget  { widget_type, config (object or JSON string), workspace_id }
 * @param {object} view    { distanceM, widthMm, heightMm, pxW, pxH }
 * @param {object} [opts]  { imageGrid, templateSlide(widget) → slide config | null | undefined }
 */
function checkWidget(widget, view, opts = {}) {
  let c = widget && widget.config;
  if (typeof c === 'string') { try { c = JSON.parse(c || '{}'); } catch { c = {}; } }
  c = c && typeof c === 'object' ? c : {};
  const type = widget && widget.widget_type;

  if (type === 'slide') return checkSlide(c, view, opts);
  if (type === 'template') {
    const slide = typeof opts.templateSlide === 'function' ? opts.templateSlide(widget) : undefined;
    if (slide) return checkSlide(slide, view, opts);
    return [{ code: 'unverifiable', severity: 'note', values: { why: 'code_template' } }];
  }
  if (UNCHECKABLE.has(type)) return [{ code: 'unverifiable', severity: 'note', values: { why: type === 'text' ? 'html' : 'external' } }];

  const runs = runsOf(type, c);
  if (!runs) return [];
  const issues = [];
  for (const r of runs) {
    let fontMm = null;
    if (r.px) fontMm = (r.px / (view.pxW || 1920)) * view.widthMm;
    else if (r.vmin) fontMm = (r.vmin / 100) * Math.min(view.widthMm, view.heightMm);
    for (const f of checkRun({ text: r.text, color: r.color, bg: r.bg, opacity: r.opacity, weight: r.weight, fontMm }, view)) {
      issues.push({ ...f, where: { part: r.part, key: r.key || null }, text: excerpt(r.text === r.part ? '' : r.text), ...(r.photo && f.code === 'contrast' ? { approx: true } : {}) });
    }
  }
  return issues;
}

module.exports = { checkWidget, runsOf };
