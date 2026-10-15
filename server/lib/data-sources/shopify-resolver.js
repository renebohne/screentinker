'use strict';

/*
 * Shopify data source: a store's products as menu rows (see pos-common.js for the row shape),
 * read through the GraphQL Admin API with READ-ONLY credentials.
 *
 * Two ways in, because Shopify changed how a store owner gets a token:
 *   connect_with 'token'               an Admin API access token (shpat_…) of a custom app made in
 *                                      the store admin. Shopify stopped letting stores CREATE these
 *                                      on 2026-01-01; existing ones keep working.
 *   connect_with 'client_credentials'  the client ID + secret of an app made in the Dev Dashboard
 *                                      and installed on the store. We exchange them for a token
 *                                      (24 h) with the client-credentials grant, cached in memory.
 * Either way the only scope we need is read_products. A credential that can WRITE anything is
 * refused (currentAppInstallation.accessScopes is checked on every sync): a screen has no business
 * holding a key that can change prices.
 *
 * ⚠️ SSRF. The store address is the one thing the operator types that becomes a host. It must be a
 * <name>.myshopify.com address (normalizeShopDomain); the URL is then built from that name, so no
 * other host — not a custom domain, not an IP, not a lookalike — ever receives the token. The
 * guarded fetch re-checks the resolved address as usual.
 *
 * Sections: with `collections` (handles, in the order they should appear) each collection is a
 * section; without, the product type is. `tag` narrows either to products carrying that tag.
 * Sold out = the variant is not available for sale (Shopify's own rule: tracked, no stock, no
 * overselling).
 *
 * config: store_domain, connect_with, access_token (secret), client_id, client_secret (secret),
 *         collections, tag, include_sections, exclude_sections, hide_sold_out, variations,
 *         price_format, locale, max_rows, key_column, interval_min
 */

const crypto = require('crypto');
const { UserFacingError } = require('./http');
const pos = require('./pos-common');

// A supported stable version (Shopify supports each for at least 12 months). Bump deliberately.
const API_VERSION = '2026-07';
const PAGE_SIZE = 25;          // products per request: keeps a query's cost well under 1000 points
const MAX_PAGES = 20;          // 500 products per sync, far more than a menu board shows
const MAX_COLLECTIONS = 12;
const SHOP_RE = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,255}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,254}$/i;
const TAG_RE = /^[\p{L}\p{N} _.&+\-/]{1,80}$/u;   // no quotes or backslashes: it goes into a search query

/**
 * What the operator pasted → "<name>.myshopify.com", or null. Accepts the bare name, the
 * myshopify address with or without https:// and a path, and the admin URL
 * (admin.shopify.com/store/<name>). Anything else — a custom domain, an IP, userinfo, a port, a
 * lookalike suffix — is refused rather than guessed at.
 */
