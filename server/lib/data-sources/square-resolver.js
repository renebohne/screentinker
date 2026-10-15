'use strict';

/*
 * Square data source: a Square item library as menu rows (see pos-common.js for the row shape).
 *
 * Read with a personal access token (Square Developer Dashboard → your app → Credentials).
 * ⚠️ Square personal access tokens cannot be narrowed: they carry every permission of the account.
 * We compensate in code — this resolver only ever issues GET requests, only to the two read
 * endpoints below, only on Square's own fixed hosts — and the docs say so (docs/pos-menus.md).
 * OAuth with ITEMS_READ + MERCHANT_PROFILE_READ is the scoped alternative, left for later because
 * it needs a registered ScreenTinker app (and a redirect URL every self-hoster would have to own).
 *
 *   GET /v2/locations                              which store: its currency and number format
 *   GET /v2/catalog/list?types=ITEM,CATEGORY,IMAGE every item with its variations, paged by cursor
 *
 * Per location (when one is chosen, or the account has only one): an item or variation not sold
 * there is left out, a location price override wins, and "Mark as sold out" on the POS
 * (location_overrides[].sold_out) becomes the row's Sold out flag.
 *
 * config: environment ('production' | 'sandbox'), access_token (secret), location_id,
 *         include_sections, exclude_sections, hide_sold_out, variations, price_format, locale,
 *         max_rows, key_column, interval_min
 */

const { UserFacingError } = require('./http');
const pos = require('./pos-common');

// The base URL is chosen from this table and nothing else: no config field can point the token
// at another host.
const BASES = {
  production: 'https://connect.squareup.com',
  sandbox: 'https://connect.squareupsandbox.com',
};
// Pinned so a Square release cannot change the response shapes under us. Square keeps old versions
// working; bump deliberately after reading their changelog.
const SQUARE_VERSION = '2026-09-16';
const MAX_PAGES = 30;
const TOKEN_RE = /^[A-Za-z0-9_\-.]{16,256}$/;
const LOCATION_RE = /^[A-Za-z0-9_-]{1,64}$/;

function validateSquareConfig(c) {
  if (!c || typeof c !== 'object') return 'Config must be an object';
  if (c.environment != null && c.environment !== '' && !BASES[c.environment]) return 'The environment must be Production or Sandbox';
  // Blank on an edit means "keep the saved token" (routes/data-sources.js merges it back).
  if (c.access_token != null && c.access_token !== '' && !TOKEN_RE.test(String(c.access_token).trim())) return 'That does not look like a Square access token — copy it again from the Developer Dashboard';
  if (c.location_id != null && c.location_id !== '' && !LOCATION_RE.test(String(c.location_id))) return 'Unknown location';
  // The dashboard keeps the picked location's name for the card; display only, never sent anywhere.
  if (c.location_name != null && String(c.location_name).length > 120) return 'The location name is too long';
  return pos.validateCommon(c);
}

function baseFor(c) { return BASES[c.environment] || BASES.production; }

