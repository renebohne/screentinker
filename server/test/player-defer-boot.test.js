'use strict';

/*
 * 2.0.1 — hold PLAYERS off until first-boot maintenance is idle.
 *
 * ⚠️ THE REPORT. A 73-device install on a Synology DS225+ (spinning SATA) upgraded 1.9.39 -> 2.0.0.
 * Migrations and the playlist-source backfill were fine. Then the box came up and all 73 players
 * reconnected at once: HTTP was unreachable for about twenty minutes even though the WebSocket
 * layer was accepting, because the content-ready storm plus the #307 stranded-play sweep kept the
 * event loop pinned. The stranded backlog was **494,000 rows** — not the 36,096 from the #307
 * investigation, which was one database's open set and was never the universe.
 *
 * #142's per-device shed was working exactly as designed and could not help: nothing was
 * misbehaving, there were simply 73 well-behaved players arriving at once. The workaround that
 * worked was stop nginx -> let maintenance finish -> start nginx. lib/boot-defer.js is that
 * workaround as a feature, and this file pins its three load-bearing promises:
 *
 *   1. while deferred, a PLAYER is refused — and refused, not accepted and stalled;
 *   2. while deferred, /api/status still answers 200 (compose's healthcheck polls it, and failing
 *      it during maintenance turns a slow boot into a restart loop — the #146 lesson);
 *   3. the defer LIFTS once the sweep reports idle, and lifts on a valve even if it does not.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-defer-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-player-defer';
// Explicitly neutral: these tests drive the state machine directly, and an operator's forced
// setting leaking in from the environment would quietly invert half of them.
delete process.env.SCREENTINKER_DEFER_PLAYERS;

const express = require('express');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');
const { db } = require('../db/database');
const bootDefer = require('../lib/boot-defer');

// ---------------------------------------------------------------------------- the state machine

test('armed: default OFF on an ordinary restart, ON after a migration that touched plays', () => {
  bootDefer.__reset();
  assert.equal(bootDefer.armed({ migrationTouchedPlays: false }), false,
    'a healthy restart must pay for none of this');
  assert.equal(bootDefer.armed({ migrationTouchedPlays: true }), true,
    'the boot after a plays migration is the one with a cold index and a backlog behind it');
});

test('SCREENTINKER_DEFER_PLAYERS forces the decision in both directions', () => {
  bootDefer.__reset();
  process.env.SCREENTINKER_DEFER_PLAYERS = '1';
  assert.equal(bootDefer.armed({ migrationTouchedPlays: false }), true, '=1 must force it on');
  process.env.SCREENTINKER_DEFER_PLAYERS = '0';
  assert.equal(bootDefer.armed({ migrationTouchedPlays: true }), false, '=0 must force it off');
  delete process.env.SCREENTINKER_DEFER_PLAYERS;
});

test('no backlog, no defer — a fresh install never holds off its own players', () => {
  bootDefer.__reset();
  assert.equal(bootDefer.begin({ openPlays: 0 }), false);
  assert.equal(bootDefer.isDeferred(), false);
});

test('the safety valve lifts a defer that never reports idle', () => {
  bootDefer.__reset();
  assert.equal(bootDefer.begin({ openPlays: 494000 }), true);
  assert.equal(bootDefer.isDeferred(), true);

  // Reach back past the ceiling. A fleet held off forever is worse than the stampede this defers,
  // so every exit from the deferred state has to be bounded — including the ones nobody plans for.
  const secretlyOld = Date.now() - bootDefer.MAX_DEFER_MS - 1000;
  bootDefer.__reset();
  bootDefer.begin({ openPlays: 494000 });
  bootDefer.__setSinceForTest(secretlyOld);
  assert.equal(bootDefer.isDeferred(), false, 'the valve must let players back in on its own');
});

// ------------------------------------------------------------------- the gates, over real wires

const app = express();
app.use(express.json());
app.use('/api/status', require('../routes/status'));
const server = http.createServer(app);
const io = new Server(server);
require('../ws/deviceSocket')(io);
server.listen(0);

const BASE = () => `http://127.0.0.1:${server.address().port}`;

function connectPlayer() {
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE()}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    const done = (r) => { try { sock.close(); } catch { /* */ } resolve(r); };
    sock.on('connect', () => done({ connected: true }));
    sock.on('connect_error', (err) => done({ connected: false, message: err.message, data: err.data }));
    setTimeout(() => done({ connected: false, timedOut: true }), 4000);
  });
}

const status = async () => {
  const res = await fetch(`${BASE()}/api/status`);
  return { code: res.status, body: await res.json() };
};

