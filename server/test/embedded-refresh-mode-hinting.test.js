'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const { parseProfile } = require('../lib/embedded-profiles');
const {
  decideRefreshModeHeader,
  recordRenderedFrame,
  _lastRendered,
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
});
