'use strict';

/*
 * Settings > User provisioning (SCIM): the org admin's side of routes/scim.js.
 *
 * Mounted under /api/organizations beside org-sso.js and gated the same way — org owner/admin of
 * THAT organization (404 to anyone else), and a verified email for anything that changes state.
 * Provisioning decides who has an account and what they can reach, so it is held to exactly the
 * bar sign-in configuration is. Platform staff get no bypass, for the same reason.
 *
 * The identity provider never reaches this router: tokens, the on/off switch and which group grants
 * which workspace role are decisions an admin makes here, and nothing a SCIM request says changes
 * them.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { db } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const { requireOrgAdmin, requireVerifiedAdmin } = require('./org-sso');
const { publicOrigin } = require('../lib/public-origin');
const { auditFromReq } = require('../lib/audit');
const prov = require('../lib/scim/provision');
const { TOKEN_PREFIX, hashToken } = require('./scim');

const MAX_ACTIVE_TOKENS = 5;

router.use('/:orgId/scim', requireAuth, resolveTenancy);

/** Can provisioning work at all? It needs an enabled SSO provider with a DNS-verified domain. */
function verifiedDomains(orgId) {
  return db.prepare(`SELECT d.domain FROM org_sso_domains d JOIN org_sso_providers p ON p.id = d.provider_id
                      WHERE d.organization_id = ? AND d.verified_at IS NOT NULL AND p.enabled = 1 ORDER BY d.domain`)
    .all(orgId).map((r) => r.domain);
}

function overview(req) {
  const orgId = req.orgId;
  const s = prov.settingsFor(orgId) || { enabled: 0, default_workspace_id: null, default_role: null };
  const tokens = db.prepare(`SELECT t.id, t.prefix, t.name, t.created_at, t.last_used_at, t.revoked_at, u.email AS created_by_email
                               FROM scim_tokens t LEFT JOIN users u ON u.id = t.created_by
                              WHERE t.organization_id = ? ORDER BY t.created_at DESC`).all(orgId);
  const workspaces = db.prepare('SELECT id, name FROM workspaces WHERE organization_id = ? ORDER BY name').all(orgId);
  const mappings = db.prepare(`SELECT m.id, m.group_id, m.workspace_id, m.role, w.name AS workspace_name
                                 FROM scim_group_mappings m JOIN workspaces w ON w.id = m.workspace_id
                                WHERE m.organization_id = ? ORDER BY w.name`).all(orgId);
  const groups = db.prepare(`SELECT g.id, g.display_name, g.external_id,
                                    (SELECT COUNT(*) FROM scim_group_members gm WHERE gm.group_id = g.id) AS member_count
                               FROM scim_groups g WHERE g.organization_id = ? ORDER BY g.display_name COLLATE NOCASE`).all(orgId)
    .map((g) => ({ ...g, mappings: mappings.filter((m) => m.group_id === g.id) }));
  const counts = db.prepare('SELECT COUNT(*) AS users, COALESCE(SUM(active), 0) AS active FROM scim_users WHERE organization_id = ?').get(orgId);
  return {
    enabled: !!s.enabled,
    base_url: `${publicOrigin(req)}/scim/v2`,
    default_workspace_id: s.default_workspace_id || null,
    default_role: s.default_role || null,
    verified_domains: verifiedDomains(orgId),
    roles: prov.WORKSPACE_ROLES,
    tokens,
    workspaces,
    groups,
    counts: { users: counts.users, active_users: counts.active, groups: groups.length },
  };
}

router.get('/:orgId/scim', requireOrgAdmin, (req, res) => res.json(overview(req)));

/*
 * The switch and the default access. Turning provisioning OFF stops the IdP (403 on every call)
 * but changes nobody's access: deprovisioning is an act, and an admin flipping a switch to stop a
 * misbehaving sync must not be the thing that strips the whole company out of their workspaces.
 */
