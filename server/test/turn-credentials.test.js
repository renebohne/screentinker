'use strict';

/*
 * Short-lived TURN credentials (GO2RTC_TURN_SECRET): every hand-out of ICE servers mints its own
 * username/password in the TURN REST scheme coturn's use-auth-secret checks, so a guest who once
 * started a share does not keep a working relay login. Without a secret, the fixed user/password
 * (or none) is handed out exactly as before.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const config = require('../config');
const go2rtc = require('../lib/go2rtc');

function withConfig(over, fn) {
  const saved = {};
  for (const k of Object.keys(over)) { saved[k] = config[k]; config[k] = over[k]; }
  try { return fn(); } finally { Object.assign(config, saved); }
}

test('credentials follow the TURN REST scheme coturn verifies', () => {
  const now = Date.UTC(2026, 9, 15, 12, 0, 0);
  const c = go2rtc.turnCredentials('s3cret', 3600, now);
  assert.equal(c.username, `${now / 1000 + 3600}:screentinker`);
  assert.equal(c.credential, crypto.createHmac('sha1', 's3cret').update(c.username).digest('base64'));
});

test('with a secret: fresh, expiring credentials on every hand-out; the fixed password is never sent', () => {
  withConfig({ go2rtcStunUrls: ['stun:stun.example:3478'], go2rtcTurnUrl: 'turn:203.0.113.5:3478?transport=udp, turn:203.0.113.5:3478?transport=tcp',
    go2rtcTurnSecret: 'shh', go2rtcTurnTtl: 3600, go2rtcTurnUser: 'fixed', go2rtcTurnPass: 'fixedpass' }, () => {
    const ice = go2rtc.iceServers();
    assert.deepEqual(ice[0], { urls: 'stun:stun.example:3478' });
    const turn = ice[1];
    assert.deepEqual(turn.urls, ['turn:203.0.113.5:3478?transport=udp', 'turn:203.0.113.5:3478?transport=tcp']);
    const expiry = Number(turn.username.split(':')[0]);
    const nowSec = Math.floor(Date.now() / 1000);
    assert.ok(expiry > nowSec + 3500 && expiry <= nowSec + 3601, 'expires after the TTL');
    assert.notEqual(turn.credential, 'fixedpass');
    assert.ok(!JSON.stringify(ice).includes('fixedpass') && !JSON.stringify(ice).includes('shh'), 'neither the fixed password nor the secret leaves the server');
  });
});

test('without a secret: the fixed user/password as before, and one URL stays a string', () => {
  withConfig({ go2rtcStunUrls: [], go2rtcTurnUrl: 'turn:turn.example:3478', go2rtcTurnSecret: null, go2rtcTurnUser: 'u', go2rtcTurnPass: 'p' }, () => {
    assert.deepEqual(go2rtc.iceServers(), [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'p' }]);
  });
  withConfig({ go2rtcStunUrls: [], go2rtcTurnUrl: null, go2rtcTurnSecret: 'shh' }, () => {
    assert.deepEqual(go2rtc.iceServers(), [], 'no TURN URL: no TURN entry, secret or not');
  });
});
