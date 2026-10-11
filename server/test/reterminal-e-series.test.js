'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseProfile, getPreset, listPresets, PRESETS } = require('../lib/embedded-profiles.js');
const { postprocess } = require('../lib/embedded-postprocess.js');
const { Jimp } = require('jimp');

describe('reTerminal E-Series Hardware Profiles & Presets', () => {
  test('all 5 reTerminal models are defined in PRESETS', () => {
    const models = [
      'seeed-reterminal-sticky',
      'seeed-reterminal-e1001',
      'seeed-reterminal-e1002',
      'seeed-reterminal-e1003',
      'seeed-reterminal-e1004',
    ];
    for (const model of models) {
      assert.ok(PRESETS[model], `Missing preset for ${model}`);
    }
  });

  test('e1001 profile: 800x480 mono/gray4 with partial refresh support', () => {
    const p = parseProfile('seeed-reterminal-e1001');
    assert.equal(p.width, 800);
    assert.equal(p.height, 480);
    assert.equal(p.colorDepth, '1bit');
    assert.equal(p.outputFormat, 'x-epd-packed');
    assert.equal(p.supportsPartialRefresh, true);
    assert.equal(p.minRefreshInterval, 5);
    assert.equal(p.fullRefreshDurationMs, 3000);
    assert.equal(p.partialRefreshDurationMs, 350);
  });

  test('e1002 profile: 800x480 6-color Spectra 6 with 30s min interval and no partial refresh', () => {
    const p = parseProfile('seeed-reterminal-e1002');
    assert.equal(p.width, 800);
    assert.equal(p.height, 480);
    assert.equal(p.colorDepth, 'spectra6');
    assert.equal(p.outputFormat, 'x-epd-spectra6');
    assert.equal(p.supportsPartialRefresh, false);
    assert.equal(p.minRefreshInterval, 30);
    assert.equal(p.fullRefreshDurationMs, 14000);
    assert.equal(p.partialRefreshDurationMs, 0);
  });

  test('e1003 profile: 1872x1404 16-level grayscale with touch and fast partial refresh', () => {
    const p = parseProfile('seeed-reterminal-e1003');
    assert.equal(p.width, 1872);
    assert.equal(p.height, 1404);
    assert.equal(p.colorDepth, 'gray16');
    assert.equal(p.outputFormat, 'x-epd-gray16');
    assert.equal(p.supportsPartialRefresh, true);
    assert.equal(p.touchSupported, true);
    assert.equal(p.touchController, 'GT911');
    assert.equal(p.minRefreshInterval, 2);
    assert.equal(p.fullRefreshDurationMs, 1200);
    assert.equal(p.partialRefreshDurationMs, 180);
  });

  test('e1004 profile: 1200x1600 6-color Spectra 6 with 60s min interval and no partial refresh', () => {
    const p = parseProfile('seeed-reterminal-e1004');
    assert.equal(p.width, 1200);
    assert.equal(p.height, 1600);
    assert.equal(p.colorDepth, 'spectra6');
    assert.equal(p.outputFormat, 'x-epd-spectra6');
    assert.equal(p.supportsPartialRefresh, false);
    assert.equal(p.minRefreshInterval, 60);
    assert.equal(p.fullRefreshDurationMs, 22000);
    assert.equal(p.partialRefreshDurationMs, 0);
  });
});

