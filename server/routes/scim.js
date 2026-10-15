'use strict';

/*
 * SCIM 2.0 (RFC 7643 / RFC 7644) service provider, mounted at /scim/v2.
 *
 * An organization's identity provider (Okta, Microsoft Entra ID, OneLogin, JumpCloud…) calls this
 * with a provisioning token minted under Settings > User provisioning. The token IS the organization:
 * every query below is scoped by req.scimOrgId, which comes from the token row and nothing else, so
 * no id, filter or body field can reach a user or group of another organization — or any account
 * provisioning did not create or link (lib/scim/provision.js has the rules).
 *
 * Not an /api router: SCIM has its own media type (application/scim+json), its own error envelope
 * and its own authentication, and none of the session, tenancy or API-token machinery applies.
 */

const express = require('express');
const crypto = require('crypto');
const { db } = require('../db/database');
const { publicOrigin } = require('../lib/public-origin');
const { parseFilter, FilterError } = require('../lib/scim/filter');
const patch = require('../lib/scim/patch');
const prov = require('../lib/scim/provision');
const S = require('../lib/scim/schemas');
const { SlidingWindow } = require('../lib/scim/rate-limit');
const { audit } = require('../lib/audit');

const router = express.Router();

const TOKEN_PREFIX = 'stscim_';
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const SCIM_TYPE = 'application/scim+json; charset=utf-8';
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/*
 * Per-organization budget. The default is far above a steady-state sync (Entra runs a cycle every
 * 40 minutes) and comfortably absorbs an initial import, which both IdPs pace and retry on 429.
 */
const perOrg = new SlidingWindow({ windowMs: 60_000, max: Math.max(1, Number(process.env.SCIM_RATE_LIMIT) || 600) });
const authFailures = new SlidingWindow({ windowMs: 10 * 60_000, max: 30 });

// ---------------------------------------------------------------------------------------------
// Responses

function send(res, status, body) {
  res.status(status).set('Content-Type', SCIM_TYPE);
  if (body === undefined) return res.end();
  return res.send(JSON.stringify(body));
}

function scimError(res, status, detail, scimType) {
  return send(res, status, { schemas: [S.ERROR], status: String(status), ...(scimType ? { scimType } : {}), detail });
}

const baseUrl = (req) => `${publicOrigin(req)}/scim/v2`;
const iso = (sec) => new Date((sec || 0) * 1000).toISOString();

/** A provisioned user as a SCIM User resource. Unset attributes are omitted, as the RFC prefers. */
function userResource(req, su) {
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(su.user_id) || {};
  const base = baseUrl(req);
  const groups = db.prepare(`SELECT g.id, g.display_name FROM scim_group_members gm JOIN scim_groups g ON g.id = gm.group_id
                             WHERE gm.scim_user_id = ? AND g.organization_id = ? ORDER BY g.display_name`).all(su.id, su.organization_id);
  const r = { schemas: [S.USER], id: su.id };
  if (su.external_id) r.externalId = su.external_id;
  r.userName = su.user_name;
  if (su.given_name || su.family_name) {
    r.name = {};
    if (su.given_name) r.name.givenName = su.given_name;
    if (su.family_name) r.name.familyName = su.family_name;
    r.name.formatted = [su.given_name, su.family_name].filter(Boolean).join(' ');
  }
  if (su.display_name) r.displayName = su.display_name;
  if (user.email) r.emails = [{ value: user.email, type: 'work', primary: true }];
  r.active = !!su.active;
  r.groups = groups.map((g) => ({ value: g.id, display: g.display_name, $ref: `${base}/Groups/${g.id}` }));
  r.meta = { resourceType: 'User', created: iso(su.created_at), lastModified: iso(su.updated_at), location: `${base}/Users/${su.id}` };
  return r;
}

function groupResource(req, g, { withMembers = true } = {}) {
  const base = baseUrl(req);
  const r = { schemas: [S.GROUP], id: g.id, displayName: g.display_name };
  if (g.external_id) r.externalId = g.external_id;
  if (withMembers) {
    r.members = db.prepare(`SELECT su.id, su.user_name FROM scim_group_members gm JOIN scim_users su ON su.id = gm.scim_user_id
                            WHERE gm.group_id = ? AND su.organization_id = ? ORDER BY su.user_name`).all(g.id, g.organization_id)
      .map((m) => ({ value: m.id, display: m.user_name, $ref: `${base}/Users/${m.id}` }));
  }
  r.meta = { resourceType: 'Group', created: iso(g.created_at), lastModified: iso(g.updated_at), location: `${base}/Groups/${g.id}` };
  return r;
}

