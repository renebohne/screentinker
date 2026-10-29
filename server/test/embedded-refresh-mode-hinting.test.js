'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const { parseProfile } = require('../lib/embedded-profiles');
const {
  decideRefreshModeHeader,
  recordRenderedFrame,
  _lastRendered,
  LAST_RENDERED_TTL_MS,
  LAST_RENDERED_MAX_ENTRIES,
} = require('../routes/embedded');

describe('Ticket S5: Server Refresh Mode Hinting Logic', () => {
  after(() => {
    _lastRendered.clear();
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
});
