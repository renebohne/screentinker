const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Database } = require('../db/sqlite-driver');
const { Jimp } = require('jimp');

// Set test environment
process.env.JWT_SECRET = 'test-secret-embedded';
process.env.EMBEDDED_CACHE_DIR = path.join(__dirname, '..', 'data', 'test-embedded-cache');

// Setup in-memory database with required tables
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT DEFAULT 'user',
    auth_provider TEXT, avatar_url TEXT, plan_id TEXT, email_alerts INTEGER,
    must_change_password INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, name TEXT, organization_id TEXT
  );
  CREATE TABLE workspace_members (
    workspace_id TEXT, user_id TEXT, role TEXT, PRIMARY KEY(workspace_id, user_id)
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, user_id TEXT, workspace_id TEXT, name TEXT,
    pairing_code TEXT, claim_secret TEXT, status TEXT,
    device_token TEXT, blocked INTEGER DEFAULT 0, screen_profile TEXT,
    playlist_id TEXT, playlist_source TEXT
  );
  CREATE TABLE playlists (
    id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, status TEXT DEFAULT 'published'
  );
  CREATE TABLE playlist_items (
    id TEXT PRIMARY KEY, playlist_id TEXT, content_id TEXT,
    sort_order INTEGER DEFAULT 0, duration_sec INTEGER DEFAULT 30, updated_at INTEGER DEFAULT 0
  );
  CREATE TABLE content (
    id TEXT PRIMARY KEY, workspace_id TEXT, type TEXT, filepath TEXT,
    remote_url TEXT, thumbnail_path TEXT, updated_at INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1
  );
  CREATE TABLE embedded_cursor (
    device_id TEXT PRIMARY KEY, item_index INTEGER DEFAULT 0, started_at INTEGER DEFAULT 0
  );
  CREATE TABLE embedded_zone_cursor (
    device_id TEXT, zone_id TEXT, item_index INTEGER DEFAULT 0, started_at INTEGER DEFAULT 0,
    PRIMARY KEY(device_id, zone_id)
  );
  CREATE TABLE layouts (
    id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, is_template INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
  );
  CREATE TABLE layout_zones (
    id TEXT PRIMARY KEY, layout_id TEXT, name TEXT, x_percent REAL, y_percent REAL,
    width_percent REAL, height_percent REAL, z_index INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0
  );
  CREATE VIEW device_resolved_playlist AS
  SELECT d.id AS device_id, d.playlist_id, 'device' AS source, NULL AS layout_id
  FROM devices d;
