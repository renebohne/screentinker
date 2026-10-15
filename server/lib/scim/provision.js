'use strict';

/*
 * SCIM provisioning: what an organization's identity provider is allowed to do to ScreenTinker
 * accounts, and how group membership becomes workspace access.
 *
 * ⚠️ THE TRUST MODEL. A SCIM token is held by a CUSTOMER's identity provider. It is exactly as
 * trustworthy as that customer's own SSO provider — and per-org SSO already had to learn, twice, that
 * a customer-controlled identity source is an account-takeover primitive unless it is confined. So
 * provisioning inherits SSO's confinement rules rather than inventing looser ones:
 *
 *   - It may only provision addresses at a DNS-VERIFIED sign-in domain of its own organization
 *     (the same set lib/oidc-providers.js lets that organization's SSO assert).
 *   - It never touches a platform account (any role but 'user'), never grants an organization role,
 *     never changes or removes the organization owner, and never sees a user it did not provision.
 *   - An existing account is linked only where an SSO sign-in by the same organization would adopt
 *     it (routes/auth.js upsertFederatedUser): already this organization's, a local account with no
 *     password, or an SSO-only organization's verified domain. An account that is already a member
 *     of the organization may also be linked — the organization already holds it — but then only
 *     its access INSIDE the organization is managed, never the account itself.
 *   - Only an account whose sign-in this organization OWNS (users.auth_provider is one of its SSO
 *     providers) can be disabled or deleted outright. Everyone else just loses access here.
 *
 * Every function takes the organization id from the authenticated token, never from the request.
 */

const crypto = require('crypto');
const { db } = require('../../db/database');
const config = require('../../config');
const oidcProviders = require('../oidc-providers');
const { bumpTokenVersion } = require('../../middleware/auth');
const { releaseWorkspaceMember, deleteUserCascade, OrgHasOtherMembersError } = require('../user-deletion');

class ScimError extends Error {
  constructor(status, detail, scimType = null) {
    super(detail); this.name = 'ScimError'; this.status = status; this.scimType = scimType;
  }
}

const WORKSPACE_ROLES = ['workspace_viewer', 'workspace_editor', 'workspace_admin'];
const rank = (r) => WORKSPACE_ROLES.indexOf(r);
const maxRole = (a, b) => (!a ? b : !b ? a : (rank(a) >= rank(b) ? a : b));

// Same shape routes/auth.js accepts from an identity provider: one @, no whitespace or control
// characters, a dotted lowercase domain. An address that is not one thing is not an account key.
const EMAIL_RE = /^[^\s@\x00-\x1f]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const nowSec = () => Math.floor(Date.now() / 1000);
const domainOf = (email) => email.slice(email.lastIndexOf('@') + 1);

// ---------------------------------------------------------------------------------------------
// Settings and the activity log

function settingsFor(orgId) {
  return db.prepare('SELECT * FROM org_scim_settings WHERE organization_id = ?').get(orgId) || null;
}

const MAX_EVENTS_PER_ORG = 500;
function logEvent(orgId, action, resource, detail, status) {
  try {
    db.prepare('INSERT INTO scim_events (organization_id, action, resource, detail, status) VALUES (?, ?, ?, ?, ?)')
      .run(orgId, action, resource ? String(resource).slice(0, 200) : null, detail ? String(detail).slice(0, 500) : null, status || null);
    db.prepare(`DELETE FROM scim_events WHERE organization_id = ? AND id <= (
      SELECT id FROM scim_events WHERE organization_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`)
      .run(orgId, orgId, MAX_EVENTS_PER_ORG);
  } catch (e) { /* the activity list must never break provisioning */ }
}

// ---------------------------------------------------------------------------------------------
// Who is who

/** The enabled SSO provider of THIS organization that has proved the address's domain. */
function providerForEmail(orgId, email) {
  return db.prepare(`
    SELECT p.* FROM org_sso_domains d JOIN org_sso_providers p ON p.id = d.provider_id
     WHERE d.organization_id = ? AND d.domain = ? AND d.verified_at IS NOT NULL AND p.enabled = 1
     ORDER BY p.created_at LIMIT 1`).get(orgId, domainOf(email)) || null;
}

