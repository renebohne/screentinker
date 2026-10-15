'use strict';

/*
 * Point-of-sale menus: the Square and Shopify data sources (lib/data-sources/square-resolver.js,
 * shopify-resolver.js, pos-common.js) and their wiring into the data-source routes and the menu
 * board. Every request goes to a fake transport — no test touches the network.
 *
 *   - real-shaped API responses (test/fixtures/pos-responses.js) → the rows a menu board reads
 *   - currency formatting per currency and locale, pagination, sold-out, filters, sizes
 *   - SSRF: Square only ever on its two fixed hosts with GET; Shopify only on <name>.myshopify.com
 *   - a credential that can write is refused; the token never comes back, is encrypted at rest,
 *     never reaches a log, an error, the audit trail — or another store after an edit
 *   - workspaces cannot see each other's sources; a viewer reads data but writes nothing
 *   - a price change in the POS reaches the menu board on the next sync ("Sync now")
 */

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-pos-' + crypto.randomBytes(4).toString('hex'));
process.env.JWT_SECRET = 'test-secret-pos-menus';
process.env.SELF_HOSTED = 'true';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const { UserFacingError, STATUS_HINTS } = require('../lib/data-sources/http');
const pos = require('../lib/data-sources/pos-common');
const square = require('../lib/data-sources/square-resolver');
const shopify = require('../lib/data-sources/shopify-resolver');
const { getBuiltinType } = require('../lib/data-sources/builtin-types');
const { RESERVED_DATA_SOURCE_TYPES } = require('../lib/plugins/reserved');
const menuBoard = require('../lib/menu-board');
const F = require('./fixtures/pos-responses');

const SQ_TOKEN = 'EAAAlSQUARE-SECRET-' + crypto.randomBytes(8).toString('hex');
const SHP_TOKEN = 'shpat_SHOPIFYSECRET' + crypto.randomBytes(8).toString('hex');
const SHP_SECRET = 'shpss_CLIENTSECRET' + crypto.randomBytes(8).toString('hex');
const NOW = new Date('2026-10-14T12:00:00Z');

/* ── fake transport ──────────────────────────────────────────────────────────────── */

// Like http.js fetchText: a 2xx answer as { text }, a 4xx/5xx as the UserFacingError it throws.
const httpError = (status) => new UserFacingError(STATUS_HINTS[status] || `The server answered HTTP ${status}.`, 'upstream-status');
const json = (o) => ({ text: JSON.stringify(o), contentType: 'application/json', status: 200 });

let calls = [];
let routes = null;   // (url, opts) => response | throws
pos._setTransportForTests(async (url, opts) => {
  calls.push({ url, method: opts.method || 'GET', headers: { ...(opts.headers || {}) }, body: opts.body == null ? null : String(opts.body), maxRedirects: opts.maxRedirects });
  if (!routes) throw new Error('no fake route');
  return routes(url, opts);
});

/** A whole Square account: locations + two catalog pages; `mutate` edits the catalog first. */
function squareAccount({ token = SQ_TOKEN, mutate = null, status = null } = {}) {
  return (url, opts) => {
    if (status) throw httpError(status);
    if (opts.headers.Authorization !== `Bearer ${token}`) throw httpError(401);
    const u = new URL(url);
    if (u.pathname === '/v2/locations') return json(F.squareLocations());
    if (u.pathname === '/v2/catalog/list') {
      const page = u.searchParams.get('cursor') ? F.squareCatalogPage2() : F.squareCatalogPage1();
      if (mutate) mutate(page);
      return json(page);
    }
    throw httpError(404);
  };
}

/** A Shopify store answering the products query in two pages. */
function shopifyStore({ token = SHP_TOKEN, scopes, mutate = null } = {}) {
  return (url, opts) => {
    const u = new URL(url);
    if (!/\.myshopify\.com$/.test(u.hostname)) throw new Error('not a shop');
    if (u.pathname === '/admin/oauth/access_token') {
      const b = new URLSearchParams(opts.body);
      if (b.get('grant_type') !== 'client_credentials' || b.get('client_secret') !== SHP_SECRET) throw httpError(400);
      return json({ access_token: token, scope: (scopes || ['read_products']).join(','), expires_in: 86399 });
    }
    if (opts.headers['X-Shopify-Access-Token'] !== token) throw httpError(401);
    const body = JSON.parse(opts.body);
    const page = body.variables.after ? F.shopifyProductsPage2() : F.shopifyProductsPage1(scopes);
    if (mutate) mutate(page);
    return json(page);
  };
}

/* ── mapping: Square ─────────────────────────────────────────────────────────────── */

test('Square: a real-shaped catalogue becomes menu rows (categories, sizes, prices, images, descriptions)', async () => {
  calls = []; routes = squareAccount();
  const out = await square.resolveSquare({ access_token: SQ_TOKEN, location_id: F.SQ_MAIN }, { now: NOW });
  assert.deepEqual(out.table.columns.map((c) => c.key), ['section', 'item', 'price', 'price_2', 'sizes', 'description', 'tags', 'sold_out', 'image']);
  const rows = out.table.sample;
  // Sections alphabetical; items by their category ordinal; legacy category_id still counts.
  assert.deepEqual(rows.map((r) => `${r.section}/${r.item}`), ['Bakery/Blueberry muffin', 'Bakery/Butter croissant', 'Bakery/Cake of the day', 'Coffee/Latte', 'Coffee/Espresso']);
  const latte = rows.find((r) => r.item === 'Latte');
  assert.equal(latte.price, '$3.50', 'variations by ordinal: Small first');
  assert.equal(latte.price_2, '$4.50');
  assert.equal(latte.sizes, 'Small / Large');
  assert.equal(latte.description, 'Double shot, steamed milk', 'description_plaintext, not the HTML');
  assert.match(latte.image, /^https:\/\/items-images-production\.s3/);
  assert.equal(rows.find((r) => r.item === 'Espresso').description, 'Legacy plain description');
  assert.equal(rows.find((r) => r.item === 'Cake of the day').price, '', 'variable pricing shows no price');
  assert.ok(!rows.some((r) => /Pumpkin|Deleted|Travel mug/.test(r.item)), 'archived, deleted and other-location items are left out');
  assert.equal(out.data.row_count, 5);
  assert.equal(out.data.row4_price, '$3.50');
  assert.equal(out.meta.location.id, F.SQ_MAIN);
  assert.deepEqual(out.meta.locations.map((l) => l.id), [F.SQ_MAIN, F.SQ_AIRPORT], 'inactive locations are not offered');
});

