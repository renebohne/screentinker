'use strict';

// Image decoding is pure JavaScript now (no native sharp), so its CPU cost lands on whichever
// thread runs it — ~1s of solid work for a 12MP photo. In-process that is a stalled event loop:
// no heartbeats, no socket traffic, panels marked offline, reconnect churn — #240 arriving from
// our own thumbnail backfill. lib/image-ops therefore hosts the work on a worker thread, and
// these bites pin the properties that makes it safe, none of which a functional test would catch.

const { test, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');            // devDependency: fixture generator only, never shipped
const imageOps = require('../lib/image-ops');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'image-ops-'));
after(async () => { await imageOps.shutdown(); fs.rmSync(tmp, { recursive: true, force: true }); });

// 12MP — a phone photo, and the size the thresholds below are calibrated against. Smaller is
// tempting for test speed but defeats the point: at 4MP the inline path stalls only ~350ms, which
// slips under any threshold loose enough not to be flaky, so the guard stops detecting the very
// regression it exists for. Measured: inline ~1000ms stall / ~2 timers serviced, worker ~0ms / ~90.
async function bigPhoto(name = 'big.jpg') {
  const p = path.join(tmp, name);
  if (!fs.existsSync(p)) {
    // Random pixels, not a flat fill: a solid colour compresses to almost nothing and decodes far
    // faster than any real photo, which would quietly defeat the timing assertion below.
    const px = Buffer.allocUnsafe(4000 * 3000 * 3);
    for (let i = 0; i < px.length; i++) px[i] = (i * 2654435761) & 0xff;
    fs.writeFileSync(p, await sharp(px, { raw: { width: 4000, height: 3000, channels: 3 } }).jpeg().toBuffer());
  }
  return p;
}

test('image work does not stall the event loop (#240)', async () => {
  const src = await bigPhoto();

  let ticks = 0, worstGap = 0, last = Date.now();
  const timer = setInterval(() => { ticks++; worstGap = Math.max(worstGap, Date.now() - last - 10); last = Date.now(); }, 10);
  const started = Date.now();
  await imageOps.writeThumbnail(src, path.join(tmp, 'thumb.jpg'), 320, 70);
  const elapsed = Date.now() - started;
  clearInterval(timer);

  // The point is not that it was fast — it is that the loop kept running while it was slow.
  // Thresholds sit in the gap between the two behaviours (worker ~90 ticks / ~0ms stall, inline
  // ~2 ticks / ~1000ms stall), far enough from both to bite without being flaky.
  assert.ok(ticks >= 20, `event loop serviced only ${ticks} timers in ${elapsed}ms — it is being blocked`);
  assert.ok(worstGap < 200, `event loop stalled ${worstGap}ms in one go — image work is on the main thread`);
  assert.ok(fs.existsSync(path.join(tmp, 'thumb.jpg')), 'thumbnail was still written');
});

test('an undecodable image rejects without killing the worker', async () => {
  const bad = path.join(tmp, 'corrupt.jpg');
  fs.writeFileSync(bad, Buffer.from('not an image'));
  await assert.rejects(() => imageOps.metadata(bad), 'corrupt input must reject, so ingest records nulls');

  // Crash isolation: one bad upload must not take out the queued work of unrelated callers.
  const ok = path.join(tmp, 'fine.png');
  fs.writeFileSync(ok, await sharp({ create: { width: 40, height: 25, channels: 3, background: '#123456' } }).png().toBuffer());
  assert.deepEqual(await imageOps.metadata(ok), { width: 40, height: 25, orientation: 1 });
});

test('concurrent callers are serialized, and each still gets its own answer', async () => {
  // Serialization bounds peak memory to ONE decoded bitmap (a 12MP photo is ~48MB of RGBA);
  // overlapping jobs would multiply that by the queue depth on exactly the small targets this
  // change exists to reach. Correctness under concurrency is what is asserted here.
  const sizes = [[30, 10], [60, 20], [90, 30], [120, 40]];
  const files = await Promise.all(sizes.map(async ([w, h], i) => {
    const p = path.join(tmp, `c${i}.png`);
    fs.writeFileSync(p, await sharp({ create: { width: w, height: h, channels: 3, background: '#0a0' } }).png().toBuffer());
    return p;
  }));
  const got = await Promise.all(files.map(f => imageOps.metadata(f)));
  assert.deepEqual(got.map(m => [m.width, m.height]), sizes, 'replies must not be crossed between queued jobs');
});

test('measureAndThumbnail decodes the file exactly once', async () => {
  // Counted, not timed: a wall-clock comparison against metadata()+writeThumbnail() would be
  // flaky under load, and this is an exact property. Asserted against image-ops-core directly
  // because the decode happens on the worker thread, out of reach of a spy set up here.
  // readImage() is the only reader in core, so readFile calls == decodes.
  const core = require('../lib/image-ops-core');
  const fsp = require('node:fs/promises');
  const src = path.join(tmp, 'once.png');
  fs.writeFileSync(src, await sharp({ create: { width: 200, height: 80, channels: 3, background: '#246' } }).png().toBuffer());

  const spy = mock.method(fsp, 'readFile');
  // Count reads OF THIS FILE only. Node's ESM loader also reads through fs.promises.readFile, so
  // a raw call count picks up jimp's and the WASM codecs' lazy module loading on first use.
  const decodes = () => spy.mock.calls.filter(c => String(c.arguments[0]) === src).length;
  try {
    const r = await core.measureAndThumbnail(src, path.join(tmp, 'once-thumb.jpg'), 100, 70);
    assert.equal(decodes(), 1, 'combined op must decode once, not once per answer');
    assert.deepEqual([r.width, r.height], [200, 80]);
    assert.equal(r.thumbnailWritten, true);

    // The pairing it replaces, for contrast — this is the cost being removed.
    spy.mock.resetCalls();
    await core.metadata(src);
    await core.writeThumbnail(src, path.join(tmp, 'twice-thumb.jpg'), 100, 70);
    assert.equal(decodes(), 2, 'the separate calls are what cost two decodes');
  } finally { spy.mock.restore(); }
});

