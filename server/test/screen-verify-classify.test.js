'use strict';

/*
 * Screen verification: the classifier (lib/screen-verify/classify.js) on REAL decoded frames.
 *
 * Generated images (solid colours, noise, the web player's "could not capture" card, the 160x90
 * privacy frame) and two real signs from the fixtures, rendered the way a player shows them —
 * letterboxed into a 960x540 capture and JPEG-encoded at the web player's quality 0.4 — then run
 * through the same frameMetrics the image worker runs. Thresholds are asserted with margin, so a
 * change that makes the classifier jumpier fails here before it pages anyone.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Jimp } = require('jimp');
const core = require('../lib/image-ops-core');
const cl = require('../lib/screen-verify/classify');

const FX = path.join(__dirname, 'fixtures', 'screen-verify');

async function jpeg(img, quality = 40) { return img.getBuffer('image/jpeg', { quality }); }
async function metricsOf(img, quality) { return core.frameMetrics(await jpeg(img, quality)); }
function solid(color, w = 960, h = 540) { return new Jimp({ width: w, height: h, color }); }
/* A sign as a player shows it: fitted inside the capture, black bars around it. */
async function frameOf(file, w = 960, h = 540) {
  const src = await Jimp.read(path.join(FX, file));
  src.contain({ w, h });
  const bg = solid(0x000000ff, w, h);
  bg.composite(src, 0, 0);
  return bg;
}
async function thumbOf(file) {
  const img = await Jimp.read(path.join(FX, file));
  img.resize({ w: 320 });
  return core.frameMetrics(await img.getBuffer('image/jpeg', { quality: 70 }));
}
function seededNoise(w, h, seed = 7) {
  const img = solid(0x000000ff, w, h);
  let x = seed;
  for (let i = 0; i < img.bitmap.data.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    img.bitmap.data[i] = i % 4 === 3 ? 255 : x & 255;
  }
  return img;
}
function paintRect(img, x0, y0, w, h, [r, g, b]) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const i = (y * img.bitmap.width + x) * 4;
    img.bitmap.data[i] = r; img.bitmap.data[i + 1] = g; img.bitmap.data[i + 2] = b;
  }
}

/* ------------------------------------------------------------------ blank */

test('solid black, white and a flat colour are blank, named for what they are, at every sensitivity', async () => {
  const black = await metricsOf(solid(0x000000ff));
  const white = await metricsOf(solid(0xffffffff));
  const blue = await metricsOf(solid(0x2050c0ff));
  for (const level of cl.SENSITIVITIES) {
    assert.equal(cl.blankKind(black, level), 'black', level);
    assert.equal(cl.blankKind(white, level), 'white', level);
    assert.equal(cl.blankKind(blue, level), 'solid', level);
  }
  assert.equal(cl.judgeFrame(black, {}).verdict, 'blank');
  assert.equal(cl.judgeFrame(black, {}).detail.kind, 'black');
});

test('noise and real signs are never blank — not even the sparse, mostly-cream opening-hours sign', async () => {
  const noise = await metricsOf(seededNoise(960, 540));
  const sale = await metricsOf(await frameOf('sale.jpg'));
  const hours = await metricsOf(await frameOf('hours.jpg'));
  for (const level of cl.SENSITIVITIES) {
    assert.equal(cl.blankKind(noise, level), null, `noise @${level}`);
    assert.equal(cl.blankKind(sale, level), null, `sale @${level}`);
    assert.equal(cl.blankKind(hours, level), null, `hours @${level}`);
  }
  // Margin, not just a pass: the sparsest sign has many times the edge density "blank" allows.
  assert.ok(hours.edge > cl.SENS.high.blankEdge * 5, `hours edge ${hours.edge}`);
});

test('a dark frame with one small logo is NOT blank at normal sensitivity (a caption is content)', async () => {
  const img = solid(0x000000ff);
  paintRect(img, 880, 480, 60, 40, [255, 255, 255]);
  const m = await metricsOf(img);
  assert.equal(cl.blankKind(m, 'normal'), null);
  assert.equal(cl.blankKind(m, 'low'), null);
});

