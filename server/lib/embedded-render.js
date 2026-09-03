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

function uploadDir() {
  return process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
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

function looksLikeImage(url, contentType) {
  if (contentType) {
    const base = contentType.split(';')[0].trim().toLowerCase();
    if (IMAGE_MIMES.has(base)) return true;
  }
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
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
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  return null;
}

let browserInstance = null;

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

  browserInstance = await puppeteer.launch({
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
  });

  browserInstance.on('disconnected', () => {
    browserInstance = null;
  });

  return browserInstance;
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

async function renderLocalImage(content, profile) {
  const filepath = path.join(uploadDir(), 'content', content.filepath);
  if (!fs.existsSync(filepath)) {
    throw Object.assign(new Error('Content file not found on disk'), { code: 'NOT_FOUND' });
  }
  const img = await Jimp.fromBuffer(fs.readFileSync(filepath));
  img.cover({ w: profile.width, h: profile.height });
  return img.getBuffer('image/png');
}

async function renderRemoteImage(content, profile) {
  const url = content.remote_url;
  if (!url) return null;

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

async function renderWidgetOrHtml(html, profile) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: profile.width, height: profile.height });
    await page.setContent(html, { waitUntil: 'load', timeout: 5000 });
    const snap = await page.screenshot({ type: 'png' });
    return Buffer.from(snap);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Render the current playlist item to a PNG Buffer.
 *
 * @param {object} item     Playlist item row (joined by the route).
 * @param {object} content  Content row (joined by the route).
 * @param {object} profile  Validated screen_profile from embedded-profiles.js.
 * @returns {Promise<{ png: Buffer } | { unsupported: true, reason: string }>}
 */
async function render(item, content, profile) {
  // ── Widget / Slide Path ──────────────────────────────────────────────────
  if (item && (item.widget_id || item.widget_type)) {
    const type = item.widget_type || 'clock';
    let config = {};
    if (typeof item.widget_config === 'string') {
      try { config = JSON.parse(item.widget_config); } catch (_) {}
    } else if (typeof item.widget_config === 'object' && item.widget_config !== null) {
      config = item.widget_config;
    }

    try {
      const { renderWidgetHtml } = require('../routes/widgets');
      const html = renderWidgetHtml(type, config);
      const png = await renderWidgetOrHtml(html, profile);
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

    // Remote web page fallback via optional browser
    try {
      const browser = await getBrowser();
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: profile.width, height: profile.height });
        await page.goto(content.remote_url, { waitUntil: 'load', timeout: 10000 });
        const snap = await page.screenshot({ type: 'png' });
        return { png: Buffer.from(snap) };
      } finally {
        await page.close().catch(() => {});
      }
    } catch (e) {
      if (e.code === 'BROWSER_UNAVAILABLE' || e.code === 'BROWSER_NOT_FOUND') {
        return {
          unsupported: true,
          reason: 'Web page rendering requires a browser (set CHROME_PATH). Direct images work natively.',
        };
      }
      throw e;
    }
  }

  // ── Local Image (Primary native path) ────────────────────────────────────
  if (content && content.filepath) {
    const png = await renderLocalImage(content, profile);
    return { png };
  }

  return { unsupported: true, reason: 'No renderable source found for this content item.' };
}

module.exports = { render, closeBrowser, getBrowser };