router.put('/:orgId/scim', requireOrgAdmin, requireVerifiedAdmin, (req, res) => {
  const b = req.body || {};
  const cur = prov.settingsFor(req.orgId) || { enabled: 0, default_workspace_id: null, default_role: null };
  const enabled = b.enabled === undefined ? !!cur.enabled : !!b.enabled;
  let wsId = b.default_workspace_id === undefined ? cur.default_workspace_id : (b.default_workspace_id || null);
  let role = b.default_role === undefined ? cur.default_role : (b.default_role || null);
  if (wsId) {
    const ws = db.prepare(`SELECT w.id FROM workspaces w WHERE w.id = ? AND w.organization_id = ?${prov.localWsClause()}`).get(String(wsId), req.orgId);
    if (!ws) return res.status(400).json({ error: 'That workspace is not in this organization.' });
    if (!prov.WORKSPACE_ROLES.includes(role)) return res.status(400).json({ error: 'Choose a role for the default workspace.' });
  } else { wsId = null; role = null; }
  if (enabled && !cur.enabled && !verifiedDomains(req.orgId).length) {
    return res.status(400).json({
      error: 'Set up single sign-on with a verified domain first: provisioned people sign in through it.',
      code: 'sso_required',
    });
  }
  db.prepare(`INSERT INTO org_scim_settings (organization_id, enabled, default_workspace_id, default_role, updated_at)
              VALUES (?, ?, ?, ?, strftime('%s','now'))
              ON CONFLICT(organization_id) DO UPDATE SET enabled = excluded.enabled, default_workspace_id = excluded.default_workspace_id,
                default_role = excluded.default_role, updated_at = excluded.updated_at`)
    .run(req.orgId, enabled ? 1 : 0, wsId, role);
  if (wsId !== cur.default_workspace_id || role !== cur.default_role) prov.reconcileOrg(req.orgId);
  if (enabled !== !!cur.enabled) {
    auditFromReq(req, enabled ? 'scim_enabled' : 'scim_disabled', { organization_id: req.orgId });
    prov.logEvent(req.orgId, enabled ? 'settings.enabled' : 'settings.disabled', null, req.user.email, 200);
  }
  if (wsId !== cur.default_workspace_id || role !== cur.default_role) {
    auditFromReq(req, 'scim_default_access_changed', { organization_id: req.orgId, default_workspace_id: wsId, default_role: role });
  }
  res.json(overview(req));
});

/*
 * Mint a token. The plaintext is in this response and nowhere else, ever: only its SHA-256 is
 * stored, like API tokens. Several may be live at once so a rotation can overlap (mint, paste into
 * the IdP, revoke the old one) without a provisioning outage.
 */
