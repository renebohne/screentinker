'use strict';

/*
 * #630 — "2.6.2 display custom code", in a real headless Chrome against a real server.
 *
 * A display link (`/player?k=…`) opened in a browser that still had storage from an earlier
 * pairing (a UniFi Cast, after its server had been rebuilt) presented the dead stored identity,
 * never the key, and ended up showing a pairing code as a brand-new display. Before the fix the
 * first test here registered as a new display, exactly as reported.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { SKIP, waitFor, startServer, launch, playerPage, player } = require('./helpers/web-player-e2e');

let srv, browser;
before(async () => {
  if (SKIP) return;
  srv = await startServer('wp-enrol');
  browser = await launch(['--autoplay-policy=no-user-gesture-required']);
});
after(async () => {
  try { if (browser) await browser.close(); } catch { /* */ }
  if (srv) srv.stop();
});

/** Open the player for a display link in a fresh browser context (its own storage). */
async function openFresh(url) {
  const ctx = await browser.createBrowserContext();
  const page = await playerPage(ctx);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { ctx, page };
}

describe('#630 a display link wins over identity left in the browser', { skip: SKIP }, () => {
  test('storage from a server that no longer knows it: the link\'s display, not a pairing code', async () => {
    const d = await srv.webPlayerDisplay('UniFi Cast');
    const before = (await srv.api('GET', '/devices')).length;

    const ctx = await browser.createBrowserContext();
    const page = await playerPage(ctx);
    try {
      // The rebuilt-server shape: this origin's storage holds an identity the database never had.
      await page.goto(`${srv.base}/player/check`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.evaluate(() => localStorage.setItem('rd_web_player', JSON.stringify({
        serverUrl: location.origin, deviceId: '00000000-dead-4bad-8bad-000000000000',
        deviceToken: 'f'.repeat(64), paired: true,
      })));
      await page.goto(`${srv.base}/player?k=${encodeURIComponent(d.key)}`, { waitUntil: 'domcontentloaded' });

      const adopted = await waitFor(() => player(page, `config.deviceId === ${JSON.stringify(d.id)} && !!(socket && socket.connected)`), 20000);
      assert.ok(adopted, `expected to become ${d.id}, got ${await player(page, 'config.deviceId')}`);
      const pairingShown = await player(page, "document.getElementById('pairingSection').style.display === 'block'");
      assert.equal(pairingShown, false, 'no pairing code should be shown for a valid display link');
      assert.equal((await srv.api('GET', '/devices')).length, before, 'no extra display may be created');
      assert.deepEqual(page.errors, []);
    } finally { await ctx.close(); }
  });

  test('a working display given a NEW link becomes the link\'s display', async () => {
    const a = await srv.webPlayerDisplay('Old');
    const b = await srv.webPlayerDisplay('New');
    const { ctx, page } = await openFresh(`${srv.base}/player?k=${encodeURIComponent(a.key)}`);
    try {
      assert.ok(await waitFor(() => player(page, `config.deviceId === ${JSON.stringify(a.id)} && socket.connected`), 20000),
        'precondition: registered as the first display');
      await page.goto(`${srv.base}/player?k=${encodeURIComponent(b.key)}`, { waitUntil: 'domcontentloaded' });
      assert.ok(await waitFor(() => player(page, `config.deviceId === ${JSON.stringify(b.id)} && socket.connected`), 20000),
        `expected the new link's display ${b.id}, got ${await player(page, 'config.deviceId')}`);
    } finally { await ctx.close(); }
  });

  test('a link the server does not know says so on screen, beside the pairing code', async () => {
    const { ctx, page } = await openFresh(`${srv.base}/player?k=${'A'.repeat(43)}`);
    try {
      const shown = await waitFor(() => player(page,
        "document.getElementById('pairingSection').style.display === 'block' && document.getElementById('enrolKeyNotice').style.display === 'block'"), 30000);
      assert.ok(shown, 'the pairing code and the explanation should both be on screen');
      const text = await player(page, "document.getElementById('enrolKeyNotice').textContent");
      assert.match(String(text), /display link/i);
    } finally { await ctx.close(); }
  });
});