/** Does this organization's SSO own how the account signs in? Read live, never cached. */
function ownsIdentity(orgId, user) {
  const owner = user ? oidcProviders.ownerOf(user.auth_provider) : null;
  return !!(owner && owner.organizationId && owner.organizationId === orgId);
}

function isOrgOwner(orgId, userId) {
  const o = db.prepare('SELECT owner_user_id FROM organizations WHERE id = ?').get(orgId);
  if (o && o.owner_user_id === userId) return true;
  return !!db.prepare("SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ? AND role = 'org_owner'").get(orgId, userId);
}

function isMemberOfOrg(orgId, userId) {
  return !!(db.prepare('SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?').get(orgId, userId)
    || db.prepare('SELECT 1 FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id WHERE w.organization_id = ? AND wm.user_id = ?').get(orgId, userId));
}

/** The address an IdP means: the primary/work email, else a userName that is an address. */
function emailFor(state) {
  const raw = state.email || (state.userName && state.userName.includes('@') ? state.userName : null);
  return raw ? String(raw).trim().toLowerCase() : null;
}

function displayNameOf(state) {
  return (state.displayName || [state.givenName, state.familyName].filter(Boolean).join(' ') || '').slice(0, 200);
}

/*
 * Find the account for a new provisioning, or create it. Mirrors upsertFederatedUser's rules for an
 * ORGANIZATION provider (see the header); returns the user id. Runs inside the caller's transaction.
 */
function linkOrCreateAccount(orgId, state) {
  const email = emailFor(state);
  if (!email || !EMAIL_RE.test(email)) {
    throw new ScimError(400, 'A work email address is required (emails, or a userName that is an email address).', 'invalidValue');
  }
  const provider = providerForEmail(orgId, email);
  if (!provider) {
    throw new ScimError(400, `${domainOf(email)} is not a verified sign-in domain of this organization's single sign-on. `
      + 'Verify the domain under Settings > Single sign-on first.', 'invalidValue');
  }

  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!existing) {
    const id = crypto.randomUUID();
    /*
     * No password, ever: the account signs in through the organization's SSO, which is what
     * auth_provider says. provider_id (the IdP subject) is filled in by the first SSO sign-in —
     * upsertFederatedUser takes the same-provider, no-subject-yet branch. email_verified, because
     * the domain is proved by DNS, which is the trust a verification mail would establish.
     * Never a platform role: provisioning creates ordinary accounts and nothing else.
     */
    db.prepare(`INSERT INTO users (id, email, name, auth_provider, provider_id, role, plan_id, email_verified)
                VALUES (?, ?, ?, ?, NULL, 'user', ?, 1)`)
      .run(id, email, displayNameOf(state), provider.slug, config.selfHosted ? 'enterprise' : 'free');
    try { require('../conversion-events').record(db, { userId: id, event: 'signup', meta: { method: 'scim' } }); } catch (_) { /* hosted funnel only */ }
    return { userId: id, created: true };
  }

  // Platform staff are the operator's, not a customer's. Refused outright, whatever the domain.
  if (existing.role !== 'user') {
    throw new ScimError(409, 'An account with this address exists and cannot be managed by provisioning.', 'uniqueness');
  }
  if (db.prepare('SELECT 1 FROM scim_users WHERE organization_id = ? AND user_id = ?').get(orgId, existing.id)) {
    throw new ScimError(409, 'This address is already provisioned under another userName.', 'uniqueness');
  }

  if (ownsIdentity(orgId, existing)) return { userId: existing.id, created: false };

  const member = isMemberOfOrg(orgId, existing.id);
  if (existing.password_hash) {
    // The one case SSO adopts a password account: this organization requires SSO for this
    // verified domain, so the password is already refused by policy (routes/auth.js).
    const enforced = oidcProviders.ssoOnlyForEmail(email);
    if (enforced && enforced.organization_id === orgId) {
      db.prepare('UPDATE users SET password_hash = NULL, auth_provider = ?, provider_id = NULL WHERE id = ?').run(provider.slug, existing.id);
      return { userId: existing.id, created: false, adopted: true };
    }
    if (member) return { userId: existing.id, created: false };
    throw new ScimError(409, 'An account with this address already exists outside this organization. Its owner can join by '
      + 'linking it to your single sign-on from their account settings, or by accepting an invitation.', 'uniqueness');
  }
  if (existing.auth_provider === 'local') {
    // Invited, never set a password: SSO adopts these, and so does provisioning.
    db.prepare('UPDATE users SET auth_provider = ?, provider_id = NULL WHERE id = ?').run(provider.slug, existing.id);
    return { userId: existing.id, created: false, adopted: true };
  }
  if (member) return { userId: existing.id, created: false };
  throw new ScimError(409, 'An account with this address signs in through another identity provider and is not part of this organization.', 'uniqueness');
}

