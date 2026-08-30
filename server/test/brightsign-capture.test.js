'use strict';

/*
 * Server-side framebuffer capture for a BrightSign running server-on-a-player.
 *
 * ⚠️ THE GAP THIS FILLS. Screenshots did not work at all on that shape, by either existing route:
 *   - the page cannot capture (its widget is created WITHOUT nodejs_enabled, so `require` is absent
 *     and `@brightsign/screenshot` is unreachable — and an in-page canvas cannot read the hardware
 *     video plane anyway, returning a frame with the content missing and throwing nothing);
 *   - the host-collected fallback has nothing collecting it, because brightsign/server/autorun.brs
 *     contains no snapshot code, unlike the player autorun which has the full implementation.
 *
 * The server there is real Node (roNodeJs), so the same module is an ordinary import for it.
 *
 * ⚠️ WHAT THESE TESTS CAN AND CANNOT PROVE. `@brightsign/screenshot` exists only on the hardware,
 * so no test here can capture a real frame — and pretending otherwise is how this feature ended up
 * with zero runtime coverage in the first place. What IS provable off-hardware is everything around
 * the call: that it degrades instead of throwing where the module is absent, that it never leaves
 * files behind, and that two captures cannot collide. The frame itself has to be verified on a box.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const cap = require('../lib/brightsign-capture');

test('on a machine without the module it reports unavailable rather than throwing', () => {
  // This is every developer machine and all of CI. A signage server must load and serve regardless.
  assert.doesNotThrow(() => cap.available());
  assert.equal(cap.available(), false);
});

test('capture() resolves null off-hardware — never rejects, never hangs', async () => {
  const r = await cap.capture({ width: 960, height: 540 });
  assert.equal(r, null);
});

test('capture() tolerates junk options', async () => {
  for (const o of [undefined, null, {}, { width: 'big' }, { quality: -1 }]) {
    assert.equal(await cap.capture(o), null);
  }
});

test('⚠️ EVERY CAPTURE GETS ITS OWN FILENAME', () => {
  /*
   * st-bridge.js writes to a fixed `st-capture.jpg`. Two captures in flight — trivially reachable
   * from the remote-control view at one per second, or two operators watching one screen — have one
   * unlinking and rewriting the file the other is about to read. The loser gets ENOENT, or worse
   * the OTHER request's frame: a picture of the right screen at the wrong moment, which looks
   * entirely plausible and is undetectable afterwards.
   */
  const names = new Set();
  for (let i = 0; i < 5000; i++) names.add(cap.captureName(1_700_000_000_000));
  assert.equal(names.size, 5000, 'names collided within a single millisecond');
});

test('a name is a plain jpg basename with no path separators', () => {
  // It is concatenated onto a directory; a separator here would write outside the chosen volume.
  const n = cap.captureName(Date.now());
  assert.match(n, /^st-capture-\d+-\d+\.jpg$/);
  assert.ok(!n.includes('/') && !n.includes('\\'));
});

test('⚠️ RAM is preferred over flash', () => {
  /*
   * The remote-control view drives roughly one capture a second. Writing that to boot flash is a
   * wear-out mechanism with no upside — the file is read back and deleted microseconds later, so it
   * never needs to be durable.
   */
  const dirs = cap.CANDIDATE_DIRS;
  assert.equal(dirs[0], '/storage/tmp');
  assert.ok(dirs.indexOf('/tmp') < dirs.indexOf('/storage/flash'), 'flash must be a last resort');
  assert.ok(dirs.includes('/storage/ssd'));
});

test('pickDir returns null when no candidate exists, rather than guessing one', () => {
  // Writing into a directory that does not exist fails the capture; inventing a path would turn a
  // clear "this platform cannot" into an obscure ENOENT.
  const fakeFs = { existsSync: () => false };
  assert.equal(cap.pickDir(fakeFs), null);
});

test('pickDir survives a filesystem that throws on probe', () => {
  const angryFs = { existsSync: () => { throw new Error('EIO'); } };
  assert.doesNotThrow(() => cap.pickDir(angryFs));
  assert.equal(cap.pickDir(angryFs), null);
});

test('pickDir takes the FIRST existing candidate', () => {
  const fs = { existsSync: (p) => p === '/tmp' || p === '/storage/flash' };
  assert.equal(cap.pickDir(fs), '/tmp', 'RAM must win over flash when both exist');
});
