'use strict';

/*
 * What the point-of-sale data sources (square-resolver.js, shopify-resolver.js) share: a catalogue
 * normalised to items → the same rows a Google Sheet menu produces, so the menu board
 * (lib/menu-board.js sectionsFromData) reads a Square or Shopify catalogue with no code of its own.
 *
 *   Section | Item | Price | Price 2..4 | Sizes | Description | Tags | Sold out | Image
 *
 * A provider resolver turns its API's objects into NORMALISED ITEMS:
 *   { sections: [{ name, rank }], name, description, image, tags: [], rank,
 *     variations: [{ name, price: <formatted string or ''>, sold_out: bool }] }
 * and buildMenuTable() applies the filters every POS source offers (include / exclude sections,
 * hide sold-out, how sizes are shown), orders the rows and flattens them with the table engine.
 *
 * ⚠️ TOKENS. These sources carry a store's API credentials. They are encrypted at rest and redacted
 * on read by the generic data-source machinery (builtin-types `fields`); here the rule is that no
 * message we build — thrown, logged or returned — ever contains one. Error text is written from
 * fixed strings and the provider's HTTP status only, never echoed from a response body or a header.
 */

const { fetchText, UserFacingError } = require('./http');
const tab = require('./tabular');

const MAX_PRICE_COLUMNS = 4;
const MAX_LIST = 40;          // include / exclude entries
const VARIATION_MODES = new Set(['columns', 'rows', 'first']);
const PRICE_FORMATS = new Set(['currency', 'number']);
const LOCALE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

// Dietary tags the menu board knows (lib/menu-board.js KNOWN_TAGS + its aliases). A Shopify
// product's tags are mostly merchandising ("summer-sale", "homepage"); only these are passed on,
// or every board would sprout marketing badges.
const DIETARY_TAGS = new Set(['v', 'vg', 'gf', 'df', 'n', 'h', 'spicy', 'new', 'popular',
  'vegetarian', 'vegan', 'gluten-free', 'glutenfree', 'dairy-free', 'nuts', 'halal', 'hot']);

/*
 * Tests swap the transport for a fake so no test ever touches the network. Production never sets
 * it; ctx.fetcher (the REST resolver's convention) wins over it when given.
 */
let testTransport = null;
function _setTransportForTests(fn) { testTransport = typeof fn === 'function' ? fn : null; }
function transportFor(ctx) { return (ctx && ctx.fetcher) || testTransport || undefined; }

/** fetchText + JSON parse, with the provider's name in the operator-facing failure. */
async function fetchJson(url, opts, ctx, provider) {
  const res = await fetchText(url, { ...opts, fetcher: transportFor(ctx) });
  try {
    return JSON.parse(res.text);
  } catch {
    throw new UserFacingError(`${provider} sent an answer that could not be read. Try again in a minute.`, 'parse');
  }
}

/** The HTTP status buried in an http.js UserFacingError (its STATUS_HINTS name the code), or 0. */
function statusOf(err) {
  if (!err || err.code !== 'upstream-status') return 0;
  const m = /\b([45]\d\d)\b/.exec(err.userMessage || err.message || '');
  return m ? Number(m[1]) : 0;
}

const sleepReal = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

// ─── config helpers ──────────────────────────────────────────────────────────────

/** "Coffee, Cakes" or ['Coffee','Cakes'] → trimmed, de-duplicated names (≤ MAX_LIST). */
function nameList(v) {
  const raw = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,\n]/);
  const out = [];
  const seen = new Set();
  for (const x of raw) {
    const s = String(x == null ? '' : x).trim().slice(0, 120);
    const k = s.toLowerCase();
    if (s && !seen.has(k)) { seen.add(k); out.push(s); }
  }
  return out.slice(0, MAX_LIST);
}