// ---------------------------------------------------------------------------------------------
// Access: groups -> workspace roles

/*
 * Scale-out: a workspace COPIED from a primary (origin_node_id set) is written only by its primary,
 * so provisioning never grants into one — the IdP belongs pointed at the primary. Detected once, so
 * a database without the mesh columns still works.
 */
let LOCAL_WS_CACHE = null;
function localWsClause() {
  if (LOCAL_WS_CACHE === null) {
    try { LOCAL_WS_CACHE = db.prepare('PRAGMA table_info(workspaces)').all().some((c) => c.name === 'origin_node_id') ? ' AND w.origin_node_id IS NULL' : ''; }
    catch { LOCAL_WS_CACHE = ''; }
  }
  return LOCAL_WS_CACHE;
}

/** The workspace roles a provisioned person should hold in this organization right now. */
function desiredAccess(orgId, scimUser) {
  const LOCAL_WS = localWsClause();
  const want = new Map();
  if (!scimUser || !scimUser.active) return want;
  const s = settingsFor(orgId);
  if (s && s.default_workspace_id && WORKSPACE_ROLES.includes(s.default_role)) {
    const ws = db.prepare(`SELECT w.id FROM workspaces w WHERE w.id = ? AND w.organization_id = ?${LOCAL_WS}`).get(s.default_workspace_id, orgId);
    if (ws) want.set(ws.id, s.default_role);
  }
  const rows = db.prepare(`
    SELECT m.workspace_id, m.role FROM scim_group_members gm
      JOIN scim_group_mappings m ON m.group_id = gm.group_id
      JOIN workspaces w ON w.id = m.workspace_id AND w.organization_id = ?${LOCAL_WS}
     WHERE gm.scim_user_id = ? AND m.organization_id = ?`).all(orgId, scimUser.id, orgId);
  for (const r of rows) {
    if (WORKSPACE_ROLES.includes(r.role)) want.set(r.workspace_id, maxRole(want.get(r.workspace_id), r.role));
  }
  return want;
}

/*
 * Bring one person's workspace memberships in line with their groups.
 *
 * Only memberships provisioning is responsible for (scim_workspace_grants) are ever removed. One an
 * admin granted by hand is never lowered: a group can raise it, and when the group stops applying
 * the hand-granted role is put back. That keeps "remove from the group" meaning exactly "take away
 * what the group gave", which is what an admin reading the mapping table expects.
 *
 * Returns the workspaces whose membership was removed, so the caller can drop live sockets after
 * the transaction commits.
 */
