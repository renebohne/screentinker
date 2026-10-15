'use strict';

/*
 * Free stock photos and videos (lib/stock-media.js, routes/stock-media.js), against a FAKE provider
 * transport: the suite never touches the network.
 *
 * What has to hold:
 *   - no key: the feature reports itself off, search/import answer "not configured" (never a 500),
 *     and only a platform admin is told where to add a key
 *   - the key never reaches a response, an error, or a log line — on success, on a provider error,
 *     on a provider that echoes the request back
 *   - a key entered by a platform admin is stored encrypted, never returned, and an env key cannot
 *     be overwritten from the UI; nobody else can read or set keys
 *   - view-only members can neither search nor add
 *   - an import downloads ONLY the rendition the provider returned for that id, from the provider's
 *     own media host: a client-supplied URL is ignored, and a provider answer pointing elsewhere
 *     (another host, plain http, the metadata address) is never fetched
 *   - size limits: the stock cap / upload limit and the storage allowance bound the download
 *   - the bytes are sniffed and must be the type asked for
 *   - attribution (provider, photographer, licence) is persisted on the content row, in the
 *     requester's own workspace only
 *   - search is cached and rate limited per person
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-stock-'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
delete process.env.PEXELS_API_KEY;
delete process.env.PIXABAY_API_KEY;

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const config = require('../config');
const { db } = require('../db/database');
const { generateToken, requireAuth } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const stock = require('../lib/stock-media');

const PEXELS_KEY = 'pexels-SECRET-key-0123456789';
const PIXABAY_KEY = 'pixabay-SECRET-key-9876543210';

/* ---------- a real PNG, so ingest's thumbnail step has something to decode ---------- */
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w = 32, h = 18) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [200, 120, 40]).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
// ISO-BMFF header the sniffer reads as video/mp4 (ffprobe will fail on it; ingest tolerates that).
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(12), Buffer.alloc(2048, 1)]);

/* ---------- the fake provider ---------- */
const F = {
  apiCalls: [], downloads: [], files: new Map(), status: 200, echo: false,
  // What the fake "API" says about each item; tests rewrite these.
  pexelsPhotoOriginal: 'https://images.pexels.com/photos/101/pexels-photo-101.jpeg',
  pexelsVideoLink: 'https://videos.pexels.com/video-files/202/hd.mp4',
  pixabayLarge: 'https://pixabay.com/get/abc_1280.png',
};
const pexelsPhoto = (id) => ({
  id, width: 6000, height: 4000, url: `https://www.pexels.com/photo/coffee-on-a-table-${id}/`,
  photographer: 'Ana <b>Barista</b>', photographer_url: 'https://www.pexels.com/@ana', avg_color: '#AA8866', alt: 'Coffee on a table',
  src: { original: F.pexelsPhotoOriginal, large: `https://images.pexels.com/photos/${id}/a.jpeg?h=650`, medium: `https://images.pexels.com/photos/${id}/a.jpeg?h=350` },
});
const pexelsVideo = (id) => ({
  id, width: 3840, height: 2160, duration: 12, url: `https://www.pexels.com/video/pouring-latte-${id}/`, image: `https://images.pexels.com/videos/${id}/p.jpg`,
  user: { name: 'Vic Video', url: 'https://www.pexels.com/@vic' },
  video_files: [
    { id: 1, quality: 'uhd', file_type: 'video/mp4', width: 3840, height: 2160, link: 'https://videos.pexels.com/video-files/202/uhd.mp4' },
    { id: 2, quality: 'hd', file_type: 'video/mp4', width: 1920, height: 1080, link: F.pexelsVideoLink },
    { id: 3, quality: 'sd', file_type: 'video/mp4', width: 640, height: 360, link: 'https://videos.pexels.com/video-files/202/sd.mp4' },
  ],
});
const pixabayHit = (id) => ({
  id, pageURL: `https://pixabay.com/photos/croissant-${id}/`, tags: 'croissant, bakery, breakfast',
  webformatURL: 'https://pixabay.com/get/abc_640.png', previewURL: 'https://cdn.pixabay.com/photo/x_150.png',
  largeImageURL: F.pixabayLarge, imageWidth: 5000, imageHeight: 3000, user: 'Pia', user_id: 42,
});

