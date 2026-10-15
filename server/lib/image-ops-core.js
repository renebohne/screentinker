'use strict';

/*
 * Pure-JavaScript image operations — the two things the ingest path ever asked sharp for:
 * measure an image, and write a thumbnail.
 *
 * THIS FILE IS THE WORK, NOT THE ENTRY POINT. Callers use ./image-ops, which runs these on a
 * worker thread; everything here is CPU-bound pure JS that would otherwise stall the event loop
 * for ~1s per 12MP photo. Requiring this module directly is only correct inside the worker (or in
 * image-ops' inline fallback). See ./image-ops for why.
 *
 * WHY NOT SHARP: sharp is a native module wrapping libvips. That costs us a prebuilt binary per
 * platform/ABI, and when there isn't one (or Node moves ABI) the failure is
 * ERR_DLOPEN_FAILED/NODE_MODULE_VERSION at require time — the same class of breakage
 * lib/preflight-deps.js exists to explain for better-sqlite3. Nothing in here is native, so the
 * server runs anywhere Node runs, including the embedded targets that have no toolchain.
 *
 * FORMAT COVERAGE vs the sharp it replaces:
 *   jpeg png gif tiff bmp   Jimp, natively
 *   webp avif               @jsquash/* — WebAssembly, bundled, no network (see wasmDecode below)
 *   svg                     never reaches here; callers thumbnail an SVG with itself
 *   heic                    unsupported — and it already was. sharp lists `heif`, but its
 *                           prebuilt libvips has AV1 only and refuses HEVC ("Unsupported
 *                           compression"), so .heic uploads have never produced a thumbnail.
 *
 * ORIENTATION (#170): Jimp applies EXIF orientation when it decodes and rewrites the tag to 1,
 * so what comes back is already DISPLAY dimensions — the rotation sharp needed an explicit
 * .rotate() for. metadata() therefore reports orientation 1 and lets imageDisplayDims() run as a
 * no-op rather than swapping W/H a second time. Report the tag honestly and that helper stays
 * correct for any future decoder that does NOT auto-orient.
 */

const path = require('path');
const fs = require('fs');
const { sniffMime } = require('./upload-sniff');

// Jimp is ESM-first but ships a CJS entry; require() is fine and keeps this file loadable from
// the CommonJS server. Deferred so a caller that never touches an image never pays for it.
let _jimp = null;
function jimp() {
  if (!_jimp) _jimp = require('jimp');
  return _jimp;
}

/*
 * @jsquash's decoders are browser-first: they locate their .wasm with
 * `fetch(new URL('...wasm', import.meta.url))`. Under Node that URL is a file:// one and Node's
 * fetch does not implement file://, so the bundled binary never loads and the only symptom is a
 * bare "fetch failed". The binary IS on disk in the package — read and compile it ourselves, then
 * hand the Module to init(). No network, at install time or after.
 */
const WASM_CODECS = {
  'image/webp': { pkg: '@jsquash/webp', wasm: '@jsquash/webp/codec/dec/webp_dec.wasm' },
  'image/avif': { pkg: '@jsquash/avif', wasm: '@jsquash/avif/codec/dec/avif_dec.wasm' },
};
const decoderCache = new Map();

async function wasmDecode(mime, buf) {
  const spec = WASM_CODECS[mime];
  if (!spec) return null;
  if (!decoderCache.has(mime)) {
    decoderCache.set(mime, (async () => {
      const mod = await import(`${spec.pkg}/decode.js`);
      await mod.init(await WebAssembly.compile(fs.readFileSync(require.resolve(spec.wasm))));
      return mod.default;
    })());
  }
  const decode = await decoderCache.get(mime);
  return decode(buf);   // -> ImageData-ish { data, width, height }
}

/*
 * ⚠️ REFUSE A HUGE CANVAS BEFORE DECODING IT. Decoding allocates width*height*4 bytes up front, and
 * the header is the uploader's claim: a few-KB PNG declaring 50000x50000 asked for 10 GB. ~50 MP
 * (a 50 MP phone sensor is 8160x6120) is ~200 MB of RGBA, which is already the most a thumbnail
 * should cost. Unknown/unreadable headers fall through to the decoder as before.
 */
const MAX_DECODE_PIXELS = 50 * 1024 * 1024;
function assertDecodableSize(buf, mime) {
  const dims = require('./image-dims').headerDims(buf, mime);
  if (dims && dims.width * dims.height > MAX_DECODE_PIXELS) {
    throw Object.assign(new Error(`image is too large to decode (${dims.width}x${dims.height}, limit ${MAX_DECODE_PIXELS} pixels)`),
      { code: 'IMAGE_TOO_LARGE' });
  }
}

