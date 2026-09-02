'use strict';

/*
 * #316: a clock widget's timezone must be a real zone, checked when it is saved.
 *
 * The old guard tested the string against a character class, which answers neither question a
 * timezone field has. A Spanish operator hit both failure modes in one sitting:
 *
 *   "España" -> the 'ñ' fails the character class -> silently replaced with UTC -> the clock ran
 *               two hours behind with nothing anywhere explaining why.
 *   "Spain"  -> passes the character class, is not a zone -> toLocaleTimeString throws RangeError
 *   "GMT+2"  -> inside the generated widget script -> the clock rendered NOTHING at all.
 *
 * Both are now refused at save time with a message naming the right format. The render-time
 * fallback stays (a wrong clock beats a blank one for configs already stored), but nothing new
 * can reach it.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
let PORT, BASE, jwt;
const DATA_DIR = path.join(os.tmpdir(), 'st-wtz-' + crypto.randomBytes(4).toString('hex'));
let proc;

const post = (t, o) => ({ method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const put = (t, o) => ({ method: 'PUT', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

const mk = (timezone) => post(jwt, { widget_type: 'clock', name: 'clock ' + crypto.randomBytes(3).toString('hex'), config: { timezone, format: '24h' } });

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-wtz.log'), 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await new Promise(r => setTimeout(r, 250)); }
  if (!up) throw new Error('server did not boot');
  const email = 'w' + crypto.randomBytes(4).toString('hex') + '@x.local';
  jwt = (await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Passw0rd123' }) })).json()).token;
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

test('#316: a country name is refused, not silently turned into UTC', async () => {
  for (const bad of ['España', 'Spain', 'Espagne']) {
    const r = await fetch(BASE + '/api/widgets', mk(bad));
    assert.equal(r.status, 400, `${bad} must be refused`);
    const body = await r.json();
    assert.match(body.error, /not a time zone/i);
    assert.match(body.error, /Europe\/Madrid/, 'the message shows the right shape');
  }
});

test('#316: a GMT offset is refused (it is not an IANA zone)', async () => {
  const r = await fetch(BASE + '/api/widgets', mk('GMT+2'));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /not a time zone/i);
});

test('real IANA zones are accepted', async () => {
  for (const good of ['Europe/Madrid', 'America/New_York', 'UTC', 'Etc/GMT-2', 'Australia/Sydney']) {
    const r = await fetch(BASE + '/api/widgets', mk(good));
    assert.equal(r.status, 201, `${good} must be accepted`);
  }
});

test('an absent or empty timezone is still fine (falls back to UTC as before)', async () => {
  assert.equal((await fetch(BASE + '/api/widgets', mk(undefined))).status, 201);
  assert.equal((await fetch(BASE + '/api/widgets', mk(''))).status, 201);
});

test('a quote cannot reach the generated widget script', async () => {
  // The value is interpolated into single-quoted JS in the render path.
  const r = await fetch(BASE + '/api/widgets', mk("UTC'; alert(1); '"));
  assert.equal(r.status, 400, 'quote-bearing value refused');
});

test('editing a widget is gated too, not just creating one', async () => {
  const created = await (await fetch(BASE + '/api/widgets', mk('Europe/Madrid'))).json();
  const bad = await fetch(BASE + '/api/widgets/' + created.id, put(jwt, { config: { timezone: 'Spain', format: '24h' } }));
  assert.equal(bad.status, 400, 'PUT must validate as POST does');
  const good = await fetch(BASE + '/api/widgets/' + created.id, put(jwt, { config: { timezone: 'Europe/Berlin', format: '24h' } }));
  assert.equal(good.status, 200);
});

test('the rendered clock carries the zone that was saved', async () => {
  const w = await (await fetch(BASE + '/api/widgets', mk('Europe/Madrid'))).json();
  const html = await (await fetch(BASE + '/api/widgets/' + w.id + '/render')).text();
  assert.match(html, /timeZone: 'Europe\/Madrid'/, 'the saved zone reaches the generated script');
  assert.doesNotMatch(html, /timeZone: 'UTC'/, 'not quietly replaced');
});
