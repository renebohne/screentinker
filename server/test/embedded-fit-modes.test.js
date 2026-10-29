'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { Jimp } = require('jimp');

const { render } = require('../lib/embedded-render');

test.describe('Embedded Single-Item Fit Modes (cover, contain, fill)', () => {
  const tmpUpload = path.join(__dirname, '..', 'uploads', 'content');
  const testFilename = 'test-fit-aspect.png';
  const imgPath = path.join(tmpUpload, testFilename);

  test.before(async () => {
    fs.mkdirSync(tmpUpload, { recursive: true });
    // Create an 800x400 (2:1 landscape) solid green image
    const img = new Jimp({ width: 800, height: 400, color: 0x00FF00FF });
    fs.writeFileSync(imgPath, await img.getBuffer('image/png'));
  });

  test.after(() => {
    try { fs.unlinkSync(imgPath); } catch (_) {}
  });

  test('fit_mode = contain letterboxes and preserves entire image without cropping', async () => {
    // Target: 400x800 portrait screen
    const profile = { width: 400, height: 800 };
    const item = { id: 'item-contain', fit_mode: 'contain' };
    const content = { id: 'cnt-1', filepath: testFilename };
    // Device background: red (#FF0000)
    const options = { backgroundColor: '#FF0000' };

    const result = await render(item, content, profile, options);
    assert.ok(result.png, 'Expected PNG buffer');

    const rendered = await Jimp.fromBuffer(result.png);
    assert.equal(rendered.bitmap.width, 400);
    assert.equal(rendered.bitmap.height, 800);

    // 800x400 in 400x800:
    // Scale factor = 400 / 800 = 0.5 -> scaled image is 400x200
    // Centered vertically: y in [300, 500)
    // Top letterbox (x=200, y=100) should be Red (background)
    const topPx = rendered.getPixelColor(200, 100);
    assert.equal(topPx, 0xFF0000FF, 'Top letterbox should match background color');

    // Bottom letterbox (x=200, y=700) should be Red (background)
    const botPx = rendered.getPixelColor(200, 700);
    assert.equal(botPx, 0xFF0000FF, 'Bottom letterbox should match background color');

    // Center (x=200, y=400) should be Green (image)
    const centerPx = rendered.getPixelColor(200, 400);
    assert.equal(centerPx, 0x00FF00FF, 'Center of image should be green');
  });

  test('fit_mode = cover crops and fills the entire screen edge-to-edge', async () => {
    // Target: 400x800 portrait screen
    const profile = { width: 400, height: 800 };
    const item = { id: 'item-cover', fit_mode: 'cover' };
    const content = { id: 'cnt-1', filepath: testFilename };
    const options = { backgroundColor: '#FF0000' };

    const result = await render(item, content, profile, options);
    assert.ok(result.png, 'Expected PNG buffer');

    const rendered = await Jimp.fromBuffer(result.png);
    assert.equal(rendered.bitmap.width, 400);
    assert.equal(rendered.bitmap.height, 800);

    // Cover scales to fill 800 height (scaled to 1600x800), cropped to 400x800.
    // Entire canvas must be Green, no red letterbox.
    assert.equal(rendered.getPixelColor(200, 100), 0x00FF00FF);
    assert.equal(rendered.getPixelColor(200, 400), 0x00FF00FF);
    assert.equal(rendered.getPixelColor(200, 700), 0x00FF00FF);
  });

  test('fit_mode = fill stretches image to exact dimensions', async () => {
    const profile = { width: 400, height: 800 };
    const item = { id: 'item-fill', fit_mode: 'fill' };
    const content = { id: 'cnt-1', filepath: testFilename };

    const result = await render(item, content, profile);
    assert.ok(result.png, 'Expected PNG buffer');

    const rendered = await Jimp.fromBuffer(result.png);
    assert.equal(rendered.bitmap.width, 400);
    assert.equal(rendered.bitmap.height, 800);
    assert.equal(rendered.getPixelColor(200, 400), 0x00FF00FF);
  });

  test('unspecified fit_mode defaults to cover (preserving fleet compatibility and parity)', async () => {
    const profile = { width: 400, height: 800 };
    const item = { id: 'item-default' }; // No fit_mode
    const content = { id: 'cnt-1', filepath: testFilename };
    const options = { backgroundColor: '#FF0000' };

    const result = await render(item, content, profile, options);
    assert.ok(result.png, 'Expected PNG buffer');

    const rendered = await Jimp.fromBuffer(result.png);
    assert.equal(rendered.bitmap.width, 400);
    assert.equal(rendered.bitmap.height, 800);

    // Default is cover -> full canvas is green
    assert.equal(rendered.getPixelColor(200, 100), 0x00FF00FF);
    assert.equal(rendered.getPixelColor(200, 400), 0x00FF00FF);
    assert.equal(rendered.getPixelColor(200, 700), 0x00FF00FF);
  });

  test('options.fitMode provides fallback when item.fit_mode is unspecified', async () => {
    const profile = { width: 400, height: 800 };
    const item = { id: 'item-inherit-zone' }; // No item fit_mode
    const content = { id: 'cnt-1', filepath: testFilename };
    const options = { backgroundColor: '#FF0000', fitMode: 'contain' };

    const result = await render(item, content, profile, options);
    assert.ok(result.png, 'Expected PNG buffer');

    const rendered = await Jimp.fromBuffer(result.png);
    assert.equal(rendered.bitmap.width, 400);
    assert.equal(rendered.bitmap.height, 800);

    // Inherited contain -> letterbox with background color
    assert.equal(rendered.getPixelColor(200, 100), 0xFF0000FF, 'Top letterbox should be red');
    assert.equal(rendered.getPixelColor(200, 400), 0x00FF00FF, 'Center of image should be green');
    assert.equal(rendered.getPixelColor(200, 700), 0xFF0000FF, 'Bottom letterbox should be red');
  });

  test('transparent PNG composites over device.background_color inside bounding box', async () => {
    const transparentFile = 'test-transparent.png';
    const transparentPath = path.join(tmpUpload, transparentFile);
    try {
      // 200x200 image with transparent background and red square in center
      const transImg = new Jimp({ width: 200, height: 200, color: 0x00000000 });
      // Fill center 50x50 with blue
      for (let x = 75; x < 125; x++) {
        for (let y = 75; y < 125; y++) {
          transImg.setPixelColor(0x0000FFFF, x, y);
        }
      }
      fs.writeFileSync(transparentPath, await transImg.getBuffer('image/png'));

      const profile = { width: 200, height: 200 };
      const item = { id: 'item-trans', fit_mode: 'cover' };
      const content = { id: 'cnt-trans', filepath: transparentFile };
      // Background color: white (#FFFFFF)
      const options = { backgroundColor: '#FFFFFF' };

      const result = await render(item, content, profile, options);
      const rendered = await Jimp.fromBuffer(result.png);

      // Transparent corners should be filled with background color (white: 0xFFFFFFFF)
      assert.equal(rendered.getPixelColor(10, 10), 0xFFFFFFFF, 'Transparent area should be background color');
      // Center blue square should be preserved (blue: 0x0000FFFF)
      assert.equal(rendered.getPixelColor(100, 100), 0x0000FFFF, 'Opaque blue pixel should be preserved');
    } finally {
      try { fs.unlinkSync(transparentPath); } catch (_) {}
    }
  });
});
