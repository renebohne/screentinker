'use strict';

/*
 * Slides editor: dragging an element moves THAT element — in a real headless Chrome, with real
 * mouse events, against a real server.
 *
 * Reported from daily use: "when moving an item around, another item is shown moving instead of the
 * one I selected." The canvas drew the background photo (and its dim scrim) as the first children
 * of the stage, and the drag picked its live node with `stage.children[i]` — so on any slide with a
 * background photo the node under the pointer was a DIFFERENT element (or the photo itself), which
 * slid around while the selected element's numbers changed invisibly and jumped on release.
 *
 * Every scenario snapshots every element's box before, mid-drag (the moment the bug is visible),
 * after release, and in the saved deck, and asserts only the pressed element changed.
 *
 * Skips cleanly when there is no Chrome or no puppeteer-core, like the other browser suites.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SKIP, sleep, waitFor, startServer, launch } = require('./helpers/web-player-e2e');

const ROOT = path.join(__dirname, '..', '..');
let srv, browser, page;
const errors = [];

before(async () => {
  if (SKIP) return;
  srv = await startServer('slides-drag');
  browser = await launch();
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1400 });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${srv.base}/app#/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((tok) => {
    localStorage.setItem('token', tok);
    localStorage.setItem('rd_onboarded', '1');
  }, srv.token);
});
after(async () => {
  try { if (browser) await browser.close(); } catch { /* */ }
  if (srv) srv.stop();
});

/* ------------------------------------------------------------------ deck builders */

const text = (slot, kind, x, y, w) => ({ slot, kind, box: { x, y, w },
  style: { color: '#ffffff', size_cqw: 4, weight: 700 }, motion: { animation: 'none', delay: 0, duration: 0.6 } });
const block = (slot, x, y, w, h, color) => ({ slot, kind: 'box', box: { x, y, w, h },
  style: { color }, motion: { animation: 'none', delay: 0, duration: 0.6 } });

/** Three elements, two of them overlapping, on a plain background. */
function handMadeSlide(extra = {}) {
  return {
    name: 'Hand made', dwell_sec: 10,
    template: { background: '#101820', elements: [
      text('title', 'head', 8, 10, 40),
      block('card', 30, 18, 30, 30, '#3366ff'),
      text('detail', 'body', 55, 70, 35),
    ], ...extra },
    fields: { title: 'Headline here', detail: 'A line of detail' },
  };
}

async function makeDeck(name, slides) {
  const d = await srv.api('POST', '/slide-decks', { name, doc: { aspect: '16:9', slides } });
  return d.id;
}

/** The community lobby-welcome template, with its params filled from the manifest defaults. */
function lobbyWelcomeSlide() {
  const dir = path.join(ROOT, 'catalog', 'templates', 'lobby-welcome');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const defaults = Object.fromEntries(manifest.params.map((p) => [p.name, p.type === 'image' ? null : p.default]));
  const raw = fs.readFileSync(path.join(dir, 'template.json'), 'utf8');
  const filled = JSON.parse(raw, (k, v) => {
    if (typeof v !== 'string') return v;
    const m = /^\{\{param:([a-z_]+)\}\}$/.exec(v);
    return m ? (defaults[m[1]] == null ? null : defaults[m[1]]) : v;
  });
  return { name: 'Lobby', dwell_sec: 15, template: filled.template, fields: filled.fields };
}

/* ------------------------------------------------------------------ page driving */

async function openDeck(id) {
  await page.goto(`${srv.base}/app#/slides`, { waitUntil: 'networkidle2' });
  await page.reload({ waitUntil: 'networkidle2' });
  const opened = await waitFor(() => page.evaluate((deckId) => {
    const b = [...document.querySelectorAll('[data-open]')].find((x) => x.dataset.open === deckId);
    if (b) { b.click(); return true; }
    return false;
  }, id), 15000, 150);
  assert.ok(opened, 'the deck appeared in the list');
  const deck = await srv.api('GET', `/slide-decks/${id}`);
  const n = deck.doc.slides[0].template.elements.length;
  assert.ok(await waitFor(() => page.evaluate((count) => {
    const st = document.getElementById('stage');
    return !!st && st.children.length >= count;
  }, n), 15000, 150), 'the stage painted');
  await sleep(300);
}

/*
 * Every element node on the stage, in element order: by `data-ei` where the editor tags them, else
 * the stage's last `n` children (the editor before the fix, which this test was written against).
 */
