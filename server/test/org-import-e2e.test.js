'use strict';

/*
 * Move an organization to another server, end to end, with REAL servers (docs/move-server.md):
 *
 *   1. pull      a source server with a seeded organization (two workspaces, media, a nested playlist,
 *                a layout, a schedule, a sign with a brand kit, a Square data source with its token,
 *                a member, a paired Android-style screen) is exported; a destination pulls the export
 *                straight from it, restores it, and the source hands its screen over: the player
 *                switches address and rematches the imported screen by its fingerprint.
 *   2. recovery  the same export, uploaded to another destination AFTER the source is stopped —
 *                nothing in upload → scan → restore needs the old server.
 *   3. whole     the source's platform admin exports the whole server (two organizations); a fresh
 *                destination restores both, isolated, with accounts recreated; a bundle with one
 *                damaged organization restores the other and lists the bad one.
 *
 * Ports 4390-4398 (fixed, by agreement for this feature's tests). Each server has its own DATA_DIR.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { io: ioClient } = require('socket.io-client');

const SERVER_DIR = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const dirs = [];

async function waitFor(fn, ms, step = 200) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) { last = await fn(); if (last) return last; await sleep(step); }
  return last;
}

async function startServer(port, tag, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `st-oi-${tag}-`));
  dirs.push(dataDir);
  const log = fs.openSync(dataDir + '.log', 'w');
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, DATA_DIR: dataDir, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test', JWT_SECRET: `e2e-${tag}-secret`, ...env },
    stdio: ['ignore', log, log],
  });
  procs.push(proc);
  const base = `http://127.0.0.1:${port}`;
  const up = await waitFor(async () => { try { return (await fetch(base + '/api/status')).ok; } catch { return false; } }, 40000);
  if (!up) throw new Error(`server ${tag} did not boot:\n` + fs.readFileSync(dataDir + '.log', 'utf8').slice(-3000));
  const s = { base, port, dataDir, proc, tag };
  s.stop = () => new Promise((r) => { proc.once('exit', r); try { proc.kill('SIGTERM'); } catch { r(); } setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* */ } }, 3000); });
  s.db = () => {
    const Database = require('better-sqlite3');
    return new Database(path.join(dataDir, 'db', 'remote_display.db'), { readonly: true, fileMustExist: true });
  };
  return s;
}

