'use strict';

/*
 * SCIM PATCH (RFC 7644 §3.5.2), as the identity providers that matter actually send it.
 *
 * Pure: every function here takes a plain state object and the request's Operations and returns a
 * new state, so the quirks below are tested directly rather than through a live IdP.
 *
 * The quirks, each of which breaks a by-the-book implementation:
 *
 *   - Microsoft Entra ID capitalises op names ("Replace", "Add", "Remove") and sends booleans as
 *     STRINGS: {"op":"Replace","path":"active","value":"False"}. "False" is truthy in JavaScript, so
 *     a naive `!!value` re-ACTIVATES the account it was told to deactivate.
 *   - Entra removes group members with path "members" and the ids in `value`
 *     ({"op":"Remove","path":"members","value":[{"value":"<id>"}]}), not with a value-path filter.
 *   - Entra addresses single values through filters: `emails[type eq "work"].value`.
 *   - Okta, and Entra in places, send `replace` with NO path and an object value, sometimes with
 *     dotted keys inside it: {"op":"replace","value":{"active":false}} or
 *     {"op":"replace","value":{"name.givenName":"Ada"}}. Okta's group rename also carries the
 *     group's own `id` in that object, which must be ignored rather than refused.
 *   - Okta removes members with a value-path filter: {"op":"remove","path":"members[value eq "<id>"]"}.
 *
 * Attributes we do not store (phoneNumbers, addresses, the enterprise extension, …) are accepted and
 * ignored. Refusing them would make provisioning fail outright for every customer whose IdP maps a
 * phone number, which helps nobody; storing them would be keeping personal data we have no use for.
 */

const { parseValuePath, FilterError } = require('./filter');

class PatchError extends Error {
  constructor(message, scimType = 'invalidValue', status = 400) {
    super(message); this.name = 'PatchError'; this.scimType = scimType; this.status = status;
  }
}

const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const MAX_OPERATIONS = 1000;

/** Booleans the way IdPs send them: true/false, or the strings "True"/"False" (Entra). */
function toBool(v) {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  throw new PatchError('active must be a boolean');
}

function str(v, name, max = 256) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' && typeof v !== 'number') throw new PatchError(`${name} must be a string`);
  // Control characters (CR/LF above all) have no place in a name and reach logs and mail subjects.
  const s = String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  if (s.length > max) throw new PatchError(`${name} is too long`);
  return s;
}

/** Validate the envelope and return the normalised operation list. */
function operationsOf(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PatchError('request body must be a PatchOp object', 'invalidSyntax');
  if (body.schemas !== undefined) {
    if (!Array.isArray(body.schemas) || !body.schemas.includes(PATCH_SCHEMA)) {
      throw new PatchError(`schemas must include ${PATCH_SCHEMA}`, 'invalidSyntax');
    }
  }
  // "Operations" per the RFC; a lowercase key is seen in the wild and costs nothing to accept.
  const ops = body.Operations || body.operations;
  if (!Array.isArray(ops) || !ops.length) throw new PatchError('Operations must be a non-empty array', 'invalidSyntax');
  if (ops.length > MAX_OPERATIONS) throw new PatchError('too many operations', 'tooMany');
  return ops.map((o) => {
    if (!o || typeof o !== 'object') throw new PatchError('each operation must be an object', 'invalidSyntax');
    const op = String(o.op || '').toLowerCase();
    if (!['add', 'replace', 'remove'].includes(op)) throw new PatchError(`unsupported op "${String(o.op).slice(0, 16)}"`, 'invalidSyntax');
    const path = o.path === undefined || o.path === null ? null : String(o.path).trim();
    if (op === 'remove' && !path) throw new PatchError('remove requires a path', 'noTarget');
    if (op !== 'remove' && o.value === undefined) throw new PatchError(`${op} requires a value`, 'invalidValue');
    return { op, path: path || null, value: o.value };
  });
}

/** Drop the core schema URN prefix from a path; leave any other URN (an extension) intact. */
function stripCore(path, schema) {
  const p = String(path);
  if (p.toLowerCase().startsWith(`${schema.toLowerCase()}:`)) return p.slice(schema.length + 1);
  return p;
}

/*
 * Flatten a no-path add/replace into path operations. A key may itself be dotted ("name.givenName")
 * or a nested object ({ name: { givenName } }); an extension URN key carries its own sub-object and
 * is ignored with everything else we do not store.
 */
