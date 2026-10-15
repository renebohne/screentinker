'use strict';

/*
 * 3.0 display-link MIRRORS, END TO END in headless Chrome: "a mirror shows everything its display
 * shows". The bug reports: Display 2 open through its display link in one browser, the same link in
 * a second browser became "Display 2 (mirror 1)", and
 *
 *   1. a screen share to Display 2 from the dashboard's "Share my screen" showed on the original only
 *      (the mirror kept saying "Waiting for content"), and the meeting-room code was on the original
 *      only;
 *   2. the mirror never had a preview (no stored screenshot, "No preview available") and its device
 *      page said nothing was playing.
 *
 * Real server, real web players (one browser context each, like two machines), the REAL dashboard UI
 * for the share (device page -> "Share my screen", fake capture), and the real /share page for the
 * guest:
 *
 *   a. remote view: a screenshot request for the mirror reaches the mirror's page only, the frame
 *      comes back tagged with the mirror's id, it is stored under that id (the screens list has a
 *      screenshot_at for it), and the original's frame stays the original's;
 *   b. the mirror's device page says what it plays: "Mirroring Display 2: playing <playlist>";
 *   c. the dashboard's single-screen share to the original plays on the original AND the mirror;
 *      Stop on the dashboard ends both;
 *   d. the mirror shows the same meeting-room code as the original; a guest who types the code read
 *      off the mirror presents to both; the guest's Stop ends both.
 *
 * Skips cleanly without Chrome / puppeteer-core.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SKIP, waitFor, sleep, startServer, launch, player } = require('./helpers/web-player-e2e');

let srv, browser, tmp, red;

async function solidPng(file, rgba) {
  const { Jimp } = require('jimp');
  const img = new Jimp({ width: 320, height: 180, color: rgba });
  fs.writeFileSync(file, await img.getBuffer('image/png'));
  return file;
}

async function playOn(deviceId, file, name) {
  const c = await srv.upload(file, 'image/png');
  const pl = await srv.api('POST', '/playlists', { name });
  await srv.api('POST', `/playlists/${pl.id}/items`, { content_id: c.id });
  await srv.api('POST', `/playlists/${pl.id}/publish`);
  await srv.api('POST', `/playlists/${pl.id}/assign`, { device_id: deviceId });
  return c.id;
}

async function pageIn(ctx) {
  const page = await ctx.newPage();
  page.errors = [];
  page.logs = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => page.logs.push(m.text()));
  await page.setViewport({ width: 960, height: 540 });
  return page;
}

let dash;
async function dashboardSocket() {
  if (dash && dash.connected) return dash;
  const { io } = require('socket.io-client');
  dash = io(srv.base + '/dashboard', { auth: { token: srv.token }, transports: ['websocket'] });
  await new Promise((res, rej) => { dash.once('connect', res); dash.once('connect_error', rej); });
  return dash;
}

/** Ask for a frame as the remote viewer does; resolves the FIRST screenshot-ready of any id, or null. */
async function requestFrame(deviceId) {
  const s = await dashboardSocket();
  const got = [];
  const h = (m) => got.push(m);
  s.on('dashboard:screenshot-ready', h);
  s.emit('dashboard:request-screenshot', { device_id: deviceId });
  await waitFor(() => got.find((m) => m.device_id === deviceId), 20000, 500);
  s.off('dashboard:screenshot-ready', h);
  return got;
}

const connectedAs = (page, id) => player(page, `!!(socket && socket.connected) && config.deviceId === ${JSON.stringify(id)}`);
const playingContent = (page, contentId) => player(page, `playlist.length === 1 && playlist[0].content_id === ${JSON.stringify(contentId)}`);

/** The player's share <video>, or null when no share is on screen. */
const videoState = (page) => page.evaluate(() => {
  const v = document.getElementById('st-share-video');
  const o = document.getElementById('st-share-overlay');
  if (!v || !o) return null;
  return { readyState: v.readyState, paused: v.paused, w: v.videoWidth, t: v.currentTime, badge: (document.getElementById('st-share-badge') || {}).textContent || '' };
}).catch(() => null);

