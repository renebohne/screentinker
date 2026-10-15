'use strict';

/*
 * /api/reports/plays and /export read play history by the SNAPSHOTTED play_logs.workspace_id, not
 * by where the device lives NOW — a screen moved from workspace A to B must not hand A's history to
 * B. A NULL snapshot (a play from before the device was in any workspace) falls back to current
 * membership. And the CSV export neutralises spreadsheet formulas in user-supplied names.
 *
 * Mounts the router in-process over an in-memory database (only the columns these routes read).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const mem = new Database(':memory:');
mem.exec(`
  CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT, workspace_id TEXT);
  CREATE TABLE play_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT, content_id TEXT, widget_id TEXT, zone_id TEXT,
    content_name TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL, ended_at INTEGER, duration_sec INTEGER,
    completed INTEGER NOT NULL DEFAULT 0, trigger_type TEXT, created_at INTEGER, client_event_id TEXT, workspace_id TEXT);
`);
require.cache[require.resolve('../db/database')] = {
  id: require.resolve('../db/database'), loaded: true, exports: { db: mem },
};
const express = require('express');
const reports = require('../routes/reports');
const { csvCell } = reports;

let server, base;
before(() => new Promise((resolve) => {
  // Device d1 played in wsA, then was MOVED to wsB and played there. d2 played before being claimed.
  mem.prepare("INSERT INTO devices VALUES ('d1', 'Lobby', 'wsB'), ('d2', 'Hall', 'wsB')").run();
  const ins = mem.prepare('INSERT INTO play_logs (device_id, content_name, started_at, workspace_id) VALUES (?, ?, ?, ?)');
  ins.run('d1', 'A-ONLY-PLAY', 1000, 'wsA');
  ins.run('d1', 'B-PLAY', 2000, 'wsB');
  ins.run('d2', '=HYPERLINK("http://evil","x")', 3000, null);
  const app = express();
  app.use((req, _res, next) => { req.workspaceId = req.headers['x-ws'] || null; next(); });
  app.use('/r', reports);
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
after(() => { if (server) server.close(); });

const get = (p, ws) => fetch(base + p, { headers: ws ? { 'x-ws': ws } : {} });

test('/plays: the old workspace keeps its history after a device moves; the new one does not inherit it', async () => {
  const a = await (await get('/r/plays', 'wsA')).json();
  const b = await (await get('/r/plays', 'wsB')).json();
  assert.deepEqual(a.map((r) => r.content_name), ['A-ONLY-PLAY']);
  assert.deepEqual(b.map((r) => r.content_name).sort(), ['=HYPERLINK("http://evil","x")', 'B-PLAY'].sort(),
    'wsB sees its own play and the NULL-snapshot (pre-claim) play of its device, never wsA\'s');
});

test('/export: same scope, and formula-leading names are neutralised', async () => {
  const csvA = await (await get('/r/export', 'wsA')).text();
  assert.match(csvA, /A-ONLY-PLAY/);
  assert.doesNotMatch(csvA, /B-PLAY/);
  const csvB = await (await get('/r/export', 'wsB')).text();
  assert.doesNotMatch(csvB, /A-ONLY-PLAY/);
  assert.match(csvB, /"'=HYPERLINK\(""http:\/\/evil"",""x""\)"/, 'prefixed with \' and quotes doubled');
});

test('csvCell: every formula lead character is prefixed; ordinary values are untouched', () => {
  for (const lead of ['=', '+', '-', '@', '\t', '\r']) assert.equal(csvCell(lead + '1'), `"'${lead}1"`);
  assert.equal(csvCell('Menu "Lunch"'), '"Menu ""Lunch"""');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell('Lobby 2'), '"Lobby 2"');
});
