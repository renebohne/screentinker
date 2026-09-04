'use strict';

/*
 * #329: sssp_config.xml reports the .wgt size in KILOBYTES. We wrote bytes.
 *
 * A Samsung panel fetches this manifest, reads <size>, then downloads the .wgt. Given a byte
 * count it refuses the install with "Unable to install. Please try again later." — which names
 * neither the size nor the unit, so the only way to find it is to correct the number by hand and
 * watch the identical file install. Reported from an OM55B (Tizen 5.0 / SSSP v6) against a
 * 126929-byte build that had to read 124.
 *
 * Both producers had it: server/lib/wgt-cache.js serves the manifest dynamically, and
 * tizen/build-wgt.sh writes the static copy for CDN hosting. Fixing one would have left every
 * panel that takes the other route still failing, so both are covered here.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const wgtCache = require('../lib/wgt-cache');

const sizeOf = (xml) => Number(/<size>(\d+)<\/size>/.exec(xml)[1]);

test('#329: the reported size is kilobytes, not the byte count', () => {
  // The exact case from the report.
  const xml = wgtCache.ssspConfigXml({ version: '2.0.7', size: 126929 });
  assert.equal(sizeOf(xml), 124, '126929 bytes must advertise as 124 KB');
  assert.notEqual(sizeOf(xml), 126929, 'the byte count is what the panel refuses');
});

test('#329: a partial last kilobyte rounds UP, never down', () => {
  // Under-reporting is indistinguishable from a truncated download, so the remainder always
  // costs a whole kilobyte.
  assert.equal(wgtCache.sizeKb(1025), 2);
  assert.equal(wgtCache.sizeKb(2047), 2);
  assert.equal(wgtCache.sizeKb(1), 1, 'a file that exists is never advertised as 0 KB');
});

test('#329: an exact multiple of 1024 does not gain a phantom kilobyte', () => {
  assert.equal(wgtCache.sizeKb(1024), 1);
  assert.equal(wgtCache.sizeKb(2048), 2);
  assert.equal(wgtCache.sizeKb(126976), 124);
});

test('#329: no .wgt reports 0, not 1', () => {
  // The route 404s before it renders a manifest, but the helper must not invent a kilobyte for a
  // file that is not there.
  assert.equal(wgtCache.sizeKb(0), 0);
  assert.equal(wgtCache.sizeKb(undefined), 0);
  assert.equal(wgtCache.sizeKb(null), 0);
  assert.equal(wgtCache.sizeKb(-5), 0);
  assert.equal(wgtCache.sizeKb('nonsense'), 0);
});

test('#329: the rest of the manifest is unchanged', () => {
  // Only the unit moved. A panel keys off widgetname to find <widgetname>.wgt beside the manifest,
  // and re-installs when <ver> changes; breaking either while fixing the size would be worse than
  // the bug.
  const xml = wgtCache.ssspConfigXml({ version: '2.0.7', size: 126929 });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<ver>2\.0\.7<\/ver>/);
  assert.match(xml, /<widgetname>ScreenTinker<\/widgetname>/);
  assert.match(xml, /<webtype>tizen<\/webtype>/);
});

test('#329: build-wgt.sh writes kilobytes too, not just the server', () => {
  // The static copy is the CDN/bucket route. It is a shell script, so this asserts on the source:
  // the division has to be there, and the raw byte count must not be what reaches <size>.
  const sh = fs.readFileSync(path.join(__dirname, '..', '..', 'tizen', 'build-wgt.sh'), 'utf8');
  assert.match(sh, /WGT_SIZE=\$\(\(\s*\(WGT_BYTES \+ 1023\) \/ 1024\s*\)\)/,
    'the byte count must be divided by 1024, rounded up');
  assert.match(sh, /<size>\$\{WGT_SIZE\}<\/size>/, '<size> reads the converted value');
  assert.doesNotMatch(sh, /<size>\$\{WGT_BYTES\}<\/size>/, 'and never the raw byte count');
});
