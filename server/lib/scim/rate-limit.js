'use strict';

/*
 * A sliding-window counter keyed by an arbitrary string. Used twice by routes/scim.js:
 *
 *   - per ORGANIZATION for authenticated traffic. Not per IP: Okta and Entra provision every one of
 *     their customers from a small shared pool of egress addresses, so an IP bucket would let one
 *     tenant's large initial sync throttle another tenant's provisioning on the same instance.
 *   - per IP for FAILED authentication only. The token is 256 random bits, so this is about noise
 *     in the log and wasted hashing, not about guessing.
 *
 * Kept small and pure so it can be tested without a server, and bounded so a flood of distinct keys
 * cannot grow it without limit.
 */
class SlidingWindow {
  constructor({ windowMs, max, maxKeys = 10000 }) {
    this.windowMs = windowMs; this.max = max; this.maxKeys = maxKeys; this.hits = new Map();
  }

  /** Count a hit. Returns { ok, retryAfter } — retryAfter in whole seconds when refused. */
  hit(key, now = Date.now()) {
    const start = now - this.windowMs;
    const list = (this.hits.get(key) || []).filter((t) => t > start);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return { ok: false, retryAfter: Math.max(1, Math.ceil((list[0] + this.windowMs - now) / 1000)) };
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) this.sweep(now);
    return { ok: true, retryAfter: 0 };
  }

  /** Would a hit be refused right now? Does not count. */
  blocked(key, now = Date.now()) {
    const start = now - this.windowMs;
    return (this.hits.get(key) || []).filter((t) => t > start).length >= this.max;
  }

  sweep(now = Date.now()) {
    const start = now - this.windowMs;
    for (const [k, v] of this.hits) if (!v.some((t) => t > start)) this.hits.delete(k);
    // Still over after dropping the idle ones: drop the oldest keys rather than grow forever.
    while (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value);
  }

  reset() { this.hits.clear(); }
}

module.exports = { SlidingWindow };
