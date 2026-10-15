'use strict';

/*
 * Make a sign: the built-in sign templates.
 *
 * ⚠️ WHY THESE ARE NOT CATALOG TEMPLATES. The template catalog (lib/templates/*) is a signed remote
 * feed that is OFF by default, so a fresh self-hosted install has no templates at all — and the
 * person who most needs a ready-made sign is exactly that person, with no photos and no designer.
 * These ship in the repo, render offline, and need nothing configured.
 *
 * ⚠️ AND WHY THEY PRODUCE A SLIDE, NOT A NEW WIDGET TYPE. A sign is built here into an ordinary slide
 * (lib/slide-render.js): a template of positioned elements plus a record of field text. That is the
 * format every player already renders, and the format the deck editor already edits — so a sign made
 * in a minute from a phone is still a normal deck in Advanced → Slides the day somebody wants to move
 * one line. Nothing downstream learns a new content type.
 *
 * ⚠️ USER TEXT NEVER BECOMES MARKUP HERE. Every value an operator types is written into the slide's
 * `fields` record and nowhere else; the layout (`template`) holds only numbers this module computed
 * and colours that passed a hex allowlist. renderSlideHtml escapes field text at the one place it
 * meets HTML, and normalizeSlide clamps everything else, so a template cannot be the hole even if a
 * builder below has a bug. test/sign-templates.test.js pushes markup through every field of every
 * template to hold that.
 *
 * Geometry: a stage is 100 units wide, and ONE UNIT IS 1cqw — the same unit the renderer sizes type
 * in — so a layout can be reasoned about in one unit and converted to the renderer's % only at the
 * edge (`yp`). Landscape is 100 x 56.25, portrait 100 x 177.8.
 */

const slideRender = require('./slide-render');
const slideFonts = require('./slide-fonts');
const metrics = require('./sign-font-metrics');

const ASPECTS = Object.freeze({ '16:9': [16, 9], '9:16': [9, 16] });
const DEFAULT_DWELL = 15;
const LH = 1.08; // the renderer's .t line-height

/* ============================================================ colour */

