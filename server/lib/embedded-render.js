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
  const filepath = path.join(contentDir(), content.filepath);
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

async function renderWidgetOrHtml(html, profile, widgetType = '') {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: profile.width, height: profile.height });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 5000 });

    // For dynamic widgets with async network requests (e.g. weather), wait for data to populate
    if (widgetType === 'weather') {
      await page.waitForFunction(() => {
        const temp = document.getElementById('temp');
        const desc = document.getElementById('desc');
        return (temp && temp.textContent !== '--') || (desc && desc.textContent.length > 0);
      }, { timeout: 3500 }).catch(() => {});
    }

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
      const { renderWidgetHtml, imageResolverFor, dataResolverFor } = require('../routes/widgets');
      const { fontResolverFor } = require('../routes/fonts');
      const { db } = require('../db/database');

      let wsId = item.workspace_id || content?.workspace_id || profile?.workspace_id;
      if (!wsId && item.widget_id) {
        try {
          const w = db.prepare('SELECT workspace_id FROM widgets WHERE id = ?').get(item.widget_id);
          if (w) wsId = w.workspace_id;
        } catch (_) {}
      }

      const html = renderWidgetHtml(type, config, {
        resolveImage: imageResolverFor ? imageResolverFor({ workspace_id: wsId }) : undefined,
        resolveFont: fontResolverFor ? fontResolverFor({ workspace_id: wsId }) : undefined,
        resolveData: typeof dataResolverFor === 'function' ? dataResolverFor(wsId) : undefined,
      });
      const png = await renderWidgetOrHtml(html, profile, type);
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

function escapeHtmlAttr(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Render a multi-zone layout composition into a composite PNG Buffer.
 *
 * @param {object} layout - Layout record
 * @param {Array<{ zone: object, item: object|null, content: object|null }>} zoneEntries
 * @param {object} profile - screen_profile
 * @returns {Promise<{ png: Buffer } | { unsupported: true, reason: string }>}
 */
async function renderLayout(layout, zoneEntries, profile) {
  const { renderWidgetHtml, imageResolverFor, dataResolverFor } = require('../routes/widgets');
  const { fontResolverFor } = require('../routes/fonts');
  const { db } = require('../db/database');

  const zoneHtmls = [];

  for (const entry of zoneEntries) {
    const { zone, item, content } = entry;
    const x = Number(zone.x_percent) || 0;
    const y = Number(zone.y_percent) || 0;
    const w = Number(zone.width_percent) || 100;
    const h = Number(zone.height_percent) || 100;
    const zIndex = Number(zone.z_index) || 1;

    let innerHtml = '<div style="width:100%;height:100%;background:transparent;"></div>';

    if (item && (item.widget_id || item.widget_type)) {
      const type = item.widget_type || 'clock';
      let config = {};
      if (typeof item.widget_config === 'string') {
        try { config = JSON.parse(item.widget_config); } catch (_) {}
      } else if (typeof item.widget_config === 'object' && item.widget_config !== null) {
        config = item.widget_config;
      }

      let wsId = item.workspace_id || layout?.workspace_id || profile?.workspace_id;
      if (!wsId && item.widget_id) {
        try {
          const row = db.prepare('SELECT workspace_id FROM widgets WHERE id = ?').get(item.widget_id);
          if (row) wsId = row.workspace_id;
        } catch (_) {}
      }

      const widgetHtml = renderWidgetHtml(type, config, {
        resolveImage: imageResolverFor ? imageResolverFor({ workspace_id: wsId }) : undefined,
        resolveFont: fontResolverFor ? fontResolverFor({ workspace_id: wsId }) : undefined,
        resolveData: typeof dataResolverFor === 'function' ? dataResolverFor(wsId) : undefined,
      });

      innerHtml = `<iframe srcdoc="${escapeHtmlAttr(widgetHtml)}" style="width:100%;height:100%;border:none;overflow:hidden;display:block;" scrolling="no"></iframe>`;
    } else if (content && content.remote_url) {
      innerHtml = `<img src="${escapeHtmlAttr(content.remote_url)}" style="width:100%;height:100%;object-fit:cover;display:block;" />`;
    } else if (content && content.filepath) {
      const safe = path.resolve(contentDir(), path.basename(content.filepath));
      if (safe.startsWith(path.resolve(contentDir())) && fs.existsSync(safe)) {
        try {
          const buf = fs.readFileSync(safe);
          const ext = path.extname(content.filepath).toLowerCase();
          const mime = EXT_MIME[ext] || content.mime_type || 'image/png';
          innerHtml = `<img src="data:${mime};base64,${buf.toString('base64')}" style="width:100%;height:100%;object-fit:cover;display:block;" />`;
        } catch (_) {}
      }
    }

    zoneHtmls.push(`
      <div class="zone-slot" style="position:absolute;left:${x}%;top:${y}%;width:${w}%;height:${h}%;z-index:${zIndex};overflow:hidden;">
        ${innerHtml}
      </div>
    `);
  }

  const compositeHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body {
    margin: 0; padding: 0;
    width: ${profile.width}px; height: ${profile.height}px;
    background: #000000; overflow: hidden; position: relative;
    box-sizing: border-box;
  }
  *, *:before, *:after { box-sizing: inherit; }
  .zone-slot { position: absolute; overflow: hidden; }
  .zone-slot iframe, .zone-slot img { width: 100%; height: 100%; display: block; border: 0; }
</style>
</head>
<body>
  ${zoneHtmls.join('\n')}
</body>
</html>`;

  try {
    const png = await renderWidgetOrHtml(compositeHtml, profile, 'layout');
    return { png };
  } catch (e) {
    if (e.code === 'BROWSER_UNAVAILABLE' || e.code === 'BROWSER_NOT_FOUND') {
      return {
        unsupported: true,
        reason: 'Multi-zone layout rendering requires a browser (set CHROME_PATH).',
      };
    }
    throw e;
  }
}

module.exports = { render, renderLayout, closeBrowser, getBrowser };