router.post('/:orgId/scim/tokens', requireOrgAdmin, requireVerifiedAdmin, (req, res) => {
  const name = String((req.body && req.body.name) || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) || 'Identity provider';
  const live = db.prepare('SELECT COUNT(*) AS n FROM scim_tokens WHERE organization_id = ? AND revoked_at IS NULL').get(req.orgId).n;
  if (live >= MAX_ACTIVE_TOKENS) return res.status(409).json({ error: `At most ${MAX_ACTIVE_TOKENS} provisioning tokens can be active. Revoke one first.` });
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomUUID();
  const prefix = token.slice(0, TOKEN_PREFIX.length + 6);
  db.prepare('INSERT INTO scim_tokens (id, organization_id, token_hash, prefix, name, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.orgId, hashToken(token), prefix, name, req.user.id);
  auditFromReq(req, 'scim_token_created', { organization_id: req.orgId, token_id: id, prefix });
  prov.logEvent(req.orgId, 'token.created', prefix, req.user.email, 201);
  res.status(201).json({ id, prefix, name, token });
});

router.delete('/:orgId/scim/tokens/:id', requireOrgAdmin, requireVerifiedAdmin, (req, res) => {
  const t = db.prepare('SELECT id, prefix, revoked_at FROM scim_tokens WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (!t.revoked_at) db.prepare("UPDATE scim_tokens SET revoked_at = strftime('%s','now') WHERE id = ?").run(t.id);
  auditFromReq(req, 'scim_token_revoked', { organization_id: req.orgId, token_id: t.id, prefix: t.prefix });
  prov.logEvent(req.orgId, 'token.revoked', t.prefix, req.user.email, 200);
  res.json({ success: true });
});

/** Map a SCIM group to a role in one workspace of this organization. One role per (group, workspace). */
router.post('/:orgId/scim/mappings', requireOrgAdmin, requireVerifiedAdmin, (req, res) => {
  const b = req.body || {};
  const group = db.prepare('SELECT id, display_name FROM scim_groups WHERE id = ? AND organization_id = ?').get(String(b.group_id || ''), req.orgId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const ws = db.prepare(`SELECT w.id, w.name FROM workspaces w WHERE w.id = ? AND w.organization_id = ?${prov.localWsClause()}`).get(String(b.workspace_id || ''), req.orgId);
  if (!ws) return res.status(400).json({ error: 'That workspace is not in this organization.' });
  // Workspace roles only. An organization role from an IdP group would let whoever edits groups in
  // the IdP make org admins here, which is a decision this product keeps with the org's own admins.
  if (!prov.WORKSPACE_ROLES.includes(b.role)) return res.status(400).json({ error: 'Role must be workspace_admin, workspace_editor or workspace_viewer.' });
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO scim_group_mappings (id, organization_id, group_id, workspace_id, role) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(group_id, workspace_id) DO UPDATE SET role = excluded.role`).run(id, req.orgId, group.id, ws.id, b.role);
  prov.reconcileOrg(req.orgId);
  auditFromReq(req, 'scim_mapping_set', { organization_id: req.orgId, group: group.display_name, workspace_id: ws.id, role: b.role });
  prov.logEvent(req.orgId, 'mapping.set', group.display_name, `${ws.name}: ${b.role}`, 200);
  res.json(overview(req));
});

router.delete('/:orgId/scim/mappings/:id', requireOrgAdmin, requireVerifiedAdmin, (req, res) => {
  const m = db.prepare(`SELECT m.id, g.display_name, w.name AS workspace_name FROM scim_group_mappings m
                          JOIN scim_groups g ON g.id = m.group_id JOIN workspaces w ON w.id = m.workspace_id
                         WHERE m.id = ? AND m.organization_id = ?`).get(req.params.id, req.orgId);
  if (!m) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM scim_group_mappings WHERE id = ?').run(m.id);
  prov.reconcileOrg(req.orgId);
  auditFromReq(req, 'scim_mapping_removed', { organization_id: req.orgId, group: m.display_name, workspace: m.workspace_name });
  prov.logEvent(req.orgId, 'mapping.removed', m.display_name, m.workspace_name, 200);
  res.json(overview(req));
});

/** Recent provisioning activity, newest first. */
router.get('/:orgId/scim/events', requireOrgAdmin, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const events = db.prepare('SELECT id, action, resource, detail, status, created_at FROM scim_events WHERE organization_id = ? ORDER BY id DESC LIMIT ?')
    .all(req.orgId, limit);
  res.json({ events });
});

/** Who provisioning manages, so an admin can see the effect without opening the IdP. */
router.get('/:orgId/scim/users', requireOrgAdmin, (req, res) => {
  const users = db.prepare(`SELECT su.id, su.user_name, su.display_name, su.active, su.updated_at, u.email, u.disabled_at
                              FROM scim_users su JOIN users u ON u.id = su.user_id
                             WHERE su.organization_id = ? ORDER BY su.user_name COLLATE NOCASE LIMIT 500`).all(req.orgId)
    .map((u) => ({ ...u, active: !!u.active, account_disabled: !!u.disabled_at, disabled_at: undefined }));
  res.json({ users });
});

module.exports = router;
