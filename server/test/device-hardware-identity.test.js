'use strict';

// Hardware identity — model, OS build, serial, which output — is reported by the panel and had
// nowhere to live: the devices row carried only `platform`. A BrightSign knows all four, and an
// operator looking at a dead screen wants the serial and the model, not a guess.
//
// The reason this is a SEPARATE writer rather than four more fields in applyDeviceInfo: that
// function is a blind full-row overwrite, and an empty device_info once nulled seventeen columns
// every five minutes because `{}` is truthy. These fields arrive only on a full register, so the
// same shape would wipe them on every lightweight refresh in between. COALESCE is what makes
// "no news" mean "unchanged" instead of "gone" — which is the property these tests pin down.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-hw-identity-'));
process.env.DATA_DIR = tmp;

const { db } = require('../db/database');
const { __applyHardwareIdentity: applyHardwareIdentity } = require('../ws/deviceSocket');

let n = 0;
function mkDevice() {
  const id = 'dev-hw-' + (++n);
  db.prepare("INSERT INTO devices (id,name,status,created_at) VALUES (?,?,'offline',strftime('%s','now'))")
    .run(id, 'HW ' + n);
  return id;
}
const row = (id) => db.prepare('SELECT * FROM devices WHERE id = ?').get(id);

test('the schema carries hardware identity and a temperature column', () => {
  const dev = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name);
  for (const c of ['hardware_model', 'hardware_serial', 'hardware_os_version', 'output_index']) {
    assert.ok(dev.includes(c), `devices.${c} missing`);
  }
  const tel = db.prepare('PRAGMA table_info(device_telemetry)').all().map((c) => c.name);
  assert.ok(tel.includes('temperature_c'), 'device_telemetry.temperature_c missing');
  assert.ok(tel.includes('humidity'), 'device_telemetry.humidity missing');
});

test('top-level bs_* fields are persisted — that is how the player reports them today', () => {
  const id = mkDevice();
  applyHardwareIdentity(id, {
    bs_model: 'XT245', bs_serial: 'URD3C6000823', bs_os_version: '9.0.189', bs_screen: 1,
  });
  const r = row(id);
  assert.equal(r.hardware_model, 'XT245');
  assert.equal(r.hardware_serial, 'URD3C6000823');
  assert.equal(r.hardware_os_version, '9.0.189');
});

test('device_info is read too, so the client can move without a flag day', () => {
  const id = mkDevice();
  applyHardwareIdentity(id, {
    device_info: { hardware_model: 'XC4055', hardware_serial: 'SN-XC', hardware_os_version: '9.1.5', output_index: 3 },
  });
  const r = row(id);
  assert.equal(r.hardware_model, 'XC4055');
  assert.equal(r.output_index, 3);
});

test('THE WIPE THIS GUARDS: a later report without the fields leaves them intact', () => {
  const id = mkDevice();
  applyHardwareIdentity(id, { bs_model: 'XT245', bs_serial: 'SN-KEEP', bs_os_version: '9.0.189' });
  // A subsequent register from a client that says nothing about hardware — the shape that nulled
  // seventeen columns when it went through the blind-overwrite path.
  applyHardwareIdentity(id, { device_info: {} });
  applyHardwareIdentity(id, {});
  const r = row(id);
  assert.equal(r.hardware_model, 'XT245', 'silence must not read as "the model is gone"');
  assert.equal(r.hardware_serial, 'SN-KEEP');
  assert.equal(r.hardware_os_version, '9.0.189');
});

test('a genuine change still overwrites — COALESCE must not freeze the value', () => {
  const id = mkDevice();
  applyHardwareIdentity(id, { bs_model: 'XT245' });
  applyHardwareIdentity(id, { bs_model: 'XC2055' });
  assert.equal(row(id).hardware_model, 'XC2055');
});

test('a player that reports none of it is not written at all', () => {
  const id = mkDevice();
  const before = row(id).updated_at;
  applyHardwareIdentity(id, { device_info: { app_version: '1.1.0-web' } });
  const r = row(id);
  assert.equal(r.hardware_model, null);
  assert.equal(r.hardware_serial, null);
  assert.equal(r.updated_at, before, 'an Android/browser register should not touch the row here');
});

test('output_index only accepts a positive integer', () => {
  const id = mkDevice();
  // screen() returns 1 for a single-output player; 0 / negative / "2" are not outputs.
  for (const bad of [0, -1, '2', 1.5, null, undefined]) {
    applyHardwareIdentity(id, { bs_model: 'X', bs_screen: bad });
    assert.equal(row(id).output_index, null, `output_index accepted ${JSON.stringify(bad)}`);
  }
  applyHardwareIdentity(id, { bs_screen: 2 });
  assert.equal(row(id).output_index, 2);
});

test('device-supplied strings are trimmed and capped', () => {
  const id = mkDevice();
  applyHardwareIdentity(id, { bs_model: '  XT245  ', bs_serial: 'S'.repeat(200) });
  const r = row(id);
  assert.equal(r.hardware_model, 'XT245');
  assert.equal(r.hardware_serial.length, 64, 'these render in the dashboard — cap them');
});

test('a whitespace-only value is not an answer', () => {
  const id = mkDevice();
  applyHardwareIdentity(id, { bs_model: 'XT245' });
  applyHardwareIdentity(id, { bs_model: '   ' });
  assert.equal(row(id).hardware_model, 'XT245');
});