/** One GET to Square, failures explained for the operator. Never anything but GET. */
async function squareGet(c, path, ctx) {
  const url = baseFor(c) + path;
  try {
    return await pos.fetchJson(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${String(c.access_token).trim()}`,
        'Square-Version': SQUARE_VERSION,
        Accept: 'application/json',
      },
      // Square never redirects these; a redirect would be someone else's answer.
      maxRedirects: 0,
      maxBytes: 4 * 1024 * 1024,
      timeoutMs: 15000,
    }, ctx, 'Square');
  } catch (err) {
    const sc = pos.statusOf(err);
    if (sc === 401) throw new UserFacingError(`Square did not accept the access token. Check you copied the ${c.environment === 'sandbox' ? 'Sandbox' : 'Production'} token — Square has one of each.`, 'auth');
    if (sc === 403) throw new UserFacingError('The token is not allowed to read the item library and locations (Square permissions ITEMS_READ and MERCHANT_PROFILE_READ).', 'scope');
    if (sc === 429) throw new UserFacingError('Square is rate-limiting requests. The next sync tries again; a longer refresh interval helps.', 'rate-limit');
    if (sc >= 500) throw new UserFacingError(`Square is having trouble right now (HTTP ${sc}). The screens keep the last menu.`, 'upstream');
    throw err;
  }
}

/** Is a catalog object sold at this location? (present_at_all_locations defaults to true.) */
function presentAt(obj, loc) {
  if (!loc || !obj) return true;
  if (obj.present_at_all_locations === false) return Array.isArray(obj.present_at_location_ids) && obj.present_at_location_ids.includes(loc);
  return !(Array.isArray(obj.absent_at_location_ids) && obj.absent_at_location_ids.includes(loc));
}

function variationFor(v, loc, fmt, now) {
  const d = (v && v.item_variation_data) || {};
  if (v.is_deleted || d.sellable === false) return null;
  const ov = loc && Array.isArray(d.location_overrides) ? d.location_overrides.find((o) => o && o.location_id === loc) : null;
  const money = (ov && ov.price_money) || d.price_money;
  const variable = ((ov && ov.pricing_type) || d.pricing_type) === 'VARIABLE_PRICING';
  let price = '';
  if (!variable && money && money.amount != null && money.currency) {
    price = pos.formatMoney(pos.fromMinor(money.amount, money.currency), money.currency, fmt);
  }
  // A sold-out mark can carry an expiry ("sold out until tomorrow"); past it, the item is back.
  let soldOut = !!(ov && ov.sold_out);
  if (soldOut && ov.sold_out_valid_until) {
    const until = Date.parse(ov.sold_out_valid_until);
    if (Number.isFinite(until) && until <= now.getTime()) soldOut = false;
  }
  return { name: pos.clean(d.name, 60), price, sold_out: soldOut, ordinal: Number.isFinite(d.ordinal) ? d.ordinal : Infinity };
}

/** Square catalog objects → normalised items (pos-common.js). Exported for the mapping tests. */
function mapCatalog(objects, { locationId = null, locale = 'en-US', price_format = 'currency', now = new Date() } = {}) {
  const cats = new Map();
  const images = new Map();
  for (const o of objects) {
    if (!o || o.is_deleted) continue;
    if (o.type === 'CATEGORY' && o.category_data) cats.set(o.id, pos.clean(o.category_data.name, 120));
    if (o.type === 'IMAGE' && o.image_data) images.set(o.id, o.image_data.url);
  }
  const fmt = { locale, format: price_format };
  const items = [];
  for (const o of objects) {
    if (!o || o.type !== 'ITEM' || o.is_deleted || !o.item_data) continue;
    const d = o.item_data;
    if (d.is_archived || !presentAt(o, locationId)) continue;
    const variations = (Array.isArray(d.variations) ? d.variations : [])
      .filter((v) => v && presentAt(v, locationId))
      .map((v) => variationFor(v, locationId, fmt, now)).filter(Boolean)
      .sort((a, b) => (a.ordinal === b.ordinal ? 0 : a.ordinal === Infinity ? 1 : b.ordinal === Infinity ? -1 : a.ordinal - b.ordinal));
    if (!variations.length) continue;
    // categories[] (2023-12 onward) with each membership's ordinal; reporting_category and the
    // deprecated category_id for catalogues built before that.
    const memberships = [];
    for (const m of Array.isArray(d.categories) ? d.categories : []) if (m && cats.has(m.id)) memberships.push({ name: cats.get(m.id), rank: 0, itemRank: Number.isFinite(m.ordinal) ? m.ordinal : undefined });
    for (const id of [d.reporting_category && d.reporting_category.id, d.category_id]) {
      if (id && cats.has(id) && !memberships.some((m) => m.name === cats.get(id))) memberships.push({ name: cats.get(id), rank: 0 });
    }
    const imageId = (Array.isArray(d.image_ids) && d.image_ids[0]) || null;
    items.push({
      name: pos.clean(d.name, 160),
      description: d.description_plaintext || d.description || '',
      image: imageId ? images.get(imageId) || '' : '',
      sections: memberships,
      variations,
    });
  }
  return items;
}

async function resolveSquare(config, ctx = {}) {
  const c = { ...(config || {}) };
  const err = validateSquareConfig(c);
  if (err) throw new UserFacingError(err, 'config');
  if (!c.access_token || !String(c.access_token).trim()) throw new UserFacingError('Enter the Square access token.', 'config');
  const now = ctx.now || new Date();

  const locRes = await squareGet(c, '/v2/locations', ctx);
  const locations = (Array.isArray(locRes && locRes.locations) ? locRes.locations : []).filter((l) => l && l.id);
  const active = locations.filter((l) => !l.status || l.status === 'ACTIVE');
  let loc = null;
  if (c.location_id) {
    loc = locations.find((l) => l.id === c.location_id) || null;
    if (!loc) throw new UserFacingError('That location is not in this Square account any more. Test the connection and pick one from the list.', 'location');
  } else if (active.length === 1) {
    loc = active[0];   // one shop: its prices and sold-out marks apply without asking
  }
  const ref = loc || active[0] || locations[0] || {};
  const locale = c.locale || (typeof ref.language_code === 'string' && /^[a-z]{2}-[A-Z]{2}$/.test(ref.language_code) ? ref.language_code : 'en-US');

  const objects = [];
  let cursor = null;
  let pages = 0;
  let truncated = false;
  const seen = new Set();
  do {
    const q = new URLSearchParams({ types: 'ITEM,CATEGORY,IMAGE' });
    if (cursor) q.set('cursor', cursor);
    const page = await squareGet(c, `/v2/catalog/list?${q}`, ctx);
    if (Array.isArray(page && page.objects)) objects.push(...page.objects);
    cursor = page && typeof page.cursor === 'string' && page.cursor ? page.cursor : null;
    if (cursor && seen.has(cursor)) cursor = null;   // a repeated cursor would loop forever
    if (cursor) seen.add(cursor);
    pages++;
    if (cursor && pages >= MAX_PAGES) { truncated = true; cursor = null; }
  } while (cursor);

  const items = mapCatalog(objects, { locationId: loc ? loc.id : null, locale, price_format: c.price_format, now });
  const out = pos.buildMenuTable(items, c, { now });
  out.meta = {
    provider: 'square',
    locations: active.map((l) => ({ id: l.id, name: pos.clean(l.name, 80) || l.id })).slice(0, 100),
    location: loc ? { id: loc.id, name: pos.clean(loc.name, 80) } : null,
    currency: ref.currency || null,
    item_count: items.length,
    truncated,
  };
  return out;
}

module.exports = { BASES, SQUARE_VERSION, validateSquareConfig, resolveSquare, mapCatalog, presentAt };
