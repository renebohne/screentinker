'use strict';

/*
 * The built-in data-source types that live next to ical and weather: one table of what each type
 * validates, how it resolves, which config fields are secrets and how often it may refresh.
 * service.js, routes/data-sources.js and plugins/secrets.js all read this — adding a type is one
 * entry here plus its form in the dashboard.
 *
 * resolve(config, ctx) → { data, table?, raw? }
 *   data   the flat variable map that is cached and bound into slides ({{ds:slug.key}})
 *   table  { columns, sample } — the preview the dashboard shows after a test, never cached
 *   raw    a trimmed copy of the selected JSON (REST only), for the same preview
 *
 * ical and weather keep their own dispatch in service.js; they predate this table and return
 * their data map directly.
 */

const { resolveRest, validateRestConfig, SECRET_FIELDS: REST_SECRETS } = require('./rest-resolver');
const { resolveSheets, validateSheetsConfig } = require('./sheets-resolver');
const { resolveCsv, validateCsvConfig } = require('./csv-resolver');
const { resolveRss, validateRssConfig } = require('./rss-resolver');
const { resolveTable, validateTableConfig } = require('./table-resolver');
const { resolveSquare, validateSquareConfig } = require('./square-resolver');
const { resolveShopify, validateShopifyConfig, shopifyDestination } = require('./shopify-resolver');

const intervalOf = (floor, dflt = 15) => (c) => Math.max(floor, parseInt(c && c.interval_min, 10) || dflt);

const TYPES = {
  rest: {
    validate: validateRestConfig,
    resolve: resolveRest,
    fields: REST_SECRETS.map((name) => ({ name, type: 'password' })),
    interval: intervalOf(1),
    network: true,
  },
  sheets: {
    validate: validateSheetsConfig,
    resolve: resolveSheets,
    fields: [],
    // Google throttles the unauthenticated CSV endpoints; a minute is plenty for a menu board.
    interval: intervalOf(2),
    network: true,
  },
  csv: { validate: validateCsvConfig, resolve: resolveCsv, fields: [], interval: intervalOf(1), network: true },
  rss: { validate: validateRssConfig, resolve: resolveRss, fields: [], interval: intervalOf(5), network: true },
  // Nothing to fetch: it only "syncs" when edited, so the interval just keeps the poller away.
  table: { validate: validateTableConfig, resolve: resolveTable, fields: [], interval: () => 24 * 60, network: false },
  // Point of sale (docs/pos-menus.md). Five minutes by default: a price change reaches the screens
  // within one sync, and a whole catalogue is a handful of paged calls — well inside either
  // provider's limits. Floored at two minutes so a busy workspace cannot hammer a store's API.
  //
  // `secretDestination` says where a stored secret may be sent. These types have no `url` for the
  // route's same-origin rule to compare, and without it an edit would merge the saved token into a
  // config pointing at a different store (routes/data-sources.js sameSecretDestination).
  square: {
    validate: validateSquareConfig,
    resolve: resolveSquare,
    fields: [{ name: 'access_token', type: 'password' }],
    interval: intervalOf(2, 5),
    network: true,
    secretDestination: (c) => `square:${c && c.environment === 'sandbox' ? 'sandbox' : 'production'}`,
  },
  shopify: {
    validate: validateShopifyConfig,
    resolve: resolveShopify,
    fields: [{ name: 'access_token', type: 'password' }, { name: 'client_secret', type: 'password' }],
    interval: intervalOf(2, 5),
    network: true,
    secretDestination: shopifyDestination,
  },
};

function getBuiltinType(type) {
  return Object.prototype.hasOwnProperty.call(TYPES, type) ? TYPES[type] : null;
}

module.exports = { BUILTIN_TYPE_NAMES: Object.freeze(Object.keys(TYPES)), getBuiltinType };