test('the 160x90 privacy frame and the web player\'s fallback card are not judged at all', async () => {
  const privacy = await metricsOf(solid(0x000000ff, 160, 90));
  assert.equal(cl.captureLimitation(privacy), 'privacy');
  assert.equal(cl.judgeFrame(privacy, {}).verdict, 'unknown');

  // #111827 with a few lines of light text, as renderCaptureCanvas draws it.
  const card = solid(0x111827ff);
  paintRect(card, 300, 200, 360, 28, [59, 130, 246]);
  paintRect(card, 340, 260, 280, 14, [148, 163, 184]);
  paintRect(card, 360, 300, 240, 14, [148, 163, 184]);
  const m = await metricsOf(card);
  assert.equal(cl.captureLimitation(m), 'placeholder');
  assert.equal(cl.judgeFrame(m, {}).verdict, 'unknown');
});

test('blank is excused for a hold item and for an item that is itself that flat', async () => {
  const black = await metricsOf(solid(0x000000ff));
  assert.equal(cl.judgeFrame(black, { current: { kind: 'hold' } }).verdict, 'ok');
  const flatRef = await metricsOf(solid(0x000000ff, 320, 180), 70);
  assert.equal(cl.judgeFrame(black, { current: { kind: 'image' }, reference: flatRef }).detail.reason, 'flat_by_design');
  // ...but a black frame where a white slide should be is still blank.
  const whiteRef = await metricsOf(solid(0xffffffff, 320, 180), 70);
  assert.equal(cl.judgeFrame(black, { current: { kind: 'image' }, reference: whiteRef }).verdict, 'blank');
});

/* ------------------------------------------------------------------ same frame */

test('a re-encode of the same frame is the same; a slightly changed frame is not', async () => {
  const base = await frameOf('sale.jpg');
  const a = await metricsOf(base, 40);
  const b = await metricsOf(base, 75);   // the same picture, different JPEG noise
  assert.equal(cl.sameFrame(a, b, 'normal'), true);
  assert.equal(cl.sameFrame(a, b, 'low'), true);

  const changed = await frameOf('sale.jpg');
  paintRect(changed, 100, 100, 40, 30, [255, 255, 255]);   // a ticking clock's worth of change
  const c = await metricsOf(changed, 40);
  for (const level of cl.SENSITIVITIES) assert.equal(cl.sameFrame(a, c, level), false, level);

  // The history keeps a quarter-size grid; it must still tell these apart.
  const small = (m) => ({ grid: cl.shrinkGrid(m.grid), hash: m.hash });
  assert.equal(cl.shrinkGrid(a.grid).length, 32 * 18);
  assert.equal(cl.sameFrame(small(a), small(b), 'normal'), true);
  for (const level of cl.SENSITIVITIES) assert.equal(cl.sameFrame(small(a), small(c), level), false, `shrunk @${level}`);
});

/* ------------------------------------------------------------------ unexpected */

test('resemblance: the letterboxed sign matches its own thumbnail and not a different sign', async () => {
  const saleThumb = await thumbOf('sale.jpg');
  const saleFrame = await metricsOf(await frameOf('sale.jpg'));
  const hoursFrame = await metricsOf(await frameOf('hours.jpg'));
  const portrait = await metricsOf(await frameOf('sale.jpg', 540, 960));
  assert.ok(cl.resemblance(saleFrame, saleThumb).score > 0.9);
  assert.ok(cl.resemblance(portrait, saleThumb).score > 0.6, 'a portrait-mounted panel letterboxes it differently');
  const wrong = cl.resemblance(hoursFrame, saleThumb).score;
  assert.ok(wrong < cl.SENS.normal.unexpectedNcc, `a different sign scores ${wrong}`);
});

test('unexpected: only for a full-screen image well inside its own play window', async () => {
  const saleThumb = await thumbOf('sale.jpg');
  const hoursThumb = await thumbOf('hours.jpg');
  const hoursFrame = await metricsOf(await frameOf('hours.jpg'));
  const now = 1_000_000;
  const cur = { kind: 'image', key: 'c:sale', fullScreen: true, wall: false, startedMs: now - 6000, durationSec: 10 };
  const v = cl.judgeFrame(hoursFrame, { current: cur, reference: saleThumb, nowMs: now });
  assert.equal(v.verdict, 'unexpected');

  const ok = (over, why) => assert.equal(cl.judgeFrame(hoursFrame, { current: { ...cur, ...over }, reference: saleThumb, nowMs: now }).verdict, 'ok', why);
  ok({ kind: 'widget' }, 'widgets have no fixed appearance');
  ok({ kind: 'video' }, 'a video is not one frame');
  ok({ kind: 'live' }, 'live streams are excluded');
  ok({ fullScreen: false }, 'zones are excluded');
  ok({ wall: true }, 'a wall panel shows a slice');
  ok({ startedMs: now - 1000 }, 'still transitioning in');
  ok({ startedMs: now - 9500 }, 'about to leave');
  // The screen is a beat behind: it still shows the previous item.
  assert.equal(cl.judgeFrame(hoursFrame, { current: cur, reference: saleThumb, previousReference: hoursThumb, nowMs: now }).detail.reason, 'previous_item');
  // Unexpected can be switched off.
  assert.equal(cl.judgeFrame(hoursFrame, { current: cur, reference: saleThumb, nowMs: now, checks: new Set(['blank']) }).verdict, 'ok');
});