/*
 * Decode to a Jimp image whatever the format. Reuses sniffMime rather than carrying a second copy
 * of the magic-byte table — routes/media.js already duplicating it once is noted there as a smell.
 * Throws on anything undecodable, which is the contract callers already handle (a failure yields
 * null metadata and no thumbnail, never a lost upload).
 */
async function readImage(src) {
  const buf = await fs.promises.readFile(src);
  const mime = sniffMime(buf);
  assertDecodableSize(buf, mime);

  if (WASM_CODECS[mime]) {
    const raw = await wasmDecode(mime, buf);
    if (!raw) throw new Error(`no decoder for ${mime}`);
    return jimp().Jimp.fromBitmap({ data: Buffer.from(raw.data), width: raw.width, height: raw.height });
  }
  return jimp().Jimp.read(buf);
}

/*
 * Display dimensions, shaped like the sharp metadata the callers already destructure.
 * orientation is 1 because the decode above already applied it — see ORIENTATION note at the top.
 */
async function metadata(src) {
  const img = await readImage(src);
  return { width: img.bitmap.width, height: img.bitmap.height, orientation: 1 };
}

/*
 * Resize-and-encode an ALREADY DECODED image. Never upscales: sharp's resize() would enlarge a
 * small source, but a thumbnail bigger than its original is pure waste and callers only shrink.
 * Mutates img, so measure before calling.
 */
async function encodeThumbnail(img, destPath, width, quality) {
  if (img.bitmap.width > width) img.resize({ w: width });
  await fs.promises.writeFile(destPath, await img.getBuffer('image/jpeg', { quality }));
}

/*
 * Write a JPEG thumbnail `width` px wide, aspect preserved — sharp's
 * .rotate().resize(width).jpeg({quality}).toFile(). Rotation is implicit in the decode.
 */
async function writeThumbnail(src, destPath, width, quality = 70) {
  await encodeThumbnail(await readImage(src), destPath, width, quality);
}

/*
 * Measure AND thumbnail from a SINGLE decode — what ingest actually wants.
 *
 * Calling metadata() then writeThumbnail() decodes the file twice. That was free under sharp,
 * whose .metadata() only parses the header, but here every decode is the full ~1s of a 12MP
 * photo, so the naive pairing doubled the most expensive thing the ingest path does.
 *
 * A thumbnail failure must NOT discard the dimensions: they are independently useful (the player
 * needs them to letterbox correctly) and that is how the two-call version behaved, since width and
 * height were already assigned before the thumbnail was written. So the write is reported, not
 * thrown — and the caller assigns a thumbnail_path only when thumbnailWritten is true, keeping the
 * phantom-path discipline that stops the UI requesting a file that was never created.
 * A DECODE failure still throws: there is nothing to report about an unreadable image.
 */
async function measureAndThumbnail(src, destPath, width, quality = 70) {
  const img = await readImage(src);
  const measured = { width: img.bitmap.width, height: img.bitmap.height, orientation: 1 };
  try {
    await encodeThumbnail(img, destPath, width, quality);
    return { ...measured, thumbnailWritten: true, thumbnailError: null };
  } catch (err) {
    return { ...measured, thumbnailWritten: false, thumbnailError: err && err.message ? err.message : String(err) };
  }
}

/*
 * Cut an object off its flat backdrop and write it as a PNG with alpha.
 *
 * ⚠️ ON THE WORKER SIDE FOR THE REASON THIS WHOLE MODULE PAIR EXISTS. Keying is one pass of
 * arithmetic per pixel, and the images this runs on are what an image endpoint returns — 2048x2048
 * is 4.2 million pixels, each costing a square root. That is exactly the shape of main-thread work
 * that produced #240 (blocked loop, missed heartbeats, panels marked offline). It goes where the
 * decoding already goes.
 *
 * ⚠️ PNG, NEVER JPEG. JPEG has no alpha channel at all, so a cut-out saved as one silently gets its
 * transparency composited onto black — an object with a black box around it, which on a slide is
 * worse than not having the feature.
 *
 * Returns what the caller needs to decide whether to trust the result: how flat the backdrop
 * actually was, and how much of the frame survived.
 */
