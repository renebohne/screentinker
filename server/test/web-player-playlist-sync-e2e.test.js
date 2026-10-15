'use strict';

/*
 * #632 — "Chrome on Linux not updating when making changes", in a real headless Chrome against a
 * real server.
 *
 * An item added to a ONE-item playlist reached the player (the socket push and the 5-minute
 * refresh both delivered it) but never reached the SCREEN: the only item had been rendered to hold
 * — a video with `loop` set never fires `ended` — and the continuity branch kept it playing,
 * waiting for an advance that could not come. A browser restart "fixed" it because the clip was
 * then rendered into a two-item playlist. Before the fix this test held item 1 of 2 for the whole
 * wait.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { SKIP, waitFor, startServer, launch, playerPage, player } = require('./helpers/web-player-e2e');

const CLIP = path.join(__dirname, 'fixtures', 'media', 'clip-3s.webm');

let srv, browser;
before(async () => {
  if (SKIP) return;
  srv = await startServer('wp-sync');
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

describe('#632 a playlist change reaches the screen, not just the player', { skip: SKIP }, () => {
  test('an item added to a one-video playlist is shown, without a reload', async () => {
    const d = await srv.webPlayerDisplay('Linux Chrome');
    const clip = await srv.upload(CLIP, 'video/webm');
    const clock = await srv.api('POST', '/widgets', { widget_type: 'clock', name: 'Added later', config: {} });
    const pl = await srv.api('POST', '/playlists', { name: 'One clip' });
    await srv.api('POST', `/playlists/${pl.id}/items`, { content_id: clip.id });
    await srv.api('POST', `/playlists/${pl.id}/publish`);
    await srv.api('POST', `/playlists/${pl.id}/assign`, { device_id: d.id });

    const { ctx, page } = await openFresh(`${srv.base}/player?k=${encodeURIComponent(d.key)}`);
    try {
      // The single clip is on screen and, being the only item, held by looping.
      const holding = await waitFor(() => player(page,
        'playlist.length === 1 && !!currentVideoEl && currentVideoEl.loop === true && !currentVideoEl.paused'), 30000);
      assert.ok(holding, 'precondition: the one-item playlist is playing its clip on a loop');

      await srv.api('POST', `/playlists/${pl.id}/items`, { widget_id: clock.id, duration_sec: 10 });
      await srv.api('POST', `/playlists/${pl.id}/publish`);

      assert.ok(await waitFor(() => player(page, 'playlist.length === 2'), 10000), 'the update reached the player');
      // The clip is 3 s: it finishes its current pass and the new item comes up. Before the fix it
      // looped forever and this stayed at index 0.
      const shown = await waitFor(() => player(page, 'currentIndex === 1'), 15000);
      assert.ok(shown, `the added item never reached the screen (still on item ${await player(page, 'currentIndex')} of 2)`);
      assert.deepEqual(page.errors, [], 'the player threw');
    } finally { await ctx.close(); }
  });
});
