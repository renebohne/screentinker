'use strict';

/*
 * Make a sign: the built-in templates (lib/sign-templates.js).
 *
 * ⚠️ THE TEST THAT MATTERS MOST IS THE MARKUP ONE. Every field of every template is text a person
 * typed, and every template ends up as an HTML document on a wall and in a dashboard frame. The
 * builders are a lot of code that handles that text, so this pushes markup through EVERY field of
 * EVERY template in BOTH shapes and in both renders (the gallery preview and the published widget)
 * and checks it arrives as characters, never as elements or attributes.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const signs = require('../lib/sign-templates');
const slideRender = require('../lib/slide-render');
const deckLib = require('../lib/slide-deck');

const ASPECTS = Object.keys(signs.ASPECTS);

test('there are 12-16 built-in templates with unique ids and well-formed fields', () => {
  const cat = signs.catalogue();
  assert.ok(cat.length >= 12 && cat.length <= 16, `${cat.length} templates`);
  assert.equal(new Set(cat.map((t) => t.id)).size, cat.length);
  const TYPES = new Set(['text', 'multiline', 'rows', 'datetime', 'color', 'toggle', 'select', 'url']);
  for (const t of cat) {
    assert.match(t.id, /^[a-z]+$/);
    assert.ok(t.fields.some((f) => f.required), `${t.id} has no required field`);
    for (const f of t.fields) {
      assert.ok(TYPES.has(f.type), `${t.id}.${f.key}: ${f.type}`);
      assert.match(f.key, /^[a-z_]+$/);
      if (f.type === 'text' || f.type === 'multiline' || f.type === 'url') assert.ok(f.max > 0, `${t.id}.${f.key} has no max`);
    }
    // The catalogue carries specs only — never the builder function.
    assert.equal(typeof t.build, 'undefined');
  }
});

test('every template builds with its samples in both shapes, inside the stage, under the element cap', () => {
  for (const t of signs.TEMPLATES) {
    for (const aspect of ASPECTS) {
      const { slide, errors } = signs.buildSign(t.id, {}, { aspect, samples: true });
      assert.deepEqual(errors, [], `${t.id} ${aspect}`);
      const els = slide.template.elements;
      assert.ok(els.length > 2 && els.length <= slideRender.MAX_ELEMENTS, `${t.id} ${aspect}: ${els.length} elements`);
      assert.equal(slide.template.aspect, aspect);
      for (const e of els) {
        if (!['head', 'body', 'stat', 'countdown', 'clock', 'qr'].includes(e.kind)) continue;
        // Text and codes stay on the stage (decorations may bleed off the edge on purpose).
        assert.ok(e.box.x >= -0.5 && e.box.x + e.box.w <= 101, `${t.id} ${aspect} ${e.slot} x=${e.box.x} w=${e.box.w}`);
        assert.ok(e.box.y >= 0 && e.box.y < 100, `${t.id} ${aspect} ${e.slot} y=${e.box.y}`);
        assert.ok(e.style.size_cqw >= 1, `${t.id} ${aspect} ${e.slot} size=${e.style.size_cqw}`);
      }
      // Every slot an element reads has its words in the record, and nothing else is in it.
      const slots = new Set(els.map((e) => e.slot));
      for (const k of Object.keys(slide.fields)) assert.ok(slots.has(k), `${t.id}: field ${k} has no element`);
      assert.equal(slots.size, els.length, `${t.id} ${aspect}: duplicate slot`);
    }
  }
});

test('text blocks in a column never overlap: a long headline pushes the next block down', () => {
  const long = 'An unusually long headline that will certainly need several lines to fit';
  const { slide } = signs.buildSign('announcement', { title: long, body: 'Body text', label: 'Notice', footer: '' }, { aspect: '16:9' });
  const title = slide.template.elements.find((e) => e.slot === 'title');
  const body = slide.template.elements.find((e) => e.slot === 'body');
  // Height of the title in % of the stage height: lines x size x line-height, in cqw → %.
  const H = 56.25;
  const lines = signs.wrapCount(slide.fields.title, title.style.size_cqw, title.box.w / 1.03, 'archivo', 800);
  const titleBottom = title.box.y + (lines * title.style.size_cqw * 1.08 / H) * 100;
  assert.ok(lines >= 2, 'the test needs a wrapping headline');
  assert.ok(body.box.y >= titleBottom - 0.01, `body at ${body.box.y}% starts inside the title (ends ${titleBottom}%)`);
});

const PAYLOADS = [
  '"><script>alert(1)</script>',
  "'><img src=x onerror=alert(2)>",
  '</style><svg onload=alert(3)>',
  '{{ds:secret.key}} </div><iframe src=javascript:alert(4)>',
];
const BAD = [/<script>alert/i, /<img src=x/i, /<svg onload/i, /<iframe/i, /onerror=alert\(2\)>/];

function hostileValues(t, p) {
  const v = {};
  for (const f of t.fields) {
    if (f.type === 'text' || f.type === 'url') v[f.key] = p.slice(0, f.max);
    else if (f.type === 'multiline') v[f.key] = `${p}\n${p}`.slice(0, f.max);
    else if (f.type === 'rows') v[f.key] = [{ label: p, value: p }, { label: p.slice(0, 20), value: p.slice(0, 20) }];
    else if (f.type === 'datetime') v[f.key] = Date.now() + 86400000;
  }
  return v;
}

test('⚠️ markup in any field of any template renders as text, in previews and in the published widget', () => {
  for (const t of signs.TEMPLATES) {
    for (const aspect of ASPECTS) {
      for (const p of PAYLOADS) {
        const values = hostileValues(t, p);
        const preview = signs.renderSign(t.id, values, { aspect, brand: { business_name: p, colors: [] } });
        // The published path: the deck document, normalized, turned into the widget config the
        // player renders — the same route a sign takes to a wall.
        const built = signs.buildSign(t.id, values, { aspect, brand: { business_name: p, colors: [] } });
        const doc = deckLib.normalizeDeck({ aspect: built.aspect, slides: [built.slide] });
        const wall = slideRender.renderSlideHtml(JSON.parse(deckLib.slideWidgetConfig(doc, doc.slides[0])));
        for (const html of [preview, wall]) {
          for (const re of BAD) assert.doesNotMatch(html, re, `${t.id} ${aspect}: ${re} for ${p}`);
          // Attribute breakout: a quote from user text must never open a new attribute.
          assert.doesNotMatch(html, /" onmouseover=|" onerror=|' onerror=/i, `${t.id} ${aspect}`);
        }
      }
    }
  }
});

test('⚠️ a countdown\'s "done" message is escaped inside its data attribute on the wall', () => {
  const values = { title: 'x', target: Date.now() + 86400000, done: '" onmouseover="alert(1)', subtitle: '' };
  const built = signs.buildSign('countdown', values, { aspect: '16:9' });
  const doc = deckLib.normalizeDeck({ aspect: built.aspect, slides: [built.slide] });
  const html = slideRender.renderSlideHtml(JSON.parse(deckLib.slideWidgetConfig(doc, doc.slides[0])));
  assert.match(html, /data-live="countdown"/, 'the published sign must carry a live countdown');
  assert.match(html, /data-done="&quot; onmouseover=&quot;alert\(1\)"/);
});

test('⚠️ colours are an allowlist: anything but hex is refused and never reaches the document', () => {
  const t = signs.getTemplate('sale');
  for (const bad of ['red;background:url(//x)', '#fff;}', 'expression(alert(1))', '#12345g', 'url(x)']) {
    const { errors, values } = signs.validateValues(t, { big: '1', title: 'x', bg: bad, accent: bad });
    assert.ok(errors.some((e) => e.field === 'bg' && e.code === 'invalid'), bad);
    assert.match(values.bg, /^#[0-9A-F]{6}$/);
    const html = signs.renderSign('sale', { big: '1', title: 'x', bg: bad, accent: bad });
    assert.ok(!html.includes(bad), `${bad} reached the HTML`);
  }
});

test('validation: required, too long, too many rows/lines, bad date, select, control characters', () => {
  const specials = signs.getTemplate('specials');
  let r = signs.validateValues(specials, { title: '' });
  assert.ok(r.errors.some((e) => e.field === 'title' && e.code === 'required'));

  r = signs.validateValues(specials, { title: 'x'.repeat(41) });
  assert.ok(r.errors.some((e) => e.field === 'title' && e.code === 'too_long'));
  assert.equal(r.values.title.length, 40);

  r = signs.validateValues(specials, { title: 'ok', items: Array.from({ length: 9 }, (_, i) => ({ label: `i${i}`, value: '1' })) });
  assert.ok(r.errors.some((e) => e.field === 'items' && e.code === 'too_many_rows'));
  assert.equal(r.values.items.length, 6);

  r = signs.validateValues(specials, { title: 'ok', items: [{ label: { x: 1 }, value: ['a'] }, null, 'str', { label: 'Tea', value: 2.5 }] });
  assert.deepEqual(r.values.items, [{ label: 'Tea', value: '2.5' }], 'non-string row values are dropped, numbers kept');

  r = signs.validateValues(specials, { title: 'a\u0000b\u0007c\nd\re' });
  assert.equal(r.values.title, 'abc d e', 'control characters stripped, a one-line field stays one line');

  const ann = signs.getTemplate('announcement');
  r = signs.validateValues(ann, { title: 'x', body: 'a\nb\nc\nd\ne\nf\ng' });
  assert.ok(r.errors.some((e) => e.field === 'body' && e.code === 'too_many_lines'));
  assert.equal(r.values.body.split('\n').length, 5);

  const cd = signs.getTemplate('countdown');
  r = signs.validateValues(cd, { title: 'x', target: 'not a date' });
  assert.ok(r.errors.some((e) => e.field === 'target' && e.code === 'invalid'));
  r = signs.validateValues(cd, { title: 'x', target: '2031-05-01T10:00:00Z' });
  assert.equal(r.values.target, Date.parse('2031-05-01T10:00:00Z'));
  assert.deepEqual(r.errors, []);

  const wifi = signs.getTemplate('wifi');
  r = signs.validateValues(wifi, { title: 'x', network: 'n', security: 'WPA3-evil' });
  assert.ok(r.errors.some((e) => e.field === 'security'));
  assert.equal(r.values.security, 'WPA');
});

test('samples fill only absent fields, and only when asked — a cleared field stays cleared', () => {
  const t = signs.getTemplate('specials');
  assert.equal(signs.validateValues(t, {}).values.subtitle, '');
  assert.ok(signs.validateValues(t, {}, { samples: true }).values.subtitle.length > 0);
  assert.equal(signs.validateValues(t, { subtitle: '' }, { samples: true }).values.subtitle, '');
});

test('the brand kit pre-fills business name, colours and the logo switch, and sets the headline font', () => {
  const brand = { business_name: 'Rosa\'s Bakery', colors: ['#FCE7F3', '#9D174D'], font: 'bitter', logo_content_id: 'logo-1' };
  const t = signs.getTemplate('specials');
  const { values } = signs.validateValues(t, {}, { brand });
  assert.equal(values.business, "Rosa's Bakery");
  assert.equal(values.bg, '#FCE7F3');
  assert.equal(values.accent, '#9D174D');
  assert.equal(values.show_logo, true);
  // An explicit value wins over the kit.
  assert.equal(signs.validateValues(t, { bg: '#000000' }, { brand }).values.bg, '#000000');

  const { slide } = signs.buildSign('specials', { title: 'Hi' }, { brand });
  const title = slide.template.elements.find((e) => e.slot === 'title');
  assert.equal(title.style.font, 'bitter');
  const logo = slide.template.elements.find((e) => e.kind === 'image');
  assert.equal(logo && logo.content_id, 'logo-1');
  assert.equal(signs.buildSign('specials', { title: 'Hi', show_logo: false }, { brand }).slide.template.elements.some((e) => e.kind === 'image'), false);
  // No kit, no logo, and the template's own palette.
  const plain = signs.validateValues(t, {});
  assert.equal(plain.values.show_logo, false);
  assert.equal(plain.values.bg, '#2B1B14');
});

test('⚠️ text is always legible: ink contrast holds whatever background a brand kit brings', () => {
  for (const bg of ['#FFFFFF', '#000000', '#777777', '#808080', '#FFE14D', '#1D4ED8', '#99F6E4', '#FF3D6E', '#5A5A5A']) {
    for (const accent of ['#FFFFFF', bg, '#888888', '#FF0000']) {
      const T = signs.themeOf(bg, accent);
      assert.ok(signs.contrast(T.ink, T.bg) >= 4, `ink on ${bg}: ${signs.contrast(T.ink, T.bg)}`);
      assert.ok(signs.contrast(T.accent, T.bg) >= 2.2, `accent ${accent} on ${bg}`);
      assert.ok(signs.contrast(T.onAccent, T.accent) >= 3, `text on accent ${T.accent}`);
    }
  }
});

test('the Wi-Fi code escapes the join string, so a ";" in a password cannot end the field', () => {
  assert.equal(signs.wifiPayload({ network: 'Café;Guest', password: 'a;b,c:d"e\\f', security: 'WPA' }),
    'WIFI:T:WPA;S:Café\\;Guest;P:a\\;b\\,c\\:d\\"e\\\\f;;');
  assert.equal(signs.wifiPayload({ network: 'Open', password: '', security: 'WPA' }), 'WIFI:T:nopass;S:Open;;');
  assert.equal(signs.wifiPayload({ network: '' }), '');
});

test('a preview never needs script: live elements are drawn as text, the wall gets the live ones', () => {
  const values = { title: 'Opening in', target: Date.now() + 3 * 86400000 + 3600000, done: 'Open!', subtitle: '' };
  const preview = signs.renderSign('countdown', values);
  assert.doesNotMatch(preview, /data-live=/, 'the dashboard frame cannot run the ticking script');
  assert.match(preview, /3d \d+h \d+m/);
  const recep = signs.buildSign('reception', { title: 'Room', show_clock: true });
  assert.ok(recep.slide.template.elements.some((e) => e.kind === 'clock'));
});

test('unknown template ids are refused', () => {
  assert.throws(() => signs.buildSign('nope', {}), /Unknown template/);
  assert.throws(() => signs.buildSign('__proto__', {}), /Unknown template/);
  assert.equal(signs.getTemplate('constructor'), null);
});

test('every computed i18n key the sign form asks for exists in English', () => {
  // views/make-sign.js builds these keys from the catalogue, so the literal-key guard
  // (i18n-keys-exist) cannot see them. A missing one would render as "signs.field.x" on the form.
  const en = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'frontend', 'js', 'i18n', 'en.js'), 'utf8');
  const has = (k) => en.includes(`'${k}':`);
  const missing = [];
  for (const t of signs.TEMPLATES) {
    if (!has(`signs.tpl.${t.id}.name`)) missing.push(`signs.tpl.${t.id}.name`);
    for (const f of t.fields) {
      if (!has(`signs.field.${f.key}`)) missing.push(`signs.field.${f.key}`);
      for (const o of f.options || []) if (!has(`signs.option.${o}`)) missing.push(`signs.option.${o}`);
    }
  }
  for (const code of ['required', 'too_long', 'too_many_rows', 'too_many_lines', 'invalid']) {
    if (!has(`signs.err.${code}`)) missing.push(`signs.err.${code}`);
  }
  assert.deepEqual(missing, []);
});

test('fit() shrinks to the line limit and a line that only just wraps is shrunk until it clearly fits', () => {
  const f = signs.fit('Harbour View', { font: 'archivo', weight: 800, max: 7.5, min: 3, width: 50, lines: 3 });
  assert.equal(f.lines, 1, 'a hair over one line is set a little smaller, not on two lines');
  const g = signs.fit('word '.repeat(12), { max: 10, min: 1, width: 50, lines: 2 });
  assert.ok(g.lines <= 2);
});