const json = (status, body) => ({ status, body });
const fakeTransport = {
  async api(url, headers) {
    const u = new URL(url);
    F.apiCalls.push({ url, headers });
    if (F.status !== 200) return { status: F.status, body: F.echo ? { error: `bad request ${url} ${JSON.stringify(headers)}` } : null };
    if (u.hostname === 'api.pexels.com') {
      if (headers.Authorization !== PEXELS_KEY) return json(401, { error: 'unauthorised' });
      let m;
      if (u.pathname === '/v1/search') return json(200, { photos: [pexelsPhoto(101), pexelsPhoto(102)], total_results: 2, page: 1, next_page: null });
      if (u.pathname === '/videos/search') return json(200, { videos: [pexelsVideo(202)], total_results: 1 });
      if ((m = /^\/v1\/photos\/(\d+)$/.exec(u.pathname))) return json(200, pexelsPhoto(Number(m[1])));
      if ((m = /^\/videos\/videos\/(\d+)$/.exec(u.pathname))) return json(200, pexelsVideo(Number(m[1])));
      return json(404, null);
    }
    if (u.hostname === 'pixabay.com') {
      if (u.searchParams.get('key') !== PIXABAY_KEY) return json(400, null);
      const id = u.searchParams.get('id');
      return json(200, { totalHits: 1, hits: [pixabayHit(Number(id || 303))] });
    }
    return json(404, null);
  },
  async download(url, dest, maxBytes) {
    F.downloads.push(url);
    const bytes = F.files.has(url) ? F.files.get(url) : null;
    if (!bytes) { const e = new Error('Request failed with status 404'); e.statusCode = 404; throw e; }
    if (bytes.length > maxBytes) throw new stock.StockError('too large', 'too_large', 413);
    fs.writeFileSync(dest, bytes);
    return { size: bytes.length };
  },
};

