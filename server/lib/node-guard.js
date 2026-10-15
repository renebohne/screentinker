'use strict';

/*
 * 3.0: refuse to start on a Node older than engines.node in package.json.
 *
 * 2.x only warned here (preflight-deps.js), on the grounds that refusing would turn an upgrade into
 * an outage. In practice the "mostly still works" case had gone: better-sqlite3 13 SEGFAULTS below
 * Node-API 10 (db/native-floor.js), node:sqlite does not exist on Node 20, and the result was a
 * crash loop under Restart=always whose only log line was a warning a screen above. 3.0 makes the
 * floor a clear, early, single refusal instead.
 *
 * - Builtins only, and required before anything else in server.js, so it can speak on any Node.
 * - The floor is read from package.json, never hard-coded: the BrightSign bundle rewrites engines to
 *   >=24 (scripts/build-server-zip.sh) and must be held to that, not to 22.
 * - Exit 78 (EX_CONFIG). Shipped units carry RestartPreventExitStatus=78 so systemd stops instead of
 *   looping on a host that needs a human to upgrade Node.
 * - ST_ALLOW_OLD_NODE=1 (the same switch scripts/upgrade.sh honours) downgrades this to a warning.
 */

const fs = require('fs');
const path = require('path');

const EXIT_CONFIG = 78;

function parseFloor(range) {
  const m = String(range || '').match(/^>=\s*v?(\d+)\.(\d+)\.(\d+)\s*$/);
  return m ? m.slice(1).map(Number) : null;
}

/** The floor ("22.14.0") this version is below, or null when it meets it or none is declared. */
function belowFloor(range, version) {
  const want = parseFloor(range);
  if (!want) return null;
  const have = String(version).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if (have[i] > want[i]) return null;
    if (have[i] < want[i]) return want.join('.');
  }
  return null;
}

function truthy(v) {
  return ['1', 'true', 'yes'].includes(String(v || '').toLowerCase());
}

function guardNode({
  pkgPath = path.join(__dirname, '..', 'package.json'),
  version = process.versions.node,
  env = process.env,
  log = console.error,
  exit = (code) => process.exit(code),
} = {}) {
  let range;
  try { range = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).engines.node; } catch { return null; }
  const floor = belowFloor(range, version);
  if (!floor) return null;

  const lines = [
    `[node-guard] This ScreenTinker release needs Node.js ${floor} or newer; this is Node ${version}.`,
    `[node-guard]   Running binary: ${process.execPath}`,
    '[node-guard]   Upgrade Node, then start the server again: see "Upgrading Node.js" in docs/operations.md',
    '[node-guard]   (scripts/upgrade.sh can do this for you on Debian/Ubuntu/Raspberry Pi OS).',
  ];
  if (truthy(env.ST_ALLOW_OLD_NODE)) {
    lines.push('[node-guard]   ST_ALLOW_OLD_NODE=1 is set: starting anyway. Expect the database driver to fail.');
    lines.forEach((l) => log(l));
    return floor;
  }
  lines.push('[node-guard]   Set ST_ALLOW_OLD_NODE=1 to start anyway (not supported).');
  lines.forEach((l) => log(l));
  exit(EXIT_CONFIG);
  return floor;
}

module.exports = { guardNode, belowFloor, EXIT_CONFIG };
