'use strict';

// 3.0: a device socket's address honours X-Forwarded-For only through a trusted proxy. The first
// XFF entry used to be believed from anyone, so a device could claim 127.0.0.1 and be treated as
// the host's own player (server-on-a-player framebuffer capture keys on a loopback ip_address).

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-devip-'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ip = require('../ws/deviceSocket').__getClientIp;
const sock = (address, xff) => ({ handshake: { address, headers: xff ? { 'x-forwarded-for': xff } : {} } });

test('a direct connection cannot claim loopback with X-Forwarded-For', () => {
  assert.equal(ip(sock('203.0.113.9', '127.0.0.1')), '203.0.113.9');
});

test('through a trusted local proxy, the forwarded client address is used', () => {
  assert.equal(ip(sock('127.0.0.1', '198.51.100.7')), '198.51.100.7');
  assert.equal(ip(sock('::ffff:127.0.0.1', '198.51.100.7, 10.0.0.2')), '198.51.100.7');
});

test('no header: the peer address', () => {
  assert.equal(ip(sock('192.168.1.40')), '192.168.1.40');
});