/* ---------- people and workspaces ---------- */
function mkUser(tag, role = 'user', plan = 'free') {
  const id = `u-stock-${tag}`;
  db.prepare("INSERT INTO users (id, email, password_hash, role, plan_id, email_verified) VALUES (?, ?, 'x', ?, ?, 1)").run(id, `${tag}@stock.test`, role, plan);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
function mkWorkspace(tag, owner) {
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(`org-${tag}`, `Org ${tag}`, owner.id);
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')").run(`org-${tag}`, owner.id);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(`ws-${tag}`, `org-${tag}`, `WS ${tag}`);
  return `ws-${tag}`;
}
const member = (ws, u, role) => db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(ws, u.id, role);

let server, base, WS_A, WS_B, OWNER, EDITOR, VIEWER, OTHER, ADMIN;
const logs = [];
const origConsole = {};

before(async () => {
  fs.mkdirSync(config.contentDir, { recursive: true });
  for (const k of ['log', 'warn', 'error', 'info']) {
    origConsole[k] = console[k];
    console[k] = (...a) => { logs.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  }
  stock._setTransport(fakeTransport);
  OWNER = mkUser('owner');
  WS_A = mkWorkspace('a', OWNER);
  EDITOR = mkUser('editor'); member(WS_A, EDITOR, 'workspace_editor');
  VIEWER = mkUser('viewer'); member(WS_A, VIEWER, 'workspace_viewer');
  OTHER = mkUser('other');
  WS_B = mkWorkspace('b', OTHER);
  ADMIN = mkUser('admin', 'platform_admin');
  member(WS_A, ADMIN, 'workspace_admin');

  const app = express();
  app.use(express.json());
  app.use('/api/stock', requireAuth, resolveTenancy, require('../routes/stock-media'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  stock._setTransport(null);
  Object.assign(console, origConsole);
  return new Promise((r) => server.close(r));
});
beforeEach(() => {
  stock._resetLimits();
  F.status = 200; F.echo = false; F.downloads.length = 0; F.apiCalls.length = 0;
  F.files.clear();
});

async function call(user, method, p, body, ws = WS_A, extraHeaders = {}) {
  const r = await fetch(base + p, {
    method,
    headers: { Authorization: `Bearer ${generateToken(user, ws)}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, text, headers: r.headers };
}
const noKeyIn = (s, label) => {
  assert.ok(!String(s).includes(PEXELS_KEY), `${label} must not contain the Pexels key`);
  assert.ok(!String(s).includes(PIXABAY_KEY), `${label} must not contain the Pixabay key`);
};
const setPexels = (on) => { if (on) process.env.PEXELS_API_KEY = PEXELS_KEY; else delete process.env.PEXELS_API_KEY; };

/* ================================ no key ================================ */

test('no key: off for everyone, the setup hint only for a platform admin, and no 500s', async () => {
  setPexels(false);
  const s = await call(EDITOR, 'GET', '/api/stock/status');
  assert.equal(s.status, 200);
  assert.equal(s.body.enabled, false);
  assert.deepEqual(s.body.providers, []);
  assert.equal(s.body.setup_hint, null, 'an ordinary member is not told about keys');
  const a = await call(ADMIN, 'GET', '/api/stock/status');
  assert.equal(a.body.setup_hint, 'platform_settings');

  const q = await call(EDITOR, 'GET', '/api/stock/search?q=coffee');
  assert.equal(q.status, 400);
  assert.equal(q.body.code, 'not_configured');
  const i = await call(EDITOR, 'POST', '/api/stock/import', { provider: 'pexels', type: 'photo', id: '101' });
  assert.equal(i.status, 400);
  assert.equal(i.body.code, 'not_configured');
  assert.equal(F.apiCalls.length, 0, 'nothing went to a provider');
});

/* ================================ search ================================ */

test('search is proxied: results and attribution come back, the key does not', async () => {
  setPexels(true);
  const r = await call(EDITOR, 'GET', '/api/stock/search?provider=pexels&type=photo&q=coffee');
  assert.equal(r.status, 200, r.text);
  noKeyIn(r.text, 'the search response');
  assert.equal(r.body.items.length, 2);
  const it = r.body.items[0];
  assert.equal(it.id, '101');
  assert.equal(it.author, 'Ana Barista', 'markup is stripped from provider text');
  assert.equal(it.author_url, 'https://www.pexels.com/@ana');
  assert.equal(it.page_url, 'https://www.pexels.com/photo/coffee-on-a-table-101/');
  assert.ok(it.thumb.startsWith('https://images.pexels.com/'));
  assert.equal(it._rendition, undefined, 'the download address is not sent to the browser');
  assert.deepEqual(r.body.attribution, { text: 'Photos provided by Pexels', url: 'https://www.pexels.com' });
  // The key went in the header the provider expects, not in the URL.
  assert.equal(F.apiCalls[0].headers.Authorization, PEXELS_KEY);
  assert.ok(!F.apiCalls[0].url.includes(PEXELS_KEY));
});

test('search is cached: the same query does not go to the provider twice', async () => {
  setPexels(true);
  await call(EDITOR, 'GET', '/api/stock/search?provider=pexels&type=photo&q=Latte');
  await call(OWNER, 'GET', '/api/stock/search?provider=pexels&type=photo&q=latte');
  assert.equal(F.apiCalls.length, 1);
});

test('search is rate limited per person, with Retry-After', async () => {
  setPexels(true);
  let last;
  for (let i = 0; i < 31; i++) last = await call(EDITOR, 'GET', `/api/stock/search?provider=pexels&type=photo&q=q${i}`);
  assert.equal(last.status, 429);
  assert.equal(last.body.code, 'rate_limited');
  assert.ok(Number(last.headers.get('retry-after')) > 0);
  // Someone else in the workspace still can.
  assert.equal((await call(OWNER, 'GET', '/api/stock/search?provider=pexels&type=photo&q=other')).status, 200);
});

test('provider errors carry no key, even when the provider echoes the request back', async () => {
  setPexels(true);
  F.status = 500; F.echo = true;
  logs.length = 0;
  const r = await call(EDITOR, 'GET', '/api/stock/search?provider=pexels&type=photo&q=boom');
  assert.equal(r.status, 502);
  noKeyIn(r.text, 'the error response');
  F.status = 401;
  const k = await call(EDITOR, 'GET', '/api/stock/search?provider=pexels&type=photo&q=boom2');
  assert.equal(k.body.code, 'key_rejected');
  noKeyIn(k.text, 'the key-rejected response');
  F.status = 429;
  const busy = await call(EDITOR, 'GET', '/api/stock/search?provider=pexels&type=photo&q=boom3');
  assert.equal(busy.status, 503);
  noKeyIn(logs.join('\n'), 'the log');
});

test('view-only members can neither search nor add', async () => {
  setPexels(true);
  const s = await call(VIEWER, 'GET', '/api/stock/status');
  assert.equal(s.body.enabled, true);
  assert.equal(s.body.can_add, false);
  assert.equal((await call(VIEWER, 'GET', '/api/stock/search?q=coffee')).status, 403);
  const i = await call(VIEWER, 'POST', '/api/stock/import', { provider: 'pexels', type: 'photo', id: '101' });
  assert.equal(i.status, 403);
  assert.equal(F.apiCalls.length + F.downloads.length, 0);
});

/* ================================ import ================================ */

test('import: the provider rendition for that id, sized for signage, with attribution persisted', async () => {
  setPexels(true);
  const expected = 'https://images.pexels.com/photos/101/pexels-photo-101.jpeg?auto=compress&cs=tinysrgb&w=1920';
  F.files.set(expected, png());
  const r = await call(EDITOR, 'POST', '/api/stock/import', { provider: 'pexels', type: 'photo', id: '101', url: 'https://evil.example/x.png' });
  assert.equal(r.status, 201, r.text);
  noKeyIn(r.text, 'the import response');
  assert.deepEqual(F.downloads, [expected], 'only the provider rendition is fetched; a client url is ignored');
  assert.equal(r.body.workspace_id, WS_A);
  assert.equal(r.body.mime_type, 'image/png', 'the bytes decide the type');
  assert.equal(r.body.filename, 'Coffee on a table.png');
  const row = db.prepare('SELECT * FROM content WHERE id = ?').get(r.body.id);
  const a = JSON.parse(row.attribution);
  assert.equal(a.provider, 'pexels');
  assert.equal(a.author, 'Ana Barista');
  assert.equal(a.author_url, 'https://www.pexels.com/@ana');
  assert.equal(a.page_url, 'https://www.pexels.com/photo/coffee-on-a-table-101/');
  assert.equal(a.licence, 'Pexels License');
  assert.ok(fs.existsSync(path.join(config.contentDir, row.filepath)), 'stored like an upload');
  const audit = db.prepare("SELECT * FROM activity_log WHERE action = 'stock_media_added' ORDER BY id DESC").get();
  assert.equal(audit.workspace_id, WS_A);
});

test('import: a video gets the HD file, not the 4K one', async () => {
  setPexels(true);
  F.files.set(F.pexelsVideoLink, MP4);
  const r = await call(EDITOR, 'POST', '/api/stock/import', { provider: 'pexels', type: 'video', id: '202' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(F.downloads, [F.pexelsVideoLink]);
  assert.equal(r.body.mime_type, 'video/mp4');
  assert.equal(JSON.parse(r.body.attribution).author, 'Vic Video');
});

test('SSRF: a rendition outside the provider media host is never fetched', async () => {
  setPexels(true);
  const original = F.pexelsPhotoOriginal;
  try {
    for (const hostile of ['https://evil.example/photo.jpeg', 'http://images.pexels.com/photos/9/a.jpeg',
      'https://169.254.169.254/latest/meta-data/', 'https://user:pw@images.pexels.com/a.jpeg', 'https://images.pexels.com.evil.example/a.jpeg']) {
      stock._resetLimits();
      F.pexelsPhotoOriginal = hostile;
      const r = await call(EDITOR, 'POST', '/api/stock/import', { provider: 'pexels', type: 'photo', id: String(500 + hostile.length) });
      assert.equal(r.status, 502, `${hostile}: ${r.text}`);
      assert.equal(r.body.code, 'bad_url');
    }
    assert.equal(F.downloads.length, 0);
  } finally { F.pexelsPhotoOriginal = original; }
});

test('import refuses ids that are not ids, and unknown providers', async () => {
  setPexels(true);
  for (const id of ['../../etc', '1?x=1', 'https://evil.example/', '']) {
    const r = await call(EDITOR, 'POST', '/api/stock/import', { provider: 'pexels', type: 'photo', id });
    assert.equal(r.status, 400, id);
  }
  assert.equal((await call(EDITOR, 'POST', '/api/stock/import', { provider: 'unsplash', type: 'photo', id: '1' })).status, 400);
  assert.equal(F.apiCalls.length + F.downloads.length, 0);
});

test('the bytes must be the type asked for', async () => {
  setPexels(true);
  F.files.set('https://images.pexels.com/photos/101/pexels-photo-101.jpeg?auto=compress&cs=tinysrgb&w=1920', Buffer.from('<html><script>alert(1)</script></html>'));
  const before = db.prepare('SELECT COUNT(*) n FROM content').get().n;
  const r = await call(EDITOR, 'POST', '/api/stock/import', { provider: 'pexels', type: 'photo', id: '101' });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'bad_file');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM content').get().n, before);
  assert.deepEqual(fs.readdirSync(config.contentDir).filter((f) => f.endsWith('.part')), [], 'no temp file left behind');
});

test('size limits: the instance upload limit and the storage allowance bound the download', async () => {
  setPexels(true);
  const url = 'https://images.pexels.com/photos/101/pexels-photo-101.jpeg?auto=compress&cs=tinysrgb&w=1920';
  const saved = config.maxFileSize;
  try {
    config.maxFileSize = 1000;
    F.files.set(url, Buffer.concat([png(), Buffer.alloc(4000)]));
    const r = await call(EDITOR, 'POST', '/api/stock/import', { provider: 'pexels', type: 'photo', id: '101' });
    assert.equal(r.status, 413, r.text);
    assert.equal(r.body.code, 'too_large');
  } finally { config.maxFileSize = saved; }

  // A plan with 1 MB of storage and a file bigger than what is left.
  db.prepare("INSERT OR IGNORE INTO plans (id, name, display_name, max_devices, max_storage_mb) VALUES ('tiny', 'tiny', 'Tiny', 1, 1)").run();
  const small = mkUser('small', 'user', 'tiny');
  member(WS_A, small, 'workspace_editor');
  F.files.set(url, Buffer.concat([png(), Buffer.alloc(1024 * 1024 + 10)]));
  const s = await call(small, 'POST', '/api/stock/import', { provider: 'pexels', type: 'photo', id: '101' });
  assert.equal(s.status, 403, s.text);
  assert.equal(s.body.code, 'STORAGE_LIMIT');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM content WHERE user_id = ?').get(small.id).n, 0);
});

test('tenancy: an import lands in the caller\'s own workspace, whatever workspace it names', async () => {
  setPexels(true);
  F.files.set('https://images.pexels.com/photos/101/pexels-photo-101.jpeg?auto=compress&cs=tinysrgb&w=1920', png());
  const r = await call(OTHER, 'POST', '/api/stock/import', { provider: 'pexels', type: 'photo', id: '101' }, WS_B, { 'X-Workspace-Id': WS_A });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.workspace_id, WS_B, 'not the workspace in the header they are not a member of');
  // A folder in someone else's workspace is refused.
  db.prepare("INSERT INTO content_folders (id, user_id, workspace_id, name) VALUES ('fold-a', ?, ?, 'A')").run(OWNER.id, WS_A);
  const f = await call(OTHER, 'POST', '/api/stock/import', { provider: 'pexels', type: 'photo', id: '101', folder_id: 'fold-a' }, WS_B);
  assert.equal(f.status, 400);
});

/* ================================ keys in settings ================================ */

test('keys: only a platform admin sets them; stored encrypted; never returned; env wins', async () => {
  setPexels(true);
  assert.equal((await call(OWNER, 'GET', '/api/stock/settings')).status, 403, 'an org owner is not a platform admin');
  assert.equal((await call(EDITOR, 'PUT', '/api/stock/settings', { provider: 'pixabay', key: 'x' })).status, 403);

  const put = await call(ADMIN, 'PUT', '/api/stock/settings', { provider: 'pixabay', key: PIXABAY_KEY });
  assert.equal(put.status, 200, put.text);
  noKeyIn(put.text, 'the settings response');
  assert.equal(put.body.providers.find((p) => p.id === 'pixabay').source, 'settings');
  const stored = db.prepare("SELECT value FROM app_settings WHERE key = 'stock_key_pixabay'").get().value;
  assert.ok(stored && !stored.includes(PIXABAY_KEY), 'encrypted at rest');
  const g = await call(ADMIN, 'GET', '/api/stock/settings');
  noKeyIn(g.text, 'the settings read');

  // The environment's key cannot be replaced from the UI.
  const locked = await call(ADMIN, 'PUT', '/api/stock/settings', { provider: 'pexels', key: 'something-else' });
  assert.equal(locked.status, 409);

  const tst = await call(ADMIN, 'POST', '/api/stock/settings/test', { provider: 'pixabay' });
  assert.equal(tst.body.ok, true);

  // Pixabay takes its key in the query string: the import still never shows or logs it.
  logs.length = 0;
  F.files.set(F.pixabayLarge, png());
  const r = await call(EDITOR, 'POST', '/api/stock/import', { provider: 'pixabay', type: 'photo', id: '303' });
  assert.equal(r.status, 201, r.text);
  noKeyIn(r.text, 'the pixabay import');
  assert.equal(JSON.parse(r.body.attribution).licence, 'Pixabay Content License');
  F.status = 500; F.echo = true;
  const bad = await call(EDITOR, 'GET', '/api/stock/search?provider=pixabay&q=bread');
  assert.equal(bad.status, 502);
  noKeyIn(bad.text, 'the pixabay error');
  noKeyIn(logs.join('\n'), 'the log');
  F.status = 200; F.echo = false;

  // Clearing it turns Pixabay off again.
  await call(ADMIN, 'PUT', '/api/stock/settings', { provider: 'pixabay', key: '' });
  const s = await call(EDITOR, 'GET', '/api/stock/status');
  assert.deepEqual(s.body.providers.map((p) => p.id), ['pexels']);
});

test('a stale cached Pixabay link gets one fresh lookup, then the import works', async () => {
  delete process.env.PEXELS_API_KEY;
  require('../lib/app-settings').set('stock_key_pixabay', require('../lib/secretbox').encrypt(PIXABAY_KEY));
  // Search (cached), then let the link go stale: the first download 404s, the re-lookup gives a new one.
  await call(EDITOR, 'GET', '/api/stock/search?provider=pixabay&q=croissant');
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 60 * 1000;
  const fresh = 'https://pixabay.com/get/fresh_1280.png';
  const old = F.pixabayLarge;
  try {
    F.pixabayLarge = fresh;
    F.files.set(fresh, png());
    const r = await call(EDITOR, 'POST', '/api/stock/import', { provider: 'pixabay', type: 'photo', id: '303' });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual(F.downloads, [old, fresh]);
  } finally { Date.now = realNow; F.pixabayLarge = old; }
});

test('the media-host check and the video picker, directly', () => {
  const p = stock.PROVIDERS.pexels;
  assert.equal(stock.checkMediaUrl(p, 'https://images.pexels.com/a.jpg'), 'https://images.pexels.com/a.jpg');
  assert.throws(() => stock.checkMediaUrl(p, 'https://images.pexels.com:8443/a.jpg'));
  assert.throws(() => stock.checkMediaUrl(stock.PROVIDERS.pixabay, 'https://images.pexels.com/a.jpg'));
  const best = stock.pickVideoFile([{ link: 'a', width: 3840, height: 2160 }, { link: 'b', width: 1280, height: 720 }, { link: 'c', width: 1080, height: 1920 }]);
  assert.equal(best.url, 'c', 'portrait HD fits the long-edge limit and is the largest that does');
  assert.equal(stock.pickVideoFile([{ link: 'z', width: 4096, height: 2160 }]).url, 'z', 'only a 4K file: take it rather than nothing');
});