async function signUp(s, email, password = 'Passw0rd123') {
  const r = await fetch(s.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const j = await r.json();
  if (!j.token) throw new Error('sign up failed: ' + JSON.stringify(j));
  return session(s, j.token, j.user);
}
function session(s, token, user) {
  const api = async (method, p, body, { raw = null, headers = {}, expect = null } = {}) => {
    const h = { Authorization: 'Bearer ' + token, ...headers };
    if (raw) h['Content-Type'] = 'application/octet-stream'; else if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(s.base + '/api' + p, { method, headers: h, body: raw || (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    if (expect != null) { assert.equal(r.status, expect, `${method} ${p} -> ${r.status} ${text.slice(0, 300)}`); return json; }
    if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${text.slice(0, 400)}`);
    return json;
  };
  return { token, user, api };
}

// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function upload(s, sess, buf, name, mime) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), name);
  const r = await fetch(s.base + '/api/content', { method: 'POST', headers: { Authorization: 'Bearer ' + sess.token }, body: fd });
  const j = await r.json();
  if (!r.ok) throw new Error('upload failed: ' + JSON.stringify(j));
  return Array.isArray(j) ? j[0] : (j.items ? j.items[0] : (j.content || j));
}

/** An Android-style player: provisions with a pairing code and a fingerprint, as the APK does. */
function player(base, { code, fingerprint, deviceId = null, token = null }) {
  return new Promise((resolve) => {
    const sock = ioClient(`${base}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    const st = { sock, events: [], commands: [] };
    sock.on('connect', () => sock.emit('device:register', {
      ...(deviceId ? { device_id: deviceId, device_token: token } : { pairing_code: code }),
      fingerprint, client_type: 'apk', client_version: '3.0.0', platform: 'android',
      capabilities: ['remote.set_server_url'], device_info: { screen_width: 1920, screen_height: 1080 },
    }));
    for (const ev of ['device:registered', 'device:paired', 'device:unpaired', 'device:auth-error', 'device:playlist-update']) {
      sock.on(ev, (d) => { st.events.push({ ev, d }); if (ev === 'device:registered') { st.id = d.device_id; st.token = d.device_token; } });
    }
    sock.on('device:command', (c) => st.commands.push(c));
    setTimeout(() => resolve(st), 800);
  });
}

async function waitJob(sess, id, statuses, ms = 90000) {
  return waitFor(async () => {
    const j = await sess.api('GET', `/org-import/jobs/${id}`);
    if (['refused', 'failed', 'partial', 'interrupted'].includes(j.status) && !statuses.includes(j.status)) throw new Error(`import ${id} ${j.status}: ${j.error}`);
    return statuses.includes(j.status) ? j : null;
  }, ms, 300);
}

async function exportOrg(src, sess) {
  const job = await sess.api('POST', '/trust/exports', { kind: 'org' });
  await waitFor(async () => (await sess.api('GET', '/trust/exports')).organization.find((j) => j.id === job.id && j.status === 'ready'), 60000);
  const { url } = await sess.api('POST', `/trust/exports/${job.id}/link`);
  return src.base + url;
}

async function uploadArchive(sess, buf, kind = 'org') {
  const job = await sess.api('POST', '/org-import/jobs', { source: 'upload', kind, bytes: buf.length, file_name: 'export.zip' });
  const chunk = 64 * 1024;
  for (let off = 0; off < buf.length; off += chunk) {
    await sess.api('PATCH', `/org-import/jobs/${job.id}/upload`, undefined, { raw: buf.subarray(off, off + chunk), headers: { 'Upload-Offset': String(off) } });
  }
  return job.id;
}

let SRC, DST, owner, member, seed = {}, androidPlayer, exportBuf;

before(async () => {
  SRC = await startServer(4390, 'source');
  // The destination may fetch from 127.0.0.1 because its operator opened it, exactly as a self-hoster
  // pulling from a LAN server would (docs/outbound-requests.md).
  DST = await startServer(4392, 'dest', { OUTBOUND_ALLOW_HOSTS: '127.0.0.1' });
});
after(async () => {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* */ } }
  if (androidPlayer) try { androidPlayer.sock.close(); } catch { /* */ }
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(d + '.log', { force: true }); } catch { /* */ } }
});

