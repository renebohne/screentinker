'use strict';

/*
 * Reading an organization export (or a whole-server bundle) that arrived from somewhere else
 * (lib/trust/import.js, docs/move-server.md).
 *
 * ⚠️ THE ARCHIVE IS UNTRUSTED INPUT, whoever's server it says it came from. It may be a recovery
 * copy restored after the source server is gone, so NOTHING here contacts any other server: the
 * manifest's per-entry SHA-256 list is the only integrity source, and every entry is checked against
 * it before anything is written (scan) and again while it is read for real (restore).
 *
 *   - names: normalised (no absolute paths, drive letters or `..` — zip slip), no symlinks, no
 *     duplicates, and only the shapes an export contains; anything else refuses the whole archive;
 *   - sizes: an entry is inflated counting REAL bytes and stopped at the size the manifest lists,
 *     so a zip bomb that lies in its central directory is caught at the lie;
 *   - digests: every entry but the manifest is listed, every listed entry is present, and each one
 *     hashes to what is listed. A missing, extra, truncated or altered entry refuses the archive.
 *
 * ⚠️ NO OPEN STREAM ACROSS A DATABASE WRITE IS A PROBLEM HERE: unzipper streams are plain node
 * streams, unlike better-sqlite3 iterators (lib/trust/export.js says why those must never be held).
 */

const crypto = require('crypto');
const { normalizeEntryPath } = require('../html-bundle');
// The unix mode is in the HIGH 16 bits of externalFileAttributes; S_IFLNK is 0xA000 (lib/html-bundle.js).
const isSymlink = (e) => ((((Number(e.externalFileAttributes) || 0) >>> 16) & 0xF000) === 0xA000);

const ORG_FORMAT = 'screentinker-org-export-v1';
const INSTANCE_FORMAT = 'screentinker-instance-export-v1';
const MAX_ENTRIES = 1000000;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const UUIDISH = '[A-Za-z0-9_-]{1,128}';
const ORG_SHAPES = [
  /^manifest\.json$/, /^README\.txt$/, /^tables\/[a-z0-9_]{1,64}\.jsonl$/,
  new RegExp(`^files/${UUIDISH}/[^/]{1,255}$`), new RegExp(`^fonts/${UUIDISH}/[^/]{1,255}$`),
  new RegExp(`^workspaces/${UUIDISH}/export\\.json$`),
];
const INSTANCE_SHAPES = [
  /^instance-manifest\.json$/, /^README\.txt$/, new RegExp(`^orgs/${UUIDISH}\\.zip$`),
  /^instance\/tables\/[a-z0-9_]{1,64}\.jsonl$/,
];

class ImportError extends Error {
  constructor(message, code = 'invalid', status = 400) { super(message); this.code = code; this.status = status; }
}

function inflateAll(entry, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    let done = false;
    const s = entry.stream();
    s.on('data', (c) => {
      if (done) return;
      n += c.length;
      if (n > cap) { done = true; s.destroy(); reject(new ImportError('An archive entry is larger than it says.', 'too_large')); return; }
      chunks.push(c);
    });
    s.on('error', () => { if (!done) { done = true; reject(new ImportError('The archive is damaged.', 'corrupt')); } });
    s.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks, n)); } });
  });
}

/**
 * Open an archive and read its manifest. Refuses unsafe or unexpected entries before reading any
 * content. Returns { kind: 'org'|'instance', manifest, entries: Map(name -> entry), size }.
 */
