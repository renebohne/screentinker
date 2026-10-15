'use strict';

/*
 * 3.0 accessibility checker: the pure checks (lib/a11y/contrast, legibility, slides, widgets,
 * flash) and every built-in Make-a-sign design. The HTTP surface, tenancy, the publish policy and
 * the caption pipeline are in accessibility-routes.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const C = require('../lib/a11y/contrast');
const L = require('../lib/a11y/legibility');
const { checkSlide } = require('../lib/a11y/slides');
const { checkWidget } = require('../lib/a11y/widgets');
const { FlashDetector, FRAME_BYTES, worstSecond } = require('../lib/a11y/flash');
const signs = require('../lib/sign-templates');

const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const VIEW = (() => { const g = L.screenSize(55, 1920, 1080); return { distanceM: 3, widthMm: g.widthMm, heightMm: g.heightMm, pxW: 1920, pxH: 1080 }; })();

/* ---------------------------------------------------------------- contrast math */

test('relative luminance and contrast match WCAG reference values', () => {
  assert.equal(C.luminance('#FFFFFF'), 1);
  assert.equal(C.luminance('#000000'), 0);
  near(C.contrast('#000000', '#FFFFFF'), 21, 1e-9);
  near(C.contrast('#FFFFFF', '#FFFFFF'), 1, 1e-9);
  // The well-known AA boundary greys on white: #767676 passes, #777777 just fails.
  near(C.contrast('#767676', '#FFFFFF'), 4.54);
  near(C.contrast('#777777', '#FFFFFF'), 4.48);
  // Pure primaries on white (WebAIM / WCAG understanding docs).
  near(C.contrast('#FF0000', '#FFFFFF'), 4.0);
  near(C.contrast('#0000FF', '#FFFFFF'), 8.59);
  near(C.contrast('#00FF00', '#000000'), 15.3, 0.05);
  // Order does not matter; shorthand hex parses.
  assert.equal(C.contrast('#fff', '#000'), C.contrast('#000000', '#FFFFFF'));
  assert.equal(C.contrast('red', '#fff'), null);
  assert.equal(C.parseHex('#12345678'), null);
});

test('blend: a colour at partial opacity reads as its mix with the background', () => {
  assert.deepEqual(C.blend([255, 255, 255], [0, 0, 0], 0.5), [127.5, 127.5, 127.5]);
  assert.deepEqual(C.blend([10, 20, 30], [0, 0, 0], 1), [10, 20, 30]);
});

test('suggest: the nearest colour of the same hue that reaches the target', () => {
  for (const [fg, bg, target] of [['#FFE14D', '#FFFFFF', 4.5], ['#457B9D', '#1D3557', 4.5], ['#777777', '#FFFFFF', 4.5], ['#FF0000', '#00FF00', 3]]) {
    const s = C.suggest(fg, bg, target);
    assert.ok(s, `${fg} on ${bg}`);
    assert.ok(C.contrast(s, bg) >= target, `${s} on ${bg} = ${C.contrast(s, bg)}`);
  }
  // Already fine: returned unchanged.
  assert.equal(C.suggest('#000000', '#FFFFFF'), '#000000');
  // The hue is kept: a too-light blue becomes a darker blue, not black.
  const [r, g, b] = C.parseHex(C.suggest('#8AB4F8', '#FFFFFF'));
  assert.ok(b > r && b > g, 'still blue');
});

test('large text is decided by visual angle (18pt / 14pt bold as the CSS reference pixel defines them)', () => {
  near(C.LARGE_DEG, 0.511, 0.001);
  near(C.LARGE_BOLD_DEG, 0.398, 0.001);
  assert.equal(C.isLarge(0.6, 400), true);
  assert.equal(C.isLarge(0.45, 400), false);
  assert.equal(C.isLarge(0.45, 700), true);
  assert.equal(C.required(true), 3);
  assert.equal(C.required(false), 4.5);
});

/* ---------------------------------------------------------------- size rule */

test('legibility: screen geometry, angles and the ISO 9241-303 thresholds', () => {
  const g = L.screenSize(55, 1920, 1080);
  near(g.widthMm, 1217.7, 0.5);
  near(g.heightMm, 684.9, 0.5);
  // A 14 mm capital at 3 m is ~16 arcminutes: the ISO minimum.
  near(L.arcmin(14, 3), 16.04, 0.05);
  // distance/215 ≈ 16', the rule of thumb distance/200 ≈ 17'.
  near(L.arcmin(3000 / 200, 3), 17.2, 0.05);
  assert.equal(L.assess(30, 3).level, 'ok');         // 21 mm cap → 24'
  assert.equal(L.assess(16, 3).level, 'warning');    // 11.2 mm cap → 12.8'
  assert.equal(L.assess(10, 3).level, 'error');      // 7 mm cap → 8'
  // The minimum font for 16' at 3 m, and twice that at 6 m.
  near(L.minFontMm(3), 19.96, 0.05);
  near(L.minFontMm(6) / L.minFontMm(3), 2, 0.001);
});

