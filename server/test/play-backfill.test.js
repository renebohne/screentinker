'use strict';

/*
 * #299 — plays recorded while a device was offline.
 *
 * ⚠️ THE BUG THIS EXISTS FOR: playback is offline-native, reporting was online-only. Every player
 * guarded its proof-of-play emit on `socket.connected` and returned, so a play that happened while
 * the link was down was discarded where it occurred. A measured 5h49m outage on alpha lost ~1,040
 * plays: play_logs had one 20,963-second hole and nothing was ever backfilled into it.
 *
 * Two layers, no socket server needed — the shape lib/incident-classify's tests use next door:
 *   1. the pure rules (lib/play-backfill), which the live handler calls, so they cannot drift;
 *   2. an in-memory better-sqlite3 running the handler's real INSERT, so the persistence shape
 *      (and the uniqueness that makes a re-flush idempotent) is proven too.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  normalizeBackfillPlay,
  boundBatch,
  MAX_BACKFILL_BATCH,
  BACKFILL_MAX_AGE_SEC,
  BACKFILL_FUTURE_SKEW_SEC,
  BACKFILL_MAX_DURATION_SEC,
} = require('../lib/play-backfill');

const NOW = 1_800_000_000;                 // fixed clock; the rules take it as a parameter
const ok = (over = {}) => ({ started_at: NOW - 3600, ended_at: NOW - 3580, content_id: 'c1', content_name: 'clip.mp4', completed: true, client_event_id: 'evt-1', ...over });

/* ===================================================== the rules */

test('a plain offline play survives with its OWN times, not the time it arrived', () => {
  /*
   * ⚠️ THE WHOLE POINT. The live path stamps rows with strftime('%s','now'); replaying a backlog
   * through that would record ~1,000 plays as having all happened in the few seconds after
   * reconnect. That is worse than the gap, because it reads as real data.
   */
  const p = normalizeBackfillPlay(ok(), NOW);
  assert.equal(p.started_at, NOW - 3600);
  assert.equal(p.ended_at, NOW - 3580);
  assert.equal(p.duration_sec, 20);
  assert.equal(p.completed, 1);
  assert.equal(p.content_name, 'clip.mp4');
});

test('⚠️ a future timestamp is DROPPED, not clamped', () => {
  // A panel with a bad RTC will offer one. Clamping it to "now" would manufacture a play that
  // never happened at a time it did not happen — indistinguishable from a real one afterwards.
  assert.equal(normalizeBackfillPlay(ok({ started_at: NOW + BACKFILL_FUTURE_SKEW_SEC + 60 }), NOW), null);
});

test('mild clock skew is tolerated — panels are not NTP-perfect', () => {
  assert.ok(normalizeBackfillPlay(ok({ started_at: NOW + 60, ended_at: NOW + 70 }), NOW));
});

test('⚠️ an ancient timestamp is DROPPED', () => {
  // 1970 is what a dead RTC reports. It is a broken clock, not an outage anyone is reporting.
  assert.equal(normalizeBackfillPlay(ok({ started_at: 0, ended_at: 10 }), NOW), null);
  assert.equal(normalizeBackfillPlay(ok({ started_at: NOW - BACKFILL_MAX_AGE_SEC - 1 }), NOW), null);
});

test('a real outage-length backlog is well inside the window', () => {
  const sixHoursAgo = NOW - 6 * 3600;
  const p = normalizeBackfillPlay(ok({ started_at: sixHoursAgo, ended_at: sixHoursAgo + 20 }), NOW);
  assert.equal(p.started_at, sixHoursAgo);
});

test('⚠️ a missing or impossible end leaves the row OPEN rather than inventing one', () => {
  for (const bad of [undefined, null, 'x', NOW - 4000 /* before its start */, NOW + 99999 /* future */]) {
    const p = normalizeBackfillPlay(ok({ ended_at: bad }), NOW);
    assert.ok(p, `started_at should still be accepted (ended_at=${bad})`);
    assert.equal(p.ended_at, null, `ended_at=${bad} should leave the row open`);
    assert.equal(p.duration_sec, null);
  }
});

test('an absurd duration is capped', () => {
  const p = normalizeBackfillPlay(ok({ started_at: NOW - 20, ended_at: NOW }), NOW);
  assert.equal(p.duration_sec, 20);
  const long = normalizeBackfillPlay({ started_at: NOW - 2 * BACKFILL_MAX_DURATION_SEC, ended_at: NOW }, NOW);
  assert.equal(long.duration_sec, BACKFILL_MAX_DURATION_SEC);
});

