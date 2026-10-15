'use strict';

// A screen-only panel has no keyboard, no pointer, and usually no way to clear site data. But
// the URL it loads is configurable from whatever manages it. ?reset=<token> is the escape hatch:
// it discards this install's identity so the panel returns as a new device with a fresh pairing
// code. That is the recovery path when a panel ends up holding an identity that belongs to a
// different screen, and the ordinary path when redeploying a panel elsewhere.
//
// The critical property is ONCE PER TOKEN. The configured URL is permanent — nobody goes back to
// remove the parameter — so a reset that fired on every load would wipe the pairing on every
// reboot and present as a screen that cannot hold its pairing at all. Worse, it would look like
// an intermittent server fault rather than the URL doing exactly what it was told.
//
// serverUrl must survive, or a panel that cannot be typed into is stranded.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

// Lift the real IIFE out of the player and run it against a fake storage + URL.
function runReset(search, store) {
  const marker = 'function applyIdentityReset()';
  const start = HTML.indexOf(marker);
  assert.notEqual(start, -1, 'applyIdentityReset() should exist');
  let depth = 0, end = -1;
  for (let j = HTML.indexOf('{', start); j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}' && --depth === 0) { end = j + 1; break; }
  }
  const scope = {
    SCREEN_SUFFIX: '',
    LINK_SUFFIX: '',   // 3.0: plain /player (no ?k=) has no per-link namespace
    STORAGE_KEY: 'rd_config',
    PLAYLIST_CACHE_KEY: 'rd_playlist_cache',
    LAYOUT_CACHE_KEY: 'rd_layout_cache',
    getConfig: () => { try { return JSON.parse(store.rd_config || '{}'); } catch { return {}; } },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    location: { search },
    URLSearchParams,
    console: { warn() {} },
  };
  const fn = new Function(...Object.keys(scope), `${HTML.slice(start, end)} applyIdentityReset();`);
  fn(...Object.values(scope));
  return store;
}

const paired = () => ({
  rd_config: JSON.stringify({ serverUrl: 'https://screentinker.com', deviceId: 'dev-1', deviceToken: 'tok-1', paired: true }),
  st_install_id: 'install-aaaa',
  rd_playlist_cache: '[{"x":1}]',
  rd_layout_cache: '{"zones":1}',
  st_group_sync: '{"offset":5}',
});

test('THE POINT: ?reset= clears the identity so the panel pairs as a new device', () => {
  const s = runReset('?reset=1', paired());
  const cfg = JSON.parse(s.rd_config);
  assert.equal(cfg.deviceId, undefined, 'device id gone');
  assert.equal(cfg.deviceToken, undefined, 'token gone');
  assert.equal(cfg.paired, false);
  assert.equal(s.st_install_id, undefined, 'a NEW identity is minted, not the old one reused');
});

test('the server URL survives — a panel with no keyboard must not be stranded', () => {
  const s = runReset('?reset=1', paired());
  assert.equal(JSON.parse(s.rd_config).serverUrl, 'https://screentinker.com');
});

test('cached content is dropped so the new device does not show the old screen', () => {
  const s = runReset('?reset=1', paired());
  assert.equal(s.rd_playlist_cache, undefined);
  assert.equal(s.rd_layout_cache, undefined);
  assert.equal(s.st_group_sync, undefined);
});

test('THE TRAP: the same token left in the URL forever resets exactly ONCE', () => {
  const s = paired();
  runReset('?reset=1', s);
  // Panel reboots. The configured URL still says ?reset=1 — it always will.
  s.rd_config = JSON.stringify({ serverUrl: 'https://screentinker.com', deviceId: 'dev-2', deviceToken: 'tok-2', paired: true });
  s.st_install_id = 'install-bbbb';
  runReset('?reset=1', s);
  const cfg = JSON.parse(s.rd_config);
  assert.equal(cfg.deviceId, 'dev-2', 'the new pairing SURVIVES the reboot');
  assert.equal(cfg.paired, true);
  assert.equal(s.st_install_id, 'install-bbbb', 'and keeps its identity');
});

test('a DIFFERENT token resets again, so the hatch is reusable', () => {
  const s = paired();
  runReset('?reset=1', s);
  s.rd_config = JSON.stringify({ serverUrl: 'https://screentinker.com', deviceId: 'dev-2', paired: true });
  runReset('?reset=2', s);
  assert.equal(JSON.parse(s.rd_config).deviceId, undefined, 'a new token means a new reset');
});

test('no reset parameter changes nothing at all', () => {
  const s = runReset('', paired());
  const cfg = JSON.parse(s.rd_config);
  assert.equal(cfg.deviceId, 'dev-1');
  assert.equal(s.st_install_id, 'install-aaaa');
  assert.equal(s.st_reset_applied, undefined);
});

test('an unrelated query string is not mistaken for a reset', () => {
  const s = runReset('?preview=1&playlist=abc', paired());
  assert.equal(JSON.parse(s.rd_config).deviceId, 'dev-1', 'preview mode is untouched');
});

test('storage being unavailable does not throw — a dying panel must still boot', () => {
  const marker = 'function applyIdentityReset()';
  const start = HTML.indexOf(marker);
  let depth = 0, end = -1;
  for (let j = HTML.indexOf('{', start); j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}' && --depth === 0) { end = j + 1; break; }
  }
  const scope = {
    SCREEN_SUFFIX: '',
    LINK_SUFFIX: '',   // 3.0: plain /player (no ?k=) has no per-link namespace
    STORAGE_KEY: 'rd_config', PLAYLIST_CACHE_KEY: 'p', LAYOUT_CACHE_KEY: 'l',
    getConfig: () => ({}),
    localStorage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } },
    location: { search: '?reset=1' }, URLSearchParams, console: { warn() {} },
  };
  assert.doesNotThrow(() =>
    new Function(...Object.keys(scope), `${HTML.slice(start, end)} applyIdentityReset();`)(...Object.values(scope)));
});

test('it runs BEFORE config is read, or the reset would not take effect this boot', () => {
  const resetAt = HTML.indexOf('function applyIdentityReset()');
  const configAt = HTML.indexOf('let config = getConfig();');
  assert.ok(resetAt !== -1 && configAt !== -1);
  assert.ok(resetAt < configAt, 'identity is cleared before anything reads it');
});
