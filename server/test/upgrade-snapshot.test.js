'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { snapshotOnVersionChange, pruneSnapshots, readLastVersion, PREFIX } = require('../lib/upgrade-snapshot');

const fakeDb = { pragma() {} };
const copy = (a, b) => fs.copyFileSync(a, b);

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'upsnap-')); }
function snaps(d) { return fs.readdirSync(d).filter((n) => n.startsWith(PREFIX)); }

test('a 2.x database (no sidecar) is snapshotted on its first 3.0 boot, then not again', () => {
  const d = dir(); const db = path.join(d, 'remote_display.db');
  fs.writeFileSync(db, 'old-bytes');
  const s = snapshotOnVersionChange({ db: fakeDb, dbPath: db, existedBefore: true, version: '3.0.0', copy });
  assert.ok(s && fs.existsSync(s));
  assert.match(path.basename(s), /from-pre-3\.0\.db$/);
  assert.equal(fs.readFileSync(s, 'utf8'), 'old-bytes');
  assert.equal(readLastVersion(d), '3.0.0');
  assert.equal(snapshotOnVersionChange({ db: fakeDb, dbPath: db, existedBefore: true, version: '3.0.0', copy }), null);
  assert.equal(snaps(d).length, 1);
});

test('a fresh install takes no snapshot but records its version', () => {
  const d = dir(); const db = path.join(d, 'remote_display.db');
  assert.equal(snapshotOnVersionChange({ db: fakeDb, dbPath: db, existedBefore: false, version: '3.0.0', copy }), null);
  assert.equal(snaps(d).length, 0);
  assert.equal(readLastVersion(d), '3.0.0');
});

test('a failed snapshot refuses to boot; ST_SKIP_UPGRADE_SNAPSHOT=1 opts out', () => {
  const d = dir(); const db = path.join(d, 'remote_display.db');
  fs.writeFileSync(db, 'x');
  let code = null;
  snapshotOnVersionChange({ db: fakeDb, dbPath: db, existedBefore: true, version: '3.0.0', copy: () => { throw new Error('ENOSPC'); }, exit: (c) => { code = c; } });
  assert.equal(code, 1);
  assert.equal(readLastVersion(d), null, 'not recorded, so the next boot tries again');
  assert.equal(snapshotOnVersionChange({ db: fakeDb, dbPath: db, existedBefore: true, version: '3.0.0', copy, env: { ST_SKIP_UPGRADE_SNAPSHOT: '1' } }), null);
  assert.equal(readLastVersion(d), '3.0.0');
});

test('only the newest snapshots are kept; unknown and in-memory databases are left alone', () => {
  const d = dir();
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(d, `${PREFIX}2026-0${i}.db`), '');
  fs.writeFileSync(path.join(d, 'remote_display.pre-migration-x.db'), '');
  pruneSnapshots(d, 3);
  assert.deepEqual(snaps(d).sort(), [`${PREFIX}2026-02.db`, `${PREFIX}2026-03.db`, `${PREFIX}2026-04.db`]);
  assert.ok(fs.existsSync(path.join(d, 'remote_display.pre-migration-x.db')), 'other snapshots are not ours to prune');
  assert.equal(snapshotOnVersionChange({ db: fakeDb, dbPath: ':memory:', existedBefore: false, version: '3.0.0', copy }), null);
  assert.equal(snapshotOnVersionChange({ db: fakeDb, dbPath: path.join(d, 'a.db'), existedBefore: true, version: '0.0.0', copy }), null);
});
