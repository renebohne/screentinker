'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Jimp } = require('jimp');

const { parseProfile, PRESETS } = require('../lib/embedded-profiles');
const { packGray4, postprocess, UnpackableWidthError } = require('../lib/embedded-postprocess');
const { cacheKey } = require('../lib/embedded-cache');

describe('Ticket S1: Profile Definitions & Validation', () => {
  test('reTerminal Sticky profile declares supportedColorModes and GT911 touch', () => {
    const p = parseProfile('seeed-reterminal-sticky');
    assert.deepEqual(p.supportedColorModes, ['1bit', 'gray4']);
    assert.equal(p.defaultColorDepth, '1bit');
    assert.equal(p.colorDepth, '1bit');
    assert.equal(p.touchSupported, true);
    assert.equal(p.touchController, 'GT911');
  });

  test('reTerminal E1001 preserves mcuTranspose: true and supports 1bit and gray4', () => {
    const p = parseProfile('seeed-reterminal-e1001');
    assert.deepEqual(p.supportedColorModes, ['1bit', 'gray4']);
    assert.equal(p.defaultColorDepth, '1bit');
    assert.equal(p.colorDepth, '1bit');
    assert.equal(p.mcuTranspose, true);
  });

  test('reTerminal E1003 is gray16-only until MCU Ticket 4', () => {
    const p = parseProfile('seeed-reterminal-e1003');
    assert.deepEqual(p.supportedColorModes, ['gray16']);
    assert.equal(p.defaultColorDepth, 'gray16');
    assert.equal(p.colorDepth, 'gray16');
  });

  test('parseProfile validates colorDepth against supportedColorModes with fallback', () => {
    // If a stored profile set colorDepth: 'gray4' while device was Sticky, then preset changed to E1003
    const invalidE1003 = parseProfile(JSON.stringify({
      preset: 'seeed-reterminal-e1003',
      colorDepth: 'gray4'
    }));
    assert.equal(invalidE1003.colorDepth, 'gray16', 'should fall back to defaultColorDepth of preset');

    // Valid override on Sticky
    const validStickyGray4 = parseProfile(JSON.stringify({
      preset: 'seeed-reterminal-sticky',
      colorDepth: 'gray4'
    }));
    assert.equal(validStickyGray4.colorDepth, 'gray4');
  });

  test('parseProfile rejects gray4 with width not divisible by 4 (CRUMB_DEPTHS)', () => {
    // 801 is not divisible by 4
    const oddWidth = parseProfile(JSON.stringify({
      width: 801,
      height: 480,
      colorDepth: 'gray4'
    }));
    assert.equal(oddWidth, null, 'should reject width not divisible by 4');

    const validWidth = parseProfile(JSON.stringify({
      width: 800,
      height: 480,
      colorDepth: 'gray4'
    }));
    assert.ok(validWidth);
    assert.equal(validWidth.width, 800);
  });
});

