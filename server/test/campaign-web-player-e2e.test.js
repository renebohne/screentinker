'use strict';

/*
 * 3.0 campaigns in a real headless Chrome running the real web player against a real server
 * (docs/layouts-and-campaigns.md): layout A (two zones, each with its own content) -> a full-screen
 * video -> layout B -> loop. The player must switch WHOLE layouts in that order, put each zone's
 * content in its zone, hold each step for its duration, and loop; and it must record proof of play
 * for the layouts and the zone items.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SKIP, sleep, waitFor, startServer, launch, playerPage, player } = require('./helpers/web-player-e2e');

const CLIP = path.join(__dirname, 'fixtures', 'media', 'clip-3s.webm');
// A 2x2 PNG (red), written out per image so each upload is its own content row.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');

let srv, browser;
before(async () => {
  if (SKIP) return;
  srv = await startServer('campaign');
  browser = await launch(['--autoplay-policy=no-user-gesture-required']);
});
after(async () => {
  try { if (browser) await browser.close(); } catch { /* */ }
  if (srv) srv.stop();
});

async function image(name) {
  const f = path.join(os.tmpdir(), `st-camp-${process.pid}-${name}`);
  fs.writeFileSync(f, PNG);
  try { return await srv.upload(f, 'image/png'); } finally { try { fs.unlinkSync(f); } catch { /* */ } }
}

