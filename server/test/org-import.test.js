'use strict';

/*
 * Organization import (lib/trust/import*.js, routes/org-import.js, docs/move-server.md), in one
 * process: an organization's export restored as a NEW organization on the same server, which is the
 * hardest case for "never overwrite" (every id, file name and unique code already exists here).
 * The two-server flows (pull, recovery after the source is gone, whole-server) are in
 * org-import-e2e.test.js.
 *
 * Covered here: references rewritten across every kind of link, files, secrets absent and flagged,
 * members invited, other organizations untouched; a tampered archive, an unlisted or missing entry,
 * zip slip and rows outside the organization refused; a storage limit refused before anything is
 * written; tenancy (another org's admin cannot see, restore into, or target an organization);
 * resume after an interruption without duplicates; rollback; SSRF on the source link; the disk
 * folder; the screen handover and pairing into an imported screen.
 */
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'st-org-import-' + process.pid + '-' + Date.now());
process.env.JWT_SECRET = 'test-secret-org-import';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const exporter = require('../lib/trust/export');
const imp = require('../lib/trust/import');
const restoreLib = require('../lib/trust/import-restore');
const archiveLib = require('../lib/trust/import-archive');

const U = { ownerA: 'u-oi-owner-a', adminA: 'u-oi-admin-a', editorA: 'u-oi-editor-a', imp: 'u-oi-imp', ownerB: 'u-oi-owner-b', plat: 'u-oi-plat' };
for (const [k, id] of Object.entries(U)) {
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role,name,plan_id) VALUES (?,?,'$2a$10$HASHHASH',?,?,'enterprise')").run(id, `${k}@import.local`, k === 'plat' ? 'platform_admin' : 'user', k);
}
db.prepare("INSERT OR IGNORE INTO plans (id,name,display_name,max_devices,max_storage_mb) VALUES ('enterprise','enterprise','Enterprise',-1,-1)").run();
db.prepare("UPDATE users SET plan_id = 'enterprise'").run();
const org = (id, name, owner) => db.prepare('INSERT INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(id, name, owner);
org('org-a', 'Alpha Bakery', U.ownerA); org('org-b', 'Bravo Corp', U.ownerB); org('org-d', 'Delta Home', U.imp);
for (const [o, ws, n] of [['org-a', 'ws-a1', 'Alpha Shop'], ['org-a', 'ws-a2', 'Alpha Kiosk'], ['org-b', 'ws-b', 'Bravo Shop'], ['org-d', 'ws-d', 'Delta Shop']]) {
  db.prepare('INSERT INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(ws, o, n);
}
const om = db.prepare('INSERT INTO organization_members (organization_id,user_id,role) VALUES (?,?,?)');
om.run('org-a', U.ownerA, 'org_owner'); om.run('org-a', U.adminA, 'org_admin'); om.run('org-b', U.ownerB, 'org_owner'); om.run('org-d', U.imp, 'org_owner');
const wm = db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)');
wm.run('ws-a1', U.ownerA, 'workspace_admin'); wm.run('ws-a1', U.editorA, 'workspace_editor'); wm.run('ws-a2', U.editorA, 'workspace_viewer');
wm.run('ws-b', U.ownerB, 'workspace_admin'); wm.run('ws-d', U.imp, 'workspace_admin');

// Source organization A: media, folders, playlists (nested), layouts, schedules, groups, a screen,
// a sign with a brand kit, a data source with a secret, triggers, an experiment, a request form.
const id = () => crypto.randomUUID();
const C1 = id(), C2 = id(), F1 = id(), F2 = id(), PL = id(), PLC = id(), W = id(), WS = id(), L = id(), Z = id(), S = id(), G = id(), D = id(), DB = id(), DECK = id(), DS = id(), TR = id(), EXP = id(), RF = id(), QR = id();
fs.mkdirSync(config.contentDir, { recursive: true });
fs.writeFileSync(path.join(config.contentDir, `${C1}.png`), 'ALPHA-PNG-BYTES');
fs.writeFileSync(path.join(config.contentDir, 'bravo.png'), 'BRAVO-PNG-BYTES');
db.prepare("INSERT INTO content_folders (id,user_id,workspace_id,parent_id,name) VALUES (?,?,'ws-a1',NULL,'Menus')").run(F1, U.ownerA);
db.prepare("INSERT INTO content_folders (id,user_id,workspace_id,parent_id,name) VALUES (?,?,'ws-a1',?,'Summer')").run(F2, U.ownerA, F1);
db.prepare("INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size,folder_id) VALUES (?,?,'ws-a1','logo.png',?,'image/png',15,?)").run(C1, U.ownerA, `${C1}.png`, F2);
db.prepare("INSERT INTO content (id,user_id,workspace_id,filename,remote_url,mime_type) VALUES (?,?,'ws-a1','site','https://example.com/menu','text/html')").run(C2, U.ownerA);
db.prepare("INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size) VALUES ('c-b',?,'ws-b','bravo.png','bravo.png','image/png',15)").run(U.ownerB);
db.prepare("INSERT INTO widgets (id,user_id,workspace_id,widget_type,name,config) VALUES (?,?,'ws-a1','clock','Clock','{}')").run(W, U.ownerA);
db.prepare("INSERT INTO layouts (id,user_id,workspace_id,name) VALUES (?,?,'ws-a1','Split')").run(L, U.ownerA);
db.prepare("INSERT INTO layout_zones (id,layout_id,name) VALUES (?,?,'Main')").run(Z, L);
db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name) VALUES (?,?,'ws-a1','Child')").run(PLC, U.ownerA);
db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name,status,published_snapshot) VALUES (?,?,'ws-a1','Morning','published',?)").run(PL, U.ownerA, JSON.stringify([{ content_id: C1, filepath: `${C1}.png` }]));
const item1 = db.prepare('INSERT INTO playlist_items (playlist_id,content_id,zone_id,sort_order) VALUES (?,?,?,0)').run(PL, C1, Z).lastInsertRowid;
db.prepare('INSERT INTO playlist_items (playlist_id,widget_id,sort_order) VALUES (?,?,1)').run(PL, W);
db.prepare('INSERT INTO playlist_items (playlist_id,child_playlist_id,sort_order) VALUES (?,?,2)').run(PL, PLC);
db.prepare('INSERT INTO playlist_items (playlist_id,content_id,sort_order) VALUES (?,?,0)').run(PLC, C1);
db.prepare("INSERT INTO playlist_item_schedules (id,playlist_item_id,active_days) VALUES (?,?,'1,2,3')").run(id(), item1);
db.prepare("INSERT INTO devices (id,name,workspace_id,user_id,playlist_id,device_token,pairing_code,enrol_key,client_type) VALUES (?,'Alpha Window','ws-a1',?,?,'DEVICETOKENSECRET','111222',?,'player')").run(D, U.ownerA, PL, 'k'.repeat(43));
db.prepare("INSERT INTO devices (id,name,workspace_id,user_id) VALUES (?,'Bravo Window','ws-b',?)").run(DB, U.ownerB);
db.prepare("INSERT INTO device_fingerprints (fingerprint,device_id,user_id) VALUES ('fp-alpha-window',?,?)").run(D, U.ownerA);
db.prepare("INSERT INTO device_groups (id,user_id,workspace_id,name) VALUES (?,?,'ws-a1','Windows')").run(G, U.ownerA);
db.prepare('INSERT INTO device_group_members (group_id,device_id) VALUES (?,?)').run(G, D);
db.prepare("INSERT INTO schedules (id,user_id,workspace_id,device_id,playlist_id,zone_id,title,start_time,end_time) VALUES (?,?,'ws-a1',?,?,?,'Breakfast','08:00','11:00')").run(S, U.ownerA, D, PL, Z);
db.prepare("INSERT INTO widgets (id,user_id,workspace_id,widget_type,name,config) VALUES (?,?,'ws-a1','slide','Sign',?)").run(WS, U.ownerA, JSON.stringify({ slide: { background_content_id: C1, elements: [{ kind: 'text', text: 'Fresh bread' }] } }));
db.prepare("INSERT INTO slide_decks (id,workspace_id,user_id,name,doc,published_widget_ids,created_at,updated_at) VALUES (?,'ws-a1',?,'Bread sign',?,?,1,1)")
  .run(DECK, U.ownerA, JSON.stringify({ slides: [{ id: 's1', widget_id: WS, background_content_id: C1 }] }), JSON.stringify([WS]));
