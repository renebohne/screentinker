'use strict';

/*
 * The outbound connections ledger: every external host this server contacted, by day, with the
 * feature that caused it. docs/trust.md is the user-facing description.
 *
 * WHERE IT LISTENS. Not in each integration: at the two places every HTTP request this process makes
 * must pass, whatever library made it.
 *
 *   node:http / node:https  the `http.client.request.created` diagnostics channel (falls back to
 *                           `http.client.request.start` on a Node that lacks it). Covers the SSRF
 *                           guard, ai-fetch's guardedFetch, the AWS / Azure / Stripe SDKs, the `ws`
 *                           client the mesh uses, and any raw https.request.
 *   global fetch (undici)   the `undici:request:create` channel.
 *
 * Listening on diagnostics channels changes nothing about a request: no wrapper sits in the request
 * path, a subscriber cannot alter or delay it, and an exception in one is swallowed here. The only
 * thing installed into the request path is a thin wrapper round globalThis.fetch whose sole job is
 * to remember who called it (undici publishes from deep inside its own async machinery, where the
 * caller is no longer on the stack). It passes its arguments through untouched.
 *
 * Non-HTTP egress (SMTP, raw TCP) has no channel; those callers call note() themselves.
 *
 * WHAT IS RECORDED: host (and a non-default port), feature, category, network scope, the workspace
 * and organization when the request was made on behalf of one, a count, declared bytes and an error
 * count, aggregated per UTC day. ⚠️ NEVER a path, a query string, a header or a body: the host is
 * cut out of the request before anything else looks at it, and nothing else is kept. A query string
 * is where API keys live (?key=, ?token=), and a path often names a customer's resource.
 *
 * WHO CAUSED IT. In order: an explicit context (withContext) → the first server file on the
 * caller's stack that is not itself a chokepoint → the SDK package on the stack → the destination
 * host → "unattributed". The table that turns a file, package or host into a feature lives in
 * lib/trust/features.js. Attribution is best effort; the host is always exact.
 *
 * WHICH WORKSPACE. A request made while serving an HTTP request is attributed to that request's
 * workspace, read lazily (resolveTenancy sets it after this middleware runs). ⚠️ Only while that
 * request is still being served: a timer created inside a request inherits its async context for
 * ever, and attributing a background job's fetch to whichever request first started its timer would
 * show one organization another's hosts. Once the response has finished, the request's workspace no
 * longer counts and the row is instance-level.
 */

const dc = require('node:diagnostics_channel');
const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('path');
const net = require('net');

const als = new AsyncLocalStorage();
const SERVER_ROOT = path.join(__dirname, '..') + path.sep;
const FLUSH_MS = 60 * 1000;
const MAX_PENDING = 5000;           // distinct (day, host, feature, workspace) keys between flushes
const RETENTION_DAYS = 400;         // the page shows 30/90 days; a year+ answers "did we ever"

let installed = false;
let dbRef = null;
let timer = null;
const pending = new Map();
const seen = new WeakSet();          // http requests already counted by request.created
const inflight = new WeakMap();      // request object -> its pending entry (for bytes and errors)

const features = () => require('./trust/features');

/* ───────────── context ───────────── */

/** Express middleware: remember the request being served so a fetch it causes can name its workspace. */
function middleware(req, res, next) {
  als.run({ req, res }, next);
}

/**
 * Run fn with an explicit attribution: { feature, workspaceId, organizationId }. For background
 * work (a data-source refresh, a feed poll) that knows whose it is, and for chokepoints that hand
 * work to a promise chain where the caller is no longer on the stack.
 */
function withContext(ctx, fn) {
  if (!ctx) return fn();
  const parent = als.getStore() || {};
  return als.run({ ...parent, ...ctx }, fn);
}

/** The ambient context plus, when none names a feature, one read off the caller's stack now. */
function captureContext() {
  if (!installed) return null;
  const store = als.getStore() || {};
  if (store.feature) return null;            // already attributed: nothing to add
  const feature = featureFromStack(new Error().stack);
  return feature ? { feature } : null;
}

/* ───────────── attribution ───────────── */

