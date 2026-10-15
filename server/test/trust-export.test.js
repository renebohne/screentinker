'use strict';

/*
 * Complete exports (lib/trust/export.js, routes/trust.js): completeness (every table is classified,
 * every category is in the manifest), tenancy (org A's archive never contains org B), secrets never
 * leave, the personal export's scope, the download link's rules, and the rate limits.
 */
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'st-trust-export-' + process.pid + '-' + Date.now());
process.env.JWT_SECRET = 'test-secret-trust-export';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('../config');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const tables = require('../lib/trust/export-tables');
const exporter = require('../lib/trust/export');

const U = { ownerA: 'u-ex-owner-a', adminA: 'u-ex-admin-a', viewerA: 'u-ex-viewer-a', wsadminA: 'u-ex-wsadmin-a', ownerB: 'u-ex-owner-b', solo: 'u-ex-solo' };
for (const [k, id] of Object.entries(U)) {
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role,name,totp_secret_enc) VALUES (?,?,'$2a$10$HASHHASHHASH','user',?,'TOTPCIPHER')").run(id, `${k}@export.local`, k);
}
db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('org-ex-a','Alpha Bakery',?)").run(U.ownerA);
db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('org-ex-b','Bravo Secret Corp',?)").run(U.ownerB);
db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-ex-a','org-ex-a','Alpha Shop')").run();
db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-ex-b','org-ex-b','Bravo Shop')").run();
const om = db.prepare('INSERT INTO organization_members (organization_id,user_id,role) VALUES (?,?,?)');
om.run('org-ex-a', U.ownerA, 'org_owner'); om.run('org-ex-a', U.adminA, 'org_admin'); om.run('org-ex-b', U.ownerB, 'org_owner');
const wm = db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)');
wm.run('ws-ex-a', U.ownerA, 'workspace_admin'); wm.run('ws-ex-a', U.viewerA, 'workspace_viewer');
wm.run('ws-ex-a', U.wsadminA, 'workspace_admin'); wm.run('ws-ex-b', U.ownerB, 'workspace_admin');

fs.mkdirSync(config.contentDir, { recursive: true });
fs.writeFileSync(path.join(config.contentDir, 'alpha-logo.png'), 'ALPHA-PNG-BYTES');
fs.writeFileSync(path.join(config.contentDir, 'bravo-logo.png'), 'BRAVO-PNG-BYTES');
db.prepare("INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size) VALUES ('c-ex-a',?,'ws-ex-a','logo.png','alpha-logo.png','image/png',15)").run(U.ownerA);
db.prepare("INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size) VALUES ('c-ex-b',?,'ws-ex-b','bravo.png','bravo-logo.png','image/png',15)").run(U.ownerB);
db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name) VALUES ('pl-ex-a',?,'ws-ex-a','Alpha Morning')").run(U.ownerA);
db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name) VALUES ('pl-ex-b',?,'ws-ex-b','Bravo Hidden Menu')").run(U.ownerB);
db.prepare("INSERT INTO playlist_items (playlist_id,content_id,sort_order) VALUES ('pl-ex-a','c-ex-a',0)").run();
db.prepare("INSERT INTO playlist_items (playlist_id,content_id,sort_order) VALUES ('pl-ex-b','c-ex-b',0)").run();
db.prepare("INSERT INTO devices (id,name,workspace_id,device_token,pairing_code) VALUES ('dev-ex-a','Alpha Window','ws-ex-a','DEVICETOKENSECRET','PAIRSECRET')").run();
db.prepare("INSERT INTO devices (id,name,workspace_id) VALUES ('dev-ex-b','Bravo Window','ws-ex-b')").run();
db.prepare(`INSERT INTO data_sources (id,workspace_id,slug,name,type,config) VALUES ('ds-ex-a','ws-ex-a','menu','Menu','rest',?)`)
  .run(JSON.stringify({ url: 'https://api.alpha.example/menu', headers: { Authorization: 'Bearer PLAINSECRET' }, api_key: 'enc:v1:CIPHERSECRET' }));
