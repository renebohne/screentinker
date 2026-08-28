'use strict';

// Uploaded files are served from the SAME ORIGIN as the dashboard, so the extension they
// land on disk with decides how a browser will interpret them. That decision must come
// from the file's CONTENT, never from the caller.
//
// Previously multer named the file `<uuid><path.extname(originalname)>` — a caller-chosen
// extension — while the only type check read `file.mimetype`, a caller-supplied header.
// A caller could therefore choose to have their bytes served as text/html or
// application/javascript from the app origin.
//
// multer's diskStorage picks the filename BEFORE any bytes are written, so the sniff
// cannot happen there. Instead multer writes a neutral `<uuid>.part` and finalizeUpload()
// below sniffs the written file, renames it to a content-derived extension, and reports
// the content-derived mime. Both ingest paths (lib/content-ingest.js and the /replace
// route) call this one function so they cannot drift.

const fs = require('fs');
const path = require('path');

// The ONLY extensions an upload may land on. Keyed by the mime the sniffer reports.
// Anything not here is refused — an allowlist, so a new container format is a deliberate
// addition rather than something that slips through.
const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/ogg': '.ogv',
  'video/x-msvideo': '.avi',
  'video/quicktime': '.mov',
  /*
   * ⚠️ A ZIP LANDS ON `.zip` AND STAYS OUT OF INLINE_SAFE_EXTS, WHICH IS THE WHOLE POINT.
   *
   * An HTML bundle (a .wgt or a plain .zip of index.html + assets) is stored as an ordinary content
   * row and shipped to players as opaque bytes. Served from this origin it must therefore be
   * application/octet-stream + attachment, which is exactly what hardenUploadResponse does for
   * anything not in that set. A `.wgt` extension would buy nothing — both answers are identical —
   * and would double the surface this map exists to keep small, so the flavour is recorded in
   * lib/html-bundle.js's metadata instead of in the type.
   *
   * The magic bytes can only say "this is a zip". Whether it is a BUNDLE is a question about the
   * central directory, and lib/html-bundle.js answers it in a second stage.
   */
  'application/zip': '.zip',
};

// Extensions served INLINE with their real media type. Anything outside this set is
// forced to download as opaque bytes.
//
// SVG is included DELIBERATELY. It has to be: white-label branding stores logos as SVG,
// and serving them as application/octet-stream with nosniff makes <img> fail to render.
// It is safe here because scripts inside an SVG never execute in an <img>/image context,
// and the `Content-Security-Policy: sandbox` the serving layer adds neutralises the only
// case where they would — a direct navigation, which is a document. So the logo renders
// and the script does not run. Dropping SVG from this set silently breaks white-label.
const INLINE_SAFE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.avif', '.heic', '.jfif', '.svg',
  '.mp4', '.webm', '.ogv', '.avi', '.mov', '.mkv', '.vtt',
]);

const SNIFF_BYTES = 4096; // enough for every magic below, plus a leading XML prolog

// Return a mime string from magic bytes, or null when nothing matches.
// Mirrors routes/media.js sniffMedia (same magic set) and adds the containers this
// product actually accepts on upload.
function sniffMime(buf) {
  if (!buf || buf.length < 4) return null;
  const b = buf;
  const a4 = b.toString('latin1', 0, 4);

  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (a4 === 'GIF8') return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (a4 === 'RIFF' && b.length >= 12) {
    const kind = b.toString('latin1', 8, 12);
    if (kind === 'WEBP') return 'image/webp';
    if (kind === 'AVI ') return 'video/x-msvideo';
  }
  // ISO-BMFF: '....ftyp<brand>' — mp4 / mov / avif / heic all share this container.
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') {
    const brand = b.toString('latin1', 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'image/heic';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  // Zip container: `PK\x03\x04` is a local file header. `PK\x05\x06` (empty archive) and
  // `PK\x07\x08` (spanned) are deliberately NOT accepted — neither can be a bundle.
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'application/zip';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm'; // EBML (webm/mkv)
  if (a4 === 'OggS') return 'video/ogg';

  // SVG has no magic number — it is XML. Accept only when the document really opens with
  // an XML prolog or an <svg> root, so arbitrary text/HTML cannot masquerade as one.
  const head = b.toString('utf8', 0, Math.min(b.length, 1024)).replace(/^﻿/, '').trimStart();
  if (/^<\?xml[\s>]/i.test(head) || /^<!DOCTYPE\s+svg/i.test(head)) {
    if (/<svg[\s>]/i.test(b.toString('utf8', 0, Math.min(b.length, SNIFF_BYTES)))) return 'image/svg+xml';
    return null;
  }
  if (/^<svg[\s>]/i.test(head)) return 'image/svg+xml';

  return null;
}

function readHead(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const n = fs.readSync(fd, buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

class UnsupportedUploadError extends Error {
  constructor(msg) { super(msg); this.name = 'UnsupportedUploadError'; this.status = 400; }
}

// Sniff a multer-written temp file, rename it to a content-derived name, and report what
// it actually is. Throws UnsupportedUploadError (and removes the file) when the bytes are
// not a supported media type — the caller maps that to a 400.
//
// Returns { filepath, mime, ext } where filepath is the basename now on disk.
function finalizeUpload(file) {
  const mime = (() => {
    try { return sniffMime(readHead(file.path)); } catch { return null; }
  })();
  const ext = mime ? MIME_TO_EXT[mime] : null;
  if (!mime || !ext) {
    try { fs.unlinkSync(file.path); } catch { /* best effort */ }
    throw new UnsupportedUploadError('Unsupported file type — only image and video files are accepted');
  }
  // `<uuid>.part` -> `<uuid><ext>`; keep the uuid multer already generated.
  const base = path.basename(file.path).replace(/\.part$/i, '');
  const finalName = base + ext;
  const finalPath = path.join(path.dirname(file.path), finalName);
  fs.renameSync(file.path, finalPath);
  // Keep the multer object consistent for any downstream reader.
  file.path = finalPath;
  file.filename = finalName;
  file.mimetype = mime;
  return { filepath: finalName, mime, ext };
}

module.exports = {
  finalizeUpload, sniffMime, UnsupportedUploadError,
  MIME_TO_EXT, INLINE_SAFE_EXTS, SNIFF_BYTES,
};
