'use strict';

/*
 * The WHOLE SERVER, for its platform administrator (docs/move-server.md): export every organization
 * in one bundle, and restore such a bundle on another server.
 *
 * THE BUNDLE
 *   instance-manifest.json        every organization (name, file, SHA-256, size), the instance tables,
 *                                 and the digest of every entry
 *   orgs/<organization id>.zip    that organization's ordinary export (lib/trust/export.js), with its
 *                                 own manifest and digests — byte for byte what an organization
 *                                 owner would download, stored without recompressing
 *   instance/tables/<t>.jsonl     instance configuration that is safe to carry: the accounts (no
 *                                 secrets; platform roles included), the plan catalog (no billing
 *                                 ids), app settings minus anything credential-like, and the
 *                                 template catalogs added by hand
 *
 * RESTORING ONE
 *   Each organization is a child import job and goes through the SAME per-organization restore
 *   (lib/trust/import-restore.js), so every per-organization guarantee holds inside a bundle. One
 *   organization that fails (a damaged entry, a restore error) is rolled back and listed; the others
 *   complete, and the failed one can be retried on its own.
 *
 * Platform administrators only, at every step (routes/org-import.js checks; this file assumes it).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const exporter = require('./export');
const exportTables = require('./export-tables');
const archive = require('./import-archive');
const { isSecretName } = require('../secret-names');
const { ImportError } = archive;

const MAX_PER_DAY = 3;
const now = () => Math.floor(Date.now() / 1000);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function dbOf() { return require('../../db/database').db; }

/* Instance settings that describe THIS install, not configuration to carry. */
const SETTINGS_NOT_CARRIED = /^(mesh|telemetry|install|instance_id|node_|last_upgraded|upgrade|stripe|smtp|graph|license|update_)/i;

const README = `ScreenTinker whole-server export
================================

instance-manifest.json     every organization in this bundle, the instance configuration
                           carried, and the SHA-256 of every entry.
orgs/<id>.zip              each organization's complete export, exactly as its owner would
                           download it from Settings -> Data & privacy.
instance/tables/*.jsonl    accounts (no passwords or other secrets), plans, app settings
                           without credentials, and template catalogs.

Restore it on another server: Platform -> Data & privacy -> Import the whole server.
`;

/* ───────────── export ───────────── */

function request(db, userId, options = {}) {
  const busy = db.prepare("SELECT id FROM instance_exports WHERE status IN ('queued','running')").get();
  if (busy) throw new exporter.ExportError('A whole-server export is already being prepared.', 429, 'busy');
  const recent = db.prepare('SELECT COUNT(*) AS n FROM instance_exports WHERE created_at > ?').get(now() - 86400).n;
  if (recent >= MAX_PER_DAY) throw new exporter.ExportError(`At most ${MAX_PER_DAY} whole-server exports a day.`, 429, 'daily_limit');
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO instance_exports (id, user_id, status, options) VALUES (?, ?, 'queued', ?)")
    .run(id, userId, JSON.stringify({ include_settings: options.include_settings !== false }));
  kick();
  return id;
}

async function writeBundle(archive, db, job, tmps) {
  const opts = JSON.parse(job.options || '{}');
  const orgs = db.prepare('SELECT id, name FROM organizations ORDER BY created_at, rowid').all();
  const listed = [];
  for (const o of orgs) {
    const tmp = path.join(exporter.exportsDir(), `instance-${job.id}-${o.id}.zip`);
    tmps.push(tmp);
    const r = await exporter.buildZip(tmp, (a) => exporter.writeOrgExport(a, db, { organization_id: o.id, user_id: job.user_id }));
    const name = `orgs/${o.id}.zip`;
    exporter.recordIntegrity(archive, name, r.sha256, r.bytes);
    archive.file(tmp, { name });
    listed.push({ id: o.id, name: o.name, file: name, sha256: r.sha256, bytes: r.bytes });
  }
  const tables = {};
  // Every account, with its platform role: a whole-server restore recreates them. No secret column
  // leaves (lib/trust/export.js exportableColumns), the same as everywhere else.
  tables.users = (await exporter.appendTable(archive, db, 'users', { sql: '1 = 1', args: [] }, 'instance/tables/users.jsonl',
    { columns: [...exportTables.MEMBER_COLUMNS, 'plan_id'] })).rows;
  if (opts.include_settings !== false) {
    tables.plans = (await exporter.appendTable(archive, db, 'plans', { sql: '1 = 1', args: [] }, 'instance/tables/plans.jsonl')).rows;
    tables.template_catalogs = (await exporter.appendTable(archive, db, 'template_catalogs', { sql: 'builtin = 0', args: [] }, 'instance/tables/template_catalogs.jsonl')).rows;
    const settings = db.prepare('SELECT key, value FROM app_settings').all()
      .filter((s) => !isSecretName(s.key) && !SETTINGS_NOT_CARRIED.test(s.key) && !/^enc:v1:/.test(String(s.value)) && !/enc:v1:/.test(String(s.value)));
    exporter.appendString(archive, settings.map((s) => JSON.stringify(s)).join('\n') + (settings.length ? '\n' : ''), 'instance/tables/app_settings.jsonl');
    tables.app_settings = settings.length;
  }
  exporter.appendString(archive, README, 'README.txt');
  const manifest = {
    format: archive_format(),
    kind: 'instance',
    exported_at: new Date().toISOString(),
    organizations: listed,
    instance: { tables },
    integrity: { algorithm: 'sha256', entries: { ...(archive._stIntegrity || {}) } },
  };
  archive.append(JSON.stringify(manifest, null, 2), { name: 'instance-manifest.json' });
  return manifest;
}
const archive_format = () => archive.INSTANCE_FORMAT;

