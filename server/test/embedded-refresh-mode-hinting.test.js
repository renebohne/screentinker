'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers/embedded-real-db').boot();
const { parseProfile } = require('../lib/embedded-profiles');
const {
  decideRefreshModeHeader,
  recordRenderedFrame,
  _lastRendered,
  LAST_RENDERED_TTL_MS,
  LAST_RENDERED_MAX_ENTRIES,
} = require('../routes/embedded');

describe('Ticket S5: Server Refresh Mode Hinting Logic', () => {
  after(async () => {
    _lastRendered.clear();
    await h.close();
  });

  test('devices with supportsPartialRefresh: false always get "full"', () => {
    const e1002 = parseProfile('seeed-reterminal-e1002');
    assert.equal(e1002.supportsPartialRefresh, false);

    const mode = decideRefreshModeHeader('dev-spectra6', e1002, { itemIndex: 0, contentId: 'c1', layoutId: null });
    assert.equal(mode, 'full');
  });

  test('devices with refreshMode: "always_full" always get "full"', () => {
    const stickyAlwaysFull = parseProfile(JSON.stringify({
      preset: 'seeed-reterminal-sticky',
      refreshMode: 'always_full'
    }));
    assert.equal(stickyAlwaysFull.refreshMode, 'always_full');

    const mode = decideRefreshModeHeader('dev-sticky-full', stickyAlwaysFull, { itemIndex: 0, contentId: 'c1', layoutId: null });
    assert.equal(mode, 'full');
  });

  test('first render for a newly connected/re-paired device gets "full"', () => {
    const sticky = parseProfile('seeed-reterminal-sticky');
    _lastRendered.delete('dev-new');

    const mode = decideRefreshModeHeader('dev-new', sticky, { itemIndex: 0, contentId: 'c1', layoutId: null });
    assert.equal(mode, 'full', 'first render must advise full refresh to clean display');
  });

  test('subsequent renders of the same item/content return "partial"', () => {
    const sticky = parseProfile('seeed-reterminal-sticky');
    const devId = 'dev-clock-widget';

    // First render
    const mode1 = decideRefreshModeHeader(devId, sticky, { itemIndex: 0, contentId: 'clock-1', layoutId: null });
    assert.equal(mode1, 'full');
    recordRenderedFrame(devId, { itemIndex: 0, contentId: 'clock-1', layoutId: null });

    // Next render of the same clock widget (minute update)
    const mode2 = decideRefreshModeHeader(devId, sticky, { itemIndex: 0, contentId: 'clock-1', layoutId: null });
    assert.equal(mode2, 'partial', 'incremental widget update should advise partial refresh');
  });

  test('transitioning between different playlist items returns "full"', () => {
    const sticky = parseProfile('seeed-reterminal-sticky');
    const devId = 'dev-playlist';

    // Render item 0
    recordRenderedFrame(devId, { itemIndex: 0, contentId: 'item-0', layoutId: null });

    // Transitioning to item 1
    const modeNext = decideRefreshModeHeader(devId, sticky, { itemIndex: 1, contentId: 'item-1', layoutId: null });
    assert.equal(modeNext, 'full', 'transitioning between playlist items must advise full refresh');
  });

  test('transitioning to/from a multi-zone layout returns "full"', () => {
    const sticky = parseProfile('seeed-reterminal-sticky');
    const devId = 'dev-layout-switch';

    // Render single item
    recordRenderedFrame(devId, { itemIndex: 0, contentId: 'single-1', layoutId: null });

    // Switch to multi-zone layout
    const modeLayout = decideRefreshModeHeader(devId, sticky, { itemIndex: 0, contentId: 'layout-abc', layoutId: 'layout-abc' });
    assert.equal(modeLayout, 'full', 'switching to multi-zone layout must advise full refresh');
  });

  test('stale entries (older than TTL) are evicted and advise "full"', () => {
    const sticky = parseProfile('seeed-reterminal-sticky');
    const devId = 'dev-stale';

    // Simulate a device last rendered 25 h ago (beyond the 24 h TTL)
    _lastRendered.set(devId, {
      itemIndex: 0, contentId: 'c1', layoutId: null,
      at: Date.now() - LAST_RENDERED_TTL_MS - 60 * 60 * 1000,
    });

    const mode = decideRefreshModeHeader(devId, sticky, { itemIndex: 0, contentId: 'c1', layoutId: null });
    assert.equal(mode, 'full', 'entry older than TTL must advise full refresh');
    assert.equal(_lastRendered.has(devId), false, 'stale entry must be evicted');
  });

  test('map is bounded: least-recently-recorded entry is evicted at the size cap', () => {
    const sticky = parseProfile('seeed-reterminal-sticky');
    _lastRendered.clear();

    // Fill the map to the cap
    for (let i = 0; i < LAST_RENDERED_MAX_ENTRIES; i++) {
      recordRenderedFrame(`dev-fill-${i}`, { itemIndex: 0, contentId: `c-${i}`, layoutId: null });
    }
    assert.equal(_lastRendered.size, LAST_RENDERED_MAX_ENTRIES);

    // One more device must evict the oldest (dev-fill-0), keeping size at the cap
    recordRenderedFrame('dev-overflow', { itemIndex: 0, contentId: 'x', layoutId: null });
    assert.equal(_lastRendered.size, LAST_RENDERED_MAX_ENTRIES, 'size must stay bounded at the cap');
    assert.equal(_lastRendered.has('dev-fill-0'), false, 'oldest entry must be evicted');
    assert.equal(_lastRendered.has('dev-overflow'), true, 'new entry must be recorded');

    // Re-recording an existing device refreshes its LRU position (no eviction, no growth)
    const secondOldest = 'dev-fill-1';
    recordRenderedFrame(secondOldest, { itemIndex: 0, contentId: 'c-1b', layoutId: null });
    assert.equal(_lastRendered.size, LAST_RENDERED_MAX_ENTRIES);
    recordRenderedFrame('dev-overflow-2', { itemIndex: 0, contentId: 'y', layoutId: null });
    assert.equal(_lastRendered.has(secondOldest), true, 'recently re-recorded entry must survive eviction');

    // Sanity: hinting still works for a survivor
    const mode = decideRefreshModeHeader(secondOldest, sticky, { itemIndex: 0, contentId: 'c-1b', layoutId: null });
    assert.equal(mode, 'partial');

    _lastRendered.clear();
  });

  test('transitioning orientation, colorDepth, dither, fitMode, or backgroundColor advises "full"', () => {
    const sticky = parseProfile('seeed-reterminal-sticky');
    const devId = 'dev-profile-transitions';

    const baseState = {
      itemIndex: 0,
      contentId: 'item-0',
      layoutId: null,
      orientation: 'landscape',
      colorDepth: '1bit',
      dither: 'floyd-steinberg',
      fitMode: 'cover',
      backgroundColor: '#000000',
    };

    // 1. Initial render -> 'full', record base state
    assert.equal(decideRefreshModeHeader(devId, sticky, baseState), 'full');
    recordRenderedFrame(devId, baseState);

    // 2. Same state -> 'partial'
    assert.equal(decideRefreshModeHeader(devId, sticky, baseState), 'partial');

    // 3. Orientation change -> 'full'
    assert.equal(decideRefreshModeHeader(devId, sticky, { ...baseState, orientation: 'portrait' }), 'full');

    // 4. Color depth change (e.g. 1bit to gray4) -> 'full'
    assert.equal(decideRefreshModeHeader(devId, sticky, { ...baseState, colorDepth: 'gray4' }), 'full');

    // 5. Dither change -> 'full'
    assert.equal(decideRefreshModeHeader(devId, sticky, { ...baseState, dither: 'atkinson' }), 'full');

    // 6. Fit mode change (e.g. cover to contain) -> 'full'
    assert.equal(decideRefreshModeHeader(devId, sticky, { ...baseState, fitMode: 'contain' }), 'full');

    // 7. Background color change -> 'full'
    assert.equal(decideRefreshModeHeader(devId, sticky, { ...baseState, backgroundColor: '#FFFFFF' }), 'full');

    _lastRendered.clear();
  });

  test('hasIfNoneMatch: false returns "full" even when previous frame matches (Item 5 unit test)', () => {
    const sticky = parseProfile('seeed-reterminal-sticky');
    const devId = 'dev-reboot-unit';
    recordRenderedFrame(devId, { itemIndex: 0, contentId: 'c1', layoutId: null });

    // With hasIfNoneMatch: false (device rebooted, no ETag sent)
    const mode = decideRefreshModeHeader(devId, sticky, { itemIndex: 0, contentId: 'c1', layoutId: null, hasIfNoneMatch: false });
    assert.equal(mode, 'full', 'must advise full refresh after cold boot / missing If-None-Match');

    // With hasIfNoneMatch: true (subsequent poll sent ETag)
    const mode2 = decideRefreshModeHeader(devId, sticky, { itemIndex: 0, contentId: 'c1', layoutId: null, hasIfNoneMatch: true });
    assert.equal(mode2, 'partial');

    // With hasIfNoneMatch: undefined (backwards compatibility for direct calls)
    const mode3 = decideRefreshModeHeader(devId, sticky, { itemIndex: 0, contentId: 'c1', layoutId: null });
    assert.equal(mode3, 'partial');
  });

  test('HTTP: poll without If-None-Match after matching frame advises "full" (Item 5)', async () => {
    const base = await h.ready();
    const p = await h.mkPanel('seeed-reterminal-sticky');

    // 1. Initial poll -> 200, full refresh, get ETag
    const res1 = await fetch(`${base}/render?device_id=${p.id}`, {
      headers: { Authorization: `Bearer ${p.token}` },
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get('x-st-refresh-mode'), 'full');
    const etag1 = res1.headers.get('etag');
    assert.ok(etag1);

    // 2. Poll with stale If-None-Match (simulating content update on device holding frame)
    const res2 = await fetch(`${base}/render?device_id=${p.id}`, {
      headers: { Authorization: `Bearer ${p.token}`, 'If-None-Match': '"stale-etag"' },
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.headers.get('x-st-refresh-mode'), 'partial', 'matching item with If-None-Match should advise partial');

    // 3. Poll without If-None-Match (simulating device reboot)
    const res3 = await fetch(`${base}/render?device_id=${p.id}`, {
      headers: { Authorization: `Bearer ${p.token}` },
    });
    assert.equal(res3.status, 200);
    assert.equal(res3.headers.get('x-st-refresh-mode'), 'full', 'poll without If-None-Match must advise full refresh');
  });

  test('HTTP: fallback loop advancing to another item recomputes X-ST-Refresh-Mode (Item 6)', async () => {
    const base = await h.ready();
    const p = await h.mkPanel('seeed-reterminal-sticky');

    // Insert an unsupported content item (e.g. video or invalid file) as item 0
    const badCid = 'c-bad-' + p.id;
    h.insert('content', {
      id: badCid,
      workspace_id: h.ids.ws,
      user_id: h.ids.user,
      filename: 'video.mp4',
      filepath: 'nonexistent-video.mp4',
      mime_type: 'video/mp4',
      file_size: 100,
      created_at: 1,
      updated_at: 1,
    });

    const plRow = h.db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(p.id);
    const validItem = h.db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(plRow.playlist_id);
    const goodCid = JSON.parse(validItem.published_snapshot)[0].content_id;

    // Set up 2-item playlist: item 0 is bad, item 1 is good
    const newSnapshot = [
      { id: 'pi-0-' + p.id, content_id: badCid, duration_sec: 30, enabled: 1 },
      { id: 'pi-1-' + p.id, content_id: goodCid, duration_sec: 30, enabled: 1 },
    ];
    h.db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?').run(JSON.stringify(newSnapshot), plRow.playlist_id);

    // Poll once on item 1 so item 1 is recorded in _lastRendered
    const res1 = await fetch(`${base}/render?device_id=${p.id}&item=1`, {
      headers: { Authorization: `Bearer ${p.token}` },
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get('x-st-item-index'), '1');

    // Now poll item 0 with If-None-Match. Item 0 fails/unsupported, falls back to item 1.
    // Refresh mode must reflect item 1 actually served (matching previous render -> partial),
    // not item 0 (which would have been full due to index/content change from item 1 to 0).
    const res2 = await fetch(`${base}/render?device_id=${p.id}&item=0`, {
      headers: { Authorization: `Bearer ${p.token}`, 'If-None-Match': '"stale-etag"' },
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.headers.get('x-st-item-index'), '1', 'fallback served item 1');
    assert.equal(res2.headers.get('x-st-refresh-mode'), 'partial', 'refresh mode must reflect item 1 actually served');
  });

  test('HTTP: scheduled_off 304 response includes X-ST-Color-Mode and X-ST-Refresh-Mode (Item 9)', async () => {
    const base = await h.ready();
    const p = await h.mkPanel('seeed-reterminal-sticky');

    // Create 24/7 OFF power schedule
    const schedId = 'sched-off-' + p.id;
    const windows = JSON.stringify([{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }]);
    h.db.prepare('INSERT INTO display_power_schedules (id, workspace_id, name, device_id, enabled, timezone, windows) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run(schedId, h.ids.ws, 'Off Sched', p.id, 'UTC', windows);

    const res = await fetch(`${base}/render?device_id=${p.id}`, {
      headers: {
        Authorization: `Bearer ${p.token}`,
        'If-None-Match': '"cached-etag-123"',
      },
    });
    assert.equal(res.status, 304);
    assert.equal(res.headers.get('x-st-power-state'), 'scheduled_off');
    assert.equal(res.headers.get('x-st-color-mode'), '1bit');
    assert.equal(res.headers.get('x-st-refresh-mode'), 'partial');

    h.db.prepare('DELETE FROM display_power_schedules WHERE id = ?').run(schedId);
  });
});
