'use strict';

/*
 * lib/public-origin: the origin put into EMAILED links (reset, verification, invites). A forged
 * Host header must never steer one, except on a SELF_HOSTED install with no APP_URL (the LAN-by-IP
 * case, documented residual risk). Each case loads the module fresh in a child process so env and
 * the config cache stay clean.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

function originFor(env, host, protocol = 'http') {
  const full = { ...process.env, JWT_SECRET: 'x'.repeat(40) };
  for (const k of ['APP_URL', 'PUBLIC_HOSTS', 'SELF_HOSTED']) delete full[k];
  Object.assign(full, env);
  const code = `const { publicOrigin } = require('./lib/public-origin');
    process.stdout.write(publicOrigin({ protocol: ${JSON.stringify(protocol)}, get: () => ${JSON.stringify(host)} }));`;
  const r = spawnSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: full, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { origin: r.stdout, stderr: r.stderr };
}

test('APP_URL wins over any Host, trailing slash trimmed, and no warning', () => {
  const r = originFor({ APP_URL: 'https://signage.example.com/' }, 'evil.example');
  assert.equal(r.origin, 'https://signage.example.com');
  assert.doesNotMatch(r.stderr, /APP_URL is not set/);
});

test('hosted (not SELF_HOSTED), no APP_URL: a forged Host is NOT used', () => {
  const r = originFor({ PORT: '3001' }, 'evil.example');
  assert.equal(r.origin, 'http://localhost:3001');
  assert.match(r.stderr, /APP_URL is not set/, 'boot warning recommends APP_URL');
});

test('PUBLIC_HOSTS allowlists request hosts; anything else falls back to the first entry', () => {
  assert.equal(originFor({ PUBLIC_HOSTS: 'signage.example.com, alt.example.com' }, 'alt.example.com', 'https').origin, 'https://alt.example.com');
  assert.equal(originFor({ PUBLIC_HOSTS: 'signage.example.com' }, 'evil.example', 'https').origin, 'https://signage.example.com');
});

test('loopback hosts are accepted (a link to the victim\'s own localhost leaks nothing)', () => {
  assert.equal(originFor({}, 'localhost:3001').origin, 'http://localhost:3001');
  assert.equal(originFor({}, '127.0.0.1:3001').origin, 'http://127.0.0.1:3001');
});

test('SELF_HOSTED with no APP_URL keeps using the request host (LAN by IP keeps working), with the warning', () => {
  const r = originFor({ SELF_HOSTED: 'true' }, '192.168.1.50:3001');
  assert.equal(r.origin, 'http://192.168.1.50:3001');
  assert.match(r.stderr, /APP_URL is not set/);
});

test('a malformed Host is never echoed into a link', () => {
  assert.equal(originFor({ SELF_HOSTED: 'true', PORT: '3001' }, 'evil.example/@x"<').origin, 'http://localhost:3001');
});
