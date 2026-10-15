'use strict';

/*
 * 3.0 news feeds, end to end in a real browser: a news widget page, loaded the way a player loads
 * it, shows the headlines of a local fixture feed — and the browser makes NO request to anything but
 * this server. Not to the feed's publisher, not to its pictures' host, and not to a feed-conversion
 * service. Also: a designer page saved before 3.0 (its ticker called api.rss2json.com) now reads
 * through this server.
 *
 * Every request leaving the page is intercepted; anything not for this server is recorded and
 * aborted, so the test never reaches the internet. SKIPS when Chromium or puppeteer-core is absent.
 */

const os = require('node:os');
const path = require('node:path');
process.env.JWT_SECRET = 'test-secret-news-e2e';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const Database = require('better-sqlite3');

function findChromium() {
  for (const c of [process.env.CHROMIUM_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return null;
}
let puppeteer = null;
try { puppeteer = require('puppeteer-core'); } catch { /* skip */ }
const CHROME = findChromium();
const SKIP = !CHROME || !puppeteer ? 'needs Chromium and puppeteer-core' : false;

// The widgets router reads its rows from this in-memory table (as test/widget-render-xss.test.js does).
const db = new Database(':memory:');
db.exec('CREATE TABLE widgets (id TEXT PRIMARY KEY, widget_type TEXT, config TEXT, workspace_id TEXT, updated_at INTEGER)');
const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const express = require('express');
const news = require('../lib/news-feed');

// 1x1 PNG
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201e2d2f8a90000000049454e44ae426082', 'hex');

let feedSrv, appSrv, feedOrigin, appOrigin, browser;
before(async () => {
  feedSrv = http.createServer((req, res) => {
    if (req.url === '/rss.xml') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title>
        <item><title><![CDATA[First fixture headline & more]]></title><link>${feedOrigin}/a</link><enclosure url="${feedOrigin}/pic.png" type="image/png"/></item>
        <item><title>Second fixture headline</title><link>${feedOrigin}/b</link></item></channel></rss>`);
    }
    if (req.url === '/pic.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => feedSrv.listen(0, '127.0.0.1', r));
  feedOrigin = `http://127.0.0.1:${feedSrv.address().port}`;
  process.env.OUTBOUND_ALLOW_HOSTS = '127.0.0.1';

  const app = express();
  const r = require('../routes/news-feeds');
  app.get('/api/news-feeds/items', r.itemsHandler);
  app.get('/api/news-feeds/image', r.imageHandler);
  app.use('/api/widgets', require('../routes/widgets'));
  appSrv = app.listen(0, '127.0.0.1');
  await new Promise((res) => appSrv.once('listening', res));
  appOrigin = `http://127.0.0.1:${appSrv.address().port}`;

  const seed = (id, type, config) => db.prepare('INSERT INTO widgets (id, widget_type, config, workspace_id, updated_at) VALUES (?,?,?,?,1)').run(id, type, JSON.stringify(config), 'ws1');
  seed('ticker', 'rss', { feed_url: `${feedOrigin}/rss.xml`, max_items: 10 });
  seed('headlines', 'rss', { feed_url: `${feedOrigin}/rss.xml`, layout: 'headlines', interval_sec: 60 });
  seed('legacy', 'text', { html: `<div id="t0">Loading...</div><script>fetch('https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(`${feedOrigin}/rss.xml`)}').then(r=>r.json()).then(d=>{document.getElementById('t0').textContent=d.items.map(i=>i.title).join('  •  ')}).catch(()=>{})</script>` });

  if (!SKIP) browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check'] });
});

after(async () => {
  if (browser) await browser.close().catch(() => {});
  appSrv && appSrv.close();
  feedSrv && feedSrv.close();
  delete process.env.OUTBOUND_ALLOW_HOSTS;
});

/** Open a widget page; returns { page, outside } where outside lists every non-server request (aborted). */
async function open(id) {
  const page = await browser.newPage();
  const outside = [];
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.startsWith(appOrigin + '/') || u.startsWith('data:') || u === 'about:srcdoc' || u === 'about:blank') return req.continue();
    outside.push(u);
    req.abort();
  });
  const response = await page.goto(`${appOrigin}/api/widgets/${id}/render?rev=1`, { waitUntil: 'domcontentloaded' });
  return { page, outside, response };
}

test('ticker: shows the fixture feed\'s headlines, read through this server only', { skip: SKIP }, async () => {
  news._reset();
  const { page, outside, response } = await open('ticker');
  // The page's own policy says the same: data and pictures from this server, nothing else.
  assert.match(response.headers()['content-security-policy'], new RegExp(`connect-src ${appOrigin};`));
  await page.waitForFunction(() => document.body.innerText.includes('Second fixture headline'), { timeout: 15000 });
  const text = await page.evaluate(() => document.body.innerText);
  assert.ok(text.includes('First fixture headline & more'));
  assert.deepEqual(outside, [], 'the screen contacted nothing but this server');
  await page.close();
});

test('headlines: the picture comes from this server\'s image proxy, not the publisher', { skip: SKIP }, async () => {
  news._reset();
  const { page, outside } = await open('headlines');
  const imgRequests = [];
  page.on('requestfinished', (req) => { if (req.url().includes('/api/news-feeds/image')) imgRequests.push(req.response() && req.response().status()); });
  await page.waitForFunction(() => document.querySelector('.hl.on .t') && document.querySelector('.hl.on .t').textContent.includes('First fixture headline'), { timeout: 15000 });
  await page.waitForFunction(() => {
    const p = document.querySelector('.hl.on .pic');
    return p && /\/api\/news-feeds\/image\?/.test(p.style.backgroundImage);
  }, { timeout: 15000 });
  // Background images load after layout; give the request a moment to finish.
  for (let i = 0; i < 50 && !imgRequests.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(imgRequests, [200], 'the picture was served by this server');
  assert.deepEqual(outside, [], 'no request to the feed host or anywhere else');
  await page.close();
});

test('a designer page saved before 3.0 (rss2json in its script) reads through this server now', { skip: SKIP }, async () => {
  news._reset();
  const { page, outside } = await open('legacy');
  // The text widget's frame is sandboxed (opaque origin): its document is not readable from the
  // parent, so check the frame directly.
  await page.waitForFunction(() => !!document.querySelector('iframe'), { timeout: 15000 });
  let frame = null;
  for (let i = 0; i < 50 && !frame; i++) {
    frame = page.frames().find((f) => f !== page.mainFrame()) || null;
    if (!frame) await new Promise((r) => setTimeout(r, 100));
  }
  await frame.waitForFunction(() => document.body.innerText.includes('Second fixture headline'), { timeout: 15000 });
  assert.ok(!outside.some((u) => /rss2json/.test(u)), `no call to rss2json: ${outside.join(', ')}`);
  assert.deepEqual(outside, []);
  await page.close();
});