db.prepare("INSERT INTO brand_kits (workspace_id,business_name,logo_content_id,colors) VALUES ('ws-a1','Alpha Bakery',?,'[\"#aa0000\"]')").run(C1);
db.prepare("INSERT INTO data_sources (id,workspace_id,slug,name,type,config) VALUES (?,'ws-a1','menu','Square menu','square',?)").run(DS, JSON.stringify({ environment: 'production', location_id: 'LOC1', access_token: 'enc:v1:SQUARESECRET' }));
db.prepare("INSERT INTO triggers (id,workspace_id,name,match_token,target_kind,target_ref) VALUES (?,'ws-a1','Fire','MATCHTOKENSECRET','playlist',?)").run(TR, PL);
db.prepare("INSERT INTO trigger_assignments (trigger_id,target_type,target_id) VALUES (?,'device',?)").run(TR, D);
// A reference to ANOTHER organization's screen, as a hand-edited row might carry: never kept.
db.prepare("INSERT INTO trigger_assignments (trigger_id,target_type,target_id) VALUES (?,'device',?)").run(TR, DB);
db.prepare("INSERT INTO experiments (id,workspace_id,name,playlist_id,slot_item_id,variants) VALUES (?,'ws-a1','Price test',?,?,?)").run(EXP, PL, item1, JSON.stringify([{ content_id: C1 }]));
db.prepare('INSERT INTO experiment_units (experiment_id,unit_key,label,device_ids) VALUES (?,?,?,?)').run(EXP, 'u1', 'Front', JSON.stringify([D]));
db.prepare("INSERT INTO request_forms (id,workspace_id,code,title,targets) VALUES (?,'ws-a1','FORMALPHA','Ask us',?)").run(RF, JSON.stringify([{ kind: 'playlist', id: PL }]));
db.prepare("INSERT INTO qr_links (id,workspace_id,code,name,target_url) VALUES (?,'ws-a1','QRALPHA','Menu','https://example.com')").run(QR);
db.prepare("INSERT INTO activity_log (user_id,action,details,workspace_id) VALUES (?, 'alpha_did_a_thing', '{\"x\":1}', 'ws-a1')").run(U.ownerA);
db.prepare("INSERT INTO org_sso_providers (id,organization_id,slug,name,issuer,client_id,client_secret_enc,enabled) VALUES (?,'org-a','alpha-okta','Okta','https://alpha.okta.example','cid','SSOCIPHERSECRET',1)").run(id());

const app = express();
app.use(express.json());
app.set('io', { of: () => fakeNs });
app.use('/api/org-import', requireAuth, resolveTenancy, require('../routes/org-import'));
const server = app.listen(0);
const fakeNs = { sent: [], adapter: { rooms: new Map() }, to(room) { return { emit: (ev, data) => fakeNs.sent.push({ room, ev, data }) }; } };
after(() => { server.close(); try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ } });

