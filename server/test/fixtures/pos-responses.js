'use strict';

/*
 * Square and Shopify responses shaped like the examples in their official API references
 * (Square: ListLocations, ListCatalog with CatalogItem / CatalogItemVariation /
 * ItemVariationLocationOverrides / CatalogCategory / CatalogImage; Shopify GraphQL Admin API:
 * products / collectionByIdentifier connections with pageInfo, Money-scalar variant prices and the
 * extensions.cost block). Field names and nesting are the providers'; the values are a café's.
 * Functions, so every test gets a fresh copy to mutate.
 */

const SQ_MAIN = 'L88917AVBK2S5';
const SQ_AIRPORT = 'LQYQJ0QEXAMPLE';
const CAT_COFFEE = '5ZYQZZ2IECPVJ2IJ5KQPRDC3';
const CAT_BAKERY = 'CBN6Q7ADXJ4TRQSCWAYIMKTG';
const CAT_RETAIL = 'RETAILCATEGORY0000000001';

const squareLocations = () => ({
  locations: [
    {
      id: SQ_MAIN, name: 'Corner Café — Main St',
      address: { address_line_1: '123 Main St', locality: 'Chicago', administrative_district_level_1: 'IL', postal_code: '60601', country: 'US' },
      timezone: 'America/Chicago', capabilities: ['CREDIT_CARD_PROCESSING', 'AUTOMATIC_TRANSFERS'], status: 'ACTIVE',
      created_at: '2024-03-01T18:22:41.000Z', merchant_id: 'MLCB5Z8XW0ZRJ', country: 'US', language_code: 'en-US',
      currency: 'USD', business_name: 'Corner Café', type: 'PHYSICAL', mcc: '5814',
    },
    {
      id: SQ_AIRPORT, name: 'Corner Café — Airport', timezone: 'America/Chicago', capabilities: ['CREDIT_CARD_PROCESSING'],
      status: 'ACTIVE', created_at: '2025-01-10T10:00:00.000Z', merchant_id: 'MLCB5Z8XW0ZRJ', country: 'US',
      language_code: 'en-US', currency: 'USD', business_name: 'Corner Café', type: 'PHYSICAL',
    },
    { id: 'LCLOSED00001', name: 'Old kiosk', status: 'INACTIVE', country: 'US', language_code: 'en-US', currency: 'USD', type: 'PHYSICAL' },
  ],
});

const meta = { updated_at: '2026-05-01T12:00:00.000Z', version: 1714564800000, is_deleted: false };
const variation = (id, itemId, name, amount, extra = {}) => ({
  type: 'ITEM_VARIATION', id, ...meta, present_at_all_locations: true,
  item_variation_data: {
    item_id: itemId, name, pricing_type: 'FIXED_PRICING', price_money: { amount, currency: 'USD' }, sellable: true, stockable: true, ...extra,
  },
});

