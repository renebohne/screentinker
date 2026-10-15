'use strict';

/*
 * config.js JWT secret handling (in a child process each, so env and require cache stay clean):
 *  - a generated certs/.jwt_secret is written 0600, and an existing world-readable one (2.x wrote
 *    it with the default umask) is tightened to 0600 at boot;
 *  - the compose example's placeholder is REFUSED under NODE_ENV=production and warned about
 *    otherwise; a short env secret is warned about but still used (in-place upgrades keep booting).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const serverDir = path.join(__dirname, '..');
function load(env) {
  const full = { ...process.env, ...env };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete full[k];
  return spawnSync(process.execPath, ['-e', "const c = require('./config'); process.stdout.write('LEN=' + c.jwtSecret.length)"], { cwd: serverDir, env: full, encoding: 'utf8' });
}
const posix = process.platform !== 'win32';

test('a generated secret file is 0600', { skip: !posix }, () => {
  const certs = fs.mkdtempSync(path.join(os.tmpdir(), 'st-jwt-'));
  const r = load({ JWT_SECRET: undefined, CERTS_DIR: certs });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.statSync(path.join(certs, '.jwt_secret')).mode & 0o777, 0o600);
  fs.rmSync(certs, { recursive: true, force: true });
});

test('an existing world-readable secret file is tightened to 0600 and still used', { skip: !posix }, () => {
  const certs = fs.mkdtempSync(path.join(os.tmpdir(), 'st-jwt-'));
  const f = path.join(certs, '.jwt_secret');
  fs.writeFileSync(f, 'x'.repeat(40));
  fs.chmodSync(f, 0o644);
  const r = load({ JWT_SECRET: undefined, CERTS_DIR: certs });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /LEN=40/, 'the same secret: nobody is signed out');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  fs.rmSync(certs, { recursive: true, force: true });
});

test('the documented placeholder is refused in production, warned about elsewhere', () => {
  const prod = load({ JWT_SECRET: 'set-a-long-random-string', NODE_ENV: 'production' });
  assert.notEqual(prod.status, 0, 'production refuses to boot on the placeholder');
  assert.match(prod.stderr, /placeholder/);
  const dev = load({ JWT_SECRET: 'set-a-long-random-string', NODE_ENV: 'test' });
  assert.equal(dev.status, 0, dev.stderr);
  assert.match(dev.stderr, /placeholder/);
});

test('a short env secret is warned about but kept; a long one is silent', () => {
  const short = load({ JWT_SECRET: 'short-but-working', NODE_ENV: 'production' });
  assert.equal(short.status, 0, short.stderr);
  assert.match(short.stderr, /only 17 characters/);
  const long = load({ JWT_SECRET: 'a'.repeat(48), NODE_ENV: 'production' });
  assert.equal(long.status, 0);
  assert.doesNotMatch(long.stderr, /JWT_SECRET/);
});
