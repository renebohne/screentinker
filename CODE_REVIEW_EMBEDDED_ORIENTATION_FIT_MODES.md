# Code Review: Embedded Device Orientation & Single-Item Image Fit Modes

- **Branch reviewed:** `feat/embedded-image-fit-modes` (`8b1fe527`) and its parent commits (`6f3eb7c5`, `a06bc786`, `4408466d`)
- **Date:** 2026-10-29
- **Status:** Changes requested before delivery

---

## Executive Summary

The unit and integration test suites (`embedded-fit-modes.test.js`, `embedded-dynamic-color-modes.test.js`, `embedded-refresh-mode-hinting.test.js`, `reterminal-e-series.test.js`) pass (`61/61`), and the Jimp resize primitives (`cover`, `contain`, `fill`) work in isolation. However, there are **6 functional and integration issues** (2 High, 3 Medium, 1 Low) where device orientation, image fit modes, ETag caching, refresh-mode hinting, and dashboard device settings interact.

---

## Findings & Remediation Guide

### 1. [HIGH] Dashboard Orientation selector has no effect on embedded renders, and saving Settings strips custom `screen_profile` fields

#### Affected Files
- `frontend/js/views/device-detail.js` (lines 1441–1449, 3020–3078)
- `server/routes/devices.js` (lines 823–895)
- `server/routes/embedded.js` (lines 1018–1023)

#### Root Cause
1. The device Settings UI renders `#deviceOrientation` (`landscape`, `portrait`, `landscape-flipped`, `portrait-flipped`) for all devices and saves the chosen value to `devices.orientation` via `PUT /api/devices/:id`.
2. In `server/routes/embedded.js`, `resolveOrientationRotation(req, device)` intentionally ignores `devices.orientation` (because the SQLite schema defaults `devices.orientation` to `'landscape'` on every row) and only checks:
   - Request query/headers (`?orientation=`, `X-ST-Device-Orientation`, etc.)
   - `devices.reported_orientation` (set when the MCU sends `X-ST-Device-Orientation` on a device-token poll)
   - `screen_profile.orientation` (parsed by `parseProfile()`)
3. When an operator clicks **Save Settings** in `frontend/js/views/device-detail.js` (lines 3024–3050), `epdProfileUpdate` reconstructs `screen_profile` from scratch with **only** four keys:
   ```js
   epdProfileUpdate = {
     preset: existingPreset,
     colorDepth: colorModeEl ? colorModeEl.value : (existingColorDepth || '1bit'),
     dither: ditherEl ? (ditherEl.value || 'floyd-steinberg') : 'floyd-steinberg',
     refreshMode: refreshModeEl ? refreshModeEl.value : (existingRefreshMode || 'smart_partial'),
   };
   ```
   - Changing `#deviceOrientation` in the Dashboard never updates `screen_profile.orientation` or `devices.reported_orientation`, so `/api/embedded/render` and `/api/embedded/info` ignore the operator's orientation change.
   - If `device.screen_profile` previously stored custom JSON fields (`orientation`, `rotation`, `width`, `height`, `outputFormat`, `mcuTranspose`), clicking **Save Settings** overwrites `screen_profile` and permanently deletes those fields.

#### How to Fix
1. In `frontend/js/views/device-detail.js`:
   - Parse and preserve any existing object properties on `device.screen_profile` (`...existingProfileObj`) when building `epdProfileUpdate` instead of discarding unknown keys.
   - Populate `#deviceOrientation` for embedded devices from the effective embedded orientation (`screen_profile.orientation || device.reported_orientation || device.orientation || 'landscape'`), and include `orientation: document.getElementById('deviceOrientation').value` in `epdProfileUpdate` (or sync it in `PUT /api/devices/:id` when `client_type === 'embedded'`).
2. Add a test verifying that changing orientation and saving settings on an embedded device updates the rendered frame dimensions (`X-ST-Screen-Width` / `X-ST-Screen-Height` / `X-ST-Orientation`) and preserves existing `screen_profile` fields.

---

### 2. [HIGH] Unspecified `fit_mode` fallback (`'cover'`) contradicts native/Android/web player parity on portrait orientations and ignores 1-zone layout `fit_mode`

#### Affected Files
- `server/lib/embedded-render.js` (lines 29–31, 306, 758)
- `server/routes/embedded.js` (lines 1134–1144)
- `server/test/embedded-fit-modes.test.js` (lines 93–109)

