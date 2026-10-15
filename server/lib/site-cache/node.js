'use strict';

/*
 * THE SITE CACHE BOX (docs/site-cache.md).
 *
 * Runs on any always-on machine on a site's LAN — a Raspberry Pi, a NUC, a container — and does
 * three things:
 *
 *   1. PRE-WARMS. Every poll it asks the origin for its manifest: which screens it serves and the
 *      sha256 of every asset those screens' payloads reference. It downloads what it does not hold,
 *      ONCE, resumably (lib/mesh/pull-download.js), and keeps it under its digest.
 *   2. VERIFIES. A download is hashed before it is kept; a file that does not hash to its name is
 *      deleted, never served. A slow scrub re-hashes one held file per poll, so bit rot on an SD card
 *      is found by the box rather than by a screen.
 *   3. SERVES `GET /cache/<sha256>` on the LAN, to a screen that shows a token the origin minted for
 *      it, and only for a digest that screen's own payload references (lib/site-cache/tokens.js).
 *
 * WHAT IT DOES NOT DO: decide anything about playback. Screens always know the origin URL as well,
 * verify what the box hands them against the digest they already have, and fall back to the origin
 * on any failure — a dead, slow or lying box costs bandwidth, never a dark screen.
 *
 * ⚠️ NODE BUILT-INS ONLY (plus three dependency-free siblings). This file must run from a bare
 * checkout with no `npm install`: `node server/lib/site-cache/node.js`, or `node server.js` with
 * SITE_CACHE_FOR set. Requiring config.js or the database here would drag the whole server in.
 *
 * Environment:
 *   SITE_CACHE_FOR            origin URL, e.g. https://signage.example.com           (required)
 *   SITE_CACHE_TOKEN          the token shown once in Displays → Site caches             (required)
 *   SITE_CACHE_PORT           LAN port to listen on (8088)
 *   SITE_CACHE_HOST           address to bind (0.0.0.0)
 *   SITE_CACHE_DIR            where blobs and state live ($DATA_DIR/site-cache, else ./site-cache-data)
 *   SITE_CACHE_MAX_BYTES      cap on held bytes (0 = no cap beyond the free-space reserve)
 *   SITE_CACHE_MIN_FREE_BYTES leave at least this much disk free (1 GB)
 *   SITE_CACHE_TLS_CERT / SITE_CACHE_TLS_KEY  serve HTTPS (needed for web players on an https origin)
 *   SITE_CACHE_POLL_SECONDS   override the origin's poll interval (testing)
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { verifyPlayerToken, isSha256 } = require('./tokens');
const { downloadResumable } = require('../mesh/pull-download');
const POLICY = require('../player-cache-policy');

let VERSION = '0.0.0';
try { VERSION = require('../../version'); } catch (_) { /* a trimmed copy without VERSION still runs */ }

const GiB = 1024 * 1024 * 1024;
/** A file nobody wants any more is kept this long: playlists flip back, and re-downloading is the cost. */
const KEEP_UNWANTED_MS = 24 * 3600 * 1000;
/** A digest that failed to download or verify is not retried before this. */
const FAILURE_BACKOFF_MS = 10 * 60 * 1000;
const MANIFEST_TIMEOUT_MS = 30_000;
/** "Not in my manifest" from a screen holding a valid token usually means the manifest is stale. */
const KICK_MIN_INTERVAL_MS = 10_000;

const SAFE_MIME = /^[a-z]+\/[a-z0-9.+-]{1,80}$/i;

