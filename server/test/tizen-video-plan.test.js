'use strict';

// 3.0 TV-safe video on the Samsung Tizen player (tizen/js/video-plan.js + player.js renderVideo).
//
// A Tizen signage TV cannot decode a 1080x1920 stream: black on a landscape TV, an AVPlay prepare
// error ("Portrait video isn't supported…") on a portrait one. The server makes copies; these pin
// which file the TV plays and how, per orientation:
//   - portrait        + tall video + rot_cw ready  -> the rot_cw copy, UNROTATED, in the flat layer
//   - portrait-flipped + tall video + rot_ccw ready -> the rot_ccw copy, same
//   - landscape       + tall video + fit ready     -> the fit copy on the normal <video> path
//   - no copy yet -> the old path (AVPlay on portrait), and a note that says what is really happening
//   - a file marked "already rotated for portrait screens" -> played as-is, no rotation anywhere
//   - a WIDE video on a portrait screen keeps the working AVPlay rotation path
// Same vm + DOM-shim harness as tizen-multitasking-resume.test.js (no jsdom in the repo).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Plan = require('../../tizen/js/video-plan.js');

const TALL = { content_id: 'c1', mime_type: 'video/mp4', width: 1080, height: 1920, content_rev: 7 };
const WIDE = { content_id: 'c2', mime_type: 'video/mp4', width: 1920, height: 1080, content_rev: 3 };
const READY = { rot_cw: 11, rot_ccw: 12, fit: 13 };

// ------------------------------------------------------------------ the pure plan

test('plan: each orientation picks its own copy of a tall video', () => {
  const it = { ...TALL, video_variants: READY };
  assert.deepEqual(Plan.plan(it, 'portrait', true), { mode: 'flat', kind: 'rot_cw' });
  assert.deepEqual(Plan.plan(it, 'portrait-flipped', true), { mode: 'flat', kind: 'rot_ccw' });
  assert.deepEqual(Plan.plan(it, 'landscape', true), { mode: 'html5', kind: 'fit' });
  assert.deepEqual(Plan.plan(it, 'landscape-flipped', true), { mode: 'html5', kind: 'fit' });
  assert.equal(Plan.variantPath(it, 'rot_cw'), '/api/content/c1/variant/rot_cw?rev=11');
});

test('plan: only the copy for THIS orientation counts (a fit copy is no use to a portrait screen)', () => {
  const it = { ...TALL, video_variants: { fit: 13 } };
  assert.deepEqual(Plan.plan(it, 'portrait', true), { mode: 'av', kind: null }, 'falls back to the AVPlay path');
  assert.deepEqual(Plan.plan(it, 'portrait', false), { mode: 'html5', kind: null });
  const flipOnly = { ...TALL, video_variants: { rot_cw: 11 } };
  assert.deepEqual(Plan.plan(flipOnly, 'portrait-flipped', true), { mode: 'av', kind: null }, 'never the wrong turn direction');
});

test('plan: a wide video keeps the working paths (AVPlay rotation on portrait, <video> on landscape)', () => {
  assert.deepEqual(Plan.plan(WIDE, 'portrait', true), { mode: 'av', kind: null });
  assert.deepEqual(Plan.plan({ ...WIDE, video_variants: READY }, 'portrait', true), { mode: 'av', kind: null }, 'copies are for tall videos only');
  assert.deepEqual(Plan.plan(WIDE, 'landscape', true), { mode: 'html5', kind: null });
});

test('plan: "already rotated for portrait screens" plays the original as-is, unrotated', () => {
  const pre = { ...WIDE, video_prerotated: 1 };
  assert.deepEqual(Plan.plan(pre, 'portrait', true), { mode: 'flat', kind: null });
  assert.deepEqual(Plan.plan(pre, 'portrait-flipped', true), { mode: 'flat', kind: null });
  assert.deepEqual(Plan.plan(pre, 'landscape', true), { mode: 'html5', kind: null }, 'a landscape screen plays it normally');
  // The flag beats a copy: the operator said this file is already the right picture.
  assert.deepEqual(Plan.plan({ ...TALL, video_prerotated: 1, video_variants: READY }, 'portrait', true), { mode: 'flat', kind: null });
});

test('plan: a landscape TV says "preparing" instead of showing a black tall original', () => {
  assert.deepEqual(Plan.plan({ ...TALL, video_variant_state: 'preparing' }, 'landscape', true), { mode: 'note', kind: null });
  assert.deepEqual(Plan.plan({ ...TALL, video_variant_state: 'unavailable', video_variant_reason: 'failed' }, 'landscape', true), { mode: 'html5', kind: null }, 'other states still try the original');
  assert.deepEqual(Plan.plan(TALL, 'landscape', true), { mode: 'html5', kind: null });
});