test('junk in never throws', () => {
  for (const bad of [null, undefined, 42, 'nope', [], {}, { started_at: NaN }, { started_at: 'x' }]) {
    assert.doesNotThrow(() => normalizeBackfillPlay(bad, NOW));
    assert.equal(normalizeBackfillPlay(bad, NOW), null);
  }
});

test('⚠️ a flush is bounded, so one payload cannot insert without limit', () => {
  const many = Array.from({ length: MAX_BACKFILL_BATCH * 3 }, () => ok());
  assert.equal(boundBatch(many).length, MAX_BACKFILL_BATCH);
  assert.deepEqual(boundBatch('not an array'), []);
  assert.deepEqual(boundBatch(undefined), []);
});

/* ===================================================== the persistence */

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE play_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      content_id TEXT, widget_id TEXT, zone_id TEXT,
      content_name TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL, ended_at INTEGER, duration_sec INTEGER,
      completed INTEGER NOT NULL DEFAULT 0,
      trigger_type TEXT DEFAULT 'playlist',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      client_event_id TEXT
    );
    CREATE UNIQUE INDEX idx_play_logs_client_event
      ON play_logs(client_event_id) WHERE client_event_id IS NOT NULL;
  `);
  return db;
}

// The handler's real statement.
const insertOf = (db) => db.prepare(`
  INSERT OR IGNORE INTO play_logs
    (device_id, content_id, widget_id, zone_id, content_name, started_at, ended_at,
     duration_sec, completed, trigger_type, client_event_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'playlist', ?)
`);

const store = (db, p) => insertOf(db).run('dev1', p.content_id, p.widget_id, p.zone_id,
  p.content_name, p.started_at, p.ended_at, p.duration_sec, p.completed, p.client_event_id);

test('a backfilled row lands with the play times the player reported', () => {
  const db = freshDb();
  store(db, normalizeBackfillPlay(ok(), NOW));
  const row = db.prepare('SELECT * FROM play_logs').get();
  assert.equal(row.started_at, NOW - 3600);
  assert.equal(row.duration_sec, 20);
  assert.equal(row.completed, 1);
  assert.notEqual(row.started_at, row.created_at, 'the play time must not be the arrival time');
});

test('⚠️ RE-FLUSHING THE SAME BACKLOG DOES NOT DOUBLE-COUNT', () => {
  /*
   * The failure this guards: a player flushes, the ack is lost (or it dies first), and it flushes
   * the same queue again on its next boot. Without the unique client_event_id every outage would
   * over-report instead of under-reporting — trading one wrong number for another.
   */
  const db = freshDb();
  const p = normalizeBackfillPlay(ok({ client_event_id: 'evt-42' }), NOW);
  const first = store(db, p);
  const second = store(db, p);
  assert.equal(first.changes, 1);
  assert.equal(second.changes, 0, 'the second flush inserted a duplicate row');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM play_logs').get().c, 1);
});

test('two DIFFERENT plays of the same content both store', () => {
  const db = freshDb();
  store(db, normalizeBackfillPlay(ok({ client_event_id: 'a' }), NOW));
  store(db, normalizeBackfillPlay(ok({ client_event_id: 'b' }), NOW));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM play_logs').get().c, 2);
});

test('⚠️ live rows (no client_event_id) never collide with each other', () => {
  // The index is partial for exactly this reason: NULLs must not be treated as a duplicate key,
  // or the first live play would block every one after it.
  const db = freshDb();
  for (let i = 0; i < 5; i++) store(db, normalizeBackfillPlay(ok({ client_event_id: null }), NOW));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM play_logs').get().c, 5);
});

test('a whole outage backlog stores in one pass, with its shape intact', () => {
  // ~1,040 plays is what the real outage produced; prove the batch bound and the rules together.
  const db = freshDb();
  const start = NOW - 6 * 3600;
  const backlog = Array.from({ length: 1040 }, (_, i) => ok({
    started_at: start + i * 20, ended_at: start + i * 20 + 20, client_event_id: `e${i}`,
  }));
  let written = 0;
  for (const raw of boundBatch(backlog)) {
    const p = normalizeBackfillPlay(raw, NOW);
    if (p) written += store(db, p).changes;
  }
  assert.equal(written, MAX_BACKFILL_BATCH, 'one flush should write exactly a bounded batch');
  const spread = db.prepare('SELECT MAX(started_at) - MIN(started_at) AS s FROM play_logs').get().s;
  assert.ok(spread > 3000, `plays must keep their real spread over time, got ${spread}s`);
});