// Files that only pass a request through. A frame in one of these says nothing about WHY.
const PASS_THROUGH = new Set([
  'lib/outbound-ledger.js', 'lib/ssrf-guard.js', 'lib/ai-fetch.js', 'lib/data-sources/http.js',
  'lib/bi/http.js', 'lib/storage/endpoint-guard.js', 'lib/remote-url.js', 'lib/http-target-guard.js',
]);

/** First meaningful frame of a stack: { file } relative to server/, or { pkg } for an SDK. */
function originFromStack(stack) {
  let pkg = null;
  for (const line of String(stack || '').split('\n').slice(1)) {
    const m = /\(?((?:[A-Za-z]:)?[\\/][^():]+?\.(?:c|m)?js):\d+:\d+\)?\s*$/.exec(line);
    if (!m) continue;
    const abs = m[1];
    const nm = abs.lastIndexOf(`${path.sep}node_modules${path.sep}`);
    if (nm >= 0) {
      if (!pkg) {
        const rest = abs.slice(nm + 14).split(path.sep);
        pkg = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
      }
      continue;
    }
    if (!abs.startsWith(SERVER_ROOT)) {
      // A plugin's own code (bundled or installed) is outside server/.
      if (/[\\/]plugins[\\/]/.test(abs)) return { file: 'plugins' };
      continue;
    }
    const rel = abs.slice(SERVER_ROOT.length).split(path.sep).join('/');
    if (PASS_THROUGH.has(rel)) continue;
    return { file: rel };
  }
  return pkg ? { pkg } : null;
}

function featureFromStack(stack) {
  const o = originFromStack(stack);
  if (!o) return null;
  return o.file ? features().featureForFile(o.file) : features().featureForPackage(o.pkg);
}

/* ───────────── host + scope ───────────── */

/**
 * The host part only, lowercased, default port dropped. Anything that does not look like a host is
 * refused rather than stored — the ledger must never become the place a path or token ends up.
 */
function cleanHost(host, protocol) {
  let h = String(host || '').trim().toLowerCase();
  if (!h || h.length > 300) return null;
  h = h.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0];
  if (h.includes('@')) h = h.slice(h.lastIndexOf('@') + 1);
  let port = '';
  const v6 = /^\[([0-9a-f:.]+)\](?::(\d+))?$/.exec(h);
  if (v6) { port = v6[2] || ''; h = `[${v6[1]}]`; }
  else {
    const m = /^([^:]+)(?::(\d+))?$/.exec(h);
    if (!m) {
      if (net.isIP(h) === 6) return `[${h}]`;
      return null;
    }
    h = m[1].replace(/\.$/, ''); port = m[2] || '';
  }
  if (!/^(\[[0-9a-f:.]+\]|[a-z0-9_.-]+)$/.test(h)) return null;
  if ((port === '443' && protocol !== 'http:') || (port === '80' && protocol === 'http:')) port = '';
  return port ? `${h}:${port}` : h;
}

