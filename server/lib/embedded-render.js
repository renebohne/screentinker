'use strict';

/*
 * Embedded renderer — Pure Jimp (production) + Optional Headless Browser (dev/opt-in).
 *
 * Takes a resolved playlist item + content row + screen_profile and returns a raw PNG
 * buffer ready for embedded-postprocess.js.
 *
 * Zero-browser architecture:
 *   image / local file  — decoded, resized & cropped with Jimp (production dependency), return PNG.
 *   remote_url (images) — fetched & processed with Jimp, return PNG.
 *   widget / web page   — optionally rendered with Puppeteer if installed and Chrome is found;
 *                         otherwise degrades gracefully returning { unsupported: true, reason }.
 */

const fs = require('fs');
const path = require('path');
const { Jimp } = require('jimp');
const config = require('../config');
const { assertSafeUrl, SsrfError } = require('./ssrf-guard');

/*
 * ⚠️ ASK config, DO NOT RE-DERIVE THIS.
 *
 * This used to read `process.env.UPLOAD_DIR` and fall back to `<server>/uploads`. Neither matches
 * how the rest of the server resolves uploads: config.js uses `UPLOADS_DIR` (plural) and falls back
 * to `DATA_DIR/uploads`. `UPLOAD_DIR` is not a variable this project sets anywhere.
 *
 * The consequence was invisible in a dev checkout and total in production. The Docker image runs
 * with DATA_DIR=/data, so content lands in /data/uploads/content while this looked in
 * /app/server/uploads/content — and the local-image path, the one native renderer that needs no
 * browser, answered 501 "No renderable items in playlist" for every image on the shipped image.
 * Reproduced end to end: 501 as written, 200 with exactly 48000 bytes (800x480 packed 1-bit) once
 * the directory matched.
 */
function contentDir() {
  return config.contentDir;
}

// Coerce an untrusted dimension (from a screen_profile row) to a positive integer.
// Returns `fallback` for anything non-numeric, non-finite, or out of range — so a
// malformed profile can never inject arbitrary values into CSS or viewport dimensions.
function safeDimension(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 10000) return fallback;
  return Math.floor(n);
}

// MIME types Jimp can decode natively
const IMAGE_MIMES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif',
  'image/webp', 'image/bmp', 'image/tiff',
]);

const EXT_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif',  '.webp': 'image/webp',  '.bmp': 'image/bmp',
};

function looksLikeImage(urlOrPath, contentType) {
  if (contentType) {
    const base = contentType.split(';')[0].trim().toLowerCase();
    if (IMAGE_MIMES.has(base)) return true;
  }
  if (typeof urlOrPath !== 'string' || !urlOrPath) return false;
  try {
    let pathname = urlOrPath;
    if (urlOrPath.includes('://')) {
      pathname = new URL(urlOrPath).pathname;
    }
    const ext = path.extname(pathname).toLowerCase();
    return !!EXT_MIME[ext];
  } catch {
    return false;
  }
}

// ─── Optional Chrome / Chromium Path Detection ───────────────────────────────
function findChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.CHROME_BIN,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  return null;
}

let browserInstance = null;
// The launch in flight, so three devices polling a cold server share ONE Chromium instead of
// starting three and keeping the last (the other two lived on, unreferenced, until exit).
let browserLaunching = null;
let browserAvailableCached = null;
let lastBrowserProbe = 0;

function isBrowserAvailable() {
  const now = Date.now();
  if (browserAvailableCached !== null && (now - lastBrowserProbe < 30000)) {
    return browserAvailableCached;
  }
  const puppeteer = getPuppeteer();
  const chromePath = findChromePath();
  browserAvailableCached = Boolean(puppeteer && chromePath);
  lastBrowserProbe = now;
  return browserAvailableCached;
}

function getPuppeteer() {
  try {
    return require('puppeteer-core');
  } catch (_) {
    return null;
  }
}