function reconcileUser(orgId, userId) {
  const su = db.prepare('SELECT * FROM scim_users WHERE organization_id = ? AND user_id = ?').get(orgId, userId);
  const want = desiredAccess(orgId, su);
  const grants = db.prepare('SELECT * FROM scim_workspace_grants WHERE organization_id = ? AND user_id = ?').all(orgId, userId);
  const memberRow = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?');
  const removed = [];

  for (const g of grants) {
    if (want.has(g.workspace_id)) continue;
    const wm = memberRow.get(g.workspace_id, userId);
    if (g.prior_role) {
      if (wm) db.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?').run(g.prior_role, g.workspace_id, userId);
    } else if (wm) {
      db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(g.workspace_id, userId);
      releaseWorkspaceMember(db, { userId, workspaceIds: [g.workspace_id] });
      removed.push(g.workspace_id);
    }
    db.prepare('DELETE FROM scim_workspace_grants WHERE workspace_id = ? AND user_id = ?').run(g.workspace_id, userId);
  }

  const grantOf = new Map(grants.map((g) => [g.workspace_id, g]));
  for (const [wsId, role] of want) {
    const g = grantOf.get(wsId);
    const wm = memberRow.get(wsId, userId);
    if (g) {
      const effective = maxRole(g.prior_role, role);
      if (!wm) {
        db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)").run(wsId, userId, effective);
      } else if (wm.role !== effective) {
        db.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?').run(effective, wsId, userId);
      }
      if (g.role !== role) db.prepare('UPDATE scim_workspace_grants SET role = ? WHERE workspace_id = ? AND user_id = ?').run(role, wsId, userId);
    } else if (wm) {
      const effective = maxRole(wm.role, role);
      if (effective !== wm.role) db.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?').run(effective, wsId, userId);
      db.prepare('INSERT INTO scim_workspace_grants (workspace_id, user_id, organization_id, role, prior_role) VALUES (?, ?, ?, ?, ?)')
        .run(wsId, userId, orgId, role, wm.role);
    } else {
      db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)").run(wsId, userId, role);
      db.prepare('INSERT INTO scim_workspace_grants (workspace_id, user_id, organization_id, role, prior_role) VALUES (?, ?, ?, ?, NULL)')
        .run(wsId, userId, orgId, role);
    }
  }
  return removed;
}

/** Re-apply every provisioned person in the organization (after a mapping or default changes). */
function reconcileOrg(orgId) {
  const removed = [];
  db.transaction(() => {
    for (const r of db.prepare('SELECT user_id FROM scim_users WHERE organization_id = ?').all(orgId)) {
      for (const ws of reconcileUser(orgId, r.user_id)) removed.push([r.user_id, ws]);
    }
  })();
  afterAccessRemoved(removed);
  return removed.length;
}

/** After COMMIT: take removed members out of the workspaces' live socket rooms. */
function afterAccessRemoved(pairs) {
  for (const [userId, wsId] of pairs) {
    try { require('../../ws/dashboardSocket').dropUserFromWorkspace(userId, wsId); } catch (_) { /* no socket server (tests, scripts) */ }
  }
}

function endSessions(userId) {
  bumpTokenVersion(userId);
  try { require('../../ws/dashboardSocket').disconnectUserSockets(userId); } catch (_) { /* best-effort */ }
}

// ---------------------------------------------------------------------------------------------
// Deactivation: the IdP's "this person has left"

/*
 * Take everything this person holds in the organization away, remembering it so a reactivation can
 * give it back. Group access goes through reconcile (active is already 0); hand-granted workspace
 * memberships and the organization membership are snapshotted into scim_users.suspended.
 * Runs inside the caller's transaction; returns removed [userId, wsId] pairs.
 */
function suspendAccess(orgId, su) {
  if (isOrgOwner(orgId, su.user_id)) {
    throw new ScimError(400, 'The organization owner cannot be deactivated or removed by provisioning.', 'mutability');
  }
  // The organization role goes FIRST: releaseWorkspaceMember keeps an org admin's integrations
  // (they still reach every workspace through that role), which is no longer true from here on.
  const om = db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?').get(orgId, su.user_id);
  if (om) db.prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?').run(orgId, su.user_id);
  db.prepare("UPDATE scim_users SET active = 0, updated_at = strftime('%s','now') WHERE id = ?").run(su.id);
  const removed = reconcileUser(orgId, su.user_id).map((ws) => [su.user_id, ws]);

  const wsRows = db.prepare(`SELECT wm.workspace_id, wm.role FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
                              WHERE w.organization_id = ? AND wm.user_id = ?`).all(orgId, su.user_id);
  const prev = su.suspended ? safeJson(su.suspended) : null;
  const snapshot = {
    org_role: om ? om.role : (prev && prev.org_role) || null,
    workspaces: [...((prev && prev.workspaces) || []), ...wsRows.map((r) => ({ workspace_id: r.workspace_id, role: r.role }))],
  };
  for (const r of wsRows) {
    db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(r.workspace_id, su.user_id);
    removed.push([su.user_id, r.workspace_id]);
  }
  if (wsRows.length) releaseWorkspaceMember(db, { userId: su.user_id, workspaceIds: wsRows.map((r) => r.workspace_id) });
  db.prepare('UPDATE scim_users SET suspended = ? WHERE id = ?').run(JSON.stringify(snapshot), su.id);
  return removed;
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

function deactivate(orgId, su) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(su.user_id);
  const removed = suspendAccess(orgId, su);
  // Only the organization that owns how this account signs in may switch the account itself off.
  if (user && ownsIdentity(orgId, user)) {
    db.prepare('UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL').run(nowSec(), user.id);
  }
  return removed;
}