function normalizeShopDomain(raw) {
  let s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s || s.length > 300) return null;
  s = s.replace(/^https?:\/\//, '');
  const admin = /^admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]{0,62})(?:[/?#]|$)/.exec(s);
  if (admin) return `${admin[1]}.myshopify.com`;
  s = s.replace(/[/?#].*$/, '');
  if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(s)) s += '.myshopify.com';
  return SHOP_RE.test(s) ? s : null;
}

function connectMode(c) { return c && c.connect_with === 'client_credentials' ? 'client_credentials' : 'token'; }

function validateShopifyConfig(c) {
  if (!c || typeof c !== 'object') return 'Config must be an object';
  if (!normalizeShopDomain(c.store_domain)) return 'Enter the store\'s .myshopify.com address (Shopify admin → Settings → Domains shows it), e.g. my-cafe.myshopify.com';
  if (c.connect_with != null && c.connect_with !== '' && !['token', 'client_credentials'].includes(c.connect_with)) return 'Unknown way to connect';
  if (c.access_token != null && c.access_token !== '' && !TOKEN_RE.test(String(c.access_token).trim())) return 'That does not look like an Admin API access token (it starts with shpat_)';
  if (connectMode(c) === 'client_credentials' && !CLIENT_ID_RE.test(String(c.client_id || '').trim())) return 'Enter the app\'s client ID';
  if (c.client_secret != null && c.client_secret !== '' && !TOKEN_RE.test(String(c.client_secret).trim())) return 'That does not look like a client secret';
  const handles = collectionHandles(c);
  if (handles === null) return 'Collections are listed by their handle — lower-case letters, digits and dashes (e.g. hot-drinks)';
  if (handles.length > MAX_COLLECTIONS) return `Up to ${MAX_COLLECTIONS} collections`;
  if (c.tag != null && c.tag !== '' && !TAG_RE.test(String(c.tag).trim())) return 'A tag may contain letters, digits, spaces and - _ . & + / only';
  return pos.validateCommon(c);
}

/** The collection handles in order, [] for none, null when one is malformed. */
function collectionHandles(c) {
  const list = pos.nameList(c && c.collections);
  for (const h of list) if (!HANDLE_RE.test(h)) return null;
  return list.map((h) => h.toLowerCase());
}

// ─── credentials ────────────────────────────────────────────────────────────────

// Client-credentials tokens live 24 hours. Cached per (store, client, secret) so a sync every few
// minutes does not mint a token each time; the key is a hash, so the map holds no secret as a key.
const tokenCache = new Map();
const TOKEN_CACHE_MAX = 500;
function cacheKey(shop, c) {
  return crypto.createHash('sha256').update(`${shop}\n${String(c.client_id).trim()}\n${String(c.client_secret).trim()}`).digest('hex');
}

async function accessTokenFor(shop, c, ctx, { fresh = false } = {}) {
  if (connectMode(c) === 'token') {
    if (!c.access_token || !String(c.access_token).trim()) throw new UserFacingError('Enter the Admin API access token.', 'config');
    return String(c.access_token).trim();
  }
  if (!c.client_secret || !String(c.client_secret).trim()) throw new UserFacingError('Enter the app\'s client secret.', 'config');
  const key = cacheKey(shop, c);
  const now = Date.now();
  const hit = tokenCache.get(key);
  if (!fresh && hit && hit.exp > now + 60000) return hit.token;
  let body;
  try {
    body = await pos.fetchJson(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: String(c.client_id).trim(), client_secret: String(c.client_secret).trim() }).toString(),
      maxRedirects: 0,
      maxBytes: 64 * 1024,
      timeoutMs: 15000,
    }, ctx, 'Shopify');
  } catch (err) {
    const sc = pos.statusOf(err);
    if (sc === 400 || sc === 401 || sc === 403) throw new UserFacingError('Shopify did not accept the client ID and secret. Check both, and that the app is installed on this store.', 'auth');
    throw shopifyStatusError(err);
  }
  const token = body && typeof body.access_token === 'string' ? body.access_token : '';
  if (!token) throw new UserFacingError('Shopify did not return an access token for this app.', 'auth');
  const ttl = Math.max(300, Math.min(86400, parseInt(body.expires_in, 10) || 3600)) * 1000;
  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.delete(tokenCache.keys().next().value);
  tokenCache.set(key, { token, exp: now + ttl });
  return token;
}

function shopifyStatusError(err) {
  const sc = pos.statusOf(err);
  if (sc === 401) return new UserFacingError('Shopify did not accept the access token. It may have been revoked — create or reveal it again.', 'auth');
  if (sc === 402) return new UserFacingError('Shopify says this store is frozen (unpaid plan), so its data cannot be read.', 'upstream');
  if (sc === 403) return new UserFacingError('The app is missing the read_products permission.', 'scope');
  if (sc === 404) return new UserFacingError('There is no Shopify store at that address. Check the .myshopify.com name.', 'not-found');
  if (sc === 423) return new UserFacingError('Shopify says this store is locked.', 'upstream');
  if (sc === 429) return new UserFacingError('Shopify is rate-limiting requests. The next sync tries again; a longer refresh interval helps.', 'rate-limit');
  if (sc >= 500) return new UserFacingError(`Shopify is having trouble right now (HTTP ${sc}). The screens keep the last menu.`, 'upstream');
  return err;
}

// ─── GraphQL ────────────────────────────────────────────────────────────────────

const PRODUCT_FIELDS = `
  id title status productType tags
  description(truncateAt: 400)
  featuredMedia { preview { image { url } } }
  variants(first: 10) { nodes { title price availableForSale position } }`;
const HEADER_FIELDS = `
  shop @include(if: $head) { name currencyCode }
  currentAppInstallation @include(if: $head) { accessScopes { handle } }
  collections(first: 100, sortKey: TITLE) @include(if: $head) { nodes { handle title } }`;
const PRODUCTS_QUERY = `query MenuProducts($after: String, $query: String, $head: Boolean!) {${HEADER_FIELDS}
  products(first: ${PAGE_SIZE}, after: $after, query: $query, sortKey: TITLE) {
    pageInfo { hasNextPage endCursor }
    nodes { ${PRODUCT_FIELDS} }
  }
}`;
const COLLECTION_QUERY = `query MenuCollection($handle: String!, $after: String, $head: Boolean!) {${HEADER_FIELDS}
  collectionByIdentifier(identifier: { handle: $handle }) {
    title
    products(first: ${PAGE_SIZE}, after: $after, sortKey: COLLECTION_DEFAULT) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PRODUCT_FIELDS} }
    }
  }
}`;