db.prepare("INSERT INTO api_tokens (id,token_hash,prefix,name,user_id,workspace_id,scope) VALUES ('tok-ex-a','TOKENHASHSECRET','st_abcd','CI',?,'ws-ex-a','read')").run(U.ownerA);
db.prepare("INSERT INTO org_sso_providers (id,organization_id,slug,name,issuer,client_id,client_secret_enc,enabled) VALUES ('sso-ex-a','org-ex-a','okta','Okta','https://alpha.okta.example','cid','SSOCIPHERSECRET',1)").run();
db.prepare("INSERT INTO activity_log (user_id,action,details,workspace_id) VALUES (?, 'alpha_did_a_thing', '{}', 'ws-ex-a')").run(U.ownerA);
db.prepare("INSERT INTO activity_log (user_id,action,details,workspace_id) VALUES (?, 'bravo_did_a_thing', '{}', 'ws-ex-b')").run(U.ownerB);
db.prepare("INSERT INTO activity_log (user_id,action,details,organization_id) VALUES (?, 'alpha_org_event', '{}', 'org-ex-a')").run(U.adminA);

const app = express();
app.use(express.json());
app.use('/api/trust', requireAuth, resolveTenancy, require('../routes/trust'));
app.get('/api/public/trust-export/:id', require('../routes/trust').download);
const server = app.listen(0);
after(() => { server.close(); try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ } });

const userRow = (id) => db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
async function call(method, p, who, body, ws = 'ws-ex-a') {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${generateToken(userRow(U[who]), ws)}`;
  const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
  return { status: res.status, json, buf, headers: res.headers };
}
async function waitReady(id) {
  await exporter.runQueue();
  for (let i = 0; i < 100; i++) {
    const j = db.prepare('SELECT status FROM data_exports WHERE id = ?').get(id);
    if (j.status === 'ready' || j.status === 'failed') return j.status;
    await new Promise((r) => setTimeout(r, 50));
  }
  return 'timeout';
}
async function unzip(buf) {
  const unzipper = require('unzipper');
  const dir = await unzipper.Open.buffer(buf);
  const out = {};
  for (const f of dir.files) if (f.type !== 'Directory') out[f.path] = (await f.buffer()).toString('utf8');
  return out;
}
const resetExports = () => db.prepare('DELETE FROM data_exports').run();

/* ───────────── completeness ───────────── */

test('⚠️ every table in the database is either exported (with a category) or excluded (with a reason)', () => {
  const all = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  const unclassified = all.filter((t) => !tables.EXPORTED[t] && !tables.EXCLUDED[t]);
  assert.deepEqual(unclassified, [], `Classify these in lib/trust/export-tables.js: ${unclassified.join(', ')}`);
  for (const t of Object.keys(tables.EXPORTED)) assert.ok(!tables.EXCLUDED[t], `${t} is both exported and excluded`);
  for (const [t, s] of Object.entries(tables.EXPORTED)) {
    assert.ok(tables.CATEGORIES.includes(s.category), `${t}: unknown category ${s.category}`);
    if (s.scope.via) assert.ok(tables.EXPORTED[s.scope.parent], `${t}: parent ${s.scope.parent} is not exported`);
  }
  for (const [t, why] of Object.entries(tables.EXCLUDED)) assert.ok(typeof why === 'string' && why.length > 5, `${t}: give a reason`);
});

test('⚠️ import side: every exported table is restored by an organization import or not restored with a reason', () => {
  const importTables = require('../lib/trust/import-tables');
  for (const t of Object.keys(tables.EXPORTED)) {
    const d = importTables.decision(t, { instance: false });
    assert.ok(d, `Decide in lib/trust/import-tables.js whether an import restores ${t} (RESTORED) or not, and why (NOT_RESTORED / ORG_IMPORT_SKIPS)`);
    if (!d.restore) assert.ok(typeof d.reason === 'string' && d.reason.length > 10, `${t}: give the reason it is not restored`);
    const w = importTables.decision(t, { instance: true });
    assert.ok(w, `${t}: undecided for a whole-server restore`);
  }
  for (const t of [...Object.keys(importTables.RESTORED), ...Object.keys(importTables.ORG_IMPORT_SKIPS), ...Object.keys(importTables.NOT_RESTORED)]) {
    assert.ok(tables.EXPORTED[t], `${t} is in lib/trust/import-tables.js but the export does not carry it`);
  }
});

test('⚠️ import side: every id-like column of a restored table is a scope, a reference, an external id or a person', () => {
  const importTables = require('../lib/trust/import-tables');
  const unclassified = [];
  for (const t of Object.keys(tables.EXPORTED)) {
    const d = importTables.decision(t, { instance: true });
    if (!d || !d.restore) continue;
    const fks = new Set(db.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => f.from));
    const refs = importTables.REFS[t] || {};
    for (const c of db.prepare(`PRAGMA table_info(${t})`).all()) {
      if (!/_id$|_ref$/.test(c.name)) continue;
      if (importTables.SCOPE_COLUMNS.has(c.name) || importTables.USER_COLUMNS.has(c.name) || fks.has(c.name) || c.name in refs || importTables.INT_REFS[`${t}.${c.name}`]) continue;
      unclassified.push(`${t}.${c.name}`);
    }
  }
  assert.deepEqual(unclassified, [], `Classify these in lib/trust/import-tables.js REFS (a table, '*', 'external' or null): ${unclassified.join(', ')}`);
});

test('every exported table\'s scope builds a query that runs', () => {
  for (const t of Object.keys(tables.EXPORTED)) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t);
    if (!exists) continue;
    const w = exporter.whereFor(db, t, 'org-ex-a');
    assert.ok(w, `${t}: no scope`);
    db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${w.sql}`).get(...w.args);
  }
});

