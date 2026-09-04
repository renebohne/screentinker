'use strict';

// Resolve the Tizen .wgt for the SSSP URL-Launcher install flow (mirrors lib/apk-cache.js).
// The path/size/mtime are resolved once at boot and refreshed on an interval, so a panel
// polling /tizen/sssp_config.xml can never turn into a per-request statSync flood.
//
// The SIGNED .wgt is provided out-of-band (like the APK): container operators mount it at
// /data/ScreenTinker.wgt. The in-repo tizen/ copy (usually unsigned, inspection-only) is a
// last-resort fallback so a dev box still serves *something*.
//
// size is the load-bearing field, and its UNIT is the thing that bites: sssp_config.xml reports
// KILOBYTES, not bytes (#329). We stored and emitted the byte length, so a 126929-byte .wgt
// advertised <size>126929</size> and an OM55B refused it with "Unable to install. Please try
// again later." — no clue that a unit was the problem. Correcting the value by hand to 124 made
// the same file install. cache.size stays in BYTES (the landing page renders MB from it); only
// ssspConfigXml() converts, so there is exactly one place that knows the manifest's unit.

const fs = require('fs');
const path = require('path');
const config = require('../config');

function candidates() {
  return [
    path.join(config.dataDir, 'ScreenTinker.wgt'),          // operator mount (signed) — wins
    path.join(__dirname, '..', '..', 'ScreenTinker.wgt'),   // repo root (release artifact)
    path.join(__dirname, '..', '..', 'tizen', 'ScreenTinker.wgt'), // in-repo build (usually unsigned)
  ];
}

// Version reported in sssp_config.xml <ver>. A panel re-installs when this changes, so it must
// bump on each release — hence the app version (single source: package.json), overridable via env
// when an operator hosts a differently-versioned signed build.
const VERSION = process.env.TIZEN_WGT_VER || (() => {
  try { return require('../package.json').version; } catch (_) { return '1.0.0'; }
})();

let cache = { path: null, exists: false, size: 0, mtime: 0, version: VERSION };

function refresh() {
  for (const p of candidates()) {
    try {
      const st = fs.statSync(p);
      cache = { path: p, exists: true, size: st.size, mtime: st.mtimeMs, version: VERSION };
      return cache;
    } catch (_) { /* next candidate */ }
  }
  cache = { path: null, exists: false, size: 0, mtime: 0, version: VERSION };
  return cache;
}

function get() { return cache; }

let timer = null;
function start() {
  refresh();
  if (!timer) {
    timer = setInterval(refresh, config.otaApkRefreshMs);  // reuse the APK refresh cadence
    if (timer.unref) timer.unref();
  }
  return cache;
}

// The SSSP manifest the panel fetches at <entered-url>/sssp_config.xml. widgetname (no extension)
// tells the panel to download <widgetname>.wgt from the same directory — we serve it at
// /tizen/ScreenTinker.wgt. webtype=tizen marks it a Tizen web app.
// Bytes -> kilobytes for the manifest, rounded UP. Rounding up rather than down on purpose: the
// value tells the panel how much to expect, and under-reporting a partial last KB is what a
// truncated download looks like. A file that exists always advertises at least 1.
function sizeKb(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(n / 1024);
}

function ssspConfigXml(wgt = cache) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<widget>
\t<ver>${wgt.version}</ver>
\t<size>${sizeKb(wgt.size)}</size>
\t<widgetname>ScreenTinker</widgetname>
\t<webtype>tizen</webtype>
</widget>
`;
}

module.exports = { start, refresh, get, ssspConfigXml, sizeKb, WIDGET_NAME: 'ScreenTinker' };