/*
 * One GraphQL call. Shopify's limit is a bucket of query-cost points that refills every second;
 * after each call we look at what is left, and wait (briefly) when the next page would not fit,
 * instead of being answered THROTTLED. A THROTTLED answer anyway gets one retry after a wait.
 */
async function graphql(shop, c, ctx, query, variables, state) {
  const sleep = ctx.sleep || pos.sleepReal;
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = await accessTokenFor(shop, c, ctx, { fresh: attempt > 0 && state.authRetry });
    state.authRetry = false;
    let res;
    try {
      res = await pos.fetchJson(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
        // A custom token header is not stripped on a redirect the way Authorization is: never follow.
        maxRedirects: 0,
        maxBytes: 4 * 1024 * 1024,
        timeoutMs: 20000,
      }, ctx, 'Shopify');
    } catch (err) {
      // A cached client-credentials token can be revoked before it expires: mint once more.
      if (pos.statusOf(err) === 401 && connectMode(c) === 'client_credentials' && attempt === 0) { state.authRetry = true; continue; }
      throw shopifyStatusError(err);
    }
    const cost = res && res.extensions && res.extensions.cost;
    const throttle = cost && cost.throttleStatus;
    const errors = Array.isArray(res && res.errors) ? res.errors : [];
    const code = (e) => (e && e.extensions && e.extensions.code) || '';
    if (errors.some((e) => code(e) === 'THROTTLED')) {
      if (attempt >= 2) throw new UserFacingError('Shopify is rate-limiting requests. The next sync tries again; a longer refresh interval helps.', 'rate-limit');
      await sleep(waitMs(throttle, (cost && cost.requestedQueryCost) || 300) || 2000);
      continue;
    }
    // state.scopeMessage: the orders import (lib/experiments/sales.js) needs read_orders, not read_products.
    if (errors.some((e) => code(e) === 'ACCESS_DENIED')) throw new UserFacingError(state.scopeMessage || 'The app is missing the read_products permission.', 'scope');
    if (errors.length && !(res && res.data)) throw new UserFacingError('Shopify could not answer the catalogue query. If this keeps happening, tell your ScreenTinker administrator.', 'upstream');
    state.nextWait = waitMs(throttle, (cost && cost.requestedQueryCost) || 0);
    return res.data || {};
  }
  throw new UserFacingError('Shopify is rate-limiting requests. The next sync tries again; a longer refresh interval helps.', 'rate-limit');
}

/** How long until `need` points are back in the bucket (0 = go now), capped at 10 s. */
function waitMs(throttle, need) {
  if (!throttle || !need) return 0;
  const avail = Number(throttle.currentlyAvailable);
  const rate = Number(throttle.restoreRate) || 50;
  if (!Number.isFinite(avail) || avail >= need) return 0;
  return Math.min(10000, Math.ceil(((need - avail) / rate) * 1000) + 100);
}

/** Refuse a credential that can write, or that cannot read products. */
function checkScopes(data) {
  const inst = data && data.currentAppInstallation;
  const scopes = inst && Array.isArray(inst.accessScopes) ? inst.accessScopes.map((s) => String(s && s.handle || '')) : null;
  if (!scopes) return;   // older shapes: Shopify still enforces the token's own scopes
  const writes = scopes.filter((s) => /^(write|unauthenticated_write)_/.test(s));
  if (writes.length) {
    throw new UserFacingError(`This app can change the store (${writes.slice(0, 4).join(', ')}${writes.length > 4 ? ', …' : ''}). For screens, use an app with the read_products permission only.`, 'scope-write');
  }
  if (!scopes.includes('read_products')) throw new UserFacingError('The app is missing the read_products permission.', 'scope');
}

/** Shopify products → normalised items (pos-common.js). Exported for the mapping tests. */
function mapProducts(products, { section = null, sectionRank = 0, currency, locale = 'en-US', price_format = 'currency', tag = '' } = {}) {
  const fmt = { locale, format: price_format };
  const wantTag = String(tag || '').trim().toLowerCase();
  const items = [];
  (products || []).forEach((p, i) => {
    if (!p || p.status && p.status !== 'ACTIVE') return;   // drafts and archived products are not on sale
    if (wantTag && !(Array.isArray(p.tags) && p.tags.some((t) => String(t).toLowerCase() === wantTag))) return;
    const variants = ((p.variants && p.variants.nodes) || []).filter(Boolean)
      .slice().sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0))
      .map((v) => ({
        // Shopify names the only variant of a size-less product "Default Title".
        name: v.title && v.title !== 'Default Title' ? pos.clean(v.title, 60) : '',
        price: v.price != null && v.price !== '' ? pos.formatMoney(Number(v.price), currency, fmt) : '',
        sold_out: v.availableForSale === false,
      }));
    if (!variants.length) return;
    const secName = section || pos.clean(p.productType, 120) || 'Menu';
    const media = p.featuredMedia && p.featuredMedia.preview && p.featuredMedia.preview.image;
    items.push({
      name: pos.clean(p.title, 160),
      description: p.description || '',
      image: media && media.url ? media.url : '',
      tags: Array.isArray(p.tags) ? p.tags : [],
      // A collection has its own order (rank); by product type, items are listed by name.
      rank: section ? i : undefined,
      sections: [{ name: secName, rank: sectionRank, itemRank: section ? i : undefined }],
      variations: variants,
    });
  });
  return items;
}