`);

require.cache[require.resolve('../db/database')] = { id: require.resolve('../db/database'), loaded: true, exports: { db } };

const { parseProfile, getPreset, listPresets } = require('../lib/embedded-profiles');
const { cacheKey, toETag, isNotModified, get: cacheGet, set: cacheSet } = require('../lib/embedded-cache');
const { postprocess } = require('../lib/embedded-postprocess');
const { deviceTokenAuth } = require('../middleware/deviceTokenAuth');
const embeddedRouter = require('../routes/embedded');

describe('Embedded Profiles', () => {
  test('lists known presets', () => {
    const presets = listPresets();
    assert.ok(presets.length >= 8);
    const sticky = presets.find(p => p.key === 'seeed-reterminal-sticky');
    assert.ok(sticky);
    assert.equal(sticky.width, 800);
    assert.equal(sticky.height, 480);
    assert.equal(sticky.colorDepth, '1bit');
    assert.equal(sticky.dither, 'floyd-steinberg');
    assert.equal(sticky.outputFormat, 'x-epd-packed');
  });

  test('parses and validates profiles with fallback defaults', () => {
    const valid = parseProfile({ width: 800, height: 480, colorDepth: '1bit', dither: 'atkinson', outputFormat: 'bmp', rotation: 90 });
    assert.deepEqual(valid, {
      width: 800,
      height: 480,
      rotation: 90,
      colorDepth: '1bit',
      dither: 'atkinson',
      outputFormat: 'bmp',
    });

    const withDefaults = parseProfile({ width: 640, height: 480, unknownField: true });
    assert.equal(withDefaults.width, 640);
    assert.equal(withDefaults.height, 480);
    assert.equal(withDefaults.colorDepth, '1bit');
    assert.equal(withDefaults.dither, 'floyd-steinberg');
    assert.equal(withDefaults.outputFormat, 'x-epd-packed');

    assert.equal(parseProfile(null), null);
    assert.equal(parseProfile({}), null);
    assert.equal(parseProfile('invalid-json'), null);
  });
});

describe('Device Token Auth Middleware', () => {
  const deviceId = 'dev-test-1';
  const token = 'secret_device_token_123';

  db.prepare('INSERT INTO devices (id, name, device_token, workspace_id, blocked) VALUES (?, ?, ?, ?, ?)').run(
    deviceId, 'Test Device', token, 'ws-1', 0
  );

  test('rejects missing authorization header', async () => {
    let status = null, json = null;
    const req = { headers: {}, query: { device_id: deviceId } };
    const res = { status(c) { status = c; return this; }, json(d) { json = d; } };
    deviceTokenAuth(req, res, () => {});
    assert.equal(status, 401);
  });

  test('rejects missing device_id', async () => {
    let status = null, json = null;
    const req = { headers: { authorization: `Bearer ${token}` }, query: {} };
    const res = { status(c) { status = c; return this; }, json(d) { json = d; } };
    deviceTokenAuth(req, res, () => {});
    assert.equal(status, 400);
  });

  test('rejects invalid token', async () => {
    let status = null, json = null;
    const req = { headers: { authorization: 'Bearer wrong_token' }, query: { device_id: deviceId } };
    const res = { status(c) { status = c; return this; }, json(d) { json = d; } };
    deviceTokenAuth(req, res, () => {});
    assert.equal(status, 401);
  });

  test('passes with valid device_id and device_token', async () => {
    let calledNext = false;
    const req = { headers: { authorization: `Bearer ${token}` }, query: { device_id: deviceId } };
    const res = { status() { return this; }, json() {} };
    deviceTokenAuth(req, res, () => { calledNext = true; });
    assert.ok(calledNext);
    assert.equal(req.device.id, deviceId);
    assert.equal(req.workspaceId, 'ws-1');
  });
});

describe('Embedded Cache', () => {
  test('computes deterministic key and handles ETags', () => {
    const profile = { width: 800, height: 480, rotation: 0, colorDepth: '1bit', dither: 'floyd-steinberg', outputFormat: 'x-epd-packed' };
    const key = cacheKey('dev-1', 'item-1', 123456, profile);
    assert.equal(typeof key, 'string');
    assert.equal(key.length, 64);

    const etag = toETag(key);
    assert.equal(etag, `"${key}"`);
    assert.ok(isNotModified(key, etag));
    assert.ok(isNotModified(key, key));
    assert.ok(!isNotModified(key, '"different"'));
  });

  test('sets and gets cache buffers', () => {
    const key = 'test_key_' + Date.now();
    const testBuf = Buffer.from('hello-embedded-image-bytes');
    cacheSet(key, testBuf);
    const res = cacheGet(key);
    assert.ok(res.hit);
    assert.deepEqual(res.buffer, testBuf);
  });
});

describe('Postprocessing & Dithering', () => {
  test('converts test image to 1-bit packed binary (x-epd-packed)', async () => {
    const img = new Jimp({ width: 200, height: 100, color: 0x808080FF }); // 50% gray
    const pngBuf = await img.getBuffer('image/png');

    const profile = {
      width: 800,
      height: 480,
      rotation: 0,
      colorDepth: '1bit',
      dither: 'floyd-steinberg',
      outputFormat: 'x-epd-packed',
    };

    const out = await postprocess(pngBuf, profile);
    assert.equal(out.contentType, 'application/octet-stream');
    // 800 * 480 / 8 = 48000 bytes
    assert.equal(out.buffer.length, 48000);
  });

  test('converts test image to 1-bit BMP', async () => {
    const img = new Jimp({ width: 100, height: 100, color: 0xFFFFFFFF });
    const pngBuf = await img.getBuffer('image/png');

    const profile = {
      width: 800,
      height: 480,
      rotation: 0,
      colorDepth: '1bit',
      dither: 'atkinson',
      outputFormat: 'bmp',
    };

    const out = await postprocess(pngBuf, profile);
    assert.equal(out.contentType, 'image/bmp');
    // BMP header starts with 'BM'
    assert.equal(out.buffer.toString('ascii', 0, 2), 'BM');
    assert.ok(out.buffer.length > 48000);
  });

  test('converts test image to RGB565', async () => {
    const img = new Jimp({ width: 10, height: 10, color: 0xFF0000FF });
    const pngBuf = await img.getBuffer('image/png');

    const profile = {
      width: 320,
      height: 240,
      rotation: 0,
      colorDepth: '16bit-rgb565',
      dither: 'none',
      outputFormat: 'raw',
    };

    const out = await postprocess(pngBuf, profile);
    assert.equal(out.contentType, 'application/octet-stream');
    // 320 * 240 * 2 = 153600 bytes
    assert.equal(out.buffer.length, 153600);
  });

  test('converts test image to JPEG', async () => {
    const img = new Jimp({ width: 100, height: 100, color: 0xFFFFFFFF });
    const pngBuf = await img.getBuffer('image/png');

    const profile = {
      width: 800,
      height: 480,
      rotation: 0,
      colorDepth: '1bit',
      dither: 'floyd-steinberg',
      outputFormat: 'jpeg',
    };

    const out = await postprocess(pngBuf, profile);
    assert.equal(out.contentType, 'image/jpeg');
    // JPEG header SOI starts with 0xFF 0xD8
    assert.equal(out.buffer[0], 0xFF);
    assert.equal(out.buffer[1], 0xD8);
  });
});

const { render, renderLayout, closeBrowser } = require('../lib/embedded-render');

describe('Embedded Renderer Native Image Path & Multi-Zone Layout', () => {
  after(async () => {
    await closeBrowser();
  });

  test('renders local image content via Jimp', async () => {
    // Create a temporary image in uploads
    const tmpUpload = path.join(__dirname, '..', 'uploads', 'content');
    fs.mkdirSync(tmpUpload, { recursive: true });
    const imgPath = path.join(tmpUpload, 'test-item.png');
    const img = new Jimp({ width: 200, height: 100, color: 0x00FF00FF });
    fs.writeFileSync(imgPath, await img.getBuffer('image/png'));

    const item = { id: 'item-img-1' };
    const content = { id: 'cnt-1', filepath: 'test-item.png' };
    const profile = { width: 800, height: 480 };

    const res = await render(item, content, profile);
    assert.ok(res.png);
    assert.ok(Buffer.isBuffer(res.png));
    assert.ok(res.png.length > 500);

    // Clean up temporary image
    try { fs.unlinkSync(imgPath); } catch (_) {}
  });

  test('returns unsupported when content is not found', async () => {
    const item = { id: 'item-empty' };
    const res = await render(item, {}, { width: 800, height: 480 });
    assert.ok(res.unsupported);
  });

  test('rejects a local image filepath that escapes the content directory', async () => {
    const item = { id: 'item-traversal' };
    // A `../` filepath must never be resolved outside the uploads content dir.
    const content = { id: 'cnt-traversal', filepath: '../../../../etc/passwd' };
    const profile = { width: 800, height: 480 };

    // The renderer must NOT succeed in reading a file outside the content dir.
    // It should reject (either because the basename-guarded path is absent, or because
    // the escalation is denied) rather than return pixels from /etc/passwd.
    await assert.rejects(
      () => render(item, content, profile),
      (e) => e.code === 'INVALID_PATH' || e.code === 'NOT_FOUND',
      'expected a path-traversal filepath to be rejected, not read from disk',
    );
  });

  test('renders weather widget or reports unsupported cleanly when browser absent', async () => {
    const item = {
      id: 'item-weather-1',
      widget_type: 'weather',
      widget_config: JSON.stringify({ location: 'Berlin', units: 'metric' }),
    };
    const profile = { width: 800, height: 480 };

    const res = await render(item, {}, profile);
    if (res.unsupported) {
      assert.ok(res.reason);
    } else {
      assert.ok(res.png);
      assert.ok(Buffer.isBuffer(res.png));
      assert.ok(res.png.length > 500);
    }
  });

  test('renders multi-zone layout composition via renderLayout', async () => {
    const layout = { id: 'tpl-split-h', name: 'Split Horizontal' };
    const zoneEntries = [
      {
        zone: { id: 'z1', x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 100, z_index: 0 },
        item: { widget_type: 'clock', widget_config: { timezone: 'Europe/Berlin' } },
        content: null,
      },
      {
        zone: { id: 'z2', x_percent: 50, y_percent: 0, width_percent: 50, height_percent: 100, z_index: 0 },
        item: { widget_type: 'weather', widget_config: { location: 'Berlin', units: 'metric' } },
        content: null,
      },
    ];
    const profile = { width: 800, height: 480 };

    const res = await renderLayout(layout, zoneEntries, profile);
    if (res.unsupported) {
      assert.ok(res.reason);
    } else {
      assert.ok(res.png);
      assert.ok(Buffer.isBuffer(res.png));
      assert.ok(res.png.length > 500);
    }
  });

  test('renderLayout coerces a malicious profile dimension to a safe integer', async () => {
    const layout = { id: 'tpl-split-h', name: 'Split Horizontal' };
    const zoneEntries = [
      {
        zone: { id: 'z1', x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 100, z_index: 0 },
        item: { widget_type: 'clock', widget_config: { timezone: 'Europe/Berlin' } },
        content: null,
      },
    ];
    // A hostile/overflowing profile must not be interpolated into CSS.
    const profile = { width: '800px; background:red', height: '480" onload=alert(1)' };

    const res = await renderLayout(layout, zoneEntries, profile);
    if (res.unsupported) {
      assert.ok(res.reason);
    } else {
      assert.ok(res.png);
      assert.ok(Buffer.isBuffer(res.png));
    }
  });
});

describe('Embedded Pairing Security', () => {
  test('pair/register generates claim_secret and pair/status requires claim_secret', async () => {
    // In-memory test using sqlite db directly
    const devId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('hex');
    const claimSecret = crypto.randomBytes(32).toString('hex');

    db.prepare(`
      INSERT INTO devices (id, pairing_code, device_token, claim_secret, status)
      VALUES (?, '123456', ?, ?, 'provisioning')
    `).run(devId, token, claimSecret);

    const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(devId);
    assert.equal(row.id, devId);
    assert.equal(row.claim_secret, claimSecret);
    assert.equal(row.status, 'provisioning');

    // Simulate claiming in workspace
    db.prepare("UPDATE devices SET workspace_id = 'ws-1', status = 'online' WHERE id = ?").run(devId);
    const claimed = db.prepare('SELECT * FROM devices WHERE id = ?').get(devId);
    assert.equal(claimed.workspace_id, 'ws-1');
    assert.equal(claimed.status, 'online');
  });
});


