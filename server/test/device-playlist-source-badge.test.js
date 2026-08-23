'use strict';

/*
 * "Why is this screen showing that?"
 *
 * Until playlist inheritance existed the dashboard could not answer it: devices.playlist_id was
 * COPIED down from the group or wall, so a playlist chosen for a screen and one it merely inherited
 * were the same byte, and the page had nothing to tell them apart. playlist_source now records
 * which, and playlist_source_name records WHICH group or wall — so the badge can name it instead of
 * saying "inherited" and leaving the operator to go hunting.
 *
 * Rendered out of the real source rather than a copy of it, for the reason device-controls-hidden
 * gives: a test that asserts on its own duplicate of the markup passes forever.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');

function badge(device) {
  const i = SRC.indexOf('function playlistSourceBadge(device) {');
  assert.notEqual(i, -1, 'device-detail.js no longer defines playlistSourceBadge');
  let depth = 0, end = -1;
  for (let k = SRC.indexOf('{', i); k < SRC.length; k++) {
    if (SRC[k] === '{') depth++;
    else if (SRC[k] === '}' && --depth === 0) { end = k + 1; break; }
  }
  assert.notEqual(end, -1, 'could not find the end of playlistSourceBadge');

  const sandbox = {
    esc: (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    // The real strings, so a key renamed in the view without a matching key in en.js shows up here
    // as the literal key rather than silently passing.
    t: (k, vars) => (vars ? `${k}:${JSON.stringify(vars)}` : k),
    String, Object, JSON,
  };
  vm.runInNewContext(SRC.slice(i, end) + '; __out = playlistSourceBadge(__device);',
    Object.assign(sandbox, { __device: device, __out: null }));
  return sandbox.__out;
}

test('an inherited playlist NAMES the group it came from', () => {
  const html = badge({ playlist_source: 'group', playlist_source_name: 'Lobby' });
  assert.match(html, /device\.playlist\.inherited_from/);
  assert.match(html, /Lobby/, 'the badge must name the group — "inherited" alone sends the operator hunting');
  assert.doesNotMatch(html, /revertPlaylistBtn/,
    'there is nothing to revert FROM on an inherited playlist, and offering it would be a control '
    + 'that does nothing');
});

test('a wall is named the same way', () => {
  const html = badge({ playlist_source: 'wall', playlist_source_name: 'Atrium wall' });
  assert.match(html, /device\.playlist\.inherited_from/);
  assert.match(html, /Atrium wall/);
});

test('⚠️ an unnamed source still renders, rather than saying "Inherited from undefined"', () => {
  const html = badge({ playlist_source: 'group', playlist_source_name: null });
  assert.match(html, /device\.playlist\.inherited_generic/);
  assert.doesNotMatch(html, /undefined|null/);
});

test('an override says so, and offers the revert', () => {
  const html = badge({ playlist_source: 'device' });
  assert.match(html, /device\.playlist\.overridden/);
  assert.match(html, /id="revertPlaylistBtn"/,
    'the revert is the whole point: the row can finally distinguish chosen from inherited, so the '
    + 'UI can offer "stop being special"');
});

test('a device that resolves to nothing gets no badge at all', () => {
  assert.equal(badge({ playlist_source: null }), '');
});

test('the source name is escaped — it is operator-supplied text', () => {
  const html = badge({ playlist_source: 'group', playlist_source_name: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(html, /<img/, 'a group named with markup must not be injected into the page');
  assert.match(html, /&lt;img/);
});
