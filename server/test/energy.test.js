'use strict';

/*
 * Energy & carbon (lib/energy, routes/energy.js, docs/energy.md), against a real migrated database.
 *
 *   - interval accounting: hour and local-midnight splits, DST spring/autumn, half-hour zones,
 *     overlapping credits, the elapsed-time cap, the first-sample baseline, offline time;
 *   - classification: panel report > schedule (only when the player can obey it) > display event;
 *   - wattage resolution order and the EU-label formula; carbon resolution order and the maths;
 *   - savings and what-if maths; CSV (formula injection) and the ESG appendix;
 *   - tenancy: another workspace's figures and ids are invisible, viewers are read-only, settings
 *     are admin-only, the org rollup is org-admin-only;
 *   - primary-only sampling (a scale-out copy is never sampled) and retention pruning.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-energy-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { db } = require('../db/database');
const energy = require('../lib/energy');
const iv = require('../lib/energy/intervals');
const wattage = require('../lib/energy/wattage');
const carbon = require('../lib/energy/carbon');
const screenVerify = require('../lib/screen-verify');

const id = (p) => `${p}-${crypto.randomBytes(4).toString('hex')}`;
const H = 3600;
const utc = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000;

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function user(email) {
  const uid = id('u');
  db.prepare('INSERT INTO users (id, email, name) VALUES (?,?,?)').run(uid, email, email.split('@')[0]);
  return uid;
}
function org(ownerId) {
  const oid = id('org');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?,?,?)').run(oid, 'Org ' + oid, ownerId);
  return oid;
}
function workspace(orgId, name, origin = null) {
  const wid = id('ws');
  db.prepare('INSERT INTO workspaces (id, organization_id, name, origin_node_id) VALUES (?,?,?,?)').run(wid, orgId, name, origin);
  return wid;
}
function device(wsId, name, extra = {}) {
  const did = id('d');
  db.prepare(`INSERT INTO devices (id, name, status, workspace_id, timezone, reported_timezone, capabilities, hardware_model, hardware_edid)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(did, name, extra.status || 'online', wsId, extra.timezone || null, extra.reported_timezone || null,
    extra.capabilities === undefined ? JSON.stringify(['display.power_schedule']) : extra.capabilities, extra.model || null, extra.edid || null);
  return did;
}
function group(wsId, ownerId, name, members) {
  const gid = id('g');
  db.prepare('INSERT INTO device_groups (id, user_id, name, workspace_id) VALUES (?,?,?,?)').run(gid, ownerId, name, wsId);
  for (const m of members) db.prepare('INSERT INTO device_group_members (device_id, group_id) VALUES (?,?)').run(m, gid);
  return gid;
}
function powerSchedule(wsId, { deviceId = null, groupId = null, windows, timezone = 'UTC' }) {
  db.prepare('INSERT INTO display_power_schedules (id, workspace_id, device_id, group_id, timezone, windows) VALUES (?,?,?,?,?,?)')
    .run(id('ps'), wsId, deviceId, groupId, timezone, JSON.stringify(windows));
}
function edid({ wCm = 0, hCm = 0, name = null } = {}) {
  const b = Buffer.alloc(128);
  Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]).copy(b, 0);
  b.writeUInt16BE(0x4c2d, 8);   // "SAM"
  b[18] = 1; b[19] = 4; b[21] = wCm; b[22] = hCm;
  if (name) { b[72 + 3] = 0xfc; Buffer.from((name + '\n').padEnd(13, ' ')).copy(b, 72 + 5); }
  return b.toString('base64');
}
const daily = (did) => db.prepare('SELECT * FROM energy_daily WHERE device_id = ? ORDER BY day').all(did);
const hourly = (did) => db.prepare('SELECT * FROM energy_hourly WHERE device_id = ? ORDER BY hour').all(did);
const W = (on, sb = 0.5) => ({ on_watts: on, standby_watts: sb });

beforeEach(() => { energy._resetForTests(); screenVerify._reset(); });

// ---------------------------------------------------------------------------------------------
// Intervals
// ---------------------------------------------------------------------------------------------

test('splitSpan: pieces sum exactly and never cross a UTC hour', () => {
  const p = iv.splitSpan(utc(2026, 5, 1, 9, 50), utc(2026, 5, 1, 11, 10), 'UTC');
  assert.deepEqual(p.map((x) => x.sec), [600, 3600, 600]);
  assert.equal(p.reduce((a, x) => a + x.sec, 0), 80 * 60);
  assert.deepEqual(iv.splitSpan(100, 100, 'UTC'), []);
  assert.deepEqual(iv.splitSpan(200, 100, 'UTC'), []);
});

test('DST: the spring-forward local day in Berlin is 23 hours, the autumn one 25, nothing lost or doubled', () => {
  // Berlin local days 2026-03-29 (23h) and 2026-10-25 (25h).
  const spring = iv.splitSpan(utc(2026, 3, 28, 23), utc(2026, 3, 29, 22), 'Europe/Berlin');
  assert.deepEqual([...new Set(spring.map((x) => x.day))], ['2026-03-29']);
  assert.equal(spring.reduce((a, x) => a + x.sec, 0), 23 * H);
  const autumn = iv.splitSpan(utc(2026, 10, 24, 22), utc(2026, 10, 25, 23), 'Europe/Berlin');
  assert.deepEqual([...new Set(autumn.map((x) => x.day))], ['2026-10-25']);
  assert.equal(autumn.reduce((a, x) => a + x.sec, 0), 25 * H);
  // UTC hour keys stay unique: 25 distinct hours, each credited once.
  assert.equal(new Set(autumn.map((x) => x.hour)).size, 25);
});

test('a half-hour zone splits its local midnight inside a UTC hour', () => {
  const p = iv.splitSpan(utc(2026, 1, 1, 18), utc(2026, 1, 1, 19), 'Asia/Kolkata');
  assert.deepEqual(p.map((x) => [x.day, x.sec]), [['2026-01-01', 1800], ['2026-01-02', 1800]]);
  assert.equal(p[0].hour, p[1].hour);
});

test('an unknown zone buckets in UTC rather than failing', () => {
  const p = iv.splitSpan(utc(2026, 1, 1, 23, 30), utc(2026, 1, 2, 0, 30), 'Not/AZone');
  assert.deepEqual(p.map((x) => x.day), ['2026-01-01', '2026-01-02']);
});

test('hourInWindow matches power-window semantics: overnight anchors to the start day', () => {
  const win = { start: 22, end: 6, days: [5] };   // Friday night only
  assert.equal(iv.hourInWindow({ hour: 23, dow: 5 }, win), true);
  assert.equal(iv.hourInWindow({ hour: 3, dow: 6 }, win), true, 'Saturday 03:00 belongs to Friday night');
  assert.equal(iv.hourInWindow({ hour: 23, dow: 6 }, win), false);
  assert.equal(iv.hourInWindow({ hour: 6, dow: 6 }, win), false, 'end is exclusive');
  assert.equal(iv.hourInWindow({ hour: 12, dow: 2 }, { start: 9, end: 17, days: null }), true);
});

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

test('classify: evidence order', () => {
  const on = { status: 'online' };
  const now = 1_000_000;
  assert.deepEqual(energy.classify({ status: 'offline' }, now, { schedOff: true, scheduleSupported: true }), { state: 'offline', inferred: false });
  assert.deepEqual(energy.classify(on, now, {}), { state: 'on', inferred: true }, 'online with no signal = lit, inferred');
  assert.deepEqual(energy.classify(on, now, { schedOff: true, scheduleSupported: true }), { state: 'sched_off', inferred: true });
  assert.deepEqual(energy.classify(on, now, { schedOff: true, scheduleSupported: false }), { state: 'on', inferred: true },
    'a schedule the player cannot obey darkens nothing');
  assert.deepEqual(energy.classify(on, now, { display: { power: 'off', at: now - 10 } }), { state: 'panel_off', inferred: false });
  assert.deepEqual(energy.classify(on, now, { display: { power: 'off' }, schedOff: true, scheduleSupported: true }), { state: 'sched_off', inferred: false });
  // A fresh panel report beats everything; a stale one is ignored.
  assert.deepEqual(energy.classify(on, now, { panel: { power: 'on', at: now - 60 }, schedOff: true, scheduleSupported: true }), { state: 'on', inferred: false });
  assert.deepEqual(energy.classify(on, now, { panel: { power: 'standby', at: now - 60 } }), { state: 'panel_off', inferred: false });
  assert.deepEqual(energy.classify(on, now, { panel: { power: 'off', at: now - 3600 } }), { state: 'on', inferred: true });
});

// ---------------------------------------------------------------------------------------------
// Credit + sampling
// ---------------------------------------------------------------------------------------------

const F = {};
before(() => {
  F.owner = user('owner@e.test');
  F.org = org(F.owner);
  F.wsA = workspace(F.org, 'Shop A');
  F.wsB = workspace(F.org, 'Shop B');
  F.otherOrg = org(user('other@e.test'));
  F.wsC = workspace(F.otherOrg, 'Elsewhere');
  F.copy = workspace(F.org, 'Copied', 'some-primary');
});

test('credit: splits across hours into both tables; offline time only into the daily one', () => {
  const ws = workspace(F.org, 'credit');
  const d = { id: device(ws, 'c1', { timezone: 'UTC' }), workspace_id: ws, timezone: 'UTC' };
  energy.credit(db, d, 'on', true, utc(2026, 6, 1, 9, 30), utc(2026, 6, 1, 10, 30), W(100));
  energy.credit(db, d, 'offline', false, utc(2026, 6, 1, 10, 30), utc(2026, 6, 1, 11), W(100));
  const h = hourly(d.id);
  assert.deepEqual(h.map((r) => r.on_sec), [1800, 1800]);
  const dd = daily(d.id);
  assert.equal(dd.length, 1);
  assert.equal(dd[0].on_sec, 3600);
  assert.equal(dd[0].offline_sec, 1800);
  assert.equal(dd[0].inferred_sec, 3600);
  assert.equal(dd[0].on_watts, 100);
});

test('overlapping credits for one hour are capped at the hour', () => {
  const ws = workspace(F.org, 'overlap');
  const d = { id: device(ws, 'o1', { timezone: 'UTC' }), workspace_id: ws, timezone: 'UTC' };
  for (let i = 0; i < 3; i++) energy.credit(db, d, 'on', false, utc(2026, 6, 1, 9), utc(2026, 6, 1, 10), W(100));
  assert.equal(hourly(d.id)[0].on_sec, 3600);
});

test('tick: the first sample is a baseline, elapsed time is capped, a copied workspace is never sampled', async () => {
  const ws = workspace(F.org, 'tick');
  const d1 = device(ws, 't-on', { timezone: 'UTC' });
  const d2 = device(ws, 't-off', { status: 'offline', timezone: 'UTC' });
  const copied = device(F.copy, 'copied');
  const t0 = utc(2026, 7, 1, 12) * 1000;
  assert.equal(await energy.tick(t0), 0, 'baseline only');
  assert.equal(daily(d1).length, 0);
  await energy.tick(t0 + 60_000);
  assert.equal(daily(d1)[0].on_sec, 60);
  assert.equal(daily(d2)[0].offline_sec, 60);
  assert.equal(hourly(d2).length, 0, 'offline time is not in the hourly table');
  // A 2-hour stall credits at most MAX_CREDIT_SEC: the rest is a gap, not invented on-time.
  await energy.tick(t0 + 60_000 + 7200_000);
  assert.equal(daily(d1)[0].on_sec, 60 + energy.MAX_CREDIT_SEC);
  assert.equal(daily(copied).length, 0, 'a scale-out copy is sampled by its primary, never here');
});

test('tick: a power schedule darkens a player that can obey it; a display_off is panel_off', async () => {
  const ws = workspace(F.org, 'sched');
  const obeys = device(ws, 'obeys', { timezone: 'UTC' });
  const cannot = device(ws, 'cannot', { timezone: 'UTC', capabilities: JSON.stringify(['playback.image']) });
  const dark = device(ws, 'os-dark', { timezone: 'UTC' });
  for (const d of [obeys, cannot]) powerSchedule(ws, { deviceId: d, windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }] });
  screenVerify.noteDisplayEvent(dark, 'display_off', 'os');
  const t0 = utc(2026, 7, 2, 3) * 1000;
  await energy.tick(t0);
  await energy.tick(t0 + 60_000);
  assert.equal(daily(obeys)[0].sched_off_sec, 60);
  assert.equal(daily(cannot)[0].on_sec, 60);
  assert.equal(daily(dark)[0].panel_off_sec, 60);
  assert.equal(daily(dark)[0].inferred_sec, 0);
});

// ---------------------------------------------------------------------------------------------
// Wattage
// ---------------------------------------------------------------------------------------------

test('EU label formula: inverse of the EEI, and the calibrated default is plausible', () => {
  const a = wattage.areaDm2FromDiagonal(55);
  assert.ok(Math.abs(a - 83.4) < 0.1, `55" 16:9 is ~83.4 dm², got ${a}`);
  const w = wattage.euLabelWatts(a, 1);
  assert.ok(Math.abs(wattage.impliedEei(w, a) - 1) < 0.01);
  assert.ok(wattage.ASSUMED_EEI > 0.6 && wattage.ASSUMED_EEI < 1.6);
  const est = wattage.euLabelWatts(a);
  assert.ok(est > 60 && est < 160, `a 55" signage estimate should be in the datasheet range, got ${est}`);
});

test('wattage resolution order: override > datasheet > EDID size > model size > workspace default > default', () => {
  const base = { hardware_model: null, hardware_edid: null };
  const ov = wattage.resolveWatts({ ...base, hardware_model: 'QM55B' }, { on_watts: 77, standby_watts: 1 }, null);
  assert.deepEqual([ov.source, ov.on_watts, ov.standby_watts], ['override', 77, 1]);
  const ds = wattage.resolveWatts({ ...base, hardware_model: 'LH55QMBEBGCXEN' }, null, null);
  assert.deepEqual([ds.source, ds.on_watts, ds.standby_source], ['datasheet', 108, 'datasheet']);
  assert.match(ds.panel_source_url, /^https:\/\//);
  const byName = wattage.resolveWatts({ ...base, hardware_edid: edid({ wCm: 121, hCm: 68, name: 'QB55B' }) }, null, null);
  assert.equal(byName.source, 'datasheet', 'the EDID monitor name finds the panel');
  const size = wattage.resolveWatts({ ...base, hardware_edid: edid({ wCm: 95, hCm: 54 }) }, null, null);
  assert.equal(size.source, 'size');
  assert.equal(size.diagonal_in, 43);
  const nonsense = wattage.resolveWatts({ ...base, hardware_edid: edid({ wCm: 16, hCm: 9 }), hardware_model: 'XY65Z' }, null, null);
  assert.notEqual(nonsense.source, 'size', 'a 16x9 "cm" EDID is an aspect ratio, not a size');
  const model = wattage.resolveWatts({ ...base, hardware_model: '86UL3J-B' }, null, null);
  assert.deepEqual([model.source, model.diagonal_in], ['size', 86]);
  const wsd = wattage.resolveWatts({ ...base, hardware_model: 'AFTKA' }, null, { default_on_watts: 42, default_standby_watts: 2 });
  assert.deepEqual([wsd.source, wsd.on_watts, wsd.standby_watts], ['workspace_default', 42, 2]);
  const def = wattage.resolveWatts({ ...base, hardware_model: 'AFTKA' }, null, null);
  assert.deepEqual([def.source, def.diagonal_in, def.standby_watts], ['default', 55, 0.5]);
  // Standby can never exceed on-power: savings must not go negative.
  assert.equal(wattage.resolveWatts(base, null, { default_on_watts: 1, default_standby_watts: 5 }).standby_watts, 1);
  // A typo'd override is ignored, not believed.
  assert.notEqual(wattage.resolveWatts(base, { on_watts: 99999 }, null).source, 'override');
});

test('every curated panel cites a source and states what kind of figure it is', () => {
  const panels = require('../lib/energy/panels.json').panels;
  assert.ok(panels.length >= 20);
  for (const p of panels) {
    assert.match(p.source_url, /^https:\/\//, p.model);
    assert.ok(['typical', 'eu_label', 'max'].includes(p.figure), p.model);
    assert.ok(p.on_watts > 0 && p.diagonal_in > 0, p.model);
  }
});

// ---------------------------------------------------------------------------------------------
// Carbon
// ---------------------------------------------------------------------------------------------

test('carbon resolution order and maths', () => {
  const de = carbon.resolveIntensity({ deviceCountry: 'FR', deviceTz: 'Europe/Berlin', wsSettings: { grid_g_per_kwh: 5, country: 'PL' } });
  assert.equal(de.source, 'device_country');
  assert.equal(carbon.resolveIntensity({ deviceTz: 'Europe/Berlin', wsSettings: { grid_g_per_kwh: 5, country: 'PL' } }).source, 'workspace_override');
  const tz = carbon.resolveIntensity({ deviceTz: 'Europe/Berlin', wsSettings: { country: 'PL' } });
  assert.deepEqual([tz.source, tz.country], ['timezone', 'DE']);
  assert.equal(carbon.resolveIntensity({ deviceTz: 'Etc/GMT+3', wsSettings: { country: 'PL' } }).source, 'workspace_country');
  const w = carbon.resolveIntensity({});
  assert.equal(w.source, 'world');
  assert.ok(w.g_per_kwh > 300 && w.g_per_kwh < 600);
  assert.equal(carbon.kgCo2e(1000, 400), 400);
  assert.equal(carbon.isCountry('XX'), false);
  const src = require('../lib/energy/grid-intensity.json').source;
  assert.match(src.url, /^https:\/\//);
  assert.ok(src.year >= 2023);
});

// ---------------------------------------------------------------------------------------------
// Report, savings, what-if
// ---------------------------------------------------------------------------------------------

test('report: kWh, CO2e and schedule savings from known watts, scoped to the workspace', () => {
  const ws = workspace(F.org, 'report');
  energy.saveSettings(db, ws, { country: null, grid_g_per_kwh: 500, default_on_watts: null, default_standby_watts: null }, F.owner);
  const d = device(ws, 'lobby', { timezone: 'UTC' });
  energy.saveOverride(db, ws, [d], { on_watts: 100, standby_watts: 1, country: null }, F.owner);
  const dev = { id: d, workspace_id: ws, timezone: 'UTC' };
  // 10 h lit, 14 h off by schedule on one day.
  energy.credit(db, dev, 'on', false, utc(2026, 8, 3, 8), utc(2026, 8, 3, 18), W(100, 1));
  energy.credit(db, dev, 'sched_off', false, utc(2026, 8, 3, 18), utc(2026, 8, 4, 8), W(100, 1));
  const r = energy.report(db, ws, { start: '2026-08-03', end: '2026-08-03' });
  // lit: 10 h × 100 W = 1 kWh; standby: 14 h × 1 W (only the part on 08-03: 6 h) = 0.006 kWh
  assert.equal(r.totals.kwh_on, 1);
  assert.equal(r.totals.kwh_standby, 0.01);
  assert.equal(r.totals.kg_co2e, 0.5);
  // savings: 6 h × (100 − 1) W = 0.594 kWh
  assert.equal(r.totals.saved_kwh, 0.59);
  assert.equal(r.by_device[0].watts_source, 'override');
  assert.equal(r.by_day.length, 1);
  const two = energy.report(db, ws, { start: '2026-08-03', end: '2026-08-04' });
  assert.equal(two.totals.saved_kwh, Math.round(14 * 99 / 1000 * 100) / 100);
  // Another workspace sees none of it.
  assert.equal(energy.report(db, F.wsC, { start: '2026-08-03', end: '2026-08-04' }).totals.screens, 0);
});

test('a screen moved to another workspace leaves its history where it happened', () => {
  const wsOld = workspace(F.org, 'old'), wsNew = workspace(F.org, 'new');
  const d = device(wsOld, 'mover', { timezone: 'UTC' });
  energy.credit(db, { id: d, workspace_id: wsOld, timezone: 'UTC' }, 'on', false, utc(2026, 8, 5, 8), utc(2026, 8, 5, 9), W(100));
  db.prepare('UPDATE devices SET workspace_id = ? WHERE id = ?').run(wsNew, d);
  energy.credit(db, { id: d, workspace_id: wsNew, timezone: 'UTC' }, 'on', false, utc(2026, 8, 5, 9), utc(2026, 8, 5, 11), W(100));
  assert.equal(energy.report(db, wsOld, { start: '2026-08-05', end: '2026-08-05' }).totals.on_hours, 1);
  assert.equal(energy.report(db, wsNew, { start: '2026-08-05', end: '2026-08-05' }).totals.on_hours, 2);
  const oldRow = energy.report(db, wsOld, { start: '2026-08-05', end: '2026-08-05' }).by_device[0];
  assert.equal(oldRow.removed, true, 'no longer in this workspace: shown as removed, with its snapshot watts');
  assert.equal(oldRow.on_watts, 100);
});

test('what-if: lit hours inside the window, scaled to a year, grouped by the schedule group', () => {
  const ws = workspace(F.org, 'whatif');
  const a = device(ws, 'lobby-1', { timezone: 'UTC' });
  const b = device(ws, 'lobby-2', { timezone: 'UTC' });
  const solo = device(ws, 'kiosk', { timezone: 'UTC' });
  group(ws, F.owner, 'Lobby', [a, b]);
  energy.saveOverride(db, ws, [a, b, solo], { on_watts: 101, standby_watts: 1, country: null }, F.owner);
  const now = utc(2026, 9, 29, 0) * 1000;
  // 28 days: lobby screens lit 24 h; the kiosk lit 08-18 only (never in 22-06).
  for (let day = 1; day <= 28; day++) {
    const start = utc(2026, 9, day, 0);
    for (const d of [a, b]) energy.credit(db, { id: d, workspace_id: ws, timezone: 'UTC' }, 'on', false, start, start + 24 * H, W(101, 1));
    energy.credit(db, { id: solo, workspace_id: ws, timezone: 'UTC' }, 'on', false, start + 8 * H, start + 18 * H, W(101, 1));
  }
  const r = energy.suggestions(db, ws, { start: 22, end: 6, nowMs: now });
  assert.equal(r.suggestions.length, 1, 'the kiosk is already dark at night');
  const s = r.suggestions[0];
  assert.equal(s.name, 'Lobby');
  assert.equal(s.devices.length, 2);
  // 8 h/night × 28 nights over 28 days → 8 h/day × 365 × 100 W net × 2 screens = 584 kWh
  assert.ok(Math.abs(s.kwh_per_year - 584) < 1, `expected ~584, got ${s.kwh_per_year}`);
  assert.ok(Math.abs(s.lit_hours_per_week - 112) < 1);
  const daytime = energy.suggestions(db, ws, { start: 9, end: 17, nowMs: now });
  assert.equal(daytime.suggestions.length, 2);
});

test('retention: hourly rows go after 35 days, daily after 400', async () => {
  const ws = workspace(F.org, 'prune');
  const d = { id: device(ws, 'p', { timezone: 'UTC' }), workspace_id: ws, timezone: 'UTC' };
  const now = utc(2026, 10, 1, 12) * 1000;
  energy.credit(db, d, 'on', false, utc(2026, 8, 1, 8), utc(2026, 8, 1, 9), W(50));    // 61 days ago
  energy.credit(db, d, 'on', false, utc(2025, 8, 1, 8), utc(2025, 8, 1, 9), W(50));    // > 400 days ago
  energy.credit(db, d, 'on', false, utc(2026, 9, 30, 8), utc(2026, 9, 30, 9), W(50));  // yesterday
  await energy.prune(now);
  assert.deepEqual(hourly(d.id).map((r) => r.hour), [utc(2026, 9, 30, 8)]);
  assert.deepEqual(daily(d.id).map((r) => r.day), ['2026-08-01', '2026-09-30']);
});

test('the location zone ignores an OS-default reported zone (Pi reports Europe/London from anywhere)', () => {
  const ws = workspace(F.org, 'zones');
  device(ws, 'pi', { reported_timezone: 'Europe/London' });
  device(ws, 'paris', { reported_timezone: 'Europe/Paris' });
  const list = energy.deviceList(db, ws);
  assert.equal(list.find((x) => x.name === 'pi').intensity_source, 'world');
  assert.deepEqual([list.find((x) => x.name === 'paris').intensity_source, list.find((x) => x.name === 'paris').country], ['timezone', 'FR']);
});

// ---------------------------------------------------------------------------------------------
// HTTP: tenancy, roles, CSV
// ---------------------------------------------------------------------------------------------

let server, base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: req.headers['x-user'] || F.owner, role: 'user' };
    req.workspaceId = req.headers['x-ws'];
    req.workspaceRole = req.headers['x-role'] || null;
    req.orgRole = req.headers['x-org-role'] || null;
    req.organizationId = req.headers['x-org'] || null;
    req.actingAs = false; req.isPlatformAdmin = false; req.isPlatformStaff = false;
    next();
  });
  app.use('/api/energy', require('../routes/energy'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

async function call(method, url, { ws = F.wsA, role = 'workspace_admin', orgRole = null, orgId = null, body } = {}) {
  const headers = { 'x-ws': ws || '', 'x-role': role || '', 'x-org-role': orgRole || '', 'x-org': orgId || '' };
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: r.status, json, text, headers: r.headers };
}

test('HTTP: report needs a workspace; bad dates are a 400, not an empty 200', async () => {
  assert.equal((await call('GET', '/api/energy/report', { ws: '' })).status, 403);
  assert.equal((await call('GET', '/api/energy/report?start=2026-13-40&end=2026-01-01')).status, 400);
  assert.equal((await call('GET', '/api/energy/report?start=2026-02-01&end=2026-01-01')).status, 400);
  assert.equal((await call('GET', '/api/energy/report?start=2020-01-01&end=2026-01-01')).status, 400);
  const ok = await call('GET', '/api/energy/report?start=2026-01-01&end=2026-01-31', { role: 'workspace_viewer' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.can_write, false);
});

test('HTTP: a viewer cannot write; an editor sets watts; only an admin changes settings', async () => {
  const d = device(F.wsA, 'http-screen');
  const v = await call('PUT', `/api/energy/devices/${d}`, { role: 'workspace_viewer', body: { on_watts: 50 } });
  assert.equal(v.status, 403);
  const e = await call('PUT', `/api/energy/devices/${d}`, { role: 'workspace_editor', body: { on_watts: 50, standby_watts: 0.3 } });
  assert.equal(e.status, 200);
  assert.equal(e.json.device.source, 'override');
  assert.equal((await call('PUT', `/api/energy/devices/${d}`, { role: 'workspace_editor', body: { on_watts: -4 } })).status, 400);
  assert.equal((await call('PUT', `/api/energy/devices/${d}`, { role: 'workspace_editor', body: { on_watts: 10, standby_watts: 20 } })).status, 400);
  assert.equal((await call('PUT', '/api/energy/settings', { role: 'workspace_editor', body: { country: 'DE' } })).status, 403);
  assert.equal((await call('PUT', '/api/energy/settings', { role: 'workspace_viewer', body: { country: 'DE' } })).status, 403);
  assert.equal((await call('PUT', '/api/energy/settings', { body: { country: 'ZZ' } })).status, 400);
  const ok = await call('PUT', '/api/energy/settings', { body: { country: 'de', grid_g_per_kwh: 300 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.settings.country, 'DE');
  const s = await call('GET', '/api/energy/settings', { role: 'workspace_viewer' });
  assert.equal(s.json.settings.grid_g_per_kwh, 300);
  assert.ok(s.json.countries.length > 20);
});

test('HTTP: another workspace\'s screen or group is a 404, and a group bulk only touches its own members', async () => {
  const foreign = device(F.wsC, 'foreign');
  assert.equal((await call('PUT', `/api/energy/devices/${foreign}`, { body: { on_watts: 50 } })).status, 404);
  assert.equal((await call('PUT', '/api/energy/devices/nope', { body: { on_watts: 50 } })).status, 404);
  const fg = group(F.wsC, F.owner, 'Theirs', [foreign]);
  assert.equal((await call('PUT', `/api/energy/groups/${fg}`, { body: { on_watts: 50 } })).status, 404);
  // A group in A that (by a corrupt membership row) lists a screen of C: only A's screens are written.
  const mine = device(F.wsA, 'mine');
  const g = group(F.wsA, F.owner, 'Mixed', [mine, foreign]);
  const r = await call('PUT', `/api/energy/groups/${g}`, { role: 'workspace_editor', body: { on_watts: 60 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.screens, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM energy_device_settings WHERE device_id = ?').get(foreign).n, 0);
});

test('HTTP: CSV export escapes formula-looking names and carries a total row', async () => {
  const d = device(F.wsB, '=HYPERLINK("http://evil")', { timezone: 'UTC' });
  energy.credit(db, { id: d, workspace_id: F.wsB, timezone: 'UTC' }, 'on', false, utc(2026, 8, 10, 8), utc(2026, 8, 10, 12), W(100));
  const r = await call('GET', '/api/energy/export?start=2026-08-10&end=2026-08-10', { ws: F.wsB });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.text, /"'=HYPERLINK\(""http:\/\/evil""\)"/);
  assert.match(r.text, /"Total"/);
  const byDay = await call('GET', '/api/energy/export?start=2026-08-10&end=2026-08-10&by=day', { ws: F.wsB });
  assert.match(byDay.text, /^Date,kWh/);
  assert.match(byDay.text, /"2026-08-10",0\.4/);
  const app = await call('GET', '/api/energy/appendix?start=2026-08-10&end=2026-08-10', { ws: F.wsB });
  assert.match(app.headers.get('content-type'), /text\/plain/);
  assert.match(app.text, /ESTIMATES, not metered/);
  assert.match(app.text, /2019\/2013/);
  assert.match(app.text, /Ember/);
});

test('HTTP: the org rollup is for org admins of the active workspace\'s organization only', async () => {
  assert.equal((await call('GET', '/api/energy/org', { role: 'workspace_admin' })).status, 403);
  const r = await call('GET', '/api/energy/org?start=2026-08-01&end=2026-08-31', { orgRole: 'org_admin', orgId: F.org });
  assert.equal(r.status, 200);
  const names = r.json.workspaces.map((w) => w.name);
  assert.ok(names.includes('Shop A') && names.includes('Shop B'));
  assert.ok(!names.includes('Elsewhere'), 'another organization never appears');
  const csv = await call('GET', '/api/energy/org/export?start=2026-08-01&end=2026-08-31', { orgRole: 'org_owner', orgId: F.org });
  assert.match(csv.text, /^Workspace,Screens/);
});

test('HTTP: suggestions validate the window; glance answers for the Simple view', async () => {
  assert.equal((await call('GET', '/api/energy/suggestions?start=25&end=6')).status, 400);
  assert.equal((await call('GET', '/api/energy/suggestions?start=6&end=6')).status, 400);
  assert.equal((await call('GET', '/api/energy/suggestions?days=9')).status, 400);
  assert.equal((await call('GET', '/api/energy/suggestions?start=22&end=6&days=1,2,3,4,5')).status, 200);
  const g = await call('GET', '/api/energy/glance', { role: 'workspace_viewer' });
  assert.equal(g.status, 200);
  assert.ok('kwh' in g.json && 'saved_kwh' in g.json);
});

test('the sampler is started from server.js and scoped with LOCAL_ROWS_SQL', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'energy', 'index.js'), 'utf8');
  assert.match(src, /LOCAL_ROWS_SQL\('d'\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /require\('\.\/lib\/energy'\)\.start\(\)/);
});
