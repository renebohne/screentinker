'use strict';

/*
 * Applying a write a parent asked for — the enforcement, not the transport.
 *
 * Every check here runs on the node that owns the screens, against that node's own rows. The
 * parent's message says what it WANTS; it is never consulted about whether it may have it, and
 * never about which workspace it is touching.
 */
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-meshapply-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { applyWrite } = require('../lib/mesh/node-write');

const id = () => crypto.randomUUID();
let wsA, wsB, plA, plB, userId;
let applied;                       // what the executor was asked to do
/*
 * ⚠️ ASYNC, because the real executor is. A synchronous stub let applyWrite record an unawaited
 * promise as a successful outcome and ack ok:true to the hub before the request had even been sent
 * — and the whole suite stayed green. A stub simpler than its collaborator tests the stub.
 */
const apply = async (call) => { applied.push(call); return { ok: true, id: call.path }; };

before(() => {
  userId = id(); const org = id();
  db.prepare('INSERT INTO users (id,email,name,password_hash) VALUES (?,?,?,?)').run(userId, `a-${userId}@e.com`, 'A', 'x');
  db.prepare(`INSERT INTO organizations (id,name,owner_user_id,created_at,updated_at)
              VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(org, 'Org', userId);
  wsA = id(); wsB = id();
  for (const w of [wsA, wsB]) {
    db.prepare(`INSERT INTO workspaces (id,organization_id,name,created_at,updated_at)
                VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(w, org, 'ws');
  }
  plA = id(); plB = id();
  db.prepare('INSERT INTO playlists (id,user_id,workspace_id,name) VALUES (?,?,?,?)').run(plA, userId, wsA, 'A loop');
  db.prepare('INSERT INTO playlists (id,user_id,workspace_id,name) VALUES (?,?,?,?)').run(plB, userId, wsB, 'B loop');
});