function reactivate(orgId, su) {
  const snap = su.suspended ? safeJson(su.suspended) : null;
  // The org role comes back as it was, but never as owner — that is not provisioning's to give.
  const orgRole = snap && ['org_admin', 'org_member'].includes(snap.org_role) ? snap.org_role : 'org_member';
  db.prepare('INSERT OR IGNORE INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(orgId, su.user_id, orgRole);
  for (const w of (snap && snap.workspaces) || []) {
    if (!WORKSPACE_ROLES.includes(w.role)) continue;
    const ws = db.prepare('SELECT id FROM workspaces WHERE id = ? AND organization_id = ?').get(w.workspace_id, orgId);
    if (ws) db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(ws.id, su.user_id, w.role);
  }
  db.prepare("UPDATE scim_users SET active = 1, suspended = NULL, updated_at = strftime('%s','now') WHERE id = ?").run(su.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(su.user_id);
  if (user && user.disabled_at && ownsIdentity(orgId, user)) db.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(user.id);
}

// ---------------------------------------------------------------------------------------------
// Users: create / update / delete

function createUser(orgId, state) {
  let row; let removed = []; let ended = false;
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM scim_users WHERE organization_id = ? AND user_name = ? COLLATE NOCASE').get(orgId, state.userName)) {
      throw new ScimError(409, 'A user with this userName already exists.', 'uniqueness');
    }
    const { userId } = linkOrCreateAccount(orgId, state);
    db.prepare('INSERT OR IGNORE INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(orgId, userId, 'org_member');
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO scim_users (id, organization_id, user_id, user_name, external_id, display_name, given_name, family_name, active)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(id, orgId, userId, state.userName, state.externalId, state.displayName, state.givenName, state.familyName);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    // Re-provisioning an account this organization owns and once switched off switches it back on.
    if (state.active && user.disabled_at && ownsIdentity(orgId, user)) db.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(userId);
    row = db.prepare('SELECT * FROM scim_users WHERE id = ?').get(id);
    if (!state.active) { removed = deactivate(orgId, row); ended = true; } else removed = reconcileUser(orgId, userId).map((ws) => [userId, ws]);
    row = db.prepare('SELECT * FROM scim_users WHERE id = ?').get(id);
  })();
  afterAccessRemoved(removed);
  if (ended) endSessions(row.user_id);
  return row;
}

/** The editable state of a provisioned user, for PATCH to apply onto. */
function stateOf(su) {
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(su.user_id);
  return {
    userName: su.user_name, externalId: su.external_id, displayName: su.display_name,
    givenName: su.given_name, familyName: su.family_name, email: user ? user.email : null, active: !!su.active,
  };
}