/* ---------------------------------------------------------------- slides */

const slide = (elements, fields, extra = {}) => ({ template: { background: '#FFFFFF', aspect: '16:9', elements, ...extra }, fields });
const txt = (slot, color, size = 4, more = {}) => ({ kind: 'body', slot, box: { x: 10, y: 10, w: 80 }, style: { color, size_cqw: size, weight: 400 }, ...more });

test('slide: low-contrast text is an error with a suggested colour that passes', () => {
  const issues = checkSlide(slide([txt('t', '#FFE14D', 2)], { t: 'Weekend sale' }), VIEW);
  const c = issues.find((i) => i.code === 'contrast');
  assert.ok(c, JSON.stringify(issues));
  assert.equal(c.severity, 'error');
  assert.equal(c.values.required, 4.5);
  assert.ok(c.values.ratio < 2);
  assert.ok(C.contrast(c.fix.color, '#FFFFFF') >= 4.5);
  assert.equal(c.where.slot, 't');
  assert.equal(c.text, 'Weekend sale');
});

test('slide: large text needs only 3:1', () => {
  // #FF0000 on white is 4.0: fails as body text, passes as a 6cqw headline on a 55" screen at 3 m.
  assert.ok(checkSlide(slide([txt('t', '#FF0000', 1.6)], { t: 'small' }), VIEW).some((i) => i.code === 'contrast'));
  assert.ok(!checkSlide(slide([txt('t', '#FF0000', 6)], { t: 'BIG' }), VIEW).some((i) => i.code === 'contrast'));
});

test('slide: the background is the box drawn underneath, not the slide colour', () => {
  const panel = { kind: 'box', slot: 'panel', box: { x: 0, y: 0, w: 100, h: 50 }, style: { color: '#111111' } };
  // White text on a dark panel over a white slide: fine.
  assert.deepEqual(checkSlide(slide([panel, txt('t', '#FFFFFF', 4)], { t: 'Hello' }), VIEW).filter((i) => i.code === 'contrast'), []);
  // The same panel drawn AFTER the text is on top of it, so the text sits on white: an error.
  assert.ok(checkSlide(slide([txt('t', '#FFFFFF', 4), panel], { t: 'Hello' }), VIEW).some((i) => i.code === 'contrast'));
  // A half-transparent panel is blended.
  const ghost = { ...panel, style: { color: '#111111', opacity: 0.2 } };
  assert.ok(checkSlide(slide([ghost, txt('t', '#FFFFFF', 4)], { t: 'Hello' }), VIEW).some((i) => i.code === 'contrast'));
});

test('slide: text over a photo or a video it cannot measure is a note, never a pass or an error', () => {
  const photo = checkSlide(slide([txt('t', '#FFFFFF')], { t: 'Hi' }, { background_content_id: 'c1' }), VIEW, { imageGrid: () => ({ unknown: 'pending' }) });
  assert.deepEqual(photo.map((i) => [i.code, i.severity]), [['contrast_unverified', 'note']]);
  assert.equal(photo[0].values.why, 'pending');
  const video = checkSlide(slide([txt('t', '#FFFFFF')], { t: 'Hi' }, { background_content_id: 'c1', background_video_content_id: 'v1' }), VIEW);
  assert.equal(video[0].values.why, 'video');
});

test('slide: text over a measured photo uses the luminance under the text, after the dim scrim', () => {
  // A 4x2 grid: a bright top half, a dark bottom half.
  const grid = { w: 4, h: 2, lum: [0.9, 0.9, 0.9, 0.9, 0.02, 0.02, 0.02, 0.02] };
  const top = { ...txt('t', '#FFFFFF', 4), box: { x: 5, y: 5, w: 90 } };
  const bottom = { ...txt('t', '#FFFFFF', 4), box: { x: 5, y: 70, w: 90 } };
  const on = (el, dim) => checkSlide(slide([el], { t: 'Hello' }, { background_content_id: 'c1', background_dim: dim }), VIEW, { imageGrid: () => ({ grid }) });
  assert.ok(on(top, 0).some((i) => i.code === 'contrast_image' && i.severity === 'error'));
  assert.ok(!on(bottom, 0).some((i) => i.code === 'contrast_image'));
  // A heavy scrim makes the bright half dark enough for white text.
  assert.ok(!on(top, 0.8).some((i) => i.code === 'contrast_image'));
  const fix = on(top, 0).find((i) => i.code === 'contrast_image').fix;
  assert.equal(fix.kind, 'dim');
  assert.ok(fix.dim > 0);
});