async function getBrowser() {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }
  if (browserLaunching) {
    return browserLaunching;
  }

  const puppeteer = getPuppeteer();
  if (!puppeteer) {
    const err = new Error('puppeteer-core is not installed. Browser rendering is unavailable.');
    err.code = 'BROWSER_UNAVAILABLE';
    throw err;
  }

  const chromePath = findChromePath();
  if (!chromePath) {
    const err = new Error('Chrome/Chromium executable not found. Set CHROME_PATH environment variable.');
    err.code = 'BROWSER_NOT_FOUND';
    throw err;
  }

  browserLaunching = puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--hide-scrollbars',
    ],
  }).then((b) => {
    browserInstance = b;
    b.on('disconnected', () => {
      if (browserInstance === b) browserInstance = null;
    });
    return b;
  }).finally(() => {
    browserLaunching = null;
  });

  return browserLaunching;
}

async function closeBrowser() {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch (_) {}
    browserInstance = null;
  }
}

// Clean lifecycle hooks to prevent hanging processes
process.on('exit', () => {
  if (browserInstance) {
    try { browserInstance.process()?.kill(); } catch (_) {}
  }
});
process.on('SIGTERM', () => { closeBrowser(); });
process.on('SIGINT', () => { closeBrowser(); });

// ─── Native Image Renderers (Jimp) ───────────────────────────────────────────

function safeLocalImagePath(filepath) {
  if (!filepath) return null;
  const base = path.resolve(contentDir());
  const safe = path.resolve(base, path.basename(String(filepath)));
  if (!safe.startsWith(base + path.sep) && safe !== base) {
    throw Object.assign(new Error('Invalid content file path'), { code: 'INVALID_PATH' });
  }
  if (!fs.existsSync(safe)) {
    throw Object.assign(new Error('Content file not found on disk'), { code: 'NOT_FOUND' });
  }
  return safe;
}

function parseColorToRgba(hexOrInt, fallback = 0x000000FF) {
  if (typeof hexOrInt === 'number' && Number.isFinite(hexOrInt)) return hexOrInt >>> 0;
  if (typeof hexOrInt === 'string') {
    let s = hexOrInt.trim().replace(/^#/, '');
    if (s.length === 3) {
      s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2] + 'FF';
    } else if (s.length === 6) {
      s = s + 'FF';
    }
    if (s.length === 8) {
      const parsed = parseInt(s, 16);
      if (!Number.isNaN(parsed)) return parsed >>> 0;
    }
  }
  return fallback;
}

function withTimeout(promise, ms = 15000, timeoutErrorMsg = 'Render timed out') {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(timeoutErrorMsg);
      err.code = 'RENDER_TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

async function renderLocalImage(content, profile) {
  const fileToLoad = (content.filepath && looksLikeImage(content.filepath, content.mime_type))
    ? content.filepath
    : (content.thumbnail_path || content.filepath);
  const safe = safeLocalImagePath(fileToLoad);
  const img = await Jimp.fromBuffer(fs.readFileSync(safe));
  img.cover({ w: profile.width, h: profile.height });
  return img.getBuffer('image/png');
}

const MAX_CONCURRENT_PAGES = 3;
let activePages = 0;
const pageWaiters = [];

function acquirePageSlot(signal) {
  if (signal?.aborted) {
    const err = new Error('Render request aborted');
    err.code = 'ABORTED';
    return Promise.reject(err);
  }
  if (activePages < MAX_CONCURRENT_PAGES) {
    activePages++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    pageWaiters.push(waiter);
    if (signal) {
      signal.addEventListener('abort', () => {
        const idx = pageWaiters.indexOf(waiter);
        if (idx !== -1) {
          pageWaiters.splice(idx, 1);
          const err = new Error('Render request aborted');
          err.code = 'ABORTED';
          reject(err);
        }
      }, { once: true });
    }
  });
}

function releasePageSlot() {
  activePages--;
  if (pageWaiters.length > 0) {
    activePages++;
    const next = pageWaiters.shift();
    next.resolve();
  }
}

