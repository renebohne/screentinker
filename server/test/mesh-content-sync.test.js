'use strict';

/*
 * Receiving content a hub wants on this node's screens.
 *
 * The two properties everything else hangs off:
 *   - "I have a row" is not "I have the bytes"
 *   - nothing is committed until the bytes are verified and on disk under their final name
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-csync-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { evaluateManifest, admitTransfer, commitStagedAsset } = require('../lib/mesh/content-sync');
const { digestFile } = require('../lib/content-digest');

const id = () => crypto.randomUUID();
const GB = 1024 ** 3;
let wsA, userId, contentDir;

before(() => {
  userId = id(); const org = id();
  db.prepare('INSERT INTO users (id,email,name,password_hash) VALUES (?,?,?,?)').run(userId, `c-${userId}@e.com`, 'C', 'x');
  db.prepare(`INSERT INTO organizations (id,name,owner_user_id,created_at,updated_at)
              VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(org, 'Org', userId);
  wsA = id();
  db.prepare(`INSERT INTO workspaces (id,organization_id,name,created_at,updated_at)
              VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(wsA, org, 'A');
  contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csync-files-'));
});

const mkEdge = (cols = {}) => {
  const e = id();
  db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, role_capabilities, grant_categories,
              transport_direction, tls_verify, created_at, write_grant, write_scope,
              write_bytes_budget, write_bytes_used)
              VALUES (?,?,'up','[]','["health"]','we-dial',1,strftime('%s','now'),?,?,?,?)`)
    .run(e, cols.peer || id(), JSON.stringify(cols.write_grant || ['content-push']),
         JSON.stringify([wsA]), cols.budget === undefined ? 20 * GB : cols.budget, cols.used || 0);
  return db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(e);
};
const stage = (bytes) => {
  const p = path.join(contentDir, `${id()}.part`);
  fs.writeFileSync(p, bytes);
  return p;
};
const sniffExt = () => '.mp4';
const entryFor = async (staged, extra = {}) => ({
  oid: id(), kind: 'local', sz: fs.statSync(staged).size, mt: 'video/mp4',
  fn: 'Clip.mp4', dg: await digestFile(staged), ...extra,
});

test('⚠️ a row without bytes on disk still counts as MISSING', async () => {
  /*
   * The check that matters. A large fraction of content rows in a real library have no file behind
   * them — restores, migrations, manual cleanups. Stopping at "is there a row" reports a playlist
   * ready and then plays nothing.
   */
  const edge = mkEdge();
  const oid = id();
  const localId = id();
  db.prepare(`INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size)
              VALUES (?,?,?,?,?,?,?)`).run(localId, userId, wsA, 'gone.mp4', 'gone.mp4', 'video/mp4', 10);
  db.prepare(`INSERT INTO mesh_content_provenance
              (origin_node_id,origin_content_id,local_content_id,bytes,first_seen_at,last_seen_at)
              VALUES (?,?,?,0,0,0)`).run(edge.peer_node_id, oid, localId);

  const r = evaluateManifest(db, edge, { content: [{ oid, kind: 'local', sz: 10 }] }, { contentDir });
  assert.equal(r.ok, true);
  assert.equal(r.need.length, 1, 'the row exists but the file does not — that is still a need');
  assert.equal(r.need[0].why, 'bytes-missing');
});

test('a second push of the same asset is recognised by provenance and needs nothing', async () => {
  const edge = mkEdge();
  const staged = stage('the same bytes every time');
  const entry = await entryFor(staged);
  const c = await commitStagedAsset(db, edge, entry, staged, { contentDir, sniffExt, workspaceId: wsA, userId });
  assert.equal(c.ok, true, c.reason);

  const r = evaluateManifest(db, edge, { content: [entry] }, { contentDir });
  assert.deepEqual(r.need, [], 're-pushing an unchanged asset must transfer nothing');
  assert.equal(r.have[0].matched, 'provenance');
});

test('⚠️ bytes we already hold from ANOTHER origin are matched by digest, not re-sent', async () => {
  const edgeA = mkEdge();
  const staged = stage('a stock clip both sites happen to have');
  const entry = await entryFor(staged);
  await commitStagedAsset(db, edgeA, entry, staged, { contentDir, sniffExt, workspaceId: wsA, userId });

  // A different hub, a different origin id, the same bytes.
  const edgeB = mkEdge();
  const r = evaluateManifest(db, edgeB, { content: [{ ...entry, oid: id() }] }, { contentDir });
  assert.deepEqual(r.need, [], 'identical bytes must not be transferred twice');
  assert.equal(r.have[0].matched, 'digest');
});