test('Square: sold-out marks per location, with expiry; location price overrides; presence per location', async () => {
  routes = squareAccount();
  const main = await square.resolveSquare({ access_token: SQ_TOKEN, location_id: F.SQ_MAIN }, { now: NOW });
  const at = (out, item) => out.table.sample.concat([]).find((r) => r.item === item) || null;
  assert.equal(at(main, 'Butter croissant').sold_out, 'yes');
  assert.equal(at(main, 'Blueberry muffin').sold_out, '', 'sold out until a time that has passed → back on sale');
  const earlier = await square.resolveSquare({ access_token: SQ_TOKEN, location_id: F.SQ_MAIN }, { now: new Date('2025-12-31T12:00:00Z') });
  assert.equal(at(earlier, 'Blueberry muffin').sold_out, 'yes', 'and sold out before it');

  const airport = await square.resolveSquare({ access_token: SQ_TOKEN, location_id: F.SQ_AIRPORT }, { now: NOW });
  assert.equal(at(airport, 'Latte').price, '$4.25', 'the location override wins');
  assert.equal(at(airport, 'Butter croissant').sold_out, '', 'sold out at Main St only');
  assert.ok(at(airport, 'Travel mug'), 'present_at_location_ids');
  assert.equal(at(airport, 'Cake of the day'), null, 'absent_at_location_ids');

  // Two active locations and none chosen: all items, list prices, no per-location sold-out.
  const all = await square.resolveSquare({ access_token: SQ_TOKEN }, { now: NOW });
  assert.equal(all.meta.location, null);
  assert.equal(at(all, 'Butter croissant').sold_out, '');
  assert.equal(at(all, 'Latte').price, '$3.50');

  routes = squareAccount();
  await assert.rejects(square.resolveSquare({ access_token: SQ_TOKEN, location_id: 'LGONE' }, { now: NOW }), (e) => e.code === 'location');
});

test('Square: pagination follows the cursor, stops on a repeated cursor, and is capped', async () => {
  calls = []; routes = squareAccount();
  await square.resolveSquare({ access_token: SQ_TOKEN }, { now: NOW });
  const lists = calls.filter((c) => c.url.includes('/v2/catalog/list'));
  assert.equal(lists.length, 2);
  assert.equal(new URL(lists[1].url).searchParams.get('cursor'), F.squareCatalogPage1().cursor);
  assert.equal(new URL(lists[0].url).searchParams.get('types'), 'ITEM,CATEGORY,IMAGE');

  // A Square that keeps handing out the same cursor must not loop forever.
  calls = [];
  routes = (url) => (url.includes('/v2/locations') ? json(F.squareLocations()) : json({ objects: [], cursor: 'SAME' }));
  await square.resolveSquare({ access_token: SQ_TOKEN }, { now: NOW });
  assert.equal(calls.filter((c) => c.url.includes('catalog')).length, 2);

  // An endless catalogue is cut at 30 pages and says so.
  calls = []; let n = 0;
  routes = (url) => (url.includes('/v2/locations') ? json(F.squareLocations()) : json({ objects: [], cursor: `C${++n}` }));
  const out = await square.resolveSquare({ access_token: SQ_TOKEN }, { now: NOW });
  assert.equal(calls.filter((c) => c.url.includes('catalog')).length, 30);
  assert.equal(out.meta.truncated, true);
});

test('Square: only GET, only to Square\'s fixed hosts, with the pinned API version; no config field moves the host', async () => {
  calls = []; routes = squareAccount();
  await square.resolveSquare({ access_token: SQ_TOKEN, url: 'https://evil.example/', base_url: 'http://127.0.0.1:8080', host: 'evil.example' }, { now: NOW });
  assert.ok(calls.length >= 3);
  for (const c of calls) {
    assert.equal(c.method, 'GET');
    assert.equal(new URL(c.url).origin, 'https://connect.squareup.com');
    assert.equal(c.headers['Square-Version'], square.SQUARE_VERSION);
    assert.equal(c.maxRedirects, 0);
    assert.equal(c.body, null);
  }
  calls = []; routes = squareAccount();
  await square.resolveSquare({ access_token: SQ_TOKEN, environment: 'sandbox' }, { now: NOW });
  assert.ok(calls.every((c) => new URL(c.url).origin === 'https://connect.squareupsandbox.com'));
  assert.match(square.validateSquareConfig({ environment: 'https://evil.example' }), /Production or Sandbox/);
});

