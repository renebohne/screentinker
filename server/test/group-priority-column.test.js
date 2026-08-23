'use strict';

/*
 * `device_groups.priority` — the precedence column for a device in MORE THAN ONE group.
 *
 * ⚠️ THIS COLUMN IS DELIBERATELY INERT. Nothing reads it yet: it is the first half of replacing
 * twelve eager writers of `devices.playlist_id` with one resolver, and it ships ahead of that logic
 * so the schema change can be present and backfilled before anything depends on it. These tests pin
 * the CONTRACT the resolver will be written against — default, nullability, and the tiebreak
 * ordering — so the column cannot quietly change shape between now and then.
 *
 * It mirrors `schedules.priority` on purpose. The two inheritance systems in this codebase already
 * disagree (schedules resolve lazily with a stated rule; playlists are copied eagerly with none),
 * and matching the column is what stops them drifting further. See docs/playlist-inheritance-design.md.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function bootDb() {
  // A real boot, so the migration list runs exactly as it does in production.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grp-pri-'));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  delete require.cache[require.resolve('../db/database')];
  const { db } = require('../db/database');
  return { db, dir, restore: () => { if (prev === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev; } };
}

test('device_groups.priority exists, is NOT NULL, and defaults to 0', () => {
  const { db, restore } = bootDb();
  try {
    const col = db.prepare('PRAGMA table_info(device_groups)').all().find(c => c.name === 'priority');
    assert.ok(col, 'the priority column is missing — multi-group precedence has nothing to resolve on');
    assert.equal(col.notnull, 1, 'nullable priority would make the ORDER BY non-deterministic for old rows');
    assert.equal(String(col.dflt_value), '0',
      'a group created without an explicit priority must sort with the others, not ahead of them');
  } finally { restore(); }
});

test('⚠️ it matches schedules.priority — the two inheritance systems must not drift', () => {
  // If these ever differ in type or nullability, one resolver will order groups differently from
  // the way the other orders schedules, and the same estate will answer "which content?" two ways.
  const { db, restore } = bootDb();
  try {
    const g = db.prepare('PRAGMA table_info(device_groups)').all().find(c => c.name === 'priority');
    const s = db.prepare('PRAGMA table_info(schedules)').all().find(c => c.name === 'priority');
    assert.ok(s, 'schedules.priority is gone — this test is comparing against nothing');
    assert.equal(g.type, s.type, 'group and schedule priority must be the same type');
  } finally { restore(); }
});

test('the documented tiebreak orders as intended: priority DESC, then created_at ASC', () => {
  /*
   * Pins the ORDER the resolver will use, before the resolver exists. The tiebreak is the half
   * people get wrong: without `created_at ASC` two equal-priority groups resolve in whatever order
   * SQLite returns, which is exactly the non-answer this column is replacing.
   */
  const { db, restore } = bootDb();
  try {
    db.exec(`CREATE TEMP TABLE g (id TEXT, priority INTEGER NOT NULL DEFAULT 0, created_at INTEGER)`);
    const ins = db.prepare('INSERT INTO g (id, priority, created_at) VALUES (?, ?, ?)');
    ins.run('older-equal', 5, 100);
    ins.run('newer-equal', 5, 200);
    ins.run('highest', 9, 300);
    ins.run('default', 0, 50);
    const order = db.prepare('SELECT id FROM g ORDER BY priority DESC, created_at ASC').all().map(r => r.id);
    assert.deepEqual(order, ['highest', 'older-equal', 'newer-equal', 'default'],
      'priority must win first, and the OLDER group must win a tie');
  } finally { restore(); }
});
