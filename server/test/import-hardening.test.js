'use strict';

/*
 * POST /api/status/import — the hardening of the workspace restore:
 *
 *   - the session is checked BEFORE multer accepts a byte, so an anonymous 2 GB upload is refused
 *     and nothing is left in the upload dir;
 *   - extraction is capped on REAL bytes (a lying archive is refused) and the extraction dir is
 *     removed however the request ends;
 *   - a digest-named file is kept under that name only when its bytes hash to it, and an existing
 *     file in the shared content dir is never written over (cross-tenant poisoning);
 *   - imported remote_url / mime_type pass the same gates as the content routes.
 *
 * Boots the REAL server.js with its own TMPDIR, so "nothing left behind" is checked on the actual
 * directories the route writes to.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { freePort } = require('./helpers/free-port');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'st-import-hard-'));
const DATA_DIR = path.join(ROOT, 'data');
const TMPDIR = path.join(ROOT, 'tmp');
const CONTENT_DIR = path.join(DATA_DIR, 'uploads', 'content');
const LOG = path.join(ROOT, 'server.log');
let PORT, BASE, proc, token, sqlite;

const PNG_A = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const PNG_B = Buffer.concat([PNG_A, Buffer.from('trailing-bytes-make-a-different-digest')]);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/* A minimal zip writer. `claim` overrides the uncompressed size the central directory states. */
function crc32(buf) { return zlib.crc32(buf) >>> 0; }
function buildZip(entries) {
  const locals = []; const central = []; let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data);
    const body = zlib.deflateRawSync(raw);
    const name = Buffer.from(e.name);
    const claim = e.claim != null ? e.claim : raw.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(claim, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(claim, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// The import route is limited to 3 per minute per IP. Loopback is a trusted proxy, so each test
// names its own client address in X-Forwarded-For and the limit does not couple them.
async function importZip(zip, tok = token, client = '198.51.100.1') {
  const form = new FormData();
  form.append('file', new Blob([zip]), 'export.zip');
  const headers = { 'X-Forwarded-For': client, ...(tok ? { Authorization: 'Bearer ' + tok } : {}) };
  const r = await fetch(BASE + '/api/status/import', { method: 'POST', headers, body: form });
  let body = null; try { body = await r.json(); } catch { /* */ }
  return { status: r.status, body };
}

function leftovers() {
  const up = path.join(TMPDIR, 'screentinker-import');
  const uploads = fs.existsSync(up) ? fs.readdirSync(up) : [];
  const extracts = fs.readdirSync(TMPDIR).filter((f) => f.startsWith('screentinker-import-'));
  return { uploads, extracts };
}

before(async () => {
  fs.mkdirSync(TMPDIR, { recursive: true });
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, TMPDIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  const reg = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `imp-${crypto.randomBytes(4).toString('hex')}@x.local`, password: 'Passw0rd123' }),
  }).then((r) => r.json());
  token = reg.token;
  assert.ok(token, 'registered');
  sqlite = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'), { timeout: 5000 });
});

after(() => {
  try { sqlite.close(); } catch { /* */ }
  try { proc.kill('SIGKILL'); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
});

test('an unauthenticated multipart import is refused before the upload is accepted', async () => {
  const r = await importZip(Buffer.alloc(2 * 1024 * 1024, 7), null);
  assert.equal(r.status, 401);
  const bad = await importZip(Buffer.alloc(1024, 7), 'not-a-jwt');
  assert.equal(bad.status, 401);
  assert.deepEqual(leftovers().uploads, [], 'no upload left on disk');
});

test('⚠️ a digest-named file whose bytes do not match is NOT written over another tenant\'s file', async () => {
  // A "victim" file already in the shared content dir, named by its true digest.
  fs.mkdirSync(CONTENT_DIR, { recursive: true });
  const victimName = `${sha(PNG_A)}.png`;
  fs.writeFileSync(path.join(CONTENT_DIR, victimName), PNG_A);
  const exp = {
    format: 'screentinker-export-v2',
    content: [
      { id: 'c-evil', filename: 'evil.png', mime_type: 'image/png', original_filepath: victimName },
      { id: 'c-good', filename: 'good.png', mime_type: 'image/png', original_filepath: `${sha(PNG_B)}.png` },
      { id: 'c-meta', filename: 'meta', mime_type: 'text/html', remote_url: 'http://169.254.169.254/latest/meta-data/' },
      { id: 'c-mime', filename: 'odd', mime_type: 'not a mime<script>', remote_url: 'https://example.com/a.png' },
      { id: 'c-web', filename: 'web', mime_type: 'text/html', remote_url: 'https://example.com/' },
    ],
  };
  const zip = buildZip([
    { name: 'export.json', data: JSON.stringify(exp) },
    { name: `files/c-evil/${victimName}`, data: PNG_B },            // claims A's digest, carries B
    { name: `files/c-good/${sha(PNG_B)}.png`, data: PNG_B },        // honest digest name
    { name: 'stray/ignored.txt', data: 'not part of an export' },
  ]);
  const r = await importZip(zip, token, '198.51.100.2');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(fs.readFileSync(path.join(CONTENT_DIR, victimName)).equals(PNG_A), 'the victim\'s bytes are untouched');

  const evil = sqlite.prepare("SELECT filepath FROM content WHERE filename = 'evil.png'").get();
  assert.ok(evil && evil.filepath && evil.filepath !== victimName, 'the lying file got a fresh name');
  assert.ok(fs.readFileSync(path.join(CONTENT_DIR, evil.filepath)).equals(PNG_B));
  const good = sqlite.prepare("SELECT filepath FROM content WHERE filename = 'good.png'").get();
  assert.equal(good.filepath, `${sha(PNG_B)}.png`, 'an honest digest name is kept');

  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM content WHERE filename IN ('meta','odd')").get().n, 0, 'refused rows are not imported');
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM content WHERE filename = 'web'").get().n, 1, 'a public remote URL still imports');
  assert.equal(r.body.stats.content_refused, 2);
  assert.deepEqual(leftovers(), { uploads: [], extracts: [] }, 'upload and extraction removed');
});

test('⚠️ an entry that inflates past its claimed size is refused, and nothing is left behind', async () => {
  const zip = buildZip([
    { name: 'export.json', data: JSON.stringify({ format: 'screentinker-export-v2' }) },
    { name: 'files/c1/big.png', data: Buffer.alloc(8 * 1024 * 1024), claim: 100 },
  ]);
  const r = await importZip(zip, token, '198.51.100.3');
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /Failed to extract ZIP/);
  assert.deepEqual(leftovers(), { uploads: [], extracts: [] });
});

test('zip slip: a traversing entry name is refused', async () => {
  const zip = buildZip([
    { name: 'export.json', data: JSON.stringify({ format: 'screentinker-export-v2' }) },
    { name: '../../escape.png', data: PNG_A },
  ]);
  const r = await importZip(zip, token, '198.51.100.3');
  assert.equal(r.status, 400);
  assert.ok(!fs.existsSync(path.join(TMPDIR, '..', 'escape.png')));
  assert.deepEqual(leftovers(), { uploads: [], extracts: [] });
});