test('Square: failures are explained without the token', async () => {
  for (const [status, re] of [[401, /did not accept the access token/], [403, /ITEMS_READ/], [429, /rate-limiting/], [503, /trouble right now/]]) {
    routes = squareAccount({ status });
    await assert.rejects(square.resolveSquare({ access_token: SQ_TOKEN }, { now: NOW }), (e) => {
      assert.match(e.userMessage, re);
      assert.ok(!String(e.message).includes(SQ_TOKEN) && !String(e.stack).includes(SQ_TOKEN));
      return true;
    });
  }
  routes = () => ({ text: '<html>oops', status: 200 });
  await assert.rejects(square.resolveSquare({ access_token: SQ_TOKEN }, { now: NOW }), (e) => e.code === 'parse');
  await assert.rejects(square.resolveSquare({}, { now: NOW }), /Enter the Square access token/);
  assert.match(square.validateSquareConfig({ access_token: 'has spaces and "quotes"' }), /does not look like/);
});

/* ── mapping: Shopify ────────────────────────────────────────────────────────────── */

test('Shopify: products by product type, prices in the store currency, sizes, sold-out, drafts dropped, dietary tags only', async () => {
  calls = []; routes = shopifyStore();
  const slept = [];
  const out = await shopify.resolveShopify({ store_domain: 'corner-cafe', access_token: SHP_TOKEN }, { now: NOW, sleep: async (ms) => slept.push(ms) });
  const rows = out.table.sample;
  assert.deepEqual(rows.map((r) => `${r.section}/${r.item}`), ['Bakery/Cinnamon bun', 'Coffee/Americano', 'Coffee/Flat white']);
  const fw = rows.find((r) => r.item === 'Flat white');
  assert.deepEqual([fw.price, fw.price_2, fw.sizes, fw.sold_out], ['€3.60', '€4.20', 'Regular / Large', ''], 'one size sold out is not the item sold out');
  assert.equal(fw.tags, 'vegan', 'merchandising tags (homepage, summer-sale) are not menu tags');
  assert.match(fw.image, /^https:\/\/cdn\.shopify\.com\//);
  const bun = rows.find((r) => r.item === 'Cinnamon bun');
  assert.deepEqual([bun.sizes, bun.sold_out, bun.tags], ['', 'yes', 'v'], '"Default Title" is no size');
  const am = rows.find((r) => r.item === 'Americano');
  assert.equal(am.image, '', 'only https images');
  assert.equal(am.tags, 'gf');
  assert.ok(!rows.some((r) => r.item === 'Winter blend beans'), 'drafts are not on sale');
  assert.equal(out.meta.currency, 'EUR');
  assert.deepEqual(out.meta.collections.map((c) => c.handle), ['hot-drinks', 'pastries', 'frontpage']);

  // Pagination and the request shape.
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.method, 'POST');
    assert.equal(c.url, `https://corner-cafe.myshopify.com/admin/api/${shopify.API_VERSION}/graphql.json`);
    assert.equal(c.headers['X-Shopify-Access-Token'], SHP_TOKEN);
    assert.equal(c.maxRedirects, 0, 'a custom token header never follows a redirect');
  }
  const [first, second] = calls.map((c) => JSON.parse(c.body).variables);
  assert.deepEqual(first, { after: null, query: 'status:active', head: true });
  assert.equal(second.after, F.shopifyProductsPage1().data.products.pageInfo.endCursor);
  assert.equal(second.head, false, 'shop, scopes and collections are read once per sync');
  assert.deepEqual(slept, [], 'plenty of query budget left: no waiting');
});

test('Shopify: collections become sections in the order given; a tag narrows; an unknown handle is explained', async () => {
  const P = F.product;
  const pages = {
    'hot-drinks': [F.shopifyCollection('Hot drinks', [P(1, 'Mocha', 'Coffee', [['Default Title', '4.10', true]], { tags: ['seasonal'] }), P(2, 'Chai', 'Tea', [['Default Title', '3.40', true]])], { first: true, hasNextPage: true, endCursor: 'HD2' }),
      F.shopifyCollection('Hot drinks', [P(3, 'Americano', 'Coffee', [['Default Title', '2.80', true]], { tags: ['Seasonal'] })])],
    pastries: [F.shopifyCollection('Pastries', [P(4, 'Croissant', 'Bakery', [['Default Title', '2.50', true]], { tags: ['seasonal'] })])],
  };
  calls = [];
  routes = (url, opts) => {
    const v = JSON.parse(opts.body).variables;
    if (!pages[v.handle]) return json(F.shopifyCollection(null, [], { first: v.head }));
    const list = pages[v.handle];
    const page = v.after ? list[1] : list[0];
    // Only the very first request of the sync asks for the head.
    if (!v.head) delete page.data.shop;
    return json(page);
  };
  const out = await shopify.resolveShopify({ store_domain: 'corner-cafe.myshopify.com', access_token: SHP_TOKEN, collections: 'pastries, hot-drinks' }, { now: NOW, sleep: async () => {} });
  assert.deepEqual(out.table.sample.map((r) => `${r.section}/${r.item}`), ['Pastries/Croissant', 'Hot drinks/Mocha', 'Hot drinks/Chai', 'Hot drinks/Americano'], 'collection order, then each collection\'s own order across pages');
  assert.ok(calls.every((c) => JSON.parse(c.body).query.includes('collectionByIdentifier')));
  assert.deepEqual(calls.map((c) => JSON.parse(c.body).variables.head), [true, false, false]);

  const tagged = await shopify.resolveShopify({ store_domain: 'corner-cafe', access_token: SHP_TOKEN, collections: ['hot-drinks'], tag: 'seasonal' }, { now: NOW, sleep: async () => {} });
  assert.deepEqual(tagged.table.sample.map((r) => r.item), ['Mocha', 'Americano'], 'tags match case-insensitively');

  await assert.rejects(shopify.resolveShopify({ store_domain: 'corner-cafe', access_token: SHP_TOKEN, collections: 'no-such' }, { now: NOW }), (e) => e.code === 'collection' && /no-such/.test(e.userMessage));

  // Products mode puts the tag into the search query, quoted, and refuses anything that could break out.
  calls = []; routes = shopifyStore();
  await shopify.resolveShopify({ store_domain: 'corner-cafe', access_token: SHP_TOKEN, tag: 'oat milk' }, { now: NOW, sleep: async () => {} });
  assert.equal(JSON.parse(calls[0].body).variables.query, 'status:active AND tag:"oat milk"');
  for (const bad of ['x" OR status:draft', 'a\\b', "it's"]) assert.match(shopify.validateShopifyConfig({ store_domain: 'a', tag: bad }), /tag may contain/);
  assert.match(shopify.validateShopifyConfig({ store_domain: 'a', collections: 'Hot Drinks!' }), /handle/);
});

