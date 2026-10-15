'use strict';

/*
 * Inflate one unzipper entry into memory, counting REAL bytes as they come out and stopping at
 * `cap`.
 *
 * ⚠️ NEVER `entry.buffer()` on an archive someone else built. It inflates the whole entry and only
 * then lets anyone look at the size, and the central directory's `uncompressedSize` is a claim the
 * archive's author wrote — a few hundred KB that "claims" 10 bytes can inflate to gigabytes. Callers
 * cap at min(claimed size, their own ceiling), so an entry that lies about its size is caught as
 * soon as it passes the claim.
 *
 * The same pattern lives in lib/plugins/inbox.js and lib/templates/zip.js with their own error
 * types; this is the shared form for new callers (HTML bundles, the instance import).
 *
 * `makeError(kind)` builds the rejection: kind is 'too-large' or 'corrupt'. The default is a plain
 * Error with `code` ZIP_ENTRY_TOO_LARGE / ZIP_ENTRY_CORRUPT.
 */
function inflateCapped(entry, cap, makeError) {
  const mk = makeError || ((kind) => Object.assign(
    new Error(kind === 'too-large' ? `zip entry inflates past ${cap} bytes` : 'zip entry is corrupt'),
    { code: kind === 'too-large' ? 'ZIP_ENTRY_TOO_LARGE' : 'ZIP_ENTRY_CORRUPT' }));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    let done = false;
    const s = entry.stream();
    s.on('data', (c) => {
      if (done) return;
      n += c.length;
      if (n > cap) {
        done = true;
        s.destroy();
        reject(mk('too-large'));
        return;
      }
      chunks.push(c);
    });
    s.on('error', () => { if (!done) { done = true; reject(mk('corrupt')); } });
    s.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks, n)); } });
  });
}

/*
 * Stream one entry to a file, counting real bytes against `cap` (bytes for this entry) and an
 * optional shared `budget` ({ remaining }) for the whole extraction. A partial file is removed on
 * failure.
 */
function inflateToFileCapped(entry, destPath, cap, budget, makeError) {
  const fs = require('fs');
  const mk = makeError || ((kind) => Object.assign(
    new Error(kind === 'too-large' ? 'zip entry inflates past its cap' : 'zip entry is corrupt'),
    { code: kind === 'too-large' ? 'ZIP_ENTRY_TOO_LARGE' : 'ZIP_ENTRY_CORRUPT' }));
  return new Promise((resolve, reject) => {
    let n = 0;
    let done = false;
    const s = entry.stream();
    const out = fs.createWriteStream(destPath, { flags: 'wx' });
    const fail = (err) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch (_) {}
      out.destroy();
      try { fs.rmSync(destPath, { force: true }); } catch (_) {}
      reject(err);
    };
    s.on('data', (c) => {
      n += c.length;
      if (budget) budget.remaining -= c.length;
      if (n > cap || (budget && budget.remaining < 0)) fail(mk('too-large'));
    });
    s.on('error', () => fail(mk('corrupt')));
    out.on('error', (e) => fail(e));
    out.on('finish', () => { if (!done) { done = true; resolve(n); } });
    s.pipe(out);
  });
}

module.exports = { inflateCapped, inflateToFileCapped };
