/*
 * 3.0 TV-safe video: which file a video item plays on this TV, and how.
 *
 * A Tizen signage TV's hardware decoder is sized for 1920x1080. A tall clip (1080x1920) is taller
 * than it will open, so the HTML5 <video> shows black on a landscape TV and AVPlay fails to prepare
 * it on a portrait one. The server makes a copy the decoder accepts (server/lib/video-variants.js)
 * and lists the ready ones on the item as `video_variants: { kind: rev }`:
 *
 *   rot_cw / rot_ccw  the clip already turned into a landscape frame for a 'portrait' /
 *                     'portrait-flipped' screen (the same clockwise convention as app.js orientEl).
 *                     It is played UNROTATED, full-screen, outside the CSS-rotated #stage: the file
 *                     is already the picture the panel shows.
 *   fit               upright, scaled to fit 1920x1080, for a landscape screen: the normal path.
 *
 * `video_prerotated` is the operator saying the ORIGINAL file is already turned for portrait
 * screens: a portrait screen plays it as-is, the same unrotated way, and turns it nowhere.
 *
 * Modes:
 *   'flat'  <video> in the unrotated full-screen layer (#flatVideo), file = the copy or the original
 *   'av'    AVPlay with setDisplayRotation (#170) — a wide video on a portrait screen, which works,
 *           and a tall one whose copy is not ready yet (it may fail; avFallback says why)
 *   'html5' the normal <video> on #stage (file = the fit copy when there is one)
 *   'note'  a landscape TV whose fit copy is still being prepared: the honest note, not a black frame
 *
 * Dependency-free UMD: Node (server/test/tizen-video-plan.test.js) + Tizen (window.StVideoPlan).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StVideoPlan = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function isPortrait(o) { return o === 'portrait' || o === 'portrait-flipped'; }

  function rotKind(o) { return o === 'portrait-flipped' ? 'rot_ccw' : 'rot_cw'; }

  // Taller than wide, by the display size the server measured (rotation-aware, #170).
  function isTall(item) {
    var w = Number(item && item.width), h = Number(item && item.height);
    return w > 0 && h > 0 && h > w;
  }

  function hasVariant(item, kind) {
    var v = item && item.video_variants;
    return !!(v && typeof v === 'object' && v[kind] != null && v[kind] !== false);
  }

  /* The copy this item plays at this orientation, or null for the original file. */
  function variantKind(item, orientation) {
    if (!item || !item.content_id || item.remote_url) return null;
    if (isPortrait(orientation)) {
      if (Number(item.video_prerotated) === 1) return null;
      var k = rotKind(orientation);
      return isTall(item) && hasVariant(item, k) ? k : null;
    }
    return isTall(item) && hasVariant(item, 'fit') ? 'fit' : null;
  }

  function plan(item, orientation, avAvailable) {
    var portrait = isPortrait(orientation);
    var kind = variantKind(item, orientation);
    if (portrait) {
      if (kind) return { mode: 'flat', kind: kind };
      if (item && item.content_id && !item.remote_url && Number(item.video_prerotated) === 1) return { mode: 'flat', kind: null };
      return { mode: avAvailable ? 'av' : 'html5', kind: null };
    }
    // A tall original on a landscape TV is a black <video> (no error event to catch). While its
    // copy is on the way, say so instead; it plays by itself once ready (the payload remounts it).
    // Any other state still tries the original: some newer panels do decode it.
    if (!kind && isTall(item) && item.content_id && !item.remote_url && item.video_variant_state === 'preparing') {
      return { mode: 'note', kind: null };
    }
    return { mode: 'html5', kind: kind };
  }

  function variantPath(item, kind) {
    var rev = item.video_variants && item.video_variants[kind];
    return '/api/content/' + item.content_id + '/variant/' + kind + (rev != null ? '?rev=' + encodeURIComponent(rev) : '');
  }

  // The media cache keys a copy apart from its original: a different file, its own revision.
  function cacheKey(item, kind) { return item.content_id + '__' + kind; }

  /*
   * The list the media cache should hold for this orientation: an item that plays a copy is cached
   * AS the copy (key, the copy's revision, its URL path in __path); the tall original it replaces
   * is not downloaded at all — this TV cannot decode it.
   */
  function cacheItems(items, orientation) {
    var out = [];
    for (var i = 0; items && i < items.length; i++) {
      var it = items[i];
      var k = variantKind(it, orientation);
      if (!k) { out.push(it); continue; }
      out.push({ content_id: cacheKey(it, k), content_rev: it.video_variants[k], __path: variantPath(it, k) });
    }
    return out;
  }

  /* Which note the player shows when a tall video cannot be played here. */
  function noteKey(item) {
    if (!item || !isTall(item)) return 'portrait_video_unsupported';
    if (item.video_variant_state === 'preparing') return 'tall_video_preparing';
    if (item.video_variant_reason === 'no_ffmpeg') return 'tall_video_no_ffmpeg';
    return 'tall_video_unavailable';
  }

  return {
    isPortrait: isPortrait, rotKind: rotKind, isTall: isTall, variantKind: variantKind, plan: plan,
    variantPath: variantPath, cacheKey: cacheKey, cacheItems: cacheItems, noteKey: noteKey,
  };
});
