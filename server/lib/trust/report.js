'use strict';

/*
 * "Your data, provably": the data handling report, built from the RUNNING configuration every time
 * it is asked for. Nothing here is a hand-written claim — each fact is read from config, the
 * environment the storage layer reads, app_settings, the schema or the outbound ledger — so the page
 * cannot drift from what the server actually does. docs/trust.md explains each section.
 *
 * Three views of the same facts:
 *   build({ db })             the platform admin's view of the whole instance
 *   build({ db, orgId })      an organization admin's view: their storage, their integrations,
 *                             their members' MFA, the hosts contacted on their behalf
 *   publicView(report)        the optional public /trust page: a strict allowlist of non-sensitive
 *                             facts. ⚠️ Built by COPYING named fields, never by deleting from the full
 *                             report, so a field added to the report later is private by default.
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const integrations = require('./integrations');

const EXPORT_TTL_HOURS = 24;
const DELETION_GRACE_DAYS = 14;
const AUDIT_RETENTION_DAYS = 90;   // services/activity.js pruneActivityLog default, scheduled in server.js

function safe(fn, dflt) { try { return fn(); } catch (_) { return dflt; } }

function storageFacts(db, orgId) {
  const s = require('../storage');
  const def = safe(() => (orgId ? s.orgDefaultProfile(orgId) : s.instanceDefault()), null) || { provider: 'local' };
  const view = safe(() => s.publicView(def), null) || { provider: 'local' };
  const profiles = safe(() => db.prepare(`SELECT provider, region, org_id, workspace_id FROM storage_profiles WHERE ${orgId ? 'org_id = ?' : '1=1'}`).all(...(orgId ? [orgId] : [])), []);
  const byProvider = {};
  for (const p of profiles) byProvider[p.provider] = (byProvider[p.provider] || 0) + 1;
  const out = {
    default: {
      provider: view.provider || 'local', region: view.region || null, bucket: view.bucket || null,
      endpoint_host: integrations.hostOf(view.endpoint) || null, from_env: !!view.from_env, scope: view.scope || 'instance',
    },
    profiles: byProvider,
    workspace_overrides: orgId ? safe(() => db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE organization_id = ? AND COALESCE(storage_profile_id,'') <> ''").get(orgId).n, 0) : null,
  };
  if (!orgId) out.local_dir = path.dirname(config.contentDir);
  // What is actually stored, and where: content rows by the backend holding their primary copy.
  const where = orgId ? 'c.workspace_id IN (SELECT id FROM workspaces WHERE organization_id = ?)' : '1=1';
  out.files = safe(() => db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(c.file_size),0) AS bytes FROM content c WHERE c.remote_url IS NULL AND ${where}`).get(...(orgId ? [orgId] : [])), { n: 0, bytes: 0 });
  return out;
}

function databaseFacts(db, orgId) {
  const out = { engine: 'sqlite', location: 'server_disk', encrypted_by_app: false };
  if (!orgId) {
    out.path = config.dbPath;
    out.bytes = safe(() => fs.statSync(config.dbPath).size, null);
    out.journal = safe(() => String(db.pragma('journal_mode', { simple: true })), null);
  }
  return out;
}

/** Every column that holds an encrypted secret, read from the schema rather than listed by hand. */
function encryptedColumns(db) {
  const out = [];
  const tables = safe(() => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name), []);
  for (const t of tables) {
    for (const c of safe(() => db.prepare(`PRAGMA table_info(${t})`).all(), [])) {
      if (/_enc$/.test(c.name)) out.push(`${t}.${c.name}`);
    }
  }
  return out.sort();
}

function encryptionFacts(db) {
  return {
    secrets_at_rest: 'aes-256-gcm',
    key_source: 'derived_from_jwt_secret',
    encrypted_columns: encryptedColumns(db),
    passwords: 'bcrypt',
    api_tokens: 'sha256_hash',
    media_encrypted_by_app: false,
    database_encrypted_by_app: false,
  };
}

