'use strict';

/*
 * SCIM through the REAL server.js: the mount, the body parsing (application/scim+json is not
 * something the global JSON parser reads, and /scim is excluded from it so its own 1 MB parser and
 * SCIM error envelope apply), and the sign-in refusals for an account provisioning switched off.
 * test/scim.test.js covers the protocol in depth in-process; this proves it is wired up.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { freePort } = require('./helpers/free-port');

const DATA_DIR = path.join(os.tmpdir(), 'st-scim-mount-' + crypto.randomBytes(4).toString('hex'));
let PORT; let BASE; let proc; let db; let token; let ownerJwt; let orgId;

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-scim-mount.log'), 'w');
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/status')).ok) { up = true; break; } } catch { /* */ } await new Promise((r) => setTimeout(r, 250)); }
  if (!up) throw new Error('server did not boot');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));

  const reg = await (await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@mount.test', password: 'Passw0rd123!' }),
  })).json();
  ownerJwt = reg.token;
  const owner = db.prepare("SELECT id FROM users WHERE email = 'owner@mount.test'").get();
  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(owner.id);
  orgId = db.prepare('SELECT organization_id FROM organization_members WHERE user_id = ?').get(owner.id).organization_id;
  const provId = crypto.randomUUID();
  db.prepare("INSERT INTO org_sso_providers (id, organization_id, slug, name, issuer, client_id, email_domains) VALUES (?, ?, ?, 'IdP', 'https://idp.mount.test', 'c', 'mount.test')")
    .run(provId, orgId, 'org' + crypto.randomBytes(6).toString('hex'));
  db.prepare("INSERT INTO org_sso_domains (id, organization_id, provider_id, domain, token, verified_at) VALUES (?, ?, ?, 'mount.test', 't', strftime('%s','now'))")
    .run(crypto.randomUUID(), orgId, provId);

  const auth = { Authorization: `Bearer ${ownerJwt}`, 'Content-Type': 'application/json' };
  const en = await fetch(`${BASE}/api/organizations/${orgId}/scim`, { method: 'PUT', headers: auth, body: JSON.stringify({ enabled: true }) });
  assert.equal(en.status, 200, await en.text());
  const minted = await (await fetch(`${BASE}/api/organizations/${orgId}/scim/tokens`, { method: 'POST', headers: auth, body: '{}' })).json();
  token = minted.token;
});

after(() => { try { db && db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

const scimFetch = (p, opts = {}) => fetch(`${BASE}/scim/v2${p}`, {
  ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/scim+json', ...(opts.headers || {}) },
});

test('POST /scim/v2/Users with application/scim+json is parsed and provisioned', async () => {
  const r = await scimFetch('/Users', { method: 'POST', body: JSON.stringify({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'pat@mount.test',
    emails: [{ value: 'pat@mount.test', primary: true }], name: { givenName: 'Pat' }, active: true,
  }) });
  assert.equal(r.status, 201, await r.clone().text());
  assert.match(r.headers.get('content-type'), /application\/scim\+json/);
  const body = await r.json();
  assert.equal(body.userName, 'pat@mount.test');
  assert.match(body.meta.location, new RegExp(`/scim/v2/Users/${body.id}$`));
});

test('a malformed body is a SCIM invalidSyntax error, not the HTML error page', async () => {
  const r = await scimFetch('/Users', { method: 'POST', body: '{"userName":' });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.scimType, 'invalidSyntax');
});

test('unauthenticated requests get a SCIM 401 and the session API is not a way in', async () => {
  const r = await fetch(`${BASE}/scim/v2/Users`, { headers: { Authorization: `Bearer ${ownerJwt}` } });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).schemas[0], 'urn:ietf:params:scim:api:messages:2.0:Error');
});

test('a disabled account is refused at password login, after the password is proven', async () => {
  await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'gone@elsewhere.test', password: 'Passw0rd123!' }) });
  db.prepare("UPDATE users SET disabled_at = strftime('%s','now') WHERE email = 'gone@elsewhere.test'").run();
  const login = (password) => fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'gone@elsewhere.test', password }) });
  const wrong = await login('nope-nope-nope');
  assert.equal(wrong.status, 401, 'a wrong password learns nothing about the account');
  const right = await login('Passw0rd123!');
  assert.equal(right.status, 403);
  assert.equal((await right.json()).code, 'account_disabled');
});