function readConfig(env = process.env) {
  const errors = [];
  let originUrl = String(env.SITE_CACHE_FOR || '').trim().replace(/\/+$/, '');
  try {
    const u = new URL(originUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') errors.push('SITE_CACHE_FOR must be an http(s) URL');
    if (u.username || u.password) errors.push('SITE_CACHE_FOR must not contain credentials');
    originUrl = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch (_) { errors.push('SITE_CACHE_FOR is not a valid URL'); }
  const token = String(env.SITE_CACHE_TOKEN || '').trim();
  if (!/^stcn_[A-Za-z0-9_-]{20,100}$/.test(token)) errors.push('SITE_CACHE_TOKEN is missing or malformed (copy it from Displays → Site caches)');
  const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
  const cfg = {
    origin: originUrl,
    token,
    port: num(env.SITE_CACHE_PORT, 8088),
    host: env.SITE_CACHE_HOST || '0.0.0.0',
    // DATA_DIR is what the Docker image already points at its volume, so a container needs no extra flag.
    dir: path.resolve(env.SITE_CACHE_DIR || (env.DATA_DIR ? path.join(env.DATA_DIR, 'site-cache') : path.join(process.cwd(), 'site-cache-data'))),
    maxBytes: num(env.SITE_CACHE_MAX_BYTES, 0),
    minFreeBytes: num(env.SITE_CACHE_MIN_FREE_BYTES, GiB),
    tlsCert: env.SITE_CACHE_TLS_CERT || null,
    tlsKey: env.SITE_CACHE_TLS_KEY || null,
    pollSeconds: env.SITE_CACHE_POLL_SECONDS ? Number(env.SITE_CACHE_POLL_SECONDS) : null,
  };
  if (!(cfg.port >= 0 && cfg.port < 65536)) errors.push('SITE_CACHE_PORT is not a port');
  if ((cfg.tlsCert && !cfg.tlsKey) || (!cfg.tlsCert && cfg.tlsKey)) errors.push('set both SITE_CACHE_TLS_CERT and SITE_CACHE_TLS_KEY, or neither');
  return { cfg, errors };
}

class SiteCacheNode {
  constructor(cfg, { fetchImpl, log } = {}) {
    this.cfg = cfg;
    this.fetch = fetchImpl || global.fetch;
    this.log = log || ((...a) => console.log('[site-cache]', ...a));
    this.manifest = null;          // { cache_id, enabled, poll_seconds, devices, files }
    this.fetchKey = null;
    this.etag = null;
    this.entitlements = new Map(); // deviceId -> Set(sha)
    this.wanted = new Map();       // sha -> { sha256, size, mime_type }
    this.stats = { hits: 0, misses: 0, bytes_served: 0, bytes_from_origin: 0 };
    this.lastSyncAt = null;
    this.lastError = null;
    this.unwantedSince = {};       // sha -> ms
    this.failedAt = new Map();     // sha -> ms
    this.priority = new Set();     // shas a screen asked for that we do not hold yet
    this.downloading = null;       // sha in flight
    this.scrubCursor = 0;
    this.server = null;
    this.timer = null;
    this.syncing = null;
    this.lastKick = 0;
    this.stopped = false;
  }

  /* ------------------------------------------------------------ disk ------------------- */

  blobPath(sha) { return path.join(this.cfg.dir, 'blobs', sha.slice(0, 2), sha); }
  tmpPath(sha) { return path.join(this.cfg.dir, 'tmp', `${sha}.part`); }
  statePath() { return path.join(this.cfg.dir, 'state.json'); }

  heldSize(sha) {
    try { const st = fs.statSync(this.blobPath(sha)); return st.isFile() ? st.size : -1; } catch (_) { return -1; }
  }

  isHeld(sha) {
    const f = this.wanted.get(sha);
    const size = this.heldSize(sha);
    // A held file whose size disagrees with the manifest is not this asset: never serve it.
    return size >= 0 && (!f || f.size === size);
  }

  listHeld() {
    const out = [];
    const root = path.join(this.cfg.dir, 'blobs');
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch (_) { return out; }
    for (const d of dirs) {
      let names = [];
      try { names = fs.readdirSync(path.join(root, d)); } catch (_) { continue; }
      for (const n of names) {
        if (!isSha256(n)) continue;
        try { out.push({ sha: n, size: fs.statSync(path.join(root, d, n)).size }); } catch (_) { /* vanished */ }
      }
    }
    return out;
  }

  /*
   * State survives a restart so a box that boots while the WAN is down still serves: the manifest
   * (who may fetch what), the key that checks screen tokens, and the counters. 0600 because the key
   * in it can mint access to this site's media.
   */
  loadState() {
    try {
      const s = JSON.parse(fs.readFileSync(this.statePath(), 'utf8'));
      if (s && s.manifest && s.fetch_key) this.applyManifest(s.manifest, s.fetch_key, s.etag || null);
      if (s && s.stats) for (const k of Object.keys(this.stats)) if (Number.isFinite(s.stats[k])) this.stats[k] = s.stats[k];
      if (s && s.unwanted_since && typeof s.unwanted_since === 'object') this.unwantedSince = s.unwanted_since;
      this.lastSyncAt = (s && s.last_sync_at) || null;
    } catch (_) { /* first boot, or a torn file: start clean */ }
  }

  saveState() {
    const body = JSON.stringify({
      manifest: this.manifest, fetch_key: this.fetchKey, etag: this.etag, stats: this.stats,
      unwanted_since: this.unwantedSince, last_sync_at: this.lastSyncAt,
    });
    const tmp = this.statePath() + '.tmp';
    try {
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.statePath());
    } catch (e) { this.log('could not save state:', e.message); }
  }

  /* ------------------------------------------------------------ manifest --------------- */

  applyManifest(m, fetchKey, etag) {
    const ok = m && typeof m === 'object' && m.enabled && fetchKey;
    this.manifest = m && typeof m === 'object' ? m : null;
    this.fetchKey = ok ? String(fetchKey) : null;
    this.etag = etag;
    this.entitlements = new Map();
    this.wanted = new Map();
    if (!ok) return;
    for (const [deviceId, shas] of Object.entries(m.devices || {})) {
      this.entitlements.set(deviceId, new Set((Array.isArray(shas) ? shas : []).filter(isSha256)));
    }
    for (const f of Array.isArray(m.files) ? m.files : []) {
      if (f && isSha256(f.sha256) && Number(f.size) >= 0) {
        this.wanted.set(f.sha256, { sha256: f.sha256, size: Number(f.size), mime_type: SAFE_MIME.test(f.mime_type || '') ? f.mime_type : null });
      }
    }
  }

  /** The origin no longer recognises us (revoked, rotated, deleted): stop serving anything. */
  forgetEverything(reason) {
    this.applyManifest(null, null, null);
    this.lastError = reason;
    this.saveState();
  }

  authHeaders(extra) { return { ...(extra || {}), Authorization: `Bearer ${this.cfg.token}` }; }

  async fetchManifest() {
    const headers = this.authHeaders(this.etag && this.fetchKey ? { 'If-None-Match': this.etag } : {});
    const res = await this.fetch(`${this.cfg.origin}/api/site-cache/node/manifest`, {
      headers, redirect: 'error', signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    });
    if (res.status === 304) return 'unchanged';
    if (res.status === 401 || res.status === 403) {
      this.forgetEverything('The origin did not accept this cache\'s token. It may have been rotated or deleted.');
      return 'refused';
    }
    if (!res.ok) throw new Error(`the origin answered ${res.status} for the manifest`);
    const body = await res.json();
    this.applyManifest(body, body && body.fetch_key, res.headers.get('etag'));
    return 'updated';
  }

  /* ------------------------------------------------------------ pre-warm --------------- */

  freeBytes() {
    try { const s = fs.statfsSync(this.cfg.dir); return Number(s.bavail) * Number(s.bsize); } catch (_) { return Infinity; }
  }

  usedBytes() { return this.listHeld().reduce((n, f) => n + f.size, 0); }

  /** One asset from the origin into blobs/, verified. Returns true when it is held afterwards. */
  async download(file) {
    const { sha256: sha, size } = file;
    if (this.isHeld(sha)) return true;
    const failed = this.failedAt.get(sha);
    if (failed && Date.now() - failed < FAILURE_BACKOFF_MS) return false;
    if (this.cfg.maxBytes > 0 && this.usedBytes() + size > this.cfg.maxBytes) {
      this.lastError = 'The cache is full (SITE_CACHE_MAX_BYTES). Some files are served from the origin instead.';
      return false;
    }
    if (this.freeBytes() - size < this.cfg.minFreeBytes) {
      this.lastError = 'The disk is nearly full. Some files are served from the origin instead.';
      return false;
    }
    const staged = this.tmpPath(sha);
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    let before = 0;
    try { before = fs.statSync(staged).size; } catch (_) { before = 0; }
    this.downloading = sha;
    try {
      const r = await downloadResumable({
        url: `${this.cfg.origin}/api/site-cache/node/blob/${sha}`,
        stagedPath: staged,
        expectedBytes: size,
        fetchImpl: (u, o) => this.fetch(u, { ...(o || {}), headers: this.authHeaders(o && o.headers) }),
      });
      let after = 0;
      try { after = fs.statSync(staged).size; } catch (_) { after = 0; }
      this.stats.bytes_from_origin += Math.max(0, after - (r.resumed ? before : 0));
      if (!r.ok) {
        if (!r.partial) { try { fs.unlinkSync(staged); } catch (_) { /* */ } }
        this.failedAt.set(sha, Date.now());
        this.lastError = r.reason || 'A download failed.';
        return false;
      }
      // ⚠️ THE INTEGRITY CHECK. Size matching is not enough: a resumed transfer spliced from two
      // representations has exactly the right length.
      const got = await hashFile(staged);
      if (got !== sha) {
        try { fs.unlinkSync(staged); } catch (_) { /* */ }
        this.failedAt.set(sha, Date.now());
        this.lastError = `A download did not match its sha256 (${sha.slice(0, 12)}…) and was discarded.`;
        this.log(this.lastError);
        return false;
      }
      const dest = this.blobPath(sha);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(staged, dest);
      this.failedAt.delete(sha);
      delete this.unwantedSince[sha];
      return true;
    } catch (e) {
      this.failedAt.set(sha, Date.now());
      this.lastError = `A download failed: ${e.message}`;
      return false;
    } finally {
      this.downloading = null;
    }
  }

  /** Everything wanted and missing, the ones a screen is waiting for first. One at a time. */
  async prewarm() {
    for (;;) {
      if (this.stopped) return;
      let next = null;
      for (const sha of this.priority) {
        this.priority.delete(sha);
        const f = this.wanted.get(sha);
        if (f && !this.isHeld(sha)) { next = f; break; }
      }
      if (!next) {
        for (const f of this.wanted.values()) {
          if (this.isHeld(f.sha256)) continue;
          const failed = this.failedAt.get(f.sha256);
          if (failed && Date.now() - failed < FAILURE_BACKOFF_MS) continue;
          if (this.cfg.maxBytes > 0 && this.usedBytes() + f.size > this.cfg.maxBytes) continue;
          next = f; break;
        }
      }
      if (!next) return;
      const ok = await this.download(next);
      if (!ok) this.failedAt.set(next.sha256, this.failedAt.get(next.sha256) || Date.now());
    }
  }

  /*
   * Eviction. A held file the manifest no longer names is kept for a day (a campaign often comes
   * back), then deleted. Over SITE_CACHE_MAX_BYTES, unwanted files go oldest-unwanted first. A
   * wanted file is never evicted to make room: the next poll would download it again.
   */
  evict() {
    const now = Date.now();
    const held = this.listHeld();
    for (const f of held) {
      if (this.wanted.has(f.sha)) { delete this.unwantedSince[f.sha]; continue; }
      if (!this.unwantedSince[f.sha]) this.unwantedSince[f.sha] = now;
    }
    for (const sha of Object.keys(this.unwantedSince)) {
      if (!held.some((f) => f.sha === sha)) delete this.unwantedSince[sha];
    }
    let used = held.reduce((n, f) => n + f.size, 0);
    const unwanted = held.filter((f) => !this.wanted.has(f.sha))
      .sort((a, b) => (this.unwantedSince[a.sha] || 0) - (this.unwantedSince[b.sha] || 0));
    for (const f of unwanted) {
      const old = now - (this.unwantedSince[f.sha] || now) >= KEEP_UNWANTED_MS;
      const over = this.cfg.maxBytes > 0 && used > this.cfg.maxBytes;
      if (!old && !over) continue;
      try { fs.unlinkSync(this.blobPath(f.sha)); used -= f.size; delete this.unwantedSince[f.sha]; } catch (_) { /* */ }
    }
    // A .part for a digest nobody wants is a download that will never finish.
    try {
      for (const n of fs.readdirSync(path.join(this.cfg.dir, 'tmp'))) {
        const sha = n.replace(/\.part$/, '');
        if (!this.wanted.has(sha) && this.downloading !== sha) { try { fs.unlinkSync(path.join(this.cfg.dir, 'tmp', n)); } catch (_) { /* */ } }
      }
    } catch (_) { /* no tmp yet */ }
  }

  /** Re-hash one held file per poll, round-robin: bit rot is found here, not by a screen. */
  async scrubOne() {
    const held = this.listHeld().sort((a, b) => (a.sha < b.sha ? -1 : 1));
    if (!held.length) return;
    const f = held[this.scrubCursor % held.length];
    this.scrubCursor++;
    if (f.sha === this.downloading) return;
    const got = await hashFile(this.blobPath(f.sha));
    if (got && got !== f.sha) {
      try { fs.unlinkSync(this.blobPath(f.sha)); } catch (_) { /* */ }
      this.lastError = `A held file no longer matched its sha256 (${f.sha.slice(0, 12)}…) and was deleted.`;
      this.log(this.lastError);
    }
  }

  async report() {
    const held = this.listHeld();
    const free = this.freeBytes();
    const body = {
      version: VERSION,
      disk_used: held.reduce((n, f) => n + f.size, 0),
      disk_free: Number.isFinite(free) ? free : null,
      files_held: held.filter((f) => this.wanted.has(f.sha)).length,
      files_wanted: this.wanted.size,
      bytes_wanted: [...this.wanted.values()].reduce((n, f) => n + f.size, 0),
      ...this.stats,
      last_sync_at: this.lastSyncAt,
      last_error: this.lastError,
    };
    const res = await this.fetch(`${this.cfg.origin}/api/site-cache/node/report`, {
      method: 'POST', headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    });
    if (res.body) { try { await res.arrayBuffer(); } catch (_) { /* drain */ } }
  }

  /** One round. Serialised: a kick during a round waits for it rather than racing it. */
  sync() {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        const r = await this.fetchManifest();
        if (r !== 'refused') {
          this.lastSyncAt = Math.floor(Date.now() / 1000);
          this.lastError = null;
          await this.prewarm();
          this.evict();
          await this.scrubOne();
        }
      } catch (e) {
        // The origin is unreachable: keep serving what we hold to the screens we know. That is the
        // offline half of this box's job.
        this.lastError = `Could not reach the origin: ${e.message}`;
      }
      this.saveState();
      try { await this.report(); } catch (_) { /* reported next round */ }
    })().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  kick() {
    if (Date.now() - this.lastKick < KICK_MIN_INTERVAL_MS) return;
    this.lastKick = Date.now();
    this.sync().catch(() => {});
  }

  pollMs() {
    const s = this.cfg.pollSeconds || (this.manifest && this.manifest.poll_seconds) || 60;
    return Math.max(1, Math.min(3600, Number(s) || 60)) * 1000;
  }

  schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => { this.sync().finally(() => this.schedule()); }, this.pollMs());
    if (this.timer.unref) this.timer.unref();
  }

  /* ------------------------------------------------------------ LAN server ------------- */

  /*
   * CORS: any origin, because the token IS the credential — nothing here reads a cookie, so a page
   * cannot borrow a screen's access by being loaded in the same browser. Private Network Access:
   * Chrome asks before a public-origin page fetches a private address, and refusing would make the
   * box unusable from a cloud-hosted player.
   */
  cors(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, ETag, Retry-After, X-ST-Cache');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Range, If-None-Match');
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
  }

  handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj, headers) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(headers || {}) });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(obj));
    };
    if (url.pathname === '/healthz') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return send(200, {
        ok: true, version: VERSION, cache_id: this.manifest ? this.manifest.cache_id : null,
        serving: !!this.fetchKey, files_wanted: this.wanted.size,
        files_held: [...this.wanted.keys()].filter((s) => this.isHeld(s)).length,
        last_sync_at: this.lastSyncAt,
      });
    }
    const m = /^\/cache\/([^/]+)$/.exec(url.pathname);
    if (!m) return send(404, { error: 'Not found' });
    this.cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD, OPTIONS' });

    const sha = m[1];
    if (!isSha256(sha)) return send(404, { error: 'Not found' });
    const auth = /^Bearer\s+(\S+)\s*$/.exec(String(req.headers.authorization || ''));
    const who = auth && this.fetchKey && this.manifest
      ? verifyPlayerToken(this.fetchKey, auth[1], { cacheId: this.manifest.cache_id })
      : null;
    if (!who) return send(401, { error: 'A valid screen token is required.' }, { 'WWW-Authenticate': 'Bearer' });
    const allowed = this.entitlements.get(who.deviceId);
    // ⚠️ Per SCREEN, not per box: a token is access to what that screen plays, and "not yours" and
    // "not here" are the same 404, so a guessed digest learns nothing about what the box holds.
    if (!allowed || !allowed.has(sha)) {
      this.kick();   // a valid screen asking for something new: our manifest is probably behind
      return send(404, { error: 'Not found' });
    }
    if (!this.isHeld(sha)) {
      this.stats.misses++;
      this.priority.add(sha);
      this.kick();
      return send(503, { error: 'Still downloading.' }, { 'Retry-After': '15', 'X-ST-Cache': 'warming' });
    }
    return this.serveBlob(req, res, sha);
  }

  serveBlob(req, res, sha) {
    const file = this.blobPath(sha);
    let size;
    try { size = fs.statSync(file).size; } catch (_) { res.writeHead(404); return res.end(); }
    const etag = `"${sha}"`;
    const meta = this.wanted.get(sha);
    const headers = {
      'Content-Type': (meta && meta.mime_type) || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'ETag': etag,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
      'X-ST-Cache': 'hit',
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    let range = POLICY.parseRange(req.headers.range, size);
    if (range && req.headers['if-range'] && req.headers['if-range'] !== etag) range = null;
    if (range === 'unsatisfiable') {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    if (start === 0) this.stats.hits++;
    if (range) {
      res.writeHead(206, { ...headers, ...POLICY.partialHeaders(start, end, size, headers['Content-Type']) });
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': String(size) });
    }
    if (req.method === 'HEAD' || size === 0) return res.end();
    const stream = fs.createReadStream(file, { start, end });
    stream.on('data', (chunk) => { this.stats.bytes_served += chunk.length; });
    stream.on('error', () => { try { res.destroy(); } catch (_) { /* */ } });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  /* ------------------------------------------------------------ lifecycle -------------- */

  async start() {
    for (const d of ['blobs', 'tmp']) fs.mkdirSync(path.join(this.cfg.dir, d), { recursive: true });
    this.loadState();
    const handler = (req, res) => {
      try { this.handle(req, res); } catch (e) {
        try { res.writeHead(500); res.end(); } catch (_) { /* */ }
      }
    };
    this.server = this.cfg.tlsCert
      ? https.createServer({ cert: fs.readFileSync(this.cfg.tlsCert), key: fs.readFileSync(this.cfg.tlsKey) }, handler)
      : http.createServer(handler);
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.cfg.port, this.cfg.host, resolve);
    });
    this.port = this.server.address().port;
    this.log(`serving ${this.cfg.tlsCert ? 'https' : 'http'} on ${this.cfg.host}:${this.port}, origin ${this.cfg.origin}, data ${this.cfg.dir}`);
    this.sync().finally(() => this.schedule());
    return this;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.server) {
      if (this.server.closeAllConnections) this.server.closeAllConnections();
      await new Promise((r) => this.server.close(() => r()));
    }
    try { if (this.syncing) await this.syncing; } catch (_) { /* */ }
    this.saveState();
  }
}

/** Streamed sha256 of a file; null when it cannot be read. Never buffered: these reach 500 MB on a Pi. */
function hashFile(file) {
  return new Promise((resolve) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('error', () => resolve(null));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

function main(env = process.env) {
  const { cfg, errors } = readConfig(env);
  if (errors.length) {
    for (const e of errors) console.error(`[site-cache] ${e}`);
    process.exit(78);   // EX_CONFIG, like node-guard: systemd should stop, not loop
  }
  if (cfg.origin.startsWith('http://') && !/^http:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(cfg.origin)) {
    console.warn('[site-cache] ⚠️ SITE_CACHE_FOR is plain http on a public address: the token and the media travel unencrypted.');
  }
  const node = new SiteCacheNode(cfg);
  node.start().catch((e) => { console.error(`[site-cache] could not start: ${e.message}`); process.exit(1); });
  const bye = () => { node.stop().finally(() => process.exit(0)); };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
  return node;
}

module.exports = { SiteCacheNode, readConfig, hashFile, main };

if (require.main === module) main();