test('note: says what is actually happening', () => {
  assert.equal(Plan.noteKey({ ...TALL, video_variant_state: 'preparing' }), 'tall_video_preparing');
  assert.equal(Plan.noteKey({ ...TALL, video_variant_state: 'unavailable', video_variant_reason: 'no_ffmpeg' }), 'tall_video_no_ffmpeg');
  assert.equal(Plan.noteKey({ ...TALL, video_variant_state: 'unavailable', video_variant_reason: 'failed' }), 'tall_video_unavailable');
  assert.equal(Plan.noteKey(WIDE), 'portrait_video_unsupported');
});

test('media cache: an item that plays a copy is cached AS the copy, the undecodable original not at all', () => {
  const items = [{ ...TALL, video_variants: READY }, WIDE];
  const out = Plan.cacheItems(items, 'portrait');
  assert.deepEqual(out[0], { content_id: 'c1__rot_cw', content_rev: 11, __path: '/api/content/c1/variant/rot_cw?rev=11' });
  assert.equal(out[1], WIDE);
  assert.equal(Plan.cacheItems(items, 'landscape')[0].content_id, 'c1__fit');
});

// ------------------------------------------------------------------ the player

function makeEl(tag) {
  const el = {
    tag, style: {}, className: '', attrs: {}, children: [], _html: '', _src: '', paused: true,
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    querySelector(sel) { const tags = sel.split(',').map((s) => s.trim()); return this.children.find((c) => tags.includes(c.tag)) || null; },
    querySelectorAll(sel) { const tags = sel.split(',').map((s) => s.trim()); return this.children.filter((c) => tags.includes(c.tag)); },
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    addEventListener() {}, removeEventListener() {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    load() {}, pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
  };
  Object.defineProperty(el, 'innerHTML', { get() { return this._html; }, set(v) { this._html = v; if (v === '') this.children = []; } });
  Object.defineProperty(el, 'src', { get() { return this._src; }, set(v) { this._src = v; } });
  return el;
}

function fakeAvplay({ prepareFails = false } = {}) {
  const calls = [];
  const av = {
    calls,
    open(u) { calls.push(['open', u]); }, close() { calls.push(['close']); }, stop() {}, play() { calls.push(['play']); },
    setDisplayRect() {}, setDisplayMethod() {}, setListener() {},
    setDisplayRotation(r) { calls.push(['rotate', r]); },
    prepareAsync(ok, err) { if (prepareFails) err(new Error('PLAYER_ERROR_NOT_SUPPORTED_FILE')); else ok(); },
  };
  return av;
}

function load({ avplay = null, lang = 'en' } = {}) {
  const avObj = makeEl('object');
  const sandbox = {
    console, Date,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    localStorage: { getItem: (k) => (k === 'rd_lang' ? lang : null), setItem() {}, removeItem() {} },
    navigator: { language: lang },
    innerWidth: 1920, innerHeight: 1080,
  };
  sandbox.document = {
    body: makeEl('body'),
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => (id === 'avPlayer' ? avObj : null),
  };
  sandbox.window = sandbox;
  if (avplay) sandbox.webapis = { avplay };
  vm.createContext(sandbox);
  const dir = path.join(__dirname, '..', '..', 'tizen', 'js');
  vm.runInContext(fs.readFileSync(path.join(dir, 'video-plan.js'), 'utf8'), sandbox, { filename: 'video-plan.js' });
  vm.runInContext(fs.readFileSync(path.join(dir, 'player.js'), 'utf8'), sandbox, { filename: 'player.js' });
  return sandbox;
}

function setup(orientation, opts) {
  const sb = load(opts);
  const stage = makeEl('div');
  const player = new sb.PlaylistPlayer(stage, () => 'http://server');
  player.setOrientation(orientation);
  const flat = () => sb.document.body.children.find((c) => c.id === 'flatVideo');
  return { sb, stage, player, flat };
}

test('player: portrait + ready rot_cw copy -> plain <video> of the copy, outside the rotated stage, no AVPlay', () => {
  const av = fakeAvplay();
  const { stage, player, flat } = setup('portrait', { avplay: av });
  player.renderVideo({ ...TALL, video_variants: READY }, true);
  const layer = flat();
  assert.ok(layer, 'the unrotated layer is mounted');
  assert.equal(layer.style.display, 'block');
  const v = layer.querySelector('video');
  assert.equal(v.src, 'http://server/api/content/c1/variant/rot_cw?rev=11');
  assert.equal(stage.querySelector('video'), null, 'nothing in the CSS-rotated stage');
  assert.equal(av.calls.length, 0, 'AVPlay never opened: the copy needs no rotation');
  assert.equal(player.hasContentOnScreen(), true);
  player.clearStage();
  assert.equal(layer.style.display, 'none', 'the next item clears the layer');
  assert.equal(layer.children.length, 0);
});

test('player: portrait-flipped plays the counter-clockwise copy', () => {
  const { player, flat } = setup('portrait-flipped', { avplay: fakeAvplay() });
  player.renderVideo({ ...TALL, video_variants: READY }, true);
  assert.equal(flat().querySelector('video').src, 'http://server/api/content/c1/variant/rot_ccw?rev=12');
});

test('player: landscape + ready fit copy -> the fit copy on the normal stage', () => {
  const { stage, player, flat } = setup('landscape', { avplay: fakeAvplay() });
  player.renderVideo({ ...TALL, video_variants: READY }, true);
  assert.equal(stage.querySelector('video').src, 'http://server/api/content/c1/variant/fit?rev=13');
  assert.equal(flat(), undefined);
});

test('player: per-item Fit (fit_mode contain) reaches the full-screen <video> and the flat layer', () => {
  const { stage, player } = setup('landscape');
  player.renderVideo({ ...WIDE, fit_mode: 'contain' }, true);
  assert.equal(stage.querySelector('video').className, 'contain');
  const p = setup('portrait', { avplay: fakeAvplay() });
  p.player.renderVideo({ ...TALL, video_variants: READY, fit_mode: 'contain' }, true);
  assert.equal(p.flat().querySelector('video').className, 'contain');
});

test('player: marked pre-rotated -> the ORIGINAL, unrotated, no AVPlay rotation', () => {
  const av = fakeAvplay();
  const { player, flat } = setup('portrait', { avplay: av });
  player.renderVideo({ ...WIDE, video_prerotated: 1 }, true);
  assert.equal(flat().querySelector('video').src, 'http://server/api/content/c2/file?rev=3');
  assert.equal(av.calls.length, 0);
});

test('player: a wide video on a portrait screen still goes through AVPlay with the hardware rotation', () => {
  const av = fakeAvplay();
  const { player, flat } = setup('portrait', { avplay: av });
  player.renderVideo(WIDE, true);
  assert.deepEqual(av.calls.find((c) => c[0] === 'rotate'), ['rotate', 'PLAYER_DISPLAY_ROTATION_90']);
  assert.equal(flat(), undefined);
});

test('player: tall video, copy still being prepared, AVPlay refuses it -> the "preparing" note, not the old advice', () => {
  const av = fakeAvplay({ prepareFails: true });
  const { stage, player } = setup('portrait', { avplay: av });
  player.renderVideo({ ...TALL, video_variant_state: 'preparing' }, true);
  assert.match(stage.innerHTML, /preparing a TV-friendly copy/);
  assert.doesNotMatch(stage.innerHTML, /mark it Landscape/);
});

test('player: no ffmpeg on the server -> the note says so (self-host: install ffmpeg)', () => {
  const { stage, player } = setup('portrait', { avplay: fakeAvplay({ prepareFails: true }) });
  player.renderVideo({ ...TALL, video_variant_state: 'unavailable', video_variant_reason: 'no_ffmpeg' }, true);
  assert.match(stage.innerHTML, /ffmpeg/);
});

test('player: a landscape TV shows the "preparing" note instead of a black tall original', () => {
  const { stage, player } = setup('landscape');
  player.renderVideo({ ...TALL, video_variant_state: 'preparing' }, true);
  assert.equal(stage.querySelector('video'), null);
  assert.match(stage.innerHTML, /preparing a TV-friendly copy/);
});

test('player strings: every Tizen language has the new notes or falls back to English per key', () => {
  for (const lang of ['en', 'de', 'es', 'fr', 'pt', 'it', 'nl', 'ja', 'zh', 'hi']) {
    const { stage, player } = setup('landscape', { lang });
    player.renderVideo({ ...TALL, video_variant_state: 'preparing' }, true);
    assert.ok(stage.innerHTML.length > 60, `${lang}: a real sentence`);
    assert.doesNotMatch(stage.innerHTML, /tall_video_preparing/, `${lang}: never the raw key`);
  }
});