test('seed the source organization', async () => {
  owner = await signUp(SRC, 'owner@alpha.test');
  member = await signUp(SRC, 'editor@alpha.test');
  const me = await owner.api('GET', '/auth/me');
  seed.ws1 = me.current_workspace_id || (await owner.api('GET', '/workspaces'))[0].id;
  seed.ws2 = (await owner.api('POST', '/workspaces', { name: 'Alpha Kiosk' })).id;
  const c = await upload(SRC, owner, PNG, 'logo.png', 'image/png');
  seed.content = c.id;
  const child = await owner.api('POST', '/playlists', { name: 'Child' });
  await owner.api('POST', `/playlists/${child.id}/items`, { content_id: c.id });
  const pl = await owner.api('POST', '/playlists', { name: 'Morning' });
  await owner.api('POST', `/playlists/${pl.id}/items`, { content_id: c.id });
  await owner.api('POST', `/playlists/${pl.id}/items`, { child_playlist_id: child.id });
  await owner.api('POST', `/playlists/${pl.id}/publish`);
  seed.playlist = pl.id;
  const layout = await owner.api('POST', '/layouts', { name: 'Split' });
  seed.layout = layout.id;
  await owner.api('PUT', '/brand-kit', { business_name: 'Alpha Bakery', logo_content_id: c.id, colors: ['#AA0000'] });
  const sign = await owner.api('POST', '/signs', { template: 'welcome', values: { title: 'Fresh bread daily' } });
  seed.signWidget = sign.widget_id;
  await owner.api('POST', '/data-sources', { name: 'Square menu', type: 'square', config: { environment: 'production', access_token: 'EAAAEXAMPLESQUARETOKEN0123456789abcdefghijklmnopqrstuvwxyz0123456789', location_id: 'L1' } });
  // A member: invited to the workspace as an editor, accepted.
  const inv = await owner.api('POST', `/workspaces/${seed.ws1}/invites`, { email: 'editor@alpha.test', role: 'workspace_editor' });
  await member.api('POST', `/auth/accept-invite/${inv.id}`);
  // A paired Android-style screen.
  androidPlayer = await player(SRC.base, { code: '482913', fingerprint: 'fp-e2e-android-1' });
  assert.ok(androidPlayer.id, 'the player provisioned');
  const dev = await owner.api('POST', '/provision/pair', { pairing_code: '482913', name: 'Front window' });
  seed.device = dev.id;
  await owner.api('POST', `/playlists/${pl.id}/assign`, { device_id: dev.id });
  await owner.api('POST', '/schedules', { device_id: dev.id, playlist_id: pl.id, title: 'Breakfast', start_time: '2026-10-20T08:00', end_time: '2026-10-20T11:00' });
  // Something on the destination that must not be touched.
  const dOwner = await signUp(DST, 'admin@dest.test');
  seed.destAdmin = dOwner;
  await upload(DST, dOwner, PNG, 'their-own.png', 'image/png');
});

function assertRestored(dbh, orgId, label) {
  const ws = dbh.prepare('SELECT id, name FROM workspaces WHERE organization_id = ?').all(orgId);
  assert.equal(ws.length, 2, label);
  assert.ok(ws.some((w) => w.name === 'Alpha Kiosk'), `${label}: both workspaces`);
  const wsIds = ws.map((w) => w.id);
  const IN = `(${wsIds.map(() => '?').join(',')})`;
  const content = dbh.prepare(`SELECT * FROM content WHERE workspace_id IN ${IN} AND filename = 'logo.png'`).get(...wsIds);
  assert.ok(content && content.id !== seed.content, `${label}: content with a new id`);
  const morning = dbh.prepare(`SELECT * FROM playlists WHERE workspace_id IN ${IN} AND name = 'Morning'`).get(...wsIds);
  const child = dbh.prepare(`SELECT * FROM playlists WHERE workspace_id IN ${IN} AND name = 'Child'`).get(...wsIds);
  const items = dbh.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order').all(morning.id);
  assert.equal(items[0].content_id, content.id, `${label}: the playlist item points at the imported content`);
  assert.equal(items[1].child_playlist_id, child.id, `${label}: the nested playlist`);
  assert.ok(morning.published_snapshot.includes(content.id), `${label}: the published snapshot names the imported content`);
  const dev = dbh.prepare(`SELECT * FROM devices WHERE workspace_id IN ${IN}`).get(...wsIds);
  assert.equal(dev.name, 'Front window');
  assert.equal(dev.playlist_id, morning.id);
  assert.equal(dbh.prepare('SELECT COUNT(*) AS n FROM schedules WHERE device_id = ? AND playlist_id = ?').get(dev.id, morning.id).n, 1, `${label}: the schedule`);
  const kit = dbh.prepare(`SELECT * FROM brand_kits WHERE workspace_id IN ${IN}`).get(...wsIds);
  assert.equal(kit.logo_content_id, content.id, `${label}: brand kit logo`);
  const deck = dbh.prepare(`SELECT * FROM slide_decks WHERE workspace_id IN ${IN}`).get(...wsIds);
  const widgetId = JSON.parse(deck.published_widget_ids)[0];
  assert.ok(widgetId && widgetId !== seed.signWidget && dbh.prepare('SELECT 1 FROM widgets WHERE id = ?').get(widgetId), `${label}: the sign\'s widget`);
  const ds = dbh.prepare(`SELECT * FROM data_sources WHERE workspace_id IN ${IN}`).get(...wsIds);
  assert.ok(!ds.config.includes('EAAAEXAMPLESQUARETOKEN'), `${label}: the Square token never left`);
  assert.equal(ds.last_status, 'error');
  return { content, morning, dev, widgetId, wsIds };
}