async function open(file) {
  const unzipper = require('unzipper');
  let directory;
  try { directory = await unzipper.Open.file(file); } catch (_) { throw new ImportError('This file is not a zip archive, or it is damaged.', 'not_zip'); }
  const files = directory.files || [];
  if (files.length > MAX_ENTRIES) throw new ImportError(`The archive has more than ${MAX_ENTRIES} entries.`, 'too_many');
  const entries = new Map();
  for (const e of files) {
    if (e.type === 'Directory') continue;
    if (isSymlink(e)) throw new ImportError('The archive contains a symbolic link.', 'unsafe_entry');
    const name = normalizeEntryPath(e.path);
    // Normalised must equal written: `a/./b`, `a//b` or a backslash name is refused, not quietly read.
    if (!name || name !== e.path) throw new ImportError(`The archive contains an unsafe path (${String(e.path).slice(0, 120)}).`, 'unsafe_entry');
    if (entries.has(name)) throw new ImportError(`The archive lists ${name} twice.`, 'duplicate_entry');
    entries.set(name, e);
  }
  let kind;
  if (entries.has('manifest.json')) kind = 'org';
  else if (entries.has('instance-manifest.json')) kind = 'instance';
  else throw new ImportError('This is not a ScreenTinker organization export (no manifest.json).', 'no_manifest');
  const shapes = kind === 'org' ? ORG_SHAPES : INSTANCE_SHAPES;
  for (const name of entries.keys()) {
    if (!shapes.some((re) => re.test(name))) throw new ImportError(`The archive contains something an export never does (${name.slice(0, 120)}).`, 'unexpected_entry');
  }
  const mname = kind === 'org' ? 'manifest.json' : 'instance-manifest.json';
  let manifest;
  try { manifest = JSON.parse((await inflateAll(entries.get(mname), MAX_MANIFEST_BYTES)).toString('utf8')); } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError('The manifest is not readable.', 'bad_manifest');
  }
  if (!manifest || typeof manifest !== 'object') throw new ImportError('The manifest is not readable.', 'bad_manifest');
  if (kind === 'org' && manifest.format !== ORG_FORMAT) throw new ImportError('This export\'s format is not one this server reads.', 'bad_format');
  if (kind === 'instance' && manifest.format !== INSTANCE_FORMAT) throw new ImportError('This bundle\'s format is not one this server reads.', 'bad_format');
  const integ = manifest.integrity;
  if (!integ || integ.algorithm !== 'sha256' || !integ.entries || typeof integ.entries !== 'object') {
    throw new ImportError('This export has no integrity list (it was made before 3.0). Export the organization again on the old server.', 'no_integrity');
  }
  for (const [name, d] of Object.entries(integ.entries)) {
    if (!d || !/^[0-9a-f]{64}$/.test(String(d.sha256)) || !Number.isSafeInteger(d.bytes) || d.bytes < 0) throw new ImportError(`The integrity list is malformed (${name.slice(0, 120)}).`, 'bad_manifest');
    if (!entries.has(name)) throw new ImportError(`The archive is missing ${name.slice(0, 120)}, which its manifest lists.`, 'tampered');
  }
  for (const name of entries.keys()) {
    if (name !== mname && !Object.prototype.hasOwnProperty.call(integ.entries, name)) throw new ImportError(`The archive contains ${name.slice(0, 120)}, which its manifest does not list.`, 'tampered');
  }
  if (kind === 'org') {
    if (!manifest.organization || typeof manifest.organization.id !== 'string') throw new ImportError('The manifest names no organization.', 'bad_manifest');
  }
  return { kind, manifest, entries, digest: (name) => integ.entries[name] || null };
}

/**
 * Stream one entry, counting and hashing the real bytes. `onData(chunk)` sees every chunk (may be
 * omitted). Resolves when the entry is complete and matches the manifest; rejects otherwise.
 */
function verifyEntry(arch, name, onData = null) {
  const d = arch.digest(name);
  const entry = arch.entries.get(name);
  if (!d || !entry) return Promise.reject(new ImportError(`${name} is not in the archive.`, 'tampered'));
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let n = 0;
    let done = false;
    const s = entry.stream();
    const fail = (e) => { if (done) return; done = true; try { s.destroy(); } catch (_) { /* */ } reject(e); };
    s.on('data', (c) => {
      if (done) return;
      n += c.length;
      if (n > d.bytes) return fail(new ImportError(`${name} does not match the manifest (it is larger).`, 'tampered'));
      h.update(c);
      if (onData) {
        try { onData(c); } catch (e) { fail(e); }
      }
    });
    s.on('error', () => fail(new ImportError(`${name} is damaged.`, 'corrupt')));
    s.on('end', () => {
      if (done) return;
      done = true;
      if (n !== d.bytes || h.digest('hex') !== d.sha256) return reject(new ImportError(`${name} does not match the manifest: the archive was changed or damaged.`, 'tampered'));
      resolve(n);
    });
  });
}

/**
 * Read a JSON Lines entry row by row: `onRows(rows)` receives batches of up to `batch` parsed rows
 * and may be async (the stream waits). The entry's digest is checked as it is read; a mismatch
 * rejects AFTER any batches already handed over, so callers that write must be able to undo
 * (the restore does: the job fails and is rolled back). `skip` drops that many leading rows (resume).
 */