/** The checks every POS config shares. Returns a message or null. */
function validateCommon(c) {
  for (const k of ['include_sections', 'exclude_sections']) {
    if (c[k] == null || c[k] === '') continue;
    if (!Array.isArray(c[k]) && typeof c[k] !== 'string') return 'Category lists must be text';
    const raw = Array.isArray(c[k]) ? c[k] : String(c[k]).split(/[,\n]/);
    if (raw.length > MAX_LIST) return `Up to ${MAX_LIST} categories can be listed`;
  }
  if (c.variations != null && c.variations !== '' && !VARIATION_MODES.has(c.variations)) return 'Unknown way to show sizes';
  if (c.price_format != null && c.price_format !== '' && !PRICE_FORMATS.has(c.price_format)) return 'Unknown price format';
  if (c.locale) {
    if (!LOCALE_RE.test(String(c.locale))) return 'The number format must look like en-US or de-DE';
    try { if (!Intl.NumberFormat.supportedLocalesOf([String(c.locale)]).length) return 'That number format is not supported'; } catch { return 'The number format must look like en-US or de-DE'; }
  }
  if (c.max_rows != null && c.max_rows !== '' && !(parseInt(c.max_rows, 10) >= 1)) return 'Items to import must be a positive number';
  if (c.key_column && String(c.key_column).length > 80) return 'The key column name is too long';
  return null;
}

// ─── money ───────────────────────────────────────────────────────────────────────

/** How many minor units the currency has (USD 2, JPY 0, KWD 3) — Square amounts are in minor units. */
function currencyDigits(currency) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}

/**
 * A price for the screen. `major` is the amount in the currency's main unit (3.5 for $3.50).
 * format 'currency' → "$3.50" / "3,50 €" in the store's locale; 'number' → "3.50", which the menu
 * board then formats with its own currency setting (the board accepts "3.50" and "3,50" only).
 */
