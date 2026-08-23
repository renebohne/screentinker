'use strict';

/*
 * A #pipContainer fake with enough DOM to tell the truth about OWNERSHIP.
 *
 * ⚠️ Why this exists rather than `{ innerHTML: '', appendChild() {}, style: {} }`, which is what
 * the trigger tests used before: that fake has no querySelectorAll, so any code that scopes its
 * teardown to its own boxes throws against it. The throw is worse than a failure — triggerStop
 * runs inside the HTTP handler, so the exception escaped, the response was never sent, and the
 * test HUNG instead of failing. A fake that is missing the method under test cannot witness the
 * bug the method was written for, and its absence fails in the least legible way available.
 *
 * #pipContainer has two owners — the trigger engine and the manual PiP path — and each must
 * remove only its own class. Modelling children, classNames and remove() is the minimum needed
 * to assert that, and to assert that a <video> inside a removed box is actually released (the
 * #146 ghost-audio path: a detached-but-decoding element keeps emitting sound).
 */

function makeVideo() {
  return {
    tagName: 'VIDEO',
    src: 'blob:fake',
    paused: false,
    loaded: false,
    onended: () => {},
    onerror: () => {},
    pause() { this.paused = true; },
    removeAttribute(a) { if (a === 'src') this.src = null; },
    load() { this.loaded = true; },
  };
}

/** A box (.trigger-box / .pip-box) that can hold media and be removed from its parent. */
function makeBox(className, opts = {}) {
  const box = {
    className,
    style: { cssText: '' },
    children: [],
    removed: false,
    videos: [],
    appendChild(c) { this.children.push(c); if (c && c.tagName === 'VIDEO') this.videos.push(c); return c; },
    querySelectorAll(sel) { return sel === 'video' ? this.videos.slice() : []; },
    remove() { this.removed = true; if (this.parent) this.parent._detach(this); },
    parent: null,
  };
  if (opts.withVideo) box.appendChild(makeVideo());
  return box;
}

function makeContainer(id) {
  const c = {
    id,
    children: [],
    // Kept so a test can still assert the OLD behaviour is gone: anything that sets innerHTML = ''
    // is nuking a shared layer rather than removing its own box.
    _innerHTMLWrites: 0,
    set innerHTML(v) { this._innerHTMLWrites++; if (v === '') this.children = []; },
    get innerHTML() { return ''; },
    style: {},
    appendChild(b) { if (b) { b.parent = this; this.children.push(b); } return b; },
    _detach(b) { const i = this.children.indexOf(b); if (i >= 0) this.children.splice(i, 1); },
    querySelectorAll(sel) {
      const want = String(sel || '').replace(/^\./, '');
      // Match a class LIST, as a real DOM does. Exact string equality silently stopped matching
      // the day an element gained a second class, taking the coverage with it.
      return this.children.filter((b) => b && String(b.className || '').split(/\s+/).includes(want));
    },
    // Convenience for assertions.
    classes() { return this.children.map((b) => b.className); },
    has(cls) { return this.children.some((b) => b.className === cls); },
  };
  return c;
}

/**
 * Build a `document` fake whose getElementById returns STABLE, per-id containers — the previous
 * fake returned a fresh throwaway object on every call, so nothing could ever be observed to
 * persist or to be removed.
 */
function makeDocument(extra = {}) {
  const byId = new Map();
  return {
    _containers: byId,
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeContainer(id));
      return byId.get(id);
    },
    /*
     * ⚠️ HONOUR THE TAG. This used to ignore its argument and always return a box, so a real
     * `document.createElement('video')` never got tagName 'VIDEO', never landed in box.videos, and
     * box.querySelectorAll('video') was always empty — making the #146 media-release path this
     * helper exists to witness unreachable even in principle.
     */
    createElement(tag) {
      return String(tag || '').toLowerCase() === 'video' ? makeVideo() : makeBox('', {});
    },
    addEventListener() {},
    querySelectorAll() { return []; },
    ...extra,
  };
}

module.exports = { makeDocument, makeContainer, makeBox, makeVideo };