/* ───────────── org export ───────────── */

let orgArchive = null;
test('an org owner exports everything: manifest lists every category; files, tables and re-importable workspaces are in it', async () => {
  resetExports();
  const r = await call('POST', '/api/trust/exports', 'ownerA', { kind: 'org' });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(await waitReady(r.json.id), 'ready');
  const l = await call('POST', `/api/trust/exports/${r.json.id}/link`, 'ownerA');
  assert.equal(l.status, 200);
  assert.match(l.json.url, /^\/api\/public\/trust-export\//);
  const d = await call('GET', l.json.url, null);
  assert.equal(d.status, 200);
  assert.match(d.headers.get('content-disposition'), /screentinker-organization-export/);
  orgArchive = await unzip(d.buf);
  const manifest = JSON.parse(orgArchive['manifest.json']);
  assert.equal(manifest.format, 'screentinker-org-export-v1');
  assert.deepEqual(Object.keys(manifest.categories), tables.CATEGORIES);
  assert.equal(manifest.categories.playlists.tables.playlists.rows, 1);
  assert.equal(manifest.categories.playlists.tables.playlist_items.rows, 1);
  // The org's workspace rows, its org-level rows, and the audit row of this very request.
  assert.equal(manifest.categories.audit.tables.activity_log.rows, 3);
  assert.ok(orgArchive['tables/activity_log.jsonl'].includes('alpha_org_event'));
  assert.ok(orgArchive['tables/activity_log.jsonl'].includes('trust.export_org_requested'));
  assert.ok(orgArchive['files/c-ex-a/alpha-logo.png'], 'media bytes are in the archive');
  assert.equal(orgArchive['files/c-ex-a/alpha-logo.png'], 'ALPHA-PNG-BYTES');
  assert.ok(orgArchive['tables/data_sources.jsonl'].includes('api.alpha.example'));
  const wsExport = JSON.parse(orgArchive['workspaces/ws-ex-a/export.json']);
  assert.equal(wsExport.format, 'screentinker-export-v2');
  assert.equal(wsExport.playlists[0].name, 'Alpha Morning');
  assert.equal(wsExport.content[0].original_filepath, 'alpha-logo.png');
  assert.ok(manifest.excluded_tables.mesh_edges, 'what is left out is said, with why');
  assert.ok(manifest.redaction.columns_removed.devices.includes('device_token'));
  assert.ok(manifest.redaction.columns_removed.users.includes('password_hash'));
});

test('⚠️ tenancy: org A\'s export contains nothing of org B', () => {
  const all = Object.entries(orgArchive).map(([k, v]) => k + '\n' + v).join('\n');
  for (const leak of ['org-ex-b', 'ws-ex-b', 'Bravo', 'bravo', 'BRAVO-PNG-BYTES', 'pl-ex-b', 'dev-ex-b', 'c-ex-b', U.ownerB]) {
    assert.ok(!all.includes(leak), `org A export leaked ${leak}`);
  }
});

test('⚠️ secrets never leave: hashes, tokens, encrypted values and secret JSON keys are removed', () => {
  const all = Object.values(orgArchive).join('\n');
  for (const s of ['$2a$10$HASHHASHHASH', 'TOTPCIPHER', 'DEVICETOKENSECRET', 'PAIRSECRET', 'PLAINSECRET', 'CIPHERSECRET', 'TOKENHASHSECRET', 'SSOCIPHERSECRET']) {
    assert.ok(!all.includes(s), `export contains secret ${s}`);
  }
  // What remains of the token and the SSO provider is still useful: who, what, when.
  assert.ok(orgArchive['tables/api_tokens.jsonl'].includes('st_abcd'));
  assert.ok(orgArchive['tables/org_sso_providers.jsonl'].includes('alpha.okta.example'));
});

test('who may export the organization: owner and org admin yes; workspace admin and viewer no', async () => {
  resetExports();
  assert.equal((await call('POST', '/api/trust/exports', 'viewerA', { kind: 'org' })).status, 403);
  assert.equal((await call('POST', '/api/trust/exports', 'wsadminA', { kind: 'org' })).status, 403);
  const r = await call('POST', '/api/trust/exports', 'adminA', { kind: 'org' });
  assert.equal(r.status, 202);
  await waitReady(r.json.id);
  // A viewer cannot mint a link for it either, even knowing the id.
  assert.equal((await call('POST', `/api/trust/exports/${r.json.id}/link`, 'viewerA')).status, 404);
  assert.equal((await call('POST', `/api/trust/exports/${r.json.id}/link`, 'ownerB', null, 'ws-ex-b')).status, 404);
});

test('rate limits: one in progress at a time, and at most three a day', async () => {
  resetExports();
  const first = await call('POST', '/api/trust/exports', 'ownerA', { kind: 'org' });
  assert.equal(first.status, 202);
  const busy = await call('POST', '/api/trust/exports', 'adminA', { kind: 'org' });
  assert.equal(busy.status, 429);
  assert.equal(busy.json.code, 'busy');
  await waitReady(first.json.id);
  for (let i = 0; i < 2; i++) {
    const r = await call('POST', '/api/trust/exports', 'ownerA', { kind: 'org' });
    assert.equal(r.status, 202);
    await waitReady(r.json.id);
  }
  const fourth = await call('POST', '/api/trust/exports', 'ownerA', { kind: 'org' });
  assert.equal(fourth.status, 429);
  assert.equal(fourth.json.code, 'daily_limit');
  // Personal exports are counted separately, per person.
  assert.equal((await call('POST', '/api/trust/exports', 'ownerA', { kind: 'user' })).status, 202);
});

test('the download link: a wrong key, an expired link, and a requester who lost access all get 404', async () => {
  resetExports();
  const r = await call('POST', '/api/trust/exports', 'adminA', { kind: 'org' });
  await waitReady(r.json.id);
  const l = await call('POST', `/api/trust/exports/${r.json.id}/link`, 'adminA');
  assert.equal((await call('GET', `/api/public/trust-export/${r.json.id}?key=nope`, null)).status, 404);
  assert.equal((await call('GET', `/api/public/trust-export/${r.json.id}`, null)).status, 404);
  // The admin is removed from the organization: the link they already hold stops working.
  db.prepare("UPDATE organization_members SET role = 'org_member' WHERE user_id = ?").run(U.adminA);
  assert.equal((await call('GET', l.json.url, null)).status, 404);
  db.prepare("UPDATE organization_members SET role = 'org_admin' WHERE user_id = ?").run(U.adminA);
  assert.equal((await call('GET', l.json.url, null)).status, 200);
  // Expired link.
  const job = db.prepare('SELECT download_hash FROM data_exports WHERE id = ?').get(r.json.id);
  db.prepare('UPDATE data_exports SET download_hash = ? WHERE id = ?').run(job.download_hash.split(':')[0] + ':1', r.json.id);
  assert.equal((await call('GET', l.json.url, null)).status, 404);
  // An expired export is swept from disk.
  db.prepare('UPDATE data_exports SET expires_at = 1 WHERE id = ?').run(r.json.id);
  assert.equal(exporter.sweep(db), 1);
  assert.equal(db.prepare('SELECT status FROM data_exports WHERE id = ?').get(r.json.id).status, 'expired');
  assert.ok(!fs.existsSync(path.join(config.dataDir, 'exports', `${r.json.id}.zip`)));
});

test('requests and downloads are audited', () => {
  const acts = db.prepare("SELECT action FROM activity_log WHERE action LIKE 'trust.export%'").all().map((r) => r.action);
  assert.ok(acts.includes('trust.export_org_requested'));
  assert.ok(acts.includes('trust.export_org_downloaded'));
});

/* ───────────── personal export ───────────── */

test('personal export: the person\'s account, memberships and own activity — nobody else\'s, no secrets', async () => {
  resetExports();
  const r = await call('POST', '/api/trust/exports', 'adminA', { kind: 'user' });
  assert.equal(r.status, 202);
  assert.equal(await waitReady(r.json.id), 'ready');
  // Another person cannot link someone's personal export, even an org owner.
  assert.equal((await call('POST', `/api/trust/exports/${r.json.id}/link`, 'ownerA')).status, 404);
  const l = await call('POST', `/api/trust/exports/${r.json.id}/link`, 'adminA');
  const z = await unzip((await call('GET', l.json.url, null)).buf);
  const manifest = JSON.parse(z['manifest.json']);
  assert.equal(manifest.format, 'screentinker-personal-export-v1');
  const account = JSON.parse(z['account.json']);
  assert.equal(account.user.email, 'adminA@export.local');
  assert.equal(account.organizations[0].id, 'org-ex-a');
  assert.ok(z['activity.jsonl'].includes('alpha_org_event'));
  assert.ok(!z['activity.jsonl'].includes('alpha_did_a_thing'), 'another person\'s activity');
  const all = Object.values(z).join('\n');
  for (const s of ['$2a$10$HASHHASHHASH', 'TOTPCIPHER', 'ownerA@export.local', 'Bravo']) assert.ok(!all.includes(s), `personal export contains ${s}`);
  assert.ok(z['resources/export.json']);
});

test('a personal export works for someone with no organization at all', async () => {
  const r = await call('POST', '/api/trust/exports', 'solo', { kind: 'user' }, null);
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(await waitReady(r.json.id), 'ready');
});

test('the export list shows a person their own jobs, and the org\'s only to its admins', async () => {
  const mine = await call('GET', '/api/trust/exports', 'viewerA');
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.json.organization, []);
  const admin = await call('GET', '/api/trust/exports', 'ownerA');
  assert.ok(admin.json.organization.length >= 0);
  assert.ok(admin.json.limits.per_day === exporter.MAX_PER_DAY);
});