#### Root Cause
1. In `server/lib/embedded-render.js` (lines 306 and 758), single-item image rendering resolves `fit_mode` via:
   ```js
   const fitMode = safeFitMode(item && item.fit_mode, 'cover');
   ```
   And `server/test/embedded-fit-modes.test.js` (line 93) states: `unspecified fit_mode defaults to cover (matching native player parity)`.
2. However, on `main` (PR #555 / commit `7388c3c5`, `native/screentinker_native/player/engine.py` lines 527–531), the native player fallback for an item with no explicit `fit_mode` (`null`, labeled *"Layout"* in the dashboard) was changed from `'cover'` to `'contain'` to match Android (`RESIZE_MODE_FIT`) and the web player:
   > *"With no fit of its own ('Layout' in the dashboard), a fullscreen item was drawn cover: barely visible on a landscape panel, but on a screen turned to portrait a landscape video showed only its middle third."*
   On a portrait-mounted e-paper panel (e.g. `480x800` or `1200x1600`), defaulting `fit_mode: null` to `'cover'` crops two-thirds of a landscape image unless the user explicitly bulk-edits the playlist item's `fit_mode` to `'contain'`.
3. Furthermore, when a device is assigned a **single-zone layout** (`layoutResolved.zoneEntries.length === 1`), `GET /api/embedded/render` (`server/routes/embedded.js` line 1136) only routes to `handleRenderLayout` when `zoneEntries.length > 1` and otherwise falls through to `handleRenderStandard`. In `handleRenderStandard`, `zoneEntries[0].zone.fit_mode` (which defaults to `'contain'` in `schema.sql`) is never consulted, so an item with `fit_mode: null` ("inherit from layout") ignores its zone's `fit_mode`.

#### How to Fix
1. Align the unspecified `fit_mode` fallback for fullscreen single items (or document/decide whether embedded intentionally diverges from native/Android/web player parity).
2. When a device has a 1-zone layout (`layoutResolved?.zoneEntries.length === 1`) and falls through to `handleRenderStandard`, pass the zone's `fit_mode` and `background_color` as fallbacks when `item.fit_mode` is `null`.

---

### 3. [MEDIUM] ETag / Cache Key does not include `device.background_color` or multi-zone item `fit_mode`

#### Affected Files
- `server/lib/embedded-cache.js` (lines 44–66)
- `server/routes/embedded.js` (lines 859–860, 1304–1312, 1528–1533)

#### Root Cause
1. In `contain` mode (and in `renderLayoutNative` / `renderLayout`), `device.background_color` fills the letterbox bars around the image.
2. However, `cacheKey(deviceId, itemId, itemUpdatedAt, profile)` in `server/lib/embedded-cache.js` only hashes:
   `[deviceId, itemId, itemUpdatedAt, profile.width, profile.height, profile.rotation, profile.colorDepth, profile.dither, profile.outputFormat]` (plus optional `orientation` and `mcuTranspose`).
3. If an operator changes `device.background_color` in the dashboard (for instance, from `#000000` black to `#FFFFFF` white so letterboxed portrait/landscape images do not have heavy black bars on e-paper), the cache key and `ETag` do not change. Subsequent polls return `304 Not Modified` or serve the stale black-letterboxed frame from disk cache.
4. Similarly, in `resolveLayoutItems()` (`server/routes/embedded.js` line 860):
   ```js
   dynamicRevParts.push(`z_${zone.id}_${item.content_id || item.widget_id || item.id || 'item'}_${dRev}`);
   ```
   Neither `item.fit_mode` nor `zone.fit_mode` is included in `dynamicRevParts`, and `dynamicRevFor(item)` only reads `content_updated_at` / `widget_updated_at` (not `playlist_items.updated_at`). Changing an item's `fit_mode` in a multi-zone layout and republishing does not invalidate the layout cache key.

#### How to Fix
1. Include `device.background_color` (when non-default / present, to avoid invalidating existing default-black fleet ETags) in the cache key inputs for both standard and layout renders.
2. Include `fitSuffix` (`item.fit_mode || zone.fit_mode || ''`) in `dynamicRevParts` inside `resolveLayoutItems()` (`server/routes/embedded.js` line 860).
3. In `handleRenderStandard` (`server/routes/embedded.js` line 1305), normalize `fitSuffix` via `safeFitMode` so invalid strings do not create arbitrary cache keys, and if the render fallback loop (lines 1369–1388) advances to a different `renderItem` on `attempt > 0`, recompute `key` / headers for `renderItem` before caching.

---

### 4. [MEDIUM] `X-ST-Refresh-Mode` hinting advises `'partial'` across orientation, color-mode, and fit-mode changes

#### Affected Files
- `server/routes/embedded.js` (lines 1201–1234, 1327–1331, 1353–1357, 1415–1419, 1547–1551)

#### Root Cause
`decideRefreshModeHeader()` and `recordRenderedFrame()` only store and compare `{ itemIndex, contentId, layoutId, at }`:
```js
if (prev.layoutId !== current.layoutId) return 'full';
if (prev.itemIndex !== current.itemIndex || prev.contentId !== current.contentId) return 'full';
return 'partial';
```
If a device changes orientation (`landscape` ↔ `portrait`), changes `colorDepth` (`1bit` ↔ `gray4`), changes `dither`, or changes `fit_mode` (`cover` ↔ `contain`) while displaying the same playlist item, the server renders a completely different `200 OK` frame buffer but sets `X-ST-Refresh-Mode: partial` instead of `full`. On e-paper panels, a full geometry/aspect/depth transition requires a `'full'` refresh to prevent ghosting.

#### How to Fix
Include the profile/render signature (e.g. `orientation: frameOrientation(profile)`, `colorDepth: profile.colorDepth`, `dither: profile.dither`, `fitMode`, `backgroundColor`) in the state object passed to `decideRefreshModeHeader()` and `recordRenderedFrame()`, and return `'full'` whenever any of those fields change.

---

### 5. [MEDIUM] `profile.fitMode` in `postprocess()` is unreachable and lacks background color handling

#### Affected Files
- `server/lib/embedded-postprocess.js` (lines 425–437)
- `server/lib/embedded-profiles.js` (lines 240–296)
- `server/routes/embedded.js` (line 1402)

#### Root Cause
1. `postprocess(pngBuffer, profile)` checks `profile.fitMode` when `img.bitmap.width !== width || img.bitmap.height !== height`.
2. However, `parseProfile()` in `server/lib/embedded-profiles.js` constructs a fresh `result` object and never copies `fitMode`, nor does `handleRenderStandard()` set `profile.fitMode` before calling `postprocess()`.
3. Even if `postprocess()` is called directly with `profile.fitMode = 'contain'` on an image whose dimensions differ from `width × height`, `img.background` is not set before `img.contain({ w: width, h: height })`. Jimp leaves the letterbox bars as transparent black (`rgba(0,0,0,0)`), which stays transparent in `24bit-rgb888` PNG output and quantizes to black in packed formats regardless of `backgroundColor`.

#### How to Fix
1. Either pass `fitMode` and `backgroundColor` through to `postprocess()` (and composite onto a background-colored canvas before `contain`), or keep `postprocess()` strictly as a post-render safety net with documented behavior.

---

### 6. [LOW] Transparent PNGs ignore `device.background_color` inside the image bounding box

#### Affected Files
- `server/lib/embedded-render.js` (lines 306–315, 758–767)

#### Root Cause
In `renderRemoteImage()` and `render()`, setting `img.background = parseColorToRgba(bgColorHex, 0x000000FF)` before `img.contain({ w: profile.width, h: profile.height })` only fills the outer letterbox bars created by `contain()`. Any transparent pixels *inside* the source PNG remain `rgba(0,0,0,0)` in `contain`, `cover`, and `fill` modes. When `postprocess()` later computes luminance from `rgba[i*4 .. i*4+2]` (ignoring alpha `rgba[i*4+3]`), transparent pixels become pure black (`0,0,0`) even when `device.background_color` is set to white (`#FFFFFF`).

#### How to Fix
Composite the resized image onto a background-colored canvas in all fit modes (matching `renderLayoutNative()` in `server/lib/embedded-render.js` line 826):
```js
const bgColorHex = safeHexColor(options?.device?.background_color || options?.backgroundColor, '#000000');
const bgRgba = parseColorToRgba(bgColorHex, 0x000000FF);
const canvas = new Jimp({ width: profile.width, height: profile.height, color: bgRgba });
if (fitMode === 'cover') {
  img.cover({ w: profile.width, h: profile.height });
} else if (fitMode === 'fill') {
  img.resize({ w: profile.width, h: profile.height });
} else {
  img.contain({ w: profile.width, h: profile.height });
}
canvas.composite(img, 0, 0);
return canvas.getBuffer('image/png');
```