/*
 * attributes / excludedAttributes (RFC 7644 §3.4.2.5), at the top level. id and schemas are
 * "returned: always" and survive both. The core schema URN prefix is accepted on names.
 */
function attrList(raw) {
  if (!raw) return null;
  return String(raw).slice(0, 1000).split(',').map((a) => a.trim().toLowerCase()
    .replace(/^urn:ietf:params:scim:schemas:core:2\.0:(user|group):/, '').split('.')[0]).filter(Boolean);
}
function project(resource, attributes, excluded) {
  if (!attributes && !excluded) return resource;
  const out = {};
  for (const [k, v] of Object.entries(resource)) {
    const lk = k.toLowerCase();
    const always = lk === 'id' || lk === 'schemas';
    if (attributes && !always && !attributes.includes(lk)) continue;
    if (excluded && !always && excluded.includes(lk)) continue;
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Authentication: the provisioning token names the organization

function clientIp(req) { return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'; }

const lastUsedWrites = new Map();
function touchLastUsed(tokenId) {
  const now = Date.now();
  if (now - (lastUsedWrites.get(tokenId) || 0) < 60_000) return;
  lastUsedWrites.set(tokenId, now);
  if (lastUsedWrites.size > 10000) lastUsedWrites.clear();
  try { db.prepare("UPDATE scim_tokens SET last_used_at = strftime('%s','now') WHERE id = ?").run(tokenId); } catch { /* best-effort */ }
}

function authenticate(req, res, next) {
  const ip = clientIp(req);
  if (authFailures.blocked(ip)) {
    const r = authFailures.hit(ip);
    res.set('Retry-After', String(r.retryAfter));
    return scimError(res, 429, 'Too many failed authentication attempts. Try again later.');
  }
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization || '');
  const raw = m ? m[1] : '';
  const fail = () => {
    authFailures.hit(ip);
    res.set('WWW-Authenticate', 'Bearer realm="ScreenTinker SCIM"');
    return scimError(res, 401, 'A valid provisioning bearer token is required.');
  };
  if (!raw.startsWith(TOKEN_PREFIX) || raw.length > 200) return fail();
  const row = db.prepare(`SELECT t.id, t.organization_id, t.revoked_at, s.enabled
                            FROM scim_tokens t
                            JOIN organizations o ON o.id = t.organization_id
                            LEFT JOIN org_scim_settings s ON s.organization_id = t.organization_id
                           WHERE t.token_hash = ?`).get(hashToken(raw));
  if (!row || row.revoked_at) return fail();
  // A real token for an organization that has switched provisioning off: say so, so the admin
  // reading their IdP's error log knows which switch to look at.
  if (!row.enabled) return scimError(res, 403, 'User provisioning is turned off for this organization.');
  const budget = perOrg.hit(row.organization_id);
  if (!budget.ok) {
    res.set('Retry-After', String(budget.retryAfter));
    return scimError(res, 429, 'Too many provisioning requests. Retry after the indicated delay.');
  }
  req.scimOrgId = row.organization_id;
  touchLastUsed(row.id);
  next();
}

router.use(authenticate);
// Parsed AFTER authentication, so an anonymous caller cannot make us parse a megabyte of JSON.
router.use(express.json({ type: ['application/scim+json', 'application/json'], limit: '1mb' }));
router.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });

// ---------------------------------------------------------------------------------------------
// Discovery

router.get('/ServiceProviderConfig', (req, res) => send(res, 200, S.serviceProviderConfig(baseUrl(req))));

function listOf(resources) {
  return { schemas: [S.LIST], totalResults: resources.length, startIndex: 1, itemsPerPage: resources.length, Resources: resources };
}
router.get('/ResourceTypes', (req, res) => send(res, 200, listOf(S.resourceTypes(baseUrl(req)))));
router.get('/ResourceTypes/:id', (req, res) => {
  const r = S.resourceTypes(baseUrl(req)).find((t) => t.id === req.params.id);
  return r ? send(res, 200, r) : scimError(res, 404, 'Resource type not found.');
});
router.get('/Schemas', (req, res) => send(res, 200, listOf(S.schemas(baseUrl(req)))));
router.get('/Schemas/:id', (req, res) => {
  const r = S.schemas(baseUrl(req)).find((t) => t.id === req.params.id);
  return r ? send(res, 200, r) : scimError(res, 404, 'Schema not found.');
});

