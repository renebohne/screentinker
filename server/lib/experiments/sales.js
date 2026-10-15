'use strict';

/*
 * Experiments: READ-ONLY sales import from Square and Shopify (docs/experiments.md, "Sales").
 *
 * An experiment does not hold credentials of its own. It names a Square or Shopify DATA SOURCE in
 * the same workspace (docs/pos-menus.md) and borrows its token for the duration of an import:
 * decrypted in memory, sent only to the host that source already sends it to, never returned,
 * logged or stored anywhere else. So the data-source rules apply unchanged — encrypted at rest,
 * redacted on read, and the "same store" rule that stops an edit pointing a saved token at another
 * store. The extra permission needed is ORDERS_READ (Square) / read_orders (Shopify).
 *
 *   Square   POST /v2/orders/search   location_ids (≤ 10 per call), COMPLETED orders by closed_at
 *            — POST because SearchOrders takes its query as a body; it reads, it changes nothing.
 *   Shopify  GraphQL orders(query: "processed_at:>=… AND processed_at:<…"), cancelled and test
 *            orders skipped. Without read_all_orders Shopify returns only the last 60 days.
 *
 * ⚠️ PRIVACY: AGGREGATES ONLY. An order is reduced, the moment it arrives, to four numbers in an
 * hourly bucket — (location, hour) → orders, units and revenue of the chosen items (or of all items
 * when none are chosen). We never request customer, fulfilment, address or payment fields, and
 * nothing per-order is stored: not an order id, not a line item, not a time finer than the hour.
 *
 * Mapping functions are exported and tested against response shapes from the official API
 * references with a fake transport (test/experiments.test.js); no test touches the network.
 */

const { UserFacingError } = require('../data-sources/http');
const pos = require('../data-sources/pos-common');
const square = require('../data-sources/square-resolver');
const shopify = require('../data-sources/shopify-resolver');

const HOUR = 3600;
const SQUARE_PAGE = 500;
const SQUARE_MAX_PAGES = 60;          // 30,000 orders per location batch per import
const SHOPIFY_PAGE = 20;              // × 30 line items: ~650 query-cost points, inside the 1,000 cap
const SHOPIFY_LINES = 30;
const SHOPIFY_MAX_PAGES = 300;        // 6,000 orders per import; the next import carries on
const MAX_ITEM_FILTERS = 40;

/* ─── item filter ───────────────────────────────────────────────────────────────────────────── */

/**
 * "Sales of the promoted item": a list of names, SKUs or catalogue ids. Matching is exact and
 * case-insensitive on any of a line's identifiers, so "Iced latte" matches the line "Iced Latte"
 * and "Iced latte (Large)" only if that full name is listed — sizes are separate items on a POS.
 */
function normaliseItemFilter(list) {
  const raw = Array.isArray(list) ? list : String(list == null ? '' : list).split(/[,\n]/);
  const out = [];
  const seen = new Set();
  for (const x of raw) {
    const s = String(x == null ? '' : x).trim().slice(0, 160);
    const k = s.toLowerCase();
    if (s && !seen.has(k)) { seen.add(k); out.push(s); }
  }
  return out.slice(0, MAX_ITEM_FILTERS);
}

function lineMatches(filterLower, ids) {
  if (!filterLower.length) return true;
  for (const id of ids) {
    if (id && filterLower.includes(String(id).toLowerCase())) return true;
  }
  return false;
}

/** Add one sale to the hourly buckets. key = `${location}|${hourUtc}`. */
function bump(buckets, location, epochSec, { orders = 0, units = 0, revenue = 0 }) {
  const hour = Math.floor(epochSec / HOUR) * HOUR;
  const key = `${location}|${hour}`;
  const b = buckets.get(key) || { location, hour_utc: hour, orders: 0, units: 0, revenue: 0 };
  b.orders += orders; b.units += units; b.revenue += revenue;
  buckets.set(key, b);
}

/* ─── Square ────────────────────────────────────────────────────────────────────────────────── */

/**
 * Square orders → hourly buckets per Square location. Only COMPLETED orders count (an OPEN order
 * is a tab still running; CANCELED never happened). Exported for the mapping tests.
 */
function mapSquareOrders(orders, { items = [], buckets = new Map() } = {}) {
  const filter = normaliseItemFilter(items).map((s) => s.toLowerCase());
  for (const o of orders || []) {
    if (!o || o.state !== 'COMPLETED' || !o.location_id) continue;
    const at = Date.parse(o.closed_at || o.created_at || '');
    if (!Number.isFinite(at)) continue;
    let units = 0, revenue = 0, matched = false;
    for (const li of Array.isArray(o.line_items) ? o.line_items : []) {
      if (!li) continue;
      const full = li.variation_name ? `${li.name} (${li.variation_name})` : li.name;
      if (!lineMatches(filter, [li.name, full, li.catalog_object_id])) continue;
      matched = true;
      const q = Number(li.quantity);
      if (Number.isFinite(q)) units += q;
      const m = li.total_money || li.gross_sales_money;
      if (m && m.amount != null) revenue += pos.fromMinor(m.amount, m.currency) || 0;
    }
    // orders = orders containing the item (or every order when no item is chosen).
    bump(buckets, o.location_id, Math.floor(at / 1000), { orders: matched ? 1 : 0, units, revenue });
  }
  return buckets;
}