const userRow = (uid) => db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(uid);
const wsOf = { ownerA: 'ws-a1', adminA: 'ws-a1', imp: 'ws-d', ownerB: 'ws-b', plat: 'ws-d', editorA: 'ws-a1' };
async function call(method, p, who, body, { raw = null, headers = {} } = {}) {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const h = { ...headers };
  if (who) h.Authorization = `Bearer ${generateToken(userRow(U[who]), wsOf[who])}`;
  if (raw) h['Content-Type'] = 'application/octet-stream'; else if (body) h['Content-Type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method, headers: h, body: raw || (body ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text };
}
async function waitJob(jobId, statuses, ms = 30000) {
  const until = Date.now() + ms;
  for (;;) {
    await imp.runQueue();
    const j = imp.getJob(db, jobId);
    if (statuses.includes(j.status)) return j;
    if (Date.now() > until) throw new Error(`job ${jobId} stuck in ${j.status}: ${j.error}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

let exportFile = null;
async function exportOrgA() {
  db.prepare('DELETE FROM data_exports').run();
  const eid = exporter.request({ db, kind: 'org', orgId: 'org-a', userId: U.ownerA });
  await exporter.runQueue(db);
  const job = db.prepare('SELECT * FROM data_exports WHERE id = ?').get(eid);
  assert.equal(job.status, 'ready', job.error);
  return exporter.filePath(job);
}
async function uploadJob(who, file) {
  const buf = fs.readFileSync(file);
  const c = await call('POST', '/api/org-import/jobs', who, { source: 'upload', bytes: buf.length, file_name: 'alpha.zip' });
  assert.equal(c.status, 201, c.text);
  // Two chunks, to exercise the offset protocol.
  const mid = Math.floor(buf.length / 2);
  let r = await call('PATCH', `/api/org-import/jobs/${c.json.id}/upload`, who, null, { raw: buf.subarray(0, mid), headers: { 'Upload-Offset': '0' } });
  assert.equal(r.status, 200, r.text);
  // A repeated chunk is told where the upload is, not appended twice.
  r = await call('PATCH', `/api/org-import/jobs/${c.json.id}/upload`, who, null, { raw: buf.subarray(0, mid), headers: { 'Upload-Offset': '0' } });
  assert.equal(r.status, 409);
  assert.equal(r.json.offset, mid);
  r = await call('PATCH', `/api/org-import/jobs/${c.json.id}/upload`, who, null, { raw: buf.subarray(mid), headers: { 'Upload-Offset': String(mid) } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.complete, true);
  return c.json.id;
}
const countsOf = (orgId) => {
  const out = {};
  for (const t of ['content', 'playlists', 'devices', 'widgets', 'layouts', 'schedules', 'slide_decks', 'data_sources', 'triggers', 'device_groups']) {
    out[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE workspace_id IN (SELECT id FROM workspaces WHERE organization_id = ?)`).get(orgId).n;
  }
  return out;
};
// Finished with earlier jobs: cancel them and age them out of the daily cap (tested on its own below).
const cancelActive = () => {
  db.prepare("UPDATE org_imports SET status = 'cancelled' WHERE status IN ('receiving','fetching','scanning','scanned','interrupted')").run();
  db.prepare('UPDATE org_imports SET created_at = created_at - 86401').run();
};

/* ───────────── the round trip ───────────── */

let doneJob = null;
test('an organization admin imports an export into a NEW organization: every reference rewritten, nothing else touched', async () => {
  exportFile = await exportOrgA();
  const before = { a: countsOf('org-a'), b: countsOf('org-b'), d: countsOf('org-d') };
  const jobId = await uploadJob('imp', exportFile);
  const scanned = await waitJob(jobId, ['scanned', 'refused']);
  assert.equal(scanned.status, 'scanned', scanned.error);
  const scan = JSON.parse(scanned.scan);
  assert.deepEqual(scan.workspaces.map((w) => w.name).sort(), ['Alpha Kiosk', 'Alpha Shop']);
  assert.equal(scan.devices.length, 1);
  assert.ok(scan.members.some((m) => m.email === 'admina@import.local' && m.org_role === 'org_admin'));
  assert.ok(scan.data_sources.some((d) => d.name === 'Square menu' && d.needs_secret), 'the Square data source is flagged as needing its token');
  assert.ok(scan.integrations.some((i) => i.kind === 'sso'), 'single sign-on is on the reconnect list');
  assert.ok(scan.not_restored.some((n) => n.table === 'outbound_ledger' || n.table === 'org_sso_domains' || n.reason), 'what is not restored is said');
  assert.equal(scan.media.files, 1);
  assert.equal(scan.room.ok, true);

  const r = await call('POST', `/api/org-import/jobs/${jobId}/restore`, 'imp', { target: { mode: 'new' } });
  assert.equal(r.status, 202, r.text);
  doneJob = await waitJob(jobId, ['done', 'failed', 'partial']);
  assert.equal(doneJob.status, 'done', doneJob.error);
  const newOrg = doneJob.organization_id;
  assert.ok(newOrg && newOrg !== 'org-a');
  assert.equal(db.prepare('SELECT owner_user_id FROM organizations WHERE id = ?').get(newOrg).owner_user_id, U.imp, 'the importer owns it');
  assert.equal(db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?').get(newOrg, U.imp).role, 'org_owner');

  // Nothing else moved: the source organization, another organization, the importer's own.
  assert.deepEqual({ a: countsOf('org-a'), b: countsOf('org-b'), d: countsOf('org-d') }, before);
  const now = countsOf(newOrg);
  assert.deepEqual(now, before.a, `every kind of row came across: ${JSON.stringify(JSON.parse(doneJob.result).stats)}`);

  const wsIds = db.prepare('SELECT id FROM workspaces WHERE organization_id = ?').all(newOrg).map((w) => w.id);
  const inNew = (t, extra = '') => db.prepare(`SELECT * FROM ${t} WHERE workspace_id IN (${wsIds.map(() => '?').join(',')}) ${extra}`).all(...wsIds);
  const [content] = inNew('content', "AND filename = 'logo.png'");
  assert.notEqual(content.id, C1, 'a new id');
  assert.ok(fs.existsSync(path.join(config.contentDir, content.filepath)), 'the file is on disk');
  assert.equal(fs.readFileSync(path.join(config.contentDir, content.filepath), 'utf8'), 'ALPHA-PNG-BYTES');
  assert.equal(content.byte_digest, crypto.createHash('sha256').update('ALPHA-PNG-BYTES').digest('hex'));
  const [summer] = inNew('content_folders', "AND name = 'Summer'");
  const [menus] = inNew('content_folders', "AND name = 'Menus'");
  assert.equal(content.folder_id, summer.id);
  assert.equal(summer.parent_id, menus.id, 'a folder inside a folder keeps its parent');

  const [morning] = inNew('playlists', "AND name = 'Morning'");
  const [child] = inNew('playlists', "AND name = 'Child'");
  const items = db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order').all(morning.id);
  assert.equal(items.length, 3);
  assert.equal(items[0].content_id, content.id, 'a playlist item points at the imported content');
  assert.equal(items[2].child_playlist_id, child.id, 'a nested playlist points at the imported child');
  const [layout] = inNew('layouts');
  const zone = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ?').get(layout.id);
  assert.equal(items[0].zone_id, zone.id, 'an item\'s zone is the imported layout\'s zone');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM playlist_item_schedules WHERE playlist_item_id = ?').get(items[0].id).n, 1, 'per-item schedule follows its (new, integer) item id');
  assert.ok(morning.published_snapshot.includes(content.id) && !morning.published_snapshot.includes(C1), 'the published snapshot names the imported content');

  const [dev] = inNew('devices');
  assert.equal(dev.playlist_id, morning.id);
  assert.equal(dev.status, 'offline');
  assert.equal(dev.device_token, null, 'no device token travels');
  assert.ok(dev.enrol_key && dev.enrol_key !== 'k'.repeat(43), 'a fresh enrolment key of this server');
  const [group] = inNew('device_groups');
  assert.ok(db.prepare('SELECT 1 FROM device_group_members WHERE group_id = ? AND device_id = ?').get(group.id, dev.id));
  const [sched] = inNew('schedules');
  assert.equal(sched.device_id, dev.id); assert.equal(sched.playlist_id, morning.id); assert.equal(sched.zone_id, zone.id);

  // The sign: deck, its published widget and its brand kit all point at the imported things.
  const [deck] = inNew('slide_decks');
  const [slideWidget] = inNew('widgets', "AND widget_type = 'slide'");
  assert.deepEqual(JSON.parse(deck.published_widget_ids), [slideWidget.id]);
  assert.equal(JSON.parse(deck.doc).slides[0].widget_id, slideWidget.id);
  assert.equal(JSON.parse(deck.doc).slides[0].background_content_id, content.id);
  assert.equal(JSON.parse(slideWidget.config).slide.background_content_id, content.id);
  const kit = db.prepare('SELECT * FROM brand_kits WHERE workspace_id IN (' + wsIds.map(() => '?').join(',') + ')').get(...wsIds);
  assert.equal(kit.logo_content_id, content.id);

  // Secrets: absent, and the things that need them say so.
  const [ds] = inNew('data_sources');
  assert.ok(!ds.config.includes('SQUARESECRET') && !JSON.parse(ds.config).access_token);
  assert.equal(ds.last_status, 'error');
  const [trigger] = inNew('triggers');
  assert.notEqual(trigger.match_token, 'MATCHTOKENSECRET');
  assert.equal(trigger.target_ref, morning.id);
  const assigns = db.prepare('SELECT * FROM trigger_assignments WHERE trigger_id = ?').all(trigger.id);
  assert.deepEqual(assigns.map((a) => a.target_id), [dev.id], 'the reference to another organization\'s screen was dropped, not kept');
  const sso = db.prepare('SELECT * FROM org_sso_providers WHERE organization_id = ?').get(newOrg);
  assert.equal(sso.enabled, 0);
  assert.ok(!sso.client_secret_enc);
  assert.notEqual(sso.slug, 'alpha-okta', 'a slug that is taken here gets a fresh one');
  const [exp] = inNew('experiments');
  assert.equal(exp.slot_item_id, items[0].id, 'an integer reference to a playlist item is rewritten');
  assert.equal(JSON.parse(exp.variants)[0].content_id, content.id);
  assert.deepEqual(JSON.parse(db.prepare('SELECT device_ids FROM experiment_units WHERE experiment_id = ?').get(exp.id).device_ids), [dev.id]);
  const [form] = inNew('request_forms');
  assert.notEqual(form.code, 'FORMALPHA', 'a public code taken here gets a fresh one');
  assert.equal(JSON.parse(form.targets)[0].id, morning.id);
  // A fingerprint already known here is never taken over.
  assert.equal(db.prepare("SELECT device_id FROM device_fingerprints WHERE fingerprint = 'fp-alpha-window'").get().device_id, D);

  // People: pending invites with their roles; the importer needs none.
  const inv = await call('GET', `/api/org-import/jobs/${jobId}/invites`, 'imp');
  assert.equal(inv.status, 200);
  const byEmail = (e) => inv.json.invites.filter((i) => i.email === e);
  assert.ok(byEmail('admina@import.local').some((i) => i.org_role === 'org_admin' && i.org_only), 'an org admin with no workspace of their own');
  assert.deepEqual(byEmail('editora@import.local').map((i) => i.role).sort(), ['workspace_editor', 'workspace_viewer']);
  assert.ok(byEmail('ownera@import.local').some((i) => i.org_role === 'org_owner'));
  assert.ok(inv.json.invites.every((i) => /\/app#\/accept-invite\//.test(i.accept_url)));
  assert.equal(byEmail('imp@import.local').length, 0);

  // Audit history: read-only, the actor kept as text.
  const log = db.prepare("SELECT * FROM activity_log WHERE action = 'alpha_did_a_thing' AND workspace_id IN (" + wsIds.map(() => '?').join(',') + ')').get(...wsIds);
  assert.equal(log.user_id, null);
  assert.equal(String(JSON.parse(log.details).imported.by).toLowerCase(), 'ownera@import.local');
});

test('accepting an imported invite adds the organization role and nothing else about the account', async () => {
  const inv = db.prepare("SELECT * FROM workspace_invites WHERE import_job_id = ? AND email = 'admina@import.local'").get(doneJob.id);
  const auth = express();
  auth.use(express.json());
  auth.use('/api/auth', require('../routes/auth'));
  const s = auth.listen(0);
  try {
    await new Promise((r) => (s.listening ? r() : s.once('listening', r)));
    const before = db.prepare('SELECT role, plan_id, password_hash FROM users WHERE id = ?').get(U.adminA);
    const r = await fetch(`http://127.0.0.1:${s.address().port}/api/auth/accept-invite/${inv.id}`, { method: 'POST', headers: { Authorization: `Bearer ${generateToken(userRow(U.adminA), 'ws-a1')}` } });
    assert.equal(r.status, 200, await r.text());
    assert.equal(db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?').get(doneJob.organization_id, U.adminA).role, 'org_admin');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workspace_members WHERE user_id = ? AND workspace_id IN (SELECT id FROM workspaces WHERE organization_id = ?)').get(U.adminA, doneJob.organization_id).n, 0, 'org-only: no workspace membership added');
    assert.deepEqual(db.prepare('SELECT role, plan_id, password_hash FROM users WHERE id = ?').get(U.adminA), before);
  } finally { s.close(); }
});

/* ───────────── tenancy ───────────── */

test('⚠️ tenancy: another organization\'s admin cannot see an import, restore it, or target another organization', async () => {
  cancelActive();
  // Bravo's owner cannot see Delta's import.
  assert.equal((await call('GET', `/api/org-import/jobs/${doneJob.id}`, 'ownerB')).status, 404);
  const list = await call('GET', '/api/org-import/jobs', 'ownerB');
  assert.ok(!list.json.jobs.some((j) => j.id === doneJob.id));
  // A fresh import by Bravo's owner may not target Alpha (not theirs), nor Delta.
  const jobId = await uploadJob('ownerB', exportFile);
  await waitJob(jobId, ['scanned']);
  for (const target of ['org-a', 'org-d']) {
    const r = await call('POST', `/api/org-import/jobs/${jobId}/restore`, 'ownerB', { target: { mode: 'existing', organization_id: target } });
    assert.equal(r.status, 403, r.text);
  }
  // Nor can the importer restore Bravo's job.
  assert.equal((await call('POST', `/api/org-import/jobs/${jobId}/restore`, 'imp', { target: { mode: 'new' } })).status, 404);
  // Into their own organization, which is not empty: refused, never merged.
  const r = await call('POST', `/api/org-import/jobs/${jobId}/restore`, 'ownerB', { target: { mode: 'existing', organization_id: 'org-b' } });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'not_empty');
  // A workspace editor is not an organization admin.
  assert.equal((await call('POST', '/api/org-import/jobs', 'editorA', { source: 'upload', bytes: 10 })).status, 403);
  // An org admin cannot start a whole-server import, nor use the server's disk.
  assert.equal((await call('POST', '/api/org-import/jobs', 'imp', { kind: 'instance', source: 'upload', bytes: 10 })).status, 403);
  assert.equal((await call('POST', '/api/org-import/jobs', 'imp', { source: 'disk', disk_name: 'x.zip' })).status, 403);
  assert.equal((await call('GET', '/api/org-import/disk', 'imp')).status, 403);
  assert.equal((await call('POST', '/api/org-import/instance-exports', 'imp', {})).status, 403);
  cancelActive();
});

/* ───────────── refusals ───────────── */

async function rezip(file, mutate) {
  // Rebuild an archive entry by entry, letting `mutate(entries)` change names, bytes or the manifest.
  const unzipper = require('unzipper');
  const dir = await unzipper.Open.file(file);
  const entries = [];
  for (const f of dir.files) if (f.type !== 'Directory') entries.push({ name: f.path, data: await f.buffer() });
  mutate(entries);
  const out = path.join(process.env.DATA_DIR, `mut-${crypto.randomBytes(4).toString('hex')}.zip`);
  const { ZipArchive } = require('archiver');
  const a = new ZipArchive({ zlib: { level: 1 } });
  const ws = fs.createWriteStream(out);
  const done = new Promise((r, j) => { ws.on('close', r); a.on('error', j); });
  a.pipe(ws);
  for (const e of entries) a.append(e.data, { name: e.name });
  await a.finalize();
  await done;
  return out;
}
const manifestOf = (entries) => JSON.parse(entries.find((e) => e.name === 'manifest.json').data.toString('utf8'));
const setManifest = (entries, m) => { entries.find((e) => e.name === 'manifest.json').data = Buffer.from(JSON.stringify(m)); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function scanOf(file) {
  cancelActive();
  const jobId = await uploadJob('imp', file);
  return waitJob(jobId, ['scanned', 'refused']);
}

test('⚠️ a tampered archive is refused: a changed entry, an unlisted entry, a missing entry', async () => {
  const changed = await rezip(exportFile, (es) => { const e = es.find((x) => x.name === 'tables/playlists.jsonl'); e.data = Buffer.from(e.data.toString().replace('Morning', 'Mourning')); });
  let j = await scanOf(changed);
  assert.equal(j.status, 'refused');
  assert.match(j.error, /does not match the manifest/);
  const extra = await rezip(exportFile, (es) => es.push({ name: 'tables/devices.jsonl.bak', data: Buffer.from('x') }));
  j = await scanOf(extra);
  assert.equal(j.status, 'refused');
  const missing = await rezip(exportFile, (es) => es.splice(es.findIndex((x) => x.name === 'tables/content.jsonl'), 1));
  j = await scanOf(missing);
  assert.equal(j.status, 'refused');
  assert.match(j.error, /missing/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM organizations WHERE name LIKE 'Alpha Bakery%'").get().n, 2, 'nothing was created');
});

test('⚠️ zip slip and symlinks are refused before anything is read', async () => {
  // archiver tidies names, so the hostile ones are written over a placeholder of the same length in
  // the finished bytes (local header and central directory both).
  const plant = async (placeholder, hostile, attrs = null) => {
    const f = await rezip(exportFile, (es) => es.push({ name: placeholder, data: Buffer.from('x') }));
    let buf = fs.readFileSync(f);
    buf = Buffer.from(buf.toString('latin1').split(placeholder).join(hostile), 'latin1');
    if (attrs != null) {
      // Central directory entry for the placeholder: external attributes at offset 38 of its header.
      const at = buf.lastIndexOf(Buffer.from(hostile, 'latin1'));
      buf.writeUInt32LE(attrs, at - 46 + 38);
    }
    fs.writeFileSync(f, buf);
    return f;
  };
  const slip = await plant('AA/AA/evil.txt', '../../evil.txt');
  await assert.rejects(archiveLib.open(slip), (e) => e.code === 'unsafe_entry');
  const abs = await plant('Xetc/passwd.x', '/etc/passwd.x');
  await assert.rejects(archiveLib.open(abs), (e) => e.code === 'unsafe_entry');
  const link = await plant('files/aaaa/link.png', 'files/aaaa/link.png', (0o120777 << 16) >>> 0);
  await assert.rejects(archiveLib.open(link), (e) => e.code === 'unsafe_entry');
  const j = await scanOf(slip);
  assert.equal(j.status, 'refused');
  assert.match(j.error, /unsafe path/);
  assert.ok(!fs.existsSync(path.join(process.env.DATA_DIR, '..', 'evil.txt')));
});

test('⚠️ rows outside the organization refuse the whole archive, even with a matching digest', async () => {
  const edited = await rezip(exportFile, (es) => {
    const e = es.find((x) => x.name === 'tables/playlists.jsonl');
    e.data = Buffer.concat([e.data, Buffer.from(JSON.stringify({ id: crypto.randomUUID(), user_id: U.ownerB, workspace_id: 'ws-b', name: 'Smuggled' }) + '\n')]);
    const m = manifestOf(es);
    m.integrity.entries['tables/playlists.jsonl'] = { sha256: sha(e.data), bytes: e.data.length };
    setManifest(es, m);
  });
  const j = await scanOf(edited);
  assert.equal(j.status, 'refused');
  assert.match(j.error, /do not belong to its organization/);
});

test('⚠️ an organization that does not fit the plan\'s storage is refused before anything is written', async () => {
  cancelActive();
  db.prepare("INSERT OR IGNORE INTO plans (id,name,display_name,max_devices,max_storage_mb) VALUES ('tiny','tiny','Tiny',100,0)").run();
  db.prepare("UPDATE users SET plan_id = 'tiny' WHERE id = ?").run(U.ownerB);
  const jobId = await uploadJob('ownerB', exportFile);
  const j = await waitJob(jobId, ['scanned']);
  assert.equal(JSON.parse(j.scan).room.ok, false);
  const orgsBefore = db.prepare('SELECT COUNT(*) AS n FROM organizations').get().n;
  const r = await call('POST', `/api/org-import/jobs/${jobId}/restore`, 'ownerB', { target: { mode: 'new' } });
  assert.equal(r.status, 413, r.text);
  assert.equal(r.json.code, 'no_room');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM organizations').get().n, orgsBefore);
  db.prepare("UPDATE users SET plan_id = 'enterprise' WHERE id = ?").run(U.ownerB);
  cancelActive();
});

/* ───────────── resume and rollback ───────────── */

test('an interrupted restore resumes where it stopped, with nothing duplicated', async () => {
  cancelActive();
  const jobId = await uploadJob('imp', exportFile);
  await waitJob(jobId, ['scanned']);
  // Crash after the playlist items are committed (a stop between two batches).
  const orig = restoreLib.Restorer.prototype.saveProgress;
  let crashed = false;
  restoreLib.Restorer.prototype.saveProgress = function (p) {
    orig.call(this, p);
    if (!crashed && p.table === 'playlist_items' && p.rows > 0) { crashed = true; throw Object.assign(new Error('simulated crash'), { simulatedCrash: true }); }
  };
  const realRollback = restoreLib.rollback;
  restoreLib.rollback = () => { throw new Error('the process died: no rollback'); };
  try {
    await call('POST', `/api/org-import/jobs/${jobId}/restore`, 'imp', { target: { mode: 'new' } });
    const j = await waitJob(jobId, ['partial', 'failed', 'done']);
    assert.equal(j.status, 'partial');
    // The process comes back: the job is restoring again, from its cursor.
    db.prepare("UPDATE org_imports SET status = 'restoring', error = NULL WHERE id = ?").run(jobId);
  } finally { restoreLib.Restorer.prototype.saveProgress = orig; restoreLib.rollback = realRollback; }
  const j = await waitJob(jobId, ['done', 'failed', 'partial']);
  assert.equal(j.status, 'done', j.error);
  assert.deepEqual(countsOf(j.organization_id), countsOf('org-a'));
  const wsIds = db.prepare('SELECT id FROM workspaces WHERE organization_id = ?').all(j.organization_id).map((w) => w.id);
  const items = db.prepare(`SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id IN (SELECT id FROM playlists WHERE workspace_id IN (${wsIds.map(() => '?').join(',')}))`).get(...wsIds).n;
  assert.equal(items, 4, 'no item written twice');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE organization_id = ?').get(j.organization_id).n, 2);
});

test('a restore that fails is rolled back: the organization and everything in it are gone', async () => {
  cancelActive();
  const jobId = await uploadJob('imp', exportFile);
  await waitJob(jobId, ['scanned']);
  const orig = restoreLib.Restorer.prototype.restoreMembers;
  restoreLib.Restorer.prototype.restoreMembers = async function () { throw new Error('boom'); };
  const orgsBefore = db.prepare('SELECT COUNT(*) AS n FROM organizations').get().n;
  const contentBefore = db.prepare('SELECT COUNT(*) AS n FROM content').get().n;
  const logBefore = db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'alpha_did_a_thing'").get().n;
  try {
    await call('POST', `/api/org-import/jobs/${jobId}/restore`, 'imp', { target: { mode: 'new' } });
    const j = await waitJob(jobId, ['failed', 'partial', 'done']);
    assert.equal(j.status, 'failed');
    assert.match(j.error, /boom/);
  } finally { restoreLib.Restorer.prototype.restoreMembers = orig; }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM organizations').get().n, orgsBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content').get().n, contentBefore);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'alpha_did_a_thing'").get().n, logBefore, 'the imported history goes too, not just detached');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM org_import_ids WHERE job_id = ?').get(jobId).n, 0);
});

/* ───────────── sources ───────────── */

test('⚠️ SSRF: a pull from a private, loopback or metadata address is refused up front', async () => {
  cancelActive();
  for (const host of ['127.0.0.1', '169.254.169.254', '10.0.0.5', '[::1]', 'localhost']) {
    const r = await call('POST', '/api/org-import/jobs', 'imp', { source: 'pull', url: `http://${host}/api/public/trust-export/abcdefgh-1234?key=${'a'.repeat(43)}` });
    assert.equal(r.status, 400, `${host}: ${r.text}`);
    assert.equal(r.json.code, 'blocked_address', host);
  }
  const bad = await call('POST', '/api/org-import/jobs', 'imp', { source: 'pull', url: 'https://example.com/whatever' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'bad_link');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM org_imports WHERE source = 'pull'").get().n, 0);
});

test('a pull that drops mid-transfer resumes with Range, and the whole file is checked against the source\'s digest', async () => {
  cancelActive();
  const http = require('http');
  const buf = fs.readFileSync(exportFile);
  const digest = crypto.createHash('sha256').update(buf).digest('hex');
  const seen = [];
  let lie = false;
  const src = http.createServer((req, res) => {
    seen.push(req.headers.range || null);
    const m = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    const start = m ? Number(m[1]) : 0;
    res.setHeader('X-Export-SHA256', lie ? 'f'.repeat(64) : digest);
    res.setHeader('Content-Type', 'application/zip');
    if (start) {
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${buf.length - 1}/${buf.length}`, 'Content-Length': buf.length - start });
      return res.end(buf.subarray(start));
    }
    res.writeHead(200, { 'Content-Length': buf.length });
    if (seen.length === 1) { res.write(buf.subarray(0, Math.floor(buf.length / 2))); setTimeout(() => res.socket.destroy(), 50); return; }
    res.end(buf);
  });
  await new Promise((r) => src.listen(0, '127.0.0.1', r));
  // The operator opened this address (docs/outbound-requests.md); only for this test.
  process.env.OUTBOUND_ALLOW_HOSTS = '127.0.0.1';
  try {
    const url = `http://127.0.0.1:${src.address().port}/api/public/trust-export/abcdefgh-0001?key=${'k'.repeat(43)}`;
    const c = await call('POST', '/api/org-import/jobs', 'imp', { source: 'pull', url });
    assert.equal(c.status, 201, c.text);
    let j = await waitJob(c.json.id, ['interrupted', 'scanned', 'refused']);
    assert.equal(j.status, 'interrupted', 'the dropped transfer waits to be resumed');
    // Resuming: same export, the transfer continues from where the bytes on disk end.
    const r = await call('POST', `/api/org-import/jobs/${c.json.id}/link`, 'imp', { url });
    assert.equal(r.status, 200, r.text);
    j = await waitJob(c.json.id, ['scanned', 'refused']);
    assert.equal(j.status, 'scanned', j.error);
    assert.match(String(seen[seen.length - 1]), /^bytes=\d+-$/, 'the second request asked for the rest only');
    assert.equal(j.source_key_enc, null, 'the download key is forgotten once the file is complete');
    imp.cancel(db, j);
    // A link for a DIFFERENT export cannot be swapped in.
    // And an archive whose bytes do not match what the source said is discarded.
    lie = true; seen.length = 0;
    const c2 = await call('POST', '/api/org-import/jobs', 'imp', { source: 'pull', url });
    seen.push('skip-the-drop');
    j = await waitJob(c2.json.id, ['refused', 'scanned', 'interrupted']);
    assert.equal(j.status, 'refused');
    assert.match(j.error, /does not match/);
    assert.ok(!fs.existsSync(imp.archivePath(j)));
  } finally { delete process.env.OUTBOUND_ALLOW_HOSTS; src.close(); }
});

test('⚠️ the disk folder: platform admins only, plain files only, never a path from the browser', async () => {
  cancelActive();
  fs.mkdirSync(imp.importsDir(), { recursive: true });
  fs.copyFileSync(exportFile, path.join(imp.importsDir(), 'alpha-backup.zip'));
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'secret.zip'), 'not yours');
  fs.symlinkSync(path.join(process.env.DATA_DIR, 'secret.zip'), path.join(imp.importsDir(), 'link.zip'));
  const list = await call('GET', '/api/org-import/disk', 'plat');
  assert.deepEqual(list.json.files.map((f) => f.name), ['alpha-backup.zip']);
  for (const name of ['link.zip', '../secret.zip', '/etc/passwd', 'incoming/../../secret.zip']) {
    const r = await call('POST', '/api/org-import/jobs', 'plat', { source: 'disk', disk_name: name });
    assert.equal(r.status, 400, name);
  }
  const r = await call('POST', '/api/org-import/jobs', 'plat', { source: 'disk', disk_name: 'alpha-backup.zip' });
  assert.equal(r.status, 201, r.text);
  const j = await waitJob(r.json.id, ['scanned', 'refused']);
  assert.equal(j.status, 'scanned', j.error);
  imp.cancel(db, j);
  assert.ok(fs.existsSync(path.join(imp.importsDir(), 'alpha-backup.zip')), 'the administrator\'s own file is never deleted');
});

/* ───────────── screens ───────────── */

test('the handover: the old server sends its screens with the new server\'s keys; other organizations\' screens are ignored', async () => {
  const doc = (await call('GET', `/api/org-import/jobs/${doneJob.id}/handover`, 'imp')).json;
  assert.equal(doc.format, 'screentinker-screen-handover-v1');
  assert.equal(doc.screens.length, 1);
  assert.equal(doc.screens[0].source_id, D);
  const newDev = db.prepare('SELECT enrol_key FROM devices WHERE name = ? AND workspace_id IN (SELECT id FROM workspaces WHERE organization_id = ?)').get('Alpha Window', doneJob.organization_id);
  assert.equal(doc.screens[0].enrol_key, newDev.enrol_key);
  // Smuggle Bravo's screen into the file: Alpha's admin cannot send it anywhere.
  doc.screens.push({ source_id: DB, name: 'Bravo Window', enrol_key: 'z'.repeat(43) });
  db.prepare("UPDATE devices SET capabilities = ? WHERE id IN (?, ?)").run(JSON.stringify(['remote.set_server_url']), D, DB);
  fakeNs.adapter.rooms.set(D, new Set(['sock1']));
  fakeNs.adapter.rooms.set(DB, new Set(['sock2']));
  fakeNs.sent = [];
  // Requires the confirmation, and an org admin of the SOURCE organization.
  assert.equal((await call('POST', '/api/org-import/handover', 'adminA', { handover: doc })).status, 400);
  assert.equal((await call('POST', '/api/org-import/handover', 'editorA', { handover: doc, confirm: true })).status, 403);
  const r = await call('POST', '/api/org-import/handover', 'adminA', { handover: doc, confirm: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.sent, 1);
  assert.equal(r.json.results.find((x) => x.device_id === DB).status, 'not_found');
  assert.equal(fakeNs.sent.length, 1);
  assert.equal(fakeNs.sent[0].room, D);
  assert.equal(fakeNs.sent[0].data.type, 'set_server_url');
  assert.equal(fakeNs.sent[0].data.payload.url, doc.server);
  assert.equal(fakeNs.sent[0].data.payload.enrol_key, newDev.enrol_key, 'the web player arrives with the NEW server\'s key');
});

test('pairing a code into an imported screen keeps its name, groups, playlist and schedules', async () => {
  const wsIds = db.prepare('SELECT id FROM workspaces WHERE organization_id = ?').all(doneJob.organization_id).map((w) => w.id);
  const imported = db.prepare(`SELECT * FROM devices WHERE workspace_id IN (${wsIds.map(() => '?').join(',')})`).get(...wsIds);
  const provId = crypto.randomUUID();
  db.prepare("INSERT INTO devices (id,name,pairing_code,device_token,status,last_heartbeat,client_type) VALUES (?,'Display','654321','NEWPLAYERTOKEN','online',strftime('%s','now'),'apk')").run(provId);
  // Another organization's admin cannot do it.
  assert.equal((await call('POST', `/api/org-import/jobs/${doneJob.id}/screens/${imported.id}/pair`, 'ownerB', { pairing_code: '654321' })).status, 404);
  const wrong = await call('POST', `/api/org-import/jobs/${doneJob.id}/screens/${imported.id}/pair`, 'imp', { pairing_code: '000000' });
  assert.equal(wrong.status, 404);
  const r = await call('POST', `/api/org-import/jobs/${doneJob.id}/screens/${imported.id}/pair`, 'imp', { pairing_code: '654321' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.id, provId);
  const now = db.prepare('SELECT * FROM devices WHERE id = ?').get(provId);
  assert.equal(now.name, 'Alpha Window');
  assert.equal(now.playlist_id, imported.playlist_id);
  assert.equal(now.workspace_id, imported.workspace_id);
  assert.equal(now.device_token, 'NEWPLAYERTOKEN', 'the player keeps the identity it holds');
  assert.equal(now.pairing_code, null);
  assert.ok(!db.prepare('SELECT 1 FROM devices WHERE id = ?').get(imported.id));
  assert.ok(db.prepare('SELECT 1 FROM device_group_members WHERE device_id = ?').get(provId), 'group membership moved');
  assert.ok(db.prepare('SELECT 1 FROM schedules WHERE device_id = ?').get(provId), 'schedule moved');
  assert.ok(db.prepare("SELECT 1 FROM trigger_assignments WHERE target_id = ?").get(provId), 'trigger assignment moved');
  assert.ok(fakeNs.sent.some((s) => s.room === provId && s.ev === 'device:paired'));
});

test('imports are audited', () => {
  const acts = new Set(db.prepare("SELECT action FROM activity_log WHERE action LIKE 'trust.%'").all().map((r) => r.action));
  for (const a of ['trust.import_started', 'trust.import_restore_started', 'trust.import_done', 'trust.screens_handed_over', 'trust.import_screen_paired']) assert.ok(acts.has(a), a);
});

test('into an existing EMPTY organization by its admin: its own workspace is kept, ownership is never handed out, rollback removes only what the import made', async () => {
  cancelActive();
  org('org-e', 'Echo Empty', U.ownerB);
  db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-e','org-e','Echo Home')").run();
  om.run('org-e', U.imp, 'org_admin');
  // A hand-edited pending invite that tries to make someone an owner.
  const edited = await rezip(exportFile, (es) => {
    const m = manifestOf(es);
    const e = { name: 'tables/workspace_invites.jsonl', data: Buffer.from(JSON.stringify({ id: crypto.randomUUID(), workspace_id: 'ws-a1', email: 'mallory@evil.test', role: 'workspace_admin', org_role: 'org_owner', invited_by: U.ownerA, expires_at: Math.floor(Date.now() / 1000) + 86400 }) + '\n') };
    const at = es.findIndex((x) => x.name === e.name);
    if (at >= 0) es.splice(at, 1);
    es.push(e);
    m.integrity.entries[e.name] = { sha256: sha(e.data), bytes: e.data.length };
    setManifest(es, m);
  });
  const jobId = await uploadJob('imp', edited);
  await waitJob(jobId, ['scanned']);
  const r = await call('POST', `/api/org-import/jobs/${jobId}/restore`, 'imp', { target: { mode: 'existing', organization_id: 'org-e' } });
  assert.equal(r.status, 202, r.text);
  const j = await waitJob(jobId, ['done', 'failed']);
  assert.equal(j.status, 'done', j.error);
  assert.equal(j.organization_id, 'org-e');
  assert.ok(db.prepare("SELECT 1 FROM workspaces WHERE id = 'ws-e' AND organization_id = 'org-e'").get(), 'the existing workspace is untouched');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE organization_id = 'org-e'").get().n, 3);
  const owners = db.prepare("SELECT * FROM workspace_invites WHERE import_job_id = ? AND email = 'ownera@import.local'").all(jobId);
  assert.ok(owners.length && owners.every((i) => i.org_role !== 'org_owner'), 'an org admin cannot hand out ownership through an archive');
  const mallory = db.prepare("SELECT * FROM workspace_invites WHERE email = 'mallory@evil.test' AND import_job_id = ?").get(jobId);
  assert.ok(mallory, 'the pending invite came across');
  assert.equal(mallory.org_role, null, '…as a workspace invite only');
  // Roll it back by hand (as a failure would): only what the import created goes.
  require('../lib/trust/import-restore').rollback(db, imp.getJob(db, jobId));
  assert.deepEqual(db.prepare("SELECT id FROM workspaces WHERE organization_id = 'org-e'").all().map((w) => w.id), ['ws-e']);
  assert.ok(db.prepare("SELECT 1 FROM organizations WHERE id = 'org-e'").get(), 'the organization itself stays');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM org_sso_providers WHERE organization_id = 'org-e'").get().n, 0, 'organization-level rows the import wrote are gone');
});

test('rate limits: one import at a time per organization, and at most ten a day', async () => {
  cancelActive();
  const first = await call('POST', '/api/org-import/jobs', 'imp', { source: 'upload', bytes: 100 });
  assert.equal(first.status, 201);
  const busy = await call('POST', '/api/org-import/jobs', 'imp', { source: 'upload', bytes: 100 });
  assert.equal(busy.status, 429);
  assert.equal(busy.json.code, 'busy');
  // Another organization is not held up by it.
  assert.equal((await call('POST', '/api/org-import/jobs', 'ownerB', { source: 'upload', bytes: 100 })).status, 201);
  cancelActive();
  for (let i = 0; i < imp.MAX_PER_DAY; i++) {
    db.prepare("INSERT INTO org_imports (id, kind, requested_by, requester_org_id, source, status) VALUES (?, 'org', ?, 'org-d', 'upload', 'cancelled')").run(crypto.randomUUID(), U.imp);
  }
  const daily = await call('POST', '/api/org-import/jobs', 'imp', { source: 'upload', bytes: 100 });
  assert.equal(daily.status, 429);
  assert.equal(daily.json.code, 'daily_limit');
  cancelActive();
});
