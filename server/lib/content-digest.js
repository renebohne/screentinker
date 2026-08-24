'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

/*
 * sha256 of a content file's bytes.
 *
 * ⚠️ STREAMED, NEVER readFileSync. These files go to 500 MB (config.maxFileSize) and this process
 * also answers every player's heartbeat. Reading one into memory to hash it is the same mistake as
 * a synchronous ffprobe on the request path — it blocks everything for the duration and the symptom
 * is panels going offline, which nobody connects back to a hash.
 *
 * Measured on a modern x86 with SHA-NI: ~600 MB/s from page cache, so a 500 MB file is about a
 * second. On a Pi or a small VPS without SHA extensions, budget 150–400 MB/s; on BrightSign,
 * 50–150 MB/s — i.e. 4–10 seconds for one large file. That number is the whole reason hashing is
 * lazy and off the boot path.
 */

/** @returns {Promise<string|null>} hex digest, or null if the file cannot be read. */
function digestFile(absPath) {
  return new Promise((resolve) => {
    let stream;
    try {
      stream = fs.createReadStream(absPath);
    } catch (e) { return resolve(null); }
    const hash = crypto.createHash('sha256');
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', () => resolve(null));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * The filepath a pushed asset lands on: content-addressed.
 *
 * ⚠️ THIS IS WHAT KEEPS AN UNCHANGED RE-PUSH FREE. `filepath` is inside the player's structural
 * fingerprint, and the ordinary upload path names files `${uuidv4()}${ext}` — so ingesting a pushed
 * file through it would mint a new name every time and restart every screen on the site, nightly,
 * for a file that never changed.
 *
 * Naming by digest gives all three properties at once:
 *   - identical bytes produce an identical name, so the fingerprint does not move
 *   - genuinely different bytes produce a different name, so the restart happens when it should
 *   - a 64-hex basename cannot collide with a locally-uploaded 36-char UUID basename
 *
 * ⚠️ The extension still comes from sniffing the bytes we received, never from the peer. "The
 * extension they land on disk with decides how a browser will interpret them" — that decision comes
 * from content, and a peer node is just another caller.
 */
function digestFilename(digest, sniffedExt) {
  if (!digest || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('a content-addressed name needs a sha256');
  const ext = String(sniffedExt || '').startsWith('.') ? sniffedExt : `.${sniffedExt || 'bin'}`;
  return `${digest}${ext}`;
}

/** Is this name one we generated from a digest? Used to tell pushed assets from local uploads. */
function isDigestName(filepath) {
  return /^[0-9a-f]{64}\.[A-Za-z0-9]+$/.test(path.basename(String(filepath || '')));
}

module.exports = { digestFile, digestFilename, isDigestName };