test('Shopify: a credential that can write, or cannot read products, is refused', async () => {
  for (const scopes of [['read_products', 'write_products'], ['read_products', 'write_orders', 'read_orders'], ['read_products', 'unauthenticated_write_checkouts']]) {
    routes = shopifyStore({ scopes });
    await assert.rejects(shopify.resolveShopify({ store_domain: 'corner-cafe', access_token: SHP_TOKEN }, { now: NOW, sleep: async () => {} }),
      (e) => e.code === 'scope-write' && /read_products permission only/.test(e.userMessage));
  }
  routes = shopifyStore({ scopes: ['read_orders'] });
  await assert.rejects(shopify.resolveShopify({ store_domain: 'corner-cafe', access_token: SHP_TOKEN }, { now: NOW }), (e) => e.code === 'scope');
  routes = () => json({ errors: [{ message: 'Access denied for products field.', extensions: { code: 'ACCESS_DENIED' } }] });
  await assert.rejects(shopify.resolveShopify({ store_domain: 'corner-cafe', access_token: SHP_TOKEN }, { now: NOW }), (e) => e.code === 'scope');
});

test('Shopify: the store address must be <name>.myshopify.com — the SSRF guard', () => {
  const ok = {
    'corner-cafe': 'corner-cafe.myshopify.com',
    'Corner-Cafe.myshopify.com': 'corner-cafe.myshopify.com',
    'https://corner-cafe.myshopify.com/admin/products?x=1': 'corner-cafe.myshopify.com',
    'https://admin.shopify.com/store/corner-cafe/products': 'corner-cafe.myshopify.com',
    '  corner-cafe.myshopify.com  ': 'corner-cafe.myshopify.com',
  };
  for (const [raw, want] of Object.entries(ok)) assert.equal(shopify.normalizeShopDomain(raw), want, raw);
  const bad = [
    '', 'shop.example.com', 'corner-cafe.myshopify.com.evil.example', 'evil.example/x.myshopify.com', 'evil.example#.myshopify.com',
    'user@corner-cafe.myshopify.com', 'corner-cafe.myshopify.com:8443', '127.0.0.1', '169.254.169.254', '[::1]',
    'a.b.myshopify.com', '-x.myshopify.com', 'corner_cafe.myshopify.com', 'myshopify.com', 'http://10.0.0.1/admin.shopify.com/store/x',
    'corner-cafe.myshopify.com\\@evil.example', 'xn--80ak6aa92e.com', 'corner-cafe.myshopify.co',
  ];
  for (const raw of bad) assert.equal(shopify.normalizeShopDomain(raw), null, raw);
  assert.match(shopify.validateShopifyConfig({ store_domain: 'shop.example.com' }), /\.myshopify\.com/);
});

test('Shopify: the URL is built from the normalised name, so the token only ever goes to that store', async () => {
  calls = []; routes = shopifyStore();
  await shopify.resolveShopify({ store_domain: 'https://admin.shopify.com/store/corner-cafe', access_token: SHP_TOKEN, url: 'https://evil.example/' }, { now: NOW, sleep: async () => {} });
  assert.ok(calls.every((c) => new URL(c.url).host === 'corner-cafe.myshopify.com'));
  await assert.rejects(shopify.resolveShopify({ store_domain: 'evil.example', access_token: SHP_TOKEN }, { now: NOW }), (e) => e.code === 'config');
});

