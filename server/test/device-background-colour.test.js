'use strict';

/*
 * #325: a per-device background colour behind letterboxed content.
 *
 * The player's stylesheet hardcoded #000 in several places, so a white-background image that did
 * not fill the frame sat in a black surround and looked like a fault rather than a choice. There
 * was no per-device or per-playlist setting anywhere. This follows the route `orientation` already
 * takes: a column on devices, threaded through the socket payload, applied by the player.
 *
 * NULL means "the player's own default", so a screen that has never been given one is untouched.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
let PORT, BASE, jwt, deviceId;
const DATA_DIR = path.join(os.tmpdir(), 'st-bg-' + crypto.randomBytes(4).toString('hex'));
let proc, db;
const Database = require('better-sqlite3');

const put = (o) => ({ method: 'PUT', headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-bg.log'), 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await new Promise(r => setTimeout(r, 250)); }
  if (!up) throw new Error('server did not boot');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  const email = 'bg' + crypto.randomBytes(4).toString('hex') + '@x.local';
  jwt = (await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Passw0rd123' }) })).json()).token;
  const ws = db.prepare('SELECT id FROM workspaces LIMIT 1').get();
  deviceId = crypto.randomUUID();
  db.prepare("INSERT INTO devices (id, name, workspace_id, status) VALUES (?, ?, ?, 'online')").run(deviceId, 'bg screen', ws.id);
});
after(() => { try { db && db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

const bgOf = () => db.prepare('SELECT background_color FROM devices WHERE id = ?').get(deviceId).background_color;

test('#325: the column exists and starts NULL, so nothing changes for existing screens', () => {
  assert.equal(bgOf(), null);
});

test('#325: a hex colour is stored', async () => {
  const r = await fetch(BASE + '/api/devices/' + deviceId, put({ background_color: '#204060' }));
  assert.equal(r.status, 200);
  assert.equal(bgOf(), '#204060');
});

test('#325: an empty value clears it back to the player default, not to an empty string', async () => {
  await fetch(BASE + '/api/devices/' + deviceId, put({ background_color: '#ffffff' }));
  const r = await fetch(BASE + '/api/devices/' + deviceId, put({ background_color: '' }));
  assert.equal(r.status, 200);
  assert.equal(bgOf(), null, 'cleared to NULL, so the player keeps its own default');
});

test('#325: a value that is not a hex colour is refused', async () => {
  for (const bad of ['red', 'url(x)', 'expression(1)', '#zzz', 'black; background:url(//evil)']) {
    const r = await fetch(BASE + '/api/devices/' + deviceId, put({ background_color: bad }));
    assert.equal(r.status, 400, `${bad} must be refused`);
    assert.match((await r.json()).error, /hex colour/i);
  }
  assert.equal(bgOf(), null, 'and nothing was stored');
});

test('#325: the player applies it, and only when it is a hex value', () => {
  const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  assert.match(player, /data\.background_color/, 'the player reads the field');
  assert.match(player, /\/\^#\[0-9a-fA-F\]\{3,8\}\$\//, 'and validates it before assigning to style');
});

test('#325: it travels in the socket payload like orientation does', () => {
  const ds = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
  assert.match(ds, /background_color: background_color \|\| null/, 'included in the assembled payload');
  assert.match(ds, /background_color: device\?\.background_color \|\| null/, 'read from the device row');
});
