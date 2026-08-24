'use strict';

/*
 * Who may grant a write, and where that decision is stored.
 *
 * ⚠️ THE DEFECT THIS EXISTS TO PREVENT: `mesh_edges.grant_categories` is authored by the PARENT.
 * It mints a pairing code naming what the code grants, and the child stores that answer verbatim.
 * For reads that is defensible — every read category is read-only by construction. Carried to
 * writes it inverts the model completely: the parent writes its own permission into the child's
 * database, and the child then enforces it faithfully. That is worse than no enforcement, because
 * the child's own consent view would look correct while being false.
 *
 * So write lives in its own columns, written by exactly one route, which is authenticated on the
 * node whose screens would change.
 */
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-meshwrite-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const grants = require('../lib/mesh/grants');
const { consentView } = require('../lib/mesh/edge-status');

const id = () => crypto.randomUUID();
let wsA, wsB;

before(() => {
  const u = id(); const org = id();
  db.prepare('INSERT INTO users (id,email,name,password_hash) VALUES (?,?,?,?)').run(u, `w-${u}@e.com`, 'W', 'x');
  db.prepare(`INSERT INTO organizations (id,name,owner_user_id,created_at,updated_at)
              VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(org, 'Org', u);
  wsA = id(); wsB = id();
  for (const [w, n] of [[wsA, 'A'], [wsB, 'B']]) {
    db.prepare(`INSERT INTO workspaces (id,organization_id,name,created_at,updated_at)
                VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(w, org, n);
  }
});

const mkEdge = (cols = {}) => {
  const e = id();
  db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, role_capabilities, grant_categories,
              transport_direction, tls_verify, created_at, write_grant, write_scope)
              VALUES (?,?,'up','[]',?, 'we-dial',1,strftime('%s','now'),?,?)`)
    .run(e, id(), JSON.stringify(cols.grant || ['health']),
         cols.write_grant === undefined ? null : JSON.stringify(cols.write_grant),
         cols.write_scope === undefined ? null : JSON.stringify(cols.write_scope));
  return db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(e);
};

test('⚠️ an edge that already exists has NO write — an upgrade changes nothing', () => {
  // The migration rule: everything already linked keeps working exactly as it does today, which
  // means read-only. Write is never acquired by upgrading; only by somebody here saying yes.
  const edge = mkEdge({ grant: ['health', 'identity'] });
  assert.equal(edge.write_grant, null, 'a pre-existing edge must have no write grant');
  assert.equal(edge.write_scope, null);

  const view = consentView({ ...edge, grant_categories: ['health', 'identity'] }, Date.now());
  assert.equal(view.parentCanControlThisNode, false);
  assert.deepEqual(view.writeGrant, []);
});

test('⚠️ the consent view REPORTS a granted write instead of asserting false', () => {
  /*
   * parentCanControlThisNode was the literal `false`. Once a write can be granted, a hardcoded
   * false assures an operator that nobody can touch their screens — on the very page where they
   * granted exactly that. A consent view that cannot report what it exists to report is worse than
   * none, because it is believed.
   */
  const edge = mkEdge({ write_grant: ['content-push'], write_scope: [wsA] });
  const view = consentView({ ...edge, grant_categories: ['health'] }, Date.now());
  assert.equal(view.parentCanControlThisNode, true);
  assert.deepEqual(view.writeGrant, ['content-push']);
  assert.deepEqual(view.writeWorkspaces, [wsA]);
  assert.match(view.writeGrantExplained.join(' '), /change what plays/i,
    'the consequence must be in words the operator can evaluate, not a category name');
});

test('a malformed write column reads as NO write, never as unrestricted', () => {
  const edge = mkEdge();
  db.prepare('UPDATE mesh_edges SET write_grant = ?, write_scope = ? WHERE id = ?')
    .run('{not json', 'also not json', edge.id);
  const row = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edge.id);
  const view = consentView({ ...row, grant_categories: [] }, Date.now());
  assert.deepEqual(view.writeGrant, [], 'garbage must fail closed');
  assert.equal(view.parentCanControlThisNode, false);
});

test('⚠️ a write category offered over the wire is REFUSED, and says where one comes from', () => {
  for (const w of grants.ALL_WRITE) {
    const v = grants.validateGrant([w]);
    assert.equal(v.ok, false);
    assert.match(v.reason, /chosen by the node being written to/i);
    assert.match(v.reason, /never over the wire/i);
  }
});

test('the consent door takes writes and refuses reads; the wire door is the mirror image', () => {
  assert.equal(grants.validateWriteConsent(['content-push', 'device-command']).ok, true);
  assert.equal(grants.validateWriteConsent(['health']).ok, false,
    'a read category set through the write door would let one route widen the other column');
  assert.equal(grants.validateGrant(['health']).ok, true);
});

test('⚠️ scope is required, and an empty scope means NOTHING', () => {
  // Deliberately opposite to shared_workspaces, where NULL means "all". A write permission that
  // becomes total by being unset is the failure mode this whole design is built against.
  assert.equal(grants.writeAllows(['content-push'], [wsA], 'content-push', wsA), true);
  assert.equal(grants.writeAllows(['content-push'], [wsA], 'content-push', wsB), false);
  assert.equal(grants.writeAllows(['content-push'], [], 'content-push', wsA), false);
  assert.equal(grants.writeAllows(['content-push'], null, 'content-push', wsA), false);
  assert.equal(grants.writeAllows(['content-push'], [wsA], 'content-push', null), false);
});

test('holding one write category never confers the other', () => {
  assert.equal(grants.writeAllows(['content-push'], [wsA], 'device-command', wsA), false);
  assert.equal(grants.writeAllows(['device-command'], [wsA], 'content-push', wsA), false);
});

test('revoking write leaves the connection and its reporting intact', () => {
  const edge = mkEdge({ grant: ['health', 'identity'], write_grant: ['content-push'], write_scope: [wsA] });
  // What the consent route does on an empty category list.
  db.prepare('UPDATE mesh_edges SET write_grant = NULL, write_scope = NULL WHERE id = ?').run(edge.id);
  const row = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edge.id);

  assert.equal(row.revoked_at, null, 'revoking WRITE must not sever the edge');
  assert.equal(JSON.parse(row.grant_categories).length, 2, 'the read grant is untouched');
  const view = consentView({ ...row, grant_categories: ['health', 'identity'] }, Date.now());
  assert.equal(view.parentCanControlThisNode, false);
  assert.equal(view.canRevoke, true);
});