test('Shopify: client credentials are exchanged once and the 24 h token is cached; a revoked token is re-minted', async () => {
  shopify._clearTokenCache();
  const MINTED = 'shpat_MINTEDFROMCLIENTCREDS0001';
  calls = []; routes = shopifyStore({ token: MINTED });
  const cfg = { store_domain: 'corner-cafe', connect_with: 'client_credentials', client_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', client_secret: SHP_SECRET };
  await shopify.resolveShopify(cfg, { now: NOW, sleep: async () => {} });
  await shopify.resolveShopify(cfg, { now: NOW, sleep: async () => {} });
  const mints = calls.filter((c) => c.url.endsWith('/admin/oauth/access_token'));
  assert.equal(mints.length, 1, 'minted once, reused');
  assert.equal(mints[0].url, 'https://corner-cafe.myshopify.com/admin/oauth/access_token');
  assert.equal(mints[0].method, 'POST');
  assert.equal(mints[0].maxRedirects, 0);
  assert.equal(new URLSearchParams(mints[0].body).get('grant_type'), 'client_credentials');
  assert.ok(calls.filter((c) => c.url.includes('graphql')).every((c) => c.headers['X-Shopify-Access-Token'] === MINTED));

  // Revoked early: one 401, one fresh mint, then success.
  calls = [];
  const NEXT = 'shpat_MINTEDFROMCLIENTCREDS0002';
  const store = shopifyStore({ token: NEXT });
  routes = store;
  await shopify.resolveShopify(cfg, { now: NOW, sleep: async () => {} });
  assert.equal(calls.filter((c) => c.url.endsWith('/admin/oauth/access_token')).length, 1);

  routes = shopifyStore();
  await assert.rejects(shopify.resolveShopify({ ...cfg, client_secret: 'shpss_wrongwrongwrongwrong' }, { now: NOW }), (e) => e.code === 'auth' && !e.userMessage.includes('shpss_'));
  await assert.rejects(shopify.resolveShopify({ ...cfg, client_secret: '' }, { now: NOW }), /client secret/);
  assert.match(shopify.validateShopifyConfig({ store_domain: 'a', connect_with: 'client_credentials' }), /client ID/);
});

test('Shopify: the query-cost budget is respected — wait when the next page would not fit, retry once when THROTTLED', async () => {
  // Page 2 leaves 100 of 2000 points; a third page of ~212 points must wait (212-100)/100 s.
  const P3 = { data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } }, extensions: { cost: { requestedQueryCost: 212, actualQueryCost: 2, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1900, restoreRate: 100 } } } };
  routes = (url, opts) => {
    const v = JSON.parse(opts.body).variables;
    if (!v.after) return json(F.shopifyProductsPage1());
    if (v.after === 'P3') return json(P3);
    const p2 = F.shopifyProductsPage2();
    p2.data.products.pageInfo = { hasNextPage: true, endCursor: 'P3' };
    return json(p2);
  };
  const slept = [];
  await shopify.resolveShopify({ store_domain: 'corner-cafe', access_token: SHP_TOKEN }, { now: NOW, sleep: async (ms) => slept.push(ms) });
  assert.deepEqual(slept, [1220]);
  assert.equal(shopify.waitMs({ currentlyAvailable: 0, restoreRate: 50 }, 5000), 10000, 'capped');

  let n = 0; slept.length = 0;
  routes = (url, opts) => {
    if (++n === 1) return json({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], extensions: { cost: { requestedQueryCost: 312, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 12, restoreRate: 100 } } } });
    return shopifyStore()(url, opts);
  };
  const out = await shopify.resolveShopify({ store_domain: 'corner-cafe', access_token: SHP_TOKEN }, { now: NOW, sleep: async (ms) => slept.push(ms) });
  assert.equal(out.data.row_count, 3);
  assert.deepEqual(slept, [3100]);

  routes = () => json({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] });
  await assert.rejects(shopify.resolveShopify({ store_domain: 'corner-cafe', access_token: SHP_TOKEN }, { now: NOW, sleep: async () => {} }), (e) => e.code === 'rate-limit');
});

test('Shopify: HTTP failures are explained without the token', async () => {
  for (const [status, re] of [[401, /did not accept the access token/], [402, /frozen/], [403, /read_products/], [404, /no Shopify store/], [423, /locked/], [429, /rate-limiting/], [502, /trouble/]]) {
    routes = () => { throw httpError(status); };
    await assert.rejects(shopify.resolveShopify({ store_domain: 'corner-cafe', access_token: SHP_TOKEN }, { now: NOW }), (e) => {
      assert.match(e.userMessage, re);
      assert.ok(!String(e.message).includes(SHP_TOKEN) && !String(e.stack).includes(SHP_TOKEN));
      return true;
    });
  }
});

/* ── shared: money, filters, sizes ───────────────────────────────────────────────── */

test('currency formatting: minor units per currency, the store\'s locale, and plain numbers for the board', () => {
  assert.equal(pos.formatMoney(pos.fromMinor(350, 'USD'), 'USD'), '$3.50');
  assert.equal(pos.formatMoney(pos.fromMinor(450, 'JPY'), 'JPY', { locale: 'ja-JP' }), '￥450');
  assert.equal(pos.formatMoney(pos.fromMinor(1250, 'KWD'), 'KWD', { locale: 'en-US' }).replace(/\s/g, ' '), 'KWD 1.250');
  assert.equal(pos.formatMoney(3.5, 'EUR', { locale: 'de-DE' }).replace(/\s/g, ' '), '3,50 €');
  assert.equal(pos.formatMoney(1234.5, 'GBP', { locale: 'en-GB' }), '£1,234.50');
  assert.equal(pos.formatMoney(3.5, 'EUR', { format: 'number' }), '3.50');
  assert.equal(pos.formatMoney(450, 'JPY', { format: 'number' }), '450');
  assert.equal(pos.formatMoney('', 'USD'), '');
  assert.equal(pos.formatMoney(3.5, 'not-a-code'), '3.50');
  // The board formats "number" prices with its own currency setting.
  assert.equal(menuBoard.formatPrice('3.50', { decimals: 2, currency: '€', currency_after: true }), '3.50 €');
  assert.equal(menuBoard.formatPrice('$3.50', { decimals: 2, currency: '£' }), '$3.50', 'a formatted price is shown as written');
  assert.match(pos.validateCommon({ locale: 'not a locale' }), /en-US/);
  assert.equal(pos.validateCommon({ locale: 'de-DE' }), null);
});