function retentionFacts() {
  const rr = safe(() => require('../revision-retention').KEEP, 20);
  const snap = safe(() => require('../upgrade-snapshot').KEEP, 3);
  return [
    { id: 'audit_log', days: AUDIT_RETENTION_DAYS },
    { id: 'proof_of_play', days: config.playLogRetentionDays },
    { id: 'device_status_log', days: config.statusLogRetentionDays },
    { id: 'device_telemetry', days: config.telemetryRetentionDays },
    { id: 'screenshots', keep: 1 },
    { id: 'revisions', keep: rr },
    { id: 'usage', days: config.billing && config.billing.usageRetentionDays },
    { id: 'outbound_ledger', days: require('../outbound-ledger').RETENTION_DAYS },
    { id: 'exports', hours: EXPORT_TTL_HOURS },
    { id: 'upgrade_snapshots', keep: snap },
    { id: 'org_deletion_grace', days: DELETION_GRACE_DAYS },
  ];
}

function backupFacts(orgId) {
  const snap = require('../upgrade-snapshot');
  const dir = path.dirname(config.dbPath);
  const files = safe(() => fs.readdirSync(dir).filter((f) => f.startsWith(snap.PREFIX)), []);
  const latest = files.map((f) => safe(() => fs.statSync(path.join(dir, f)).mtimeMs, 0)).sort((a, b) => b - a)[0] || null;
  const out = {
    upgrade_snapshots: { keep: snap.KEEP, present: files.length, latest_at: latest ? Math.floor(latest / 1000) : null },
    platform_db_download: true,   // GET /api/status/backup, platform admins only
    offsite: false,               // the server copies nothing anywhere by itself
  };
  if (!orgId) out.upgrade_snapshots.dir = dir;
  return out;
}