test('remote and YouTube items need a row but never any bytes', () => {
  const edge = mkEdge();
  const r = evaluateManifest(db, edge, {
    content: [{ oid: id(), kind: 'youtube', sz: 0 }, { oid: id(), kind: 'remote', sz: 0 }],
  }, { contentDir });
  assert.deepEqual(r.need, []);
  assert.equal(r.bytesNeeded, 0);
  assert.equal(r.have.every((h) => h.matched === 'no-bytes'), true);
});

test('⚠️ the budget is checked BEFORE any bytes move', () => {
  const edge = mkEdge({ budget: 10 * GB, used: 9 * GB });
  const ok = admitTransfer(edge, 512 * 1024 * 1024, {});
  const no = admitTransfer(edge, 4 * GB, {});
  assert.equal(ok.ok, true);
  assert.equal(no.ok, false);
  assert.match(no.reason, /allowance is left/i, 'the refusal must say how much room there is');
});

test('an edge without content-push cannot send bytes however much budget it has', () => {
  const edge = mkEdge({ write_grant: ['device-command'], budget: 100 * GB });
  const r = admitTransfer(edge, 1, {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /may not send content/i);
});

test('⚠️ free space is checked as well as the allowance — they are different limits', () => {
  // The budget is what the operator agreed to give. Free space is what the machine has, and it can
  // be smaller. A full disk on a signage server takes the screens down with it.
  const edge = mkEdge({ budget: 100 * GB, used: 0 });
  const r = admitTransfer(edge, 10 * GB, { freeBytes: () => 5 * GB, freeFloorBytes: GB });
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not have room/i);
});

test('⚠️ a file that arrives the wrong SIZE is refused and nothing is committed', async () => {
  const edge = mkEdge();
  const staged = stage('short');
  const entry = await entryFor(staged, { sz: 999999 });
  const before = db.prepare('SELECT COUNT(*) n FROM content').get().n;
  const r = await commitStagedAsset(db, edge, entry, staged, { contentDir, sniffExt, workspaceId: wsA, userId });
  assert.equal(r.ok, false);
  assert.match(r.reason, /bytes, not the/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM content').get().n, before, 'no row may be written');
});

test('⚠️ a file that does not match its CHECKSUM is refused', async () => {
  const edge = mkEdge();
  const staged = stage('these are not the bytes you were promised');
  const entry = await entryFor(staged, { dg: 'f'.repeat(64) });
  const r = await commitStagedAsset(db, edge, entry, staged, { contentDir, sniffExt, workspaceId: wsA, userId });
  assert.equal(r.ok, false);
  assert.match(r.reason, /checksum/i);
});

test('⚠️ the type is SNIFFED here too — the peer does not choose the extension', async () => {
  const edge = mkEdge();
  const staged = stage('whatever the hub claims this is');
  const entry = await entryFor(staged, { mt: 'video/mp4' });
  const r = await commitStagedAsset(db, edge, entry, staged,
    { contentDir, sniffExt: () => null, workspaceId: wsA, userId });
  assert.equal(r.ok, false, 'a type this server does not accept must be refused');
  assert.match(r.reason, /not a type this server accepts/i);
});

test('⚠️ the stored file is named by its DIGEST, so an unchanged re-push cannot move the fingerprint', async () => {
  const edge = mkEdge();
  const staged = stage('stable bytes');
  const entry = await entryFor(staged);
  const r = await commitStagedAsset(db, edge, entry, staged, { contentDir, sniffExt, workspaceId: wsA, userId });
  assert.equal(r.ok, true, r.reason);
  assert.match(r.filepath, /^[0-9a-f]{64}\.mp4$/,
    'filepath is in the player fingerprint; a random name per push restarts every screen');
  assert.equal(r.filepath, `${entry.dg}.mp4`);
});

test('committing spends the allowance in the SAME transaction as the row', async () => {
  const edge = mkEdge({ used: 0 });
  const staged = stage('some bytes to account for');
  const entry = await entryFor(staged);
  const r = await commitStagedAsset(db, edge, entry, staged, { contentDir, sniffExt, workspaceId: wsA, userId });
  const after = db.prepare('SELECT write_bytes_used FROM mesh_edges WHERE id = ?').get(edge.id);
  assert.equal(after.write_bytes_used, r.bytes, 'accounting done separately is accounting that drifts');
});

test('an over-long manifest is refused with a readable reason rather than truncated', () => {
  const edge = mkEdge();
  const content = Array.from({ length: 501 }, () => ({ oid: id(), kind: 'local', sz: 1 }));
  const r = evaluateManifest(db, edge, { content }, { contentDir });
  assert.equal(r.ok, false);
  assert.match(r.reason, /send it in pages/i, 'silent truncation would report a playlist ready that is not');
});