test('filters: include (and its order), exclude, hide sold-out; sizes as columns, rows or the first only', async () => {
  routes = squareAccount();
  const base = { access_token: SQ_TOKEN, location_id: F.SQ_MAIN };
  const items = async (extra) => (await square.resolveSquare({ ...base, ...extra }, { now: NOW })).table.sample.map((r) => `${r.section}/${r.item}`);

  assert.deepEqual(await items({ include_sections: 'coffee, Bakery' }), ['Coffee/Latte', 'Coffee/Espresso', 'Bakery/Blueberry muffin', 'Bakery/Butter croissant', 'Bakery/Cake of the day'], 'case-insensitive, in the order listed');
  assert.deepEqual(await items({ exclude_sections: ['Bakery'] }), ['Coffee/Latte', 'Coffee/Espresso']);
  assert.ok(!(await items({ hide_sold_out: true })).includes('Bakery/Butter croissant'));

  const rows = (await square.resolveSquare({ ...base, variations: 'rows', include_sections: 'Coffee' }, { now: NOW })).table;
  assert.deepEqual(rows.sample.map((r) => [r.item, r.price]), [['Latte (Small)', '$3.50'], ['Latte (Large)', '$4.50'], ['Espresso', '$2.80']]);
  assert.ok(!rows.columns.some((c) => c.key === 'price_2' || c.key === 'sizes'));
  const first = (await square.resolveSquare({ ...base, variations: 'first', include_sections: 'Coffee' }, { now: NOW })).table.sample;
  assert.deepEqual(first.map((r) => [r.item, r.price]), [['Latte', '$3.50'], ['Espresso', '$2.80']]);

  // An item in several categories shows under the first one that survives the filters.
  const multi = pos.buildMenuTable([{ name: 'Mug', sections: [{ name: 'Retail' }, { name: 'Gifts' }], variations: [{ name: '', price: '$9', sold_out: false }] }], { exclude_sections: 'Retail' });
  assert.equal(multi.table.sample[0].section, 'Gifts');
  // Never more than four price columns; a sold-out item counts as sold out only when every size is.
  const many = pos.buildMenuTable([{ name: 'Tea', variations: ['XS', 'S', 'M', 'L', 'XL'].map((n) => ({ name: n, price: '1', sold_out: n !== 'XL' })) }]);
  assert.deepEqual(many.table.columns.filter((c) => /^price/.test(c.key)).map((c) => c.key), ['price', 'price_2', 'price_3', 'price_4']);
  assert.equal(many.table.sample[0].sold_out, 'yes', 'the four sizes shown are all sold out');
  assert.equal(many.table.sample[0].section, 'Menu', 'no category → "Menu"');
});

test('the menu board reads POS rows: sections, prices, sold-out struck through or hidden', async () => {
  routes = squareAccount();
  const out = await square.resolveSquare({ access_token: SQ_TOKEN, location_id: F.SQ_MAIN }, { now: NOW });
  const dataMap = { cafe: out.data };
  const secs = menuBoard.sectionsFromData(out.data);
  assert.deepEqual(secs.map((s) => s.name), ['Bakery', 'Coffee']);
  const latte = secs[1].items.find((i) => i.name === 'Latte');
  assert.deepEqual(latte.prices, ['$3.50', '$4.50']);
  assert.equal(secs[0].items.find((i) => i.name === 'Butter croissant').sold_out, true);

  const marked = menuBoard.renderMenuBoard({ source: { slug: 'cafe' }, sold_out: 'mark', price_labels: ['Small', 'Large'] }, { dataMap });
  assert.match(marked, /<div class="it so">[\s\S]*?Butter croissant[\s\S]*?Sold out/);
  assert.match(marked, /\.so \.nm,\.so \.ds\{opacity:\.45;text-decoration:line-through\}/);
  assert.match(marked, /\$4\.50/);
  const hidden = menuBoard.renderMenuBoard({ source: { slug: 'cafe' }, sold_out: 'hide' }, { dataMap });
  assert.doesNotMatch(hidden, /Butter croissant/);
  assert.match(hidden, /Blueberry muffin/);
});

test('wiring: registered, reserved from plugins, secrets declared, 5-minute default with a 2-minute floor', () => {
  for (const type of ['square', 'shopify']) {
    const b = getBuiltinType(type);
    assert.ok(b && b.network && typeof b.secretDestination === 'function');
    assert.ok(RESERVED_DATA_SOURCE_TYPES.has(type));
    assert.equal(b.interval({}), 5);
    assert.equal(b.interval({ interval_min: 1 }), 2);
    assert.equal(b.interval({ interval_min: 30 }), 30);
  }
  const { secretNames, fieldsForDataSource } = require('../lib/plugins/secrets');
  assert.deepEqual([...secretNames(fieldsForDataSource('shopify'))].sort(), ['access_token', 'authorization', 'client_secret']);
  assert.ok(secretNames(fieldsForDataSource('square')).has('access_token'));
  assert.ok(!secretNames(fieldsForDataSource('shopify')).has('connect_with'), 'the mode is not mistaken for a secret');
  assert.equal(getBuiltinType('shopify').secretDestination({ store_domain: 'https://A.myshopify.com/admin' }), 'shopify:a.myshopify.com');
  assert.equal(getBuiltinType('shopify').secretDestination({ store_domain: 'evil.example' }), null);
});

/* ── HTTP: routes, tenancy, viewer, secrets ──────────────────────────────────────── */

const ORG = 'o-pos', WS = 'ws-pos', OWNER = 'u-pos-owner', VIEWER = 'u-pos-viewer';
const ORG2 = 'o-pos2', WS2 = 'ws-pos2', OTHER = 'u-pos-other';
let server, base;
const realFetch = global.fetch;
const logged = [];
const origConsole = {};