function updateUser(orgId, su, next) {
  let removed = []; let ended = false;
  db.transaction(() => {
    if (!next.userName) throw new ScimError(400, 'userName is required.', 'invalidValue');
    if (next.userName.toLowerCase() !== su.user_name.toLowerCase()
      && db.prepare('SELECT 1 FROM scim_users WHERE organization_id = ? AND user_name = ? COLLATE NOCASE AND id != ?').get(orgId, next.userName, su.id)) {
      throw new ScimError(409, 'A user with this userName already exists.', 'uniqueness');
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(su.user_id);
    if (!user) throw new ScimError(404, 'Resource not found.');
    const owned = ownsIdentity(orgId, user);

    // A missing email in a PUT means "unchanged", never "remove the address the account keys on".
    const nextEmail = next.email ? String(next.email).trim().toLowerCase() : null;
    if (nextEmail && nextEmail !== user.email) {
      if (!owned) throw new ScimError(400, 'The email of an account this organization does not own cannot be changed by provisioning.', 'mutability');
      if (!EMAIL_RE.test(nextEmail)) throw new ScimError(400, 'That is not a valid email address.', 'invalidValue');
      if (!providerForEmail(orgId, nextEmail)) throw new ScimError(400, `${domainOf(nextEmail)} is not a verified sign-in domain of this organization.`, 'invalidValue');
      if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(nextEmail, user.id)) {
        throw new ScimError(409, 'Another account already uses that email address.', 'uniqueness');
      }
      db.prepare("UPDATE users SET email = ?, updated_at = strftime('%s','now') WHERE id = ?").run(nextEmail, user.id);
    }
    // The person's display name is the account's own only when this organization owns the account.
    const name = displayNameOf(next);
    if (owned && name && name !== user.name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);

    db.prepare(`UPDATE scim_users SET user_name = ?, external_id = ?, display_name = ?, given_name = ?, family_name = ?,
                updated_at = strftime('%s','now') WHERE id = ?`)
      .run(next.userName, next.externalId, next.displayName, next.givenName, next.familyName, su.id);

    const fresh = db.prepare('SELECT * FROM scim_users WHERE id = ?').get(su.id);
    if (su.active && !next.active) { removed = deactivate(orgId, fresh); ended = true; }
    else if (!su.active && next.active) { reactivate(orgId, fresh); removed = reconcileUser(orgId, su.user_id).map((ws) => [su.user_id, ws]); }
  })();
  afterAccessRemoved(removed);
  if (ended) endSessions(su.user_id);
  return db.prepare('SELECT * FROM scim_users WHERE id = ?').get(su.id);
}

/*
 * DELETE: the person is gone from this organization. Their access here goes, their provisioning
 * record goes, and — only for an account this organization owns — the account itself: deleted when
 * it has nothing anywhere else, otherwise disabled (the identity provider that signs it in has said
 * it no longer exists, so it must not keep signing in elsewhere either).
 */
function deleteUser(orgId, su) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(su.user_id);
  const owned = !!user && ownsIdentity(orgId, user);
  let removed = [];
  db.transaction(() => {
    removed = suspendAccess(orgId, su);
    db.prepare('DELETE FROM scim_users WHERE id = ?').run(su.id);
  })();
  afterAccessRemoved(removed);
  let outcome = 'access_removed';
  if (owned) {
    if (!hasAccessElsewhere(orgId, user.id)) {
      try {
        const org = db.prepare('SELECT owner_user_id FROM organizations WHERE id = ?').get(orgId);
        deleteUserCascade(db, { targetId: user.id, actingAdminId: org ? org.owner_user_id : null });
        outcome = 'account_deleted';
      } catch (e) {
        if (!(e instanceof OrgHasOtherMembersError)) throw e;
      }
    }
    if (outcome !== 'account_deleted') {
      db.prepare('UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL').run(nowSec(), user.id);
      outcome = 'account_disabled';
    }
  }
  if (outcome !== 'account_deleted') endSessions(su.user_id);
  return outcome;
}

/** Any membership outside this organization, other than a private org they alone use? */
function hasAccessElsewhere(orgId, userId) {
  const solo = new Set(require('../user-deletion').listOwnedOrgsWithSharing(db, userId).filter((o) => !o.shared).map((o) => o.id));
  const orgs = db.prepare(`
    SELECT organization_id AS id FROM organization_members WHERE user_id = ?
    UNION SELECT w.organization_id FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id WHERE wm.user_id = ?`)
    .all(userId, userId).map((r) => r.id);
  return orgs.some((id) => id !== orgId && !solo.has(id));
}

// ---------------------------------------------------------------------------------------------
// Groups

/** Every id must be a provisioned user of THIS organization; returns the matching rows. */
function resolveMembers(orgId, ids) {
  const out = [];
  for (const id of ids) {
    const su = db.prepare('SELECT id, user_id FROM scim_users WHERE id = ? AND organization_id = ?').get(id, orgId);
    if (!su) throw new ScimError(400, `member "${String(id).slice(0, 64)}" is not a provisioned user.`, 'invalidValue');
    out.push(su);
  }
  return out;
}

