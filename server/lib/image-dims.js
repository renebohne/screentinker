'use strict';

/*
 * Image dimensions from the HEADER, without decoding.
 *
 * ⚠️ WHY: image-ops-core decodes to a full RGBA bitmap (4 bytes per pixel) before it can know the
 * size. A 30 KB PNG can declare 50000x50000 — a 10 GB bitmap — so "decode, then look" is a
 * decompression bomb from any upload. This reads what the file DECLARES so the caller can refuse a
 * huge canvas before allocating it. A file that lies smaller than it decodes is the decoder's
 * problem (Jimp/jpeg-js have their own ceilings, and the worker has resourceLimits + a timeout).
 *
 * Returns { width, height } or null when the format is unknown or the header is unreadable; null
 * means "no opinion", and the caller decodes as before.
 */
function headerDims(buf, mime) {
  try {
    if (!buf || buf.length < 24) return null;
    switch (mime) {
      case 'image/png':
        // IHDR is the first chunk: width/height big-endian at 16/20.
        if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      case 'image/gif':
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      case 'image/bmp':
        if (buf.length < 26) return null;
        return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
      case 'image/jpeg':
        return jpegDims(buf);
      case 'image/webp':
        return webpDims(buf);
      case 'image/avif':
        return avifDims(buf);
      default:
        return null;
    }
  } catch (_) {
    return null;
  }
}

// Walk the marker segments to the first SOFn (C0-CF except C4 DHT, C8 JPG, CC DAC).
function jpegDims(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webpDims(buf) {
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8X' && buf.length >= 30) {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  if (chunk === 'VP8L' && buf.length >= 25) {
    const b = buf.readUInt32LE(21);
    return { width: 1 + (b & 0x3fff), height: 1 + ((b >>> 14) & 0x3fff) };
  }
  if (chunk === 'VP8 ' && buf.length >= 30) {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

// 'ispe' (image spatial extent) property boxes; the largest one bounds what will be decoded.
function avifDims(buf) {
  let best = null;
  const end = Math.min(buf.length, 1024 * 1024);
  for (let i = buf.indexOf('ispe', 0, 'latin1'); i !== -1 && i + 16 <= end; i = buf.indexOf('ispe', i + 4, 'latin1')) {
    const width = buf.readUInt32BE(i + 8);
    const height = buf.readUInt32BE(i + 12);
    if (!best || width * height > best.width * best.height) best = { width, height };
  }
  return best;
}

module.exports = { headerDims };