test('slide: text too small for the viewing distance, with the size that would pass', () => {
  const far = { ...VIEW, distanceM: 15 };
  const s = slide([{ ...txt('t', '#000000', 2) }], { t: 'Small print' });
  assert.deepEqual(checkSlide(s, VIEW).filter((i) => i.code === 'text_small'), []);
  const issue = checkSlide(s, far).find((i) => i.code === 'text_small');
  assert.ok(issue);
  assert.equal(issue.severity, 'error');
  assert.ok(issue.values.min_size_cqw > 2);
  // At the suggested size it is no longer flagged.
  assert.deepEqual(checkSlide(slide([{ ...txt('t', '#000000', issue.values.min_size_cqw + 0.1) }], { t: 'Small print' }), far).filter((i) => i.code === 'text_small'), []);
});

test('slide: lettering (words drawn as a picture) gets the text-in-image note; empty text is skipped', () => {
  const s = slide([{ kind: 'lettering', slot: 'l', content_id: 'c9', box: { x: 0, y: 0, w: 50, h: 20 }, style: {} }, txt('e', '#FFFFFF')], { l: 'Grand opening', e: '' });
  assert.deepEqual(checkSlide(s, VIEW).map((i) => i.code), ['text_in_image']);
});

/* ---------------------------------------------------------------- widgets */

test('widgets: ticker, clock and menu board are checked from their config', () => {
  const rss = checkWidget({ widget_type: 'rss', config: { color: '#FFFFFF', background: '#FFEE00', font_size: 40 } }, VIEW);
  const c = rss.find((i) => i.code === 'contrast');
  assert.ok(c);
  assert.equal(c.where.key, 'color');
  // Defaults (white on black) pass.
  assert.deepEqual(checkWidget({ widget_type: 'rss', config: { font_size: 40 } }, VIEW).filter((i) => i.code === 'contrast'), []);
  // A clock on a transparent background sits on whatever is under it: a note.
  assert.ok(checkWidget({ widget_type: 'clock', config: {} }, VIEW).some((i) => i.code === 'contrast_unverified'));
  // A clock whose date is a 70%-white on a light grey fails, and points at date_color.
  const clock = checkWidget({ widget_type: 'clock', config: { background: '#BBBBBB', color: '#000000' } }, VIEW);
  assert.ok(!clock.some((i) => i.code === 'contrast' && i.where.part === 'time'));
  // Menu board: the built-in themes pass; a pale accent on the light theme does not.
  assert.deepEqual(checkWidget({ widget_type: 'menu-board', config: { title: 'Menu', theme: 'dark' } }, VIEW).filter((i) => i.code === 'contrast'), []);
  const pale = checkWidget({ widget_type: 'menu-board', config: { title: 'Menu', theme: 'light', accent: '#FDE68A' } }, VIEW);
  assert.ok(pale.some((i) => i.code === 'contrast' && i.where.key === 'accent'));
  // Free HTML cannot be checked, and says so.
  assert.deepEqual(checkWidget({ widget_type: 'text', config: { html: '<p>x</p>' } }, VIEW).map((i) => i.code), ['unverifiable']);
  // A config stored as a JSON string is read the same way.
  assert.ok(checkWidget({ widget_type: 'rss', config: JSON.stringify({ color: '#FFFFFF', background: '#FFEE00' }) }, VIEW).some((i) => i.code === 'contrast'));
});

/* ---------------------------------------------------------------- Make a sign */

