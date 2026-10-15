'use strict';

/*
 * Dashboard: a login that stops being valid while the page is open ends at the sign-in page, not on a
 * "Disconnected" badge forever.
 *
 * Reported from daily use: a tab left open on screentinker.com showed "Disconnected" for good, while
 * a private window worked. The server refuses the live socket of an expired/revoked login in its auth
 * middleware, and Socket.IO never retries a middleware refusal, so nothing told the page to sign in
 * again until some REST call happened to return 401.
 *
 * Skips cleanly when there is no Chrome or no puppeteer-core, like the other browser suites.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { SKIP, waitFor, startServer, launch } = require('./helpers/web-player-e2e');

let srv, browser, page;

before(async () => {
  if (SKIP) return;
  srv = await startServer('session-expired');
  browser = await launch();
  page = await browser.newPage();
  await page.goto(`${srv.base}/app#/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((tok) => {
    localStorage.setItem('token', tok);
    localStorage.setItem('rd_onboarded', '1');
  }, srv.token);
});
after(async () => {
  try { if (browser) await browser.close(); } catch { /* */ }
  if (srv) srv.stop();
});

test('a revoked login drops the live connection to the sign-in page', { skip: SKIP, timeout: 90000 }, async () => {
  await page.goto(`${srv.base}/app#/`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });   // same-document hash change: boot again with the token
  const connected = () => page.evaluate(() => {
    const el = document.getElementById('connectionStatus');
    return !!el && /connected/i.test(el.textContent) && !/disconnected/i.test(el.textContent);
  });
  const ok = await waitFor(connected, 20000);
  assert.ok(ok, 'the dashboard connects first');

  // "Sign out everywhere else" from another place: the page's token is now dead.
  const r = await srv.api('POST', '/auth/sessions/revoke-others');
  assert.ok(r.ok, 'sessions revoked');

  // The connection drops (network blip, server restart…); the reconnect is refused by the auth check.
  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await new Promise((res) => setTimeout(res, 3000));
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  const atLogin = await waitFor(() => page.evaluate(() => location.hash.startsWith('#/login') && !localStorage.getItem('token')).catch(() => false), 30000);
  assert.ok(atLogin, 'the page went to sign-in with the dead token cleared');
});