/** 'internet' | 'private' | 'loopback' | 'socket', from the host (and the connected address when known). */
function scopeOf(host, remoteAddress) {
  const bare = String(host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const ip = remoteAddress && net.isIP(remoteAddress) ? remoteAddress : (net.isIP(bare) ? bare : null);
  if (bare === 'localhost' || bare.endsWith('.localhost')) return 'loopback';
  if (!ip) return /\.(lan|local|home\.arpa|internal|intranet|corp)$/.test(bare) || !bare.includes('.') ? 'private' : 'internet';
  const g = require('./ssrf-guard');
  if (ip === '::1' || /^127\./.test(ip) || /^::ffff:127\./.test(ip)) return 'loopback';
  return g.isPrivateNetworkIp(ip) ? 'private' : 'internet';
}

/* ───────────── recording ───────────── */

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

function currentWorkspace() {
  const store = als.getStore();
  if (!store) return { workspaceId: null, organizationId: null, feature: null };
  let workspaceId = store.workspaceId || null;
  let organizationId = store.organizationId || null;
  if (!workspaceId && store.req && store.res && !store.res.writableFinished && !store.res.destroyed) {
    workspaceId = store.req.workspaceId || null;
    organizationId = store.req.organizationId || null;
  }
  return { workspaceId, organizationId, feature: store.feature || null };
}

/**
 * Count one connection. `host` may be a Host header, a hostname or a URL — only the host survives.
 * Returns the pending entry (so bytes and errors can be added) or null when nothing was recorded.
 */
function note({ host, protocol = 'https:', feature = null, stack = null, workspaceId, organizationId, remoteAddress = null, socket = false, bytesOut = 0 } = {}) {
  if (!installed) return null;
  try {
    const h = cleanHost(host, protocol);
    if (!h) return null;
    const ambient = currentWorkspace();
    const f = feature || ambient.feature || (stack ? featureFromStack(stack) : null) || features().featureForHost(h) || 'unattributed';
    const ws = workspaceId !== undefined ? workspaceId : ambient.workspaceId;
    let org = organizationId !== undefined ? organizationId : ambient.organizationId;
    if (ws && !org) org = orgOf(ws);
    const day = today();
    const key = `${day}|${h}|${f}|${ws || ''}`;
    let e = pending.get(key);
    const now = Math.floor(Date.now() / 1000);
    if (!e) {
      if (pending.size >= MAX_PENDING) flush();
      e = { day, host: h, feature: f, category: features().categoryOf(f), scope: socket ? 'socket' : scopeOf(h, remoteAddress),
            workspace_id: ws || '', organization_id: org || '', count: 0, bytes_in: 0, bytes_out: 0, errors: 0, first_seen: now, last_seen: now };
      pending.set(key, e);
    }
    e.count += 1;
    e.bytes_out += Math.max(0, Number(bytesOut) || 0);
    e.last_seen = now;
    return e;
  } catch (_) {
    return null;   // the ledger must never break the request it is counting
  }
}

const orgCache = new Map();
function orgOf(workspaceId) {
  if (orgCache.has(workspaceId)) return orgCache.get(workspaceId);
  let org = null;
  try { const r = dbRef && dbRef.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(workspaceId); org = r ? r.organization_id : null; } catch (_) { /* */ }
  if (orgCache.size > 2000) orgCache.clear();
  orgCache.set(workspaceId, org);
  return org;
}

const contentLength = (v) => { const n = Number(Array.isArray(v) ? v[0] : v); return Number.isFinite(n) && n > 0 ? n : 0; };

/* node:http — the ClientRequest is created synchronously by its caller, so its stack names them. */
function onHttpRequest({ request }) {
  if (!request || seen.has(request)) return;
  seen.add(request);
  if (request.socketPath || (request.agent && request.agent.options && request.agent.options.socketPath)) {
    inflight.set(request, note({ host: 'unix-socket', feature: null, stack: new Error().stack, socket: true }));
    return;
  }
  let host = null;
  try { host = request.getHeader('host'); } catch (_) { /* */ }
  const e = note({
    host: host || request.host, protocol: request.protocol, stack: new Error().stack,
    bytesOut: (() => { try { return contentLength(request.getHeader('content-length')); } catch (_) { return 0; } })(),
  });
  if (e) inflight.set(request, e);
}
function onHttpResponse({ request, response }) {
  const e = request && inflight.get(request);
  if (!e || !response) return;
  e.bytes_in += contentLength(response.headers && response.headers['content-length']);
}
function onHttpError({ request }) {
  const e = request && inflight.get(request);
  if (e) e.errors += 1;
}

/* undici (global fetch) */
function onUndiciCreate({ request }) {
  if (!request) return;
  let host = null, protocol = 'https:';
  try { const u = new URL(String(request.origin)); host = u.host; protocol = u.protocol; } catch (_) { return; }
  const e = note({ host, protocol, stack: null });
  if (e) inflight.set(request, e);
}
function onUndiciHeaders({ request, response }) {
  const e = request && inflight.get(request);
  if (!e || !response || !Array.isArray(response.headers)) return;
  const hs = response.headers;
  for (let i = 0; i + 1 < hs.length; i += 2) {
    if (String(hs[i]).toLowerCase() === 'content-length') { e.bytes_in += contentLength(String(hs[i + 1])); break; }
  }
}
function onUndiciError({ request }) {
  const e = request && inflight.get(request);
  if (e) e.errors += 1;
}

const safe = (fn) => (msg) => { try { fn(msg); } catch (_) { /* never into the request path */ } };
const SUBSCRIPTIONS = [
  ['http.client.request.created', safe(onHttpRequest)],
  ['http.client.request.start', safe(onHttpRequest)],      // older Node: no `created`; same handler, deduplicated
  ['http.client.response.finish', safe(onHttpResponse)],
  ['http.client.request.error', safe(onHttpError)],
  ['undici:request:create', safe(onUndiciCreate)],
  ['undici:request:headers', safe(onUndiciHeaders)],
  ['undici:request:error', safe(onUndiciError)],
];

let originalFetch = null;
function wrappedFetch(...args) {
  const ctx = captureContext();
  return ctx ? withContext(ctx, () => originalFetch.apply(this, args)) : originalFetch.apply(this, args);
}

/* ───────────── persistence ───────────── */

function flush() {
  if (!pending.size || !dbRef) return 0;
  const rows = [...pending.values()];
  pending.clear();
  try {
    const up = dbRef.prepare(`INSERT INTO outbound_ledger (day, host, feature, category, scope, workspace_id, organization_id, count, bytes_in, bytes_out, errors, first_seen, last_seen)
      VALUES (@day, @host, @feature, @category, @scope, @workspace_id, @organization_id, @count, @bytes_in, @bytes_out, @errors, @first_seen, @last_seen)
      ON CONFLICT(day, host, feature, workspace_id) DO UPDATE SET
        count = count + excluded.count, bytes_in = bytes_in + excluded.bytes_in, bytes_out = bytes_out + excluded.bytes_out,
        errors = errors + excluded.errors, last_seen = MAX(last_seen, excluded.last_seen),
        first_seen = MIN(first_seen, excluded.first_seen), scope = excluded.scope,
        organization_id = CASE WHEN excluded.organization_id <> '' THEN excluded.organization_id ELSE organization_id END`);
    dbRef.transaction(() => { for (const r of rows) up.run(r); })();
  } catch (_) { /* table absent (a degraded boot): the counts are lost, never the request */ }
  return rows.length;
}

function prune(now = Date.now()) {
  if (!dbRef) return 0;
  try { return dbRef.prepare('DELETE FROM outbound_ledger WHERE day < ?').run(today(now - RETENTION_DAYS * 86400000)).changes; }
  catch (_) { return 0; }
}

/**
 * Start listening. Idempotent. `db` is where the daily rows go. Tests call install({ db }) and
 * uninstall() around themselves; server.js installs once at boot.
 */
function install({ db } = {}) {
  dbRef = db || dbRef || require('../db/database').db;
  if (installed) return;
  installed = true;
  for (const [name, fn] of SUBSCRIPTIONS) dc.subscribe(name, fn);
  if (typeof globalThis.fetch === 'function' && !globalThis.fetch.__ledger) {
    originalFetch = globalThis.fetch;
    const w = wrappedFetch.bind(globalThis);
    Object.defineProperty(w, '__ledger', { value: true });
    globalThis.fetch = w;
  }
  timer = setInterval(() => { flush(); }, FLUSH_MS);
  timer.unref?.();
  const daily = setInterval(() => prune(), 24 * 3600 * 1000);
  daily.unref?.();
  timer._daily = daily;
}

function uninstall() {
  if (!installed) return;
  for (const [name, fn] of SUBSCRIPTIONS) dc.unsubscribe(name, fn);
  if (originalFetch && globalThis.fetch && globalThis.fetch.__ledger) globalThis.fetch = originalFetch;
  originalFetch = null;
  if (timer) { clearInterval(timer._daily); clearInterval(timer); timer = null; }
  installed = false;
}

function isInstalled() { return installed; }

module.exports = {
  install, uninstall, isInstalled, middleware, withContext, captureContext, note, flush, prune,
  cleanHost, scopeOf, originFromStack, featureFromStack, RETENTION_DAYS, PASS_THROUGH,
  _pending: () => pending,
};