describe('Spectra 6 & Gray16 Postprocessing Pipeline', () => {
  test('e1002 Spectra 6 produces exact 192,000 bytes packed payload (800x480 / 2)', async () => {
    const img = new Jimp({ width: 100, height: 100, color: 0xFF0000FF }); // Red
    const pngBuf = await img.getBuffer('image/png');

    const profile = parseProfile('seeed-reterminal-e1002');
    const processed = await postprocess(pngBuf, profile);

    assert.equal(processed.contentType, 'application/octet-stream');
    assert.equal(processed.buffer.length, 192000); // 800 * 480 / 2 = 192000 bytes

    // Check red color index: Red in Spectra 6 palette is 3 (or 4). Two red pixels packed into byte:
    // Nibbles should match non-zero color
    assert.ok(processed.buffer[0] !== 0x00 && processed.buffer[0] !== 0x11);
  });

  test('e1004 Spectra 6 produces exact 960,000 bytes packed payload (1200x1600 / 2)', async () => {
    const img = new Jimp({ width: 100, height: 100, color: 0x00FF00FF }); // Green
    const pngBuf = await img.getBuffer('image/png');

    const profile = parseProfile('seeed-reterminal-e1004');
    const processed = await postprocess(pngBuf, profile);

    assert.equal(processed.contentType, 'application/octet-stream');
    assert.equal(processed.buffer.length, 960000); // 1200 * 1600 / 2 = 960000 bytes
  });

  test('e1003 Gray16 produces exact 1,314,144 bytes packed payload (1872x1404 / 2)', async () => {
    const img = new Jimp({ width: 100, height: 100, color: 0x808080FF }); // 50% Gray
    const pngBuf = await img.getBuffer('image/png');

    const profile = parseProfile('seeed-reterminal-e1003');
    const processed = await postprocess(pngBuf, profile);

    assert.equal(processed.contentType, 'application/octet-stream');
    assert.equal(processed.buffer.length, 1314144); // 1872 * 1404 / 2 = 1314144 bytes
    // 50% gray should quantize to ~7 or 8 (0x77 or 0x88)
    const midNibble = (processed.buffer[0] >> 4) & 0x0F;
    assert.ok(midNibble >= 6 && midNibble <= 9, `Expected mid-gray nibble, got ${midNibble}`);
  });
});

