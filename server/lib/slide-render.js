'use strict';

/*
 * Slide widgets: a template joined to a record, at render time.
 *
 * ⚠️ THE ONE THING THIS FILE EXISTS TO DO: keep the changeable text OUT of the layout.
 *
 * Every other widget in this codebase bakes its content into `config.html` and re-emits the whole
 * document on every edit. That is fine for a clock. It is fatal for a slide somebody comes back to
 * three months later to change a number, because there is no route back to the form — the HTML IS
 * the record, and it has already lost which parts were fields.
 *
 * Fifteen signage products were surveyed before this was written and not one of them makes the
 * changeable text part of the template. Scala has template variables bound to a CMS record;
 * Appspace pairs `schema.json` with `model.json`; Xibo deliberately keeps widget HTML and widget
 * data in SEPARATE files so a data change never rebuilds the layout. The single vendor that does
 * what ScreenTinker does today is the one where editing later genuinely breaks.
 *
 * So: `config.template` is a VIEW — geometry, style, motion, and a `slot` name per element.
 * `config.fields` is a RECORD — `{ slot: value }`. They meet here and nowhere else. Editing a
 * headline writes one string into `fields` and bumps the widget's rev; the template is untouched,
 * which is what makes the round trip possible at all.
 *
 * ⚠️ EVERYTHING IS BOUNDED, because all of it lands in an HTML document. Values are clamped to
 * ranges and allowlists rather than sanitised in place: an out-of-range number becomes the nearest
 * legal one, an unknown enum becomes the default, and unknown keys are dropped entirely. A slide is
 * authored by a workspace editor and rendered into a sandboxed iframe, but "it is only staff" is
 * not a security model, and a 40,000-character headline is a layout attack whoever typed it.
 */

const MAX_ELEMENTS = 40;
const MAX_FIELD_CHARS = 2000;
const MAX_FIELDS = 60;

/*
 * The entrance vocabulary, as CSS keyframe names.
 *
 * ⚠️ CSS ONLY, AND THAT IS A PLATFORM DECISION RATHER THAN A STYLISTIC ONE. BrightSign's
 * `nodejs_enabled` breaks CommonJS-first UMD modules silently — it has already cost this project
 * transitions, dayparting, mute and video-wall geometry. A JavaScript motion library is exactly
 * that shape of dependency, and its failure mode is a BLANK slide. A keyframe that a player does
 * not understand leaves the element simply present, correctly laid out, which is the only
 * acceptable way for motion to fail on a wall.
 */
const ANIMATIONS = Object.freeze({
  fade:   'st-fade',
  slideL: 'st-slide-l',
  slideR: 'st-slide-r',
  slideU: 'st-slide-u',
  slideD: 'st-slide-d',
  zoom:   'st-zoom',
  wipe:   'st-wipe',
});

const EASINGS = Object.freeze({
  'ease-out': 'ease-out',
  'ease-in': 'ease-in',
  'ease-in-out': 'ease-in-out',
  'linear': 'linear',
  'soft': 'cubic-bezier(.2,.8,.2,1)',
});

/*
 * ⚠️ FONTS ARE A REQUEST, NOT A GUARANTEE, AND THE STACKS SAY SO.
 *
 * There is no font pipeline at any layer of this product: no @font-face anywhere, no font files
 * shipped, and `lib/upload-sniff.js` accepts only image and video magic bytes, so a font cannot
 * even be uploaded. The designer already offers "Impact", which exists on none of Android, Tizen or
 * BrightSign — so that slide renders as something different on every panel, and differently again
 * on each.
 *
 * Until that is fixed, every family here ends in a GENERIC keyword. The named face is used where a
 * platform happens to have it and the generic carries it everywhere else, which is a predictable
 * degrade rather than a silent substitution to whatever the panel's fallback happens to be. The
 * editor is expected to say this out loud rather than present a font menu that implies a promise.
 */
const FONTS = Object.freeze({
  sans:      "system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif",
  serif:     "Georgia, 'Times New Roman', Times, serif",
  mono:      "ui-monospace, 'DejaVu Sans Mono', 'Courier New', monospace",
  condensed: "'Arial Narrow', 'Helvetica Neue Condensed', sans-serif",
});

/** Text kinds carry a field value; the rest are decoration and never read `fields`. */
const KINDS = Object.freeze({
  head:  { text: true },
  body:  { text: true },
  stat:  { text: true },
  image: { text: false },
  rule:  { text: false },
  box:   { text: false },
});

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