async function assertPlaying(page, label) {
  const s1 = await waitFor(async () => {
    const s = await videoState(page);
    return s && s.readyState >= 2 && s.w > 0 && !s.paused ? s : null;
  }, 30000, 300);
  assert.ok(s1, label + ': a playing share <video>');
  await sleep(1200);
  const s2 = await videoState(page);
  assert.ok(s2 && s2.t > s1.t, `${label}: video time advances`);
  return s2;
}

const codeOn = (page) => page.evaluate(() => {
  const el = document.getElementById('st-share-code');
  const c = el && el.querySelector('[data-share-code]');
  return el && el.style.display !== 'none' && c ? c.textContent : null;
}).catch(() => null);

before(async () => {
  if (SKIP) return;
  srv = await startServer('share-mirrors');
  browser = await launch([
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--auto-select-desktop-capture-source=Entire screen',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  ]);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sm-media-'));
  red = await solidPng(path.join(tmp, 'red.png'), 0xdd1111ff);
});
after(async () => {
  try { if (dash) dash.close(); } catch { /* */ }
  try { if (browser) await browser.close(); } catch { /* */ }
  if (srv) srv.stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('display-link mirrors: everything the display shows', { skip: SKIP }, () => {
  test('remote view, now playing, the dashboard share and the meeting-room code all reach the mirror', { timeout: 400000 }, async () => {
    const d = await srv.webPlayerDisplay('Display 2');
    const cRed = await playOn(d.id, red, 'Lobby loop');
    await srv.api('PUT', `/screen-share/devices/${d.id}/guest`, { enabled: true });
    const link = `${srv.base}/player?k=${encodeURIComponent(d.key)}`;
    const ctxA = await browser.createBrowserContext();
    const ctxB = await browser.createBrowserContext();
    const ctxD = await browser.createBrowserContext();
    const ctxG = await browser.createBrowserContext();
    try {
      const pA = await pageIn(ctxA);
      await pA.goto(link, { waitUntil: 'domcontentloaded' });
      assert.ok(await waitFor(async () => (await connectedAs(pA, d.id)) && (await playingContent(pA, cRed)), 40000), 'the first opening is the display');
      const pB = await pageIn(ctxB);
      await pB.goto(link, { waitUntil: 'domcontentloaded' });
      const mirror = await waitFor(async () => {
        const row = await srv.api('GET', `/devices/${d.id}`).catch(() => null);
        return row && row.mirrors && row.mirrors.length === 1 ? row.mirrors[0] : null;
      }, 40000);
      assert.ok(mirror, 'the second opening is a mirror');
      assert.equal(mirror.name, 'Display 2 (mirror 1)');
      assert.ok(await waitFor(async () => (await connectedAs(pB, mirror.id)) && (await playingContent(pB, cRed)), 40000), 'the mirror plays the display\'s content');

      // ---- a. remote view: the mirror's frame, under the mirror's id, stored under it.
      const asked = (p) => p.logs.filter((l) => l === 'Screenshot requested').length;
      const [a0, b0] = [asked(pA), asked(pB)];
      const frames = await waitFor(async () => {
        const got = await requestFrame(mirror.id).catch(() => []);
        return got.find((m) => m.device_id === mirror.id) ? got : null;
      }, 40000, 1000);
      assert.ok(frames, 'a frame for the mirror');
      const mf = frames.find((m) => m.device_id === mirror.id);
      assert.match(mf.image_data, /^data:image\/jpeg;base64,/);
      assert.ok(asked(pB) > b0, 'the request reached the mirror\'s page');
      assert.equal(asked(pA), a0, 'and not the original\'s');
      assert.ok(!frames.some((m) => m.device_id === d.id), 'no frame was attributed to the original');
      const listed = await waitFor(async () => {
        const list = await srv.api('GET', '/devices');
        const m = list.find((x) => x.id === mirror.id);
        return m && m.screenshot_at ? m : null;
      }, 10000);
      assert.ok(listed, 'the screens list has a stored screenshot for the mirror');
      const img = await fetch(`${srv.base}/api/devices/${mirror.id}/screenshot`, { headers: { Authorization: 'Bearer ' + srv.token } });
      assert.equal(img.status, 200);
      // The original's own request still answers from the original.
      const oframes = await requestFrame(d.id);
      assert.ok(oframes.find((m) => m.device_id === d.id), 'the original answers for itself');

      // ---- b. the mirror's device page says what it plays.
      const mrow = await srv.api('GET', `/devices/${mirror.id}`);
      assert.equal(mrow.mirror_playing.playlist_name, 'Lobby loop');
      const dashPage = await pageIn(ctxD);
      await dashPage.setViewport({ width: 1400, height: 1000 });
      await dashPage.goto(`${srv.base}/app#/login`, { waitUntil: 'domcontentloaded' });
      await dashPage.evaluate((tok) => { localStorage.setItem('token', tok); localStorage.setItem('rd_onboarded', '1'); }, srv.token);
      await dashPage.goto(`${srv.base}/app#/device/${mirror.id}`, { waitUntil: 'domcontentloaded' });
      await dashPage.waitForSelector('#nowPlayingInfo', { timeout: 30000 });
      const line = await dashPage.$eval('#nowPlayingInfo', (el) => el.textContent.trim());
      assert.match(line, /^Mirroring Display 2: playing Lobby loop/);
      assert.ok(await dashPage.$('#currentScreenshot[src]'), 'the mirror\'s device page shows its stored picture');

      // ---- c. the dashboard's "Share my screen" on the ORIGINAL plays on both; Stop ends both.
      await dashPage.goto(`${srv.base}/app#/device/${d.id}`, { waitUntil: 'domcontentloaded' });
      await dashPage.waitForSelector('[data-share-start]:not([disabled])', { timeout: 30000 });
      // The mirror is not a box to tick: the card says the share includes it.
      const mirrorsLine = await dashPage.$eval('[data-share-mirrors]', (el) => el.textContent.trim());
      assert.equal(mirrorsLine, 'Also shows on its mirrors (1): Display 2 (mirror 1)');
      await dashPage.click('[data-share-start]');
      await assertPlaying(pA, 'dashboard share on the original');
      await assertPlaying(pB, 'dashboard share on the mirror');
      await dashPage.waitForSelector('#screenShareBar [data-share-stop]', { timeout: 10000 });
      await dashPage.click('#screenShareBar [data-share-stop]');
      assert.ok(await waitFor(async () => (await videoState(pA)) === null && (await videoState(pB)) === null, 15000), 'Stop took the share off both');

      // ---- d. the same meeting-room code on the mirror; a guest with it reaches both.
      const code = await waitFor(async () => {
        const [ca, cb] = [await codeOn(pA), await codeOn(pB)];
        return ca && ca === cb ? cb : null;
      }, 30000, 500);
      assert.ok(code, 'the mirror shows the display\'s meeting-room code');
      assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      const guest = await pageIn(ctxG);
      await guest.goto(srv.base + '/share', { waitUntil: 'domcontentloaded' });
      await guest.waitForSelector('#shareCode');
      await guest.type('#shareCode', code);
      await guest.type('#shareName', 'Erin');
      await guest.click('#shareGo');
      const sa = await assertPlaying(pA, 'guest share on the original');
      const sb = await assertPlaying(pB, 'guest share on the mirror');
      assert.match(sa.badge, /Erin/);
      assert.match(sb.badge, /Erin/);
      assert.ok(await waitFor(() => guest.evaluate(() => document.getElementById('shareLive').classList.contains('on')), 15000), 'the guest page says live');
      assert.equal(await codeOn(pB), null, 'no code on the mirror while it is busy');
      await guest.click('#shareStop');
      assert.ok(await waitFor(async () => (await videoState(pA)) === null && (await videoState(pB)) === null, 15000), 'the guest\'s Stop took the share off both');
      const next = await waitFor(async () => {
        const [ca, cb] = [await codeOn(pA), await codeOn(pB)];
        return ca && ca === cb && ca !== code ? ca : null;
      }, 15000, 500);
      assert.ok(next, 'a fresh code on both afterwards');
      const old = await fetch(srv.base + '/api/share/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      assert.equal(old.status, 404, 'the code redeemed at the mirror is refused after the share');
      for (const p of [pA, pB]) assert.deepEqual(p.errors, [], 'no page errors');
    } finally {
      for (const c of [ctxA, ctxB, ctxD, ctxG]) { try { await c.close(); } catch { /* */ } }
    }
  });

  /*
   * Mirrors are automatic, including ones that appear DURING a share: the server hands the sharer's
   * page a leg for the new screen over its open signalling socket, and the page sends the same
   * capture to it. Also a mirror that drops and comes back mid-share.
   */
  test('a mirror opened (or reopened) during a share joins it on its own', { timeout: 300000 }, async () => {
    const d = await srv.webPlayerDisplay('Display 3');
    await playOn(d.id, red, 'Atrium loop');
    const link = `${srv.base}/player?k=${encodeURIComponent(d.key)}`;
    const ctxA = await browser.createBrowserContext();
    const ctxB = await browser.createBrowserContext();
    const ctxD = await browser.createBrowserContext();
    try {
      const pA = await pageIn(ctxA);
      await pA.goto(link, { waitUntil: 'domcontentloaded' });
      assert.ok(await waitFor(() => connectedAs(pA, d.id), 40000), 'the display is up');
      assert.ok(await waitFor(async () => {
        const st = await srv.api('GET', `/screen-share/devices/${d.id}`).catch(() => null);
        return st && st.available;
      }, 30000), 'the display can take a share');

      // Share from the dashboard with NO mirror open.
      const dashPage = await pageIn(ctxD);
      await dashPage.setViewport({ width: 1400, height: 1000 });
      await dashPage.goto(`${srv.base}/app#/login`, { waitUntil: 'domcontentloaded' });
      await dashPage.evaluate((tok) => { localStorage.setItem('token', tok); localStorage.setItem('rd_onboarded', '1'); }, srv.token);
      await dashPage.goto(`${srv.base}/app#/device/${d.id}`, { waitUntil: 'domcontentloaded' });
      await dashPage.waitForSelector('[data-share-start]:not([disabled])', { timeout: 30000 });
      await dashPage.click('[data-share-start]');
      await assertPlaying(pA, 'the share on the display');

      // Now the link opens somewhere else: a mirror, which joins the running share.
      let pB = await pageIn(ctxB);
      await pB.goto(link, { waitUntil: 'domcontentloaded' });
      const mirror = await waitFor(async () => {
        const row = await srv.api('GET', `/devices/${d.id}`).catch(() => null);
        return row && row.mirrors && row.mirrors.length === 1 ? row.mirrors[0] : null;
      }, 40000);
      assert.ok(mirror, 'the second opening is a mirror');
      const sb = await assertPlaying(pB, 'the mirror that appeared mid-share');
      assert.match(sb.badge, /Shared by/i);
      const barText = () => dashPage.$eval('#screenShareBar', (el) => el.textContent).catch(() => '');
      assert.ok(await waitFor(async () => /2 of 2/.test(await barText()), 15000), 'the bar counts both screens: ' + await barText());
      await assertPlaying(pA, 'the display still');

      // The mirror drops and comes back mid-share: it rejoins.
      await pB.close();
      assert.ok(await waitFor(async () => /1 of 1|Sharing to Display 3/.test(await barText()), 20000), 'the bar drops it: ' + await barText());
      pB = await pageIn(ctxB);
      await pB.goto(link, { waitUntil: 'domcontentloaded' });
      assert.ok(await waitFor(() => connectedAs(pB, mirror.id), 40000), 'the same mirror again');
      await assertPlaying(pB, 'the mirror after reconnecting');
      assert.ok(await waitFor(async () => /2 of 2/.test(await barText()), 15000), 'the bar counts it again: ' + await barText());

      // Stop on the dashboard ends both.
      await dashPage.click('#screenShareBar [data-share-stop]');
      assert.ok(await waitFor(async () => (await videoState(pA)) === null && (await videoState(pB)) === null, 15000), 'Stop took the share off both');
    } finally {
      for (const c of [ctxA, ctxB, ctxD]) { try { await c.close(); } catch { /* */ } }
    }
  });
});
