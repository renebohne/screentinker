'use strict';

/*
 * 3.0: passkeys (WebAuthn) — the parts that are not HTTP: where the relying party lives, the
 * single-use challenge store, and the credential rows. routes/passkeys.js is the HTTP side.
 *
 * ⚠️ VERIFICATION IS NOT DONE HERE. Attestation and assertion checks (CBOR, COSE keys, signature,
 * rpIdHash, flags, origin, counter) are @simplewebauthn/server's job, pinned in package.json. Do not
 * replace a library call with a hand-rolled check because it "only needs one field": every one of
 * those fields is a published bypass in somebody's hand-rolled verifier.
 */

const crypto = require('crypto');
const { db } = require('../db/database');

// A challenge is good for one ceremony, once, for five minutes. Long enough for someone to find
// their phone for a cross-device sign-in; short enough that a leaked one is worthless.
const CHALLENGE_TTL_S = 300;
// Unauthenticated callers can mint challenges (the login page does, on every view, for autofill).
// Rows are swept on every insert; past this many live rows the oldest go first, so a flood of
// option requests from many IPs can grow the table to a fixed size and no further.
const MAX_LIVE_CHALLENGES = 5000;
// Enough for every device someone owns plus spares; bounded so a credential list is never a
// storage sink for a hijacked session.
const MAX_PER_USER = 20;
const NAME_MAX = 64;

const PURPOSES = new Set(['register', 'login', 'mfa']);

/*
 * WHERE IS THE RELYING PARTY?
 *
 * ⚠️ NEVER FROM THE Host HEADER ALONE. The RP ID is the domain a passkey is bound to for ever, and
 * the expected origin is the one thing standing between an assertion and a phishing proxy. Taking
 * either from a header the caller writes would let `Host: evil.example` define both. So:
 *
 *   1. APP_URL, when set — the canonical public address, the same answer emailed links use.
 *   2. Otherwise the request host, but ONLY when the operator listed it in PUBLIC_HOSTS — an
 *      allowlist the operator wrote, so a forged Host can only ever name an address they declared.
 *   3. Otherwise: passkeys are OFF, and the UI says why (to admins: set APP_URL).
 *
 * Unlike lib/public-origin.js there is deliberately NO "self-hosted, trust whatever arrived"
 * fallback and no loopback exception. A reset link built from a bad host fails once; a passkey
 * registered against one is bound to it permanently.
 *
 * WebAuthn also refuses to run outside a secure context and refuses an IP address as an RP ID,
 * so http:// is accepted only for localhost, and a bare IP is refused with its own reason — both
 * would only produce a button that throws in the browser.
 */
function parseOrigin(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return { origin: u.origin, rpID: u.hostname.toLowerCase().replace(/^\[|\]$/g, '') };
  } catch { return null; }
}

function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

function rpConfig(req) {
  const appUrl = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  let parsed = null;
  let source = null;
  if (appUrl) {
    parsed = parseOrigin(appUrl);
    source = 'APP_URL';
    if (!parsed) return { enabled: false, reason: 'bad_app_url' };
  } else {
    const allowed = new Set(String(process.env.PUBLIC_HOSTS || '').split(',')
      .map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter(Boolean));
    const host = String((req && typeof req.get === 'function' && req.get('host')) || '').trim().toLowerCase();
    if (host && allowed.has(host)) {
      parsed = parseOrigin(`${req.protocol === 'https' ? 'https' : 'http'}://${host}`);
      source = 'PUBLIC_HOSTS';
    }
    if (!parsed) return { enabled: false, reason: 'no_public_origin' };
  }
  if (isIpLiteral(parsed.rpID)) return { enabled: false, reason: 'ip_address', origin: parsed.origin };
  const secure = parsed.origin.startsWith('https://') || parsed.rpID === 'localhost';
  if (!secure) return { enabled: false, reason: 'insecure_origin', origin: parsed.origin };
  return { enabled: true, origin: parsed.origin, rpID: parsed.rpID, source };
}

/** The name an authenticator shows next to the passkey: the instance's own brand where it has one. */
function rpName() {
  try {
    const { resolveBranding } = require('./branding');
    const b = resolveBranding(db, {});
    if (b && b.brand_name) return String(b.brand_name).slice(0, 64);
  } catch { /* fall through */ }
  return 'ScreenTinker';
}

// ---------------------------------------------------------------------------------------------
// Challenges: stored server-side, single-use, short-lived.
// ---------------------------------------------------------------------------------------------

function now() { return Math.floor(Date.now() / 1000); }

function sweepChallenges() {
  db.prepare('DELETE FROM webauthn_challenges WHERE expires_at <= ?').run(now());
  const live = db.prepare('SELECT COUNT(*) AS n FROM webauthn_challenges').get().n;
  if (live >= MAX_LIVE_CHALLENGES) {
    db.prepare(`DELETE FROM webauthn_challenges WHERE id IN (
      SELECT id FROM webauthn_challenges ORDER BY expires_at ASC LIMIT ?)`).run(live - MAX_LIVE_CHALLENGES + 1);
  }
}