function flatten(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PatchError('an operation without a path needs an object value', 'invalidValue');
  const out = [];
  for (const [k, v] of Object.entries(value)) {
    if (k === 'name' && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) out.push([`name.${k2}`, v2]);
    } else out.push([k, v]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Users

/** The parts of a User we keep. `email` is the work address; `active` a real boolean. */
function emptyUser() {
  return { userName: null, externalId: null, displayName: null, givenName: null, familyName: null, email: null, active: true };
}

/** Pick the address to key the account on: the primary email, else a work one, else the first. */
function pickEmail(emails) {
  if (!Array.isArray(emails) || !emails.length) return null;
  const valid = emails.filter((e) => e && typeof e === 'object' && typeof e.value === 'string');
  const pick = valid.find((e) => e.primary === true || String(e.primary).toLowerCase() === 'true')
    || valid.find((e) => String(e.type || '').toLowerCase() === 'work')
    || valid[0];
  return pick ? pick.value.trim().toLowerCase() : null;
}

/** Set one user attribute by (core-relative, lowercased) path. Unknown attributes are ignored. */
function setUserAttr(state, path, value, op) {
  const removing = op === 'remove';
  const p = path.toLowerCase();
  switch (p) {
    case 'username':
      if (removing) throw new PatchError('userName is required and cannot be removed', 'mutability');
      state.userName = str(value, 'userName'); return;
    case 'externalid': state.externalId = removing ? null : str(value, 'externalId'); return;
    case 'displayname': state.displayName = removing ? null : str(value, 'displayName'); return;
    case 'name.givenname': state.givenName = removing ? null : str(value, 'name.givenName'); return;
    case 'name.familyname': state.familyName = removing ? null : str(value, 'name.familyName'); return;
    case 'name.formatted': return; // derived from the parts; nothing of ours to keep
    case 'name':
      if (removing) { state.givenName = null; state.familyName = null; return; }
      if (!value || typeof value !== 'object') throw new PatchError('name must be an object');
      if (value.givenName !== undefined) state.givenName = str(value.givenName, 'name.givenName');
      if (value.familyName !== undefined) state.familyName = str(value.familyName, 'name.familyName');
      return;
    case 'active':
      if (removing) throw new PatchError('active cannot be removed', 'mutability');
      state.active = toBool(value); return;
    case 'emails':
      if (removing) throw new PatchError('the account email cannot be removed', 'mutability');
      {
        const e = pickEmail(Array.isArray(value) ? value : [value]);
        if (e) state.email = e;
      }
      return;
    default:
      return;
  }
}

function applyUserPatch(current, body) {
  const state = { ...current };
  for (const { op, path, value } of operationsOf(body)) {
    if (!path) {
      for (const [k, v] of flatten(value)) {
        if (k.toLowerCase() === 'id' || k.toLowerCase() === 'schemas' || k.toLowerCase() === 'meta') continue;
        const vp = k.includes('[') ? userValuePath(k) : null;
        if (vp) { if (vp === 'email') setEmailFromValuePath(state, v, op); continue; }
        setUserAttr(state, stripCore(k, USER_SCHEMA), v, op);
      }
      continue;
    }
    const p = stripCore(path, USER_SCHEMA);
    if (p.includes('[')) {
      const target = userValuePath(p);
      if (target === 'email') setEmailFromValuePath(state, value, op);
      continue;   // a value path into something we do not store (phoneNumbers[type eq "mobile"].value…)
    }
    setUserAttr(state, p, value, op);
  }
  return state;
}

/** `emails[type eq "work"].value` (or `emails[primary eq true].value`) → 'email'; others → null. */
function userValuePath(p) {
  let vp;
  try { vp = parseValuePath(p); } catch (e) {
    if (e instanceof FilterError) throw new PatchError(e.message, 'invalidPath');
    throw e;
  }
  if (!vp) throw new PatchError(`unsupported path "${String(p).slice(0, 80)}"`, 'invalidPath');
  if (vp.attr !== 'emails') return null;
  const okFilter = (vp.filter.attr === 'type' && String(vp.filter.value).toLowerCase() === 'work')
    || (vp.filter.attr === 'primary' && vp.filter.value === true);
  return okFilter && (vp.sub === 'value' || vp.sub === null) ? 'email' : null;
}

function setEmailFromValuePath(state, value, op) {
  if (op === 'remove') throw new PatchError('the account email cannot be removed', 'mutability');
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value.value : value;
  if (typeof v !== 'string' || !v.trim()) throw new PatchError('email value must be a string');
  state.email = v.trim().toLowerCase();
}

/** A full User resource (POST / PUT body) to our state. Missing optional attributes become null. */
function userFromResource(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PatchError('request body must be a User resource', 'invalidSyntax');
  const s = emptyUser();
  s.userName = str(body.userName, 'userName');
  if (!s.userName) throw new PatchError('userName is required', 'invalidValue');
  s.externalId = str(body.externalId, 'externalId');
  s.displayName = str(body.displayName, 'displayName');
  if (body.name && typeof body.name === 'object') {
    s.givenName = str(body.name.givenName, 'name.givenName');
    s.familyName = str(body.name.familyName, 'name.familyName');
  }
  s.email = pickEmail(body.emails);
  s.active = body.active === undefined ? true : toBool(body.active);
  return s;
}

// ---------------------------------------------------------------------------------------------
// Groups

/** Member ids from a value that may be an array of {value}, one {value}, or (rarely) a bare id. */
function memberIds(value) {
  const list = Array.isArray(value) ? value : [value];
  return list.map((m) => {
    const id = m && typeof m === 'object' ? m.value : m;
    if (typeof id !== 'string' || !id.trim() || id.length > 128) throw new PatchError('each member needs a string value');
    return id.trim();
  });
}

/**
 * Apply a Group PATCH. `state.members` is a Set of SCIM user ids; the caller validates that every
 * added id is a user of this organization (an unknown one is an error, not a silent skip — that is
 * how a mis-scoped push gets noticed).
 */
function applyGroupPatch(current, body) {
  const state = { ...current, members: new Set(current.members) };
  const setGroupAttr = (attr, value, op) => {
    const a = attr.toLowerCase();
    if (a === 'displayname') {
      if (op === 'remove') throw new PatchError('displayName is required and cannot be removed', 'mutability');
      const name = str(value, 'displayName');
      if (!name) throw new PatchError('displayName cannot be empty');
      state.displayName = name;
    } else if (a === 'externalid') {
      state.externalId = op === 'remove' ? null : str(value, 'externalId');
    } else if (a === 'members') {
      if (op === 'remove') {
        if (value === undefined || value === null) state.members.clear();
        else for (const id of memberIds(value)) state.members.delete(id);
      } else if (op === 'replace') {
        state.members = new Set(value === null ? [] : memberIds(value));
      } else {
        for (const id of memberIds(value)) state.members.add(id);
      }
    }
    // id, schemas, meta and anything unknown: ignored (Okta sends the group's own id here).
  };

  for (const { op, path, value } of operationsOf(body)) {
    if (!path) {
      for (const [k, v] of flatten(value)) setGroupAttr(stripCore(k, GROUP_SCHEMA), v, op);
      continue;
    }
    const p = stripCore(path, GROUP_SCHEMA);
    if (p.includes('[')) {
      let vp;
      try { vp = parseValuePath(p); } catch (e) {
        if (e instanceof FilterError) throw new PatchError(e.message, 'invalidPath');
        throw e;
      }
      if (!vp || vp.attr !== 'members' || vp.filter.attr !== 'value' || vp.sub) {
        throw new PatchError(`unsupported path "${p.slice(0, 80)}"`, 'invalidPath');
      }
      if (op !== 'remove') throw new PatchError('only remove is supported on a member value path', 'invalidPath');
      state.members.delete(String(vp.filter.value));
      continue;
    }
    setGroupAttr(p, value, op);
  }
  return state;
}

function groupFromResource(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PatchError('request body must be a Group resource', 'invalidSyntax');
  const displayName = str(body.displayName, 'displayName');
  if (!displayName) throw new PatchError('displayName is required');
  return {
    displayName,
    externalId: str(body.externalId, 'externalId'),
    // null = "not sent". A PUT that only renames must not empty the group and strip everyone's
    // access; the route keeps the current members in that case.
    members: body.members === undefined || body.members === null ? null : new Set(memberIds(body.members)),
  };
}

module.exports = {
  PatchError, toBool, operationsOf, applyUserPatch, userFromResource, applyGroupPatch, groupFromResource,
  pickEmail, emptyUser, PATCH_SCHEMA, USER_SCHEMA, GROUP_SCHEMA,
};
