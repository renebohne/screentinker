'use strict';

/*
 * Site cache (docs/site-cache.md): the token a SCREEN shows the cache box on its LAN.
 *
 * ⚠️ SHARED BY BOTH ENDS, AND DEPENDENCY-FREE ON PURPOSE. The origin mints these into a capable
 * player's payload; the cache node (lib/site-cache/node.js) verifies them. The node runs on a Pi with
 * a bare checkout and no `npm install`, so this file may require Node built-ins only — never config,
 * never the database.
 *
 * WHY AN HMAC AND NOT A LOOKUP. The cache has to answer a screen while the WAN is down, which is half
 * of the reason it exists. It cannot ask the origin "is this token good?" per request, so the origin
 * and the node share a per-cache key (`fetch_key`, sealed at rest on the origin) and the node checks
 * the signature itself. The token names the device it was minted for, and the node serves that
 * device only the digests the origin's manifest says that device's own payload references — so a
 * token is not "access to the cache", it is "access to what this one screen already plays".
 *
 * Shape: stc1.<cacheId>.<deviceId>.<exp>.<sig>, sig = base64url(HMAC-SHA256(key, "stc1|cache|device|exp")).
 * Ids are uuid-shaped; anything that is not [A-Za-z0-9_-] is refused rather than escaped, so the
 * dot-separated form can never be ambiguous.
 */

const crypto = require('node:crypto');

const PREFIX = 'stc1';
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

function isSha256(s) { return typeof s === 'string' && SHA_RE.test(s); }

function sign(key, cacheId, deviceId, exp) {
  return crypto.createHmac('sha256', Buffer.from(String(key), 'utf8'))
    .update(`${PREFIX}|${cacheId}|${deviceId}|${exp}`)
    .digest('base64url');
}

/** @returns {string} a token, or throws on ids that could not round-trip. */
function mintPlayerToken(key, { cacheId, deviceId, exp }) {
  if (!key) throw new Error('a site cache token needs a key');
  if (!ID_RE.test(String(cacheId)) || !ID_RE.test(String(deviceId))) throw new Error('unexpected id shape');
  const e = Math.floor(Number(exp));
  if (!(e > 0)) throw new Error('a site cache token needs an expiry');
  return `${PREFIX}.${cacheId}.${deviceId}.${e}.${sign(key, cacheId, deviceId, e)}`;
}

/**
 * @returns {{deviceId: string, exp: number}|null} null for anything not minted by `key` for `cacheId`,
 * or past its expiry. Never throws: this is on the request path of a box nobody is watching.
 */
function verifyPlayerToken(key, token, { cacheId, nowSec } = {}) {
  if (!key || typeof token !== 'string' || token.length > 400) return null;
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== PREFIX) return null;
  const [, cid, did, expRaw, sig] = parts;
  if (!ID_RE.test(cid) || !ID_RE.test(did) || !/^\d{1,12}$/.test(expRaw)) return null;
  if (cacheId && cid !== cacheId) return null;
  const exp = Number(expRaw);
  const now = nowSec == null ? Math.floor(Date.now() / 1000) : nowSec;
  if (exp < now) return null;
  const want = Buffer.from(sign(key, cid, did, exp));
  const got = Buffer.from(String(sig));
  // Length first: timingSafeEqual throws on a mismatch, and a thrown error here is a 500, not a 401.
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  return { deviceId: did, exp };
}

/** sha256 hex of a string — how the node's enrolment token is stored on the origin. */
function hashSecret(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

module.exports = { mintPlayerToken, verifyPlayerToken, isSha256, hashSecret, ID_RE };