async function renderRemoteImage(content, profile) {
  const url = content.remote_url;
  if (!url) return null;

  // Same vetting as the page path below: this fetch runs on the server, against a URL a
  // workspace editor typed. Private ranges and the metadata endpoint are not content.
  try {
    await assertSafeUrl(url);
  } catch (e) {
    if (e instanceof SsrfError) {
      throw Object.assign(new Error(`Remote content refused: ${e.message}`), { code: 'BLOCKED_URL' });
    }
    throw Object.assign(new Error(`Invalid remote URL: ${e.message}`), { code: 'FETCH_ERROR' });
  }

  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'ScreenTinker-EmbeddedRenderer/1.0' },
    });
  } catch (e) {
    throw Object.assign(
      new Error(`Failed to fetch remote content: ${e.message}`),
      { code: 'FETCH_ERROR' }
    );
  }

  if (!response.ok) {
    throw Object.assign(
      new Error(`Remote content returned HTTP ${response.status}`),
      { code: 'FETCH_ERROR' }
    );
  }

  const contentType = response.headers.get('content-type') || '';
  if (!looksLikeImage(url, contentType)) {
    return null;
  }

  const buf = Buffer.from(await response.arrayBuffer());
  const img = await Jimp.fromBuffer(buf);
  img.cover({ w: profile.width, h: profile.height });
  return img.getBuffer('image/png');
}