async function squarePost(c, path, body, ctx) {
  const url = square.BASES[c.environment === 'sandbox' ? 'sandbox' : 'production'] + path;
  try {
    return await pos.fetchJson(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${String(c.access_token).trim()}`,
        'Square-Version': square.SQUARE_VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      maxRedirects: 0,
      maxBytes: 8 * 1024 * 1024,
      timeoutMs: 20000,
    }, ctx, 'Square');
  } catch (err) { throw squareError(err); }
}

async function squareGetJson(c, path, ctx) {
  const url = square.BASES[c.environment === 'sandbox' ? 'sandbox' : 'production'] + path;
  try {
    return await pos.fetchJson(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${String(c.access_token).trim()}`, 'Square-Version': square.SQUARE_VERSION, Accept: 'application/json' },
      maxRedirects: 0, maxBytes: 1024 * 1024, timeoutMs: 15000,
    }, ctx, 'Square');
  } catch (err) { throw squareError(err); }
}

function squareError(err) {
  const sc = pos.statusOf(err);
  if (sc === 401) return new UserFacingError('Square did not accept the access token saved in the data source.', 'auth');
  if (sc === 403) return new UserFacingError('The Square token is not allowed to read orders (Square permission ORDERS_READ).', 'scope');
  if (sc === 429) return new UserFacingError('Square is rate-limiting requests. The next import tries again.', 'rate-limit');
  if (sc >= 500) return new UserFacingError(`Square is having trouble right now (HTTP ${sc}). The next import tries again.`, 'upstream');
  return err;
}

/** The account's locations, for mapping a store to its Square location. */
async function squareLocations(c, ctx = {}) {
  const res = await squareGetJson(c, '/v2/locations', ctx);
  return (Array.isArray(res && res.locations) ? res.locations : [])
    .filter((l) => l && l.id && (!l.status || l.status === 'ACTIVE'))
    .map((l) => ({ id: String(l.id).slice(0, 64), name: pos.clean(l.name, 80) || l.id }))
    .slice(0, 100);
}

const LOCATION_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Import [fromSec, toSec) for `locationIds` ('*' = every active location). → { buckets, currency }.
 */
async function importSquare(c, { locationIds, fromSec, toSec, items, ctx = {} }) {
  if (!c || !c.access_token) throw new UserFacingError('The Square data source has no access token saved.', 'config');
  let ids = (locationIds || []).filter((x) => x === '*' || LOCATION_RE.test(String(x)));
  if (ids.includes('*')) ids = (await squareLocations(c, ctx)).map((l) => l.id);
  ids = [...new Set(ids)];
  const buckets = new Map();
  let currency = null;
  // SearchOrders takes at most 10 location ids per call.
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    let cursor = null;
    let pages = 0;
    const seen = new Set();
    do {
      const body = {
        location_ids: batch,
        limit: SQUARE_PAGE,
        return_entries: false,
        query: {
          filter: {
            state_filter: { states: ['COMPLETED'] },
            date_time_filter: { closed_at: { start_at: new Date(fromSec * 1000).toISOString(), end_at: new Date(toSec * 1000).toISOString() } },
          },
          // closed_at filtering requires sorting by CLOSED_AT (Square's rule).
          sort: { sort_field: 'CLOSED_AT', sort_order: 'ASC' },
        },
      };
      if (cursor) body.cursor = cursor;
      const page = await squarePost(c, '/v2/orders/search', body, ctx);
      const orders = Array.isArray(page && page.orders) ? page.orders : [];
      for (const o of orders) {
        const m = o && o.total_money;
        if (!currency && m && m.currency) currency = m.currency;
      }
      mapSquareOrders(orders, { items, buckets });
      cursor = page && typeof page.cursor === 'string' && page.cursor ? page.cursor : null;
      if (cursor && seen.has(cursor)) cursor = null;
      if (cursor) seen.add(cursor);
      pages++;
      if (cursor && pages >= SQUARE_MAX_PAGES) throw new UserFacingError('Square returned more orders than one import can read. Import a shorter period.', 'size-limit');
    } while (cursor);
  }
  return { buckets, currency };
}

/* ─── Shopify ───────────────────────────────────────────────────────────────────────────────── */

const ORDERS_QUERY = `query ExperimentOrders($after: String, $query: String, $head: Boolean!) {
  shop @include(if: $head) { currencyCode }
  currentAppInstallation @include(if: $head) { accessScopes { handle } }
  orders(first: ${SHOPIFY_PAGE}, after: $after, query: $query, sortKey: PROCESSED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      processedAt cancelledAt test
      retailLocation { id }
      lineItems(first: ${SHOPIFY_LINES}) { nodes { name sku quantity variant { id } product { id } originalTotalSet { shopMoney { amount currencyCode } } } }
    }
  }
}`;
const LOCATIONS_QUERY = `query ExperimentLocations { locations(first: 50) { nodes { id name } } }`;

