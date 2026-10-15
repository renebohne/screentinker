'use strict';

/*
 * Preview-at-time routes: who may ask, and what a bad question gets.
 *
 * ⚠️ These are READ routes over a screen's whole decision trail — playlist names, schedule titles,
 * group names, what a trigger is called. Reading another tenant's screen through them would be a
 * quiet leak, so each one is asked by the owner, by a viewer (read is allowed), by a stranger, and
 * by nobody. And none of them may write: the scheduler's columns are unchanged afterwards.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { freePort } = require('./helpers/free-port');

let PORT, BASE, proc, db;
const DATA_DIR = path.join(os.tmpdir(), 'st-simroutes-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-simroutes-' + crypto.randomBytes(4).toString('hex') + '.log');

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
});
after(() => { try { db && db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

const jf = async (p, tok) => {
  const r = await fetch(BASE + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} });
  let b = null; try { b = await r.json(); } catch { /* */ }
  return { status: r.status, body: b };
};
const reg = async (email) => (await (await fetch(BASE + '/api/auth/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Passw0rd123' }),
})).json()).token;

test('simulate, payload, timeline and group simulate: owner and viewer read; stranger and anon do not; nothing is written', async () => {
  const emailA = 'a' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const emailB = 'b' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const jwtA = await reg(emailA);
  const jwtB = await reg(emailB);
  assert.ok(jwtA && jwtB, 'both users registered');
  const userA = db.prepare('SELECT id FROM users WHERE email = ?').get(emailA).id;
  const userB = db.prepare('SELECT id FROM users WHERE email = ?').get(emailB).id;
  const wsA = db.prepare("SELECT workspace_id FROM workspace_members WHERE user_id = ? AND role = 'workspace_admin'").get(userA).workspace_id;

  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, status, published_snapshot) VALUES ('sim-pl', ?, ?, 'Secret menu', 'published', '[]')").run(userA, wsA);
  db.prepare("INSERT INTO devices (id, user_id, name, status, workspace_id, playlist_id, playlist_source, reported_timezone) VALUES ('sim-dev', ?, 'D', 'online', ?, 'sim-pl', 'device', 'Europe/Berlin')").run(userA, wsA);
  db.prepare("INSERT INTO device_groups (id, user_id, workspace_id, name) VALUES ('sim-grp', ?, ?, 'G')").run(userA, wsA);
  db.prepare("INSERT INTO device_group_members (device_id, group_id) VALUES ('sim-dev', 'sim-grp')").run();
  db.prepare(`INSERT INTO schedules (id, user_id, device_id, playlist_id, title, start_time, end_time, recurrence, enabled)
              VALUES ('sim-s', ?, 'sim-dev', 'sim-pl', 'Lunch', '2026-01-01T12:00', '2026-01-01T13:00', 'FREQ=DAILY', 1)`).run(userA);
  const colsBefore = db.prepare("SELECT scheduled_playlist_id, scheduled_layout_id FROM devices WHERE id = 'sim-dev'").get();

  const at = encodeURIComponent('2026-11-02T11:30:00Z');   // 12:30 Berlin: Lunch is live
  const urls = [
    `/api/devices/sim-dev/simulate?at=${at}`,
    `/api/devices/sim-dev/simulate/payload?at=${at}`,
    `/api/devices/sim-dev/timeline?from=${at}`,
    `/api/groups/sim-grp/simulate?at=${at}`,
  ];

  for (const u of urls) {
    assert.equal((await jf(u)).status, 401, `anon ${u}`);
    const stranger = await jf(u, jwtB);
    assert.equal(stranger.status, 403, `a user of another workspace reached ${u}`);
    assert.ok(!JSON.stringify(stranger.body || {}).includes('Secret menu'), 'and learned nothing');
    const own = await jf(u, jwtA);
    assert.equal(own.status, 200, `owner ${u}: ${JSON.stringify(own.body)}`);
  }

  const r = await jf(urls[0], jwtA);
  assert.equal(r.body.active_schedule.title, 'Lunch');
  assert.equal(r.body.resolved.playlist_name, 'Secret menu');
  assert.equal(r.body.local.schedule, '2026-11-02T12:30');

  // A viewer may look: this is a read, like the device page itself.
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')").run(wsA, userB);
  for (const u of urls) assert.equal((await jf(u, jwtB)).status, 200, `viewer ${u}`);

  // A preview never moves the live screen.
  assert.deepEqual(db.prepare("SELECT scheduled_playlist_id, scheduled_layout_id FROM devices WHERE id = 'sim-dev'").get(), colsBefore);

  // Missing device / group.
  assert.equal((await jf(`/api/devices/nope/simulate?at=${at}`, jwtA)).status, 404);
  assert.equal((await jf(`/api/groups/nope/simulate?at=${at}`, jwtA)).status, 404);
});

test('bad questions get a 400, not a 500', async () => {
  const email = 'c' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const jwt = await reg(email);
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  const ws = db.prepare("SELECT workspace_id FROM workspace_members WHERE user_id = ? AND role = 'workspace_admin'").get(user).workspace_id;
  db.prepare("INSERT INTO devices (id, user_id, name, status, workspace_id) VALUES ('sim-dev2', ?, 'D2', 'offline', ?)").run(user, ws);
  for (const q of [
    '/simulate?at=yesterday',
    '/simulate?at=2099-01-01T00:00:00Z',
    '/simulate?weather=hail',
    '/simulate?temp_c=hot',
    '/timeline?from=2026-11-01T00:00:00Z&to=2026-11-20T00:00:00Z',
    '/timeline?from=2026-11-02T00:00:00Z&to=2026-11-01T00:00:00Z',
    '/timeline?from=nonsense',
  ]) {
    const r = await jf('/api/devices/sim-dev2' + q, jwt);
    assert.equal(r.status, 400, `${q} answered ${r.status}`);
  }
  const ok = await jf('/api/devices/sim-dev2/timeline', jwt);
  assert.equal(ok.status, 200, 'no range means the next 24 hours');
  assert.equal(Date.parse(ok.body.to) - Date.parse(ok.body.from), 24 * 3600 * 1000);
  const off = await jf('/api/devices/sim-dev2/simulate', jwt);
  assert.equal(off.body.offline, true, 'an offline screen is flagged');
});
