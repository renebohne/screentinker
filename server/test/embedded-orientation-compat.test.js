'use strict';

/*
 * Existing embedded panels render exactly as they did before reTerminal E-Series support, unless
 * they opt in by stating an orientation (#638 review).
 *
 * The regressions this pins, each measured against main (1e094530) with the same source image:
 *   - devices.orientation is 'landscape' on EVERY row by schema default, and was read as the panel's
 *     choice: a portrait custom profile came out landscape and a profile's own rotation was wiped;
 *   - server-side rotation 90/270 was replaced by "the MCU transposes" for every profile, not only
 *     for the firmware that does;
 *   - odd-width 1-bit profiles were refused.
 * The SHA-256 prefixes below are main's bytes for these profiles (scratch script, real schema,
 * the helper's 64x48 test image). Real schema throughout: db/database.js on a temp DATA_DIR.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const deviceNs = { adapter: { rooms: new Map() }, to: () => ({ emit() {} }) };
const h = require('./helpers/embedded-real-db').boot({
  configure(app) {
    app.set('io', { of: (n) => (n === '/device' ? deviceNs : { to: () => ({ emit() {} }) }) });
    const { requireAuth } = require('../middleware/auth');
    app.use('/api/devices', requireAuth, require('../routes/devices'));
  },
});
const { parseProfile } = require('../lib/embedded-profiles');

after(() => h.close());

const sha16 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
async function render(base, p, headers = {}, qs = '') {
  const res = await fetch(`${base}/render?device_id=${p.id}${qs}`, { headers: { Authorization: `Bearer ${p.token}`, ...headers } });
  const body = Buffer.from(await res.arrayBuffer());
  return { res, body };
}

// main's bytes, per stored profile
const MAIN = {
  'seeed-reterminal-sticky': [48000, 'f56c40d907b3eb5c'],
  'waveshare-7.5in-v2': [48000, 'f56c40d907b3eb5c'],
  'waveshare-4.2in-v2': [15000, '5d136996adb3ba46'],
  'waveshare-2.9in-v2': [4736, 'd773afd1e61e4f47'],
  'waveshare-1.54in-v2': [5000, '11de8e6919a7eed8'],
  'waveshare-5.65in-acep': [28949, 'c733613642e7a2e4'],
  'generic-320x240-rgb565': [153600, 'a06728310d1cd206'],
  'generic-480x320-rgb565': [307200, '661218403da4bbdf'],
  'generic-128x64-1bit': [1024, '4f46b76947a2b23a'],
  'generic-128x32-1bit': [512, 'ee4add492eaaeeac'],
};

test('all 10 presets that existed before render byte-identical to main on a freshly paired row', async () => {
  const base = await h.ready();
  for (const [preset, [len, sha]] of Object.entries(MAIN)) {
    const p = await h.mkPanel(preset);
    assert.equal(h.db.prepare('SELECT orientation FROM devices WHERE id = ?').get(p.id).orientation, 'landscape',
      'the schema default is present, as on every real row');
    const { res, body } = await render(base, p);
    assert.equal(res.status, 200, preset);
    assert.equal(body.length, len, `${preset}: length`);
    assert.equal(sha16(body), sha, `${preset}: bytes differ from main`);
  }
});

test('a portrait custom profile stays portrait (480x800), not turned landscape by the column default', async () => {
  const base = await h.ready();
  const prof = { width: 480, height: 800, colorDepth: '1bit' };
  const p = await h.mkPanel(prof);
  const { res, body } = await render(base, p);
  assert.equal(res.status, 200);
  assert.equal(sha16(body), '3d791c43fa6151c7', 'main\'s bytes');
  assert.equal(res.headers.get('x-st-screen-width'), '480');
  assert.equal(res.headers.get('x-st-screen-height'), '800');
  assert.equal(res.headers.get('x-st-orientation'), 'portrait');
});

test('a profile\'s own rotation is kept: 128x296 r270 stays 128x296 r270', async () => {
  const base = await h.ready();
  const prof = { width: 128, height: 296, rotation: 270 };
  const parsed = parseProfile(JSON.stringify(prof));
  assert.equal(parsed.width, 128);
  assert.equal(parsed.height, 296);
  assert.equal(parsed.rotation, 270);
  const p = await h.mkPanel(prof);
  const { res, body } = await render(base, p);
  assert.equal(res.status, 200);
  assert.equal(sha16(body), '3c382adb7c306943', 'main\'s bytes');
  assert.equal(res.headers.get('x-st-rotation'), '270');
  // Rotated on the server, so the frame itself is in the panel's native 296x128 order.
  assert.equal(res.headers.get('x-st-screen-width'), '296');
  assert.equal(res.headers.get('x-st-screen-height'), '128');
});

test('a preset with its own rotation keeps it: waveshare-2.9in-v2 r180 stays r180', async () => {
  const base = await h.ready();
  const p = await h.mkPanel({ preset: 'waveshare-2.9in-v2', rotation: 180 });
  const { res, body } = await render(base, p);
  assert.equal(res.status, 200);
  assert.equal(sha16(body), 'b953ecb1490a6bc9', 'main\'s bytes');
  assert.equal(res.headers.get('x-st-rotation'), '180');
});

test('server-side rotation 90 keeps working for existing panels (custom r90, Sticky r90)', async () => {
  const base = await h.ready();
  for (const [prof, sha] of [
    [{ width: 296, height: 128, rotation: 90, colorDepth: '1bit' }, '2ebf4078f5ea44d7'],
    [{ preset: 'seeed-reterminal-sticky', rotation: 90 }, '63e90f56fafcc46d'],
  ]) {
    const p = await h.mkPanel(prof);
    const { res, body } = await render(base, p);
    assert.equal(res.status, 200);
    assert.equal(sha16(body), sha, `${JSON.stringify(prof)}: main's img.rotate(90) bytes`);
  }
});

test('odd-width 1-bit profiles are accepted again: 249x120 renders as on main', async () => {
  const base = await h.ready();
  const prof = { width: 249, height: 120, colorDepth: '1bit' };
  assert.ok(parseProfile(JSON.stringify(prof)), 'parseProfile accepts it');
  const p = await h.mkPanel(prof);
  const { res, body } = await render(base, p);
  assert.equal(res.status, 200);
  assert.equal(body.length, 3735);
  assert.equal(sha16(body), '489490fae478534f', 'main\'s bytes');
  // The nibble formats still need an even frame width.
  assert.equal(parseProfile(JSON.stringify({ width: 249, height: 120, colorDepth: 'spectra6' })), null);
  assert.equal(parseProfile(JSON.stringify({ width: 249, height: 120, colorDepth: 'gray16' })), null);
});

test('a freshly paired E1004 renders portrait 1200x1600 by default', async () => {
  const base = await h.ready();
  const p = await h.mkPanel('seeed-reterminal-e1004');
  const { res, body } = await render(base, p);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-st-screen-width'), '1200');
  assert.equal(res.headers.get('x-st-screen-height'), '1600');
  assert.equal(res.headers.get('x-st-orientation'), 'portrait');
  assert.equal(body.length, 1200 * 1600 / 2);
  // ...unless the device says otherwise.
  const land = await render(base, p, { 'X-ST-Device-Orientation': 'landscape', 'X-ST-Device-Rotation': '0' });
  assert.equal(land.res.headers.get('x-st-screen-width'), '1600');
  assert.equal(land.res.headers.get('x-st-screen-height'), '1200');
});

test('an orientation the device stated is remembered for its next poll; the column default never is', async () => {
  const base = await h.ready();
  const p = await h.mkPanel('seeed-reterminal-e1001');
  const plain = await render(base, p);
  assert.equal(plain.res.headers.get('x-st-screen-width'), '800');
  assert.equal(h.db.prepare('SELECT reported_orientation FROM devices WHERE id = ?').get(p.id).reported_orientation, null);

  const stated = await render(base, p, { 'X-ST-Device-Orientation': 'portrait', 'X-ST-Device-Rotation': '90' });
  assert.equal(stated.res.headers.get('x-st-screen-width'), '480');
  assert.equal(h.db.prepare('SELECT reported_orientation FROM devices WHERE id = ?').get(p.id).reported_orientation, 'portrait');

  const next = await render(base, p);
  assert.equal(next.res.headers.get('x-st-screen-width'), '480', 'the stated orientation is remembered');
  assert.equal(next.res.headers.get('x-st-orientation'), 'portrait');
});

test('a read API token (a preview) neither changes nor is the source of the stored orientation', async () => {
  const base = await h.ready();
  const p = await h.mkPanel('seeed-reterminal-e1001');
  const read = h.mkToken('read');
  const res = await fetch(`${base}/render?device_id=${p.id}&orientation=portrait`, { headers: { Authorization: `Bearer ${read}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-st-screen-width'), '480', 'the preview itself shows what was asked for');
  assert.equal(h.db.prepare('SELECT reported_orientation FROM devices WHERE id = ?').get(p.id).reported_orientation, null,
    'but a reader cannot re-mount the panel');
  const dev = await render(base, p);
  assert.equal(dev.res.headers.get('x-st-screen-width'), '800', 'the panel itself is unaffected');
});

test('saving settings updates orientation and preserves existing custom screen_profile fields', async () => {
  const base = await h.ready();
  const customProfile = {
    preset: 'seeed-reterminal-sticky',
    colorDepth: '1bit',
    dither: 'atkinson',
    refreshMode: 'smart_partial',
    customTag: 'preserved-custom-setting',
  };
  const p = await h.mkPanel(customProfile);

  // Initial render (landscape: 800x480)
  const devInitial = await render(base, p);
  assert.equal(devInitial.res.headers.get('x-st-screen-width'), '800');
  assert.equal(devInitial.res.headers.get('x-st-screen-height'), '480');
  assert.equal(devInitial.res.headers.get('x-st-orientation'), 'landscape');

  // Operator saves settings in Dashboard with orientation: 'portrait' and preserved profile fields
  const { generateToken } = require('../middleware/auth');
  const userJwt = generateToken({ id: 'u-emb', email: 'emb@t.local', role: 'workspace_admin' }, 'ws-emb');
  const rootUrl = base.replace(/\/api\/embedded\/?$/, '');
  const updateBody = {
    orientation: 'portrait',
    screen_profile: {
      ...customProfile,
      orientation: 'portrait',
    },
  };
  const putRes = await fetch(`${rootUrl}/api/devices/${p.id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${userJwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updateBody),
  });
  assert.equal(putRes.status, 200);

  // Verify custom field in screen_profile was preserved in DB
  const row = h.db.prepare('SELECT screen_profile, orientation, reported_orientation FROM devices WHERE id = ?').get(p.id);
  assert.equal(row.orientation, 'portrait');
  assert.equal(row.reported_orientation, null);
  const storedProfile = JSON.parse(row.screen_profile);
  assert.equal(storedProfile.customTag, 'preserved-custom-setting', 'custom fields must be preserved');
  assert.equal(storedProfile.orientation, 'portrait');

  // Verify next device poll renders portrait (480x800)
  const devNext = await render(base, p);
  assert.equal(devNext.res.headers.get('x-st-screen-width'), '480');
  assert.equal(devNext.res.headers.get('x-st-screen-height'), '800');
  assert.equal(devNext.res.headers.get('x-st-orientation'), 'portrait');
});

test('PUT /api/devices/:id with string screen_profile preserves orientation in screen_profile', async () => {
  const base = await h.ready();
  const rootUrl = base.replace(/\/api\/embedded\/?$/, '');
  const userJwt = h.sessionToken();

  // Test 1a: preset string
  const p1 = await h.mkPanel('seeed-reterminal-sticky');
  const res1 = await fetch(`${rootUrl}/api/devices/${p1.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${userJwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ orientation: 'portrait', screen_profile: 'seeed-reterminal-sticky' }),
  });
  assert.equal(res1.status, 200);
  const row1 = h.db.prepare('SELECT screen_profile, orientation FROM devices WHERE id = ?').get(p1.id);
  assert.equal(row1.orientation, 'portrait');
  const prof1 = JSON.parse(row1.screen_profile);
  assert.equal(prof1.preset, 'seeed-reterminal-sticky');
  assert.equal(prof1.orientation, 'portrait');

  // Test 1b: JSON string
  const p2 = await h.mkPanel('seeed-reterminal-sticky');
  const res2 = await fetch(`${rootUrl}/api/devices/${p2.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${userJwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ orientation: 'portrait', screen_profile: '{"preset":"seeed-reterminal-sticky"}' }),
  });
  assert.equal(res2.status, 200);
  const row2 = h.db.prepare('SELECT screen_profile, orientation FROM devices WHERE id = ?').get(p2.id);
  assert.equal(row2.orientation, 'portrait');
  const prof2 = JSON.parse(row2.screen_profile);
  assert.equal(prof2.preset, 'seeed-reterminal-sticky');
  assert.equal(prof2.orientation, 'portrait');
});

test('echoing unchanged orientation does not clear reported_orientation', async () => {
  const base = await h.ready();
  const rootUrl = base.replace(/\/api\/embedded\/?$/, '');
  const userJwt = h.sessionToken();

  const p = await h.mkPanel('seeed-reterminal-e1001', { extra: { reported_orientation: 'portrait' } });
  assert.equal(h.db.prepare('SELECT reported_orientation FROM devices WHERE id = ?').get(p.id).reported_orientation, 'portrait');

  const res = await fetch(`${rootUrl}/api/devices/${p.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${userJwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: 'hello', orientation: 'portrait' }),
  });
  assert.equal(res.status, 200);

  const row = h.db.prepare('SELECT reported_orientation, notes FROM devices WHERE id = ?').get(p.id);
  assert.equal(row.notes, 'hello');
  assert.equal(row.reported_orientation, 'portrait', 'reported_orientation must not be cleared when orientation is unchanged');
});

test('echoing default landscape orientation does not inject orientation into screen_profile', async () => {
  const base = await h.ready();
  const rootUrl = base.replace(/\/api\/embedded\/?$/, '');
  const userJwt = h.sessionToken();

  const p = await h.mkPanel('seeed-reterminal-sticky');
  const initialRow = h.db.prepare('SELECT screen_profile, orientation, reported_orientation FROM devices WHERE id = ?').get(p.id);
  assert.equal(initialRow.screen_profile, 'seeed-reterminal-sticky');
  assert.equal(initialRow.reported_orientation, null);
  assert.equal(initialRow.orientation, 'landscape');

  const res = await fetch(`${rootUrl}/api/devices/${p.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${userJwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: 'hello', orientation: 'landscape' }),
  });
  assert.equal(res.status, 200);

  const row = h.db.prepare('SELECT screen_profile, reported_orientation FROM devices WHERE id = ?').get(p.id);
  assert.equal(row.screen_profile, 'seeed-reterminal-sticky', 'screen_profile should not have orientation injected');
  assert.equal(row.reported_orientation, null);
});

test('operator changing orientation clears reported_orientation and sets screen_profile.orientation', async () => {
  const base = await h.ready();
  const rootUrl = base.replace(/\/api\/embedded\/?$/, '');
  const userJwt = h.sessionToken();

  const p = await h.mkPanel('seeed-reterminal-sticky', { extra: { reported_orientation: 'portrait' } });
  assert.equal(h.db.prepare('SELECT reported_orientation FROM devices WHERE id = ?').get(p.id).reported_orientation, 'portrait');

  const res = await fetch(`${rootUrl}/api/devices/${p.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${userJwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ orientation: 'landscape' }),
  });
  assert.equal(res.status, 200);

  const row = h.db.prepare('SELECT screen_profile, orientation, reported_orientation FROM devices WHERE id = ?').get(p.id);
  assert.equal(row.reported_orientation, null, 'reported_orientation must be cleared to null');
  assert.equal(row.orientation, 'landscape');
  const prof = JSON.parse(row.screen_profile);
  assert.equal(prof.orientation, 'landscape');
});
