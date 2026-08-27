'use strict';

// Browser smoke test. NOT part of `npm test` — it needs a real Chrome, which CI does not have,
// and it boots a server and drives it. Run it deliberately:
//
//     npm run smoke                 (skips cleanly if no Chrome is installed)
//
// It lives OUTSIDE test/ on purpose: `node --test` globs that directory, so a file placed
// there is picked up by `npm test` no matter what the intent was — which is exactly what
// happened the first time, and it broke CI.
//     CHROME=/path/to/chrome npm run smoke
//
// It exists because a whole class of defect is invisible to the unit suite, to a syntax check
// and to review, and only appears in front of a browser. Every check below is here because it
// caught something real:
//
//   * a context menu whose only item read "schedule.ctx_new" — t() returns the KEY when a string
//     is missing, so a missing key ships as user-facing text
//   * pointer handlers stacking on every calendar render — five renders meant five PUTs on one
//     drop, which no unit test would ever notice
//   * the week grid forcing a horizontal scroll on a phone
//   * an uncaught error blanking a view
//
// Keep it fast and keep every assertion tied to a real past failure, or it becomes noise nobody
// runs.

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const VIEWS = ['#/', '#/content', '#/playlists', '#/layouts', '#/widgets', '#/schedule',
  '#/walls', '#/reports', '#/kiosk', '#/designer', '#/activity', '#/members', '#/help', '#/settings'];

function findChrome() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;
  for (const c of ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium',
    '/snap/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    try { if (fs.existsSync(c)) return c; } catch { /* */ }
  }
  try { return execSync('which google-chrome chromium 2>/dev/null | head -1').toString().trim() || null; }
  catch { return null; }
}

let puppeteer;
try { puppeteer = require('puppeteer-core'); } catch { puppeteer = null; }

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n         ${detail}`}`);
};