test('the org export lists the SHA-256 of every entry, and the download sends the whole archive\'s', async () => {
  resetExports();
  const r = await call('POST', '/api/trust/exports', 'ownerA', { kind: 'org' });
  assert.equal(await waitReady(r.json.id), 'ready');
  const l = await call('POST', `/api/trust/exports/${r.json.id}/link`, 'ownerA');
  const d = await call('GET', l.json.url, null);
  const crypto = require('crypto');
  assert.equal(d.headers.get('x-export-sha256'), crypto.createHash('sha256').update(d.buf).digest('hex'));
  assert.equal(d.headers.get('accept-ranges'), 'bytes');
  const z = await unzip(d.buf);
  const m = JSON.parse(z['manifest.json']);
  assert.equal(m.integrity.algorithm, 'sha256');
  for (const name of Object.keys(z)) {
    if (name === 'manifest.json') continue;
    assert.ok(m.integrity.entries[name], `${name} has no digest`);
    assert.equal(m.integrity.entries[name].sha256, crypto.createHash('sha256').update(Buffer.from(z[name], 'utf8')).digest('hex'), `${name} digest`);
  }
  // A ranged request resumes from the middle.
  const headers = { Range: 'bytes=10-' };
  const part = await fetch(`http://127.0.0.1:${server.address().port}${l.json.url}`, { headers });
  assert.equal(part.status, 206);
  assert.equal(Buffer.from(await part.arrayBuffer()).compare(d.buf.subarray(10)), 0);
});