function boxes(n) {
  return page.evaluate((count) => {
    const st = document.getElementById('stage');
    const tagged = [...st.querySelectorAll(':scope > [data-ei]')].sort((a, b) => a.dataset.ei - b.dataset.ei);
    const kids = tagged.length ? tagged : [...st.children].slice(-count);
    return kids.map((k) => { const r = k.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
  }, n);
}

/** A viewport point where element `i` is the thing the pointer actually hits. */
function hitPoint(n, i) {
  return page.evaluate((count, idx) => {
    const st = document.getElementById('stage');
    const tagged = [...st.querySelectorAll(':scope > [data-ei]')].sort((a, b) => a.dataset.ei - b.dataset.ei);
    const node = (tagged.length ? tagged : [...st.children].slice(-count))[idx];
    const r = node.getBoundingClientRect();
    for (let fy = 0.5; fy < 1; fy += 0.1) {
      for (const fx of [0.5, 0.3, 0.7, 0.15, 0.85]) {
        for (const sy of [fy, 1 - fy]) {
          const x = r.left + r.width * fx; const y = r.top + r.height * sy;
          const hit = document.elementFromPoint(x, y);
          if (hit && node.contains(hit)) return { x, y };
        }
      }
    }
    return null;
  }, n, i);
}

const near = (a, b) => Math.abs(a - b) < 0.75;
const sameBox = (a, b) => near(a.l, b.l) && near(a.t, b.t) && near(a.w, b.w) && near(a.h, b.h);
const savedBoxes = async (id) => (await srv.api('GET', `/slide-decks/${id}`)).doc.slides[0].template.elements.map((e) => e.box);

function assertOnlyMoved(beforeB, afterB, i, dx, dy, when) {
  for (let k = 0; k < beforeB.length; k++) {
    if (k === i) {
      // Within the snap threshold (6px): the editor may pull an edge onto a guide as it goes.
      assert.ok(Math.abs((afterB[k].l - beforeB[k].l) - dx) < 7 && Math.abs((afterB[k].t - beforeB[k].t) - dy) < 7,
        `${when}: the dragged element #${i} should follow the pointer by (${dx},${dy}); moved by (${
          (afterB[k].l - beforeB[k].l).toFixed(1)},${(afterB[k].t - beforeB[k].t).toFixed(1)})`);
    } else {
      assert.ok(sameBox(beforeB[k], afterB[k]),
        `${when}: element #${k} must not move while #${i} is dragged (${JSON.stringify(beforeB[k])} -> ${JSON.stringify(afterB[k])})`);
    }
  }
}

/**
 * Press on element `i`, drag it by (dx,dy) with real mouse events, release, save; assert at every
 * stage that only element `i` changed, on the canvas and in the stored deck.
 */
async function dragAndCheck(deckId, i, dx = 40, dy = 25) {
  const deck = await srv.api('GET', `/slide-decks/${deckId}`);
  const n = deck.doc.slides[0].template.elements.length;
  const storedBefore = deck.doc.slides[0].template.elements.map((e) => e.box);
  const pt = await hitPoint(n, i);
  assert.ok(pt, `element #${i} can be pressed somewhere`);
  const before0 = await boxes(n);

  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  for (let s = 1; s <= 6; s++) { await page.mouse.move(pt.x + (dx * s) / 6, pt.y + (dy * s) / 6); await sleep(20); }
  // Pointer moves are delivered on the next frame; measure after they land.
  await sleep(120);
  const mid = await boxes(n);
  // The pressed element is the selected one.
  const selected = await page.evaluate((count) => [...document.querySelectorAll('#stage > [data-ei]')]
    .map((k) => /solid/.test(k.style.outline || '')), n);
  await page.mouse.up();
  await sleep(150);
  const done = await boxes(n);

  assert.deepEqual(selected.map((v, k) => (v ? k : -1)).filter((k) => k >= 0), [i], 'the pressed element is selected');
  assertOnlyMoved(before0, mid, i, dx, dy, 'mid-drag');
  assertOnlyMoved(before0, done, i, dx, dy, 'after release');

  await page.click('#saveBtn');
  const stored = await waitFor(async () => {
    const b = await savedBoxes(deckId);
    return (b[i].x !== storedBefore[i].x || b[i].y !== storedBefore[i].y) ? b : null;
  }, 10000, 150);
  assert.ok(stored, 'the save reached the server');
  await sleep(500);   // and its response reached the editor, which repaints from the saved deck
  for (let k = 0; k < n; k++) {
    if (k === i) continue;
    assert.deepEqual(stored[k], storedBefore[k], `saved: element #${k} must be untouched when #${i} was dragged`);
  }
  assert.ok(stored[i].x > storedBefore[i].x && stored[i].y > storedBefore[i].y, `saved: element #${i} moved right and down`);
}

/* ------------------------------------------------------------------ scenarios */

describe('Slides editor: drag moves the selected element and nothing else', { skip: SKIP }, () => {
  test('a hand-made deck with overlapping elements', async () => {
    const id = await makeDeck('Drag plain', [handMadeSlide()]);
    await openDeck(id);
    for (const i of [1, 0, 2]) await dragAndCheck(id, i);
  });

  test('a slide with a background photo and dim — the reported bug', async () => {
    const photo = await srv.upload(path.join(ROOT, 'catalog', 'templates', 'lobby-welcome', 'thumbnail.png'), 'image/png');
    assert.ok(photo && photo.id, 'uploaded a background photo');
    const id = await makeDeck('Drag photo', [handMadeSlide({ background_content_id: photo.id, background_dim: 0.3 })]);
    await openDeck(id);
    const hasPhoto = await page.evaluate(() => document.getElementById('stage').children.length);
    assert.ok(hasPhoto > 3, 'precondition: the photo and scrim are on the stage');
    for (const i of [0, 1, 2]) await dragAndCheck(id, i);
  });

  test('after reordering layers and after adding an element', async () => {
    const id = await makeDeck('Drag reorder', [handMadeSlide()]);
    await openDeck(id);
    // Select the headline from the layers list and bring it forward (it becomes element #1).
    await page.evaluate(() => document.querySelector('[data-el="0"]').click());
    await page.evaluate(() => document.querySelector('.tabBtn[data-tab="content"]').click());
    await page.evaluate(() => document.getElementById('pFwd').click());
    await page.click('#saveBtn');
    await waitFor(async () => (await savedBoxes(id))[1].x === 8, 10000, 150);
    await sleep(500);
    for (const i of [1, 0]) await dragAndCheck(id, i);
    // Add a box from the tool rail; it lands on top of the others.
    await page.evaluate(() => document.querySelector('[data-add="box"]').click());
    await page.click('#saveBtn');
    await waitFor(async () => (await savedBoxes(id)).length === 4, 10000, 150);
    await sleep(500);
    for (const i of [3, 2]) await dragAndCheck(id, i, 30, 20);
  });

  test('a deck made with Make a sign', async () => {
    const made = await srv.api('POST', '/signs', { template: 'celebration', values: { title: 'Happy birthday', name: 'Sam' } });
    await openDeck(made.deck_id);
    const n = (await savedBoxes(made.deck_id)).length;
    assert.ok(n >= 3, 'the sign has several elements');
    let dragged = 0;
    for (let i = n - 1; i >= 0 && dragged < 3; i--) {
      if (!(await hitPoint(n, i))) continue;      // fully covered by something above it
      await dragAndCheck(made.deck_id, i, 20, 15);
      dragged++;
    }
    assert.ok(dragged >= 2, 'at least two sign elements were dragged');
  });

  test('a deck shaped like the community lobby-welcome template', async () => {
    const id = await makeDeck('Drag lobby', [lobbyWelcomeSlide()]);
    await openDeck(id);
    const n = (await savedBoxes(id)).length;
    let dragged = 0;
    for (let i = n - 1; i >= 0 && dragged < 3; i--) {
      if (!(await hitPoint(n, i))) continue;
      await dragAndCheck(id, i, 20, 15);
      dragged++;
    }
    assert.ok(dragged >= 2, 'at least two template elements were dragged');
  });

  test('no uncaught errors', () => {
    assert.deepEqual(errors, []);
  });
});

/* ------------------------------------------------------------------ PowerPoint-style editing */

/*
 * Phase two: the canvas behaves like PowerPoint's — handles, multi-selection, marquee, snapping,
 * arrange, clipboard, undo, in-place text. Each test drives it with real input and checks the
 * SAVED deck, because a canvas that looks right and stores something else is the failure that
 * matters on a wall.
 */

/** Click Save and read back what the server stored. */
async function saveAndGet(id) {
  await page.click('#saveBtn');
  await waitFor(() => page.evaluate(() => !/unsaved/.test(document.getElementById('deckStatus').textContent)), 10000, 100);
  await sleep(250);
  return (await srv.api('GET', `/slide-decks/${id}`)).doc.slides[0];
}

/** The centre of element i as drawn (a point where it is the thing hit). */
async function pressPoint(i) {
  const pt = await page.evaluate((idx) => {
    const node = document.querySelector(`#stage > [data-ei="${idx}"]`);
    const r = node.getBoundingClientRect();
    for (const fy of [0.5, 0.3, 0.7, 0.15, 0.85]) {
      for (const fx of [0.5, 0.3, 0.7, 0.15, 0.85]) {
        const x = r.left + r.width * fx; const y = r.top + r.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (hit && node.contains(hit)) return { x, y };
      }
    }
    return null;
  }, i);
  assert.ok(pt, `element #${i} can be pressed`);
  return pt;
}

async function dragFrom(pt, dx, dy, { steps = 8, mods = [] } = {}) {
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  for (let s = 1; s <= steps; s++) { await page.mouse.move(pt.x + (dx * s) / steps, pt.y + (dy * s) / steps); await sleep(15); }
  await sleep(80);
  await page.mouse.up();
  for (const m of mods) await page.keyboard.up(m);
  await sleep(150);
}

async function click(pt, mods = []) {
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.click(pt.x, pt.y);
  for (const m of mods) await page.keyboard.up(m);
  await sleep(120);
}

async function key(combo) {
  const parts = combo.split('+');
  const last = parts.pop();
  for (const m of parts) await page.keyboard.down(m);
  await page.keyboard.press(last);
  for (const m of parts.reverse()) await page.keyboard.up(m);
  await sleep(150);
}

const selectedOnCanvas = () => page.evaluate(() => [...document.querySelectorAll('#stage > [data-ei]')]
  .filter((n) => /solid|dashed/.test(n.style.outline || '')).map((n) => Number(n.dataset.ei)));
const handleCount = () => page.evaluate(() => document.querySelectorAll('#stage .sl-handle').length);
const handleAt = (dir) => page.evaluate((d) => {
  const h = document.querySelector(`#stage .sl-handle[data-handle="${d}"]`);
  const r = h.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, dir);
/** A point on the stage that no element covers (the lower-left corner region of this layout). */
const emptyPoint = () => page.evaluate(() => {
  const st = document.getElementById('stage').getBoundingClientRect();
  return { x: st.left + st.width * 0.03, y: st.top + st.height * 0.95 };
});
const boxesOf = (sl) => sl.template.elements.map((e) => e.box);

/** Four elements, none overlapping: headline, panel, photo placeholder, detail. */
function editSlide() {
  return {
    name: 'Edit', dwell_sec: 10,
    template: { background: '#101820', elements: [
      text('title', 'head', 8, 8, 40),
      block('card', 55, 10, 20, 20, '#3366ff'),
      { slot: 'pic', kind: 'image', content_id: null, fit: 'cover', box: { x: 10, y: 45, w: 20, h: 20 },
        style: { color: '#ffffff' }, motion: { animation: 'none', delay: 0, duration: 0.6 } },
      text('detail', 'body', 55, 60, 30),
    ] },
    fields: { title: 'Headline here', detail: 'A line of detail' },
  };
}

describe('Slides editor: PowerPoint-style editing', { skip: SKIP }, () => {
  test('click selects with eight handles; empty canvas deselects; auto-height text gets two', async () => {
    const id = await makeDeck('Edit select', [editSlide()]);
    await openDeck(id);
    await click(await pressPoint(1));
    assert.deepEqual(await selectedOnCanvas(), [1]);
    assert.equal(await handleCount(), 8);
    await click(await emptyPoint());
    assert.deepEqual(await selectedOnCanvas(), []);
    assert.equal(await handleCount(), 0);
    await click(await pressPoint(0));
    assert.equal(await handleCount(), 2, 'a text box that sizes to its words resizes in width only');
  });

  test('resize by handle; Shift locks the ratio; a photo keeps its ratio by default; nothing else moves', async () => {
    const id = await makeDeck('Edit resize', [editSlide()]);
    await openDeck(id);
    const before = boxesOf(await saveAndGet(id));
    await click(await pressPoint(1));
    await dragFrom(await handleAt('se'), 60, 20);
    let now = boxesOf(await saveAndGet(id));
    assert.equal(now[1].x, before[1].x); assert.equal(now[1].y, before[1].y);
    assert.ok(now[1].w > before[1].w + 3 && now[1].h > before[1].h + 1, `grew: ${JSON.stringify(now[1])}`);
    assert.ok(Math.abs(now[1].w / now[1].h - before[1].w / before[1].h) > 0.05, 'free resize changes the ratio');
    for (const k of [0, 2, 3]) assert.deepEqual(now[k], before[k], `element #${k} untouched by the resize`);

    const r0 = now[1].w / now[1].h;
    await dragFrom(await handleAt('se'), 50, 5, { mods: ['Shift'] });
    now = boxesOf(await saveAndGet(id));
    assert.ok(Math.abs(now[1].w / now[1].h - r0) < 0.03, `Shift kept w:h (${r0} -> ${now[1].w / now[1].h})`);

    await click(await pressPoint(2));
    const p0 = now[2];
    await dragFrom(await handleAt('e'), 70, 0);
    now = boxesOf(await saveAndGet(id));
    assert.ok(now[2].w > p0.w + 3, 'the photo got wider');
    assert.ok(Math.abs(now[2].w / now[2].h - p0.w / p0.h) < 0.03, 'and kept its shape without Shift');

    await click(await pressPoint(0));
    const t0 = now[0];
    await dragFrom(await handleAt('e'), -80, 0);
    now = boxesOf(await saveAndGet(id));
    assert.ok(now[0].w < t0.w - 3 && now[0].h === undefined, 'a text box narrows and stays auto-height');
  });

  test('Shift-click builds a multi-selection that moves together; a marquee selects what it encloses', async () => {
    const id = await makeDeck('Edit multi', [editSlide()]);
    await openDeck(id);
    const before = boxesOf(await saveAndGet(id));
    await click(await pressPoint(1));
    await click(await pressPoint(3), ['Shift']);
    assert.deepEqual(await selectedOnCanvas(), [1, 3]);
    await dragFrom(await pressPoint(3), -40, 30, { mods: [] });
    const now = boxesOf(await saveAndGet(id));
    const d1 = [now[1].x - before[1].x, now[1].y - before[1].y];
    const d3 = [now[3].x - before[3].x, now[3].y - before[3].y];
    assert.ok(Math.abs(d1[0]) > 1 && Math.abs(d1[1]) > 1, 'the group moved');
    assert.ok(Math.abs(d1[0] - d3[0]) < 0.01 && Math.abs(d1[1] - d3[1]) < 0.01, 'by the same amount');
    assert.deepEqual(now[0], before[0]); assert.deepEqual(now[2], before[2]);

    await click(await emptyPoint());
    // A marquee from the top-left corner around the headline and the photo, not the others.
    const st = await page.evaluate(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
    await dragFrom({ x: st.l + st.w * 0.01, y: st.t + st.h * 0.02 }, st.w * 0.48, st.h * 0.7);
    assert.deepEqual(await selectedOnCanvas(), [0, 2]);
  });

  test('align and distribute act on the selection', async () => {
    const id = await makeDeck('Edit align', [editSlide()]);
    await openDeck(id);
    await key('Control+a');
    assert.deepEqual(await selectedOnCanvas(), [0, 1, 2, 3]);
    await page.click('#arrangeBar [data-act="left"]');
    let now = boxesOf(await saveAndGet(id));
    assert.deepEqual(now.map((b) => b.x), [8, 8, 8, 8], 'align left lines them up on the leftmost');
    await page.click('#arrangeBar [data-act="dist-v"]');
    now = boxesOf(await saveAndGet(id));
    const tops = now.map((b) => b.y);
    assert.equal(Math.min(...tops), 8, 'the topmost stays');
    assert.equal(new Set(tops.map((v) => v.toFixed(1))).size, 4, 'and the rest are spread out');
  });

  test('layer order: Ctrl+Shift+] to the front, Ctrl+[ back one, and the context menu', async () => {
    const id = await makeDeck('Edit order', [editSlide()]);
    await openDeck(id);
    await click(await pressPoint(0));
    await key('Control+Shift+BracketRight');
    let sl = await saveAndGet(id);
    assert.deepEqual(sl.template.elements.map((e) => e.slot), ['card', 'pic', 'detail', 'title']);
    assert.deepEqual(await selectedOnCanvas(), [3], 'the selection followed the element');
    await key('Control+BracketLeft');
    sl = await saveAndGet(id);
    assert.deepEqual(sl.template.elements.map((e) => e.slot), ['card', 'pic', 'title', 'detail']);
    // Right-click the panel and send it to the back... it already is; bring it to the front.
    const pt = await pressPoint(0);
    await page.mouse.click(pt.x, pt.y, { button: 'right' });
    await sleep(150);
    assert.ok(await page.evaluate(() => !!document.querySelector('.sl-ctx')), 'a context menu opened');
    await page.click('.sl-ctx [data-act="front"]');
    await sleep(150);
    sl = await saveAndGet(id);
    assert.deepEqual(sl.template.elements.map((e) => e.slot), ['pic', 'title', 'detail', 'card']);
  });

  test('copy, paste, cut and duplicate make NEW elements with unique slots and the same words', async () => {
    const id = await makeDeck('Edit clip', [editSlide()]);
    await openDeck(id);
    await click(await pressPoint(0));
    await key('Control+c');
    await key('Control+v');
    await key('Control+d');
    let sl = await saveAndGet(id);
    let els = sl.template.elements;
    assert.equal(els.length, 6);
    assert.equal(new Set(els.map((e) => e.slot)).size, 6, 'every slot is unique');
    assert.equal(sl.fields[els[4].slot], 'Headline here'); assert.equal(sl.fields[els[5].slot], 'Headline here');
    assert.ok(els[4].box.x > els[0].box.x && els[5].box.x > els[4].box.x, 'each copy lands offset from the last');
    assert.equal(sl.fields.title, 'Headline here', 'the original keeps its words');
    await key('Control+x');
    sl = await saveAndGet(id);
    assert.equal(sl.template.elements.length, 5, 'cut removed the duplicate');
    await key('Control+v');
    sl = await saveAndGet(id);
    els = sl.template.elements;
    assert.equal(els.length, 6);
    assert.equal(new Set(els.map((e) => e.slot)).size, 6);
    await key('Delete');
    sl = await saveAndGet(id);
    assert.equal(sl.template.elements.length, 5, 'Delete removes the selection');
  });

  test('undo and redo restore the deck exactly', async () => {
    const id = await makeDeck('Edit undo', [editSlide()]);
    await openDeck(id);
    const original = await saveAndGet(id);
    await dragFrom(await pressPoint(1), 50, 40);
    await click(await pressPoint(3));
    await key('Delete');
    await click(await pressPoint(0));
    await key('ArrowRight');
    await key('Shift+ArrowDown');
    const edited = await saveAndGet(id);
    assert.equal(edited.template.elements.length, 3);
    assert.equal(edited.template.elements[0].box.x, 9, 'arrow nudges 1');
    assert.equal(edited.template.elements[0].box.y, 18, 'Shift+arrow nudges 10');
    for (let k = 0; k < 3; k++) await key('Control+z');
    const undone = await saveAndGet(id);
    assert.deepEqual(undone.template, original.template, 'three undos are back to the start');
    assert.deepEqual(undone.fields, original.fields);
    for (let k = 0; k < 2; k++) await key('Control+Shift+z');
    await key('Control+y');
    const redone = await saveAndGet(id);
    assert.deepEqual(redone.template, edited.template, 'redo replays them');
    await page.click('#arrangeBar [data-act="undo"]');
    const once = await saveAndGet(id);
    assert.equal(once.template.elements[0].box.x, 8, 'the toolbar undo undid the nudges as one step');
  });

  test('double-click edits a text element in place, and the words are saved', async () => {
    const id = await makeDeck('Edit text', [editSlide()]);
    await openDeck(id);
    const before = await saveAndGet(id);
    const pt = await pressPoint(0);
    await page.mouse.click(pt.x, pt.y, { count: 2 });
    await sleep(150);
    assert.ok(await page.evaluate(() => !!document.querySelector('#stage > [data-ei="0"][data-editing]')), 'editing in place');
    await page.keyboard.type('Welcome in');
    await page.keyboard.press('Enter');
    await sleep(150);
    const sl = await saveAndGet(id);
    assert.equal(sl.fields.title, 'Welcome in');
    assert.deepEqual(sl.template, before.template, 'typing changed the words and nothing else');
    // Escape abandons an edit.
    const pt2 = await pressPoint(0);
    await page.mouse.click(pt2.x, pt2.y, { count: 2 });
    await sleep(150);
    await page.keyboard.type('nope');
    await page.keyboard.press('Escape');
    await sleep(150);
    assert.equal((await saveAndGet(id)).fields.title, 'Welcome in');
  });

  test('dragging snaps to the slide centre with a guide; Alt turns snapping off', async () => {
    const id = await makeDeck('Edit snap', [editSlide()]);
    await openDeck(id);
    // The panel is 20% wide at x=55: centred is x=40. Drag it 14.5% left (a hair from the centre).
    const st = await page.evaluate(() => document.getElementById('stage').getBoundingClientRect().width);
    const pt = await pressPoint(1);
    await page.mouse.move(pt.x, pt.y);
    await page.mouse.down();
    for (let s = 1; s <= 8; s++) { await page.mouse.move(pt.x - (st * 0.145 * s) / 8, pt.y + s * 0.2); await sleep(15); }
    await sleep(80);
    const guides = await page.evaluate(() => document.querySelectorAll('#stage .sl-guide').length);
    await page.mouse.up();
    await sleep(150);
    let sl = await saveAndGet(id);
    assert.ok(guides >= 1, 'a guide line showed while snapped');
    assert.ok(Math.abs(sl.template.elements[1].box.x - 40) < 0.05, `snapped to the centre: ${sl.template.elements[1].box.x}`);
    const pt2 = await pressPoint(1);
    await dragFrom(pt2, st * 0.004, 0, { mods: ['Alt'] });
    sl = await saveAndGet(id);
    assert.ok(Math.abs(sl.template.elements[1].box.x - 40.4) < 0.15, `Alt: no snap (${sl.template.elements[1].box.x})`);
  });

  test('a deck whose elements share a slot is repaired on open, keeping every word', async () => {
    const slide = editSlide();
    slide.template.elements[3].slot = 'title';           // two elements sharing "title"
    const id = await makeDeck('Edit twins', [slide]);
    const stored = (await srv.api('GET', `/slide-decks/${id}`)).doc.slides[0];
    assert.equal(stored.template.elements.filter((e) => e.slot === 'title').length, 2, 'precondition: twins stored');
    await openDeck(id);
    const sl = await saveAndGet(id);
    const slots = sl.template.elements.map((e) => e.slot);
    assert.equal(new Set(slots).size, 4, 'unique after the repair');
    assert.equal(slots[0], 'title', 'the first keeps its slot');
    assert.equal(sl.fields[slots[3]], 'Headline here', 'the twin keeps the words it showed');
  });

  test('at tablet width, a finger drags an element and its handles; the page does not scroll sideways', async () => {
    const id = await makeDeck('Edit touch', [editSlide()]);
    await page.setViewport({ width: 820, height: 1180, isMobile: true, hasTouch: true });
    try {
      await openDeck(id);
      const before = boxesOf(await saveAndGet(id));
      const pt = await pressPoint(1);
      await page.touchscreen.touchStart(pt.x, pt.y);
      for (let s = 1; s <= 8; s++) { await page.touchscreen.touchMove(pt.x + s * 4, pt.y + s * 3); await sleep(15); }
      await page.touchscreen.touchEnd();
      await sleep(200);
      let now = boxesOf(await saveAndGet(id));
      assert.ok(now[1].x > before[1].x && now[1].y > before[1].y, `the panel followed the finger: ${JSON.stringify(now[1])}`);
      for (const k of [0, 2, 3]) assert.deepEqual(now[k], before[k]);
      const h = await handleAt('se');
      await page.touchscreen.touchStart(h.x, h.y);
      for (let s = 1; s <= 6; s++) { await page.touchscreen.touchMove(h.x + s * 5, h.y + s * 3); await sleep(15); }
      await page.touchscreen.touchEnd();
      await sleep(200);
      const after = boxesOf(await saveAndGet(id));
      assert.ok(after[1].w > now[1].w, 'and resized it by its corner');
      const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
      assert.ok(m.doc <= m.win + 4, `no sideways scroll at tablet width (${m.doc} in ${m.win})`);
    } finally {
      await page.setViewport({ width: 1440, height: 1400 });
    }
  });

  test('no uncaught errors while editing', () => {
    assert.deepEqual(errors, []);
  });
});