(async () => {
  const chrome = findChrome();
  if (!puppeteer || !chrome) {
    console.log(`SKIP: ui smoke needs puppeteer-core${chrome ? '' : ' and a Chrome binary'}.`);
    console.log('      npm i -D puppeteer-core   # and install Chrome, or set CHROME=/path/to/chrome');
    process.exit(0);
  }

  const DATA_DIR = path.join(os.tmpdir(), 'st-smoke-' + crypto.randomBytes(4).toString('hex'));
  const PORT = 4000 + Math.floor(Math.random() * 900);
  const BASE = `http://127.0.0.1:${PORT}`;
  const logFile = path.join(os.tmpdir(), 'st-smoke.log');
  const srv = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', fs.openSync(logFile, 'w'), fs.openSync(logFile, 'a')],
  });
  const stop = () => { try { srv.kill('SIGKILL'); } catch { /* */ } };
  process.on('exit', stop);

  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) { console.error('server did not start:\n' + fs.readFileSync(logFile, 'utf8').slice(-1500)); stop(); process.exit(1); }

  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|404 \(Not Found\)/.test(m.text())) errors.push(m.text().slice(0, 140)); });

  await page.goto(BASE + '/app#/login', { waitUntil: 'networkidle2' });
  const registered = await page.evaluate(async () => {
    const r = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'smoke' + Date.now() + '@x.test', password: 'Passw0rd123' }) });
    const d = await r.json();
    if (d.token) localStorage.setItem('token', d.token);
    return !!d.token;
  });
  check('an account can be created', registered);

  // ---- every view: renders, no raw keys, no uncaught errors ----------------------------------
  const rawKeyOffenders = [];
  for (const hash of VIEWS) {
    const before = errors.length;
    await page.goto(BASE + '/app' + hash, { waitUntil: 'networkidle2' });
    await page.reload({ waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 900));
    const info = await page.evaluate(() => {
      const bare = [...document.querySelectorAll('body *')]
        .filter(e => e.children.length === 0)
        .map(e => (e.textContent || '').trim())
        // A bare i18n key: dotted, lower-case, no spaces. Version strings (v1.2.3) are excluded.
        .filter(s => /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(s) && !/^v?\d/.test(s));
      return { chars: (document.body.innerText || '').trim().length, bare: [...new Set(bare)] };
    });
    check(`renders ${hash}`, info.chars > 60, `only ${info.chars} chars of text`);
    if (info.bare.length) rawKeyOffenders.push(`${hash}: ${info.bare.join(', ')}`);
    check(`no uncaught error on ${hash}`, errors.length === before, errors.slice(before).join(' | '));
  }
  check('no untranslated keys rendered as text', rawKeyOffenders.length === 0, rawKeyOffenders.join('\n         '));

  // ---- a background picture can be added to a directory board WITHOUT leaving the form ---------
  //
  // ⚠️ THE REPORT THIS CAME FROM: "someone couldn't upload a background picture". They were right.
  // The picker was read-only and its own empty state said so — "Upload images first from Content
  // Library" — so the only route to a background was to abandon a half-filled widget form, cross to
  // another view, upload, and come back. Nothing threw, nothing failed, and no unit test could see
  // it, because the feature simply was not there. This drives the real dialog in a real browser.
  await page.goto(BASE + '/app#/widgets', { waitUntil: 'networkidle2' });
  await page.reload({ waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 900));

  // ---- every widget type can actually be OPENED for editing ------------------------------------
  //
  // ⚠️ Weather and Social could not be, for sixteen days. Both config forms interpolate esc() into
  // their HTML, and esc was never imported into views/widgets.js — so building the form threw
  // ReferenceError and the modal never appeared. Rendering the widgets VIEW proves nothing about
  // this: the throw is inside a click handler. One click per type is the whole guard.
  const formsBefore = errors.length;
  const formResults = await page.evaluate(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    for (const type of ['clock', 'weather', 'rss', 'text', 'webpage', 'social',
      'directory-board', 'directory-search', 'transition']) {
      const card = document.querySelector(`[data-create-type="${type}"]`);
      if (!card) { out[type] = 'no tile'; continue; }
      const form = document.getElementById('widgetConfigForm');
      if (form) form.innerHTML = '';        // so a form left over from the last type cannot pass for this one
      try { card.click(); } catch (e) { out[type] = 'threw: ' + e.message; continue; }
      await sleep(250);
      const f = document.getElementById('widgetConfigForm');
      out[type] = f && f.children.length ? 'ok' : 'empty form';
      const modal = document.getElementById('widgetModal');
      if (modal) modal.style.display = 'none';
    }
    return out;
  });
  const badForms = Object.entries(formResults).filter(([, v]) => v !== 'ok');
  check('every widget type opens its config form', badForms.length === 0,
    badForms.map(([k, v]) => `${k}: ${v}`).join(', '));
  check('no uncaught error while opening the widget forms', errors.length === formsBefore,
    errors.slice(formsBefore).join(' | '));

  const picker = await page.evaluate(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const card = q('[data-create-type="directory-board"]');
    if (!card) return { err: 'no directory-board tile in the widget type grid' };
    card.click();
    await sleep(200);
    const add = q('#wBgAdd');
    if (!add) return { err: 'the directory-board form has no "Add Background Image" button' };
    add.click();
    await sleep(400);

    const opened = {
      hasUploadButton: !!q('#cpUploadBtn'),
      hasFileInput: !!q('#cpFile'),
      // t() returns the KEY itself when a string is missing, so a new key ships as visible text.
      bareKeys: [...document.querySelectorAll('#cpBox *')]
        .filter(e => e.children.length === 0)
        .map(e => (e.textContent || '').trim())
        .filter(s => /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(s)),
    };
    if (!opened.hasFileInput) return { ...opened, err: 'the picker has no file input' };

    // A real PNG, magic bytes and all — the server sniffs content, not the filename.
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'smoke-backdrop.png', { type: 'image/png' }));
    const input = q('#cpFile');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));

    // Wait for the upload to land as a tile in the grid.
    let tiles = 0;
    for (let i = 0; i < 60 && tiles === 0; i++) { await sleep(250); tiles = document.querySelectorAll('#cpList [data-pick-id]').length; }
    const status = (q('#cpStatus') || {}).textContent || '';
    const selectedAfterUpload = document.querySelectorAll('#cpList [data-check]')
      .length ? [...document.querySelectorAll('#cpList [data-check]')].filter(e => e.style.display !== 'none').length : 0;

    const done = q('#cpDone');
    if (done) done.click();
    await sleep(400);
    return {
      ...opened,
      tiles,
      status,
      selectedAfterUpload,
      onBoard: document.querySelectorAll('#wBgList img').length,
    };
  });

  check('the picker offers an upload', !picker.err && picker.hasUploadButton && picker.hasFileInput,
    picker.err || 'no upload control in the image picker — the whole point of the report');
  check('an uploaded picture lands in the picker', picker.tiles > 0,
    `no tile appeared after the upload (status: ${picker.status || 'none'})`);
  check('the uploaded picture comes back selected', picker.selectedAfterUpload > 0,
    'the file uploaded but was not selected, so Done would return nothing');
  check('it reaches the directory board', picker.onBoard > 0,
    'the picker resolved but no background image is on the widget form');
  check('the picker renders no untranslated keys', (picker.bareKeys || []).length === 0,
    (picker.bareKeys || []).join(', '));

  // ---- the calendar binds its pointer handlers ONCE -------------------------------------------
  await page.goto(BASE + '/app#/schedule', { waitUntil: 'networkidle2' });
  await page.reload({ waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1200));
  const cdp = await page.target().createCDPSession();
  const countListeners = async () => {
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.getElementById("calendar")' });
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    return listeners.filter(l => l.type === 'pointerdown').length;
  };
  const first = await countListeners();
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => document.getElementById('nextWeek')?.click());
    await new Promise(r => setTimeout(r, 500));
  }
  const later = await countListeners();
  check('calendar handlers do not stack per render', first === 1 && later === 1,
    `pointerdown listeners: ${first} then ${later} — each extra one repeats the drag's PUT`);

  // ---- a phone-width viewport must not scroll sideways -----------------------------------------
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const overflowing = [];
  for (const hash of ['#/', '#/schedule', '#/content', '#/settings']) {
    await page.goto(BASE + '/app' + hash, { waitUntil: 'networkidle2' });
    await page.reload({ waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 900));
    const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
    if (m.doc > m.win + 4) overflowing.push(`${hash} (${m.doc}px in ${m.win}px)`);
  }
  check('no horizontal overflow at phone width', overflowing.length === 0, overflowing.join(', '));

  await browser.close();
  stop();

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