function assertGroupNameFree(orgId, name, exceptId = null) {
  const clash = db.prepare('SELECT id FROM scim_groups WHERE organization_id = ? AND display_name = ? COLLATE NOCASE').get(orgId, name);
  if (clash && clash.id !== exceptId) throw new ScimError(409, 'A group with this displayName already exists.', 'uniqueness');
}

function setGroupMembers(orgId, groupId, nextIds) {
  const before = new Map(db.prepare(`SELECT gm.scim_user_id, su.user_id FROM scim_group_members gm
    JOIN scim_users su ON su.id = gm.scim_user_id WHERE gm.group_id = ?`).all(groupId).map((r) => [r.scim_user_id, r.user_id]));
  const after = new Map(resolveMembers(orgId, [...nextIds]).map((r) => [r.id, r.user_id]));
  const touched = new Set();
  for (const [sid, uid] of before) if (!after.has(sid)) {
    db.prepare('DELETE FROM scim_group_members WHERE group_id = ? AND scim_user_id = ?').run(groupId, sid);
    touched.add(uid);
  }
  for (const [sid, uid] of after) if (!before.has(sid)) {
    db.prepare('INSERT OR IGNORE INTO scim_group_members (group_id, scim_user_id) VALUES (?, ?)').run(groupId, sid);
    touched.add(uid);
  }
  return touched;
}

function reconcileUsers(orgId, userIds) {
  const removed = [];
  for (const uid of userIds) for (const ws of reconcileUser(orgId, uid)) removed.push([uid, ws]);
  return removed;
}

function createGroup(orgId, g) {
  let id; let removed = [];
  db.transaction(() => {
    assertGroupNameFree(orgId, g.displayName);
    id = crypto.randomUUID();
    db.prepare('INSERT INTO scim_groups (id, organization_id, display_name, external_id) VALUES (?, ?, ?, ?)').run(id, orgId, g.displayName, g.externalId);
    removed = reconcileUsers(orgId, setGroupMembers(orgId, id, g.members || new Set()));
  })();
  afterAccessRemoved(removed);
  return db.prepare('SELECT * FROM scim_groups WHERE id = ?').get(id);
}

function updateGroup(orgId, group, next) {
  let removed = [];
  db.transaction(() => {
    if (next.displayName.toLowerCase() !== group.display_name.toLowerCase()) assertGroupNameFree(orgId, next.displayName, group.id);
    db.prepare("UPDATE scim_groups SET display_name = ?, external_id = ?, updated_at = strftime('%s','now') WHERE id = ?")
      .run(next.displayName, next.externalId, group.id);
    if (next.members) removed = reconcileUsers(orgId, setGroupMembers(orgId, group.id, next.members));
  })();
  afterAccessRemoved(removed);
  return db.prepare('SELECT * FROM scim_groups WHERE id = ?').get(group.id);
}

function deleteGroup(orgId, group) {
  let removed = [];
  db.transaction(() => {
    const members = db.prepare(`SELECT su.user_id FROM scim_group_members gm JOIN scim_users su ON su.id = gm.scim_user_id
                                WHERE gm.group_id = ?`).all(group.id).map((r) => r.user_id);
    db.prepare('DELETE FROM scim_group_members WHERE group_id = ?').run(group.id);
    db.prepare('DELETE FROM scim_group_mappings WHERE group_id = ?').run(group.id);
    db.prepare('DELETE FROM scim_groups WHERE id = ?').run(group.id);
    removed = reconcileUsers(orgId, members);
  })();
  afterAccessRemoved(removed);
}

function groupMemberIds(groupId) {
  return db.prepare('SELECT scim_user_id FROM scim_group_members WHERE group_id = ?').all(groupId).map((r) => r.scim_user_id);
}

module.exports = {
  ScimError, WORKSPACE_ROLES, EMAIL_RE,
  settingsFor, logEvent, providerForEmail, ownsIdentity, isOrgOwner,
  createUser, updateUser, deleteUser, stateOf,
  createGroup, updateGroup, deleteGroup, groupMemberIds,
  reconcileUser, reconcileOrg, desiredAccess, localWsClause,
};