async function cutout(src, destPath, opts = {}) {
  const key = require('./image-key');
  const img = await readImage(src);
  // Work at a bounded size: the object is laid onto a slide element a fraction of a screen wide, so
  // a 2048px cut-out is detail nobody sees, at 4x the pixels to key and to ship to every player.
  const max = opts.maxWidth || 1024;
  if (img.bitmap.width > max) img.resize({ w: max });

  const keyRgb = opts.key || key.sampleKey(img.bitmap);
  const spread = key.backdropSpread(img.bitmap, keyRgb);
  key.keyOut(img.bitmap, keyRgb, opts);

  const bounds = key.contentBounds(img.bitmap);
  if (!bounds) {
    // The key removed everything. Refused rather than written: see image-key.contentBounds.
    return { written: false, reason: 'the backdrop key removed the entire image', keyRgb, spread };
  }
  /*
   * ⚠️ MEASURED AFTER THE CROP, so the numbers describe the asset the caller is about to store
   * rather than the frame it was cut from. Measured before, a sparse subject reads as alarmingly
   * empty purely because it was generated small in a large frame — three leaves came back "15%
   * opaque" pre-crop and 34% post-crop, and the caller would be judging the wrong thing.
   *
   * `frame` is the other half of that: how much of the original frame the object occupied. A tiny
   * value means the generator drew something small in a big empty backdrop, which is worth knowing
   * separately from how solid the object itself is.
   */
  img.crop(bounds);
  const cov = key.coverage(img.bitmap);
  await fs.promises.writeFile(destPath, await img.getBuffer('image/png'));
  return {
    written: true, keyRgb, spread,
    width: img.bitmap.width, height: img.bitmap.height,
    opaque: cov.opaque, feathered: cov.feathered,
    frame: (bounds.w * bounds.h) / (max * max || 1),
  };
}

/*
 * Screen verification (lib/screen-verify): the handful of numbers that describe what a captured
 * frame looks like. `src` is a file path (a content thumbnail used as the reference) or the raw
 * bytes of a screenshot as the player sent it. ON THE WORKER SIDE for the same reason as cutout:
 * a 1080p capture is two million pixels of arithmetic, and screenshots arrive continuously while
 * anyone has the dashboard open.
 *
 * ⚠️ The bytes are the PLAYER'S, so they get the same header-size refusal as an upload: the 2MB
 * cap on a screenshot bounds the compressed size, not what a PNG header claims it decodes to.
 * Only JPEG and PNG are accepted from a player; every player sends one or the other.
 */
const FRAME_MAX_PIXELS = 3840 * 2160;
async function frameMetrics(src) {
  let img;
  if (typeof src === 'string') {
    img = await readImage(src);
  } else {
    const buf = Buffer.from(src);
    const mime = sniffMime(buf);
    if (mime !== 'image/jpeg' && mime !== 'image/png') throw new Error(`unsupported frame type ${mime || 'unknown'}`);
    const dims = require('./image-dims').headerDims(buf, mime);
    if (dims && dims.width * dims.height > FRAME_MAX_PIXELS) throw new Error('frame is too large to analyse');
    img = await jimp().Jimp.read(buf);
  }
  return require('./screen-verify/frame-metrics').metricsFromBitmap(img.bitmap);
}

/*
 * 3.0 accessibility (lib/a11y): the WCAG relative luminance of a photo, as a small grid of cells.
 *
 * Text over a photo can only be checked against what is under it, and the checker needs that for
 * arbitrary rectangles (every text box on every slide that uses the photo). A grid computed once per
 * image and cached answers all of them without decoding again. 64 cells across keeps a headline's
 * box several cells tall on any normal photo, and the grid keeps the image's aspect so the checker
 * can reproduce `background-size: cover` cropping. Area-averaged (resize), so a cell is the mean of
 * the pixels it stands for, not one sampled pixel.
 */
async function luminanceGrid(src, cols = 64) {
  const img = await readImage(src);
  const { width, height } = img.bitmap;
  const w = Math.max(1, Math.min(cols, width));
  const h = Math.max(1, Math.min(64, Math.round((height / width) * w)));
  img.resize({ w, h });
  const d = img.bitmap.data;
  const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = new Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const o = p * 4;
    const a = d[o + 3] / 255;
    // A transparent pixel shows whatever is under the photo, which is not known here; it is read as
    // its own colour at its alpha over black. Photos used as backgrounds are almost always opaque.
    lum[p] = Math.round(a * (0.2126 * lin(d[o]) + 0.7152 * lin(d[o + 1]) + 0.0722 * lin(d[o + 2])) * 1000) / 1000;
  }
  return { w, h, lum, width, height };
}

module.exports = { metadata, writeThumbnail, measureAndThumbnail, readImage, cutout, frameMetrics, luminanceGrid, MAX_DECODE_PIXELS };