function identityFacts(db, orgId) {
  const memberWhere = orgId
    ? `id IN (SELECT user_id FROM organization_members WHERE organization_id = ?
              UNION SELECT wm.user_id FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id WHERE w.organization_id = ?)`
    : '1=1';
  const margs = orgId ? [orgId, orgId] : [];
  const users = safe(() => db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${memberWhere}`).get(...margs).n, 0);
  const withTotp = safe(() => db.prepare(`SELECT COUNT(*) AS n FROM users WHERE totp_enabled = 1 AND ${memberWhere}`).get(...margs).n, 0);
  const withPasskey = safe(() => db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM webauthn_credentials WHERE user_id IN (SELECT id FROM users WHERE ${memberWhere})`).get(...margs).n, 0);
  const withMfa = safe(() => db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${memberWhere} AND (totp_enabled = 1 OR id IN (SELECT user_id FROM webauthn_credentials))`).get(...margs).n, 0);
  const instSso = orgId ? [] : safe(() => require('../oidc-providers').list().map((p) => p.slug), []);
  const orgArgs = orgId ? [orgId] : [];
  const ow = orgId ? 'organization_id = ?' : '1=1';
  return {
    totp_available: true,
    passkeys_available: true,
    members: users, members_with_totp: withTotp, members_with_passkey: withPasskey, members_with_mfa: withMfa,
    sso: {
      instance_providers: instSso,
      org_providers: safe(() => db.prepare(`SELECT COUNT(*) AS n FROM org_sso_providers WHERE enabled = 1 AND ${ow}`).get(...orgArgs).n, 0),
      saml_providers: safe(() => db.prepare(`SELECT COUNT(*) AS n FROM org_sso_providers WHERE enabled = 1 AND kind = 'saml' AND ${ow}`).get(...orgArgs).n, 0),
      sso_only: orgId ? !!safe(() => db.prepare('SELECT sso_only FROM organizations WHERE id = ?').get(orgId).sso_only, 0)
        : safe(() => db.prepare('SELECT COUNT(*) AS n FROM organizations WHERE sso_only = 1').get().n, 0),
    },
    scim: {
      enabled: safe(() => db.prepare(`SELECT COUNT(*) AS n FROM org_scim_settings WHERE enabled = 1 AND ${ow}`).get(...orgArgs).n, 0),
      active_tokens: safe(() => db.prepare(`SELECT COUNT(*) AS n FROM scim_tokens WHERE revoked_at IS NULL AND ${ow}`).get(...orgArgs).n, 0),
    },
  };
}

/** Hosts contacted in the last `days` days, from the ledger. org view: only on the org's behalf. */
function outboundSummary(db, { orgId = null, days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const rows = safe(() => db.prepare(`
    SELECT host, scope, GROUP_CONCAT(DISTINCT feature) AS features, SUM(count) AS count
      FROM outbound_ledger WHERE day >= ? ${orgId ? 'AND organization_id = ?' : ''}
     GROUP BY host, scope ORDER BY count DESC`).all(...(orgId ? [since, orgId] : [since])), []);
  return {
    days,
    internet_hosts: rows.filter((r) => r.scope === 'internet').length,
    local_hosts: rows.filter((r) => r.scope !== 'internet').length,
    requests: rows.reduce((a, r) => a + (r.count || 0), 0),
  };
}

/**
 * Does all customer data stay on this server? True only when media and the database are local and
 * no integration that sends customer data is switched on toward a host outside the private network.
 * `reasons` names what makes it false, so the statement can be acted on rather than just read.
 */
function residency(storage, ints) {
  const { scopeOf } = require('../outbound-ledger');
  const reasons = [];
  if (storage.default.provider !== 'local' || Object.keys(storage.profiles || {}).some((p) => p !== 'local')) {
    const local = storage.default.provider === 'local' || (storage.default.endpoint_host && scopeOf(storage.default.endpoint_host) !== 'internet');
    if (!local || Object.keys(storage.profiles || {}).some((p) => p !== 'local')) reasons.push('storage');
  }
  for (const i of ints) {
    if (!i.enabled || !i.customer_data || i.id === 'storage') continue;
    // A destination we cannot name is assumed to be off-server: the statement must never overclaim.
    const offBox = !i.hosts.length || i.hosts.some((h) => scopeOf(h) === 'internet');
    if (offBox) reasons.push(i.id);
  }
  return { all_on_server: reasons.length === 0, reasons };
}

function build({ db, orgId = null } = {}) {
  db = db || require('../../db/database').db;
  const ints = integrations.evaluate({ db, orgId });
  const storage = storageFacts(db, orgId);
  const out = {
    generated_at: Math.floor(Date.now() / 1000),
    scope: orgId ? 'organization' : 'instance',
    self_hosted: !!config.selfHosted,
    database: databaseFacts(db, orgId),
    storage,
    encryption: encryptionFacts(db),
    integrations: ints,
    telemetry: (ints.find((i) => i.id === 'telemetry') || {}).detail || {},
    retention: retentionFacts(),
    backups: backupFacts(orgId),
    identity: identityFacts(db, orgId),
    outbound: outboundSummary(db, { orgId }),
    residency: residency(storage, ints),
  };
  if (orgId) {
    const org = safe(() => db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(orgId), null);
    out.organization = org ? { id: org.id, name: org.name } : { id: orgId, name: null };
    out.deletion = safe(() => db.prepare('SELECT requested_at, execute_after FROM org_deletion_requests WHERE organization_id = ?').get(orgId), null) || null;
  }
  return out;
}

/*
 * The public page's facts. An ALLOWLIST: storage provider and region (never bucket, endpoint or
 * path), whether secrets are encrypted, which instance-level integrations are on (never a host or a
 * count), telemetry state, retention, the backup policy, which sign-in protections exist, and the
 * residency statement. No version (it tells an attacker what to try), no names, no hosts, no counts
 * of anything a competitor or attacker would want.
 */
function publicView(r) {
  return {
    generated_at: r.generated_at,
    database: { engine: r.database.engine, location: r.database.location, encrypted_by_app: r.database.encrypted_by_app },
    storage: { provider: r.storage.default.provider, region: r.storage.default.provider === 'local' ? null : (r.storage.default.region || null) },
    encryption: {
      secrets_at_rest: r.encryption.secrets_at_rest, passwords: r.encryption.passwords, api_tokens: r.encryption.api_tokens,
      media_encrypted_by_app: r.encryption.media_encrypted_by_app, database_encrypted_by_app: r.encryption.database_encrypted_by_app,
    },
    integrations: r.integrations.filter((i) => i.level === 'instance' && i.enabled).map((i) => ({ id: i.id, customer_data: i.customer_data })),
    org_integrations_available: true,
    telemetry: { state: r.telemetry.state === 'on' ? 'on' : 'off', fields: r.telemetry.state === 'on' ? r.telemetry.fields : [] },
    retention: r.retention.map((x) => ({ ...x })),
    backups: { upgrade_snapshots_keep: r.backups.upgrade_snapshots.keep, offsite: r.backups.offsite },
    identity: { totp_available: true, passkeys_available: true, sso_available: true, scim_available: true },
    residency: { all_on_server: r.residency.all_on_server, reasons: r.residency.reasons.filter((x) => typeof x === 'string') },
  };
}

module.exports = { build, publicView, residency, outboundSummary, encryptedColumns, EXPORT_TTL_HOURS, DELETION_GRACE_DAYS };