before(async () => {
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, 'po@t.local', 'x', 'user'), (?, 'pv@t.local', 'x', 'user'), (?, 'px@t.local', 'x', 'user')").run(OWNER, VIEWER, OTHER);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?), (?, ?, ?)').run(ORG, 'Café', OWNER, ORG2, 'Other', OTHER);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?), (?, ?, ?)').run(WS, ORG, 'Main', WS2, ORG2, 'Theirs');
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner'), (?, ?, 'org_member'), (?, ?, 'org_owner')").run(ORG, OWNER, ORG, VIEWER, ORG2, OTHER);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin'), (?, ?, 'workspace_viewer'), (?, ?, 'workspace_admin')").run(WS, OWNER, WS, VIEWER, WS2, OTHER);

  // Everything the server prints from here on is checked for tokens at the end.
  for (const k of ['log', 'warn', 'error', 'info']) {
    origConsole[k] = console[k];
    console[k] = (...args) => { logged.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  }

  const app = express();
  app.use(express.json());
  app.use('/api/data-sources', requireAuth, resolveTenancy, require('../routes/data-sources'));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  for (const k of Object.keys(origConsole)) console[k] = origConsole[k];
  global.fetch = realFetch;
  pos._setTransportForTests(null);
  try { server.close(); } catch { /* */ }
  try { require('node:fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const tokenOf = (u) => generateToken(db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(u), u === OTHER ? WS2 : WS);
async function api(method, p, body, who = OWNER) {
  const r = await realFetch(base + p, { method, headers: { Authorization: `Bearer ${tokenOf(who)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* */ }
  return { status: r.status, body: j, text };
}
async function settle(id) {
  for (let i = 0; i < 100; i++) {
    const row = db.prepare('SELECT last_status FROM data_sources WHERE id = ?').get(id);
    if (row && row.last_status !== 'pending') return row.last_status;
    await new Promise((r) => setTimeout(r, 20));
  }
  return 'pending';
}
const IDS = {};

test('HTTP: connect Square — the token is encrypted at rest and never comes back', async () => {
  routes = squareAccount();
  const r = await api('POST', '/api/data-sources', { name: 'Café menu', slug: 'cafe', type: 'square', config: { access_token: SQ_TOKEN, location_id: F.SQ_MAIN } });
  assert.equal(r.status, 201, r.text);
  IDS.square = r.body.id;
  assert.equal(r.body.config.access_token, '');
  assert.equal(await settle(IDS.square), 'ok');

  const stored = db.prepare('SELECT config, cached_data FROM data_sources WHERE id = ?').get(IDS.square);
  assert.ok(!stored.config.includes(SQ_TOKEN), 'not plaintext in the database');
  assert.match(JSON.parse(stored.config).access_token, /^enc:v1:/);
  assert.ok(!stored.cached_data.includes(SQ_TOKEN));
  assert.equal(JSON.parse(stored.cached_data).row1_item, 'Blueberry muffin');

  for (const p of ['/api/data-sources', `/api/data-sources/${IDS.square}`]) {
    const g = await api('GET', p);
    assert.equal(g.status, 200);
    assert.ok(!g.text.includes(SQ_TOKEN), p);
    assert.ok(!g.text.includes('enc:v1:'), `${p}: not even the ciphertext`);
  }
  const audit = db.prepare("SELECT details FROM activity_log WHERE action = 'data_source.create'").all().map((a) => a.details).join('\n');
  assert.match(audit, /"type":"square"/);
  assert.ok(!audit.includes(SQ_TOKEN));
});

test('HTTP: test connection shows the first rows and the locations; an edit keeps the saved token', async () => {
  routes = squareAccount();
  const t1 = await api('POST', '/api/data-sources/test', { type: 'square', id: IDS.square, config: { access_token: '', location_id: F.SQ_MAIN } });
  assert.equal(t1.status, 200, t1.text);
  assert.equal(t1.body.table.sample[0].item, 'Blueberry muffin');
  assert.equal(t1.body.meta.locations.length, 2);
  assert.ok(!t1.text.includes(SQ_TOKEN));

  const put = await api('PUT', `/api/data-sources/${IDS.square}`, { config: { access_token: '', location_id: F.SQ_AIRPORT, hide_sold_out: true } });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.body.config.access_token, '');
  await new Promise((r) => setTimeout(r, 150));
  const row = db.prepare('SELECT config, last_status FROM data_sources WHERE id = ?').get(IDS.square);
  assert.equal(row.last_status, 'ok', 'the saved token was kept and works');
  assert.match(JSON.parse(row.config).access_token, /^enc:v1:/);

  const bad = await api('POST', '/api/data-sources/test', { type: 'square', config: { access_token: 'EAAAwrongwrongwrongwrong' } });
  assert.equal(bad.status, 422);
  assert.match(bad.body.error, /did not accept the access token/);
});

test('HTTP: a price change in Square reaches the menu board on "Sync now", and bumps the widget', async () => {
  db.prepare("INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config, updated_at) VALUES ('w-pos-menu', ?, ?, 'menu-board', 'Menu', ?, 1000)")
    .run(OWNER, WS, JSON.stringify({ source: { slug: 'cafe' }, sold_out: 'mark' }));
  routes = squareAccount({ mutate: (page) => {
    for (const o of page.objects) {
      if (o.type === 'ITEM' && o.item_data.name === 'Espresso') o.item_data.variations[0].item_variation_data.price_money.amount = 310;
    }
  } });
  const r = await api('POST', `/api/data-sources/${IDS.square}/refresh`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.last_status, 'ok');
  const espresso = Object.entries(r.body.data).find(([k, v]) => /_item$/.test(k) && v === 'Espresso');
  assert.equal(r.body.data[espresso[0].replace(/_item$/, '_price')], '$3.10');
  assert.ok(db.prepare("SELECT updated_at FROM widgets WHERE id = 'w-pos-menu'").get().updated_at > 1000, 'the widget revision moved, so screens re-render');
  const html = menuBoard.renderMenuBoard({ source: { slug: 'cafe' } }, { dataMap: { cafe: r.body.data } });
  assert.match(html, /\$3\.10/);
});

test('HTTP: Shopify — an edit that points at ANOTHER store drops the saved token instead of sending it there', async () => {
  routes = shopifyStore();
  const r = await api('POST', '/api/data-sources', { name: 'Shop', type: 'shopify', config: { store_domain: 'corner-cafe', access_token: SHP_TOKEN } });
  assert.equal(r.status, 201, r.text);
  IDS.shopify = r.body.id;
  assert.equal(await settle(IDS.shopify), 'ok');

  // Test against another store, borrowing the saved token by id: not merged.
  calls = [];
  routes = (url, opts) => shopifyStore()(url, opts);
  const t = await api('POST', '/api/data-sources/test', { type: 'shopify', id: IDS.shopify, config: { store_domain: 'attacker-shop', access_token: '' } });
  assert.equal(t.status, 422);
  assert.match(t.body.error, /Enter the Admin API access token/);
  assert.ok(!calls.some((c) => JSON.stringify(c.headers).includes(SHP_TOKEN)), 'no request carried the token to the other store');

  // Same store: merged, works.
  calls = [];
  const same = await api('POST', '/api/data-sources/test', { type: 'shopify', id: IDS.shopify, config: { store_domain: 'https://corner-cafe.myshopify.com/', access_token: '' } });
  assert.equal(same.status, 200, same.text);

  // A REST source's token is never back-filled into a Shopify test by id.
  const rest = await api('POST', '/api/data-sources', { name: 'Api', type: 'rest', config: { url: 'https://corner-cafe.myshopify.com/x', auth_type: 'bearer', auth_token: 'REST-TOKEN-0123456789abcdef' } });
  calls = [];
  const cross = await api('POST', '/api/data-sources/test', { type: 'shopify', id: rest.body.id, config: { store_domain: 'corner-cafe', access_token: '' } });
  assert.equal(cross.status, 422);
  assert.equal(calls.length, 0);

  // PUT to another store with a blank token: the stored token is dropped.
  calls = [];
  const put = await api('PUT', `/api/data-sources/${IDS.shopify}`, { config: { store_domain: 'attacker-shop', access_token: '' } });
  assert.equal(put.status, 200, put.text);
  await new Promise((res) => setTimeout(res, 150));
  const cfg = JSON.parse(db.prepare('SELECT config FROM data_sources WHERE id = ?').get(IDS.shopify).config);
  assert.equal(cfg.access_token, undefined, 'the token did not follow the store change');
  assert.ok(!calls.some((c) => JSON.stringify(c.headers).includes(SHP_TOKEN)));

  // A non-myshopify address is refused at save time.
  const ssrf = await api('PUT', `/api/data-sources/${IDS.shopify}`, { config: { store_domain: '169.254.169.254', access_token: SHP_TOKEN } });
  assert.equal(ssrf.status, 400);
  assert.match(ssrf.body.error, /myshopify\.com/);
});

test('HTTP: a viewer sees the menu data but no credential, and can change nothing', async () => {
  const list = await api('GET', '/api/data-sources', null, VIEWER);
  assert.equal(list.status, 200);
  assert.ok(list.body.some((d) => d.id === IDS.square && d.data && d.data.row_count > 0), 'viewers see the data');
  assert.ok(!list.text.includes(SQ_TOKEN) && !list.text.includes(SHP_TOKEN));
  for (const [m, p, b] of [
    ['POST', '/api/data-sources', { name: 'x', type: 'square', config: { access_token: SQ_TOKEN } }],
    ['POST', '/api/data-sources/test', { type: 'square', id: IDS.square, config: {} }],
    ['PUT', `/api/data-sources/${IDS.square}`, { config: { location_id: F.SQ_MAIN } }],
    ['POST', `/api/data-sources/${IDS.square}/refresh`],
    ['DELETE', `/api/data-sources/${IDS.square}`],
  ]) {
    assert.equal((await api(m, p, b, VIEWER)).status, 403, `${m} ${p}`);
  }
});

test('HTTP: another organization cannot list, read, test with, sync or delete the source', async () => {
  const list = await api('GET', '/api/data-sources', null, OTHER);
  assert.deepEqual(list.body, []);
  for (const [m, p] of [['GET', `/api/data-sources/${IDS.square}`], ['PUT', `/api/data-sources/${IDS.square}`], ['POST', `/api/data-sources/${IDS.square}/refresh`], ['DELETE', `/api/data-sources/${IDS.square}`]]) {
    assert.equal((await api(m, p, m === 'PUT' ? { config: { location_id: F.SQ_MAIN } } : undefined, OTHER)).status, 404, `${m} ${p}`);
  }
  calls = []; routes = squareAccount();
  const t = await api('POST', '/api/data-sources/test', { type: 'square', id: IDS.square, config: { access_token: '' } }, OTHER);
  assert.equal(t.status, 422, 'no back-fill across organizations');
  assert.equal(calls.length, 0);
});

test('no token ever reached a log line or the audit trail', async () => {
  const audit = db.prepare('SELECT details FROM activity_log').all().map((a) => a.details || '').join('\n');
  for (const secret of [SQ_TOKEN, SHP_TOKEN, SHP_SECRET]) {
    assert.ok(!logged.some((l) => l.includes(secret)), 'console');
    assert.ok(!audit.includes(secret), 'activity_log');
  }
  assert.ok(logged.length > 0, 'the failure paths above did log something');
});