/**
 * Remember a challenge the library generated. Returns an opaque id the browser hands back with
 * its response; the challenge itself is re-read from here, never from the request.
 */
function storeChallenge({ challenge, purpose, userId = null, userHandle = null, rp }) {
  if (!PURPOSES.has(purpose)) throw new Error('unknown challenge purpose');
  const id = crypto.randomBytes(18).toString('base64url');
  db.transaction(() => {
    sweepChallenges();
    // user_handle: registration only — the handle the browser was given, so the row stored at
    // verify time carries exactly what the authenticator now holds.
    db.prepare(`INSERT INTO webauthn_challenges (id, challenge, purpose, user_id, user_handle, rp_id, origin, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, challenge, purpose, userId, userHandle, rp.rpID, rp.origin, now() + CHALLENGE_TTL_S);
  })();
  return id;
}

/*
 * Take a challenge out of the store. ⚠️ DELETED BEFORE IT IS CHECKED, whatever the outcome: a
 * challenge that survived a failed attempt could be retried against, and one that survived a
 * successful one could be replayed. A response is checked against exactly one challenge, exactly
 * once. Returns null for unknown, spent, expired, wrong-purpose or wrong-user — one answer for all.
 */
function consumeChallenge(id, { purpose, userId = null }) {
  if (typeof id !== 'string' || !id || id.length > 64) return null;
  const row = db.transaction(() => {
    const r = db.prepare('SELECT * FROM webauthn_challenges WHERE id = ?').get(id);
    if (r) db.prepare('DELETE FROM webauthn_challenges WHERE id = ?').run(id);
    return r;
  })();
  if (!row) return null;
  if (row.expires_at <= now()) return null;
  if (row.purpose !== purpose) return null;
  if ((row.user_id || null) !== (userId || null)) return null;
  return row;
}

// ---------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------

// Only what the account's own Settings page needs. The public key is not secret, but it has no
// business in a browser either.
const LIST_COLS = 'id, name, created_at, last_used_at, backed_up, device_type, transports, rp_id';

function listForUser(userId) {
  return db.prepare(`SELECT ${LIST_COLS} FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at ASC`)
    .all(userId)
    .map((r) => ({ ...r, backed_up: !!r.backed_up, transports: safeJsonArray(r.transports) }));
}

function countForUser(userId) {
  try { return db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?').get(userId).n; }
  catch { return 0; }
}

function findByCredentialId(credentialId) {
  if (typeof credentialId !== 'string' || !credentialId || credentialId.length > 1400) return null;
  return db.prepare('SELECT * FROM webauthn_credentials WHERE credential_id = ?').get(credentialId) || null;
}

/** The library's WebAuthnCredential shape for a stored row. */
function toLibraryCredential(row) {
  return {
    id: row.credential_id,
    publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64url')),
    counter: row.counter || 0,
    transports: safeJsonArray(row.transports),
  };
}

/** The descriptor list for excludeCredentials / allowCredentials. */
function descriptorsForUser(userId) {
  return db.prepare('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?').all(userId)
    .map((r) => ({ id: r.credential_id, transports: safeJsonArray(r.transports) }));
}

/*
 * One WebAuthn user handle per account, reused for every passkey it registers. Random bytes, never
 * the email or our user id: the handle is stored on the authenticator and shown to anyone who can
 * read it, and the spec asks for something that identifies nobody.
 */
function userHandleFor(userId) {
  const row = db.prepare('SELECT user_handle FROM webauthn_credentials WHERE user_id = ? LIMIT 1').get(userId);
  if (row && row.user_handle) return Buffer.from(row.user_handle, 'base64url');
  return crypto.randomBytes(32);
}

function cleanName(raw) {
  // Control and bidi-override characters out; the name is shown back in Settings and the audit log.
  const s = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim();
  return s.slice(0, NAME_MAX);
}

function insertCredential({ userId, info, userHandle, name, rpID }) {
  const cred = info.credential;
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO webauthn_credentials
      (id, user_id, credential_id, public_key, counter, transports, user_handle, rp_id, name, aaguid, device_type, backed_up)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, cred.id, Buffer.from(cred.publicKey).toString('base64url'), cred.counter || 0,
      JSON.stringify(Array.isArray(cred.transports) ? cred.transports.slice(0, 8) : []),
      userHandle, rpID, name, info.aaguid || null, info.credentialDeviceType || null, info.credentialBackedUp ? 1 : 0);
  return id;
}

function markUsed(rowId, { newCounter, backedUp }) {
  db.prepare("UPDATE webauthn_credentials SET counter = ?, backed_up = ?, last_used_at = strftime('%s','now') WHERE id = ?")
    .run(Math.max(0, Number(newCounter) || 0), backedUp ? 1 : 0, rowId);
}

function safeJsonArray(s) {
  try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; }
  catch { return []; }
}

module.exports = {
  rpConfig, rpName,
  storeChallenge, consumeChallenge,
  listForUser, countForUser, findByCredentialId, toLibraryCredential, descriptorsForUser,
  userHandleFor, cleanName, insertCredential, markUsed,
  CHALLENGE_TTL_S, MAX_PER_USER, MAX_LIVE_CHALLENGES, NAME_MAX,
};
