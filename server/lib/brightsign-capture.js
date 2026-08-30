'use strict';

/*
 * Framebuffer capture from the SERVER's own Node process, for a BrightSign running
 * server-on-a-player.
 *
 * ⚠️ WHY THE EXISTING PATHS DO NOT COVER THIS BOX.
 *
 * Every other player is told to capture over its device socket and the page captures itself. A
 * BrightSign page cannot: with hwz enabled the video decodes onto a hardware plane the DOM cannot
 * read, so drawImage() returns a frame with the content missing and throws nothing. st-bridge.js
 * therefore uses BrightSign's own `@brightsign/screenshot`, which composites both planes — and that
 * needs the Node `require` a widget only has when it was created with nodejs_enabled.
 *
 * The server-on-a-player build creates its widget WITHOUT nodejs_enabled (deliberately — see
 * brightsign/server/autorun.brs). So on that box the page-side capture cannot work, and the
 * host-collected fallback in lib/brightsign-snapshot-queue.js has nothing collecting it either:
 * brightsign/server/autorun.brs contains no snapshot code at all, unlike the player autorun which
 * has the full implementation. Measured: screenshots simply do not work on that shape, by either
 * route.
 *
 * ⚠️ BUT THE SERVER THERE IS REAL NODE. It runs under roNodeJs, so `@brightsign/screenshot` is an
 * ordinary import for it — no DWS, no digest auth, no credentials to discover, no page-to-host
 * messaging (which is dead after load on this platform anyway). The same module the widget uses,
 * required from the process that actually has a working `require`.
 *
 * Everything here degrades to null rather than throwing: this is loaded by a server that must keep
 * serving screens on hardware where none of it exists.
 */

/** Volumes to write the capture into, RAM first. */
const CANDIDATE_DIRS = ['/storage/tmp', '/tmp', '/storage/ssd', '/storage/usb1', '/storage/sd', '/storage/flash'];

function tryRequire(name) {
  try { return require(name); } catch (e) { return null; }
}

/** Is this process running on a BrightSign with the capture API available? */
function available() {
  return !!(tryRequire('@brightsign/screenshot') && tryRequire('fs'));
}

/**
 * Where to write. RAM first, deliberately: the remote-control view drives a capture roughly once a
 * second, and a screenshot per second written to boot flash is a wear-out mechanism with no upside —
 * the file is read back and deleted immediately, so it never needs to be durable. The directory
 * must already exist or the capture fails, so each candidate is checked rather than assumed.
 */
function pickDir(fs) {
  for (const d of CANDIDATE_DIRS) {
    try { if (fs.existsSync(d)) return d; } catch (e) { /* keep looking */ }
  }
  return null;
}

/*
 * ⚠️ A UNIQUE FILENAME PER CAPTURE, NOT A FIXED ONE.
 *
 * st-bridge.js writes to a fixed `st-capture.jpg`. Two captures in flight — trivially reachable
 * from the remote-control view at one per second, or from two operators watching the same screen —
 * have one unlinking and rewriting the file the other is about to read. The reader either gets
 * ENOENT or, worse, the OTHER request's frame, which is a picture of the right screen at the wrong
 * moment and looks entirely plausible. A per-call name removes the race rather than narrowing it.
 */
let seq = 0;
function captureName(nowMs) {
  seq = (seq + 1) % 100000;
  return `st-capture-${nowMs}-${seq}.jpg`;
}

/**
 * Capture the composited screen and return it as base64 JPEG, or null if this platform cannot.
 *
 * @param {object} opts { width, height, quality }
 * @returns {Promise<string|null>}
 */
function capture(opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const ScreenshotClass = tryRequire('@brightsign/screenshot');
    const fs = tryRequire('fs');
    if (!ScreenshotClass || !fs) return resolve(null);

    const dir = pickDir(fs);
    if (!dir) return resolve(null);

    const file = `${dir}/${captureName(Date.now())}`;
    const params = {
      destinationFileName: file,
      fileName: file,                 // deprecated alias, still honoured on older firmware
      fileType: 'JPEG',
      width: o.width || 960,
      height: o.height || 540,
      quality: o.quality || 70,
      rotation: 0,
    };

    /*
     * ⚠️ ALWAYS CLEANS UP. A capture that fails part-way still leaves a file behind, and this path
     * runs once a second while somebody watches a screen. On a RAM volume that is a slow leak
     * toward a full /tmp, which breaks far more than screenshots.
     */
    const done = (value) => {
      try { fs.unlinkSync(file); } catch (e) { /* never written, or already gone */ }
      resolve(value);
    };

    try {
      const shot = new ScreenshotClass();
      Promise.resolve(shot.capture(params))
        .then(() => {
          try {
            if (!fs.existsSync(file)) return done(null);
            const buf = fs.readFileSync(file);
            if (!buf || buf.length < 100) return done(null);
            done(buf.toString('base64'));
          } catch (e) { done(null); }
        })
        .catch(() => done(null));
    } catch (e) {
      done(null);
    }
  });
}

module.exports = { available, capture, pickDir, captureName, CANDIDATE_DIRS };