test('a thumbnail that cannot be written still yields dimensions', async () => {
  // Dimensions are independently useful — the player needs them to letterbox — and the two-call
  // version kept them, because width/height were assigned before the thumbnail was attempted.
  // Merging the calls must not quietly turn a thumbnail failure into a total metadata failure.
  const src = path.join(tmp, 'ok.png');
  fs.writeFileSync(src, await sharp({ create: { width: 150, height: 60, channels: 3, background: '#654' } }).png().toBuffer());

  const undirectable = path.join(tmp, 'no-such-dir', 'thumb.jpg');   // parent does not exist
  const r = await imageOps.measureAndThumbnail(src, undirectable, 100, 70);
  assert.deepEqual([r.width, r.height], [150, 60], 'dimensions survive a thumbnail write failure');
  assert.equal(r.thumbnailWritten, false);
  assert.match(r.thumbnailError || '', /ENOENT|no such file/i);
});

test('#170 EXIF orientation is applied by the decoder, so dimensions are as DISPLAYED', async () => {
  // orientation 6 = "rotate 90° CW to display": a 30x100 stored buffer DISPLAYS as 100x30.
  const p = path.join(tmp, 'rot6.jpg');
  fs.writeFileSync(p, await sharp({ create: { width: 30, height: 100, channels: 3, background: '#00ff00' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer());

  const meta = await imageOps.metadata(p);
  assert.equal(meta.width, 100, 'EXIF-rotated image measures as displayed, not as stored');
  assert.equal(meta.height, 30);
  // Reported as 1 because the rotation is already applied — imageDisplayDims() must NOT swap again.
  assert.equal(meta.orientation, 1, 'a tag of 6 here would double-rotate downstream');
});

/* ---------------------------------------------------- decompression bombs / runaway jobs */

test('header dimensions are read without decoding (PNG, JPEG, WebP, GIF)', async () => {
  const { headerDims } = require('../lib/image-dims');
  const { sniffMime } = require('../lib/upload-sniff');
  const raw = Buffer.alloc(37 * 23 * 3, 0x80);
  for (const fmt of ['png', 'jpeg', 'webp', 'gif']) {
    const buf = await sharp(raw, { raw: { width: 37, height: 23, channels: 3 } }).toFormat(fmt).toBuffer();
    assert.deepEqual(headerDims(buf, sniffMime(buf)), { width: 37, height: 23 }, fmt);
  }
  // lossless WebP is the VP8L header, a different bit layout
  const lossless = await sharp(raw, { raw: { width: 37, height: 23, channels: 3 } }).webp({ lossless: true }).toBuffer();
  assert.deepEqual(headerDims(lossless, 'image/webp'), { width: 37, height: 23 });
  assert.equal(headerDims(Buffer.from('nope'), 'image/png'), null, 'unreadable header: no opinion');
});

test('a tiny file DECLARING a huge canvas is refused before decode', async () => {
  // A valid PNG signature + IHDR claiming 60000x60000 (14 GB of RGBA); the rest is junk.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(60000, 0); ihdr.writeUInt32BE(60000, 4); ihdr[8] = 8; ihdr[9] = 6;
  const len = Buffer.alloc(4); len.writeUInt32BE(13);
  const bomb = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), len, Buffer.from('IHDR'), ihdr, Buffer.alloc(64)]);
  const p = path.join(tmp, 'bomb.png');
  fs.writeFileSync(p, bomb);
  await assert.rejects(() => imageOps.metadata(p), /too large to decode/);

  // JPEG SOF0 claiming 65000x65000
  const sof = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0xfd, 0xe8, 0xfd, 0xe8, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9, 0, 0, 0]);
  const pj = path.join(tmp, 'bomb.jpg');
  fs.writeFileSync(pj, sof);
  await assert.rejects(() => imageOps.metadata(pj), /too large to decode/);

  // A normal image still measures.
  const ok = path.join(tmp, 'after-bomb.png');
  fs.writeFileSync(ok, await sharp({ create: { width: 9, height: 7, channels: 3, background: '#123456' } }).png().toBuffer());
  assert.deepEqual(await imageOps.metadata(ok), { width: 9, height: 7, orientation: 1 });
});

test('a job past the per-job timeout is rejected, the worker replaced, and the next job runs', async () => {
  const src = await bigPhoto();
  const prev = imageOps._setJobTimeoutMs(1);
  try {
    await assert.rejects(() => imageOps.writeThumbnail(src, path.join(tmp, 'slow.jpg'), 320, 70), /timed out/);
  } finally {
    imageOps._setJobTimeoutMs(prev);
  }
  const ok = path.join(tmp, 'after-timeout.png');
  fs.writeFileSync(ok, await sharp({ create: { width: 5, height: 4, channels: 3, background: '#000' } }).png().toBuffer());
  assert.deepEqual(await imageOps.metadata(ok), { width: 5, height: 4, orientation: 1 });
});