describe('Ticket S2: Gray4 4-Level Grayscale Postprocessing Pipeline', () => {
  test('packGray4 rejects width not divisible by 4', () => {
    const rgba = new Uint8Array(5 * 2 * 4);
    assert.throws(() => packGray4(rgba, 5, 2), UnpackableWidthError);
  });

  test('packGray4 produces exactly (W*H)/4 bytes', () => {
    const w = 800, h = 480;
    const rgba = new Uint8Array(w * h * 4);
    const packed = packGray4(rgba, w, h);
    assert.equal(packed.length, 96000);
  });

  test('packGray4 all-black and all-white test vectors', () => {
    // 8x2 all black
    const blackRgba = new Uint8Array(8 * 2 * 4); // all 0
    const blackPacked = packGray4(blackRgba, 8, 2);
    assert.equal(blackPacked.length, 4);
    assert.deepEqual([...blackPacked], [0x00, 0x00, 0x00, 0x00]);

    // 8x2 all white
    const whiteRgba = new Uint8Array(8 * 2 * 4).fill(255);
    const whitePacked = packGray4(whiteRgba, 8, 2);
    assert.equal(whitePacked.length, 4);
    assert.deepEqual([...whitePacked], [0xFF, 0xFF, 0xFF, 0xFF]);
  });

  test('packGray4 bit order matches MCU test_08 vector ([Black, DarkGray, LightGray, White])', () => {
    // 4 pixels:
    // px0: Black (#000000) -> 0b00 (0)
    // px1: Dark Gray (#555555) -> 0b01 (1)
    // px2: Light Gray (#AAAAAA) -> 0b10 (2)
    // px3: White (#FFFFFF) -> 0b11 (3)
    // MSB-first packing: (0 << 6) | (1 << 4) | (2 << 2) | (3 << 0) = 0b00011011 = 0x1B
    const rgba = new Uint8Array([
      0, 0, 0, 255,          // Black (level 0)
      85, 85, 85, 255,       // Dark Gray (level 1)
      170, 170, 170, 255,    // Light Gray (level 2)
      255, 255, 255, 255,    // White (level 3)
    ]);
    const packed = packGray4(rgba, 4, 1, 'none');
    assert.equal(packed.length, 1);
    assert.equal(packed[0], 0x1B, 'Expected 0x1B (0b00_01_10_11) for [Black, DarkGray, LightGray, White]');

    // Reverse order: [White, LightGray, DarkGray, Black]
    // (3 << 6) | (2 << 4) | (1 << 2) | (0 << 0) = 0b11100100 = 0xE4
    const revRgba = new Uint8Array([
      255, 255, 255, 255,
      170, 170, 170, 255,
      85, 85, 85, 255,
      0, 0, 0, 255,
    ]);
    const revPacked = packGray4(revRgba, 4, 1, 'none');
    assert.equal(revPacked.length, 1);
    assert.equal(revPacked[0], 0xE4, 'Expected 0xE4 (0b11_10_01_00) for [White, LightGray, DarkGray, Black]');
  });

  test('postprocess() handles gray4 profile correctly', async () => {
    // Create an 800x480 test image in memory
    const img = new Jimp({ width: 800, height: 480, color: 0xFFFFFFFF });
    const pngBuf = await img.getBuffer('image/png');

    const profile = parseProfile(JSON.stringify({
      preset: 'seeed-reterminal-sticky',
      colorDepth: 'gray4'
    }));

    const result = await postprocess(pngBuf, profile);
    assert.equal(result.contentType, 'application/octet-stream');
    assert.equal(result.outputFormat, 'x-epd-gray4');
    assert.equal(result.width, 800);
    assert.equal(result.height, 480);
    assert.equal(result.buffer.length, 96000);
  });
});

describe('Ticket S4: Response Headers & Cache Key', () => {
  test('cacheKey changes when colorDepth changes from 1bit to gray4', () => {
    const p1bit = parseProfile(JSON.stringify({
      preset: 'seeed-reterminal-sticky',
      colorDepth: '1bit'
    }));
    const pGray4 = parseProfile(JSON.stringify({
      preset: 'seeed-reterminal-sticky',
      colorDepth: 'gray4'
    }));

    const k1 = cacheKey('dev-1', 'item-1', 1000, p1bit);
    const k2 = cacheKey('dev-1', 'item-1', 1000, pGray4);

    assert.notEqual(k1, k2, 'Cache key must differ when colorDepth changes so device re-downloads frame');
  });

  test('applyFormatOverride rejects image formats on gray4 panels and allows x-epd-gray4', () => {
    const { applyFormatOverride } = require('../routes/embedded');
    const pGray4 = parseProfile(JSON.stringify({
      preset: 'seeed-reterminal-sticky',
      colorDepth: 'gray4'
    }));

    for (const fmt of ['png', 'jpeg', 'jpg', 'bmp']) {
      const err = applyFormatOverride({ query: { format: fmt } }, pGray4);
      assert.ok(err, `format=${fmt} should be rejected for gray4`);
      assert.ok(err.includes('not available for gray4 panels'), `error message should mention gray4: ${err}`);
    }

    // x-epd-gray4 is recognized as a valid format override
    const errOverride = applyFormatOverride({ query: { format: 'x-epd-gray4' } }, pGray4);
    assert.equal(errOverride, null);
    assert.equal(pGray4.outputFormat, 'x-epd-gray4');
  });
});
