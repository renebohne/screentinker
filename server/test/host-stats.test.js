'use strict';

// 3.0 Platform → Overview "This server": lib/host-stats.js and GET /api/admin/host.
//   - CPU is busy share between two readings, clamped, null when nothing elapsed;
//   - every reading is a number or null (never a made-up 0), with low-disk / low-memory warnings;
//   - the route is for platform admins only.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-hoststats-'));
process.env.DATA_DIR = TMP;
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db/database');
const { generateToken, requireAuth } = require('../middleware/auth');
const hostStats = require('../lib/host-stats');

let server, base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', requireAuth, require('../routes/admin'));  // as server.js mounts it
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
});
after(() => new Promise((r) => server.close(r)));

function makeUser(role) {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO users (id, email, password_hash, auth_provider, role, email_verified) VALUES (?,?,?,'local',?,1)")
    .run(id, `h${crypto.randomBytes(4).toString('hex')}@x.local`, bcrypt.hashSync('x', 4), role);
  return db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
}

test('CPU percentage between two readings', () => {
  assert.equal(hostStats._pctBetween({ idle: 100, total: 200 }, { idle: 150, total: 400 }), 75);
  assert.equal(hostStats._pctBetween({ idle: 100, total: 200 }, { idle: 300, total: 400 }), 0);
  assert.equal(hostStats._pctBetween({ idle: 100, total: 200 }, { idle: 100, total: 200 }), null, 'no time passed');
});

test('a reading: numbers or null, the data disk, warnings as a list', async () => {
  hostStats._reset();
  const s = await hostStats.sample();
  assert.ok(s.cpu.pct === null || (s.cpu.pct >= 0 && s.cpu.pct <= 100));
  assert.ok(s.cpu.cores > 0);
  assert.ok(s.memory.total > 0);
  assert.ok(s.memory.available === null || (s.memory.available > 0 && s.memory.available <= s.memory.total));
  assert.equal(s.disks[0].role, 'data');
  assert.ok(s.disks[0].total > 0 && s.disks[0].free >= 0);
  assert.ok(Array.isArray(s.warnings));
});

test('GET /api/admin/host: platform admins only', async () => {
  const admin = makeUser('platform_admin');
  const user = makeUser('user');
  const ok = await fetch(`${base}/host`, { headers: { Authorization: `Bearer ${generateToken(admin, null)}` } });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.ok(body.cpu && body.memory && Array.isArray(body.disks));
  const no = await fetch(`${base}/host`, { headers: { Authorization: `Bearer ${generateToken(user, null)}` } });
  assert.equal(no.status, 403);
  const anon = await fetch(`${base}/host`);
  assert.equal(anon.status, 401);
});

test('GET /api/admin/overview carries the disk/memory warnings for "Needs your attention"', async () => {
  const admin = makeUser('platform_admin');
  const r = await fetch(`${base}/overview`, { headers: { Authorization: `Bearer ${generateToken(admin, null)}` } });
  assert.equal(r.status, 200);
  const o = await r.json();
  assert.ok(Array.isArray(o.host_warnings));
  for (const w of o.host_warnings) assert.ok(['disk_low', 'mem_low'].includes(w.kind));
  assert.deepEqual(hostStats.warningsNow().map((w) => w.kind).sort(), o.host_warnings.map((w) => w.kind).sort());
});
