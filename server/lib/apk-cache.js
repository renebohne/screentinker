'use strict';
// #146 hardening (Item C) — cache the OTA APK resolution so no /api/update/check or
// /download/apk does a per-request synchronous filesystem call. The path/size/mtime are
// resolved once at boot and refreshed on an interval (like the frontend-hash refresh),
// so a poll/download flood can't turn into an existsSync/statSync flood on the loop.
//
// Two channels. The STABLE slot is the APK every display gets. The BETA slot is optional and
// only reaches displays with devices.ota_beta = 1.
//
// A beta build must DECLARE its version, in a sidecar `<apk>.version` file beside it. The server
// cannot infer it: latest_version on the stable channel is the server's own VERSION constant
// (server and APK ship together), but a beta APK is by definition a different version, and
// reading it out of the APK would mean parsing binary AndroidManifest.xml on the request path.
// A one-line text file is explicit, greppable, and cannot drift silently.
//
// If the sidecar is missing or unparseable the beta channel does NOT activate and opted-in
// displays keep getting stable. Failing closed matters here: advertising a version that does not
// match the bytes actually served is precisely the OTA-loop condition this fleet has been bitten
// by before.

const fs = require('fs');
const path = require('path');
const config = require('../config');

// A copy under DATA_DIR wins (container operators mount /data/ScreenTinker.apk),
// else the legacy in-repo root path — same order as the old resolveApkPath().
function candidates(name) {
  return [path.join(config.dataDir, name), path.join(__dirname, '..', '..', name)];
}

const EMPTY = { path: null, exists: false, size: 0, mtime: 0, version: null };

let stable = { ...EMPTY };
let beta = { ...EMPTY };

function statFirst(name) {
  for (const p of candidates(name)) {
    try {
      const st = fs.statSync(p);
      return { path: p, exists: true, size: st.size, mtime: st.mtimeMs, version: null };
    } catch (_) { /* next */ }
  }
  return { ...EMPTY };
}

// Version declared alongside the APK. First non-empty line, trimmed; anything that is not a
// plausible semver is treated as absent rather than trusted.
function readDeclaredVersion(apkPath) {
  if (!apkPath) return null;
  try {
    const raw = fs.readFileSync(apkPath + '.version', 'utf8');
    const v = String(raw).split('\n')[0].trim();
    return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v) ? v : null;
  } catch (_) { return null; }
}

function refresh() {
  stable = statFirst('ScreenTinker.apk');
  /*
   * #341: THE STABLE SLOT DECLARES ITS VERSION TOO, when it can.
   *
   * The header above assumed "server and APK ship together", so latest_version on stable was the
   * server's own VERSION. That assumption breaks the moment an operator mounts their own APK at
   * /data/ScreenTinker.apk, and it breaks silently and expensively: a server on 2.0.7 serving a
   * 2.0.0 APK offers 2.0.7 to a 2.0.0 device, Android accepts the download as a same-version
   * reinstall, the device returns on 2.0.0, and is offered again. Reported in the field as two
   * displays looping for five days and 493 downloads with nothing failing anywhere.
   *
   * Same sidecar mechanism as beta. Unlike beta this does NOT fail closed: an existing deployment
   * where server and APK really did ship together has no sidecar and must keep working, so an
   * absent sidecar falls back to the server VERSION as before. The caller reads `version` and
   * decides. CI writes the sidecar on release, so from then on the served bytes are self-describing
   * and the fallback only covers hand-mounted APKs.
   */
  stable.version = stable.exists ? readDeclaredVersion(stable.path) : null;
  const b = statFirst('ScreenTinker-beta.apk');
  b.version = b.exists ? readDeclaredVersion(b.path) : null;
  beta = b.exists && b.version ? b : { ...EMPTY };   // no declared version -> no beta channel
  return stable;
}

function get() { return stable; }
function getBeta() { return beta; }

/** The slot to serve for a channel, falling back to stable whenever beta is not usable. */
function forChannel(channel) {
  return channel === 'beta' && beta.exists ? beta : stable;
}

/** Whether a usable beta build is published right now. */
function betaAvailable() { return beta.exists && !!beta.version; }

let timer = null;
function start() {
  refresh();                                   // resolve once at boot
  if (!timer) {
    timer = setInterval(refresh, config.otaApkRefreshMs);
    if (timer.unref) timer.unref();
  }
  return stable;
}

module.exports = { start, refresh, get, getBeta, forChannel, betaAvailable };