/*
 * ⚠️ A COLOUR IS SIX OR THREE HEX DIGITS OR IT IS THE DEFAULT.
 *
 * Not a CSS colour parser. This value is interpolated into a style attribute, and the set of
 * strings CSS accepts there is far larger than the set that is safe to concatenate — `url(...)`,
 * `expression(...)` and anything carrying a `;` or a `}` all live in it. An allowlist of hex is
 * everything a slide editor needs to emit and nothing it does not.
 */
function color(v, dflt) {
  return (typeof v === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim()))
    ? v.trim() : dflt;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** A slot name — the join key between template and record. */
const SLOT_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

/**
 * Validate and clamp a stored slide config into exactly the shape the renderer expects.
 *
 * ⚠️ TOTAL, NOT PARTIAL. It never throws and never returns null: a malformed slide still renders,
 * because the alternative on a wall is a blank screen. What it does is refuse to carry anything it
 * did not recognise, so the renderer below can interpolate every value it is handed without
 * re-checking. The two halves are only safe as a pair.
 */
function normalizeSlide(raw) {
  const cfg = (raw && typeof raw === 'object') ? raw : {};
  const tplIn = (cfg.template && typeof cfg.template === 'object') ? cfg.template : {};
  const fieldsIn = (cfg.fields && typeof cfg.fields === 'object' && !Array.isArray(cfg.fields)) ? cfg.fields : {};

  const fields = {};
  let n = 0;
  for (const [k, v] of Object.entries(fieldsIn)) {
    if (n++ >= MAX_FIELDS) break;
    if (!SLOT_RE.test(k)) continue;
    // Coerced rather than skipped: a number typed into a field is a perfectly reasonable value and
    // arrives from JSON as a number. Objects and arrays are not values and are dropped.
    if (v == null) { fields[k] = ''; continue; }
    if (typeof v === 'object') continue;
    fields[k] = String(v).slice(0, MAX_FIELD_CHARS);
  }

  const elsIn = Array.isArray(tplIn.elements) ? tplIn.elements.slice(0, MAX_ELEMENTS) : [];
  const elements = elsIn.map((e, i) => {
    const src = (e && typeof e === 'object') ? e : {};
    const kind = Object.prototype.hasOwnProperty.call(KINDS, src.kind) ? src.kind : 'body';
    const box = (src.box && typeof src.box === 'object') ? src.box : {};
    const style = (src.style && typeof src.style === 'object') ? src.style : {};
    const m = (src.motion && typeof src.motion === 'object') ? src.motion : null;

    const slot = (typeof src.slot === 'string' && SLOT_RE.test(src.slot)) ? src.slot : `slot_${i}`;

    return {
      slot,
      kind,
      // ⚠️ Percentages, and allowed slightly outside 0-100 on purpose: sliding a strapline off the
      // edge is a legitimate design, and clamping it to the frame would silently move somebody's
      // layout rather than render what they built.
      x: clamp(box.x, -50, 150, 0),
      y: clamp(box.y, -50, 150, 0),
      w: clamp(box.w, 0.5, 200, 40),
      h: box.h == null ? null : clamp(box.h, 0.1, 200, 10),
      contentId: typeof src.content_id === 'string' && src.content_id.length <= 64 ? src.content_id : null,
      style: {
        color: color(style.color, '#FFFFFF'),
        font: Object.prototype.hasOwnProperty.call(FONTS, style.font) ? style.font : 'sans',
        // Container units, NEVER px. A slide is authored once and lands on panels from 720p to 4K,
        // and px is how the designer ended up with a regex that divides by 108 to rescue old
        // widgets. cqw against a sized container is the same number on every screen.
        size: clamp(style.size_cqw, 0.2, 40, 3),
        weight: Math.round(clamp(style.weight, 100, 900, 400) / 100) * 100,
        align: ['left', 'center', 'right'].includes(style.align) ? style.align : 'left',
        radius: clamp(style.radius_cqw, 0, 20, 0),
        opacity: clamp(style.opacity, 0, 1, 1),
      },
      motion: (m && Object.prototype.hasOwnProperty.call(ANIMATIONS, m.animation)) ? {
        animation: m.animation,
        // Bounded well below anything sane: a 40-second delay on a 10-second slide is not a slow
        // entrance, it is an element that never appears, and the editor should have refused it.
        delay: clamp(m.delay, 0, 30, 0),
        duration: clamp(m.duration, 0.05, 10, 0.5),
        easing: Object.prototype.hasOwnProperty.call(EASINGS, m.easing) ? m.easing : 'ease-out',
      } : null,
    };
  });

  return {
    background: color(tplIn.background, '#000000'),
    elements,
    fields,
  };
}

