'use strict';

// 3.0 passkeys: the decisions in lib/passkeys.js that do not need a server — where the relying
// party lives (never a forged Host) and the challenge store (single-use, expiring, bound).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const mem = new Database(':memory:');
mem.exec(`CREATE TABLE webauthn_challenges (id TEXT PRIMARY KEY, challenge TEXT NOT NULL, purpose TEXT NOT NULL,
  user_id TEXT, user_handle TEXT, rp_id TEXT NOT NULL, origin TEXT NOT NULL, expires_at INTEGER NOT NULL)`);
require.cache[require.resolve('../db/database')] = {
  id: require.resolve('../db/database'), loaded: true, exports: { db: mem },
};
const passkeys = require('../lib/passkeys');

const req = (host, protocol = 'https') => ({ protocol, get: (h) => (h.toLowerCase() === 'host' ? host : undefined) });

function withEnv(env, fn) {
  const saved = { APP_URL: process.env.APP_URL, PUBLIC_HOSTS: process.env.PUBLIC_HOSTS };
  for (const [k, v] of Object.entries(env)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
}

test('APP_URL is the relying party, whatever Host the request carries', () => {
  withEnv({ APP_URL: 'https://signage.example.com/', PUBLIC_HOSTS: null }, () => {
    const rp = passkeys.rpConfig(req('evil.example'));
    assert.equal(rp.enabled, true);
    assert.equal(rp.rpID, 'signage.example.com');
    assert.equal(rp.origin, 'https://signage.example.com');
  });
});

test('⚠️ no APP_URL: a Host header alone NEVER enables passkeys — not even on a self-hosted box or loopback', () => {
  for (const host of ['signage.example.com', 'evil.example', 'localhost:3000', '127.0.0.1:3000']) {
    withEnv({ APP_URL: null, PUBLIC_HOSTS: null }, () => {
      const rp = passkeys.rpConfig(req(host));
      assert.equal(rp.enabled, false, host);
      assert.equal(rp.reason, 'no_public_origin');
      assert.equal(rp.rpID, undefined);
    });
  }
});

test('no APP_URL: a host the operator listed in PUBLIC_HOSTS is accepted, and only that one', () => {
  withEnv({ APP_URL: null, PUBLIC_HOSTS: 'signage.example.com, https://other.example.org/' }, () => {
    assert.equal(passkeys.rpConfig(req('signage.example.com')).rpID, 'signage.example.com');
    assert.equal(passkeys.rpConfig(req('OTHER.example.org')).origin, 'https://other.example.org');
    assert.equal(passkeys.rpConfig(req('evil.example')).enabled, false);
  });
});

test('addresses WebAuthn itself would refuse are reported, not offered', () => {
  withEnv({ APP_URL: 'http://signage.example.com', PUBLIC_HOSTS: null }, () => {
    assert.equal(passkeys.rpConfig(req('x')).reason, 'insecure_origin', 'plain http off localhost');
  });
  withEnv({ APP_URL: 'https://192.168.1.20:3001', PUBLIC_HOSTS: null }, () => {
    assert.equal(passkeys.rpConfig(req('x')).reason, 'ip_address', 'an IP cannot be an RP ID');
  });
  withEnv({ APP_URL: 'http://localhost:3001', PUBLIC_HOSTS: null }, () => {
    const rp = passkeys.rpConfig(req('x'));
    assert.equal(rp.enabled, true, 'localhost is a secure context');
    assert.equal(rp.origin, 'http://localhost:3001');
  });
  withEnv({ APP_URL: 'not a url', PUBLIC_HOSTS: null }, () => {
    assert.equal(passkeys.rpConfig(req('x')).reason, 'bad_app_url');
  });
});

const RP = { rpID: 'signage.example.com', origin: 'https://signage.example.com' };
beforeEach(() => mem.exec('DELETE FROM webauthn_challenges'));

test('a challenge is single-use, whatever the outcome', () => {
  const id = passkeys.storeChallenge({ challenge: 'c1', purpose: 'login', rp: RP });
  assert.equal(passkeys.consumeChallenge(id, { purpose: 'login' }).challenge, 'c1');
  assert.equal(passkeys.consumeChallenge(id, { purpose: 'login' }), null, 'second use');
  // A wrong-purpose attempt spends it too, so it cannot be retried with the right one.
  const id2 = passkeys.storeChallenge({ challenge: 'c2', purpose: 'login', rp: RP });
  assert.equal(passkeys.consumeChallenge(id2, { purpose: 'mfa' }), null);
  assert.equal(passkeys.consumeChallenge(id2, { purpose: 'login' }), null);
});

test('a challenge is bound to its purpose and its account, and expires', () => {
  const reg = passkeys.storeChallenge({ challenge: 'r', purpose: 'register', userId: 'alice', rp: RP });
  assert.equal(passkeys.consumeChallenge(reg, { purpose: 'register', userId: 'bob' }), null);
  const mfa = passkeys.storeChallenge({ challenge: 'm', purpose: 'mfa', userId: 'alice', rp: RP });
  assert.equal(passkeys.consumeChallenge(mfa, { purpose: 'mfa' }), null, 'an account-bound challenge needs that account');
  const old = passkeys.storeChallenge({ challenge: 'o', purpose: 'login', rp: RP });
  mem.prepare('UPDATE webauthn_challenges SET expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 1, old);
  assert.equal(passkeys.consumeChallenge(old, { purpose: 'login' }), null);
  for (const junk of [undefined, null, '', 42, {}, 'x'.repeat(65)]) {
    assert.equal(passkeys.consumeChallenge(junk, { purpose: 'login' }), null);
  }
  assert.throws(() => passkeys.storeChallenge({ challenge: 'z', purpose: 'other', rp: RP }));
});

test('unauthenticated option requests cannot grow the store without bound', () => {
  const insert = mem.prepare('INSERT INTO webauthn_challenges (id, challenge, purpose, rp_id, origin, expires_at) VALUES (?, ?, ?, ?, ?, ?)');
  const far = Math.floor(Date.now() / 1000) + 300;
  mem.transaction(() => { for (let i = 0; i < passkeys.MAX_LIVE_CHALLENGES + 50; i++) insert.run('k' + i, 'c', 'login', 'x', 'y', far); })();
  passkeys.storeChallenge({ challenge: 'new', purpose: 'login', rp: RP });
  const n = mem.prepare('SELECT COUNT(*) AS n FROM webauthn_challenges').get().n;
  assert.ok(n <= passkeys.MAX_LIVE_CHALLENGES, `capped at ${passkeys.MAX_LIVE_CHALLENGES}, have ${n}`);
});

test('passkey names are cleaned before they are stored or shown', () => {
  assert.equal(passkeys.cleanName('  Work laptop  '), 'Work laptop');
  assert.equal(passkeys.cleanName('a‮b\u0000c'), 'abc');
  assert.equal(passkeys.cleanName('x'.repeat(200)).length, passkeys.NAME_MAX);
  assert.equal(passkeys.cleanName(null), '');
});

test('verification is the pinned library\'s job, not hand-rolled', () => {
  const pkg = require('../package.json');
  assert.match(pkg.dependencies['@simplewebauthn/server'], /^\d+\.\d+\.\d+$/, 'pinned to an exact version');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'passkeys.js'), 'utf8');
  assert.match(src, /verifyRegistrationResponse\(/);
  assert.match(src, /verifyAuthenticationResponse\(/);
  assert.doesNotMatch(src, /createVerify|crypto\.verify|subtle\.verify/, 'no signature checks of our own');
});