const squareCatalogPage1 = () => ({
  objects: [
    { type: 'CATEGORY', id: CAT_COFFEE, ...meta, present_at_all_locations: true, category_data: { name: 'Coffee', category_type: 'REGULAR_CATEGORY', is_top_level: true } },
    { type: 'CATEGORY', id: CAT_BAKERY, ...meta, present_at_all_locations: true, category_data: { name: 'Bakery', category_type: 'REGULAR_CATEGORY', is_top_level: true } },
    { type: 'CATEGORY', id: CAT_RETAIL, ...meta, present_at_all_locations: true, category_data: { name: 'Retail', category_type: 'REGULAR_CATEGORY', is_top_level: true } },
    {
      type: 'IMAGE', id: 'WQLKN5FKCQS3BTUZHRCMP3WP', ...meta, present_at_all_locations: true,
      image_data: { name: 'latte.jpg', url: 'https://items-images-production.s3.us-west-2.amazonaws.com/files/latte/original.jpeg', caption: 'Latte' },
    },
    {
      type: 'ITEM', id: 'W62UWFY35CWMYGVWK6TWJDNI', ...meta, present_at_all_locations: true,
      item_data: {
        name: 'Latte',
        description_html: '<p>Double shot, <b>steamed</b> milk</p>',
        description_plaintext: 'Double shot, steamed milk',
        is_taxable: true,
        categories: [{ id: CAT_COFFEE, ordinal: 2 }],
        reporting_category: { id: CAT_COFFEE, ordinal: 2 },
        image_ids: ['WQLKN5FKCQS3BTUZHRCMP3WP'],
        product_type: 'FOOD_AND_BEV',
        variations: [
          variation('2TZFAOHWGG7PAK2QEXWYPZSP', 'W62UWFY35CWMYGVWK6TWJDNI', 'Large', 450, { ordinal: 2 }),
          variation('AII6GTZT7FDVNL4IIKOZTESP', 'W62UWFY35CWMYGVWK6TWJDNI', 'Small', 350, {
            ordinal: 1,
            location_overrides: [{ location_id: SQ_AIRPORT, price_money: { amount: 425, currency: 'USD' } }],
          }),
        ],
      },
    },
    {
      type: 'ITEM', id: 'LJ5F3DKUJ5N2YQIEPNWPD4QS', ...meta, present_at_all_locations: true,
      item_data: {
        name: 'Espresso', description: 'Legacy plain description', category_id: CAT_COFFEE, product_type: 'FOOD_AND_BEV',
        variations: [variation('ESPRESSOVARIATION0000001', 'LJ5F3DKUJ5N2YQIEPNWPD4QS', 'Regular', 280, { ordinal: 0 })],
      },
    },
  ],
  cursor: 'CAASGgoSMTIzNDU2Nzg5MDEyMzQ1Njc4EAEaBAgCEAE',
});

const squareCatalogPage2 = () => ({
  objects: [
    {
      type: 'ITEM', id: 'CROISSANT000000000000001', ...meta, present_at_all_locations: true,
      item_data: {
        name: 'Butter croissant', description_plaintext: 'Baked every morning', categories: [{ id: CAT_BAKERY, ordinal: 1 }], product_type: 'FOOD_AND_BEV',
        variations: [variation('CROISSANTVAR000000000001', 'CROISSANT000000000000001', 'Regular', 325, {
          ordinal: 0, location_overrides: [{ location_id: SQ_MAIN, track_inventory: true, sold_out: true }],
        })],
      },
    },
    {
      type: 'ITEM', id: 'MUFFIN000000000000000001', ...meta, present_at_all_locations: true,
      item_data: {
        name: 'Blueberry muffin', categories: [{ id: CAT_BAKERY, ordinal: 0 }],
        // Marked sold out "until" a time that has passed: available again.
        variations: [variation('MUFFINVAR000000000000001', 'MUFFIN000000000000000001', 'Regular', 300, {
          location_overrides: [{ location_id: SQ_MAIN, sold_out: true, sold_out_valid_until: '2026-01-01T00:00:00Z' }],
        })],
      },
    },
    {
      type: 'ITEM', id: 'AIRPORTONLY0000000000001', ...meta, present_at_all_locations: false, present_at_location_ids: [SQ_AIRPORT],
      item_data: {
        name: 'Travel mug', categories: [{ id: CAT_RETAIL, ordinal: 0 }],
        variations: [{ ...variation('MUGVAR000000000000000001', 'AIRPORTONLY0000000000001', 'Regular', 1800), present_at_all_locations: false, present_at_location_ids: [SQ_AIRPORT] }],
      },
    },
    {
      type: 'ITEM', id: 'ARCHIVED0000000000000001', ...meta, present_at_all_locations: true,
      item_data: { name: 'Pumpkin spice latte', is_archived: true, categories: [{ id: CAT_COFFEE }], variations: [variation('PSLVAR00000000000000001', 'ARCHIVED0000000000000001', 'Regular', 550)] },
    },
    {
      type: 'ITEM', id: 'DELETED00000000000000001', ...meta, is_deleted: true, present_at_all_locations: true,
      item_data: { name: 'Deleted scone', categories: [{ id: CAT_BAKERY }], variations: [variation('SCONEVAR000000000000001', 'DELETED00000000000000001', 'Regular', 250)] },
    },
    {
      type: 'ITEM', id: 'MARKETPRICE0000000000001', ...meta, present_at_all_locations: true, absent_at_location_ids: [SQ_AIRPORT],
      item_data: {
        name: 'Cake of the day', categories: [{ id: CAT_BAKERY, ordinal: 5 }],
        variations: [{ type: 'ITEM_VARIATION', id: 'CAKEVAR00000000000000001', ...meta, present_at_all_locations: true, item_variation_data: { name: 'Slice', pricing_type: 'VARIABLE_PRICING', sellable: true } }],
      },
    },
  ],
});