// ---------------------------------------------------------------------------------------------
// Listing: filter + pagination

function paging(q) {
  let startIndex = parseInt(q.startIndex, 10);
  if (!Number.isFinite(startIndex) || startIndex < 1) startIndex = 1;
  let count = parseInt(q.count, 10);
  if (!Number.isFinite(count)) count = 100;
  count = Math.min(Math.max(count, 0), S.MAX_RESULTS);
  return { startIndex, count };
}

/*
 * Each filterable attribute maps to a FIXED SQL fragment with one placeholder. The parsed value is
 * only ever bound, so nothing a filter says can become SQL; an attribute not in the map is refused.
 */
const USER_FILTERS = {
  username: { sql: 'su.user_name = ? COLLATE NOCASE', type: 'string' },
  externalid: { sql: 'su.external_id = ?', type: 'string' },
  id: { sql: 'su.id = ?', type: 'string' },
  emails: { sql: 'u.email = ?', type: 'string', lower: true },
  'emails.value': { sql: 'u.email = ?', type: 'string', lower: true },
  displayname: { sql: 'su.display_name = ? COLLATE NOCASE', type: 'string' },
  active: { sql: 'su.active = ?', type: 'boolean' },
};
const GROUP_FILTERS = {
  displayname: { sql: 'g.display_name = ? COLLATE NOCASE', type: 'string' },
  externalid: { sql: 'g.external_id = ?', type: 'string' },
  id: { sql: 'g.id = ?', type: 'string' },
  members: { sql: 'EXISTS (SELECT 1 FROM scim_group_members gm WHERE gm.group_id = g.id AND gm.scim_user_id = ?)', type: 'string' },
  'members.value': { sql: 'EXISTS (SELECT 1 FROM scim_group_members gm WHERE gm.group_id = g.id AND gm.scim_user_id = ?)', type: 'string' },
};

function whereFor(filterParam, map) {
  const terms = parseFilter(filterParam);
  const clauses = []; const params = [];
  for (const t of terms || []) {
    const f = map[t.attr];
    if (!f) throw new FilterError(`filtering on "${t.attr.slice(0, 64)}" is not supported`);
    if (f.type === 'boolean') {
      if (typeof t.value !== 'boolean') throw new FilterError(`${t.attr} compares with true or false`);
      params.push(t.value ? 1 : 0);
    } else {
      if (typeof t.value !== 'string') throw new FilterError(`${t.attr} compares with a quoted string`);
      params.push(f.lower ? t.value.toLowerCase() : t.value);
    }
    clauses.push(f.sql);
  }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
}

router.get('/Users', (req, res) => {
  const { sql, params } = whereFor(req.query.filter, USER_FILTERS);
  const { startIndex, count } = paging(req.query);
  const from = `FROM scim_users su JOIN users u ON u.id = su.user_id WHERE su.organization_id = ?${sql}`;
  const total = db.prepare(`SELECT COUNT(*) AS n ${from}`).get(req.scimOrgId, ...params).n;
  const rows = count ? db.prepare(`SELECT su.* ${from} ORDER BY su.created_at, su.id LIMIT ? OFFSET ?`)
    .all(req.scimOrgId, ...params, count, startIndex - 1) : [];
  const attributes = attrList(req.query.attributes);
  const excluded = attrList(req.query.excludedAttributes);
  send(res, 200, {
    schemas: [S.LIST], totalResults: total, startIndex, itemsPerPage: rows.length,
    Resources: rows.map((su) => project(userResource(req, su), attributes, excluded)),
  });
});