async function resolveShopify(config, ctx = {}) {
  const c = { ...(config || {}) };
  const err = validateShopifyConfig(c);
  if (err) throw new UserFacingError(err, 'config');
  const shop = normalizeShopDomain(c.store_domain);
  const handles = collectionHandles(c);
  const sleep = ctx.sleep || pos.sleepReal;
  const state = { nextWait: 0, authRetry: false };
  const now = ctx.now || new Date();

  let head = null;
  let pages = 0;
  let truncated = false;
  const products = [];   // [{ list, section, sectionRank }]
  const pace = async () => { if (state.nextWait) { await sleep(state.nextWait); state.nextWait = 0; } };
  const takeHead = (data) => { if (!head) { head = data; checkScopes(data); } };

  const targets = handles.length ? handles.map((h, i) => ({ handle: h, rank: i })) : [{ handle: null, rank: 0 }];
  const tag = c.tag ? String(c.tag).trim() : '';
  for (const target of targets) {
    let after = null;
    do {
      if (pages >= MAX_PAGES) { truncated = true; break; }
      await pace();
      let conn;
      let title = null;
      if (target.handle) {
        const data = await graphql(shop, c, ctx, COLLECTION_QUERY, { handle: target.handle, after, head: !head }, state);
        takeHead(data);
        const coll = data.collectionByIdentifier;
        if (!coll) throw new UserFacingError(`There is no collection with the handle "${target.handle}" in this store. Test the connection to see the store's collections.`, 'collection');
        title = pos.clean(coll.title, 120) || target.handle;
        conn = coll.products;
      } else {
        const query = `status:active${tag ? ` AND tag:"${tag}"` : ''}`;
        const data = await graphql(shop, c, ctx, PRODUCTS_QUERY, { after, query, head: !head }, state);
        takeHead(data);
        conn = data.products;
      }
      pages++;
      products.push({ list: (conn && conn.nodes) || [], section: title, sectionRank: target.rank, offset: products.filter((p) => p.sectionRank === target.rank).reduce((n, p) => n + p.list.length, 0) });
      const info = conn && conn.pageInfo;
      after = info && info.hasNextPage && info.endCursor ? info.endCursor : null;
    } while (after);
  }

  const currency = head && head.shop && head.shop.currencyCode;
  const locale = c.locale || 'en-US';
  const items = [];
  for (const chunk of products) {
    const mapped = mapProducts(chunk.list, { section: chunk.section, sectionRank: chunk.sectionRank, currency, locale, price_format: c.price_format, tag });
    // Keep a collection's own order across pages.
    for (const it of mapped) { if (Number.isFinite(it.rank)) it.rank += chunk.offset; for (const s of it.sections) if (s.itemRank !== undefined) s.itemRank += chunk.offset; }
    items.push(...mapped);
  }
  const out = pos.buildMenuTable(items, c, { now });
  out.meta = {
    provider: 'shopify',
    shop: head && head.shop ? { name: pos.clean(head.shop.name, 120), domain: shop } : { domain: shop },
    currency: currency || null,
    collections: head && head.collections && Array.isArray(head.collections.nodes)
      ? head.collections.nodes.filter((n) => n && n.handle).map((n) => ({ handle: String(n.handle).slice(0, 255), title: pos.clean(n.title, 120) })).slice(0, 100)
      : [],
    item_count: items.length,
    truncated,
  };
  return out;
}

/** Where a stored secret may be sent: the same store. routes/data-sources.js compares these. */
function shopifyDestination(c) {
  const shop = normalizeShopDomain(c && c.store_domain);
  return shop ? `shopify:${shop}` : null;
}

function _clearTokenCache() { tokenCache.clear(); }

module.exports = {
  API_VERSION, normalizeShopDomain, validateShopifyConfig, resolveShopify, mapProducts, checkScopes,
  shopifyDestination, waitMs, _clearTokenCache, PRODUCTS_QUERY, COLLECTION_QUERY,
  // For the experiments sales import (lib/experiments/sales.js): the same credentials, host rule and
  // rate-limit pacing, so a second copy of them can never disagree with this one.
  graphql, connectMode,
};