function localBaseUrl() {
  return global.__localApiOrigin || process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || config.port || 3001}`;
}

async function renderWidgetOrHtml(html, profile, widgetType = '', options = {}) {
  await acquirePageSlot(options.signal);
  let browser = null;
  let page = null;
  try {
    return await withTimeout((async () => {
      browser = await getBrowser();
      page = await browser.newPage();
      await page.setViewport({ width: profile.width, height: profile.height });

      const baseUrl = localBaseUrl();
      const staticStyle = '<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>';
      let finalHtml = html;
      if (/<head[^>]*>/i.test(finalHtml)) {
        finalHtml = finalHtml.replace(/(<head[^>]*>)/i, `$1\n<base href="${baseUrl}/">\n${staticStyle}`);
      } else if (/<html[^>]*>/i.test(finalHtml)) {
        finalHtml = finalHtml.replace(/(<html[^>]*>)/i, `$1\n<head><base href="${baseUrl}/">\n${staticStyle}</head>`);
      } else {
        finalHtml = `<!DOCTYPE html><html><head><base href="${baseUrl}/">\n${staticStyle}</head><body>${finalHtml}</body></html>`;
      }

      // For layout compositions, wait for domcontentloaded so slow/hung zones don't abort whole layout.
      // Single-widget / slide / webpage items wait for 'load'.
      const waitUntil = widgetType === 'layout' ? 'domcontentloaded' : 'load';
      await page.setContent(finalHtml, { waitUntil, timeout: 8000 });

      // Wait for any async network fetches to settle if present
      if (widgetType === 'weather' || widgetType === 'rss' || widgetType === 'layout') {
        await page.waitForNetworkIdle({ idleTime: 200, timeout: 2500 }).catch(() => {});
      }

      // Template-agnostic settlement: fonts, animations, images, and videos (including inside srcdoc iframes)
      await page.evaluate(async (isLayout) => {
        try { if (document.fonts?.ready) await document.fonts.ready; } catch (_) {}
        try { document.getAnimations().forEach(a => { try { a.finish(); } catch (_) {} }); } catch (_) {}

        // Settle iframes with individual bounded wait (so a hung remote iframe never blocks whole layout)
        const iframes = Array.from(document.querySelectorAll('iframe'));
        await Promise.all(iframes.map(iframe => {
          return new Promise((resolve) => {
            // Listeners and the timer FIRST. Reading contentDocument on a cross-origin zone throws
            // SecurityError, and a catch that resolved there let a remote dashboard be captured
            // blank at ~3s while it was still painting. A remote zone now waits for its load
            // event or the bounded timer, whichever comes first.
            setTimeout(resolve, isLayout ? 3000 : 5000);
            iframe.addEventListener('load', resolve, { once: true });
            iframe.addEventListener('error', resolve, { once: true });
            try {
              const doc = iframe.contentDocument || iframe.contentWindow?.document;
              if (doc && (doc.readyState === 'complete' || doc.readyState === 'interactive')) {
                try { doc.getAnimations().forEach(a => { try { a.finish(); } catch (_) {} }); } catch (_) {}
                const fonts = doc.fonts && doc.fonts.ready;
                if (fonts && typeof fonts.then === 'function') fonts.then(resolve, resolve); else resolve();
              }
            } catch (_) { /* cross-origin: the load event or the timer settles it */ }
          });
        }));

        // Settle images across root and iframes
        const getNestedImages = (root) => {
          let imgs = Array.from(root.querySelectorAll('img'));
          const fList = Array.from(root.querySelectorAll('iframe'));
          for (const f of fList) {
            try {
              const doc = f.contentDocument || f.contentWindow?.document;
              if (doc) {
                imgs = imgs.concat(Array.from(doc.querySelectorAll('img')));
              }
            } catch (_) {}
          }
          return imgs;
        };

        const imgs = getNestedImages(document);
        await Promise.all(imgs.map(img => {
          if (img.complete && img.naturalHeight !== 0) return Promise.resolve();
          return new Promise(resolve => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
            setTimeout(resolve, 1500);
          });
        }));

        // Settle videos
        const videos = Array.from(document.querySelectorAll('video'));
        await Promise.all(videos.map(v => {
          if (v.readyState >= 2) return Promise.resolve();
          return new Promise(resolve => {
            v.addEventListener('loadeddata', resolve, { once: true });
            v.addEventListener('canplay', resolve, { once: true });
            v.addEventListener('error', resolve, { once: true });
            setTimeout(resolve, 2000);
          });
        }));
      }, widgetType === 'layout').catch(() => {});

      const snap = await page.screenshot({ type: 'png' });
      return Buffer.from(snap);
    })(), 15000, 'Page rendering exceeded 15s deadline');
  } finally {
    if (page) {
      try { await page.close(); } catch (_) {}
    }
    releasePageSlot();
  }
}

/*
 * A remote WEB PAGE is navigated to, not pasted into a document. #331's last round folded the
 * remote-page branch into renderWidgetOrHtml(), whose only way of loading anything is
 * page.setContent(html) — so the URL string itself became the document, and a panel pointed at
 * https://example.com/board received a white frame with that address printed on it, cached for
 * five minutes. This is the page.goto() path main had before, behind the same slot and lifecycle
 * the HTML path uses.
 *
 * The URL is vetted first. Chromium is a full client running on the server: pointed at
 * 127.0.0.1, 169.254.169.254, or a LAN address it renders whatever is there into a frame any
 * device on that workspace can pull. The media proxy and the data-source fetcher already refuse
 * those through lib/ssrf-guard; this path never did.
 */
async function renderRemotePage(url, profile, options = {}) {
  try {
    await assertSafeUrl(url);
  } catch (e) {
    if (e instanceof SsrfError) {
      throw Object.assign(new Error(`Remote page refused: ${e.message}`), { code: 'BLOCKED_URL' });
    }
    throw Object.assign(new Error(`Invalid remote URL: ${e.message}`), { code: 'FETCH_ERROR' });
  }
  await acquirePageSlot(options.signal);
  let page = null;
  try {
    return await withTimeout((async () => {
      const browser = await getBrowser();
      page = await browser.newPage();
      await page.setViewport({ width: profile.width, height: profile.height });
      await page.goto(url, { waitUntil: 'load', timeout: 10000 });
      // Dashboards and boards usually paint from a fetch after load; give that a bounded chance.
      await page.waitForNetworkIdle({ idleTime: 200, timeout: 2500 }).catch(() => {});
      const snap = await page.screenshot({ type: 'png' });
      return Buffer.from(snap);
    })(), 15000, 'Remote page rendering exceeded 15s deadline');
  } finally {
    if (page) {
      try { await page.close(); } catch (_) {}
    }
    releasePageSlot();
  }
}

async function render(item, content, screenProfile, options = {}) {
  const profile = {
    width: safeDimension(screenProfile?.width, 800),
    height: safeDimension(screenProfile?.height, 480),
    rotation: [0, 90, 180, 270].includes(Number(screenProfile?.rotation)) ? Number(screenProfile.rotation) : 0,
    colorDepth: screenProfile?.colorDepth || '1bit',
    dither: screenProfile?.dither || 'floyd-steinberg',
    outputFormat: screenProfile?.outputFormat || 'x-epd-packed',
  };

  // ── Widget rendering (Clock, Weather, Slide Deck, RSS, etc.) ─────────────
  if (item && (item.widget_id || item.widget_type)) {
    const type = item.widget_type || 'clock';
    let config = {};
    if (typeof item.widget_config === 'string') {
      try { config = JSON.parse(item.widget_config); } catch (_) {}
    } else if (typeof item.widget_config === 'object' && item.widget_config !== null) {
      config = item.widget_config;
    }

    try {
      const { renderWidgetHtml, imageResolverFor, dataResolverFor, widgetIframeSandboxForWorkspace } = require('../routes/widgets');
      const { fontResolverFor } = require('../routes/fonts');
      const { db } = require('../db/database');

      let wsId;
      if (item.widget_id) {
        wsId = item.widget_workspace_id !== undefined ? item.widget_workspace_id : null;
        if (wsId === undefined) {
          try {
            const w = db.prepare('SELECT workspace_id FROM widgets WHERE id = ?').get(item.widget_id);
            wsId = w ? w.workspace_id : null;
          } catch (_) {}
        }
      } else {
        wsId = item.workspace_id || content?.workspace_id || profile?.workspace_id;
      }

      const html = renderWidgetHtml(type, config, {
        iframeSandbox: widgetIframeSandboxForWorkspace ? widgetIframeSandboxForWorkspace(wsId) : 'allow-scripts',
        resolveImage: imageResolverFor ? imageResolverFor({ workspace_id: wsId }) : undefined,
        resolveFont: fontResolverFor ? fontResolverFor({ workspace_id: wsId }) : undefined,
        resolveData: typeof dataResolverFor === 'function' ? dataResolverFor(wsId) : undefined,
      });
      const png = await renderWidgetOrHtml(html, profile, type, options);
      return { png };
    } catch (e) {
      if (e.code === 'BROWSER_UNAVAILABLE' || e.code === 'BROWSER_NOT_FOUND') {
        return {
          unsupported: true,
          reason: 'Widget rendering requires a browser (set CHROME_PATH). Image content works natively without a browser.',
        };
      }
      throw e;
    }
  }

  // ── Remote Web Page or Remote Image ──────────────────────────────────────
  if (content && content.remote_url) {
    const png = await renderRemoteImage(content, profile);
    if (png) return { png };

    try {
      const p = await renderRemotePage(content.remote_url, profile, options);
      return { png: p };
    } catch (e) {
      if (e.code === 'BROWSER_UNAVAILABLE' || e.code === 'BROWSER_NOT_FOUND') {
        return {
          unsupported: true,
          reason: 'Rendering remote web pages requires a browser (set CHROME_PATH).',
        };
      }
      throw e;
    }
  }

  // ── Local Image / File (Native Jimp Execution) ──────────────────────────
  if (content && (content.filepath || content.thumbnail_path)) {
    const fileToLoad = (content.filepath && looksLikeImage(content.filepath, content.mime_type))
      ? content.filepath
      : (content.thumbnail_path || content.filepath);

    if (fileToLoad) {
      const safe = safeLocalImagePath(fileToLoad);
      try {
        const fileBuffer = fs.readFileSync(safe);
        const img = await Jimp.fromBuffer(fileBuffer);
        img.cover({ w: profile.width, h: profile.height });
        const png = await img.getBuffer('image/png');
        return { png };
      } catch (e) {
        if (e.code === 'INVALID_PATH' || e.code === 'NOT_FOUND') throw e;
        throw Object.assign(
          new Error(`Failed to decode image with Jimp: ${e.message}`),
          { code: 'DECODE_ERROR' }
        );
      }
    }
  }

  return { unsupported: true, reason: 'No renderable content' };
}

function escapeHtmlAttr(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isLayoutImageOnly(zoneEntries) {
  if (!Array.isArray(zoneEntries) || !zoneEntries.length) return false;
  for (const entry of zoneEntries) {
    if (!entry || !entry.item) continue;
    const c = entry.content;
    if (!c) {
      if (entry.item.widget_type || entry.item.widget_id) return false;
      continue;
    }
    if (c.remote_url) {
      if (!looksLikeImage(c.remote_url, c.mime_type)) return false;
    } else if (c.filepath) {
      if (!looksLikeImage(c.filepath, c.mime_type) && !c.thumbnail_path) return false;
    } else {
      return false;
    }
  }
  return true;
}

async function renderLayoutNative(layout, zoneEntries, screenProfile) {
  const profile = {
    width: safeDimension(screenProfile?.width, 800),
    height: safeDimension(screenProfile?.height, 480),
  };

  const sorted = [...zoneEntries].sort((a, b) => {
    const za = Number.isFinite(Number(a.zone?.z_index)) ? Number(a.zone.z_index) : 0;
    const zb = Number.isFinite(Number(b.zone?.z_index)) ? Number(b.zone.z_index) : 0;
    return za - zb;
  });

  const layoutBg = parseColorToRgba(layout?.background_color, 0x000000FF);
  const canvas = new Jimp({ width: profile.width, height: profile.height, color: layoutBg });

  for (const entry of sorted) {
    const { zone, content } = entry;
    if (!zone || !content) continue;

    const x = Number.isFinite(Number(zone.x_percent)) ? Math.max(0, Math.min(100, Number(zone.x_percent))) : 0;
    const y = Number.isFinite(Number(zone.y_percent)) ? Math.max(0, Math.min(100, Number(zone.y_percent))) : 0;
    const w = Number.isFinite(Number(zone.width_percent)) ? Math.max(0, Math.min(100, Number(zone.width_percent))) : 100;
    const h = Number.isFinite(Number(zone.height_percent)) ? Math.max(0, Math.min(100, Number(zone.height_percent))) : 100;

    const pixelX = Math.round((x / 100) * profile.width);
    const pixelY = Math.round((y / 100) * profile.height);
    const pixelW = Math.max(1, Math.round((w / 100) * profile.width));
    const pixelH = Math.max(1, Math.round((h / 100) * profile.height));

    try {
      if (zone.background_color) {
        const zoneBg = parseColorToRgba(zone.background_color, null);
        if (zoneBg !== null) {
          const bgImg = new Jimp({ width: pixelW, height: pixelH, color: zoneBg });
          canvas.composite(bgImg, pixelX, pixelY);
        }
      }

      let img = null;
      if (content.remote_url) {
        let res;
        try {
          res = await fetch(content.remote_url, {
            signal: AbortSignal.timeout(10000),
            headers: { 'User-Agent': 'ScreenTinker-EmbeddedRenderer/1.0' },
          });
        } catch (e) {
          throw Object.assign(new Error(`Failed to fetch remote content: ${e.message}`), { code: 'FETCH_ERROR' });
        }
        if (!res.ok) {
          throw Object.assign(new Error(`Remote content returned HTTP ${res.status}`), { code: 'FETCH_ERROR' });
        }
        const contentType = res.headers.get('content-type') || '';
        if (!looksLikeImage(content.remote_url, contentType)) {
          throw Object.assign(new Error('Remote content is not an image'), { code: 'FETCH_ERROR' });
        }
        const buf = Buffer.from(await res.arrayBuffer());
        img = await Jimp.fromBuffer(buf);
      } else {
        const fileToLoad = (content.filepath && looksLikeImage(content.filepath, content.mime_type))
          ? content.filepath
          : (content.thumbnail_path || content.filepath);
        if (fileToLoad) {
          const safe = safeLocalImagePath(fileToLoad);
          img = await Jimp.fromBuffer(fs.readFileSync(safe));
        }
      }

      if (img) {
        const fitMode = zone.fit_mode || 'contain';
        if (fitMode === 'cover') {
          img.cover({ w: pixelW, h: pixelH });
        } else {
          img.contain({ w: pixelW, h: pixelH });
        }
        canvas.composite(img, pixelX, pixelY);
      }
    } catch (zoneErr) {
      console.warn(`[embedded] native layout zone error for zone ${zone.id || 'unknown'}: ${zoneErr.message}`);
    }
  }

  const png = await canvas.getBuffer('image/png');
  return { png };
}

async function renderLayout(layout, zoneEntries, screenProfile, options = {}) {
  const profile = {
    width: safeDimension(screenProfile?.width, 800),
    height: safeDimension(screenProfile?.height, 480),
    rotation: [0, 90, 180, 270].includes(Number(screenProfile?.rotation)) ? Number(screenProfile.rotation) : 0,
    colorDepth: screenProfile?.colorDepth || '1bit',
    dither: screenProfile?.dither || 'floyd-steinberg',
    outputFormat: screenProfile?.outputFormat || 'x-epd-packed',
  };

  if (isLayoutImageOnly(zoneEntries)) {
    try {
      return await renderLayoutNative(layout, zoneEntries, profile);
    } catch (e) {
      console.warn(`[embedded] native image layout render failed, falling back to browser: ${e.message}`);
    }
  }

  const { renderWidgetHtml, imageResolverFor, dataResolverFor, widgetIframeSandboxForWorkspace } = require('../routes/widgets');
  const { fontResolverFor } = require('../routes/fonts');
  const { db } = require('../db/database');

  const zoneHtmls = [];
  for (const entry of zoneEntries) {
    const { zone, item, content } = entry;
    if (!zone) continue;

    const x = Number.isFinite(Number(zone.x_percent)) ? Math.max(0, Math.min(100, Number(zone.x_percent))) : 0;
    const y = Number.isFinite(Number(zone.y_percent)) ? Math.max(0, Math.min(100, Number(zone.y_percent))) : 0;
    const w = Number.isFinite(Number(zone.width_percent)) ? Math.max(0, Math.min(100, Number(zone.width_percent))) : 100;
    const h = Number.isFinite(Number(zone.height_percent)) ? Math.max(0, Math.min(100, Number(zone.height_percent))) : 100;
    const zIndex = Number.isFinite(Number(zone.z_index)) ? Math.floor(Number(zone.z_index)) : 0;
    const fitMode = zone.fit_mode || 'contain';
    const zoneBg = zone.background_color ? `background-color: ${escapeHtmlAttr(zone.background_color)};` : '';

    let innerHtml = '<div style="width:100%;height:100%;background:transparent;"></div>';

    if (item && (item.widget_id || item.widget_type)) {
      const type = item.widget_type || 'clock';
      let config = {};
      if (typeof item.widget_config === 'string') {
        try { config = JSON.parse(item.widget_config); } catch (_) {}
      } else if (typeof item.widget_config === 'object' && item.widget_config !== null) {
        config = item.widget_config;
      }

      let wsId;
      if (item.widget_id) {
        wsId = item.widget_workspace_id !== undefined ? item.widget_workspace_id : null;
        if (wsId === undefined) {
          try {
            const row = db.prepare('SELECT workspace_id FROM widgets WHERE id = ?').get(item.widget_id);
            wsId = row ? row.workspace_id : null;
          } catch (_) {}
        }
      } else {
        wsId = item.workspace_id || layout?.workspace_id || profile?.workspace_id;
      }

      try {
        const widgetHtml = renderWidgetHtml(type, config, {
          iframeSandbox: widgetIframeSandboxForWorkspace ? widgetIframeSandboxForWorkspace(wsId) : 'allow-scripts',
          resolveImage: imageResolverFor ? imageResolverFor({ workspace_id: wsId }) : undefined,
          resolveFont: fontResolverFor ? fontResolverFor({ workspace_id: wsId }) : undefined,
          resolveData: typeof dataResolverFor === 'function' ? dataResolverFor(wsId) : undefined,
        });

        innerHtml = `<iframe srcdoc="${escapeHtmlAttr(widgetHtml)}" style="width:100%;height:100%;border:none;overflow:hidden;display:block;" scrolling="no"></iframe>`;
      } catch (zoneErr) {
        console.warn(`[embedded] zone widget render error for ${type}:`, zoneErr.message);
        innerHtml = `<div style="width:100%;height:100%;background:transparent;"></div>`;
      }
    } else if (content && content.remote_url) {
      if (looksLikeImage(content.remote_url, content.mime_type)) {
        innerHtml = `<img src="${escapeHtmlAttr(content.remote_url)}" style="width:100%;height:100%;object-fit:${fitMode};display:block;" />`;
      } else {
        innerHtml = `<iframe src="${escapeHtmlAttr(content.remote_url)}" style="width:100%;height:100%;border:none;overflow:hidden;display:block;" scrolling="no"></iframe>`;
      }
    } else if (content && content.filepath) {
      if (looksLikeImage(content.filepath, content.mime_type)) {
        const safeFilename = path.basename(content.filepath);
        innerHtml = `<img src="/uploads/content/${encodeURIComponent(safeFilename)}" style="width:100%;height:100%;object-fit:${fitMode};display:block;" />`;
      } else if (content.thumbnail_path) {
        const safeThumb = path.basename(content.thumbnail_path);
        innerHtml = `<img src="/uploads/content/${encodeURIComponent(safeThumb)}" style="width:100%;height:100%;object-fit:${fitMode};display:block;" />`;
      } else {
        const safeFilename = path.basename(content.filepath);
        innerHtml = `<video src="/uploads/content/${encodeURIComponent(safeFilename)}" style="width:100%;height:100%;object-fit:${fitMode};display:block;" autoplay muted playsinline preload="auto"></video>`;
      }
    }

    zoneHtmls.push(`
      <div class="zone-slot" style="position:absolute;left:${x}%;top:${y}%;width:${w}%;height:${h}%;z-index:${zIndex};overflow:hidden;${zoneBg}">
        ${innerHtml}
      </div>
    `);
  }

  const baseUrl = localBaseUrl();
  const compositeHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<base href="${baseUrl}/">
<style>
  html, body {
    margin: 0; padding: 0;
    width: ${profile.width}px; height: ${profile.height}px;
    background: ${escapeHtmlAttr(layout?.background_color || '#000000')}; overflow: hidden; position: relative;
    box-sizing: border-box;
  }
  *, *:before, *:after { box-sizing: inherit; }
  .zone-slot { position: absolute; overflow: hidden; }
  .zone-slot iframe, .zone-slot img, .zone-slot video { width: 100%; height: 100%; display: block; border: 0; }
</style>
</head>
<body>
  ${zoneHtmls.join('\n')}
</body>
</html>`;

  try {
    const png = await renderWidgetOrHtml(compositeHtml, profile, 'layout', options);
    return { png };
  } catch (e) {
    if (e.code === 'BROWSER_UNAVAILABLE' || e.code === 'BROWSER_NOT_FOUND') {
      return {
        unsupported: true,
        reason: 'Multi-zone layout rendering with widgets or web pages requires a browser (set CHROME_PATH).',
      };
    }
    throw e;
  }
}

module.exports = {
  render,
  renderRemotePage,
  renderLayout,
  renderLayoutNative,
  closeBrowser,
  getBrowser,
  looksLikeImage,
  isLayoutImageOnly,
  isBrowserAvailable,
  safeDimension,
  safeLocalImagePath,
  parseColorToRgba,
  withTimeout,
};