router.get('/Groups', (req, res) => {
  const { sql, params } = whereFor(req.query.filter, GROUP_FILTERS);
  const { startIndex, count } = paging(req.query);
  const from = `FROM scim_groups g WHERE g.organization_id = ?${sql}`;
  const total = db.prepare(`SELECT COUNT(*) AS n ${from}`).get(req.scimOrgId, ...params).n;
  const rows = count ? db.prepare(`SELECT g.* ${from} ORDER BY g.created_at, g.id LIMIT ? OFFSET ?`)
    .all(req.scimOrgId, ...params, count, startIndex - 1) : [];
  const attributes = attrList(req.query.attributes);
  const excluded = attrList(req.query.excludedAttributes);
  const withMembers = !(excluded && excluded.includes('members')) && !(attributes && !attributes.includes('members'));
  send(res, 200, {
    schemas: [S.LIST], totalResults: total, startIndex, itemsPerPage: rows.length,
    Resources: rows.map((g) => project(groupResource(req, g, { withMembers }), attributes, excluded)),
  });
});

// ---------------------------------------------------------------------------------------------
// Users

function loadUser(req) {
  const id = String(req.params.id || '');
  if (!ID_RE.test(id)) return null;
  return db.prepare('SELECT * FROM scim_users WHERE id = ? AND organization_id = ?').get(id, req.scimOrgId) || null;
}

function loadGroup(req) {
  const id = String(req.params.id || '');
  if (!ID_RE.test(id)) return null;
  return db.prepare('SELECT * FROM scim_groups WHERE id = ? AND organization_id = ?').get(id, req.scimOrgId) || null;
}

router.get('/Users/:id', (req, res) => {
  const su = loadUser(req);
  if (!su) return scimError(res, 404, 'Resource not found.');
  send(res, 200, project(userResource(req, su), attrList(req.query.attributes), attrList(req.query.excludedAttributes)));
});

router.post('/Users', (req, res) => {
  const state = patch.userFromResource(req.body);
  const su = prov.createUser(req.scimOrgId, state);
  prov.logEvent(req.scimOrgId, 'user.create', su.user_name, su.active ? null : 'created inactive', 201);
  auditLifecycle(req, 'scim_user_provisioned', su, { active: !!su.active });
  const body = userResource(req, su);
  res.set('Location', body.meta.location);
  send(res, 201, body);
});

router.put('/Users/:id', (req, res) => {
  const su = loadUser(req);
  if (!su) return scimError(res, 404, 'Resource not found.');
  const next = patch.userFromResource(req.body);
  // Omitted in a PUT means "as it is": a client that leaves `active` out must not reactivate
  // someone, and one that leaves `emails` out must not be read as removing the address.
  if (req.body.active === undefined) next.active = !!su.active;
  const updated = prov.updateUser(req.scimOrgId, su, next);
  prov.logEvent(req.scimOrgId, 'user.replace', updated.user_name, transition(su, updated), 200);
  if (transition(su, updated)) auditLifecycle(req, `scim_user_${transition(su, updated)}`, updated);
  send(res, 200, userResource(req, updated));
});

router.patch('/Users/:id', (req, res) => {
  const su = loadUser(req);
  if (!su) return scimError(res, 404, 'Resource not found.');
  const next = patch.applyUserPatch(prov.stateOf(su), req.body);
  const updated = prov.updateUser(req.scimOrgId, su, next);
  prov.logEvent(req.scimOrgId, 'user.patch', updated.user_name, transition(su, updated), 200);
  if (transition(su, updated)) auditLifecycle(req, `scim_user_${transition(su, updated)}`, updated);
  send(res, 200, userResource(req, updated));
});

/*
 * Lifecycle changes also go to the audit log (lib/audit.js), not only the provisioning activity
 * list: an account being created, switched off or removed by an outside system is exactly what an
 * audit trail is for. The actor is the identity provider, so there is no user id.
 */
function auditLifecycle(req, action, su, extra = {}) {
  audit(action, { ip: req.ip || null, details: { organization_id: req.scimOrgId, scim_user: su.user_name, user_id: su.user_id, ...extra } });
}

function transition(before, after) {
  if (before.active && !after.active) return 'deactivated';
  if (!before.active && after.active) return 'reactivated';
  return null;
}

router.delete('/Users/:id', (req, res) => {
  const su = loadUser(req);
  if (!su) return scimError(res, 404, 'Resource not found.');
  const outcome = prov.deleteUser(req.scimOrgId, su);
  prov.logEvent(req.scimOrgId, 'user.delete', su.user_name, outcome, 204);
  auditLifecycle(req, 'scim_user_removed', su, { outcome });
  send(res, 204);
});

// ---------------------------------------------------------------------------------------------
// Groups

