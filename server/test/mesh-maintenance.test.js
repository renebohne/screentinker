'use strict';

/*
 * THE SWEEPS THAT WERE DESIGNED, INDEXED FOR, AND NEVER SCHEDULED.
 *
 * Three tables grew without bound on a long-lived node, and each already had everything needed to
 * prune it except a caller: mirror-store.pruneEdge had no callers outside its own tests, and both
 * idx_mesh_write_ops_age and the mesh_pull_tickets expiry index were created for pruners nobody
 * wrote. A retention setting the UI offers and the server never applies is worse than none — it is
 * a promise the product does not keep, on the axis a customer asks about by name.
 */
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-meshmaint-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { sweepOnce, WRITE_OP_RETENTION_DAYS } = require('../services/mesh-maintenance');

const id = () => crypto.randomUUID();
const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);
let edge;

before(() => {
  edge = id();
  db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, transport_direction, created_at,
              retention_days, tombstone_purge_days)
              VALUES (?,?,'down','they-dial',strftime('%s','now'), 30, 30)`).run(edge, 'child-1');
});

test('closed alerts past the edge retention are removed; open ones are not', () => {
  const old = nowSec() - 60 * DAY;
  db.prepare(`INSERT INTO mesh_mirror_alerts (origin_node_id, alert_type, severity, opened_at, closed_at, received_at)
              VALUES (?,?,?,?,?,?)`).run('child-1', 'a-closed', 'warn', old, old, old);
  db.prepare(`INSERT INTO mesh_mirror_alerts (origin_node_id, alert_type, severity, opened_at, closed_at, received_at)
              VALUES (?,?,?,?,NULL,?)`).run('child-1', 'a-open', 'warn', old, old);

  sweepOnce(db, { warn() {}, log() {} });

  const left = db.prepare('SELECT alert_type FROM mesh_mirror_alerts WHERE origin_node_id = ?').all('child-1')
    .map((r) => r.alert_type);
  assert.deepEqual(left, ['a-open'],
    'an alert still open is current state however old it is — only history ages out');
});

test('⚠️ settled write ops age out; an IN-FLIGHT one never does', () => {
  const old = nowSec() - (WRITE_OP_RETENTION_DAYS + 5) * DAY;
  const rows = [
    ['op-applied', 1, old],
    ['op-refused', 0, old],
    ['op-inflight', -1, old],       // outcome unknown
    ['op-recent', 1, nowSec()],
  ];
  for (const [op, ok, at] of rows) {
    db.prepare(`INSERT INTO mesh_write_ops (edge_id, op_id, target, intent_seq, ok, outcome, applied_at)
                VALUES (?,?,?,NULL,?,NULL,?)`).run(edge, op, 'playlist:x', ok, at);
  }

  sweepOnce(db, { warn() {}, log() {} });

  const left = db.prepare('SELECT op_id FROM mesh_write_ops WHERE edge_id = ?').all(edge)
    .map((r) => r.op_id).sort();
  /*
   * ⚠️ The in-flight row is the important one. Deleting a write whose outcome nobody knows frees
   * its op id for reuse — and the design instructs the operator to retry with that same id, so the
   * next retry would apply the change a second time instead of replaying the recorded outcome.
   */
  assert.deepEqual(left, ['op-inflight', 'op-recent']);
});

test('expired pull tickets are swept and live ones are kept', () => {
  db.prepare(`INSERT INTO mesh_pull_tickets (token_hash, edge_id, filepath, size, digest, expires_at, created_at)
              VALUES (?,?,?,?,?,?,strftime('%s','now'))`)
    .run('t-dead', edge, 'a.mp4', 10, 'a'.repeat(64), nowSec() - 60);
  db.prepare(`INSERT INTO mesh_pull_tickets (token_hash, edge_id, filepath, size, digest, expires_at, created_at)
              VALUES (?,?,?,?,?,?,strftime('%s','now'))`)
    .run('t-live', edge, 'b.mp4', 10, 'b'.repeat(64), nowSec() + 3600);

  sweepOnce(db, { warn() {}, log() {} });

  const left = db.prepare('SELECT token_hash FROM mesh_pull_tickets').all().map((r) => r.token_hash);
  assert.deepEqual(left, ['t-live']);
});

test('⚠️ one edge failing does not stop the others being swept', () => {
  // I1: this service must never be able to harm its own node. A malformed row on one relationship
  // must not leave every other customer's retention unapplied.
  const broken = id();
  db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, transport_direction, created_at,
              retention_days) VALUES (?,?,'down','they-dial',strftime('%s','now'), 30)`)
    .run(broken, 'child-broken');
  const old = nowSec() - 60 * DAY;
  db.prepare(`INSERT INTO mesh_mirror_play_logs (origin_node_id, device_id, played_at, received_at)
              VALUES (?,?,?,?)`).run('child-1', 'd1', old, old);

  const r = sweepOnce(db, { warn() {}, log() {} });
  assert.ok(r.playLogs >= 1, 'the healthy edge is still pruned');
});

test('a sweep on an empty database removes nothing and throws nothing', () => {
  const r = sweepOnce(db, { warn() {}, log() {} });
  assert.equal(typeof r.writeOps, 'number');
});