function hex6(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return ('#' + s.slice(1).split('').map((c) => c + c).join('')).toUpperCase();
  return null;
}
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (c) => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
/** a → b by t (0 = a, 1 = b). */
const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };
function luminance(h) {
  return rgb(h).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
    .reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const WHITE = '#FFFFFF';
const INK = '#14171C';

/*
 * ⚠️ THE TEXT COLOURS ARE DERIVED, NEVER CHOSEN. A brand kit hands us whatever colours a business
 * has — a pale mint, a mid grey — and a sign whose headline is white on pale mint is unreadable from
 * across a room. So the operator picks a BACKGROUND and an ACCENT; the ink is whichever of white or
 * near-black contrasts better with that background, and an accent too close to the background to
 * read is swapped for the ink. The sign can be ugly-on-brand; it cannot be illegible.
 */
/*
 * ⚠️ AND EVERY TEXT COLOUR CLEARS WCAG AA (4.5:1), NOT MERELY "READS BETTER" (3.0: accessibility,
 * lib/a11y). The checker found the gaps the old rule left: on a mid-tone background neither white nor
 * the near-black ink reaches 4.5 (the best of the two can be 4.2); the muted line, a 30% mix towards
 * the background, fell to ~3 on saturated colours; and an accent was kept from 2.2:1. So:
 *   - the ink falls back to pure black when near-black is not enough — white or black always gives
 *     at least 4.58 against any colour;
 *   - the muted colour mixes towards the background only as far as 4.5 allows;
 *   - an accent below 4.5 is moved in LIGHTNESS ONLY (lib/a11y/contrast.suggest) until it reads, so a
 *     brand blue stays recognisably that blue rather than collapsing to the ink.
 * test/accessibility-signs.test.js runs the real checker over every design, both shapes, defaults
 * and a spread of awkward brand colours.
 */
const A11Y_MIN = 4.5;
function inkOn(bg) {
  const best = contrast(WHITE, bg) >= contrast(INK, bg) ? WHITE : INK;
  if (contrast(best, bg) >= A11Y_MIN) return best;
  return contrast(WHITE, bg) >= contrast('#000000', bg) ? WHITE : '#000000';
}
function readable(color, bg) {
  if (contrast(color, bg) >= A11Y_MIN) return color;
  return require('./a11y/contrast').suggest(color, bg, A11Y_MIN) || inkOn(bg);
}
/** ink mixed towards bg by up to `t`, stopping where the contrast would drop below AA. */
function softened(ink, bg, t) {
  for (let k = t; k > 0; k -= 0.05) {
    const c = mix(ink, bg, k);
    if (contrast(c, bg) >= A11Y_MIN) return c;
  }
  return ink;
}

function themeOf(bgIn, accentIn, extraIn) {
  const bg = hex6(bgIn) || '#111827';
  const ink = inkOn(bg);
  const rawAccent = hex6(accentIn) || mix(bg, ink, 0.6);
  const accent = readable(rawAccent, bg);
  const onAccent = inkOn(accent);
  const extra = hex6(extraIn);
  return {
    bg, ink, accent, onAccent,
    muted: softened(ink, bg, 0.3),
    faint: mix(ink, bg, 0.8),
    // Decorative shapes: present but quiet, so they never compete with the words.
    tint: mix(extra || rawAccent, bg, extra ? 0.35 : 0.72),
    extra: extra || accent,
  };
}

/* ============================================================ type measurement */

/*
 * Text is measured with the bundled fonts' real glyph widths (lib/sign-font-metrics.js), and every
 * text box is then emitted a little WIDER than the width it was measured against (TEXT_ROOM in
 * st.text). That asymmetry is deliberate: a line predicted to fit always does, so text never runs
 * into the block below it; the only cost is the rare line predicted to wrap that the browser just
 * manages to fit, which leaves a small gap rather than an overlap.
 */
const SLACK = 1;
const TEXT_ROOM = 0.03;
const fam = (font) => slideFonts.resolveFamily(font);
const textWidth = (text, size, font, weight) => metrics.textEm(text, fam(font), weight) * size * SLACK;

/** How many lines `text` wraps to at `size` in a box `width` wide — the browser's greedy wrap. */
function wrapCount(text, size, width, font = 'inter', weight = 400) {
  const space = textWidth(' ', size, font, weight);
  let lines = 0;
  for (const para of String(text || '').split('\n')) {
    const words = para.split(/[ \t]+/).filter(Boolean);
    lines++;
    let cur = 0;
    for (const word of words) {
      let ww = textWidth(word, size, font, weight);
      if (cur && cur + space + ww <= width) { cur += space + ww; continue; }
      if (cur) lines++;
      // A word longer than the box breaks anywhere (the renderer's word-break:break-word).
      while (ww > width) { lines++; ww -= width; }
      cur = ww;
    }
  }
  return lines;
}

/** The largest size from max down to min at which text fits in maxLines lines and `height`. */
function fit(text, { font = 'inter', weight = 400, max, min = 1.2, width, lines = 99, height = Infinity }) {
  let size = max;
  for (let i = 0; i < 80; i++) {
    let n = wrapCount(text, size, width, font, weight);
    if ((n <= lines && n * size * LH <= height) || size <= min) {
      /*
       * ⚠️ A LINE THAT ONLY JUST WRAPS IS SHRUNK UNTIL IT CLEARLY DOESN'T. Text boxes are emitted
       * TEXT_ROOM wider than measured, so a line predicted to wrap by a hair may fit on the wall —
       * and the layout below it would then sit a whole line too low. 4% smaller is more than the
       * room, so after this the prediction and the browser agree.
       */
      if (n > 1 && size * 0.96 >= min) {
        const fewer = wrapCount(text, size * 0.96, width, font, weight);
        if (fewer < n) { size *= 0.96; n = fewer; }
      }
      return { size: Math.round(size * 100) / 100, lines: n, h: n * size * LH };
    }
    size = Math.max(min, size * 0.95);
  }
  return { size: min, lines: 1, h: min * LH };
}

/* ============================================================ the stage */

/**
 * A stage being laid out. Everything a builder emits goes through these methods, which is what keeps
 * operator text in `fields` and out of the layout.
 */
function makeStage({ aspect, theme, fonts, brand, showLogo, preview }) {
  const [aw, ah] = ASPECTS[aspect] || ASPECTS['16:9'];
  const W = 100;
  const H = (100 * ah) / aw;
  const portrait = ah > aw;
  const elements = [];
  const fields = {};
  let n = 0;
  const yp = (v) => Math.round((v / H) * 10000) / 100;  // stage units → % of height
  const r2 = (v) => Math.round(v * 100) / 100;
  const slotFor = (base) => `${base}`.replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
  let order = 0;
  const enter = (anim = 'slideU', extra = 0) => {
    const d = Math.min(1.4, 0.15 + order++ * 0.12 + extra);
    return { animation: anim, delay: r2(d), duration: 0.7, easing: 'soft' };
  };

  const st = {
    W, H, portrait, theme, fonts, brand, preview, aspect,
    m: portrait ? 8 : 7, // the margin, in stage units
    fields, elements,
    /** A run of text. y is the TOP in stage units; height grows with the words. */
    text(slot, value, { kind = 'body', x, y, w, size, weight = 400, color, font, align = 'left', opacity = 1, anim = 'slideU', motion = true }) {
      const s = slotFor(slot);
      const room = w * TEXT_ROOM;
      const bx = align === 'right' ? x - room : align === 'center' ? x - room / 2 : x;
      elements.push({
        kind, slot: s, box: { x: r2(bx), y: yp(y), w: r2(w + room) },
        style: { color, font: font || fonts.body, size_cqw: r2(size), weight, align, opacity, radius_cqw: 0 },
        motion: motion ? enter(anim) : null,
      });
      fields[s] = String(value == null ? '' : value);
    },
    /** A filled shape. y and h in stage units; radius in cqw (a circle is radius = w/2 on a square). */
    box(slot, { x, y, w, h, color, radius = 0, opacity = 1, anim = 'fade', motion = true, kind = 'box' }) {
      elements.push({
        kind, slot: slotFor(slot), box: { x: r2(x), y: yp(y), w: r2(w), h: Math.max(0.1, yp(h)) },
        style: { color, font: fonts.body, size_cqw: 3, weight: 400, align: 'left', opacity, radius_cqw: r2(Math.min(20, radius)) },
        motion: motion ? enter(anim, 0) : null,
      });
    },
    circle(slot, { cx, cy, d, color, opacity = 1, anim = 'zoom' }) {
      // radius_cqw is capped at 20 by the renderer, so a circle wider than 40 units is drawn as two
      // overlapping rounded boxes would be wrong — it is simply capped. Builders keep d <= 40.
      st.box(slot, { x: cx - d / 2, y: cy - d / 2, w: d, h: d, color, radius: d / 2, opacity, anim });
    },
    rule(slot, { x, y, w, h = 0.18, color }) {
      st.box(slot, { x, y, w, h, color, kind: 'rule', motion: false });
    },
    image(slot, contentId, { x, y, w, h }) {
      elements.push({
        kind: 'image', slot: slotFor(slot), content_id: contentId, fit: 'contain',
        box: { x: r2(x), y: yp(y), w: r2(w), h: yp(h) },
        style: { color: WHITE, font: fonts.body, size_cqw: 3, weight: 400, align: 'left', opacity: 1, radius_cqw: 0 },
        motion: enter('fade'),
      });
    },
    /** A QR on a white card. ⚠️ Dark on light, always: a camera thresholds contrast. */
    qr(slot, payload, { x, y, size }) {
      const pad = size * 0.06;
      st.box(`${slot}_card`, { x, y, w: size, h: size, color: WHITE, radius: size * 0.06, anim: 'zoom' });
      const s = slotFor(slot);
      elements.push({
        kind: 'qr', slot: s, qr_ec: 'M', qr_fg: '#000000', qr_bg: '#FFFFFF',
        box: { x: r2(x + pad), y: yp(y + pad), w: r2(size - pad * 2), h: yp(size - pad * 2) },
        style: { color: INK, font: fonts.body, size_cqw: 3, weight: 400, align: 'left', opacity: 1, radius_cqw: 0 },
        motion: enter('zoom'),
      });
      fields[s] = String(payload || '');
    },
    /*
     * A live countdown. ⚠️ IN A PREVIEW IT IS STATIC TEXT: the dashboard draws previews in a srcdoc
     * frame, which inherits the dashboard's script-src 'self', so the renderer's ticking script never
     * runs there and a real countdown element would preview as an empty box.
     */
    countdown(slot, doneText, target, opts) {
      if (preview) {
        const ms = target - Date.now();
        let txt = doneText;
        if (ms > 0) {
          const s = Math.floor(ms / 1000);
          const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
          txt = d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m ${s % 60}s`;
        }
        st.text(slot, txt, { ...opts, kind: 'stat' });
        return;
      }
      st.text(slot, doneText, { ...opts, kind: 'countdown' });
      Object.assign(elements[elements.length - 1], { target, locale: '' });
    },
    clock(slot, opts) {
      if (preview) {
        const d = new Date();
        st.text(slot, `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, { ...opts, kind: 'stat' });
        return;
      }
      st.text(slot, '', { ...opts, kind: 'clock' });
      Object.assign(elements[elements.length - 1], { clock_format: '24', tz: '', locale: '' });
    },
    /** The workspace logo, if there is one and the sign wants it. Returns true when drawn. */
    logo(box) {
      if (!showLogo || !brand || !brand.logo_content_id) return false;
      st.image('logo', brand.logo_content_id, box);
      return true;
    },
    /** The default logo spot: top right in landscape, bottom centre in portrait. */
    cornerLogo() {
      return st.portrait
        ? st.logo({ x: 35, y: H - st.m - 12, w: 30, h: 12 })
        : st.logo({ x: W - st.m - 16, y: st.m * 0.75, w: 16, h: 8 });
    },
  };
  return st;
}

/*
 * A column of blocks laid top-down with gaps, then shifted as a whole to sit at the top, centre or
 * bottom of a region. Blocks are measured before anything is placed, which is what lets a long
 * headline push the text below it down instead of running into it.
 */
function column(st, region, blocks, valign = 'center') {
  let live = blocks.filter(Boolean);
  const measure = (bs) => bs.reduce((a, b, i) => a + b.h + (i < bs.length - 1 ? (b.gap || 0) : 0), 0);
  const room = region.bottom - region.top;
  let total = measure(live);
  /*
   * ⚠️ TOO MUCH TEXT SHRINKS THE WHOLE COLUMN, NOT THE LAST BLOCK. Every field has a length cap,
   * but a headline, a paragraph and a list all at their caps do not fit any one layout. Rather than
   * run off the bottom of the stage (or into the footer), every block that can be re-measured is
   * re-fitted at a smaller scale until the column fits — so the proportions between headline and
   * body survive, which is what keeps it looking designed. Blocks that are geometry (a countdown
   * panel, ornaments) keep their size.
   */
  for (let f = 0.92; total > room && f > 0.4; f *= 0.92) {
    live = blocks.filter(Boolean).map((b) => (b.remake ? b.remake(f) || b : b));
    total = measure(live);
  }
  let y = valign === 'top' ? region.top : valign === 'bottom' ? region.bottom - total : region.top + Math.max(0, (room - total) / 2);
  for (const b of live) { b.draw(y); y += b.h + (b.gap || 0); }
  return total;
}

/** A text block for `column`: measured now, drawn when the column places it. */
function tb(st, slot, value, o, scale = 1) {
  const text = String(value || '').trim();
  if (!text) return null;
  const f = fit(text, {
    font: o.font || st.fonts.body, weight: o.weight || 400, width: o.w, lines: o.lines, height: o.height,
    max: o.max * scale, min: Math.max(1, (o.min || 1.2) * scale),
  });
  return {
    h: f.h, gap: (o.gap == null ? f.size * 0.6 : o.gap) * scale, size: f.size,
    remake: (g) => tb(st, slot, value, o, g),
    draw: (y) => st.text(slot, text, { kind: o.kind || 'body', x: o.x, y, w: o.w, size: f.size, weight: o.weight || 400, color: o.color, font: o.font || st.fonts.body, align: o.align || 'left' }),
  };
}

/** A pill: rounded box with one line of text in it, sized to the text. */
function pill(st, slot, value, opts) {
  const { x, w: maxW, size, fill, color, weight = 700, font, align = 'left', gap, opacity = 1 } = opts;
  const text = String(value || '').trim();
  if (!text) return null;
  const f = font || st.fonts.body;
  let s = size;
  while (s > 1.2 && textWidth(text, s, f, weight) + s * 2.4 > maxW) s *= 0.94;
  const tw = Math.min(maxW - s * 2.4, textWidth(text, s, f, weight));
  const w = tw + s * 2.4;
  const h = s * LH + s * 1.1;
  const left = align === 'center' ? x + (maxW - w) / 2 : x;
  return {
    h, gap: gap == null ? s : gap,
    remake: (g) => pill(st, slot, value, { ...opts, size: size * g, gap: gap == null ? undefined : gap * g }),
    draw: (y) => {
      st.box(`${slot}_bg`, { x: left, y, w, h, color: fill, radius: h / 2, opacity });
      st.text(slot, text, { x: left + s * 1.2, y: y + s * 0.55, w: tw + s * 0.2, size: s, weight, color, font: f, align: 'center' });
    },
  };
}

/**
 * Two-column rows (a price list, opening hours): label left, value right, a hairline between rows.
 * Sized so the longest label and longest value fit side by side on ONE line each — a price list
 * whose prices wrap under their dishes is unreadable.
 */
function rowsBlock(st, slot, rows, opts) {
  const { x, w, maxH, maxSize, pitchMax, valueColor, labelColor, ruleColor, labelWeight = 500, valueWeight = 700 } = opts;
  const list = (rows || []).filter((r) => r && (r.label || r.value));
  if (!list.length) return null;
  const font = st.fonts.body;
  const nRows = list.length;
  const pitch = Math.min(pitchMax, maxH / nRows);
  let size = Math.min(maxSize, pitch * 0.46);
  const longest = (k, wt) => Math.max(...list.map((r) => textWidth(r[k] || '', 1, font, wt)));
  const lw = longest('label', labelWeight);
  const vw = longest('value', valueWeight);
  while (size > 1.2 && (lw + vw) * size + 3 > w) size *= 0.95;
  const valueW = Math.min(w * 0.6, vw * size + 1);
  const labelW = w - valueW - 1;
  return {
    h: pitch * nRows, gap: 0,
    remake: (g) => rowsBlock(st, slot, rows, { ...opts, maxSize: maxSize * g, pitchMax: pitchMax * g }),
    draw: (y0) => {
      list.forEach((r, i) => {
        const top = y0 + i * pitch;
        const ty = top + (pitch - size * LH) / 2;
        if (r.label) st.text(`${slot}${i + 1}_l`, r.label, { x, y: ty, w: labelW, size, weight: labelWeight, color: labelColor });
        if (r.value) st.text(`${slot}${i + 1}_v`, r.value, { x: x + w - valueW, y: ty, w: valueW, size, weight: valueWeight, color: valueColor(r.value), align: 'right' });
        if (i < nRows - 1) st.rule(`${slot}${i + 1}_rule`, { x, y: top + pitch, w, color: ruleColor });
      });
    },
  };
}

/* ============================================================ the templates */

/*
 * Field types: text (one line), multiline, rows (label/value pairs), datetime (an instant), color,
 * toggle, select. `more: true` fields are tucked under "More options" in the form — they are the
 * ones a person in a hurry should never have to look at.
 *
 * `sample` is the English sample text a template shows before anybody types; the dashboard shows
 * the translated sample from its own strings (signs.sample.*) instead.
 */
const COLORS = (bg, accent) => [
  { key: 'bg', type: 'color', default: bg, more: true },
  { key: 'accent', type: 'color', default: accent, more: true },
];
const LOGO = { key: 'show_logo', type: 'toggle', default: true, more: true };

const hasDigit = (s) => /\d/.test(String(s || ''));

const TEMPLATES = [
  {
    id: 'specials', name: "Today's specials",
    fields: [
      { key: 'business', type: 'text', max: 40, brand: 'business_name', sample: 'Corner Café' },
      { key: 'title', type: 'text', max: 40, required: true, sample: "Today's specials" },
      { key: 'subtitle', type: 'text', max: 120, sample: 'Freshly made every morning, right here in our kitchen.' },
      { key: 'items', type: 'rows', max_rows: 6, sample: [
        { label: 'Flat white', value: '3.20' }, { label: 'Banana bread', value: '2.80' },
        { label: 'Avocado toast', value: '7.50' }, { label: 'Soup of the day', value: '5.90' }, { label: 'Lemon tart', value: '3.60' }] },
      ...COLORS('#2B1B14', '#E0A96D'), LOGO,
    ],
    build(st, v) {
      const { theme: T, fonts: F, W, H, m, portrait } = st;
      const logo = st.cornerLogo();
      if (portrait) {
        st.circle('deco', { cx: 8, cy: H - 22, d: 40, color: T.tint });
        const top = m + 4;
        const head = [
          tb(st, 'business', v.business, { x: m, w: W - 2 * m, max: 3.8, min: 2.4, lines: 1, weight: 700, color: T.accent, gap: 2 }),
          tb(st, 'title', v.title, { kind: 'head', x: m, w: W - 2 * m, max: 15, min: 7, lines: 3, weight: 800, font: F.head, color: T.ink, gap: 3 }),
          tb(st, 'subtitle', v.subtitle, { x: m, w: W - 2 * m, max: 5.4, min: 3, lines: 4, color: T.muted, gap: 9 }),
          rowsBlock(st, 'item', v.items, { x: m, w: W - 2 * m, maxH: 80, maxSize: 6, pitchMax: 14, labelColor: T.ink, valueColor: () => T.accent, ruleColor: T.faint }),
        ];
        column(st, { top, bottom: H - m - (logo ? 16 : 0) }, head, 'top');
        return;
      }
      st.circle('deco', { cx: 8, cy: H - 6, d: 38, color: T.tint });
      column(st, { top: m, bottom: H - m }, [
        tb(st, 'business', v.business, { x: m, w: 40, max: 2.1, min: 1.4, lines: 1, weight: 700, color: T.accent, gap: 1.4 }),
        tb(st, 'title', v.title, { kind: 'head', x: m, w: 40, max: 8.5, min: 4, lines: 3, weight: 800, font: F.head, color: T.ink, gap: 2.2, height: 30 }),
        tb(st, 'subtitle', v.subtitle, { x: m, w: 36, max: 2.4, min: 1.6, lines: 4, color: T.muted }),
      ]);
      column(st, { top: m + (logo ? 6 : 0), bottom: H - m }, [
        rowsBlock(st, 'item', v.items, { x: 52, w: W - 52 - m, maxH: H - 2 * m - (logo ? 6 : 0), maxSize: 3.2, pitchMax: 8, labelColor: T.ink, valueColor: () => T.accent, ruleColor: T.faint }),
      ]);
    },
  },
  {
    id: 'sale', name: 'Sale',
    fields: [
      { key: 'big', type: 'text', max: 8, required: true, sample: '20%' },
      { key: 'title', type: 'text', max: 40, required: true, sample: 'Weekend sale' },
      { key: 'details', type: 'text', max: 140, sample: 'On all coffee beans and brewing gear. Saturday and Sunday.' },
      { key: 'cta', type: 'text', max: 40, sample: 'Ask at the counter' },
      ...COLORS('#FF3D6E', '#FFE14D'), LOGO,
    ],
    build(st, v) {
      const { theme: T, fonts: F, W, H, m, portrait } = st;
      const logo = st.cornerLogo();
      if (portrait) {
        st.circle('deco1', { cx: W - 4, cy: 14, d: 40, color: T.tint, opacity: 0.55 });
        st.circle('deco2', { cx: 6, cy: H - 30, d: 26, color: T.tint, opacity: 0.4 });
        column(st, { top: m + 6, bottom: H - m - (logo ? 16 : 0) }, [
          tb(st, 'big', v.big, { kind: 'stat', x: m, w: W - 2 * m, max: 40, min: 8, lines: 1, weight: 800, font: F.head, color: T.ink, align: 'center', gap: 4 }),
          tb(st, 'title', v.title, { kind: 'head', x: m, w: W - 2 * m, max: 12, min: 6, lines: 3, weight: 800, font: F.head, color: T.ink, align: 'center', gap: 3 }),
          tb(st, 'details', v.details, { x: m + 4, w: W - 2 * m - 8, max: 4.8, min: 3, lines: 4, color: T.ink, align: 'center', gap: 6 }),
          pill(st, 'cta', v.cta, { x: m, w: W - 2 * m, size: 4.6, fill: T.accent, color: T.onAccent, align: 'center', font: F.head }),
        ]);
        return;
      }
      st.circle('deco1', { cx: W - 2, cy: 2, d: 36, color: T.tint, opacity: 0.55 });
      st.circle('deco2', { cx: 40, cy: H + 4, d: 20, color: T.tint, opacity: 0.4 });
      column(st, { top: m, bottom: H - m }, [
        tb(st, 'big', v.big, { kind: 'stat', x: m, w: 38, max: 24, min: 4, lines: 1, weight: 800, font: F.head, color: T.ink, align: 'center' }),
      ]);
      column(st, { top: m + (logo ? 6 : 0), bottom: H - m }, [
        tb(st, 'title', v.title, { kind: 'head', x: 50, w: W - 50 - m, max: 7, min: 3.6, lines: 3, weight: 800, font: F.head, color: T.ink, gap: 2 }),
        tb(st, 'details', v.details, { x: 50, w: W - 50 - m, max: 2.6, min: 1.6, lines: 4, color: T.ink, gap: 3 }),
        pill(st, 'cta', v.cta, { x: 50, w: W - 50 - m, size: 2.3, fill: T.accent, color: T.onAccent, font: F.head }),
      ]);
    },
  },
  {
    id: 'hours', name: 'Opening hours',
    fields: [
      { key: 'title', type: 'text', max: 40, required: true, sample: 'Opening hours' },
      { key: 'rows', type: 'rows', max_rows: 7, sample: [
        { label: 'Monday – Friday', value: '7:30 – 18:00' }, { label: 'Saturday', value: '8:30 – 17:00' }, { label: 'Sunday', value: 'Closed' }] },
      { key: 'note', type: 'text', max: 100, sample: '' },
      ...COLORS('#F4EFE8', '#2F7D5B'), LOGO,
    ],
    build(st, v) {
      const { theme: T, fonts: F, W, H, m, portrait } = st;
      const logo = st.cornerLogo();
      // A value with no digits in it ("Closed", "Geschlossen", "Fermé") is the one that matters most.
      const valueColor = (val) => (hasDigit(val) ? T.ink : T.accent);
      if (!logo) {
        if (portrait) st.circle('deco', { cx: W - m - 9, cy: m + 9, d: 18, color: T.accent });
        else st.circle('deco', { cx: W - m - 6, cy: m + 5, d: 9.5, color: T.accent });
      }
      const x = portrait ? m : 10;
      const w = W - x * 2;
      column(st, { top: m + (portrait ? 20 : 2), bottom: H - m - (portrait && logo ? 16 : 0) }, [
        tb(st, 'title', v.title, { kind: 'head', x, w: portrait ? w : w - 14, max: portrait ? 15 : 6.6, min: 3.5, lines: 2, weight: 800, font: F.head, color: T.ink, gap: portrait ? 6 : 3 }),
        rowsBlock(st, 'row', v.rows, { x, w, maxH: portrait ? 100 : 30, maxSize: portrait ? 7 : 3.4, pitchMax: portrait ? 17 : 8, labelColor: T.ink, valueColor, ruleColor: T.faint, labelWeight: 400, valueWeight: 600 }),
        tb(st, 'note', v.note, { x, w, max: portrait ? 5 : 2, min: 1.4, lines: 2, color: T.muted, gap: 0 }),
      ]);
    },
  },
  {
    id: 'welcome', name: 'Welcome',
    fields: [
      { key: 'business', type: 'text', max: 40, brand: 'business_name', sample: '' },
      { key: 'title', type: 'text', max: 40, required: true, sample: 'Welcome in!' },
      { key: 'message', type: 'text', max: 140, sample: "Order at the counter and we'll bring it to your table." },
      { key: 'info_label', type: 'text', max: 20, sample: 'Wi-Fi', more: true },
      { key: 'info', type: 'text', max: 40, sample: 'CornerCafe-Guest' },
      ...COLORS('#0F766E', '#99F6E4'), LOGO,
    ],
    build(st, v) {
      const { theme: T, fonts: F, W, H, m, portrait } = st;
      const logo = st.cornerLogo();
      const x = portrait ? m : 9;
      const w = W - x - m;
      const info = String(v.info || '').trim();
      const label = String(v.info_label || '').trim();
      const infoBlock = info ? (() => {
        let size = portrait ? 4.4 : 2.3;
        while (size > 1.2 && (label ? textWidth(label, size, F.body, 400) + size : 0) + textWidth(info, size, F.body, 700) + size * 2.6 > w) size *= 0.94;
        const lw = label ? textWidth(label, size, F.body, 400) + size : 0;
        const iw = Math.min(w - lw - size * 2.6, textWidth(info, size, F.body, 700));
        const h = size * LH + size * 1.6;
        return {
          h, gap: 0,
          draw: (y) => {
            st.box('info_bg', { x, y, w: lw + iw + size * 2.6, h, color: T.ink, opacity: 0.12, radius: size * 0.7 });
            if (label) st.text('info_label', label, { x: x + size * 1.2, y: y + size * 0.8, w: lw, size, color: T.ink });
            st.text('info', info, { x: x + size * 1.2 + lw, y: y + size * 0.8, w: iw + size * 0.4, size, weight: 700, color: T.ink });
          },
        };
      })() : null;
      column(st, { top: m, bottom: H - m - (portrait && logo ? 16 : 0) }, [
        tb(st, 'business', v.business, { x, w, max: portrait ? 4 : 2.1, min: 1.4, lines: 1, weight: 700, color: T.accent, gap: portrait ? 2.5 : 1.4 }),
        tb(st, 'title', v.title, { kind: 'head', x, w, max: portrait ? 16 : 9.5, min: 4, lines: 3, weight: 800, font: F.head, color: T.ink, gap: portrait ? 4 : 2 }),
        tb(st, 'message', v.message, { x, w: portrait ? w : 70, max: portrait ? 6 : 2.8, min: 1.6, lines: 4, color: T.accent === T.ink ? T.muted : T.accent, gap: portrait ? 8 : 4 }),
        infoBlock,
      ]);
    },
  },
  {
    id: 'event', name: 'Event or live music',
    fields: [
      { key: 'eyebrow', type: 'text', max: 40, sample: 'Every Friday' },
      { key: 'title', type: 'text', max: 40, required: true, sample: 'Live music' },
      { key: 'details', type: 'text', max: 100, sample: 'From 8 pm · Free entry' },
      ...COLORS('#2A1065', '#FBBF24'), LOGO,
    ],
    build(st, v) {
      const { theme: T, fonts: F, W, H, m, portrait } = st;
      const logo = st.cornerLogo();
      // A ring: the accent disc with the background punched back into it, and a soft halo behind.
      const ring = (cx, cy, d) => {
        st.circle('halo', { cx, cy, d: d * 1.17, color: T.accent, opacity: 0.25 });
        st.circle('ring', { cx, cy, d, color: T.accent });
        st.circle('hole', { cx, cy, d: d * 0.8, color: T.bg });
      };
      if (portrait) {
        ring(W / 2, H - (logo ? 50 : 40), 40);
        column(st, { top: m + 6, bottom: H - 80 }, [
          tb(st, 'eyebrow', v.eyebrow, { x: m, w: W - 2 * m, max: 4.4, min: 2.4, lines: 1, weight: 700, color: T.accent, gap: 3 }),
          tb(st, 'title', v.title, { kind: 'head', x: m, w: W - 2 * m, max: 20, min: 8, lines: 3, weight: 800, font: F.head, color: T.ink, gap: 4 }),
          tb(st, 'details', v.details, { x: m, w: W - 2 * m, max: 6, min: 3, lines: 3, weight: 500, color: T.ink }),
        ], 'top');
        return;
      }
      ring(W - m - 15, H - m - 13, 19);
      column(st, { top: m, bottom: H - m }, [
        tb(st, 'eyebrow', v.eyebrow, { x: m, w: 55, max: 2.2, min: 1.4, lines: 1, weight: 700, color: T.accent, gap: 1.4 }),
        tb(st, 'title', v.title, { kind: 'head', x: m, w: 55, max: 10, min: 4.5, lines: 3, weight: 800, font: F.head, color: T.ink, gap: 2.2, height: 34 }),
        tb(st, 'details', v.details, { x: m, w: 55, max: 3.2, min: 1.8, lines: 2, weight: 500, color: T.ink }),
      ]);
    },
  },
  {
    id: 'announcement', name: 'Announcement',
    fields: [
      { key: 'label', type: 'text', max: 30, sample: 'Notice' },
      { key: 'title', type: 'text', max: 60, required: true, sample: 'The car park is closed on Monday' },
      { key: 'body', type: 'multiline', max: 280, max_lines: 5, sample: 'Resurfacing work starts at 7 am. Please use the public car park on Station Road — it is free for our customers all day.' },
      { key: 'footer', type: 'text', max: 80, sample: 'Thank you for your patience' },
      ...COLORS('#102A43', '#FFB020'), LOGO,
    ],
    build(st, v) {
      const { theme: T, fonts: F, W, H, m, portrait } = st;
      const logo = st.cornerLogo();
      const x = m + (portrait ? 0 : 3);
      const w = W - x - m - (portrait ? 0 : 8);
      const blocks = [
        pill(st, 'label', v.label, { x, w, size: portrait ? 3.6 : 1.8, fill: T.accent, color: T.onAccent, gap: portrait ? 4 : 2 }),
        tb(st, 'title', v.title, { kind: 'head', x, w, max: portrait ? 11 : 6.4, min: 3.2, lines: 4, weight: 800, font: F.head, color: T.ink, gap: portrait ? 4 : 2.2 }),
        tb(st, 'body', v.body, { x, w: portrait ? w : Math.min(w, 70), max: portrait ? 5.6 : 2.5, min: 1.5, lines: portrait ? 10 : 6, color: T.muted, gap: 0 }),
      ];
      const region = { top: m + (logo && !portrait ? 6 : 2), bottom: H - m - (portrait ? (logo ? 26 : 10) : 6) };
      const total = column(st, region, blocks);
      if (!portrait && total > 0) {
        const top = region.top + Math.max(0, (region.bottom - region.top - total) / 2);
        st.box('bar', { x: m - 0.2, y: top, w: 0.8, h: total, color: T.accent, radius: 0.4 });
      }
      const footer = String(v.footer || '').trim();
      if (footer) {
        const f = fit(footer, { width: w, max: portrait ? 3.6 : 1.9, min: 1.2, lines: 1 });
        st.text('footer', footer, { x, y: H - m - (portrait && logo ? 18 : 0) - f.h, w, size: f.size, color: T.accent, weight: 600 });
      }
    },
  },
  {
    id: 'hiring', name: 'Now hiring',
    fields: [
      { key: 'title', type: 'text', max: 40, required: true, sample: "We're hiring" },
      { key: 'roles', type: 'multiline', max: 200, max_lines: 5, sample: 'Barista\nKitchen assistant\nWeekend shift lead' },
      { key: 'apply', type: 'text', max: 120, sample: 'Ask at the counter or scan to apply' },
      { key: 'url', type: 'url', max: 500, sample: '' },
      ...COLORS('#FDE047', '#111827'), LOGO,
    ],
    build(st, v) {
      const { theme: T, fonts: F, W, H, m, portrait } = st;
      const logo = st.cornerLogo();
      const url = String(v.url || '').trim();
      const roles = String(v.roles || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 5);
      const colW = portrait ? W - 2 * m : (url ? 52 : W - 2 * m - 10);
      const roleSize = (() => {
        const longest = roles.reduce((a, r) => (r.length > a.length ? r : a), '');
        return longest ? fit(longest, { width: colW - 6, max: portrait ? 7.5 : 3.4, min: 1.6, lines: 1, weight: 600 }).size : 0;
      })();
      const rolesBlock = roles.length ? {
        h: roles.length * roleSize * LH * 1.35, gap: portrait ? 5 : 2.6,
        draw: (y) => roles.forEach((r, i) => {
          const ry = y + i * roleSize * LH * 1.35;
          st.box(`role${i + 1}_dot`, { x: m, y: ry + roleSize * 0.32, w: roleSize * 0.5, h: roleSize * 0.5, color: T.accent, radius: roleSize * 0.12 });
          st.text(`role${i + 1}`, r, { x: m + roleSize * 1.1, y: ry, w: colW - roleSize * 1.1, size: roleSize, weight: 600, color: T.ink });
        }),
      } : null;
      if (portrait) {
        column(st, { top: m + 4, bottom: H - m - (url ? 58 : 0) - (logo ? 16 : 0) }, [
          tb(st, 'title', v.title, { kind: 'head', x: m, w: colW, max: 19, min: 8, lines: 3, weight: 800, font: F.head, color: T.ink, gap: 7 }),
          rolesBlock,
          tb(st, 'apply', v.apply, { x: m, w: colW, max: 5.6, min: 2.6, lines: 3, color: T.muted, gap: 0 }),
        ], url ? 'top' : 'center');
        if (url) st.qr('url', url, { x: (W - 46) / 2, y: H - m - 50 - (logo ? 16 : 0), size: 46 });
        return;
      }
      column(st, { top: m, bottom: H - m }, [
        tb(st, 'title', v.title, { kind: 'head', x: m, w: colW, max: 10, min: 4.5, lines: 2, weight: 800, font: F.head, color: T.ink, gap: 2.6 }),
        rolesBlock,
        tb(st, 'apply', v.apply, { x: m, w: colW, max: 2.4, min: 1.5, lines: 2, color: T.muted, gap: 0 }),
      ]);
      if (url) st.qr('url', url, { x: W - m - 28, y: (H - 28) / 2 + (logo ? 3 : 0), size: 28 });
    },
  },
  {
    id: 'closure', name: 'Holiday closure',
    fields: [
      { key: 'title', type: 'text', max: 50, required: true, sample: 'Closed for the holidays' },
      { key: 'dates', type: 'text', max: 60, sample: '24 December – 1 January' },
      { key: 'message', type: 'text', max: 120, sample: 'Thank you for a wonderful year. See you soon!' },
      { key: 'reopen', type: 'text', max: 60, sample: 'Back on Friday 2 January' },
      ...COLORS('#0B3B2E', '#F4C95D'), LOGO,
    ],
    build(st, v) {
      const { theme: T, fonts: F, W, H, m, portrait } = st;
      const logo = st.cornerLogo();
      const w = W - 2 * m - (portrait ? 0 : 16);
      const x = (W - w) / 2;
      const dots = (y, tag) => [-1, 0, 1].forEach((k) => st.circle(`orn${tag}${k + 2}`, { cx: W / 2 + k * (portrait ? 6 : 3), cy: y, d: portrait ? 2.2 : 1.1, color: T.accent }));
      const dotsBlock = (gap, tag) => ({ h: portrait ? 2.2 : 1.1, gap, draw: (y) => dots(y + (portrait ? 1.1 : 0.55), tag) });
      column(st, { top: m + (logo && !portrait ? 6 : 0), bottom: H - m - (portrait && logo ? 16 : 0) }, [
        dotsBlock(portrait ? 6 : 3, 'a'),
        tb(st, 'title', v.title, { kind: 'head', x, w, max: portrait ? 14 : 7.5, min: 3.6, lines: 3, weight: 800, font: F.head, color: T.ink, align: 'center', gap: portrait ? 5 : 2.4 }),
        tb(st, 'dates', v.dates, { kind: 'stat', x, w, max: portrait ? 6.4 : 3.6, min: 2, lines: 2, weight: 700, color: T.accent, align: 'center', gap: portrait ? 5 : 2.4 }),
        tb(st, 'message', v.message, { x, w, max: portrait ? 5.6 : 2.4, min: 1.5, lines: 3, color: T.muted, align: 'center', gap: portrait ? 5 : 2.4 }),
        tb(st, 'reopen', v.reopen, { x, w, max: portrait ? 5.6 : 2.4, min: 1.5, lines: 2, weight: 600, color: T.ink, align: 'center', gap: portrait ? 6 : 3 }),
        dotsBlock(0, 'b'),
      ]);
    },
  },
  {
    id: 'wifi', name: 'Wi-Fi',
    fields: [
      { key: 'title', type: 'text', max: 40, required: true, sample: 'Free Wi-Fi' },
      { key: 'network', type: 'text', max: 32, required: true, sample: 'CornerCafe-Guest' },
      { key: 'password', type: 'text', max: 63, sample: 'coffee2026' },
      { key: 'security', type: 'select', options: ['WPA', 'WEP', 'nopass'], default: 'WPA', more: true },
      { key: 'network_label', type: 'text', max: 20, sample: 'Network', more: true },
      { key: 'password_label', type: 'text', max: 20, sample: 'Password', more: true },
      { key: 'note', type: 'text', max: 80, sample: 'Scan with your phone camera to connect' },
      ...COLORS('#1D4ED8', '#BFDBFE'), LOGO,
    ],
    build(st, v) {
      const { theme: T, fonts: F, W, H, m, portrait } = st;
      const logo = st.cornerLogo();
      const payload = wifiPayload(v);
      const w = portrait ? W - 2 * m : 50;
      const pair = (slot, label, value, size) => {
        const val = String(value || '').trim();
        if (!val) return null;
        const lab = String(label || '').trim();
        const vf = fit(val, { width: w, max: size, min: 1.4, lines: 1, weight: 700 });
        const ls = vf.size * 0.62;
        return {
          h: (lab ? ls * LH + ls * 0.4 : 0) + vf.h, gap: portrait ? 4 : 2,
          draw: (y) => {
            if (lab) st.text(`${slot}_label`, lab, { x: m, y, w, size: ls, color: T.accent === T.ink ? T.muted : T.accent, weight: 500 });
            st.text(slot, val, { x: m, y: y + (lab ? ls * LH + ls * 0.4 : 0), w, size: vf.size, weight: 700, color: T.ink });
          },
        };
      };
      if (portrait) {
        column(st, { top: m + 4, bottom: H }, [
          tb(st, 'title', v.title, { kind: 'head', x: m, w, max: 15, min: 7, lines: 2, weight: 800, font: F.head, color: T.ink, gap: 6 }),
          pair('network', v.network_label, v.network, 7),
          pair('password', v.password_label, v.password, 7),
        ], 'top');
        if (payload) st.qr('qr', payload, { x: (W - 56) / 2, y: H - m - 64 - (logo ? 14 : 0), size: 56 });
        const note = String(v.note || '').trim();
        if (note) {
          const f = fit(note, { width: W - 2 * m, max: 3.8, min: 2, lines: 2 });
          st.text('note', note, { x: m, y: H - m - (logo ? 14 : 0) - f.h, w: W - 2 * m, size: f.size, color: T.muted, align: 'center' });
        }
        return;
      }
      column(st, { top: m, bottom: H - m }, [
        tb(st, 'title', v.title, { kind: 'head', x: m, w, max: 8, min: 4, lines: 2, weight: 800, font: F.head, color: T.ink, gap: 3 }),
        pair('network', v.network_label, v.network, 3.6),
        pair('password', v.password_label, v.password, 3.6),
        tb(st, 'note', v.note, { x: m, w, max: 2, min: 1.3, lines: 2, color: T.muted, gap: 0 }),
      ]);
      if (payload) st.qr('qr', payload, { x: W - m - 30, y: (H - 30) / 2 + (logo ? 3 : 0), size: 30 });
    },
  },
  {
    id: 'safety', name: 'Safety notice',
    fields: [
      { key: 'label', type: 'text', max: 30, sample: 'Safety notice' },
      { key: 'title', type: 'text', max: 60, required: true, sample: 'Hard hats must be worn beyond this point' },
      { key: 'body', type: 'multiline', max: 240, max_lines: 4, sample: 'Report hazards to the site office\nVisitors must be accompanied at all times' },
      ...COLORS('#FACC15', '#111111'), LOGO,
    ],
    build(st, v) {
      const { theme: T, fonts: F, W, H, m, portrait } = st;
      const band = portrait ? 16 : 8.5;
      st.box('band', { x: 0, y: 0, w: W, h: band, color: T.accent, motion: false });
      const label = String(v.label || '').trim();
      if (label) {
        const f = fit(label, { width: W - 2 * m - 20, max: portrait ? 5.6 : 3, min: 1.6, lines: 1, weight: 800, font: F.head });
        st.text('label', label, { x: m, y: (band - f.h) / 2, w: W - 2 * m - 20, size: f.size, weight: 800, font: F.head, color: T.onAccent });
      }
      if (portrait) st.logo({ x: W - m - 22, y: 2, w: 22, h: band - 4 });
      else st.logo({ x: W - m - 16, y: 1, w: 16, h: band - 2 });
      const sign = (cx, cy, d) => {
        st.circle('sym_bg', { cx, cy, d, color: T.accent });
        st.text('sym', '!', { kind: 'stat', x: cx - d / 2, y: cy - d * 0.36, w: d, size: d * 0.6, weight: 800, font: F.head, color: T.onAccent, align: 'center', anim: 'zoom' });
      };
      const lines = String(v.body || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const x = portrait ? m : 38;
      const w = W - x - m;
      if (portrait) sign(W / 2, band + 26, 34);
      else sign(m + 13, band + (H - band) / 2, 24);
      column(st, { top: portrait ? band + 52 : band + m * 0.8, bottom: H - m }, [
        tb(st, 'title', v.title, { kind: 'head', x, w, max: portrait ? 12 : 6.4, min: 3.4, lines: 4, weight: 800, font: F.head, color: T.ink, gap: portrait ? 6 : 3, align: portrait ? 'center' : 'left' }),
        tb(st, 'body', lines.join('\n'), { x, w, max: portrait ? 5.6 : 2.6, min: 1.5, lines: 8, weight: 500, color: T.ink, gap: 0, align: portrait ? 'center' : 'left' }),
      ], portrait ? 'top' : 'center');
    },
  },
  {
    id: 'celebration', name: 'Birthday or celebration',
    fields: [
      { key: 'eyebrow', type: 'text', max: 40, sample: 'Happy birthday' },
      { key: 'name', type: 'text', max: 40, required: true, sample: 'Maria' },
      { key: 'message', type: 'text', max: 120, sample: 'From all of us at the Corner Café team' },
      ...COLORS('#6D28D9', '#F9A8D4'), { key: 'extra', type: 'color', default: '#FDE68A', more: true }, LOGO,
    ],
    build(st, v) {
      const { theme: T, fonts: F, W, H, m, portrait } = st;
      const logo = st.cornerLogo();
      // Confetti, at fixed spots near the edges — deterministic, so a republish never moves it.
      const spots = portrait
        ? [[10, 12, 5], [84, 8, 3.4], [92, 30, 6], [6, 42, 3], [88, 118, 4], [12, 128, 6], [80, 150, 3], [20, 160, 3.6], [52, 6, 2.6], [50, 170, 2.6]]
        : [[6, 8, 3], [18, 46, 2], [30, 6, 1.6], [70, 5, 2.4], [88, 14, 3.6], [94, 40, 2], [80, 48, 3], [9, 28, 1.6], [56, 50, 1.6], [44, 4, 1.2]];
      const palette = [T.accent, T.extra, T.ink];
      spots.forEach(([cx, cy, d], i) => {
        if (logo && !portrait && cx > 70 && cy < 16) return;
        st.circle(`confetti${i + 1}`, { cx, cy: portrait ? cy : cy, d, color: palette[i % 3], opacity: i % 3 === 2 ? 0.35 : 0.9 });
      });
      const w = W - 2 * m - (portrait ? 0 : 20);
      const x = (W - w) / 2;
      column(st, { top: m, bottom: H - m - (portrait && logo ? 16 : 0) }, [
        tb(st, 'eyebrow', v.eyebrow, { x, w, max: portrait ? 8.5 : 4, min: 2, lines: 2, weight: 700, color: T.accent, align: 'center', gap: portrait ? 3 : 1.6 }),
        tb(st, 'name', v.name, { kind: 'head', x, w, max: portrait ? 22 : 13, min: 5, lines: 2, weight: 800, font: F.head, color: T.ink, align: 'center', gap: portrait ? 5 : 2.6 }),
        tb(st, 'message', v.message, { x, w, max: portrait ? 6 : 2.6, min: 1.5, lines: 3, color: T.muted, align: 'center', gap: 0 }),
      ]);
    },
  },
  {
    id: 'countdown', name: 'Countdown',
    fields: [
      { key: 'title', type: 'text', max: 50, required: true, sample: 'Grand opening in' },
      { key: 'target', type: 'datetime', required: true, sample: null },
      { key: 'done', type: 'text', max: 40, sample: "We're open!" },
      { key: 'subtitle', type: 'text', max: 100, sample: 'Saturday 10 am · 12 High Street' },
      ...COLORS('#0B1220', '#22D3EE'), LOGO,
    ],
    build(st, v) {
      const { theme: T, fonts: F, W, H, m, portrait } = st;
      const logo = st.cornerLogo();
      const w = W - 2 * m;
      const target = Number(v.target) || (Date.now() + 7 * 86400000);
      // The live text changes every second; size it for the widest it can be ("888d 88h 88m").
      const cs = fit('888d 88h 88m', { font: F.head, weight: 800, max: portrait ? 15 : 10, min: 3, width: w - 4, lines: 1 }).size;
      const cdBlock = {
        h: cs * LH, gap: portrait ? 6 : 3,
        draw: (y) => {
          st.box('cd_bg', { x: m, y: y - cs * 0.3, w, h: cs * LH + cs * 0.6, color: T.accent, opacity: 0.12, radius: cs * 0.25 });
          st.countdown('countdown', String(v.done || ''), target, { x: m, y, w, size: cs, weight: 800, font: F.head, color: T.accent, align: 'center' });
        },
      };
      column(st, { top: m + (logo && !portrait ? 6 : 0), bottom: H - m - (portrait && logo ? 16 : 0) }, [
        tb(st, 'title', v.title, { kind: 'head', x: m, w, max: portrait ? 12 : 6, min: 3, lines: 3, weight: 800, font: F.head, color: T.ink, align: 'center', gap: portrait ? 9 : 4 }),
        cdBlock,
        tb(st, 'subtitle', v.subtitle, { x: m, w, max: portrait ? 5.6 : 2.6, min: 1.5, lines: 3, color: T.muted, align: 'center', gap: 0 }),
      ]);
    },
  },
  {
    id: 'reception', name: 'Room or reception',
    fields: [
      { key: 'eyebrow', type: 'text', max: 40, sample: 'Meeting room' },
      { key: 'title', type: 'text', max: 40, required: true, sample: 'Harbour View' },
      { key: 'subtitle', type: 'text', max: 100, sample: 'Product team weekly · 10:00 – 11:30' },
      { key: 'rows', type: 'rows', max_rows: 4, sample: [{ label: 'Floor', value: '2' }, { label: 'Host', value: 'Anna Berg' }, { label: 'Wi-Fi', value: 'Guest' }] },
      { key: 'show_clock', type: 'toggle', default: true, more: true },
      ...COLORS('#EEF2F6', '#3056D3'), LOGO,
    ],
    build(st, v) {
      const { theme: T, fonts: F, W, H, m, portrait } = st;
      const logo = st.cornerLogo();
      if (portrait) {
        st.box('stripe', { x: 0, y: 0, w: W, h: 2, color: T.accent, motion: false });
        if (v.show_clock) st.clock('clock', { x: m, y: m + 2, w: W - 2 * m, size: 6, weight: 600, font: F.head, color: T.muted, align: 'right' });
        column(st, { top: m + 18, bottom: H - m - (logo ? 16 : 0) }, [
          tb(st, 'eyebrow', v.eyebrow, { x: m, w: W - 2 * m, max: 4.6, min: 2.4, lines: 1, weight: 700, color: T.accent, gap: 3 }),
          tb(st, 'title', v.title, { kind: 'head', x: m, w: W - 2 * m, max: 14, min: 6, lines: 3, weight: 800, font: F.head, color: T.ink, gap: 4 }),
          tb(st, 'subtitle', v.subtitle, { x: m, w: W - 2 * m, max: 5.8, min: 2.6, lines: 3, color: T.muted, gap: 10 }),
          rowsBlock(st, 'row', v.rows, { x: m, w: W - 2 * m, maxH: 60, maxSize: 5.2, pitchMax: 13, labelColor: T.muted, valueColor: () => T.ink, ruleColor: T.faint, labelWeight: 400, valueWeight: 600 }),
        ], 'top');
        return;
      }
      st.box('stripe', { x: 0, y: 0, w: 1.2, h: H, color: T.accent, motion: false });
      if (v.show_clock) st.clock('clock', { x: 60, y: m * 0.8, w: W - 60 - m - (logo ? 18 : 0), size: 3, weight: 600, font: F.head, color: T.muted, align: 'right' });
      column(st, { top: m, bottom: H - m }, [
        tb(st, 'eyebrow', v.eyebrow, { x: m, w: 50, max: 2.2, min: 1.4, lines: 1, weight: 700, color: T.accent, gap: 1.6 }),
        tb(st, 'title', v.title, { kind: 'head', x: m, w: 50, max: 7.5, min: 3.5, lines: 3, weight: 800, font: F.head, color: T.ink, gap: 2 }),
        tb(st, 'subtitle', v.subtitle, { x: m, w: 46, max: 2.5, min: 1.5, lines: 3, color: T.muted, gap: 0 }),
      ]);
      column(st, { top: m + 8, bottom: H - m }, [
        rowsBlock(st, 'row', v.rows, { x: 62, w: W - 62 - m, maxH: 34, maxSize: 2.6, pitchMax: 8, labelColor: T.muted, valueColor: () => T.ink, ruleColor: T.faint, labelWeight: 400, valueWeight: 600 }),
      ]);
    },
  },
  {
    id: 'qr', name: 'Scan me',
    fields: [
      { key: 'title', type: 'text', max: 40, required: true, sample: 'See our full menu' },
      { key: 'message', type: 'text', max: 120, sample: 'Point your phone camera at the code.' },
      { key: 'url', type: 'url', max: 500, required: true, sample: 'https://example.com/menu' },
      { key: 'caption', type: 'text', max: 60, sample: 'example.com/menu' },
      ...COLORS('#111827', '#A3E635'), LOGO,
    ],
    build(st, v) {
      const { theme: T, fonts: F, W, H, m, portrait } = st;
      const logo = st.cornerLogo();
      const url = String(v.url || '').trim();
      if (portrait) {
        column(st, { top: m + 4, bottom: H }, [
          tb(st, 'title', v.title, { kind: 'head', x: m, w: W - 2 * m, max: 14, min: 6, lines: 3, weight: 800, font: F.head, color: T.ink, align: 'center', gap: 4 }),
          tb(st, 'message', v.message, { x: m, w: W - 2 * m, max: 6, min: 2.6, lines: 3, color: T.muted, align: 'center' }),
        ], 'top');
        if (url) st.qr('url', url, { x: (W - 60) / 2, y: H - m - 72 - (logo ? 12 : 0), size: 60 });
        const cap = String(v.caption || '').trim();
        if (cap) {
          const f = fit(cap, { width: W - 2 * m, max: 4.4, min: 2, lines: 1, weight: 700 });
          st.text('caption', cap, { x: m, y: H - m - 8 - (logo ? 12 : 0), w: W - 2 * m, size: f.size, weight: 700, color: T.accent, align: 'center' });
        }
        return;
      }
      column(st, { top: m, bottom: H - m }, [
        tb(st, 'title', v.title, { kind: 'head', x: m, w: 52, max: 8, min: 4, lines: 3, weight: 800, font: F.head, color: T.ink, gap: 2.4 }),
        tb(st, 'message', v.message, { x: m, w: 50, max: 2.6, min: 1.5, lines: 3, color: T.muted, gap: 3 }),
        tb(st, 'caption', v.caption, { x: m, w: 52, max: 2.6, min: 1.5, lines: 1, weight: 700, color: T.accent, gap: 0 }),
      ]);
      if (url) st.qr('url', url, { x: W - m - 32, y: (H - 32) / 2 + (logo ? 3 : 0), size: 32 });
    },
  },
];

const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

/*
 * The Wi-Fi join string phones understand (the ZXing "WIFI:" convention). ⚠️ ESCAPED: \ ; , : and "
 * are syntax in it, so a password containing ";" would otherwise end the field early and the phone
 * would join with the wrong password — a sign that looks right and does not work.
 */
function wifiPayload(v) {
  const ssid = String(v.network || '').trim();
  if (!ssid) return '';
  const e = (s) => String(s).replace(/([\\;,:"])/g, '\\$1');
  const sec = ['WPA', 'WEP', 'nopass'].includes(v.security) ? v.security : 'WPA';
  const pw = String(v.password || '');
  if (sec === 'nopass' || !pw) return `WIFI:T:nopass;S:${e(ssid)};;`;
  return `WIFI:T:${sec};S:${e(ssid)};P:${e(pw)};;`;
}

/* ============================================================ values */

// C0 controls and DEL, except newline (multiline fields keep it). Nothing here is HTML-escaped: the
// renderer does that at the one place text meets markup, and doing it twice shows "&amp;" on a wall.
const CTRL = /[\u0000-\u0009\u000B-\u001F\u007F]/g;
const oneLine = (s) => String(s).replace(/\r\n?|\n/g, ' ').replace(CTRL, '').trim();

/**
 * Validate an operator's values against a template's fields.
 *
 * Always returns usable values; `errors` lists what a strict caller (creating the sign) refuses. A
 * missing key gets the field's sample text only when `samples` is set (the gallery's previews) —
 * a field somebody cleared on purpose must stay empty, not grow sample text back.
 */
function validateValues(tpl, raw, { samples = false, brand = null } = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const values = {};
  const errors = [];
  for (const f of tpl.fields) {
    const v = has(f.key) ? src[f.key] : undefined;
    const fromBrand = f.brand && brand && brand[f.brand] ? brand[f.brand] : null;
    switch (f.type) {
      case 'text':
      case 'url': {
        let s = v === undefined ? (fromBrand || (samples ? f.sample || '' : '')) : (v == null || typeof v === 'object' ? '' : oneLine(v));
        if (s.length > f.max) { errors.push({ field: f.key, code: 'too_long' }); s = s.slice(0, f.max); }
        values[f.key] = s;
        break;
      }
      case 'multiline': {
        let s = v === undefined ? (samples ? f.sample || '' : '') : (v == null || typeof v === 'object' ? '' : String(v).replace(/\r\n?/g, '\n').replace(CTRL, ''));
        const lines = s.split('\n').map((l) => l.trim());
        if (lines.length > f.max_lines) errors.push({ field: f.key, code: 'too_many_lines' });
        s = lines.slice(0, f.max_lines).join('\n').trim();
        if (s.length > f.max) { errors.push({ field: f.key, code: 'too_long' }); s = s.slice(0, f.max); }
        values[f.key] = s;
        break;
      }
      case 'rows': {
        const list = v === undefined ? (samples ? f.sample || [] : []) : (Array.isArray(v) ? v : []);
        if (v !== undefined && !Array.isArray(v)) errors.push({ field: f.key, code: 'invalid' });
        if (list.length > f.max_rows) errors.push({ field: f.key, code: 'too_many_rows' });
        values[f.key] = list.slice(0, f.max_rows).map((r) => {
          const o = r && typeof r === 'object' ? r : {};
          return {
            label: oneLine(typeof o.label === 'string' || typeof o.label === 'number' ? o.label : '').slice(0, 60),
            value: oneLine(typeof o.value === 'string' || typeof o.value === 'number' ? o.value : '').slice(0, 30),
          };
        }).filter((r) => r.label || r.value);
        break;
      }
      case 'datetime': {
        const n = typeof v === 'number' ? v : (typeof v === 'string' && v ? Date.parse(v) : NaN);
        if (Number.isFinite(n) && n > 0 && n < Date.UTC(2200, 0, 1)) values[f.key] = Math.round(n);
        else {
          if (v !== undefined && v !== '' && v !== null) errors.push({ field: f.key, code: 'invalid' });
          values[f.key] = samples ? Date.now() + 9 * 86400000 + 4 * 3600000 : null;
        }
        break;
      }
      case 'color': {
        const brandColor = brand && Array.isArray(brand.colors) ? brand.colors[{ bg: 0, accent: 1, extra: 2 }[f.key]] : null;
        const c = hex6(v);
        if (v !== undefined && v !== '' && v !== null && !c) errors.push({ field: f.key, code: 'invalid' });
        values[f.key] = c || hex6(brandColor) || f.default;
        break;
      }
      case 'toggle':
        values[f.key] = v === undefined ? (f.key === 'show_logo' ? !!(brand && brand.logo_content_id) : !!f.default) : v === true || v === 'true' || v === 1;
        break;
      case 'select':
        if (v !== undefined && !f.options.includes(v)) errors.push({ field: f.key, code: 'invalid' });
        values[f.key] = f.options.includes(v) ? v : f.default;
        break;
      default:
        break;
    }
    if (f.required) {
      const val = values[f.key];
      const empty = val == null || val === '' || (Array.isArray(val) && !val.length);
      if (empty && !errors.some((e) => e.field === f.key)) errors.push({ field: f.key, code: 'required' });
    }
  }
  // rows fields: at least one row when the template is about the rows (none are required today).
  return { values, errors };
}

/* ============================================================ build */

function fontsFor(brand) {
  const head = brand && typeof brand.font === 'string' && Object.prototype.hasOwnProperty.call(slideFonts.FAMILIES, brand.font)
    ? brand.font : 'archivo';
  return { head, body: 'inter' };
}

/**
 * A template + values → one slide, in the stored deck shape.
 *
 * @returns {{ slide, aspect, name, errors }} — `slide` is ready to go into a deck document as is.
 */
function buildSign(templateId, rawValues, { aspect = '16:9', brand = null, samples = false, preview = false } = {}) {
  const tpl = BY_ID.get(templateId);
  if (!tpl) { const e = new Error('Unknown template'); e.status = 400; throw e; }
  const asp = Object.prototype.hasOwnProperty.call(ASPECTS, aspect) ? aspect : '16:9';
  const { values, errors } = validateValues(tpl, rawValues, { samples, brand });
  const theme = themeOf(values.bg, values.accent, values.extra);
  const st = makeStage({ aspect: asp, theme, fonts: fontsFor(brand), brand, showLogo: values.show_logo !== false, preview });
  tpl.build(st, values);
  // A preview is a still: an entrance replayed on every keystroke is noise, and a gallery thumbnail
  // caught mid-animation looks broken. The published sign keeps its motion.
  if (preview) for (const e of st.elements) e.motion = null;
  const titleish = values.title || values.name || values.big || tpl.name;
  const slide = {
    name: String(titleish).slice(0, 120),
    dwell_sec: DEFAULT_DWELL,
    template: { background: theme.bg, aspect: asp, elements: st.elements.slice(0, slideRender.MAX_ELEMENTS) },
    fields: st.fields,
  };
  return { slide, aspect: asp, name: String(titleish).slice(0, 120), values, errors };
}

/** The sign as a standalone HTML document, through the slide renderer — the same bytes a player gets. */
function renderSign(templateId, rawValues, opts = {}) {
  const { slide } = buildSign(templateId, rawValues, { ...opts, preview: true });
  const html = slideRender.renderSlideHtml({ template: slide.template, fields: slide.fields }, {
    resolveImage: opts.resolveImage, resolveFont: opts.resolveFont,
  });
  /*
   * ⚠️ A PREVIEW CARRIES NO SCRIPT AT ALL. The dashboard shows it in a frame sandboxed with no
   * permissions, where the renderer's fitter and ticker could never run — each blocked script is a
   * console error per frame, fourteen per gallery — and nothing in a preview needs them: the stage is
   * sized by the frame's own aspect ratio and live elements were drawn as text above. Both scripts
   * are the renderer's constants; operator text is escaped, so it cannot contain a <script> tag.
   */
  return html.replace(/<script>[\s\S]*?<\/script>/g, '');
}

/** What the dashboard needs to draw a form: ids and field specs, no builders. */
function catalogue() {
  return TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    fields: t.fields.map((f) => {
      const o = { key: f.key, type: f.type };
      for (const k of ['max', 'max_rows', 'max_lines', 'required', 'options', 'default', 'more', 'brand', 'sample']) {
        if (f[k] !== undefined) o[k] = f[k];
      }
      return o;
    }),
  }));
}

module.exports = {
  ASPECTS, DEFAULT_DWELL, TEMPLATES,
  catalogue, validateValues, buildSign, renderSign, wifiPayload,
  // Exported for tests.
  themeOf, contrast, fit, wrapCount, hex6,
  getTemplate: (id) => BY_ID.get(id) || null,
};