async function runJob(db, job) {
  db.prepare("UPDATE instance_exports SET status = 'running', started_at = ? WHERE id = ?").run(now(), job.id);
  fs.mkdirSync(exporter.exportsDir(), { recursive: true });
  const file = path.join(exporter.exportsDir(), `instance-${job.id}.zip`);
  const tmps = [];
  try {
    const { manifest, sha256, bytes } = await exporter.buildZip(file, (a) => writeBundle(a, db, job, tmps), { store: true });
    db.prepare("UPDATE instance_exports SET status = 'ready', file_name = ?, bytes = ?, sha256 = ?, manifest = ?, finished_at = ?, expires_at = ? WHERE id = ?")
      .run(path.basename(file), bytes, sha256, JSON.stringify({ organizations: manifest.organizations.length, tables: manifest.instance.tables }), now(), now() + exporter.TTL_HOURS * 3600, job.id);
  } catch (e) {
    try { fs.rmSync(file, { force: true }); } catch (_) { /* */ }
    db.prepare("UPDATE instance_exports SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(String((e && e.message) || e).slice(0, 300), now(), job.id);
  } finally {
    for (const t of tmps) { try { fs.rmSync(t, { force: true }); } catch (_) { /* */ } }
  }
}

let running = false;
function kick() { setImmediate(() => { runQueue().catch(() => {}); }); }
async function runQueue(db = dbOf()) {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const job = db.prepare("SELECT * FROM instance_exports WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1").get();
      if (!job) break;
      await runJob(db, job);
    }
  } finally { running = false; }
}

function link(db, job) {
  if (!job || job.status !== 'ready' || !job.expires_at || job.expires_at <= now()) throw new exporter.ExportError('This export is not available.', 404, 'not_ready');
  const key = crypto.randomBytes(32).toString('base64url');
  const exp = Math.min(now() + exporter.LINK_TTL_MIN * 60, job.expires_at);
  db.prepare('UPDATE instance_exports SET download_hash = ? WHERE id = ?').run(`${sha(key)}:${exp}`, job.id);
  return { key, expires_at: exp };
}

