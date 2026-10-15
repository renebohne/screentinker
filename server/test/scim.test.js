'use strict';

/*
 * SCIM 2.0 provisioning (routes/scim.js, routes/org-scim.js, lib/scim/*, docs/scim.md).
 *
 * Request and response shapes follow RFC 7643/7644, and the user/group traffic is written the way
 * Okta and Microsoft Entra ID actually send it — capitalised ops, "False" as a string, member
 * removal by `path: "members"` with a value array, no-path replace objects — because a server that
 * only passes the RFC's own examples fails against both.
 *
 * The security half: a provisioning token is a customer-controlled credential, so the tests that
 * matter most are the ones where it tries to reach past its organization — another org's users and
 * groups, an address at a domain it has not proved, an existing account it may not take over, a
 * platform account, the organization owner — and the filter parser being handed SQL.
 */

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-scim-' + crypto.randomBytes(4).toString('hex'));
process.env.JWT_SECRET = 'test-secret-scim-0123456789abcdef0123456789';
process.env.SELF_HOSTED = 'true';
process.env.SCIM_RATE_LIMIT = '100000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { apiTokenAuth, hashToken: hashApiToken } = require('../middleware/apiToken');
const scimRouter = require('../routes/scim');
const { parseFilter, FilterError } = require('../lib/scim/filter');
const { SlidingWindow } = require('../lib/scim/rate-limit');
const { upsertFederatedUser, scimDeactivated } = require('../routes/auth');

const uid = () => crypto.randomUUID();
const OWNER = uid(); const ADMIN_B = uid(); const PLATFORM = uid(); const OUTSIDER = uid(); const MEMBER = uid(); const OTHER_FED = uid();
const ORG_A = uid(); const ORG_B = uid(); const ORG_C = uid();
const WS_A1 = uid(); const WS_A2 = uid(); const WS_B = uid(); const WS_C = uid();
const PROV_A = uid(); const PROV_B = uid();
const SLUG_A = 'org' + crypto.randomBytes(6).toString('hex');
const SLUG_B = 'org' + crypto.randomBytes(6).toString('hex');

let server; let BASE; let tokenA; let tokenB; let ownerJwt;