function formatMoney(major, currency, { locale = 'en-US', format = 'currency' } = {}) {
  if (major == null || major === '' || !Number.isFinite(Number(major))) return '';
  const n = Number(major);
  const code = /^[A-Z]{3}$/.test(String(currency || '')) ? String(currency) : '';
  const digits = code ? currencyDigits(code) : 2;
  if (format === 'number' || !code) return n.toFixed(digits);
  try {
    return new Intl.NumberFormat(locale || 'en-US', { style: 'currency', currency: code, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
  } catch {
    return `${n.toFixed(digits)} ${code}`;
  }
}

/** Minor units (Square's Money.amount: 350 for $3.50) → main unit. */
function fromMinor(amount, currency) {
  const a = Number(amount);
  if (!Number.isFinite(a)) return null;
  return a / 10 ** currencyDigits(currency);
}

// ─── text ────────────────────────────────────────────────────────────────────────

const clean = (v, n) => String(v == null ? '' : v).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
/** Only an https image: the menu board would accept http too, but a store CDN is always https. */
const httpsUrl = (u) => (/^https:\/\/[^\s"'<>]{1,1500}$/.test(String(u || '')) ? String(u) : '');
const dietaryTags = (tags) => (Array.isArray(tags) ? tags : [])
  .map((t) => String(t || '').trim().toLowerCase()).filter((t) => DIETARY_TAGS.has(t)).slice(0, 8);

// ─── items → rows ────────────────────────────────────────────────────────────────

/**
 * Pick each item's section (the first of its sections that survives the filters), drop what is
 * filtered out, order, and build the table.
 * opts: include_sections, exclude_sections, hide_sold_out, variations, max_rows, key_column, now
 */
function buildMenuTable(items, c = {}, ctx = {}) {
  const include = nameList(c.include_sections).map((s) => s.toLowerCase());
  const exclude = new Set(nameList(c.exclude_sections).map((s) => s.toLowerCase()));
  const mode = VARIATION_MODES.has(c.variations) ? c.variations : 'columns';

  const placed = [];
  for (const it of items || []) {
    if (!it || !it.name) continue;
    const secs = (it.sections && it.sections.length ? it.sections : [{ name: 'Menu', rank: 0 }])
      .filter((s) => s && s.name && !exclude.has(s.name.toLowerCase()));
    if (!secs.length) continue;   // every category it is in was excluded
    let sec = secs[0];
    let sectionRank = sec.rank || 0;
    if (include.length) {
      let best = null;
      for (const s of secs) {
        const i = include.indexOf(s.name.toLowerCase());
        if (i >= 0 && (best === null || i < best.i)) best = { s, i };
      }
      if (!best) continue;
      sec = best.s;
      sectionRank = best.i;
    }
    let vars = (it.variations || []).filter(Boolean);
    if (!vars.length) continue;
    if (mode === 'first') vars = vars.slice(0, 1);
    const units = mode === 'rows'
      ? vars.map((v) => ({ name: vars.length > 1 && v.name ? `${it.name} (${v.name})` : it.name, vars: [v] }))
      : [{ name: it.name, vars: vars.slice(0, MAX_PRICE_COLUMNS) }];
    units.forEach((u, subRank) => {
      const soldOut = u.vars.every((v) => v.sold_out);
      if (soldOut && c.hide_sold_out) return;
      placed.push({
        subRank,
        section: sec.name, sectionRank, itemRank: Number.isFinite(sec.itemRank) ? sec.itemRank : (Number.isFinite(it.rank) ? it.rank : Infinity),
        name: clean(u.name, 160), description: clean(it.description, 400), image: httpsUrl(it.image),
        tags: dietaryTags(it.tags), prices: u.vars.map((v) => v.price || ''),
        sizes: u.vars.length > 1 ? u.vars.map((v) => clean(v.name, 30)).join(' / ') : '',
        sold_out: soldOut,
      });
    });
  }
  // Sections in the order asked for (the include list, or the provider's), then by name; items
  // by the provider's position, then by name. Stable for equal keys, so a sync that changed
  // nothing yields the same table and does not bump a single widget.
  placed.sort((a, b) => (a.sectionRank - b.sectionRank)
    || a.section.localeCompare(b.section)
    || ((a.itemRank === b.itemRank) ? 0 : (a.itemRank === Infinity ? 1 : b.itemRank === Infinity ? -1 : a.itemRank - b.itemRank))
    || a.name.replace(/ \(.*\)$/, '').localeCompare(b.name.replace(/ \(.*\)$/, ''))
    || (a.subRank - b.subRank)
    || a.name.localeCompare(b.name));

  const nPrices = Math.min(MAX_PRICE_COLUMNS, placed.reduce((n, p) => Math.max(n, p.prices.length), 1));
  const header = ['Section', 'Item', 'Price'];
  for (let i = 2; i <= nPrices; i++) header.push(`Price ${i}`);
  const hasSizes = placed.some((p) => p.sizes);
  if (hasSizes) header.push('Sizes');
  header.push('Description', 'Tags', 'Sold out', 'Image');
  const rows = placed.map((p) => {
    const r = [p.section, p.name];
    for (let i = 0; i < nPrices; i++) r.push(p.prices[i] || '');
    if (hasSizes) r.push(p.sizes);
    r.push(p.description, p.tags.join(', '), p.sold_out ? 'yes' : '', p.image);
    return r;
  });
  const table = tab.rowsToTable([header, ...rows], { headerRow: true });
  // rowsToTable drops all-empty rows; a header alone is still a table (an empty catalogue).
  const data = tab.flattenTable(table, { keyColumn: c.key_column, maxRows: c.max_rows, now: ctx.now });
  return { data, table: { columns: table.columns, sample: table.records.slice(0, 10) } };
}

module.exports = {
  MAX_PRICE_COLUMNS, DIETARY_TAGS,
  _setTransportForTests, transportFor, fetchJson, statusOf, sleepReal,
  nameList, validateCommon, currencyDigits, formatMoney, fromMinor, clean, httpsUrl, buildMenuTable,
};