function readRows(arch, name, onRows, { batch = 500, skip = 0 } = {}) {
  const d = arch.digest(name);
  const entry = arch.entries.get(name);
  if (!d || !entry) return Promise.resolve(0);
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const { StringDecoder } = require('string_decoder');
    const dec = new StringDecoder('utf8');
    let n = 0, seen = 0, rest = '', pending = [], done = false;
    const s = entry.stream();
    const fail = (e) => { if (done) return; done = true; try { s.destroy(); } catch (_) { /* */ } reject(e); };
    const flush = async () => {
      if (!pending.length) return;
      const rows = pending;
      pending = [];
      await onRows(rows);
    };
    const take = (line) => {
      if (!line) return;
      seen += 1;
      if (seen <= skip) return;
      let row;
      try { row = JSON.parse(line); } catch (_) { throw new ImportError(`${name} has a line that is not JSON.`, 'corrupt'); }
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new ImportError(`${name} has a line that is not a row.`, 'corrupt');
      pending.push(row);
    };
    s.on('data', (c) => {
      if (done) return;
      n += c.length;
      if (n > d.bytes) return fail(new ImportError(`${name} does not match the manifest (it is larger).`, 'tampered'));
      h.update(c);
      rest += dec.write(c);
      if (rest.length > MAX_LINE_BYTES && rest.indexOf('\n') < 0) return fail(new ImportError(`${name} has a line that is too long.`, 'corrupt'));
      const lines = rest.split('\n');
      rest = lines.pop();
      try { for (const l of lines) take(l); } catch (e) { return fail(e); }
      if (pending.length >= batch) {
        s.pause();
        flush().then(() => { if (!done) s.resume(); }, fail);
      }
    });
    s.on('error', () => fail(new ImportError(`${name} is damaged.`, 'corrupt')));
    s.on('end', async () => {
      if (done) return;
      try {
        take(rest + dec.end());
        if (n !== d.bytes || h.digest('hex') !== d.sha256) throw new ImportError(`${name} does not match the manifest: the archive was changed or damaged.`, 'tampered');
        await flush();
        done = true;
        resolve(seen);
      } catch (e) { fail(e); }
    });
  });
}

/** The parsed JSON of a small entry (a workspace's export.json), digest-checked. */
async function readJson(arch, name, cap = MAX_MANIFEST_BYTES) {
  const chunks = [];
  await verifyEntry(arch, name, (c) => { chunks.push(c); });
  const buf = Buffer.concat(chunks);
  if (buf.length > cap) throw new ImportError(`${name} is too large.`, 'too_large');
  try { return JSON.parse(buf.toString('utf8')); } catch (_) { throw new ImportError(`${name} is not readable.`, 'corrupt'); }
}

/**
 * Copy one entry to a file (exclusive create), digest-checked, with backpressure. The partial file is
 * removed on any failure, so a file under `dest` always holds exactly the bytes the manifest lists.
 * Resolves { bytes, sha256 }.
 */
async function extractTo(arch, name, dest) {
  const fs = require('fs');
  const { Transform } = require('stream');
  const { pipeline } = require('stream/promises');
  const d = arch.digest(name);
  const entry = arch.entries.get(name);
  if (!d || !entry) throw new ImportError(`${name} is not in the archive.`, 'tampered');
  const h = crypto.createHash('sha256');
  let n = 0;
  const check = new Transform({
    transform(chunk, enc, cb) {
      n += chunk.length;
      if (n > d.bytes) return cb(new ImportError(`${name} does not match the manifest (it is larger).`, 'tampered'));
      h.update(chunk);
      cb(null, chunk);
    },
    flush(cb) {
      if (n !== d.bytes || h.digest('hex') !== d.sha256) return cb(new ImportError(`${name} does not match the manifest: the archive was changed or damaged.`, 'tampered'));
      cb();
    },
  });
  try {
    await pipeline(entry.stream(), check, fs.createWriteStream(dest, { flags: 'wx', mode: 0o644 }));
  } catch (e) {
    try { fs.rmSync(dest, { force: true }); } catch (_) { /* */ }
    if (e instanceof ImportError || (e && e.code === 'EEXIST')) throw e;
    throw new ImportError(`${name} is damaged.`, 'corrupt');
  }
  return { bytes: n, sha256: d.sha256 };
}

module.exports = { open, verifyEntry, readRows, readJson, extractTo, ImportError, ORG_FORMAT, INSTANCE_FORMAT };
