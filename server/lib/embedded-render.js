'use strict';

/*
 * Embedded renderer — Jimp backend (Phase 1).
 *
 * Takes a resolved playlist item + content row + screen_profile and returns a raw PNG
 * buffer ready for embedded-postprocess.js.
 *
 * Supported in Phase 1 (Jimp):
 *   image / local file  — resize to target dimensions, return PNG.
 *   remote_url          — if the URL points to a direct image, download + resize.
 *
 * Returns { unsupported: true, reason } for:
 *   widget / slide      — requires Puppeteer (Phase 2).
 *   youtube             — requires Puppeteer (Phase 2).
 *   remote_url          — when the URL is not a direct image (web page).
 *
 * ⚠️ This module is intentionally pure: no Express, no DB. All auth + DB lookups
 *    happen in routes/embedded.js before calling render().
 * ⚠️ Remote image fetching uses Node's built-in fetch (Node ≥ 18, present in this
 *    server's runtime). No new network dependencies.
 */

const fs   = require('fs');
const path = require('path');
const { Jimp } = require('jimp');

function uploadDir() {
  return process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
}

// MIME types Jimp can decode natively (+ @jsquash WASM for webp/avif, already in tree)
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
    return null; // not an image — caller responds 501
  }

  const buf = Buffer.from(await response.arrayBuffer());
  const img = await Jimp.fromBuffer(buf);
  img.cover({ w: profile.width, h: profile.height });
  return img.getBuffer('image/png');
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
  if (item && item.widget_id) {
    return {
      unsupported: true,
      reason: 'Widget content requires the Puppeteer renderer (Phase 2). ' +
              'Assign an image content item to this device for Phase 1 support.',
    };
  }

  const mime = (content.mime_type || '').toLowerCase();
  const remoteUrl = content.remote_url || '';

  if (remoteUrl.includes('youtube.com') || remoteUrl.includes('youtu.be')) {
    return {
      unsupported: true,
      reason: 'YouTube content requires the Puppeteer renderer (Phase 2).',
    };
  }

  if (mime.startsWith('video/')) {
    return {
      unsupported: true,
      reason: 'Video content is not supported by the embedded e-paper renderer.',
    };
  }

  if (content.remote_url) {
    const png = await renderRemoteImage(content, profile);
    if (!png) {
      return {
        unsupported: true,
        reason: 'Remote URL does not appear to be a direct image. ' +
                'Puppeteer renderer (Phase 2) is required for web pages.',
      };
    }
    return { png };
  }

  if (content.filepath) {
    const png = await renderLocalImage(content, profile);
    return { png };
  }

  return { unsupported: true, reason: 'No renderable source found for this content item.' };
}

module.exports = { render };
