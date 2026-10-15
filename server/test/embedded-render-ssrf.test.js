'use strict';

/*
 * The e-ink widget / layout render path runs tenant-authored HTML in a server-side Chromium. It
 * must vet every request the page makes exactly like the raster path does — otherwise a layout zone
 * whose remote_url is http://169.254.169.254/ comes back as a PNG of the metadata page through
 * GET /api/embedded/render-layout?preview=1.
 *
 * No Chromium here: the request guard is driven with a fake page (the same interface puppeteer
 * exposes), and the wiring into renderWidgetOrHtml is pinned at the source.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), 'st-embed-ssrf-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { guardRasterRequests, safeZoneRemoteUrl } = require('../lib/embedded-render');

function fakePage() {
  let handler = null;
  return {
    intercepting: false,
    setRequestInterception(v) { this.intercepting = v; return Promise.resolve(); },
    on(ev, fn) { if (ev === 'request') handler = fn; },
    async request(url, method = 'GET') {
      let verdict = null;
      await handler({
        url: () => url, method: () => method,
        continue: async () => { verdict = 'continue'; },
        abort: async () => { verdict = 'abort'; },
      });
      return verdict;
    },
  };
}

test('the request guard: own origin GET only, metadata / private aborted, data: passes', async () => {
  const page = fakePage();
  await guardRasterRequests(page, 'http://127.0.0.1:3001');
  assert.equal(page.intercepting, true);
  assert.equal(await page.request('http://127.0.0.1:3001/uploads/content/a.png'), 'continue');
  assert.equal(await page.request('http://127.0.0.1:3001/api/devices', 'POST'), 'abort');
  assert.equal(await page.request('http://169.254.169.254/latest/meta-data/'), 'abort');
  assert.equal(await page.request('http://10.0.0.1/'), 'abort');
  assert.equal(await page.request('http://127.0.0.1:22/'), 'abort', 'another loopback port is not this server');
  assert.equal(await page.request('data:image/png;base64,AAAA'), 'continue');
});

test('a layout zone remote_url is vetted before it is emitted', async () => {
  assert.equal(await safeZoneRemoteUrl('http://169.254.169.254/latest/meta-data/'), null);
  assert.equal(await safeZoneRemoteUrl('http://192.168.1.1/admin'), null);
  assert.equal(await safeZoneRemoteUrl('file:///etc/passwd'), null);
  assert.equal(await safeZoneRemoteUrl('http://1.1.1.1/x.png'), 'http://1.1.1.1/x.png');
});

test('renderWidgetOrHtml installs the guard before loading the HTML (source)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'embedded-render.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function renderWidgetOrHtml'), src.indexOf('async function renderRemotePage'));
  const guard = fn.indexOf('guardRasterRequests(page');
  assert.ok(guard > 0, 'renderWidgetOrHtml must vet requests');
  assert.ok(guard < fn.indexOf('page.setContent('), 'the guard must be installed before setContent');
  const layout = src.slice(src.indexOf('async function renderLayout'));
  assert.ok(layout.indexOf('safeZoneRemoteUrl(content.remote_url)') > 0, 'zone remote_url is vetted');
  assert.ok(layout.indexOf('safeZoneRemoteUrl(content.remote_url)') < layout.indexOf('<iframe src="${escapeHtmlAttr(content.remote_url)}'));
});