test('unexpected: a noise frame (nothing to correlate) stays quiet rather than guessing', async () => {
  const saleThumb = await thumbOf('sale.jpg');
  const noise = await metricsOf(seededNoise(960, 540));
  const now = 1_000_000;
  const cur = { kind: 'image', key: 'c:sale', fullScreen: true, startedMs: now - 6000, durationSec: 10 };
  assert.notEqual(cl.judgeFrame(noise, { current: cur, reference: saleThumb, nowMs: now }).verdict, 'blank');
});

/* ------------------------------------------------------------------ the image worker */

test('frameMetrics runs in the image worker and refuses what is not a frame', async () => {
  const imageOps = require('../lib/image-ops');
  try {
    const m = await imageOps.frameMetrics(await jpeg(solid(0x000000ff)));
    assert.equal(cl.blankKind(m, 'normal'), 'black');
    assert.equal(m.grid.length, 64 * 36);
    await assert.rejects(imageOps.frameMetrics(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), /unsupported frame type/);
    assert.equal(imageOps.pending(), 0);
  } finally {
    await imageOps.shutdown();
  }
});

/* ------------------------------------------------------------------ frozen */

const MIN = 60 * 1000;
function hist(frames) {
  // frames: [{ at (minutes), m: metrics, key }]
  return frames.map((f) => ({ at: f.at * MIN, metrics: f.m, itemKey: f.key || null }));
}

test('frozen: a single-item still playlist is never frozen, however long it shows the same picture', async () => {
  const m = await metricsOf(await frameOf('sale.jpg'));
  const h = hist([0, 20, 40, 60, 80].map((at) => ({ at, m, key: 'c:sale' })));
  for (const kind of ['image', 'widget', 'animated']) {
    const r = cl.evaluateFreeze(h, { persistSec: 600, playlist: { visualItems: 1, maxDurationSec: 10 }, current: { kind, key: 'c:sale', inPlaylist: true } });
    assert.equal(r.frozen, false, kind);
  }
});

test('frozen: a loop of several items stuck on one picture for longer than any item lasts', async () => {
  const m = await metricsOf(await frameOf('sale.jpg'));
  const h = hist([0, 5, 10, 15].map((at) => ({ at, m, key: 'c:sale' })));
  const ctx = { persistSec: 600, playlist: { visualItems: 3, maxDurationSec: 10 }, current: { kind: 'image', key: 'c:sale', inPlaylist: true } };
  const r = cl.evaluateFreeze(h, ctx);
  assert.equal(r.frozen, true);
  assert.equal(r.reason, 'not_advancing');
  assert.equal(r.sinceMs, 0);
  assert.equal(r.frames, 4);
});

test('frozen: a still image during its OWN long duration is not a freeze', async () => {
  const m = await metricsOf(await frameOf('sale.jpg'));
  // A 15-minute item in a two-item loop, watched for 12 minutes.
  const h = hist([0, 4, 8, 12].map((at) => ({ at, m, key: 'c:sale' })));
  const ctx = { persistSec: 600, playlist: { visualItems: 2, maxDurationSec: 900 }, current: { kind: 'image', key: 'c:sale', inPlaylist: true } };
  assert.equal(cl.evaluateFreeze(h, ctx).frozen, false);
  // ...and the same picture past 1.5x that duration is.
  const longer = hist([0, 8, 16, 24].map((at) => ({ at, m, key: 'c:sale' })));
  assert.equal(cl.evaluateFreeze(longer, ctx).frozen, true);
});

test('frozen: the player said it moved on, the picture did not — even for an item we cannot time', async () => {
  const m = await metricsOf(await frameOf('sale.jpg'));
  const h = hist([{ at: 0, m, key: 'c:a' }, { at: 6, m, key: 'c:b' }, { at: 12, m, key: 'c:c' }]);
  const r = cl.evaluateFreeze(h, { persistSec: 600, playlist: null, current: { kind: 'image', key: 'c:c', inPlaylist: false } });
  assert.equal(r.frozen, true);
  assert.equal(r.reason, 'player_advanced');
});

