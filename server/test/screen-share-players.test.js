'use strict';

/*
 * 3.0 screen share on the players that are NOT the browser web player (docs/screen-share.md, "Which
 * screens can show a share"): who declares remote.screen_share and when, and that each one wires
 * the same protocol. The web player's own declaration is in screen-share-player.test.js; the native
 * RTC page and multi share run end to end in screen-share-e2e.test.js; Android's wire handling is
 * JUnit (android/.../ScreenShareProtocolTest.kt) and the native player's is pytest
 * (native/tests/test_screen_share.py).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ------------------------------------------------------------------ Samsung Tizen
test('Tizen ships the web player\'s receiver byte for byte, and build-wgt.sh re-copies it', () => {
  const a = fs.readFileSync(path.join(ROOT, 'server/lib/screen-share-player.js'));
  const b = fs.readFileSync(path.join(ROOT, 'tizen/js/screen-share.js'));
  assert.ok(a.equals(b), 'tizen/js/screen-share.js has drifted — re-copy it (build-wgt.sh does this)');
  assert.match(read('tizen/build-wgt.sh'), /cp \.\.\/server\/lib\/screen-share-player\.js js\/screen-share\.js/);
  const html = read('tizen/index.html');
  const iRecv = html.indexOf('js/screen-share.js');
  const iGlue = html.indexOf('js/screen-share-tizen.js');
  const iCaps = html.indexOf('js/capabilities.js');
  const iApp = html.indexOf('js/app.js');
  assert.ok(iRecv > 0 && iRecv < iGlue && iGlue < iCaps && iCaps < iApp, 'receiver, glue, then capabilities and app');
});

function tizenSandbox({ version = '10.0', rtc = true } = {}) {
  const els = {};
  const sb = {
    console: { log() {}, warn() {} },
    tizen: { systeminfo: { getCapability: (k) => (k === 'http://tizen.org/feature/platform.version' ? version : null) } },
    document: { getElementById: (id) => els[id] || null, querySelectorAll: () => [] },
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(read('tizen/js/screen-share.js'), sb);
  if (!rtc) sb.STScreenShare.isSupported = () => false;
  else sb.STScreenShare.isSupported = () => true;   // the engine probe itself is tested on the web player
  vm.runInContext(read('tizen/js/screen-share-tizen.js'), sb);
  return { sb, els };
}

test('Tizen claims a share only on Tizen 10+ AND with a working receiver', () => {
  assert.equal(tizenSandbox({ version: '10.0' }).sb.STShareTizen.supported(), true);
  assert.equal(tizenSandbox({ version: '11.0' }).sb.STShareTizen.supported(), true);
  for (const v of ['9.0', '8.0', '6.5', '', null, 'garbage']) {
    assert.equal(tizenSandbox({ version: v }).sb.STShareTizen.supported(), false, `Tizen ${v}`);
  }
  assert.equal(tizenSandbox({ version: '10.0', rtc: false }).sb.STShareTizen.supported(), false);
});

test('Tizen capabilities.js declares remote.screen_share exactly when the glue says so', () => {
  for (const [ok, expect] of [[true, true], [false, false]]) {
    const sb = { console: { log() {} }, STShareTizen: { supported: () => ok } };
    sb.window = sb;
    vm.createContext(sb);
    vm.runInContext(read('tizen/js/capabilities.js'), sb);
    assert.equal(sb.STCapabilities.detect().includes('remote.screen_share'), expect);
  }
  // No glue loaded (an older .wgt layout): not declared, and detect() still works.
  const bare = { console: { log() {} } };
  bare.window = bare;
  vm.createContext(bare);
  vm.runInContext(read('tizen/js/capabilities.js'), bare);
  assert.ok(!bare.STCapabilities.detect().includes('remote.screen_share'));
});

test('Tizen wires start / stop / code to the receiver and steps the content aside and back', () => {
  const { sb } = tizenSandbox();
  const calls = [];
  let active = false;
  let onState = null;
  sb.STScreenShare.start = (o) => { calls.push(['start', o.sessionId, o.deviceId, o.sharedBy, o.guest]); active = true; onState = o.onState; };
  sb.STScreenShare.stop = (id, reason) => calls.push(['stop', id, reason]);
  sb.STScreenShare.showCode = (d) => calls.push(['code', d && d.code]);
  sb.STScreenShare.active = () => active;
  const handlers = {};
  const socket = { on: (ev, fn) => { handlers[ev] = fn; } };
  sb.STShareTizen.wire(socket, {
    creds: () => ({ deviceId: 'dev1', deviceToken: 'tok', serverUrl: 'https://s.example' }),
    pause: () => calls.push(['pause']), resume: () => calls.push(['resume']), log: () => {},
  });
  assert.deepEqual(Object.keys(handlers).sort(), ['device:screenshare-code', 'device:screenshare-start', 'device:screenshare-stop']);
  handlers['device:screenshare-start']({ session_id: 's1', shared_by: 'Gail', guest: true, ice_servers: [] });
  handlers['device:screenshare-start']({ session_id: 42 });   // junk: ignored
  handlers['device:screenshare-stop']({ session_id: 's1', reason: 'stopped_by_owner' });
  handlers['device:screenshare-code']({ code: 'K7QM-3XHP' });
  assert.deepEqual(calls.slice(0, 2), [['pause'], ['start', 's1', 'dev1', 'Gail', true]]);
  assert.deepEqual(calls.slice(2), [['stop', 's1', 'stopped_by_owner'], ['code', 'K7QM-3XHP']]);
  // The receiver reports stopped: the content comes back once.
  active = false;
  onState('stopped', 'stopped_by_owner');
  onState('stopped', 'again');
  assert.equal(calls.filter((c) => c[0] === 'resume').length, 1);
});

test('Tizen\'s remote viewer gets an honest card while a share is up, never the paused playlist', () => {
  const { sb, els } = tizenSandbox();
  const drawn = [];
  const ctx = { fillRect() {}, fillText: (txt) => drawn.push(txt), set fillStyle(_) {}, set font(_) {}, set textAlign(_) {} };
  assert.equal(sb.STShareTizen.drawCard(ctx, 960, 540), false, 'no share: the normal capture runs');
  els['st-share-overlay'] = { parentNode: {} };
  els['st-share-badge'] = { textContent: 'Shared by Gail · guest' };
  assert.equal(sb.STShareTizen.drawCard(ctx, 960, 540), true);
  assert.ok(drawn.includes('A screen share is on screen'));
  assert.ok(drawn.some((d) => /can.t be captured/.test(d)));
  assert.ok(drawn.includes('Shared by Gail · guest'));
  // And app.js consults it before anything else in its capture.
  const app = read('tizen/js/app.js');
  const cap = app.slice(app.indexOf('function captureAndSend'));
  assert.ok(cap.indexOf('STShareTizen.drawCard') > 0 && cap.indexOf('STShareTizen.drawCard') < cap.indexOf("querySelector('img')"));
});

// ------------------------------------------------------------------ the others
test('Android declares remote.screen_share and handles the three events through its own receiver', () => {
  const caps = read('android/app/src/main/java/com/remotedisplay/player/telemetry/PlayerCapabilities.kt');
  assert.match(caps, /"remote\.screen_share"/);
  const svc = read('android/app/src/main/java/com/remotedisplay/player/service/WebSocketService.kt');
  for (const ev of ['start', 'stop', 'code']) assert.match(svc, new RegExp(`safeOn\\("device:screenshare-${ev}"\\)`));
  const recv = read('android/app/src/main/java/com/remotedisplay/player/remote/ScreenShareReceiver.kt');
  // Token in the first message, never the URL; recvonly video + audio, the same as the web receiver.
  assert.match(recv, /authMessage\(deviceToken, start\.sessionId\)/);
  assert.doesNotMatch(read('android/app/src/main/java/com/remotedisplay/player/remote/ScreenShareProtocol.kt'), /screen-share\/ws\?/);
  assert.match(recv, /MEDIA_TYPE_VIDEO, recv\)/);
  assert.match(recv, /MEDIA_TYPE_AUDIO, recv\)/);
  // The remote viewer: the overlay is redrawn on top of the capture while a share is up.
  assert.match(read('android/app/src/main/java/com/remotedisplay/player/remote/ScreenshotCapture.kt'), /drawScreenShare\(view, canvas\)/);
});

test('the native Pi / Windows / macOS player declares it and loads the server\'s own receiver', () => {
  assert.match(read('native/screentinker_native/capabilities.py'), /"remote\.screen_share"/);
  const page = read('native/screentinker_native/ui/rtc_page.py');
  assert.match(page, /<script src="\/player\/screen-share\.js"><\/script>/);
  const app = read('native/screentinker_native/app.py');
  for (const ev of ['start', 'stop', 'code']) assert.match(app, new RegExp(`"device:screenshare-${ev}"`));
});

test('players with no WebRTC receiver never declare it', () => {
  // Roku: no web engine at all. BrightSign / webOS / Vega run the web player, which withholds it in
  // those shells (screen-share-player.test.js). The baselines never grant it to anyone.
  const caps = require('../lib/player-capabilities');
  for (const [family, list] of Object.entries(caps.BASELINE)) {
    assert.ok(!list.includes('remote.screen_share'), `${family} baseline must not grant remote.screen_share`);
  }
  const rokuFiles = fs.readdirSync(path.join(ROOT, 'roku'), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(brs|xml)$/.test(e.name)).map((e) => path.join(e.parentPath || e.path, e.name))
    .filter((f) => !f.includes('node_modules'));
  assert.ok(rokuFiles.length > 0);
  for (const f of rokuFiles) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /remote\.screen_share/, f);
});

test('docs carry the per-player support table with sources', () => {
  const doc = read('docs/screen-share.md');
  for (const p of ['Android', 'Raspberry Pi', 'Windows', 'macOS', 'Tizen', 'webOS', 'BrightSign', 'Vega', 'iOS', 'tvOS', 'Roku']) {
    assert.match(doc, new RegExp(p), `docs mention ${p}`);
  }
  assert.match(doc, /developer\.samsung\.com\/smarttv\/develop\/specifications\/web-engine-specifications/);
  assert.match(doc, /SCREEN_SHARE_MAX_TARGETS/);
});
