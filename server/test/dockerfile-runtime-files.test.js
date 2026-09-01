'use strict';

/*
 * ⚠️ EVERY REPO-ROOT FILE THE SERVER READS AT RUNTIME MUST BE IN THE IMAGE.
 *
 * The server is built from `server/`, but a handful of things it reads live one level up, at the
 * repo root — VERSION, and the release notes. The Dockerfile copies `server/` wholesale and then
 * names those root files ONE BY ONE, so adding a new one is a silent two-place change: the feature
 * works in development, every unit test passes because it reads the source tree, and the file is
 * simply absent in the container.
 *
 * That is not hypothetical. 2.0.1 shipped the "what's new" panel and did not ship
 * release-notes.json, so `/api/release-notes` answered `current: null` on every containerised
 * install. It was found by deploying it, which is the expensive way to find it.
 *
 * This test reads the paths out of the SOURCE rather than listing them, so a new root-file read is
 * caught the day it is written.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

/** Every `path.join(__dirname, '..', '..', <name>)` in server code — i.e. a read of the repo root. */
function rootReads() {
  const dirs = ['lib', 'routes', 'services', 'middleware', 'db', 'ws'];
  const found = new Set();
  const re = /__dirname,\s*'\.\.',\s*'\.\.',\s*'([^']+)'/g;
  for (const d of dirs) {
    const dir = path.join(__dirname, '..', d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      let m;
      while ((m = re.exec(src))) found.add(m[1]);
    }
  }
  return [...found];
}

test('the Dockerfile ships every repo-root file the server reads', () => {
  const reads = rootReads();
  assert.ok(reads.length > 0, 'found no root reads at all — the detection regex has drifted');

  for (const name of reads) {
    /*
     * Only files that EXIST in the repo are required to be copied. The rest are optional release
     * artifacts fetched or mounted at deploy time — a .wgt and an .apk are built by the release
     * workflow and bind-mounted, so demanding a COPY for them would fail the build for a file the
     * repo does not contain.
     */
    const abs = path.join(ROOT, name);
    if (!fs.existsSync(abs)) continue;
    /*
     * FILES only. A multi-segment join like ('..','..','tizen','ScreenTinker.wgt') captures its
     * first segment here, which is a DIRECTORY — and `tizen/` is deliberately not in the image:
     * what the server wants out of it is a signed .wgt built by the release workflow and mounted at
     * deploy time, not the Tizen sources. Directories have their own COPY lines with their own
     * reasons; this test is about the loose root files that are easy to forget.
     */
    if (!fs.statSync(abs).isFile()) continue;

    const copied = new RegExp(`^COPY\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'm').test(dockerfile)
      || new RegExp(`^COPY\\s+\\S*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'm').test(dockerfile);

    assert.ok(copied,
      `server code reads ${name} from the repo root, but the Dockerfile never copies it — ` +
      'it will be missing in the container while every test here still passes');
  }
});

test('release-notes.json specifically, because that is the one that shipped broken', () => {
  assert.match(dockerfile, /^COPY release-notes\.json /m,
    'the what’s-new panel is empty in the container without this line');
});