describe('reTerminal E-Series Registration & Route Handling', () => {
  const http = require('node:http');
  const express = require('express');
  const path = require('node:path');
  const { Database } = require('../db/sqlite-driver');

  let db, app, server, baseUrl, embeddedRouter;

  test('setup test server and database', async () => {
    process.env.JWT_SECRET = 'test-secret-embedded-e-series';
    process.env.EMBEDDED_CACHE_DIR = path.join(__dirname, '..', 'data', 'test-embedded-cache-e-series');

    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT DEFAULT 'user');
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE workspace_members (workspace_id TEXT, user_id TEXT, role TEXT, PRIMARY KEY(workspace_id, user_id));
      CREATE TABLE devices (
        id TEXT PRIMARY KEY, user_id TEXT, workspace_id TEXT, name TEXT,
        pairing_code TEXT, claim_secret TEXT, status TEXT, client_type TEXT,
        device_token TEXT, blocked INTEGER DEFAULT 0, screen_profile TEXT,
        screen_width INTEGER, screen_height INTEGER, render_width INTEGER, render_height INTEGER,
        playlist_id TEXT, playlist_source TEXT, layout_id TEXT,
        timezone TEXT, reported_timezone TEXT, background_color TEXT DEFAULT '#000000',
        default_content_id TEXT, last_heartbeat INTEGER, ip_address TEXT,
        app_version TEXT, updated_at INTEGER, heartbeat_expected_by INTEGER,
        power_source TEXT
      );
      CREATE TABLE device_telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT, battery_level INTEGER, battery_charging INTEGER,
        wifi_rssi INTEGER, local_ip TEXT, power_source TEXT,
        reported_at INTEGER
      );
      CREATE TABLE playlists (
        id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, status TEXT DEFAULT 'published',
        published_snapshot TEXT, published_structure TEXT, updated_at INTEGER DEFAULT 0,
        playback_order TEXT DEFAULT 'sequential', published_playback_order TEXT,
        smart_rules TEXT, published_smart_rules TEXT
      );
      CREATE TABLE playlist_items (
        id TEXT PRIMARY KEY, playlist_id TEXT, content_id TEXT,
        sort_order INTEGER DEFAULT 0, duration_sec INTEGER DEFAULT 10, updated_at INTEGER DEFAULT 0,
        zone_id TEXT, widget_id TEXT, child_playlist_id TEXT, muted INTEGER DEFAULT 0,
        play_from TEXT, play_until TEXT, enabled INTEGER DEFAULT 1, log_play INTEGER DEFAULT 1,
        fit_mode TEXT, play_when TEXT, weight INTEGER DEFAULT 1, repeat_every_sec INTEGER
      );
      CREATE TABLE playlist_item_schedules (
        id TEXT PRIMARY KEY, playlist_item_id TEXT, active_days TEXT,
        start_time TEXT, end_time TEXT, start_date TEXT, end_date TEXT,
        sort_order INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0
      );
      CREATE TABLE widgets (
        id TEXT PRIMARY KEY, workspace_id TEXT, widget_type TEXT, name TEXT, config TEXT, updated_at INTEGER DEFAULT 0
      );
      CREATE TABLE content (
        id TEXT PRIMARY KEY, workspace_id TEXT, type TEXT, mime_type TEXT, filepath TEXT,
        filename TEXT, file_size INTEGER DEFAULT 0, duration_sec REAL, remote_url TEXT,
        thumbnail_path TEXT, updated_at INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE embedded_cursor (
        device_id TEXT PRIMARY KEY, item_index INTEGER DEFAULT 0, started_at INTEGER DEFAULT 0
      );
      CREATE TABLE embedded_zone_cursor (
        device_id TEXT, zone_id TEXT, item_index INTEGER DEFAULT 0, started_at INTEGER DEFAULT 0,
        PRIMARY KEY(device_id, zone_id)
      );
      CREATE TABLE layouts (
        id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, is_template INTEGER DEFAULT 0,
        width INTEGER DEFAULT 1920, height INTEGER DEFAULT 1080, updated_at INTEGER DEFAULT 0
      );
      CREATE TABLE layout_zones (
        id TEXT PRIMARY KEY, layout_id TEXT, name TEXT, x_percent REAL, y_percent REAL,
        width_percent REAL, height_percent REAL, z_index INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0,
        fit_mode TEXT DEFAULT 'contain', background_color TEXT DEFAULT '#000000'
      );
      CREATE VIEW device_resolved_playlist AS
      SELECT d.id AS device_id, d.playlist_id, 'device' AS source, d.layout_id
      FROM devices d;
      CREATE TABLE IF NOT EXISTS display_power_schedules (
        id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, device_id TEXT, group_id TEXT,
        timezone TEXT, enabled INTEGER NOT NULL DEFAULT 1, windows TEXT, set_by_org_admin INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS device_groups (
        id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT
      );
      CREATE TABLE IF NOT EXISTS device_group_members (
        group_id TEXT, device_id TEXT, workspace_id TEXT, PRIMARY KEY(group_id, device_id)
      );
    `);

    require.cache[require.resolve('../db/database')] = {
      id: require.resolve('../db/database'),
      loaded: true,
      exports: { db, pruneTelemetry: () => {} },
    };

    delete require.cache[require.resolve('../routes/embedded')];
    embeddedRouter = require('../routes/embedded');

    app = express();
    app.use(express.json());
    app.use('/api/embedded', embeddedRouter);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/embedded`;
  });

  test('POST /pair/register auto-assigns dimensions from screen_profile preset', async () => {
    // E1003 registration without explicit width/height
    const res = await fetch(`${baseUrl}/pair/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screen_profile: 'seeed-reterminal-e1003' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.device_id);

    const dev = db.prepare('SELECT screen_width, screen_height, render_width, render_height FROM devices WHERE id = ?').get(body.device_id);
    assert.equal(dev.screen_width, 1872);
    assert.equal(dev.screen_height, 1404);
    assert.equal(dev.render_width, 1872);
    assert.equal(dev.render_height, 1404);
  });

  test('POST /pair/register auto-assigns dimensions for E1004', async () => {
    const res = await fetch(`${baseUrl}/pair/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screen_profile: 'seeed-reterminal-e1004' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const dev = db.prepare('SELECT screen_width, screen_height, render_width, render_height FROM devices WHERE id = ?').get(body.device_id);
    assert.equal(dev.screen_width, 1200);
    assert.equal(dev.screen_height, 1600);
    assert.equal(dev.render_width, 1200);
    assert.equal(dev.render_height, 1600);
  });

  test('GET /render clamps expiresIn to minRefreshInterval and emits X-ST-Supports-Partial for E1002', async () => {
    const fs = require('node:fs');
    const { contentDir } = require('../config');
    fs.mkdirSync(contentDir, { recursive: true });
    const img = new Jimp({ width: 100, height: 100, color: 0xFF0000FF });
    const pngPath = path.join(contentDir, 'test-e1002.png');
    await img.write(pngPath);

    db.prepare("INSERT INTO content (id, workspace_id, type, mime_type, filepath, is_active, created_at) VALUES ('c-e1002', 'ws-test', 'image', 'image/png', 'test-e1002.png', 1, 1)").run();
    db.prepare("INSERT INTO playlists (id, workspace_id, name, status, published_snapshot) VALUES ('pl-e1002', 'ws-test', 'PL E1002', 'published', ?)").run(JSON.stringify([
      { id: 'pi-1', content_id: 'c-e1002', duration_sec: 10, enabled: 1 }
    ]));
    db.prepare(`
      INSERT INTO devices (id, name, workspace_id, status, device_token, playlist_id, screen_profile)
      VALUES ('dev-e1002', 'E1002 Dev', 'ws-test', 'online', 'tok-e1002', 'pl-e1002', 'seeed-reterminal-e1002')
    `).run();

    const res = await fetch(`${baseUrl}/render?device_id=dev-e1002`, {
      headers: { 'Authorization': 'Bearer tok-e1002' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-st-supports-partial'), '0');
    const expiresIn = Number(res.headers.get('x-st-expires-in'));
    assert.ok(expiresIn >= 30, `Expected expiresIn >= 30, got ${expiresIn}`);

    try { fs.unlinkSync(pngPath); } catch (_) {}
  });

  test('GET /render emits X-ST-Supports-Partial: 1 for E1001', async () => {
    const fs = require('node:fs');
    const { contentDir } = require('../config');
    fs.mkdirSync(contentDir, { recursive: true });
    const img = new Jimp({ width: 100, height: 100, color: 0x000000FF });
    const pngPath = path.join(contentDir, 'test-e1001.png');
    await img.write(pngPath);

    db.prepare("INSERT INTO content (id, workspace_id, type, mime_type, filepath, is_active, created_at) VALUES ('c-e1001', 'ws-test', 'image', 'image/png', 'test-e1001.png', 1, 1)").run();
    db.prepare("INSERT INTO playlists (id, workspace_id, name, status, published_snapshot) VALUES ('pl-e1001', 'ws-test', 'PL E1001', 'published', ?)").run(JSON.stringify([
      { id: 'pi-2', content_id: 'c-e1001', duration_sec: 10, enabled: 1 }
    ]));
    db.prepare(`
      INSERT INTO devices (id, name, workspace_id, status, device_token, playlist_id, screen_profile)
      VALUES ('dev-e1001', 'E1001 Dev', 'ws-test', 'online', 'tok-e1001', 'pl-e1001', 'seeed-reterminal-e1001')
    `).run();

    const res = await fetch(`${baseUrl}/render?device_id=dev-e1001`, {
      headers: { 'Authorization': 'Bearer tok-e1001' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-st-supports-partial'), '1');

    try { fs.unlinkSync(pngPath); } catch (_) {}
  });

  test('teardown server', async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });
});