let pullJob, pulled;
test('1. pull: the destination streams the export from the source and restores it', async () => {
  const link = await exportOrg(SRC, owner);
  exportBuf = Buffer.from(await (await fetch(link)).arrayBuffer());   // kept for the recovery test
  const link2 = await exportOrg(SRC, owner).catch(() => null) || link;
  const dest = seed.destAdmin;
  const before = (() => { const d = DST.db(); try { return d.prepare('SELECT COUNT(*) AS n FROM content').get().n; } finally { d.close(); } })();
  const job = await dest.api('POST', '/org-import/jobs', { source: 'pull', url: link2 });
  assert.equal(job.status, 'fetching');
  let j = await waitJob(dest, job.id, ['scanned']);
  assert.equal(j.scan.workspaces.length, 2);
  assert.ok(j.scan.data_sources.some((d) => d.type === 'square' && d.needs_secret));
  assert.ok(j.scan.members.some((m) => m.email === 'editor@alpha.test'));
  assert.equal(j.scan.devices.length, 1);
  assert.ok(j.scan.room.ok);
  await dest.api('POST', `/org-import/jobs/${job.id}/restore`, { target: { mode: 'new' } });
  j = await waitJob(dest, job.id, ['done']);
  pullJob = j;
  const dbh = DST.db();
  try {
    pulled = assertRestored(dbh, j.organization_id, 'pull');
    assert.equal(dbh.prepare('SELECT COUNT(*) AS n FROM content').get().n, before + 1, 'the destination\'s own content is untouched; one came in');
    assert.equal(dbh.prepare("SELECT COUNT(*) AS n FROM content WHERE filename = 'their-own.png'").get().n, 1);
  } finally { dbh.close(); }
  // The media is served from the destination.
  const file = await fetch(`${DST.base}/uploads/content/${encodeURIComponent(pulled.content.filepath)}`);
  assert.equal(file.status, 200);
  assert.equal(Buffer.compare(Buffer.from(await file.arrayBuffer()), PNG), 0);
  // The sign renders on the destination.
  const html = await (await fetch(`${DST.base}/api/widgets/${pulled.widgetId}/render`)).text();
  assert.match(html, /Fresh bread daily/);
  // The member is invited, with their role, to that organization only.
  const inv = await dest.api('GET', `/org-import/jobs/${job.id}/invites`);
  const ed = inv.invites.find((i) => i.email === 'editor@alpha.test');
  assert.equal(ed.role, 'workspace_editor');
  assert.match(ed.accept_url, /#\/accept-invite\//);
});

test('1b. move your screens: the source hands the screen over; the player rematches the imported screen', async () => {
  const dest = seed.destAdmin;
  const doc = await dest.api('GET', `/org-import/jobs/${pullJob.id}/handover`);
  assert.equal(doc.screens.length, 1);
  assert.equal(doc.screens[0].source_id, seed.device);
  const r = await owner.api('POST', '/org-import/handover', { handover: doc, confirm: true });
  assert.equal(r.sent, 1, JSON.stringify(r));
  const cmd = await waitFor(() => androidPlayer.commands.find((c) => c.type === 'set_server_url'), 5000);
  assert.ok(cmd, 'the player was told to switch');
  assert.equal(cmd.payload.url, doc.server);
  // The Android app now connects to the new address with its OLD identity, is told it is unknown,
  // clears it and asks for a pairing code with its fingerprint — which the imported screen carries.
  const old = androidPlayer;
  old.sock.close();
  const first = await player(DST.base, { fingerprint: 'fp-e2e-android-1', deviceId: old.id, token: old.token });
  assert.ok(first.events.some((e) => e.ev === 'device:unpaired' || e.ev === 'device:auth-error'), JSON.stringify(first.events));
  first.sock.close();
  const again = await player(DST.base, { code: '771204', fingerprint: 'fp-e2e-android-1' });
  androidPlayer = again;
  assert.equal(again.id, pulled.dev.id, 'it became the imported screen, not a new one');
  assert.ok(again.events.some((e) => e.ev === 'device:paired'), 'and is told it is paired');
  const dbh = DST.db();
  try {
    const d = dbh.prepare('SELECT * FROM devices WHERE id = ?').get(pulled.dev.id);
    assert.equal(d.status, 'online');
    assert.equal(d.playlist_id, pulled.morning.id, 'with its playlist');
    assert.equal(dbh.prepare("SELECT COUNT(*) AS n FROM devices WHERE pairing_code = '771204' AND user_id IS NOT NULL").get().n, 0, 'no stray screen');
  } finally { dbh.close(); }
  const screens = await dest.api('GET', `/org-import/jobs/${pullJob.id}/screens`);
  assert.equal(screens.screens[0].moved, true);
});

test('2. recovery: the source is gone; the export is uploaded to a fresh server and restored', async () => {
  await SRC.stop();
  const REC = await startServer(4394, 'recovery');   // no outbound allowance: nothing may be fetched
  const admin = await signUp(REC, 'admin@recovery.test');   // install → create admin → restore
  const jobId = await uploadArchive(admin, exportBuf);
  let j = await waitJob(admin, jobId, ['scanned']);
  assert.equal(j.scan.workspaces.length, 2);
  await admin.api('POST', `/org-import/jobs/${jobId}/restore`, { target: { mode: 'new' } });
  j = await waitJob(admin, jobId, ['done']);
  const dbh = REC.db();
  try { assertRestored(dbh, j.organization_id, 'recovery'); } finally { dbh.close(); }
  // With the source gone, the screens step offers the enrolment link and the pairing route instead.
  const screens = await admin.api('GET', `/org-import/jobs/${jobId}/screens`);
  assert.match(screens.screens[0].enrol_url, /\/player\?k=/);
  assert.equal(screens.screens[0].rematches_by_fingerprint, true);
  await REC.stop();
});

test('3. whole server: a platform admin exports both organizations; a fresh server restores both, isolated', async () => {
  // A new source with two organizations (the first account's, and a second sign-up's).
  const SRC2 = await startServer(4396, 'source2');
  const plat = await signUp(SRC2, 'root@two.test');
  const other = await signUp(SRC2, 'boss@beta.test');
  await upload(SRC2, plat, PNG, 'a.png', 'image/png');
  await upload(SRC2, other, PNG, 'b.png', 'image/png');
  // An org admin (not a platform admin) can do neither half.
  await other.api('POST', '/org-import/instance-exports', {}, { expect: 403 });
  await other.api('POST', '/org-import/jobs', { kind: 'instance', source: 'upload', bytes: 100 }, { expect: 403 });
  const ex = await plat.api('POST', '/org-import/instance-exports', {});
  await waitFor(async () => (await plat.api('GET', '/org-import/instance-exports')).exports.find((e) => e.id === ex.id && e.status === 'ready'), 60000);
  const { url } = await plat.api('POST', `/org-import/instance-exports/${ex.id}/link`);
  const bundle = Buffer.from(await (await fetch(SRC2.base + url)).arrayBuffer());
  await SRC2.stop();

  const DST2 = await startServer(4398, 'whole');
  const root = await signUp(DST2, 'root@new.test');
  let jobId = await uploadArchive(root, bundle, 'instance');
  let j = await waitJob(root, jobId, ['scanned']);
  assert.equal(j.scan.organizations.length, 2);
  assert.ok(j.scan.organizations.every((o) => o.status === 'scanned'));
  await root.api('POST', `/org-import/jobs/${jobId}/restore`, { options: {} });
  j = await waitJob(root, jobId, ['done'], 120000);
  assert.equal(j.result.failed, 0, JSON.stringify(j.result));
  let dbh = DST2.db();
  try {
    const ids = j.result.organizations.map((o) => o.organization_id);
    assert.equal(new Set(ids).size, 2);
    const filesOf = (oid) => dbh.prepare('SELECT c.filename FROM content c JOIN workspaces w ON w.id = c.workspace_id WHERE w.organization_id = ?').all(oid).map((r) => r.filename);
    // Each organization has its own content and nothing of the other's.
    assert.deepEqual(ids.map(filesOf).sort((x, y) => String(x).localeCompare(String(y))), [['a.png'], ['b.png']]);
    const orgs = [ids.find((oid) => filesOf(oid)[0] === 'a.png'), ids.find((oid) => filesOf(oid)[0] === 'b.png')];
    // Accounts recreated, platform role carried, no password (set one through a link).
    const rootOld = dbh.prepare("SELECT * FROM users WHERE email = 'root@two.test'").get();
    assert.equal(rootOld.role, 'platform_admin');
    assert.equal(rootOld.password_hash, null);
    const boss = dbh.prepare("SELECT * FROM users WHERE email = 'boss@beta.test'").get();
    assert.equal(dbh.prepare('SELECT role FROM organization_members WHERE user_id = ? AND organization_id = ?').get(boss.id, orgs[1]).role, 'org_owner');
    assert.equal(dbh.prepare('SELECT owner_user_id FROM organizations WHERE id = ?').get(orgs[1]).owner_user_id, boss.id);
    assert.equal(dbh.prepare('SELECT COUNT(*) AS n FROM organization_members WHERE user_id = ? AND organization_id = ?').get(boss.id, orgs[0]).n, 0, 'isolated');
    const link = await root.api('POST', `/org-import/accounts/${boss.id}/password-link`);
    assert.match(link.url, /#\/reset-password\?token=/);
  } finally { dbh.close(); }

  // A bundle with one damaged organization: the other is restored, the bad one listed.
  const unzipper = require('unzipper');
  const dir = await unzipper.Open.buffer(bundle);
  const entries = [];
  for (const f of dir.files) entries.push({ name: f.path, data: await f.buffer() });
  const orgEntry = entries.find((e) => e.name.startsWith('orgs/'));
  orgEntry.data = Buffer.from(orgEntry.data); orgEntry.data[orgEntry.data.length - 30] ^= 0xff;
  const { ZipArchive } = require('archiver');
  const out = path.join(DST2.dataDir, 'damaged.zip');
  const a = new ZipArchive({ store: true });
  const ws = fs.createWriteStream(out);
  const closed = new Promise((r) => ws.on('close', r));
  a.pipe(ws);
  for (const e of entries) a.append(e.data, { name: e.name });
  await a.finalize(); await closed;
  jobId = await uploadArchive(root, fs.readFileSync(out), 'instance');
  j = await waitJob(root, jobId, ['scanned']);
  assert.equal(j.scan.organizations.filter((o) => o.status === 'refused').length, 1, JSON.stringify(j.scan.organizations));
  await root.api('POST', `/org-import/jobs/${jobId}/restore`, { options: {} });
  j = await waitJob(root, jobId, ['done'], 120000);
  assert.equal(j.result.organizations.filter((o) => o.status === 'done').length, 1);
  assert.equal(j.result.failed, 1);
  await DST2.stop();
});