router.get('/Groups/:id', (req, res) => {
  const g = loadGroup(req);
  if (!g) return scimError(res, 404, 'Resource not found.');
  const attributes = attrList(req.query.attributes);
  const excluded = attrList(req.query.excludedAttributes);
  const withMembers = !(excluded && excluded.includes('members')) && !(attributes && !attributes.includes('members'));
  send(res, 200, project(groupResource(req, g, { withMembers }), attributes, excluded));
});

router.post('/Groups', (req, res) => {
  const g = patch.groupFromResource(req.body);
  const row = prov.createGroup(req.scimOrgId, g);
  prov.logEvent(req.scimOrgId, 'group.create', row.display_name, null, 201);
  const body = groupResource(req, row);
  res.set('Location', body.meta.location);
  send(res, 201, body);
});

router.put('/Groups/:id', (req, res) => {
  const g = loadGroup(req);
  if (!g) return scimError(res, 404, 'Resource not found.');
  const next = patch.groupFromResource(req.body);
  const row = prov.updateGroup(req.scimOrgId, g, next);
  prov.logEvent(req.scimOrgId, 'group.replace', row.display_name, null, 200);
  send(res, 200, groupResource(req, row));
});

router.patch('/Groups/:id', (req, res) => {
  const g = loadGroup(req);
  if (!g) return scimError(res, 404, 'Resource not found.');
  const before = new Set(prov.groupMemberIds(g.id));
  const next = patch.applyGroupPatch({ displayName: g.display_name, externalId: g.external_id, members: before }, req.body);
  const row = prov.updateGroup(req.scimOrgId, g, next);
  const added = [...next.members].filter((id) => !before.has(id)).length;
  const removed = [...before].filter((id) => !next.members.has(id)).length;
  prov.logEvent(req.scimOrgId, 'group.patch', row.display_name, added || removed ? `+${added} -${removed} members` : null, 200);
  /*
   * 204 when nothing was asked back. Entra and Okta both accept either; returning the full group
   * would mean listing every member after every single-member change, which for a 5,000-person
   * group is the whole membership on every one of 5,000 PATCHes.
   */
  if (req.query.attributes || req.query.excludedAttributes) {
    return send(res, 200, project(groupResource(req, row), attrList(req.query.attributes), attrList(req.query.excludedAttributes)));
  }
  send(res, 204);
});

router.delete('/Groups/:id', (req, res) => {
  const g = loadGroup(req);
  if (!g) return scimError(res, 404, 'Resource not found.');
  prov.deleteGroup(req.scimOrgId, g);
  prov.logEvent(req.scimOrgId, 'group.delete', g.display_name, null, 204);
  send(res, 204);
});

// ---------------------------------------------------------------------------------------------
// Everything else

router.all(['/Bulk', '/Me'], (req, res) => scimError(res, 501, 'Not supported by this service provider.'));
router.use((req, res) => scimError(res, 404, 'Endpoint not found.'));

// Express 5 forwards a throw from a handler here. Every known failure becomes a SCIM error; the
// rest is a generic 500 with the detail in the log, never in the response.
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed')) return scimError(res, 400, 'The request body is not valid JSON.', 'invalidSyntax');
  if (err && err.type === 'entity.too.large') return scimError(res, 413, 'The request body is too large.');
  let status = 500; let detail = 'Internal error.'; let scimType = null;
  if (err instanceof FilterError) { status = 400; detail = err.message; scimType = 'invalidFilter'; }
  else if (err instanceof patch.PatchError) { status = err.status || 400; detail = err.message; scimType = err.scimType; }
  else if (err instanceof prov.ScimError) { status = err.status; detail = err.message; scimType = err.scimType; }
  else console.error('[scim] %s %s failed:', req.method, req.path, err && err.message);
  if (req.scimOrgId && req.method !== 'GET') {
    prov.logEvent(req.scimOrgId, `${resourceOf(req.path)}.${req.method.toLowerCase()}`, null, detail, status);
  }
  return scimError(res, status, detail, scimType);
});

function resourceOf(p) { return /^\/Groups/i.test(p) ? 'group' : 'user'; }

module.exports = router;
module.exports.TOKEN_PREFIX = TOKEN_PREFIX;
module.exports.hashToken = hashToken;
module.exports._limiters = { perOrg, authFailures };
