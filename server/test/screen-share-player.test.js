'use strict';

/*
 * 3.0 screen share — the web player's side: which players DECLARE remote.screen_share (the gate the
 * dashboard and the meeting-room code rely on), and that the receiver is wired the way the server
 * expects. The real declaredCapabilities() is extracted from index.html and run in a sandbox, the
 * same way player-declared-capabilities.test.js does it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
const RECEIVER = fs.readFileSync(path.join(__dirname, '..', 'lib', 'screen-share-player.js'), 'utf8');

function extract(name) {
  const start = HTML.indexOf(`    function ${name}(`);
  assert.notEqual(start, -1, `${name}() must exist in the player`);
  let depth = 0;
  for (let i = HTML.indexOf('{', start); i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}' && --depth === 0) return HTML.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

function declare({ rtc = true, receiver = true, brightsign = false, host = false, ios = false } = {}) {
  const sandbox = {
    console: { log() {}, warn() {} },
    navigator: {},
    document: { createElement: () => ({ getContext: () => null }) },
    BS: null,
  };
  sandbox.window = sandbox;
  // The receiver's own probe decides; this world just says what it would answer.
  if (receiver) sandbox.STScreenShare = { isSupported: () => rtc };
  vm.createContext(sandbox);
  const prelude = `var ON_BRIGHTSIGN = ${brightsign}; var HOST = ${ios ? '{ platform: "ios" }' : host ? '{ platform: "webos" }' : 'null'};`
    + (ios ? ' function onIOS() { return true; }' : '');
  vm.runInContext(`${prelude}\n${extract('declaredCapabilities')}\nvar __out = declaredCapabilities();`, sandbox);
  return sandbox.__out;
}

test('a plain browser with WebRTC and the receiver loaded declares remote.screen_share', () => {
  assert.ok(declare().includes('remote.screen_share'));
});

test('no usable WebRTC receiver (e.g. Chromium < 69 without addTransceiver), or the receiver script failed to load: not declared', () => {
  assert.ok(!declare({ rtc: false }).includes('remote.screen_share'));
  assert.ok(!declare({ receiver: false }).includes('remote.screen_share'));
});

test('inside the BrightSign or the webOS / Vega shells it is NOT declared (no documented WebRTC there)', () => {
  assert.ok(!declare({ brightsign: true }).includes('remote.screen_share'));
  assert.ok(!declare({ host: true }).includes('remote.screen_share'));
});

test('the iOS app (WKWebView, iOS 16+) declares it — but only with a working receiver', () => {
  assert.ok(declare({ ios: true }).includes('remote.screen_share'));
  assert.ok(!declare({ ios: true, rtc: false }).includes('remote.screen_share'));
});

test('the extracted function still runs where the shell globals do not exist at all', () => {
  const sandbox = { console: { log() {} }, navigator: {}, document: { createElement: () => ({ getContext: () => null }) }, BS: null };
  sandbox.window = sandbox;
  sandbox.STScreenShare = { isSupported: () => true };
  vm.createContext(sandbox);
  vm.runInContext(`${extract('declaredCapabilities')}\nvar __out = declaredCapabilities();`, sandbox);
  assert.ok(sandbox.__out.includes('remote.screen_share'));
});

test('the player loads the receiver and handles start / stop / code from the server', () => {
  assert.match(HTML, /<script src="\/player\/screen-share\.js"><\/script>/);
  assert.match(HTML, /socket\.on\('device:screenshare-start'/);
  assert.match(HTML, /socket\.on\('device:screenshare-stop'/);
  assert.match(HTML, /socket\.on\('device:screenshare-code'/);
  // The playlist is ducked while sharing and restored after, via its own flag.
  assert.match(extract('setShareDucking'), /shareDucking = !!on;/);
  assert.match(extract('triggerSyncAudio'), /typeof shareDucking !== 'undefined' && shareDucking/);
});

test('the receiver authenticates in the first message (never the URL), offers recvonly, and never parses HTML', () => {
  assert.match(RECEIVER, /type: 'auth', device_token: opts\.deviceToken, session_id: opts\.sessionId/);
  assert.doesNotMatch(RECEIVER, /screen-share\/ws\?/, 'no token in the URL');
  assert.match(RECEIVER, /addTransceiver\('video', \{ direction: 'recvonly' \}\)/);
  assert.match(RECEIVER, /addTransceiver\('audio', \{ direction: 'recvonly' \}\)/);
  assert.doesNotMatch(RECEIVER, /innerHTML|insertAdjacentHTML|outerHTML/, 'names and codes go in as text');
  // Only a PNG data URL from our own server is accepted as the QR image.
  assert.match(RECEIVER, /\^data:image\\\/png;base64,/);
});

test('the receiver\'s own support probe requires addTransceiver, not just RTCPeerConnection', () => {
  const sandbox = { window: {}, WebSocket: function () {}, MediaStream: function () {} };
  sandbox.window = sandbox;
  function OldPC() {}
  sandbox.RTCPeerConnection = OldPC;
  vm.createContext(sandbox);
  vm.runInContext(RECEIVER, sandbox);
  assert.equal(sandbox.STScreenShare.isSupported(), false, 'Chromium < 69: no addTransceiver');
  OldPC.prototype.addTransceiver = function () {};
  assert.equal(sandbox.STScreenShare.isSupported(), true);
});

// ---------------------------------------------------------------- several presenters (tiles)
function declareTiles(opts = {}) {
  const sandbox = { console: { log() {}, warn() {} }, navigator: {}, document: { createElement: () => ({ getContext: () => null }) }, BS: null };
  sandbox.window = sandbox;
  sandbox.STScreenShare = { isSupported: () => opts.rtc !== false, tiles: opts.tiles !== false };
  vm.createContext(sandbox);
  vm.runInContext(`var ON_BRIGHTSIGN = ${!!opts.brightsign}; var HOST = null;\n${extract('declaredCapabilities')}\nvar __out = declaredCapabilities();`, sandbox);
  return sandbox.__out;
}

test('a receiver that tiles declares remote.screen_share_tiles; an older one, or no WebRTC, does not', () => {
  assert.ok(declareTiles().includes('remote.screen_share_tiles'));
  assert.ok(!declareTiles({ tiles: false }).includes('remote.screen_share_tiles'));
  assert.ok(!declareTiles({ rtc: false }).includes('remote.screen_share_tiles'));
  assert.ok(!declareTiles({ brightsign: true }).includes('remote.screen_share_tiles'));
  assert.match(RECEIVER, /tiles: true/);
});

test('the player follows the layout event, and gives the playlist back only when the LAST share is gone', () => {
  assert.match(HTML, /socket\.on\('device:screenshare-layout'/);
  assert.match(HTML, /\(st === 'stopped' \|\| st === 'unsupported'\) && !SS\.active\(\)/);
  // The remote viewer draws every visible tile, not just one.
  assert.match(extract('drawScreenShare'), /tilesOnScreen/);
});