test('frozen: a healthy loop caught on the same item every time (aliasing) is NOT frozen', async () => {
  const m = await metricsOf(await frameOf('sale.jpg'));
  // Every capture landed on item a; the player reported starting items in between.
  const h = hist([0, 6, 12, 18].map((at) => ({ at, m, key: 'c:a' })));
  const ctx = { persistSec: 600, playlist: { visualItems: 2, maxDurationSec: 10 }, current: { kind: 'image', key: 'c:a', inPlaylist: true } };
  assert.equal(cl.evaluateFreeze(h, { ...ctx, startsDuring: () => 40 }).frozen, false);
  // The same frames with the player silent the whole time: stuck.
  assert.equal(cl.evaluateFreeze(h, { ...ctx, startsDuring: () => 0 }).reason, 'not_advancing');
});

test('frozen: not for an override we cannot time, a hold, a live stream, too few frames or too short a span', async () => {
  const m = await metricsOf(await frameOf('sale.jpg'));
  const base = { persistSec: 600, playlist: { visualItems: 3, maxDurationSec: 10 } };
  const long = hist([0, 6, 12, 18].map((at) => ({ at, m, key: 'c:x' })));
  assert.equal(cl.evaluateFreeze(long, { ...base, current: { kind: 'image', key: 'c:x', inPlaylist: false } }).frozen, false, 'trigger/emergency item');
  assert.equal(cl.evaluateFreeze(long, { ...base, current: { kind: 'hold', key: 'c:x', inPlaylist: true } }).frozen, false, 'hold');
  assert.equal(cl.evaluateFreeze(long, { ...base, current: { kind: 'live', key: 'c:x', inPlaylist: true } }).frozen, false, 'live');
  const two = hist([0, 30].map((at) => ({ at, m, key: 'c:x' })));
  assert.equal(cl.evaluateFreeze(two, { ...base, current: { kind: 'image', key: 'c:x', inPlaylist: true } }).frozen, false, 'two frames');
  const short = hist([0, 2, 4].map((at) => ({ at, m, key: 'c:x' })));
  assert.equal(cl.evaluateFreeze(short, { ...base, current: { kind: 'image', key: 'c:x', inPlaylist: true } }).frozen, false, 'under the persistence window');
});

test('frozen: a picture that changes slightly between captures is moving', async () => {
  const a = await metricsOf(await frameOf('sale.jpg'));
  const changedImg = await frameOf('sale.jpg');
  paintRect(changedImg, 100, 100, 40, 30, [255, 255, 255]);
  const b = await metricsOf(changedImg);
  const h = hist([{ at: 0, m: a }, { at: 6, m: b }, { at: 12, m: a }, { at: 18, m: b }]);
  assert.equal(cl.evaluateFreeze(h, { persistSec: 600, playlist: { visualItems: 3, maxDurationSec: 10 }, current: { kind: 'image', inPlaylist: true } }).frozen, false);
});

test('frozen: a lone video on one frame for twice its length — but never at low sensitivity', async () => {
  const m = await metricsOf(await frameOf('sale.jpg'));
  const h = hist([0, 5, 10, 15, 20].map((at) => ({ at, m, key: 'c:v' })));
  const ctx = { persistSec: 600, playlist: { visualItems: 1, maxDurationSec: 300 }, current: { kind: 'video', key: 'c:v', inPlaylist: true, durationSec: 300 } };
  assert.equal(cl.evaluateFreeze(h, ctx).reason, 'video_still');
  assert.equal(cl.evaluateFreeze(h, { ...ctx, level: 'low' }).frozen, false);
  assert.equal(cl.evaluateFreeze(h, { ...ctx, current: { ...ctx.current, durationSec: 900 } }).frozen, false, 'shorter than twice its length');
});

/* ------------------------------------------------------------------ persistence and resolve */

const PERSIST = { persistSec: 600 };
const bad = (at, kind = 'blank') => ({ kind, scope: kind === 'panel_off' ? 'panel' : 'frame', at });
const good = (at, scope = 'frame') => ({ kind: null, scope, at });
function run(obsList) {
  let state = { open: null };
  const log = [];
  for (const o of obsList) { const r = cl.step(state, o, PERSIST); state = r.state; log.push(...r.actions.map((a) => a.type + ':' + a.kind)); }
  return { state, log };
}