test('DEFERRED: the player socket is refused with 503, and refused outright', async () => {
  bootDefer.__reset();
  bootDefer.begin({ openPlays: 494000 });

  const r = await connectPlayer();
  assert.equal(r.connected, false, 'a player must not be accepted while maintenance is draining');
  assert.ok(!r.timedOut,
    'the connection was accepted and then went quiet — that is the accept-and-stall failure this ' +
    'exists to prevent; a player must be TOLD to go away so it can back off');
  assert.equal(r.data?.status, 503, 'the refusal must carry 503');
  assert.ok(r.data?.reason, 'the refusal must say why');
});

test('DEFERRED: /api/status still answers 200 so the healthcheck does not restart the boot', async () => {
  bootDefer.__reset();
  bootDefer.begin({ openPlays: 494000 });

  const { code, body } = await status();
  assert.equal(code, 200, 'a non-2xx here restarts the container mid-maintenance');
  assert.equal(body.status, 'ok', "compose reads r.ok; the container IS healthy, it just isn't taking players");
  assert.equal(body.maintenance?.deferring_players, true, 'and it must say that plainly');
  assert.ok(body.maintenance.reason, '…and say why');
});

test('LIFTED: players are accepted again and the maintenance block disappears', async () => {
  bootDefer.__reset();
  bootDefer.begin({ openPlays: 494000 });
  bootDefer.lift({ closed: 494000, remaining: 0 });

  const r = await connectPlayer();
  assert.equal(r.connected, true, 'once the sweep is idle the fleet must be able to come back');

  const { code, body } = await status();
  assert.equal(code, 200);
  assert.equal(body.maintenance, undefined,
    "a healthy install's status payload must be byte-identical to 2.0.0's");
});

// --------------------------------------------------------------------- the drain that lifts it

test('the boot drain defers, closes the backlog, and lifts when the sweep is idle', async () => {
  bootDefer.__reset();
  const heartbeat = require('../services/heartbeat');

  // A screen with a backlog of plays nothing will ever close: opened long ago, never ended. This is
  // the shape of the 494k rows, in miniature — no content row, so each expires at the unknown-length
  // ceiling (INFER_UNKNOWN_MAX_SEC) rather than its own duration.
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, role) VALUES ('u-dr','dr@test.local','x','user')").run();
  db.prepare("INSERT OR IGNORE INTO organizations (id, name, owner_user_id) VALUES ('o-dr','org','u-dr')").run();
  db.prepare("INSERT OR IGNORE INTO workspaces (id, organization_id, name) VALUES ('ws-dr','o-dr','ws')").run();
  db.prepare(`INSERT OR IGNORE INTO devices (id, name, workspace_id, user_id, created_at, updated_at)
              VALUES ('d-dr','Screen','ws-dr','u-dr',strftime('%s','now'),strftime('%s','now'))`).run();

  const longAgo = Math.floor(Date.now() / 1000) - (30 * 86400);
  const ins = db.prepare("INSERT INTO play_logs (device_id, started_at, ended_at, content_name) VALUES ('d-dr', ?, NULL, 'x')");
  const many = db.transaction(() => { for (let i = 0; i < 1200; i++) ins.run(longAgo + i); });
  many();

  const openBefore = heartbeat.countOpenPlays();
  assert.ok(openBefore >= 1200, `precondition: a backlog exists (saw ${openBefore})`);

  // Capture the two lines an operator greps for. They are the whole point of the feature being
  // legible: "holding players off" and "players accepted again", with counts on both.
  const lines = [];
  const warn = console.warn, log = console.log;
  console.warn = (...a) => lines.push(a.join(' '));
  console.log = (...a) => lines.push(a.join(' '));
  let closed;
  try {
    closed = await heartbeat.drainStrandedAtBoot();
  } finally {
    console.warn = warn; console.log = log;
  }

  assert.ok(closed >= 1200, `the drain must actually close the backlog (closed ${closed})`);
  assert.equal(heartbeat.countOpenPlays(), 0, 'and drain it to idle');
  assert.equal(bootDefer.isDeferred(), false, 'players must be accepted again once the sweep is idle');

  const started = lines.findIndex((l) => l.includes('[boot-defer] holding players off'));
  const lifted = lines.findIndex((l) => l.includes('[boot-defer] players accepted again'));
  assert.ok(started >= 0, 'one line when the defer starts, with counts');
  assert.ok(lifted > started, 'one line when it lifts, after it');
  assert.match(lines[lifted], /stranded play\(s\) closed/, 'the lift line must report what it closed');
  assert.ok(lines.some((l) => /\[boot\] stranded sweep batch \d+\/\d+ closed=\d+ remaining=\d+ duration=\d+ms/.test(l)),
    'every batch must log batch/closed/remaining/duration — the difference between "building" and "dead"');
});

after(() => { try { io.close(); } catch { /* */ } try { server.close(); } catch { /* */ } });