const gidTail = (gid) => ((/(\d+)$/.exec(String(gid || '')) || [])[1] || null);

/** gid://shopify/Location/123 → "123"; an online order (no retail location) → "online". */
function shopifyLocationKey(loc) {
  const id = loc && loc.id ? String(loc.id) : '';
  const m = /(\d+)$/.exec(id);
  return m ? m[1] : 'online';
}

/** Shopify order nodes → hourly buckets per location ('online' for web orders). Exported for tests. */
function mapShopifyOrders(nodes, { items = [], buckets = new Map() } = {}) {
  const filter = normaliseItemFilter(items).map((s) => s.toLowerCase());
  for (const o of nodes || []) {
    if (!o || o.cancelledAt || o.test) continue;
    const at = Date.parse(o.processedAt || '');
    if (!Number.isFinite(at)) continue;
    let units = 0, revenue = 0, matched = false;
    for (const li of (o.lineItems && o.lineItems.nodes) || []) {
      if (!li) continue;
      // A product or variant may be listed by its full gid or by the number at its end (what the
      // Shopify admin shows in the address bar).
      const vid = li.variant && li.variant.id, pid = li.product && li.product.id;
      const ids = [li.name, li.sku, vid, pid, gidTail(vid), gidTail(pid)];
      if (!lineMatches(filter, ids)) continue;
      matched = true;
      const q = Number(li.quantity);
      if (Number.isFinite(q)) units += q;
      const amt = li.originalTotalSet && li.originalTotalSet.shopMoney && Number(li.originalTotalSet.shopMoney.amount);
      if (Number.isFinite(amt)) revenue += amt;
    }
    bump(buckets, shopifyLocationKey(o.retailLocation), Math.floor(at / 1000), { orders: matched ? 1 : 0, units, revenue });
  }
  return buckets;
}

function checkOrderScopes(data) {
  const inst = data && data.currentAppInstallation;
  const scopes = inst && Array.isArray(inst.accessScopes) ? inst.accessScopes.map((s) => String(s && s.handle || '')) : null;
  if (!scopes) return;
  // Same rule as the menu source: a credential that can change the store is not one a sign holds.
  const writes = scopes.filter((s) => /^(write|unauthenticated_write)_/.test(s));
  if (writes.length) throw new UserFacingError(`This app can change the store (${writes.slice(0, 4).join(', ')}). Use an app with read permissions only.`, 'scope-write');
  if (!scopes.includes('read_orders') && !scopes.includes('read_all_orders')) throw new UserFacingError('The Shopify app is missing the read_orders permission.', 'scope');
}

const SCOPE_MSG = 'The Shopify app is missing the read_orders permission.';

async function importShopify(c, { fromSec, toSec, items, ctx = {} }) {
  const shop = shopify.normalizeShopDomain(c && c.store_domain);
  if (!shop) throw new UserFacingError('The Shopify data source has no valid store address.', 'config');
  const sleep = ctx.sleep || pos.sleepReal;
  const state = { nextWait: 0, authRetry: false, scopeMessage: SCOPE_MSG };
  const query = `processed_at:>='${new Date(fromSec * 1000).toISOString()}' AND processed_at:<'${new Date(toSec * 1000).toISOString()}'`;
  const buckets = new Map();
  let after = null, pages = 0, head = true, currency = null;
  do {
    if (state.nextWait) { await sleep(state.nextWait); state.nextWait = 0; }
    let data;
    try {
      data = await shopify.graphql(shop, c, ctx, ORDERS_QUERY, { after, query, head }, state);
    } catch (err) {
      if (err && err.code === 'scope') throw new UserFacingError(SCOPE_MSG, 'scope');
      throw err;
    }
    if (head) { checkOrderScopes(data); currency = data.shop && data.shop.currencyCode || null; head = false; }
    const conn = data.orders;
    mapShopifyOrders((conn && conn.nodes) || [], { items, buckets });
    const info = conn && conn.pageInfo;
    after = info && info.hasNextPage && info.endCursor ? info.endCursor : null;
    pages++;
    if (after && pages >= SHOPIFY_MAX_PAGES) throw new UserFacingError('Shopify returned more orders than one import can read. Import a shorter period.', 'size-limit');
  } while (after);
  return { buckets, currency };
}

/** The store's locations (needs read_locations; [] when the app lacks it — ids can be typed). */
async function shopifyLocations(c, ctx = {}) {
  const shop = shopify.normalizeShopDomain(c && c.store_domain);
  if (!shop) return [];
  try {
    const data = await shopify.graphql(shop, c, ctx, LOCATIONS_QUERY, {}, { nextWait: 0, authRetry: false });
    return ((data.locations && data.locations.nodes) || []).filter((n) => n && n.id)
      .map((n) => ({ id: shopifyLocationKey(n), name: pos.clean(n.name, 80) || shopifyLocationKey(n) })).slice(0, 100);
  } catch (_) {
    return [];
  }
}

module.exports = {
  HOUR, normaliseItemFilter, mapSquareOrders, mapShopifyOrders, importSquare, importShopify,
  squareLocations, shopifyLocations, shopifyLocationKey, checkOrderScopes, ORDERS_QUERY,
};