function verifyKey(db, id, key) {
  const job = db.prepare('SELECT * FROM instance_exports WHERE id = ?').get(String(id || ''));
  if (!job || !job.download_hash || !key) return null;
  const [hash, exp] = job.download_hash.split(':');
  if (!exp || Number(exp) <= now()) return null;
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(sha(String(key)), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (job.status !== 'ready' || !job.expires_at || job.expires_at <= now()) return null;
  return job;
}

function filePath(job) {
  const p = path.join(exporter.exportsDir(), path.basename(String(job.file_name || '')));
  return p.startsWith(exporter.exportsDir() + path.sep) ? p : null;
}

function sweep(db = dbOf()) {
  try {
    for (const j of db.prepare("SELECT * FROM instance_exports WHERE status = 'ready' AND expires_at <= ?").all(now())) {
      const p = filePath(j);
      if (p) { try { fs.rmSync(p, { force: true }); } catch (_) { /* */ } }
      db.prepare("UPDATE instance_exports SET status = 'expired', download_hash = NULL WHERE id = ?").run(j.id);
    }
    db.prepare("UPDATE instance_exports SET status = 'queued' WHERE status = 'running'").run();
  } catch (_) { /* table absent */ }
}

function publicJob(j) {
  let summary = null;
  try { summary = j.manifest ? JSON.parse(j.manifest) : null; } catch (_) { summary = null; }
  return { id: j.id, status: j.status, bytes: j.bytes || null, sha256: j.sha256 || null, created_at: j.created_at, finished_at: j.finished_at || null,
    expires_at: j.expires_at || null, error: j.status === 'failed' ? j.error : null, summary };
}

/* ───────────── import ───────────── */

/**
 * Check a bundle and prepare one child job per organization: each nested export is copied out
 * (digest-checked against the bundle) and scanned on its own. A damaged organization is marked
 * refused with the reason; it does not refuse the bundle.
 */
async function scanBundle(db, job, arch, onProgress) {
  const imp = require('./import');
  const m = arch.manifest;
  if (!Array.isArray(m.organizations)) throw new ImportError('The bundle lists no organizations.', 'bad_manifest');
  for (const name of arch.entries.keys()) {
    if (name.startsWith('instance/') || name === 'README.txt') await archive.verifyEntry(arch, name);
  }
  const users = [];
  if (arch.entries.has('instance/tables/users.jsonl')) await archive.readRows(arch, 'instance/tables/users.jsonl', async (rows) => { users.push(...rows); });
  const orgs = [];
  let i = 0;
  fs.mkdirSync(imp.incomingDir(), { recursive: true, mode: 0o700 });
  for (const o of m.organizations) {
    i += 1;
    onProgress({ phase: 'checking', done: i, total: m.organizations.length });
    const file = String(o && o.file || '');
    let child = db.prepare('SELECT * FROM org_imports WHERE parent_id = ? AND file_name = ?').get(job.id, file);
    if (!child) {
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO org_imports (id, kind, parent_id, requested_by, requester_org_id, source, file_name, status) VALUES (?, 'org', ?, ?, NULL, 'bundle', ?, 'scanning')")
        .run(id, job.id, job.requested_by, file);
      child = imp.getJob(db, id);
    }
    const entry = { child_id: child.id, name: String(o && o.name || ''), file };
    try {
      if (!/^orgs\/[A-Za-z0-9_-]{1,128}\.zip$/.test(file) || !arch.entries.has(file)) throw new ImportError('The bundle lists an organization file it does not contain.', 'tampered');
      const p = imp.archivePath(child);
      try { fs.rmSync(p, { force: true }); } catch (_) { /* */ }
      await archive.extractTo(arch, file, p);
      const childArch = await archive.open(p);
      if (childArch.kind !== 'org') throw new ImportError('Not an organization export.', 'bad_format');
      const summary = await require('./import-restore').scan(childArch, { db, instance: true });
      summary.room = { ok: true, need_bytes: summary.media.bytes };
      imp.update(db, child.id, { status: 'scanned', scan: summary, error: null });
      Object.assign(entry, { status: 'scanned', workspaces: summary.workspaces.length, screens: summary.devices.length, members: summary.members.length, media_bytes: summary.media.bytes });
    } catch (e) {
      imp.update(db, child.id, { status: 'refused', error: String(e.message).slice(0, 500) });
      Object.assign(entry, { status: 'refused', error: String(e.message).slice(0, 300) });
    }
    orgs.push(entry);
  }
  const mediaBytes = orgs.reduce((n, o) => n + (o.media_bytes || 0), 0);
  return {
    kind: 'instance', exported_at: m.exported_at || null, organizations: orgs,
    accounts: users.length, platform_admins: users.filter((u) => require('../../middleware/auth').isPlatformRole(u.role)).length,
    instance_tables: (m.instance && m.instance.tables) || {},
    room: require('./import-restore').roomFor(db, job.requested_by, mediaBytes, 0),
  };
}

function startBundleRestore(db, job, who, options = {}) {
  const imp = require('./import');
  imp.update(db, job.id, {
    status: 'restoring', options: { include_settings: options.include_settings !== false, include_proof_of_play: options.include_proof_of_play !== false, include_audit: options.include_audit !== false, include_history: options.include_history !== false },
    progress: { phase: 'instance' }, error: null,
  });
  imp.kick();
  return imp.getJob(db, job.id);
}

/** Restore the instance tables, then every scanned organization in turn. */
async function runBundleRestore(db, job) {
  const imp = require('./import');
  const opts = JSON.parse(job.options || '{}');
  const progress = JSON.parse(job.progress || '{}');
  const arch = await archive.open(imp.archivePath(job));
  const result = JSON.parse(job.result || '{}');
  if (progress.phase === 'instance') {
    result.accounts = await restoreAccounts(db, arch);
    if (opts.include_settings !== false) result.settings = await restoreSettings(db, arch);
    imp.update(db, job.id, { progress: { phase: 'organizations' }, result });
  }
  const who = { userId: job.requested_by, platformAdmin: true };
  const orgs = [];
  for (const child of db.prepare("SELECT * FROM org_imports WHERE parent_id = ? ORDER BY created_at, rowid").all(job.id)) {
    let c = child;
    if (c.status === 'scanned') {
      try { imp.startRestore(db, c, who, { target: { mode: 'new' }, options: opts }); } catch (e) { imp.update(db, c.id, { status: 'failed', error: e.message }); }
      c = imp.getJob(db, c.id);
    }
    // Restored here, one after another, rather than left to the queue: the bundle is one job, and
    // its summary is only true once every organization has had its turn.
    if (c.status === 'restoring') { await imp.runOne(db, c); c = imp.getJob(db, c.id); }
    const scan = JSON.parse(c.scan || '{}');
    orgs.push({ child_id: c.id, name: (scan.organization && scan.organization.name) || c.file_name, status: c.status, error: c.error || null, organization_id: c.organization_id || null });
    imp.update(db, job.id, { progress: { phase: 'organizations', done: orgs.length } });
  }
  result.organizations = orgs;
  result.failed = orgs.filter((o) => o.status !== 'done').length;
  imp.update(db, job.id, { status: 'done', result, finished_at: now(), progress: { phase: 'done' } });
}

/*
 * The accounts, so platform roles come back. An address that already has an account here keeps it
 * unchanged. New accounts have no password: "Forgot password", or a set-password link from the
 * administrator (routes/org-import.js), or their single sign-on provider once it is reconnected.
 */
async function restoreAccounts(db, arch) {
  if (!arch.entries.has('instance/tables/users.jsonl')) return 0;
  const { isPlatformRole } = require('../../middleware/auth');
  const plans = new Set(db.prepare('SELECT id FROM plans').all().map((p) => p.id));
  let n = 0;
  await archive.readRows(arch, 'instance/tables/users.jsonl', async (rows) => {
    db.transaction(() => {
      for (const r of rows) {
        const email = String(r.email || '').trim().toLowerCase();
        if (!email || db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) continue;
        db.prepare(`INSERT INTO users (id, email, name, password_hash, auth_provider, role, plan_id, email_verified, created_at, disabled_at, ui_mode)
                    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'advanced')`)
          .run(crypto.randomUUID(), email, String(r.name || email.split('@')[0]), ['local', 'google', 'microsoft', 'oidc', 'saml'].includes(r.auth_provider) ? r.auth_provider : 'local',
            isPlatformRole(r.role) || r.role === 'user' ? r.role : 'user', plans.has(r.plan_id) ? r.plan_id : 'free', r.email_verified ? 1 : 0, r.created_at || now(), r.disabled_at || null);
        n += 1;
      }
    })();
  });
  return n;
}

/** Plans, template catalogs and app settings this server does not have yet; nothing is overwritten. */
async function restoreSettings(db, arch) {
  const out = { plans: 0, template_catalogs: 0, app_settings: 0 };
  const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
  for (const t of ['plans', 'template_catalogs']) {
    const name = `instance/tables/${t}.jsonl`;
    if (!arch.entries.has(name)) continue;
    const have = cols(t);
    await archive.readRows(arch, name, async (rows) => {
      for (const r of rows) {
        const keys = Object.keys(r).filter((k) => have.has(k));
        if (!keys.includes('id')) continue;
        const res = db.prepare(`INSERT OR IGNORE INTO ${t} (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => r[k]));
        out[t] += res.changes;
      }
    });
  }
  if (arch.entries.has('instance/tables/app_settings.jsonl')) {
    const appSettings = require('../app-settings');
    await archive.readRows(arch, 'instance/tables/app_settings.jsonl', async (rows) => {
      for (const r of rows) {
        const key = String(r.key || '');
        if (!key || isSecretName(key) || SETTINGS_NOT_CARRIED.test(key) || /enc:v1:/.test(String(r.value))) continue;
        if (db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(key)) continue;
        appSettings.set(key, String(r.value));
        out.app_settings += 1;
      }
    });
  }
  return out;
}

function start(db = dbOf()) {
  sweep(db);
  kick();
  const t = setInterval(() => sweep(db), 15 * 60 * 1000);
  t.unref?.();
}

module.exports = { request, runQueue, link, verifyKey, filePath, sweep, start, publicJob, scanBundle, startBundleRestore, runBundleRestore, MAX_PER_DAY };