const mkEdge = (writeGrant, writeScope) => {
  const e = id();
  db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, role_capabilities, grant_categories,
              transport_direction, tls_verify, created_at, write_grant, write_scope)
              VALUES (?,?,'up','[]','["health"]','we-dial',1,strftime('%s','now'),?,?)`)
    .run(e, id(), writeGrant ? JSON.stringify(writeGrant) : null, writeScope ? JSON.stringify(writeScope) : null);
  return db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(e);
};
const req = (o = {}) => ({ opId: id(), path: `/api/playlists/${plA}/items`, method: 'POST', body: {}, ...o });

test('a granted write, in scope, is applied', async () => {
  applied = [];
  const edge = mkEdge(['content-push'], [wsA]);
  const r = await applyWrite(db, edge, req(), { apply });
  assert.equal(r.ok, true, r.reason);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].workspaceId, wsA, 'the workspace must be the one the TARGET belongs to');
});

test('⚠️ the workspace comes from the TARGET, not from the request', async () => {
  /*
   * The scope check is decorative if the parent names its own scope. Here the edge may write wsA,
   * and the request claims wsA — but the playlist it names lives in wsB. The child resolves the
   * target itself, so the claim is irrelevant.
   */
  applied = [];
  const edge = mkEdge(['content-push'], [wsA]);
  const r = await applyWrite(db, edge, req({ path: `/api/playlists/${plB}/items`, body: { workspace_id: wsA } }), { apply });
  assert.equal(r.ok, false, 'a parent naming its own scope must not widen it');
  assert.equal(applied.length, 0);
});

test('an edge with no write grant is refused before the target is even looked up', async () => {
  applied = [];
  const edge = mkEdge(null, null);
  const r = await applyWrite(db, edge, req(), { apply });
  assert.equal(r.ok, false);
  assert.match(r.reason, /may not change anything/i);
});

test('⚠️ an unknown target is refused in the SAME words as a denial', async () => {
  // Otherwise the write door becomes an oracle: a parent could enumerate which playlist ids exist
  // on someone else's server by telling the two refusals apart.
  const edge = mkEdge(['content-push'], [wsA]);
  const denied = await applyWrite(db, edge, req({ path: `/api/playlists/${plB}/items` }), { apply });
  const missing = await applyWrite(db, edge, req({ path: '/api/playlists/does-not-exist/items' }), { apply });
  assert.equal(denied.ok, false);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, denied.reason, 'a missing target and a forbidden one must be indistinguishable');
});

test('a path outside the allowlist is refused however good the grant is', async () => {
  const edge = mkEdge(['content-push', 'device-command'], [wsA, wsB]);
  for (const p of ['/api/admin/users', '/api/tokens', '/api/workspaces', '/api/mesh/uplink/e1/write-grant']) {
    const r = await applyWrite(db, edge, req({ path: p, method: 'POST' }), { apply });
    assert.equal(r.ok, false, `${p} must never be writable`);
  }
});

test('⚠️ a RETRY returns the first outcome instead of applying twice', async () => {
  /*
   * The uplink re-queues on ack timeout, so a dropped link resends the same intent as a matter of
   * course. Without this, "the network hiccuped" and "the operator asked twice" are the same event,
   * and the second one adds a duplicate item to somebody's playlist.
   */
  applied = [];
  const edge = mkEdge(['content-push'], [wsA]);
  const r1 = await applyWrite(db, edge, req({ opId: 'op-fixed' }), { apply });
  const r2 = await applyWrite(db, edge, req({ opId: 'op-fixed' }), { apply });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r2.replayed, true, 'the second attempt must be reported as a replay');
  assert.equal(applied.length, 1, 'it must not have been applied twice');
  assert.deepEqual(r2.outcome, r1.outcome, 'a replay returns what happened the first time');
});

test('a write with no operation id is refused, because retrying it could not be safe', async () => {
  const edge = mkEdge(['content-push'], [wsA]);
  const r = await applyWrite(db, edge, { path: `/api/playlists/${plA}/items`, method: 'POST', body: {} }, { apply });
  assert.equal(r.ok, false);
  assert.match(r.reason, /operation id/i);
});

test('⚠️ a STALE intent for the same target is dropped, not applied last-wins', async () => {
  applied = [];
  const edge = mkEdge(['content-push'], [wsA]);
  const newer = await applyWrite(db, edge, req({ intentSeq: 5 }), { apply });
  const older = await applyWrite(db, edge, req({ intentSeq: 2 }), { apply });
  assert.equal(newer.ok, true);
  assert.equal(older.ok, false, 'an older intent must not overwrite a newer one by arriving later');
  assert.match(older.reason, /newer change/i);
  assert.equal(applied.length, 1);
});

test('⚠️ an EXPIRED write is refused — revocation must not be outrun by a slow link', async () => {
  const edge = mkEdge(['content-push'], [wsA]);
  const now = Date.now();
  const r = await applyWrite(db, edge, req({ notAfter: now - 1000, sentAt: now }), { apply, now: () => now });
  assert.equal(r.ok, false);
  assert.match(r.reason, /expired/i);
});

test('a peer with absurd clock skew cannot be trusted with a deadline', async () => {
  const edge = mkEdge(['content-push'], [wsA]);
  const now = Date.now();
  const r = await applyWrite(db, edge, req({ notAfter: now + 60000, sentAt: now + 40 * 60 * 1000 }), { apply, now: () => now });
  assert.equal(r.ok, false);
  assert.match(r.reason, /clock skew|disagree about the time/i);
});

test('holding content-push never confers device-command', () => {
  const edge = mkEdge(['content-push'], [wsA]);
  // device-command paths are not even in WRITABLE yet — the point is the grant is per-category.
  const { writeAllows } = require('../lib/mesh/grants');
  assert.equal(writeAllows(['content-push'], [wsA], 'device-command', wsA), false);
});

test('⚠️ a write that FAILS locally is reported as failed, not acked as success', async () => {
  /*
   * The bug this pins: applyWrite was not async and did not await apply(). The real executor is
   * async, so the promise was recorded in mesh_write_ops as `ok=1` BEFORE the request had been
   * sent, the hub was told ok:true, and the idempotency record then replayed that invented success
   * on every retry — the write could never recover, and nothing anywhere said so.
   */
  const edge = mkEdge(['content-push'], [wsA]);
  const failing = async () => { const e = new Error('Content not found'); e.status = 404; throw e; };
  const r = await applyWrite(db, edge, req({ opId: 'op-fails' }), { apply: failing });
  assert.equal(r.ok, false, 'a rejected apply must not be reported as success');

  const row = db.prepare('SELECT ok FROM mesh_write_ops WHERE edge_id = ? AND op_id = ?')
    .get(edge.id, 'op-fails');
  assert.equal(row.ok, 0, 'the failure must be recorded as a failure, or a retry replays a lie');
});

test('the recorded outcome is the RESOLVED value, not a promise', async () => {
  const edge = mkEdge(['content-push'], [wsA]);
  await applyWrite(db, edge, req({ opId: 'op-shape' }), { apply: async () => ({ status: 201, result: { id: 'x' } }) });
  const row = db.prepare('SELECT outcome FROM mesh_write_ops WHERE edge_id = ? AND op_id = ?')
    .get(edge.id, 'op-shape');
  assert.deepEqual(JSON.parse(row.outcome), { status: 201, result: { id: 'x' } },
    'JSON.stringify of an unawaited promise is "{}" — a recorded outcome that says nothing');
});
