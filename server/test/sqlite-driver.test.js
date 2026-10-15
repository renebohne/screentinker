'use strict';

/*
 * The driver choice, and the thing that choice is supposed to protect: that BOTH drivers behave the
 * same way for the SQL this server actually issues.
 *
 * ⚠️ WHY THIS FILE EXISTS AT ALL. The player package used to be manufactured by the packager, which
 * dropped better-sqlite3 and installed db/sqlite-compat.js into node_modules under that name. The
 * result was an artifact whose database layer no test had ever run — the same shape as the
 * TELEMETRY_COLLECTOR crash that took production down with 1676 tests green. Choosing at runtime is
 * only an improvement if the second choice is exercised, so these run the built-in driver on an
 * ordinary developer machine via ST_SQLITE_DRIVER=node.
 *
 * Each case runs in a CHILD PROCESS. The driver decides once at require time and caches on the
 * module registry, so two selections cannot coexist in one process, and clearing require.cache would
 * leave the previous native binding loaded anyway.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const DRIVER = path.join(__dirname, '..', 'db', 'sqlite-driver.js');

/*
 * node:sqlite is unflagged from Node 22.13 and does not exist on 20.x. Where it is missing the
 * built-in-driver cases SKIP rather than fail - a skip says "not checked here", which is true,
 * where a failure would say "broken", which is not.
 *
 * The fallback is genuinely exercised by the separate Node 24 CI job that runs this whole suite with
 * ST_SQLITE_DRIVER=node. If that job is ever dropped, these tests go quiet everywhere and the player's
 * database layer is untested again - which is the exact hole this file was written to close.
 */
const NO_BUILTIN = (() => { try { require('node:sqlite'); return false; }
                            catch { return `node:sqlite unavailable on ${process.version}`; } })();

/*
 * Whether the NATIVE module is usable under this exact Node. Not the same question as "is it
 * installed": better-sqlite3 loads its binding lazily, so a node_modules built for another ABI
 * requires fine and dies on first use. A tree built by Node 24 and then run under Node 20 is the
 * everyday case on a developer machine, and "the native driver is preferred WHEN IT WORKS" is
 * untestable there - so that case skips rather than reporting a bug that is not in the code.
 */
const NO_NATIVE = (() => {
  try { const D = require('better-sqlite3'); new D(':memory:').close(); return false; }
  catch (e) { return `better-sqlite3 unusable on ${process.version}: ${String(e.message).split('\n')[0]}`; }
})();

function inChild(code, env) {
  return execFileSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    timeout: 30000,
    env: Object.assign({}, process.env, env || {}),
  }).trim();
}

test('by default it picks the native driver when the native driver works', { skip: NO_NATIVE }, () => {
  const out = inChild(`console.log(require(${JSON.stringify(DRIVER)}).driverName)`, { ST_SQLITE_DRIVER: '' });
  assert.equal(out, 'better-sqlite3');
});

test('ST_SQLITE_DRIVER=node selects the built-in one', { skip: NO_BUILTIN }, () => {
  // This is the switch CI uses to run the whole suite the way a player runs it.
  const out = inChild(`console.log(require(${JSON.stringify(DRIVER)}).driverName)`, { ST_SQLITE_DRIVER: 'node' });
  assert.equal(out, 'node:sqlite');
});

test('asking for the native driver by name fails loudly rather than downgrading', () => {
  /*
   * A production server that has lost its native module should not quietly continue on a different
   * driver: the install is broken and someone needs to know. Simulated by making better-sqlite3
   * unresolvable in a throwaway directory rather than by touching the real node_modules.
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stdrv-'));
  const stub = path.join(dir, 'driver-copy.js');
  fs.copyFileSync(DRIVER, stub);
  fs.copyFileSync(path.join(__dirname, '..', 'db', 'sqlite-compat.js'), path.join(dir, 'sqlite-compat.js'));

  let threw = null;
  try {
    inChild(`require(${JSON.stringify(stub)})`, { ST_SQLITE_DRIVER: 'better-sqlite3' });
  } catch (e) {
    threw = String(e.stderr || e.message);
  }
  assert.ok(threw, 'requesting an unusable native driver should throw');
  assert.match(threw, /ST_SQLITE_DRIVER=better-sqlite3 was requested but it is not usable/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing native module falls back instead of failing', { skip: NO_BUILTIN }, () => {
  // The player case: no compiler, no prebuild, no node-gyp — and the server still has to start.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stdrv-'));
  fs.copyFileSync(DRIVER, path.join(dir, 'driver-copy.js'));
  fs.copyFileSync(path.join(__dirname, '..', 'db', 'sqlite-compat.js'), path.join(dir, 'sqlite-compat.js'));
  const out = inChild(
    `console.log(require(${JSON.stringify(path.join(dir, 'driver-copy.js'))}).driverName)`,
    { ST_SQLITE_DRIVER: '' });
  assert.equal(out, 'node:sqlite');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('THE POINT: both drivers give the same answers for the SQL this server issues', { skip: NO_BUILTIN }, () => {
  /*
   * Not a smoke test of "it opens". These are the shapes the server relies on at its 1501 prepare()
   * call sites - named parameters, .get/.all/.run, lastInsertRowid, changes, and the three methods
   * the façade has to provide itself (.pragma, .transaction, .pluck).
   */
  const program = (dbPath) => `
    const { Database } = require(${JSON.stringify(DRIVER)});
    const db = new Database(${JSON.stringify(dbPath)});
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n INTEGER)');
    const ins = db.prepare('INSERT INTO t (name, n) VALUES (@name, @n)');
    const r1 = ins.run({ name: 'a', n: 1 });
    ins.run({ name: 'b', n: 2 });
    const tx = db.transaction((rows) => { for (const row of rows) ins.run(row); });
    tx([{ name: 'c', n: 3 }, { name: 'd', n: 4 }]);
    const out = {
      lastInsertRowid: Number(r1.lastInsertRowid),
      changes: db.prepare('UPDATE t SET n = n + 1 WHERE name = ?').run('a').changes,
      one: db.prepare('SELECT name, n FROM t WHERE name = ?').get('b'),
      all: db.prepare('SELECT name FROM t ORDER BY name').all().map((r) => r.name),
      plucked: db.prepare('SELECT n FROM t ORDER BY n').pluck().all(),
      count: db.prepare('SELECT COUNT(*) AS c FROM t').get().c,
      missing: db.prepare('SELECT name FROM t WHERE name = ?').get('nope') === undefined,
    };
    db.close();
    console.log(JSON.stringify(out));
  `;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stdrv-cmp-'));
  const native = JSON.parse(inChild(program(path.join(tmp, 'native.db')), { ST_SQLITE_DRIVER: 'better-sqlite3' }));
  const builtin = JSON.parse(inChild(program(path.join(tmp, 'builtin.db')), { ST_SQLITE_DRIVER: 'node' }));

  assert.deepEqual(builtin, native,
    'the built-in driver must answer exactly as the native one does, or the player runs different software');
  // And the values are what they should be, so two identically-wrong drivers cannot pass.
  assert.deepEqual(native.all, ['a', 'b', 'c', 'd']);
  assert.deepEqual(native.plucked, [2, 2, 3, 4]);
  assert.equal(native.count, 4);
  assert.equal(native.changes, 1);
  assert.equal(native.missing, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});