test('⚠️ every built-in sign design passes, both shapes, with its own colours and awkward brand colours', () => {
  const brands = [null, ['#777777', '#888888'], ['#7F7F7F', '#FF0000'], ['#B8F2E6', '#FFD166'], ['#1D3557', '#457B9D'],
    ['#E63946', '#F1FAEE'], ['#FFFFFF', '#FFE14D'], ['#000000', '#111111'], ['#FFD700', '#FFFF00'], ['#808000', '#008080', '#800080']];
  const failures = [];
  for (const t of signs.TEMPLATES) {
    for (const aspect of ['16:9', '9:16']) {
      const g = aspect === '9:16' ? L.screenSize(55, 1080, 1920) : L.screenSize(55, 1920, 1080);
      for (const colors of brands) {
        const { slide: s } = signs.buildSign(t.id, {}, { aspect, samples: true, brand: colors ? { colors } : null });
        for (const i of checkSlide(s, { distanceM: 3, widthMm: g.widthMm })) {
          if (i.severity !== 'note') failures.push(`${t.id} ${aspect} ${colors || 'default'}: ${i.code} ${JSON.stringify(i.values)} "${i.text}"`);
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('sign theme: every derived text colour clears 4.5:1 on any background', () => {
  for (let v = 0; v <= 255; v += 5) {
    const bg = C.toHex([v, (v * 7) % 256, (v * 13) % 256]);
    const T = signs.themeOf(bg, '#808080');
    for (const k of ['ink', 'muted', 'accent']) assert.ok(C.contrast(T[k], T.bg) >= 4.5, `${k} ${T[k]} on ${bg}`);
    assert.ok(C.contrast(T.onAccent, T.accent) >= 4.5, `onAccent on ${T.accent}`);
  }
});

/* ---------------------------------------------------------------- flashing */

test('flash detector: hysteresis and the one-second window', () => {
  assert.deepEqual(worstSecond([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 1.7]), { transitions: 7, at: 0 });
  assert.deepEqual(worstSecond([]).transitions, 0);
  // Synthetic frames: whole-frame black/white alternation at 30 fps.
  const run = (hz, rgbOn, rgbOff = [0, 0, 0]) => {
    const d = new FlashDetector(30);
    for (let f = 0; f < 90; f++) {
      const on = Math.floor((f / 30) * hz * 2) % 2 === 0;
      const px = on ? rgbOn : rgbOff;
      const buf = Buffer.alloc(FRAME_BYTES);
      for (let o = 0; o < FRAME_BYTES; o += 3) { buf[o] = px[0]; buf[o + 1] = px[1]; buf[o + 2] = px[2]; }
      d.push(buf);
    }
    return d.result();
  };
  assert.equal(run(2, [255, 255, 255]).general.fails, false);
  assert.equal(run(3, [255, 255, 255]).general.fails, false); // exactly three flashes is allowed
  assert.equal(run(5, [255, 255, 255]).general.fails, true);
  // A 0.05 flicker is not a flash at any rate.
  assert.equal(run(10, [70, 70, 70], [60, 60, 60]).general.fails, false);
  // Bright flicker where the darker state is above 0.8 does not count (WCAG's darker-image rule).
  assert.equal(run(10, [255, 255, 255], [235, 235, 235]).general.fails, false);
  // Saturated red against a darker red: below the luminance threshold, above the red one.
  const red = run(5, [255, 0, 0], [200, 0, 0]);
  assert.equal(red.general.fails, false);
  assert.equal(red.red.fails, true);
});

function haveFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

test('flash detector on real videos (ffmpeg lavfi): 2 Hz passes, 5 Hz fails, red flashes found', { skip: !haveFfmpeg() && 'ffmpeg not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-a11y-flash-'));
  const gen = (name, expr, extra = []) => {
    const out = path.join(dir, name);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=black:s=160x90:r=30:d=3,format=rgb24,geq=${expr}`, ...extra, '-pix_fmt', 'yuv420p', out]);
    return out;
  };
  const sq = (period) => `if(lt(mod(T,${period}),${period / 2}),255,0)`;
  const files = {
    bw2: gen('bw2.mp4', `r='${sq(0.5)}':g='${sq(0.5)}':b='${sq(0.5)}'`),
    bw5: gen('bw5.mp4', `r='${sq(0.2)}':g='${sq(0.2)}':b='${sq(0.2)}'`),
    red5: gen('red5.mp4', "r='if(lt(mod(T,0.2),0.1),255,200)':g=0:b=0"),
  };
  const gif = path.join(dir, 'bw5.gif');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', files.bw5, gif]);
  const { Worker } = require('node:worker_threads');
  const w = new Worker(path.join(__dirname, '..', 'lib', 'a11y', 'media-worker.js'));
  let n = 0;
  const ask = (file) => new Promise((resolve) => {
    const id = ++n;
    const on = (m) => { if (m.id === id) { w.off('message', on); resolve(m); } };
    w.on('message', on);
    w.postMessage({ id, op: 'video', path: file, fps: 30, maxSec: 600, timeoutMs: 60000 });
  });
  try {
    const r2 = (await ask(files.bw2)).result;
    assert.equal(r2.flash.general.fails, false);
    assert.equal(r2.flash.general.flashes_per_sec, 2);
    assert.equal(r2.has_audio, false);
    const r5 = (await ask(files.bw5)).result;
    assert.equal(r5.flash.general.fails, true);
    assert.equal(r5.flash.general.flashes_per_sec, 5);
    const rr = (await ask(files.red5)).result;
    assert.equal(rr.flash.general.fails, false);
    assert.equal(rr.flash.red.fails, true);
    const rg = (await ask(gif)).result;
    assert.equal(rg.flash.general.fails, true, 'an animated GIF is read the same way');
    const bad = await ask(path.join(dir, 'missing.mp4'));
    assert.equal(bad.ok, false);
  } finally {
    await w.terminate();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