const SCIM_JSON = 'application/scim+json';
async function scim(method, p, { token = tokenA, body, type = SCIM_JSON, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined || raw !== undefined) headers['Content-Type'] = type;
  const r = await fetch(BASE + '/scim/v2' + p, { method, headers, body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined) });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null };
}
async function admin(method, p, body, jwtTok = ownerJwt) {
  const r = await fetch(BASE + '/api/organizations' + p, {
    method, headers: { Authorization: `Bearer ${jwtTok}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const userRow = (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email);
const wsRole = (ws, userId) => (db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(ws, userId) || {}).role || null;
const orgRole = (org, userId) => (db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?').get(org, userId) || {}).role || null;
const sessionFor = (userId, ws = null) => generateToken(db.prepare('SELECT * FROM users WHERE id = ?').get(userId), ws);
async function whoami(jwtTok) { return (await fetch(BASE + '/whoami', { headers: { Authorization: `Bearer ${jwtTok}` } })).status; }

function oktaUser(userName, extra = {}) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    userName,
    name: { givenName: 'Ada', familyName: 'Lovelace' },
    emails: [{ primary: true, value: userName, type: 'work' }],
    displayName: 'Ada Lovelace',
    locale: 'en-US',
    externalId: '00u' + crypto.randomBytes(6).toString('hex'),
    groups: [],
    password: 'ThisMustBeIgnored1!',
    active: true,
    ...extra,
  };
}
function entraUser(userName, email = userName) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User', 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'],
    externalId: crypto.randomUUID(),
    userName,
    active: true,
    addresses: [{ primary: false, type: 'work', country: 'GB' }],
    displayName: 'Grace Hopper',
    emails: [{ primary: true, type: 'work', value: email }],
    meta: { resourceType: 'User' },
    name: { familyName: 'Hopper', givenName: 'Grace' },
    roles: [{ primary: false, type: 'WindowsAzureActiveDirectoryRole', value: 'platform_admin' }],
    'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { department: 'Engineering' },
  };
}
const patchOp = (...Operations) => ({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations });

before(async () => {
  const ins = db.prepare('INSERT INTO users (id, email, name, password_hash, role, email_verified, auth_provider) VALUES (?, ?, ?, ?, ?, 1, ?)');
  ins.run(OWNER, 'owner@acme.test', 'Owner', 'x', 'user', 'local');
  ins.run(ADMIN_B, 'boss@beta.test', 'Boss', 'x', 'user', 'local');
  ins.run(PLATFORM, 'ops@acme.test', 'Ops', 'x', 'platform_admin', 'local');
  ins.run(OUTSIDER, 'outsider@acme.test', 'Outsider', 'hash', 'user', 'local');      // password account, not in org A
  ins.run(MEMBER, 'member@acme.test', 'Member', 'hash', 'user', 'local');             // password account, IS in org A
  ins.run(OTHER_FED, 'fed@acme.test', 'Fed', null, 'user', SLUG_B);                   // signs in through ORG B's provider
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)')
    .run(ORG_A, 'Acme', OWNER, ORG_B, 'Beta', ADMIN_B, ORG_C, 'Elsewhere', ADMIN_B);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)')
    .run(WS_A1, ORG_A, 'Lobby', WS_A2, ORG_A, 'Stores', WS_B, ORG_B, 'Beta HQ', WS_C, ORG_C, 'Elsewhere HQ');
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner'), (?, ?, 'org_owner'), (?, ?, 'org_member'), (?, ?, 'org_owner')")
    .run(ORG_A, OWNER, ORG_B, ADMIN_B, ORG_A, MEMBER, ORG_C, ADMIN_B);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin'), (?, ?, 'workspace_admin'), (?, ?, 'workspace_viewer')")
    .run(WS_A1, OWNER, WS_B, ADMIN_B, WS_A2, MEMBER);
  db.prepare("INSERT INTO org_sso_providers (id, organization_id, slug, name, issuer, client_id, email_domains, enabled) VALUES (?, ?, ?, 'Acme IdP', 'https://idp.acme.test', 'c', 'acme.test', 1), (?, ?, ?, 'Beta IdP', 'https://idp.beta.test', 'c', 'beta.test', 1)")
    .run(PROV_A, ORG_A, SLUG_A, PROV_B, ORG_B, SLUG_B);
  db.prepare("INSERT INTO org_sso_domains (id, organization_id, provider_id, domain, token, verified_at) VALUES (?, ?, ?, 'acme.test', 't', strftime('%s','now')), (?, ?, ?, 'beta.test', 't', strftime('%s','now'))")
    .run(uid(), ORG_A, PROV_A, uid(), ORG_B, PROV_B);

  const app = express();
  app.use((req, res, next) => (req.path.startsWith('/scim/') ? next() : express.json()(req, res, next)));
  app.use('/scim/v2', scimRouter);
  app.use('/api/organizations', require('../routes/org-scim'));
  app.get('/whoami', requireAuth, (req, res) => res.json({ id: req.user.id }));
  app.get('/api-token-check', apiTokenAuth, (req, res) => res.json({ id: req.user.id }));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  BASE = `http://127.0.0.1:${server.address().port}`;

  ownerJwt = sessionFor(OWNER, WS_A1);
  // Org A: enable and mint through the admin API (that path is under test too).
  assert.equal((await admin('PUT', `/${ORG_A}/scim`, { enabled: true })).status, 200);
  const minted = await admin('POST', `/${ORG_A}/scim/tokens`, { name: 'Okta' });
  assert.equal(minted.status, 201);
  tokenA = minted.body.token;
  const bossJwt = sessionFor(ADMIN_B, WS_B);
  assert.equal((await admin('PUT', `/${ORG_B}/scim`, { enabled: true }, bossJwt)).status, 200);
  tokenB = (await admin('POST', `/${ORG_B}/scim/tokens`, { name: 'Entra' }, bossJwt)).body.token;
});

after(() => { try { server.close(); } catch { /* */ } });

// ---------------------------------------------------------------------------------------------
// Tokens

test('a provisioning token is stored only as its SHA-256, shown once, and listed by prefix', async () => {
  assert.match(tokenA, /^stscim_[A-Za-z0-9_-]{43}$/);
  const row = db.prepare('SELECT * FROM scim_tokens WHERE organization_id = ? AND revoked_at IS NULL').get(ORG_A);
  assert.equal(row.token_hash, crypto.createHash('sha256').update(tokenA).digest('hex'));
  assert.ok(!JSON.stringify(row).includes(tokenA.slice(7)), 'no part of the secret beyond the prefix is stored');
  const ov = await admin('GET', `/${ORG_A}/scim`);
  assert.equal(ov.status, 200);
  assert.ok(!JSON.stringify(ov.body).includes(tokenA), 'the overview never returns the token');
  assert.equal(ov.body.tokens[0].prefix, tokenA.slice(0, 13));
  assert.match(ov.body.base_url, /\/scim\/v2$/);
});

test('no token, a wrong token, or another kind of token: 401 in the SCIM error envelope', async () => {
  for (const token of [null, 'stscim_' + 'A'.repeat(43), 'st_' + 'A'.repeat(43), ownerJwt]) {
    const r = await scim('GET', '/Users', { token });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('content-type'), /application\/scim\+json/);
    assert.deepEqual(r.body.schemas, ['urn:ietf:params:scim:api:messages:2.0:Error']);
    assert.equal(r.body.status, '401');
  }
});

test('revoking a token stops it at once; last-used is recorded', async () => {
  const bossJwt = sessionFor(ADMIN_B, WS_B);
  const m = await admin('POST', `/${ORG_B}/scim/tokens`, { name: 'temp' }, bossJwt);
  assert.equal((await scim('GET', '/Users', { token: m.body.token })).status, 200);
  assert.ok(db.prepare('SELECT last_used_at FROM scim_tokens WHERE id = ?').get(m.body.id).last_used_at);
  assert.equal((await admin('DELETE', `/${ORG_B}/scim/tokens/${m.body.id}`, undefined, bossJwt)).status, 200);
  assert.equal((await scim('GET', '/Users', { token: m.body.token })).status, 401);
});

test('turning provisioning off answers 403 to a valid token; on again, it works', async () => {
  assert.equal((await admin('PUT', `/${ORG_A}/scim`, { enabled: false })).status, 200);
  const r = await scim('GET', '/Users');
  assert.equal(r.status, 403);
  assert.equal(r.body.status, '403');
  assert.equal((await admin('PUT', `/${ORG_A}/scim`, { enabled: true })).status, 200);
  assert.equal((await scim('GET', '/Users')).status, 200);
});

test('settings are org-admin only (404 to anyone else) and cannot be pointed at another org\'s workspace', async () => {
  const memberJwt = sessionFor(MEMBER, WS_A2);
  assert.equal((await admin('GET', `/${ORG_A}/scim`, undefined, memberJwt)).status, 404);
  assert.equal((await admin('POST', `/${ORG_A}/scim/tokens`, {}, memberJwt)).status, 404);
  assert.equal((await admin('GET', `/${ORG_A}/scim`, undefined, sessionFor(ADMIN_B, WS_B))).status, 404);
  assert.equal((await admin('PUT', `/${ORG_A}/scim`, { default_workspace_id: WS_B, default_role: 'workspace_viewer' })).status, 400);
  // An org with no verified SSO domain cannot switch provisioning on: nobody could sign in.
  assert.equal((await admin('PUT', `/${ORG_C}/scim`, { enabled: true }, sessionFor(ADMIN_B, WS_C))).status, 400);
});

// ---------------------------------------------------------------------------------------------
// Discovery

test('ServiceProviderConfig, ResourceTypes and Schemas describe what the server does', async () => {
  const spc = await scim('GET', '/ServiceProviderConfig');
  assert.equal(spc.status, 200);
  assert.match(spc.headers.get('content-type'), /application\/scim\+json/);
  assert.equal(spc.body.patch.supported, true);
  assert.equal(spc.body.bulk.supported, false);
  assert.equal(spc.body.filter.supported, true);
  assert.equal(spc.body.changePassword.supported, false);
  const rt = await scim('GET', '/ResourceTypes');
  assert.deepEqual(rt.body.Resources.map((r) => r.id).sort(), ['Group', 'User']);
  assert.equal(rt.body.schemas[0], 'urn:ietf:params:scim:api:messages:2.0:ListResponse');
  const sc = await scim('GET', '/Schemas');
  assert.equal(sc.body.totalResults, 2);
  assert.equal((await scim('GET', '/Schemas/urn:ietf:params:scim:schemas:core:2.0:User')).body.name, 'User');
  assert.equal((await scim('POST', '/Bulk', { body: {} })).status, 501);
  assert.equal((await scim('GET', '/Nope')).status, 404);
});

// ---------------------------------------------------------------------------------------------
// Users — Okta

test('Okta: create, find by userName/externalId, PUT update, PUT deactivate, PATCH reactivate', async () => {
  const body = oktaUser('ada@acme.test');
  const c = await scim('POST', '/Users', { body });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(c.headers.get('location'), c.body.meta.location);
  assert.equal(c.body.userName, 'ada@acme.test');
  assert.equal(c.body.active, true);
  assert.deepEqual(c.body.emails, [{ value: 'ada@acme.test', type: 'work', primary: true }]);
  assert.equal(c.body.meta.resourceType, 'User');
  assert.ok(!('password' in c.body));

  const u = userRow('ada@acme.test');
  assert.equal(u.password_hash, null, 'a provisioned account never has a password, even when the IdP sends one');
  assert.equal(u.auth_provider, SLUG_A, 'it signs in through the organization\'s SSO');
  assert.equal(u.role, 'user');
  assert.equal(u.email_verified, 1);
  assert.equal(orgRole(ORG_A, u.id), 'org_member');

  // Okta looks the user up before creating; userName is case-insensitive.
  const f = await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "ADA@acme.test"')}&startIndex=1&count=100`);
  assert.equal(f.status, 200);
  assert.equal(f.body.totalResults, 1);
  assert.equal(f.body.Resources[0].id, c.body.id);
  const fx = await scim('GET', `/Users?filter=${encodeURIComponent(`externalId eq "${body.externalId}"`)}`);
  assert.equal(fx.body.totalResults, 1);
  assert.equal((await scim('GET', `/Users?filter=${encodeURIComponent(`externalId eq "${body.externalId.toUpperCase()}"`)}`)).body.totalResults, 0, 'externalId is caseExact');

  // PUT: Okta's update verb.
  const p = await scim('PUT', `/Users/${c.body.id}`, { body: { ...body, name: { givenName: 'Augusta', familyName: 'King' }, displayName: 'Augusta King' } });
  assert.equal(p.status, 200);
  assert.equal(p.body.name.givenName, 'Augusta');
  assert.equal(userRow('ada@acme.test').name, 'Augusta King');

  // A live session, then deactivation by PUT active:false.
  const session = sessionFor(u.id);
  assert.equal(await whoami(session), 200);
  const tvBefore = userRow('ada@acme.test').token_version;
  const d = await scim('PUT', `/Users/${c.body.id}`, { body: { ...body, active: false } });
  assert.equal(d.status, 200);
  assert.equal(d.body.active, false);
  const after1 = userRow('ada@acme.test');
  assert.ok(after1.disabled_at, 'the account this org owns is disabled');
  assert.ok(after1.token_version > tvBefore, 'token_version is bumped');
  assert.equal(await whoami(session), 401, 'the existing session is over');
  assert.equal(await whoami(sessionFor(u.id)), 401, 'and a freshly minted one is refused too');
  assert.equal(orgRole(ORG_A, u.id), null, 'no organization access while deactivated');

  // Okta reactivates with a no-path PATCH.
  const r = await scim('PATCH', `/Users/${c.body.id}`, { body: patchOp({ op: 'replace', value: { active: true } }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.active, true);
  assert.equal(userRow('ada@acme.test').disabled_at, null);
  assert.equal(orgRole(ORG_A, u.id), 'org_member');
  assert.equal(await whoami(sessionFor(u.id)), 200);
});

test('a PUT without `active` leaves it as it is (does not reactivate)', async () => {
  const c = await scim('POST', '/Users', { body: oktaUser('quiet@acme.test', { active: false }) });
  assert.equal(c.status, 201);
  assert.equal(c.body.active, false);
  const body = oktaUser('quiet@acme.test'); delete body.active;
  assert.equal((await scim('PUT', `/Users/${c.body.id}`, { body })).body.active, false);
});

test('POSTing the same userName again is 409 uniqueness and changes nothing', async () => {
  const body = oktaUser('twice@acme.test');
  const a = await scim('POST', '/Users', { body });
  assert.equal(a.status, 201);
  const b = await scim('POST', '/Users', { body: { ...body, displayName: 'Changed' } });
  assert.equal(b.status, 409);
  assert.equal(b.body.scimType, 'uniqueness');
  assert.equal((await scim('GET', `/Users/${a.body.id}`)).body.displayName, 'Ada Lovelace');
  // And a PUT of identical content twice is the same resource both times.
  const p1 = await scim('PUT', `/Users/${a.body.id}`, { body });
  const p2 = await scim('PUT', `/Users/${a.body.id}`, { body });
  assert.deepEqual({ ...p1.body, meta: null }, { ...p2.body, meta: null });
});

// ---------------------------------------------------------------------------------------------
// Users — Entra

test('Entra: create with its payload; PATCH with capitalised ops, string booleans and value-path emails', async () => {
  const c = await scim('POST', '/Users', { body: entraUser('grace@acme.test') });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const id = c.body.id;
  assert.equal(userRow('grace@acme.test').role, 'user', 'a roles attribute can never make a platform admin');

  // Entra's validation probe: a filter for a user that does not exist is an empty list, not a 404.
  const probe = await scim('GET', `/Users?filter=${encodeURIComponent(`userName eq "${crypto.randomUUID()}"`)}`);
  assert.equal(probe.status, 200);
  assert.equal(probe.body.totalResults, 0);
  assert.deepEqual(probe.body.Resources, []);

  const p = await scim('PATCH', `/Users/${id}`, { body: patchOp(
    { op: 'Replace', path: 'displayName', value: 'Rear Admiral Hopper' },
    { op: 'Add', path: 'emails[type eq "work"].value', value: 'grace@acme.test' },
    { op: 'Replace', path: 'name.givenName', value: 'Amazing Grace' },
    { op: 'Add', path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department', value: 'Navy' },
    { op: 'Add', path: 'phoneNumbers[type eq "mobile"].value', value: '+1 555 0100' },
  ) });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.displayName, 'Rear Admiral Hopper');
  assert.equal(p.body.name.givenName, 'Amazing Grace');

  // THE trap: "False" is a truthy string. It must deactivate.
  const d = await scim('PATCH', `/Users/${id}`, { body: patchOp({ op: 'Replace', path: 'active', value: 'False' }) });
  assert.equal(d.status, 200);
  assert.equal(d.body.active, false);
  assert.ok(userRow('grace@acme.test').disabled_at);
  const r = await scim('PATCH', `/Users/${id}`, { body: patchOp({ op: 'Replace', path: 'active', value: 'True' }) });
  assert.equal(r.body.active, true);
  assert.equal(userRow('grace@acme.test').disabled_at, null);

  // A non-boolean is an error, not a guess.
  const bad = await scim('PATCH', `/Users/${id}`, { body: patchOp({ op: 'Replace', path: 'active', value: 'maybe' }) });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.scimType, 'invalidValue');
  // No-path replace with dotted keys (also Entra).
  const dotted = await scim('PATCH', `/Users/${id}`, { body: patchOp({ op: 'replace', value: { 'name.familyName': 'Murray', externalId: 'ext-g' } }) });
  assert.equal(dotted.body.name.familyName, 'Murray');
  assert.equal(dotted.body.externalId, 'ext-g');
});

test('PATCH errors are RFC-shaped: bad op, missing Operations, wrong schema, remove userName', async () => {
  const c = await scim('POST', '/Users', { body: oktaUser('errs@acme.test') });
  const cases = [
    [patchOp({ op: 'merge', path: 'displayName', value: 'x' }), 'invalidSyntax'],
    [{ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'] }, 'invalidSyntax'],
    [{ schemas: ['urn:wrong'], Operations: [{ op: 'replace', path: 'displayName', value: 'x' }] }, 'invalidSyntax'],
    [patchOp({ op: 'remove', path: 'userName' }), 'mutability'],
    [patchOp({ op: 'remove' }), 'noTarget'],
  ];
  for (const [body, scimType] of cases) {
    const r = await scim('PATCH', `/Users/${c.body.id}`, { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.scimType, scimType);
    assert.equal(r.body.status, '400');
  }
  const bad = await scim('POST', '/Users', { raw: '{"userName": ' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.scimType, 'invalidSyntax');
  assert.equal((await scim('GET', `/Users/${crypto.randomUUID()}`)).status, 404);
  assert.equal((await scim('GET', '/Users/not-a-uuid')).status, 404);
  // application/json is accepted as well as application/scim+json.
  assert.equal((await scim('POST', '/Users', { body: oktaUser('plainjson@acme.test'), type: 'application/json' })).status, 201);
});

test('pagination: startIndex is 1-based, count is capped, count=0 returns only the total', async () => {
  const all = await scim('GET', '/Users?count=1000');
  assert.ok(all.body.totalResults >= 4);
  assert.ok(all.body.itemsPerPage <= 200);
  const p1 = await scim('GET', '/Users?startIndex=1&count=2');
  const p2 = await scim('GET', '/Users?startIndex=3&count=2');
  assert.equal(p1.body.itemsPerPage, 2);
  assert.equal(p1.body.startIndex, 1);
  assert.equal(p2.body.startIndex, 3);
  assert.notEqual(p1.body.Resources[0].id, p2.body.Resources[0].id);
  const zero = await scim('GET', '/Users?count=0');
  assert.equal(zero.body.Resources.length, 0);
  assert.equal(zero.body.totalResults, all.body.totalResults);
  const neg = await scim('GET', '/Users?startIndex=-5&count=1');
  assert.equal(neg.body.startIndex, 1);
  const proj = await scim('GET', '/Users?count=1&attributes=userName');
  assert.deepEqual(Object.keys(proj.body.Resources[0]).sort(), ['id', 'schemas', 'userName']);
});

// ---------------------------------------------------------------------------------------------
// Filters

test('filter parser: the strict grammar, and nothing outside it', () => {
  assert.deepEqual(parseFilter('userName eq "a@b.c"'), [{ attr: 'username', value: 'a@b.c' }]);
  assert.deepEqual(parseFilter('urn:ietf:params:scim:schemas:core:2.0:User:userName eq "x"'), [{ attr: 'username', value: 'x' }]);
  assert.deepEqual(parseFilter('externalId eq "a\\"b" and active eq true'), [{ attr: 'externalid', value: 'a"b' }, { attr: 'active', value: true }]);
  assert.deepEqual(parseFilter('emails.value EQ "x"'), [{ attr: 'emails.value', value: 'x' }]);
  assert.equal(parseFilter(''), null);
  for (const bad of [
    'userName co "a"', 'userName sw "a"', 'userName eq a', 'userName eq "a" or userName eq "b"', 'not (userName eq "a")',
    '(userName eq "a")', 'userName eq "a', 'userName  eq', 'userName eq "a" and', 'emails[type eq "work"] eq "x"',
    'userName eq "a"; DROP TABLE users', "userName eq 'a'", 'a.b.c eq "x"', 'userName eq "a" garbage',
    'a eq "1" and b eq "2" and c eq "3" and d eq "4" and e eq "5"', 'x'.repeat(1001),
  ]) {
    assert.throws(() => parseFilter(bad), FilterError, bad.slice(0, 60));
  }
});

test('filters cannot inject SQL or reach unsupported attributes over the wire', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const inj = await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "x\' OR 1=1 --"')}`);
  assert.equal(inj.status, 200);
  assert.equal(inj.body.totalResults, 0, 'the value is bound, so the quote is just a character');
  const inj2 = await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "" OR 1=1')}`);
  assert.equal(inj2.status, 400);
  assert.equal(inj2.body.scimType, 'invalidFilter');
  for (const f of ['password eq "x"', 'password_hash eq "x"', 'role eq "platform_admin"', 'userName gt "a"', 'active eq "true"', 'userName eq true']) {
    const r = await scim('GET', `/Users?filter=${encodeURIComponent(f)}`);
    assert.equal(r.status, 400, f);
    assert.equal(r.body.scimType, 'invalidFilter', f);
  }
  assert.equal((await scim('GET', `/Groups?filter=${encodeURIComponent('members.value eq "x" or 1 eq 1')}`)).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, before);
  const em = await scim('GET', `/Users?filter=${encodeURIComponent('emails.value eq "ADA@ACME.TEST"')}`);
  assert.equal(em.body.totalResults, 1);
  const act = await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "quiet@acme.test" and active eq false')}`);
  assert.equal(act.body.totalResults, 1);
});

// ---------------------------------------------------------------------------------------------
// Groups -> workspace access

test('groups: members get the mapped workspace role; Entra and Okta member removal both take it away', async () => {
  const u1 = await scim('POST', '/Users', { body: entraUser('g1@acme.test') });
  const u2 = await scim('POST', '/Users', { body: oktaUser('g2@acme.test') });
  const g = await scim('POST', '/Groups', { body: { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'Signage Editors', externalId: 'grp-1', members: [{ value: u1.body.id }] } });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.equal(g.headers.get('location'), g.body.meta.location);
  assert.deepEqual(g.body.members.map((m) => m.value), [u1.body.id]);
  const user1 = userRow('g1@acme.test'); const user2 = userRow('g2@acme.test');
  assert.equal(wsRole(WS_A1, user1.id), null, 'no mapping yet, so no access yet');

  // The org admin maps the group to a workspace role.
  const m = await admin('POST', `/${ORG_A}/scim/mappings`, { group_id: g.body.id, workspace_id: WS_A1, role: 'workspace_editor' });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(wsRole(WS_A1, user1.id), 'workspace_editor');

  // Entra adds a member.
  const add = await scim('PATCH', `/Groups/${g.body.id}`, { body: patchOp({ op: 'Add', path: 'members', value: [{ value: u2.body.id }] }) });
  assert.equal(add.status, 204);
  assert.equal(wsRole(WS_A1, user2.id), 'workspace_editor');
  assert.deepEqual((await scim('GET', `/Users/${u2.body.id}`)).body.groups.map((x) => x.display), ['Signage Editors']);

  // Entra removes with path "members" + value array.
  await scim('PATCH', `/Groups/${g.body.id}`, { body: patchOp({ op: 'Remove', path: 'members', value: [{ value: u1.body.id }] }) });
  assert.equal(wsRole(WS_A1, user1.id), null);
  // Okta removes with a value-path filter.
  await scim('PATCH', `/Groups/${g.body.id}`, { body: patchOp({ op: 'remove', path: `members[value eq "${u2.body.id}"]` }) });
  assert.equal(wsRole(WS_A1, user2.id), null);

  // Okta renames with a no-path replace that carries the group's own id.
  const ren = await scim('PATCH', `/Groups/${g.body.id}?attributes=displayName`, { body: patchOp({ op: 'replace', value: { id: g.body.id, displayName: 'Signage Team' } }) });
  assert.equal(ren.status, 200);
  assert.equal(ren.body.displayName, 'Signage Team');

  // Filters Entra uses on groups.
  const byName = await scim('GET', `/Groups?filter=${encodeURIComponent('displayName eq "signage team"')}&excludedAttributes=members`);
  assert.equal(byName.body.totalResults, 1);
  assert.ok(!('members' in byName.body.Resources[0]));
  await scim('PATCH', `/Groups/${g.body.id}`, { body: patchOp({ op: 'add', path: 'members', value: [{ value: u1.body.id }] }) });
  const isMember = await scim('GET', `/Groups?filter=${encodeURIComponent(`id eq "${g.body.id}" and members eq "${u1.body.id}"`)}`);
  assert.equal(isMember.body.totalResults, 1);
  assert.equal(wsRole(WS_A1, user1.id), 'workspace_editor');

  // Removing the mapping removes the access; DELETE of the group likewise.
  const mappingId = m.body.groups.find((x) => x.id === g.body.id).mappings[0].id;
  await admin('DELETE', `/${ORG_A}/scim/mappings/${mappingId}`);
  assert.equal(wsRole(WS_A1, user1.id), null);
  await admin('POST', `/${ORG_A}/scim/mappings`, { group_id: g.body.id, workspace_id: WS_A2, role: 'workspace_viewer' });
  assert.equal(wsRole(WS_A2, user1.id), 'workspace_viewer');
  assert.equal((await scim('DELETE', `/Groups/${g.body.id}`)).status, 204);
  assert.equal(wsRole(WS_A2, user1.id), null);
  assert.equal((await scim('GET', `/Groups/${g.body.id}`)).status, 404);
});

test('a hand-granted membership is raised by a group and put back afterwards, never removed', async () => {
  const s = await scim('POST', '/Users', { body: oktaUser('member@acme.test') });
  assert.equal(s.status, 201, 'an existing member of the org is linked');
  assert.equal(wsRole(WS_A2, MEMBER), 'workspace_viewer');
  assert.equal(userRow('member@acme.test').password_hash, 'hash', 'linking a member does not take their account over');
  const g = await scim('POST', '/Groups', { body: { displayName: 'Store Admins', members: [{ value: s.body.id }] } });
  await admin('POST', `/${ORG_A}/scim/mappings`, { group_id: g.body.id, workspace_id: WS_A2, role: 'workspace_admin' });
  assert.equal(wsRole(WS_A2, MEMBER), 'workspace_admin');
  await scim('PATCH', `/Groups/${g.body.id}`, { body: patchOp({ op: 'replace', path: 'members', value: [] }) });
  assert.equal(wsRole(WS_A2, MEMBER), 'workspace_viewer', 'the hand-granted role is restored, not deleted');
  await scim('DELETE', `/Groups/${g.body.id}`);
});

test('default access applies to every provisioned person and follows deactivation', async () => {
  assert.equal((await admin('PUT', `/${ORG_A}/scim`, { default_workspace_id: WS_A1, default_role: 'workspace_viewer' })).status, 200);
  const u = await scim('POST', '/Users', { body: oktaUser('dflt@acme.test') });
  const id = userRow('dflt@acme.test').id;
  assert.equal(wsRole(WS_A1, id), 'workspace_viewer');
  await scim('PATCH', `/Users/${u.body.id}`, { body: patchOp({ op: 'replace', path: 'active', value: false }) });
  assert.equal(wsRole(WS_A1, id), null);
  await scim('PATCH', `/Users/${u.body.id}`, { body: patchOp({ op: 'replace', path: 'active', value: true }) });
  assert.equal(wsRole(WS_A1, id), 'workspace_viewer');
  assert.equal((await admin('PUT', `/${ORG_A}/scim`, { default_workspace_id: null })).status, 200);
  assert.equal(wsRole(WS_A1, id), null, 'clearing the default takes it back');
});

test('group mappings refuse organization roles and other organizations\' workspaces', async () => {
  const g = await scim('POST', '/Groups', { body: { displayName: 'Escalators' } });
  assert.equal((await admin('POST', `/${ORG_A}/scim/mappings`, { group_id: g.body.id, workspace_id: WS_A1, role: 'org_admin' })).status, 400);
  assert.equal((await admin('POST', `/${ORG_A}/scim/mappings`, { group_id: g.body.id, workspace_id: WS_B, role: 'workspace_admin' })).status, 400);
  assert.equal((await admin('POST', `/${ORG_B}/scim/mappings`, { group_id: g.body.id, workspace_id: WS_B, role: 'workspace_admin' }, sessionFor(ADMIN_B, WS_B))).status, 404);
  assert.equal((await scim('POST', '/Groups', { body: { displayName: 'escalators' } })).status, 409, 'displayName is unique, case-insensitively');
});

// ---------------------------------------------------------------------------------------------
// Isolation and account-linking rules

test('cross-org isolation: another organization\'s token sees and touches nothing of this one', async () => {
  const a = await scim('POST', '/Users', { body: oktaUser('iso@acme.test') });
  const ga = await scim('POST', '/Groups', { body: { displayName: 'Iso Group', members: [{ value: a.body.id }] } });
  assert.equal((await scim('GET', `/Users/${a.body.id}`, { token: tokenB })).status, 404);
  assert.equal((await scim('PUT', `/Users/${a.body.id}`, { token: tokenB, body: oktaUser('iso@acme.test', { active: false }) })).status, 404);
  assert.equal((await scim('PATCH', `/Users/${a.body.id}`, { token: tokenB, body: patchOp({ op: 'replace', path: 'active', value: false }) })).status, 404);
  assert.equal((await scim('DELETE', `/Users/${a.body.id}`, { token: tokenB })).status, 404);
  assert.equal((await scim('GET', `/Groups/${ga.body.id}`, { token: tokenB })).status, 404);
  assert.equal((await scim('DELETE', `/Groups/${ga.body.id}`, { token: tokenB })).status, 404);
  const list = await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "iso@acme.test"')}`, { token: tokenB });
  assert.equal(list.body.totalResults, 0);
  const groups = await scim('GET', '/Groups', { token: tokenB });
  assert.ok(!groups.body.Resources.some((g) => g.id === ga.body.id));
  // Org B cannot provision at org A's domain, nor put org A's user into its own group.
  const steal = await scim('POST', '/Users', { token: tokenB, body: oktaUser('iso@acme.test') });
  assert.equal(steal.status, 400);
  assert.equal(steal.body.scimType, 'invalidValue');
  const gb = await scim('POST', '/Groups', { token: tokenB, body: { displayName: 'Grab', members: [{ value: a.body.id }] } });
  assert.equal(gb.status, 400);
  assert.equal(userRow('iso@acme.test').disabled_at, null);
  assert.equal(orgRole(ORG_B, userRow('iso@acme.test').id), null);
});

test('only verified domains: an address the org has not proved is refused', async () => {
  const r = await scim('POST', '/Users', { body: oktaUser('someone@gmail.com') });
  assert.equal(r.status, 400);
  assert.match(r.body.detail, /not a verified sign-in domain/);
  const noEmail = await scim('POST', '/Users', { body: { userName: 'just-a-login', name: { givenName: 'x' } } });
  assert.equal(noEmail.status, 400);
});

test('existing accounts: SSO linking rules are mirrored, platform accounts are never touched', async () => {
  // A password account outside the organization: SSO would refuse to adopt it, so does SCIM.
  const out = await scim('POST', '/Users', { body: oktaUser('outsider@acme.test') });
  assert.equal(out.status, 409);
  assert.equal(out.body.scimType, 'uniqueness');
  assert.equal(userRow('outsider@acme.test').password_hash, 'hash');
  // An account another organization's provider signs in.
  assert.equal((await scim('POST', '/Users', { body: oktaUser('fed@acme.test') })).status, 409);
  assert.equal(userRow('fed@acme.test').auth_provider, SLUG_B);
  // A platform admin, even at the org's own verified domain.
  assert.equal((await scim('POST', '/Users', { body: oktaUser('ops@acme.test') })).status, 409);
  assert.equal(userRow('ops@acme.test').role, 'platform_admin');
  assert.equal(orgRole(ORG_A, PLATFORM), null);
  // An invited account with no password yet is adopted, exactly as SSO would.
  db.prepare("INSERT INTO users (id, email, name, auth_provider, role) VALUES (?, 'invited@acme.test', '', 'local', 'user')").run(uid());
  assert.equal((await scim('POST', '/Users', { body: oktaUser('invited@acme.test') })).status, 201);
  assert.equal(userRow('invited@acme.test').auth_provider, SLUG_A);
});

test('the organization owner cannot be deactivated or deleted by provisioning', async () => {
  const o = await scim('POST', '/Users', { body: oktaUser('owner@acme.test') });
  assert.equal(o.status, 201);
  const d = await scim('PATCH', `/Users/${o.body.id}`, { body: patchOp({ op: 'replace', path: 'active', value: false }) });
  assert.equal(d.status, 400);
  assert.equal(d.body.scimType, 'mutability');
  assert.equal((await scim('DELETE', `/Users/${o.body.id}`)).status, 400);
  assert.equal(orgRole(ORG_A, OWNER), 'org_owner');
  assert.equal(await whoami(ownerJwt), 200);
});

test('deactivating a linked member it does not own ends their sessions and access here, not the account', async () => {
  const s = (await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "member@acme.test"')}`)).body.Resources[0];
  const session = sessionFor(MEMBER, WS_A2);
  assert.equal(await whoami(session), 200);
  await scim('PATCH', `/Users/${s.id}`, { body: patchOp({ op: 'Replace', path: 'active', value: 'False' }) });
  assert.equal(await whoami(session), 401, 'session ended');
  assert.equal(userRow('member@acme.test').disabled_at, null, 'not this org\'s account to switch off');
  assert.equal(wsRole(WS_A2, MEMBER), null);
  assert.equal(orgRole(ORG_A, MEMBER), null);
  assert.equal(scimDeactivated(ORG_A, MEMBER), true, 'the org\'s own SSO will not re-admit them (completeFederatedLogin)');
  assert.equal(scimDeactivated(ORG_B, MEMBER), false);
  await scim('PATCH', `/Users/${s.id}`, { body: patchOp({ op: 'Replace', path: 'active', value: 'True' }) });
  assert.equal(scimDeactivated(ORG_A, MEMBER), false);
  assert.equal(wsRole(WS_A2, MEMBER), 'workspace_viewer', 'hand-granted access comes back on reactivation');
  assert.equal(orgRole(ORG_A, MEMBER), 'org_member');
  // Changing the address of an account the org does not own is refused.
  const em = await scim('PATCH', `/Users/${s.id}`, { body: patchOp({ op: 'replace', path: 'emails[type eq "work"].value', value: 'renamed@acme.test' }) });
  assert.equal(em.status, 400);
  assert.equal(em.body.scimType, 'mutability');
});

test('API tokens of a deactivated account stop working', async () => {
  const c = await scim('POST', '/Users', { body: oktaUser('apitok@acme.test') });
  const id = userRow('apitok@acme.test').id;
  const raw = 'st_' + crypto.randomBytes(32).toString('base64url');
  db.prepare("INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, scope) VALUES (?, ?, ?, 'x', ?, ?, 'read')")
    .run(uid(), hashApiToken(raw), raw.slice(0, 11), id, WS_A1);
  const call = async () => (await fetch(BASE + '/api-token-check', { headers: { Authorization: `Bearer ${raw}` } })).status;
  assert.equal(await call(), 200);
  await scim('PATCH', `/Users/${c.body.id}`, { body: patchOp({ op: 'replace', path: 'active', value: false }) });
  assert.equal(await call(), 401);
});

test('SSO sign-in after provisioning completes the same account; a deactivated one is refused', async () => {
  const c = await scim('POST', '/Users', { body: entraUser('sso@acme.test') });
  const provider = { slug: SLUG_A, name: 'Acme IdP', organizationId: ORG_A, emailDomains: 'acme.test' };
  const r = upsertFederatedUser({ claims: { sub: 'idp-sub-1', email: 'sso@acme.test', name: 'S' }, email: 'sso@acme.test', provider, req: {} });
  assert.ok(r.user, JSON.stringify(r));
  assert.equal(r.isNew, false);
  assert.equal(r.user.id, userRow('sso@acme.test').id);
  assert.equal(userRow('sso@acme.test').provider_id, 'idp-sub-1', 'the first sign-in binds the IdP subject');
  await scim('PATCH', `/Users/${c.body.id}`, { body: patchOp({ op: 'replace', path: 'active', value: false }) });
  assert.ok(userRow('sso@acme.test').disabled_at, 'completeFederatedLogin refuses on this flag');
});

test('idempotent re-provision: delete then create again; an account with access elsewhere is disabled, then restored', async () => {
  const c = await scim('POST', '/Users', { body: oktaUser('again@acme.test') });
  const firstId = userRow('again@acme.test').id;
  assert.equal((await scim('DELETE', `/Users/${c.body.id}`)).status, 204);
  assert.equal(userRow('again@acme.test'), undefined, 'an account this org owns, with nothing elsewhere, is deleted');
  assert.equal((await scim('GET', `/Users/${c.body.id}`)).status, 404);
  const c2 = await scim('POST', '/Users', { body: oktaUser('again@acme.test') });
  assert.equal(c2.status, 201);
  assert.notEqual(userRow('again@acme.test').id, firstId);

  // Same, but the person also works in another organization: the account is disabled, not deleted…
  const id = userRow('again@acme.test').id;
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')").run(WS_C, id);
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_member')").run(ORG_C, id);
  const session = sessionFor(id);
  assert.equal((await scim('DELETE', `/Users/${c2.body.id}`)).status, 204);
  assert.ok(userRow('again@acme.test').disabled_at);
  assert.equal(await whoami(session), 401);
  assert.equal(wsRole(WS_C, id), 'workspace_viewer', 'another organization\'s membership is not this one\'s to remove');
  // …and provisioning it again links the same account and switches it back on.
  const c3 = await scim('POST', '/Users', { body: oktaUser('again@acme.test') });
  assert.equal(c3.status, 201);
  assert.equal(userRow('again@acme.test').id, id);
  assert.equal(userRow('again@acme.test').disabled_at, null);
});

test('recent provisioning activity is recorded for the org, and never contains a token', async () => {
  const ev = await admin('GET', `/${ORG_A}/scim/events?limit=200`);
  assert.equal(ev.status, 200);
  const actions = new Set(ev.body.events.map((e) => e.action));
  for (const a of ['user.create', 'user.patch', 'user.delete', 'group.create', 'group.patch', 'token.created']) assert.ok(actions.has(a), a);
  assert.ok(ev.body.events.some((e) => e.status === 409), 'failures are recorded too');
  assert.ok(!JSON.stringify(ev.body).includes(tokenA));
  const evB = await admin('GET', `/${ORG_B}/scim/events`, undefined, sessionFor(ADMIN_B, WS_B));
  assert.ok(!evB.body.events.some((e) => /acme\.test/.test(e.resource || '')), 'events are per organization');
  // Lifecycle changes from the IdP reach the audit log too, and admin actions are audited as theirs.
  const audited = new Set(db.prepare("SELECT action FROM activity_log WHERE action LIKE 'scim_%'").all().map((r) => r.action));
  for (const a of ['scim_user_provisioned', 'scim_user_deactivated', 'scim_user_reactivated', 'scim_user_removed', 'scim_token_created', 'scim_token_revoked', 'scim_mapping_set']) assert.ok(audited.has(a), a);
  assert.ok(!db.prepare("SELECT details FROM activity_log WHERE action LIKE 'scim_%'").all().some((r) => String(r.details).includes(tokenA)));
  const users = await admin('GET', `/${ORG_A}/scim/users`);
  assert.ok(users.body.users.some((u) => u.user_name === 'ada@acme.test'));
});

// ---------------------------------------------------------------------------------------------
// Rate limits

test('rate limit: per organization, with Retry-After; one org cannot exhaust another\'s budget', async () => {
  const { perOrg } = scimRouter._limiters;
  const saved = perOrg.max;
  perOrg.reset();
  perOrg.max = 3;
  try {
    for (let i = 0; i < 3; i++) assert.equal((await scim('GET', '/ServiceProviderConfig')).status, 200);
    const r = await scim('GET', '/ServiceProviderConfig');
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.equal(r.body.status, '429');
    assert.equal((await scim('GET', '/ServiceProviderConfig', { token: tokenB })).status, 200, 'org B has its own budget');
  } finally { perOrg.max = saved; perOrg.reset(); }
});

test('rate limit: repeated bad tokens from one address are cut off', async () => {
  const { authFailures } = scimRouter._limiters;
  authFailures.reset();
  try {
    let last;
    for (let i = 0; i < 31; i++) last = await scim('GET', '/Users', { token: 'stscim_' + crypto.randomBytes(32).toString('base64url') });
    assert.equal(last.status, 429);
    assert.equal((await scim('GET', '/Users')).status, 429, 'even a good token waits once the address is blocked');
  } finally { authFailures.reset(); }
  assert.equal((await scim('GET', '/Users')).status, 200);
});

test('SlidingWindow counts per key and reports when the oldest hit expires', () => {
  const w = new SlidingWindow({ windowMs: 1000, max: 2 });
  assert.equal(w.hit('a', 0).ok, true);
  assert.equal(w.hit('a', 100).ok, true);
  const r = w.hit('a', 200);
  assert.equal(r.ok, false);
  assert.equal(r.retryAfter, 1);
  assert.equal(w.hit('b', 200).ok, true);
  assert.equal(w.hit('a', 1001).ok, true, 'the first hit has left the window');
});