describe('a campaign switches whole layouts in the web player', { skip: SKIP }, () => {
  test('layout A -> full-screen video -> layout B, with zone content and durations, and it loops', async () => {
    const d = await srv.webPlayerDisplay('Campaign screen');
    const [m1, m2, side, top] = [await image('m1.png'), await image('m2.png'), await image('side.png'), await image('top.png')];
    const clip = await srv.upload(CLIP, 'video/webm');
    const A = await srv.api('POST', '/layouts', { name: 'Layout A', zones: [
      { name: 'Main', x_percent: 0, y_percent: 0, width_percent: 70, height_percent: 100 },
      { name: 'Side', x_percent: 70, y_percent: 0, width_percent: 30, height_percent: 100 }] });
    const B = await srv.api('POST', '/layouts', { name: 'Layout B', zones: [
      { name: 'Top', x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 50 },
      { name: 'Bottom', x_percent: 0, y_percent: 50, width_percent: 100, height_percent: 50 }] });
    const zid = (l, n) => l.zones.find((z) => z.name === n).id;
    // A's main zone plays its own playlist; its side zone the item placed in it.
    const menu = await srv.api('POST', '/playlists', { name: 'Menu' });
    await srv.api('POST', `/playlists/${menu.id}/items`, { content_id: m1.id, duration_sec: 2 });
    await srv.api('POST', `/playlists/${menu.id}/items`, { content_id: m2.id, duration_sec: 2 });
    await srv.api('POST', `/playlists/${menu.id}/publish`);

    const pl = await srv.api('POST', '/playlists', { name: 'Campaign' });
    await srv.api('POST', `/playlists/${pl.id}/items`, { layout_ref_id: A.id, duration_sec: 4, zone_sources: { [zid(A, 'Main')]: menu.id } });
    await srv.api('POST', `/playlists/${pl.id}/items`, { content_id: side.id, zone_id: zid(A, 'Side'), duration_sec: 10 });
    await srv.api('POST', `/playlists/${pl.id}/items`, { content_id: clip.id });
    await srv.api('POST', `/playlists/${pl.id}/items`, { layout_ref_id: B.id, duration_sec: 4 });
    await srv.api('POST', `/playlists/${pl.id}/items`, { content_id: top.id, zone_id: zid(B, 'Top'), duration_sec: 10 });
    await srv.api('POST', `/playlists/${pl.id}/publish`);
    await srv.api('POST', `/playlists/${pl.id}/assign`, { device_id: d.id });

    const ctx = await browser.createBrowserContext();
    const page = await playerPage(ctx);
    try {
      await page.goto(`${srv.base}/player?k=${encodeURIComponent(d.key)}`, { waitUntil: 'domcontentloaded' });
      assert.ok(await waitFor(() => player(page, 'campaignActive()'), 30000), 'the player adopted the campaign');

      // Sample the stage until two full loops have been seen.
      const seen = [];
      const until = Date.now() + 40000;
      while (Date.now() < until) {
        const s = await player(page, `(() => {
          const st = [...document.querySelectorAll('#playerContainer > .campaign-stage')].pop();
          if (!st) return null;
          const zones = [...st.querySelectorAll(':scope > .zone')].map((z) => ({
            zone: z.dataset.zone, img: (z.querySelector('img') || {}).src || null, video: !!z.querySelector('video'),
            w: z.style.width, h: z.style.height }));
          return { step: Number(st.dataset.step), layout: st.dataset.layout || null, zones, at: Date.now() };
        })()`);
        if (s && (!seen.length || seen[seen.length - 1].step !== s.step)) seen.push(s);
        if (seen.length >= 7) break;
        await sleep(150);
      }
      const order = seen.map((s) => s.step);
      assert.deepEqual(order.slice(0, 7), [0, 1, 2, 0, 1, 2, 0], `step order ${JSON.stringify(order)}`);

      const a = seen[0];
      assert.equal(a.layout, A.id);
      assert.deepEqual(a.zones.map((z) => z.zone).sort(), [zid(A, 'Main'), zid(A, 'Side')].sort(), 'both zones of A are drawn');
      const main = a.zones.find((z) => z.zone === zid(A, 'Main'));
      assert.equal(main.w, '70%');
      assert.ok(main.img && main.img.includes(m1.filepath), "A's main zone shows the menu playlist");
      assert.ok(a.zones.find((z) => z.zone === zid(A, 'Side')).img.includes(side.filepath), "A's side zone shows its own item");

      const v = seen[1];
      assert.equal(v.layout, null, 'the video step is full screen, not a layout');
      assert.equal(v.zones.length, 1);
      assert.equal(v.zones[0].video, true);
      assert.equal(v.zones[0].w, '', 'full screen (inset 0)');

      const b = seen[2];
      assert.equal(b.layout, B.id);
      assert.deepEqual(b.zones.map((z) => z.zone), [zid(B, 'Top')], 'an empty zone draws nothing');
      assert.ok(b.zones[0].img.includes(top.filepath));

      // Durations: each layout held ~4 s, the clip ~3 s (it plays to its end).
      const dur = (i) => (seen[i + 1].at - seen[i].at) / 1000;
      assert.ok(Math.abs(dur(0) - 4) < 1.5, `layout A held ${dur(0)} s`);
      assert.ok(dur(1) > 2 && dur(1) < 6, `video step held ${dur(1)} s`);
      assert.ok(Math.abs(dur(2) - 4) < 1.5, `layout B held ${dur(2)} s`);
      // Only one stage remains after a switch (the old one is released after the fade).
      assert.ok(await player(page, 'document.querySelectorAll("#playerContainer > .campaign-stage").length') <= 2);
      assert.deepEqual(page.errors, [], 'the player threw');

      // Proof of play: the layouts, and the zone items with the layout they played in.
      const Database = require('better-sqlite3');
      const ro = new Database(path.join(srv.dataDir, 'db', 'remote_display.db'), { readonly: true });
      try {
        const layouts = ro.prepare("SELECT layout_id FROM play_logs WHERE device_id = ? AND trigger_type = 'layout'").all(d.id).map((r) => r.layout_id);
        assert.ok(layouts.includes(A.id) && layouts.includes(B.id), `layout plays: ${JSON.stringify(layouts)}`);
        const zoneRows = ro.prepare('SELECT COUNT(*) AS n FROM play_logs WHERE device_id = ? AND layout_id IS NOT NULL AND content_id IS NOT NULL').get(d.id).n;
        assert.ok(zoneRows > 0, 'zone items recorded with their layout');
      } finally { ro.close(); }

      // Turning the campaign back into an ordinary playlist hands the stage back.
      const items = await srv.api('GET', `/playlists/${pl.id}/items`);
      for (const it of items.filter((x) => x.layout_ref_id)) await srv.api('DELETE', `/playlists/${pl.id}/items/${it.id}`);
      await srv.api('POST', `/playlists/${pl.id}/publish`);
      assert.ok(await waitFor(() => player(page, '!campaignActive() && playlist.length > 0'), 15000), 'the campaign stopped and the playlist plays');
      assert.equal(await player(page, 'document.querySelectorAll("#playerContainer > .campaign-stage").length'), 0);
    } finally { await ctx.close(); }
  });
});
