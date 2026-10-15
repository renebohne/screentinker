'use strict';

/*
 * The door a SITE CACHE BOX uses (lib/site-cache/node.js; docs/site-cache.md).
 *
 * Authenticated by the box's own token (`Authorization: Bearer stcn_…`, stored here only as a
 * sha256), never by a session or an API token: a cache box is not a person and holds no account.
 * Mounted on its own in server.js, rate-limited per IP like the other machine doors.
 *
 *   GET  /manifest       which screens the box serves, which digests each may fetch, the key that
 *                        checks screen tokens, and how often to ask again (ETag / 304)
 *   GET  /blob/:sha256   the bytes, only for a digest some screen of THIS box is entitled to
 *   POST /report         status for the dashboard (disk, hits, bytes); display only
 *
 * The one write is that cache row's own status columns, so it is not a workspace write in the
 * replica sense (test/scale-out-guards.test.js lists it).
 */

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const router = express.Router();
router.use(require('../lib/backstop-limiter'));
const { db } = require('../db/database');
const config = require('../config');
const origin = require('../lib/site-cache/origin');
const { isSha256 } = require('../lib/site-cache/tokens');

function nodeAuth(req, res, next) {
  const cache = origin.authenticateNode(db, req.headers.authorization);
  // One answer for "no token", "wrong token" and "revoked": the box's operator reads the log on the
  // box, and a probe learns nothing from the difference.
  if (!cache) return res.status(401).json({ error: 'This site cache is not recognised. Check its token in the dashboard.' });
  req.siteCache = cache;
  next();
}
router.use(nodeAuth);

router.get('/manifest', (req, res) => {
  const cache = req.siteCache;
  const { manifest } = origin.manifestFor(db, cache, { fresh: true });
  const body = { ...manifest, fetch_key: cache.enabled ? origin.fetchKeyOf(cache) : null };
  const json = JSON.stringify(body);
  const etag = `"${crypto.createHash('sha256').update(json).digest('hex').slice(0, 32)}"`;
  origin.touchSeen(db, cache);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.type('application/json').send(json);
});

router.post('/report', express.json({ limit: '16kb' }), (req, res) => {
  origin.recordReport(db, req.siteCache, req.body);
  res.json({ ok: true });
});

router.get('/blob/:sha', async (req, res) => {
  const sha = String(req.params.sha || '');
  if (!isSha256(sha)) return res.status(404).json({ error: 'Not found' });
  const row = origin.contentForBlob(db, req.siteCache, sha);
  // Not entitled and not held look the same from outside, so a guessed digest learns nothing.
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('ETag', `"${sha}"`);
  const abs = path.resolve(config.contentDir, path.basename(String(row.filepath)));
  if (!abs.startsWith(path.resolve(config.contentDir))) return res.status(404).json({ error: 'Not found' });
  if (fs.existsSync(abs)) {
    // octet-stream: the box stores bytes by digest and serves them with the manifest's type; nothing
    // here is ever rendered.
    return res.sendFile(abs, { headers: { 'Content-Type': 'application/octet-stream' }, etag: false, lastModified: false });
  }
  const storageServe = require('../lib/storage/serve');
  if (storageServe.storedElsewhere(row)) {
    return storageServe.serveFromStorage(req, res, row, 'asset', {
      harden: (r) => r.setHeader('Content-Type', 'application/octet-stream'),
      cacheControl: 'private, no-store',
    });
  }
  return res.status(404).json({ error: 'Not found' });
});

module.exports = router;