/**
 * How long after the slide appears the last element finishes arriving, in seconds.
 *
 * ⚠️ THE NUMBER THE EDITOR HAS TO SHOW. A slide's motion must finish inside the playlist item's
 * duration, and nothing in the authoring path currently knows that those two things are related.
 * An animation that outlives its dwell is not a subtle defect: the text is still moving when the
 * slide is replaced, so on the wall it reads as content that never arrives — and it looks exactly
 * like a broken player rather than a slide someone mis-timed.
 */
function settleTime(slide) {
  return (slide.elements || []).reduce(
    (max, e) => (e.motion ? Math.max(max, e.motion.delay + e.motion.duration) : max), 0);
}

/**
 * Join the template to the record and emit a standalone document.
 *
 * `resolveImage(contentId)` returns a URL or null; injected rather than imported so this module
 * stays a pure function of its inputs and can be tested without a database.
 */
function renderSlideHtml(rawConfig, opts = {}) {
  const slide = normalizeSlide(rawConfig);
  const resolveImage = typeof opts.resolveImage === 'function' ? opts.resolveImage : () => null;

  const body = slide.elements.map((e) => {
    const s = e.style;
    const css = [
      `left:${e.x}%`, `top:${e.y}%`, `width:${e.w}%`,
      e.h == null ? '' : `height:${e.h}%`,
      s.opacity === 1 ? '' : `opacity:${s.opacity}`,
      s.radius ? `border-radius:${s.radius}cqw` : '',
    ];

    if (e.motion) {
      const m = e.motion;
      css.push(
        `animation-name:${ANIMATIONS[m.animation]}`,
        `animation-duration:${m.duration}s`,
        `animation-delay:${m.delay}s`,
        `animation-timing-function:${EASINGS[m.easing]}`,
        // ⚠️ `both`, so the element holds its FROM state through the delay. Without it every
        // element is painted in place on frame one and then jumps to its entrance when its delay
        // elapses — the slide flashes its finished layout before animating into it.
        'animation-fill-mode:both',
      );
    }

    if (e.kind === 'rule' || e.kind === 'box') {
      css.push(`background:${s.color}`);
      return `<div class="e" style="${css.filter(Boolean).join(';')}"></div>`;
    }

    if (e.kind === 'image') {
      const url = resolveImage(e.contentId);
      css.push('overflow:hidden');
      const inner = url
        ? `<img src="${escapeHtml(url)}" alt="">`
        // A slide whose photo is missing says so, quietly, rather than leaving a hole an operator
        // has to guess at. It is deliberately unobtrusive: on a wall this is better than a red box.
        : `<div class="ph"></div>`;
      return `<div class="e" style="${css.filter(Boolean).join(';')}">${inner}</div>`;
    }

    css.push(
      `color:${s.color}`,
      `font-family:${FONTS[s.font]}`,
      `font-size:${s.size}cqw`,
      `font-weight:${s.weight}`,
      `text-align:${s.align}`,
    );
    return `<div class="e t" style="${css.filter(Boolean).join(';')}">${escapeHtml(slide.fields[e.slot] || '')}</div>`;
  }).join('\n    ');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body { margin:0; height:100%; overflow:hidden; background:${slide.background}; }
  /* ⚠️ container-type:size is what makes every cqw above mean anything. Without it the units
     resolve against the viewport and a slide inside a ZONE renders at full-screen sizes. */
  .stage { position:relative; width:100%; height:100%; container-type:size; }
  .e { position:absolute; }
  .t { line-height:1.08; white-space:pre-wrap; word-break:break-word; }
  .e img { width:100%; height:100%; object-fit:cover; display:block; }
  .ph { width:100%; height:100%; background:rgba(255,255,255,.06);
        border:1px dashed rgba(255,255,255,.18); box-sizing:border-box; }
  @keyframes st-fade    { from { opacity:0 } to { opacity:1 } }
  @keyframes st-slide-l { from { opacity:0; transform:translateX(-14%) } to { opacity:1; transform:none } }
  @keyframes st-slide-r { from { opacity:0; transform:translateX(14%) }  to { opacity:1; transform:none } }
  @keyframes st-slide-u { from { opacity:0; transform:translateY(26%) }  to { opacity:1; transform:none } }
  @keyframes st-slide-d { from { opacity:0; transform:translateY(-26%) } to { opacity:1; transform:none } }
  @keyframes st-zoom    { from { opacity:0; transform:scale(.86) }       to { opacity:1; transform:none } }
  @keyframes st-wipe    { from { clip-path:inset(0 100% 0 0) }           to { clip-path:inset(0 0 0 0) } }
</style></head>
<body><div class="stage">
    ${body}
</div></body></html>`;
}

module.exports = {
  ANIMATIONS, EASINGS, FONTS, KINDS,
  MAX_ELEMENTS, MAX_FIELD_CHARS, MAX_FIELDS,
  normalizeSlide, settleTime, renderSlideHtml,
};