test('debounce: one bad frame opens a suspicion that one good frame discards — nobody is paged', () => {
  const r = run([bad(0), good(60)]);
  assert.deepEqual(r.log, ['open:blank', 'discard:blank']);
  assert.equal(r.state.open, null);
});

test('debounce: confirmed only when seen twice AND across the persistence window', () => {
  assert.deepEqual(run([bad(0), bad(300)]).log, ['open:blank'], 'twice, but only 5 minutes apart');
  const r = run([bad(0), bad(300), bad(600)]);
  assert.deepEqual(r.log, ['open:blank', 'confirm:blank']);
  assert.equal(r.state.open.openedAt, 0, 'since-when is the first sighting');
  assert.deepEqual(run([bad(0), bad(700)]).log, ['open:blank', 'confirm:blank']);
});

test('resolve: a confirmed incident needs two good observations in a row; one is a flap', () => {
  const flap = run([bad(0), bad(700), good(800), bad(900)]);
  assert.deepEqual(flap.log, ['open:blank', 'confirm:blank']);
  assert.ok(flap.state.open.confirmedAt);
  const fixed = run([bad(0), bad(700), good(800), good(860)]);
  assert.deepEqual(fixed.log, ['open:blank', 'confirm:blank', 'resolve:blank']);
  assert.equal(fixed.state.open, null);
});

test('a frozen observation carries its own history and confirms at once', () => {
  const r = cl.step({ open: null }, { kind: 'frozen', scope: 'frame', at: 1000, since: 100 }, PERSIST);
  assert.deepEqual(r.actions.map((a) => a.type), ['open', 'confirm']);
  assert.equal(r.state.open.openedAt, 100);
});

test('a changed problem closes the old incident and opens the new one', () => {
  const r = run([bad(0), bad(700), bad(800, 'unexpected')]);
  assert.deepEqual(r.log, ['open:blank', 'confirm:blank', 'resolve:blank', 'open:unexpected']);
});

test('frames and the panel do not clear each other: a screenshot cannot prove the panel is on', () => {
  const r = run([bad(0, 'panel_off'), bad(700, 'panel_off'), good(800, 'frame'), good(860, 'frame')]);
  assert.deepEqual(r.log, ['open:panel_off', 'confirm:panel_off']);
  const blankWhileOff = run([bad(0, 'panel_off'), bad(60, 'blank')]);
  assert.equal(blankWhileOff.state.open.kind, 'panel_off', 'a dark panel explains a dark frame');
  const back = run([bad(0, 'panel_off'), bad(700, 'panel_off'), good(760, 'panel'), good(820, 'panel')]);
  assert.deepEqual(back.log.slice(-1), ['resolve:panel_off']);
});

test('unknown observations change nothing', () => {
  const r = cl.step({ open: { kind: 'blank', openedAt: 0, confirmedAt: 700, count: 2, goodStreak: 1 } }, { unknown: true, at: 900 }, PERSIST);
  assert.deepEqual(r.actions, []);
  assert.equal(r.state.open.goodStreak, 1);
});

/* ------------------------------------------------------------------ settings */

test('settings: validated, unknown checks refused, defaults when nothing is stored', () => {
  assert.match(cl.normaliseSettings({ cadence_minutes: 2 }).error, /cadence/);
  assert.equal(cl.normaliseSettings({ cadence_minutes: 0 }).fields.cadence_minutes, 0, '0 = never ask, judge what arrives');
  assert.match(cl.normaliseSettings({ sensitivity: 'paranoid' }).error, /sensitivity/);
  assert.match(cl.normaliseSettings({ persist_minutes: 1 }).error, /persist/);
  assert.match(cl.normaliseSettings({ alert_checks: ['blank', '<img src=x>'] }).error, /unknown check/);
  assert.match(cl.normaliseSettings({ alert_checks: 'blank' }).error, /array/);
  assert.deepEqual(JSON.parse(cl.normaliseSettings({ alert_checks: ['blank', 'blank', 'frozen'] }).fields.alert_checks), ['blank', 'frozen']);
  const d = cl.presentSettings(null);
  assert.equal(d.enabled, true);
  assert.equal(d.is_default, true);
  assert.deepEqual(d.alert_checks, ['blank', 'frozen', 'panel_off'], 'unexpected is shown but does not page by default');
});