const cost = (requested, available) => ({
  cost: { requestedQueryCost: requested, actualQueryCost: 40, throttleStatus: { maximumAvailable: 2000.0, currentlyAvailable: available, restoreRate: 100.0 } },
});
const head = (scopes = ['read_products']) => ({
  shop: { name: 'Corner Café Berlin', currencyCode: 'EUR' },
  currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) },
  collections: { nodes: [{ handle: 'hot-drinks', title: 'Hot drinks' }, { handle: 'pastries', title: 'Pastries' }, { handle: 'frontpage', title: 'Home page' }] },
});
const product = (n, title, type, variants, extra = {}) => ({
  id: `gid://shopify/Product/80246522017${n}`, title, status: 'ACTIVE', productType: type, tags: [], description: '', featuredMedia: null,
  variants: { nodes: variants.map(([t, price, availableForSale], i) => ({ title: t, price, availableForSale, position: i + 1 })) },
  ...extra,
});

const shopifyProductsPage1 = (scopes) => ({
  data: {
    ...head(scopes),
    products: {
      pageInfo: { hasNextPage: true, endCursor: 'eyJsYXN0X2lkIjo4MDI0NjUyMjAxNzg1LCJsYXN0X3ZhbHVlIjoiRmxhdCB3aGl0ZSJ9' },
      nodes: [
        product(85, 'Flat white', 'Coffee', [['Regular', '3.60', true], ['Large', '4.20', false]], {
          tags: ['vegan', 'homepage', 'summer-sale'], description: 'Ristretto with velvety oat milk',
          featuredMedia: { preview: { image: { url: 'https://cdn.shopify.com/s/files/1/0712/3456/files/flat-white.jpg?v=1714564800' } } },
        }),
        product(86, 'Cinnamon bun', 'Bakery', [['Default Title', '2.90', false]], { tags: ['v'] }),
      ],
    },
  },
  extensions: cost(312, 1953),
});

const shopifyProductsPage2 = () => ({
  data: {
    products: {
      pageInfo: { hasNextPage: false, endCursor: 'eyJsYXN0X2lkIjo4MDI0NjUyMjAxNzg5fQ' },
      nodes: [
        product(87, 'Winter blend beans', 'Coffee', [['Default Title', '14.00', true]], { status: 'DRAFT', description: 'Not launched yet' }),
        product(88, 'Americano', 'Coffee', [['Default Title', '2.80', true]], {
          tags: ['GF'], featuredMedia: { preview: { image: { url: 'http://insecure.example/a.jpg' } } },
        }),
      ],
    },
  },
  // Only 100 points left of a 212-point query: the next call must wait ~1.1 s.
  extensions: cost(212, 100),
});

const shopifyCollection = (title, nodes, { first = false, hasNextPage = false, endCursor = null } = {}) => ({
  data: {
    ...(first ? head() : {}),
    collectionByIdentifier: title == null ? null : { title, products: { pageInfo: { hasNextPage, endCursor }, nodes } },
  },
  extensions: cost(300, 1900),
});

module.exports = {
  SQ_MAIN, SQ_AIRPORT, squareLocations, squareCatalogPage1, squareCatalogPage2,
  shopifyProductsPage1, shopifyProductsPage2, shopifyCollection, product,
};
