# Menus from your till: Square and Shopify

Connect your **Square** item library or your **Shopify** store, and a menu board or price display
uses it as its menu. When you change a price, add an item or mark something sold out, the screens
pick it up on the next sync. That's every 5 minutes by default, or straight away when you press
**Sync now**.

This is set up under **Advanced → Data sources** (two new types, *Square* and *Shopify*). There's
also a shortcut in the menu board editor. You need to be a workspace editor or admin. People with
view-only access can see the menu data but not the credentials, and they can't change anything.

- [What ends up on the screen](#what-ends-up-on-the-screen)
- [Square: step by step](#square-step-by-step)
- [Shopify: step by step](#shopify-step-by-step)
- [Put it on a menu board](#put-it-on-a-menu-board)
- [Options](#options)
- [How often it updates](#how-often-it-updates)
- [Security](#security)
- [For administrators and self-hosters](#for-administrators-and-self-hosters)
- [Why not Toast, Clover or Lightspeed?](#why-not-toast-clover-or-lightspeed)
- [Troubleshooting](#troubleshooting)

---

## What ends up on the screen

Your catalogue becomes a table with one row per item. A Google Sheet menu produces the same kind
of table, so the menu board needs nothing special for it:

| Column | Square | Shopify |
|---|---|---|
| **Section** | the item's category | the collection, or else the product type |
| **Item** | item name | product title |
| **Price**, Price 2 … Price 4 | variation prices, in the location's currency | variant prices, in the store currency |
| **Sizes** | variation names, e.g. `Small / Large` | variant names (Shopify's `Default Title` counts as no size) |
| **Description** | the item description, as plain text | the product description, as plain text (first 400 characters) |
| **Tags** | — | dietary tags only: `v`, `vg`, `gf`, `df`, `n`, `h`, `spicy`, `new`, `popular`, `vegan`, `vegetarian`, `gluten-free`, `dairy-free`, `nuts`, `halal`, `hot` |
| **Sold out** | `yes` when the item is marked sold out at the chosen location | `yes` when no variant is available for sale |
| **Image** | the item's first image | the product's featured image (https only) |

Prices are formatted for the store, for example `$3.50`, `3,50 €` or `￥450`. If an item has
several sizes it counts as sold out only when every size is. Some things are always left out:

- Square: archived and deleted items, variations that can't be sold, and items not sold at the
  chosen location
- Shopify: draft and archived products

On a slide you can also use the values directly, e.g. `{{ds:cafe.row1_item}}` and
`{{ds:cafe.row1_price}}`. The data source's **Variables** drawer lists them all.

---

## Square: step by step

You'll need a Square account and about five minutes.

1. Go to **[developer.squareup.com](https://developer.squareup.com)** and sign in with your normal
   Square account. Choose **Create an application** and give it any name, e.g. *Screens*. Creating
   an application is free, and nothing changes in your shop.
2. Open the application. At the top, switch from **Sandbox** to **Production**, then open
   **Credentials** and copy the **Production access token**. It starts with `EAAA`.
3. In ScreenTinker, go to **Data sources → Connect data → Square**. Give it a name, e.g. *Café
   menu*, paste the token and press **Test & preview**. You'll see the first rows of your menu.
4. If you have more than one shop, pick its **Location** from the list that appears after the
   test. Each location has its own prices, items and sold-out marks. With only one location,
   that location is used automatically.
5. Press **Save & connect**.

> **About the token.** Square personal access tokens can't be limited to "read only". The token can
> do anything in your Square account. ScreenTinker only uses it to *read* two things, your item
> library and your list of locations. Every request it makes is a read (`GET`), and only to
> Square's own address. The token is stored encrypted and never shown again, and you can replace or
> revoke it at any time in the Developer Dashboard, under the application's **Credentials**. Don't paste it anywhere else.
>
> If you'd rather try it out first, choose **Sandbox (test account)** and use the Sandbox token
> from the same page.

**Sold out on Square.** On the POS, use *Mark as sold out* on an item, or let inventory tracking
mark it. This works per location, so choose a location (step 4) for sold-out marks to show. A
sold-out mark that expires ("sold out until tomorrow") stops counting once that time has passed.

---

## Shopify: step by step

You need the store's **.myshopify.com** address. It's under **Settings → Domains** in your Shopify
admin, e.g. `my-cafe.myshopify.com`. Pasting the admin address
(`admin.shopify.com/store/my-cafe`) works too. Your own domain (`shop.example.com`) does not.

The only permission ScreenTinker needs is **`read_products`**. It covers products, their prices,
images and availability, and collections. **Don't grant anything else.** ScreenTinker refuses
credentials that can change the store (any `write_…` permission), so a screen never holds a key
that could change your prices.

Shopify changed how stores get API access on 1 January 2026, so there are two ways in:

### A. You already have a custom app (Admin API access token)

1. In the Shopify admin, open **Settings → Apps and sales channels → Develop apps** and open your
   app. If it's new, create it and, under **Configuration → Admin API integration**, select only
   **`read_products`**, then **Install app**.
2. Under **API credentials**, reveal and copy the **Admin API access token**. It starts with
   `shpat_`. Shopify only shows it once.
3. In ScreenTinker, go to **Data sources → Connect data → Shopify**, enter the store address,
   choose **Admin API access token**, paste it and press **Test & preview**.

### B. A Dev Dashboard app (client ID and secret)

Stores that can no longer create custom apps in the admin use an app from the Shopify **Dev
Dashboard**:

1. Go to **[dev.shopify.com](https://dev.shopify.com)**, create an app, and give it the
   **`read_products`** scope only.
2. Install the app on your store.
3. Copy the app's **Client ID** and **Client secret**.
4. In ScreenTinker, choose **Client ID and secret**, paste both and press **Test & preview**.

With option B, ScreenTinker swaps the ID and secret for an access token using Shopify's
*client credentials* grant. That token lasts 24 hours and is renewed automatically.

**Which products?** By default you get every active product, grouped by **product type**. You can
narrow it down:

- **Collections**: list collection handles, e.g. `hot-drinks, pastries`. Each collection becomes
  a section, in the order you list them, with its products in the collection's own order. The
  handle is the last part of the collection's address, and the test shows your store's
  collections as suggestions.
- **Only products tagged**: tag the products that belong on the screen, e.g. `menu`, and enter
  that tag.

**Sold out on Shopify** means Shopify's own "available for sale" is off: the product's inventory is
tracked, nothing is in stock, and "continue selling when out of stock" is off.

---

## Put it on a menu board

The fastest way: **Widgets → New → Menu board**. Under *Items come from*, press **Menu from
Square** or **Menu from Shopify**. The connect form opens, and once you save it, the board uses it.

Or connect the data source first, then pick it under *Items come from*.

On the menu board:

- **Sold-out items**: *show as sold out* strikes the item through and shows a red "Sold out" in
  place of the price. *Hide* leaves it off the screen. To leave sold-out items out of the data
  altogether, use the data source option instead.
- **Price columns**: when items have sizes side by side, enter the size names in the same order,
  e.g. `Small, Large`.
- **Currency** and **Decimals** aren't used for POS prices, which come already formatted. Set the
  data source's *Prices* option to *Number only* if you want the board to add its own currency.

---

## Options

All of these are under **Menu options** on the data source.

| Option | What it does |
|---|---|
| Only these categories | Comma-separated category names (Square), or collection titles / product types (Shopify). Sections appear in this order. An item in several categories appears under the first one listed. |
| Leave out these categories | E.g. `Retail, Gift cards`. An item that is also in a category you kept still shows there. |
| Sizes and variations | *Side by side*: up to four prices on one line. *One line each*: `Latte (Small)`, `Latte (Large)`. *First size only*. |
| Prices | *In the store's currency* (`$3.50`) or *Number only* (`3.50`). |
| Number format | Overrides the locale, e.g. `de-DE` gives `3,50 €`. Square uses the location's language by default, Shopify `en-US`. |
| Leave sold-out items out | Removes them from the data, so no board shows them. |
| Refresh | Every 5 minutes (default), 15 minutes or hourly. |
| Rows to import | At most 100 items reach the screen (the data-source limit for any table). Use the category filters for big catalogues. |

---

## How often it updates

- **Every 5 minutes** by default, and never more often than every 2 minutes, however it's
  configured. A sync reads the whole catalogue: Square page by page (at most 30
  pages), Shopify 25 products per request (at most 500 products).
- **Sync now** on the data source card fetches immediately. It shares the workspace's limit of 30
  manual syncs a minute with the other data sources.
- A screen re-renders only when something actually changed: a price, an item, a sold-out mark.
  Unchanged syncs cost the screens nothing.
- **Rate limits.** Shopify meters API use in query-cost points. ScreenTinker reads the remaining
  budget after every request and waits, for up to 10 seconds, when the next page wouldn't fit. If
  Shopify still answers *throttled*, it waits and retries once. Square doesn't publish its limits.
  A `429` there ends the sync with "rate-limiting", and the next sync tries again.
- **When something goes wrong** (Square or Shopify is down, a token was revoked), the screens keep
  showing the last good menu. The card shows the error, written so you can fix it, e.g. "Square
  did not accept the access token".

---

## Security

- **Credentials are encrypted at rest** with the same AES-256-GCM secret box as every other
  data-source credential. They're never sent back to the browser after you save them: the form
  shows them blank, and saving with the field left blank keeps the stored value. View-only
  members don't see the Shopify client ID either.
- **They never reach a log or the audit trail.** Error messages are built from fixed text and the
  provider's HTTP status only, never from a response body or header. Creating, editing and
  deleting a data source is recorded in the activity log by id, type and slug.
- **A stored credential only goes back where it came from.** If you edit a Shopify source to point
  at a different store, or a Square source at the other environment, the saved credential is
  dropped and you have to enter it again. *Test* on a saved source fills in the stored credential
  only for the same store, the same environment and the same type. This closes the "repoint it at
  my own server and collect the token" trick.
- **Fixed destinations (SSRF).** Square requests only go to `https://connect.squareup.com` or
  `https://connect.squareupsandbox.com`. Nothing in the configuration can change the host, and
  only `GET` is used. Shopify requests only go to `https://<name>.myshopify.com`. The address you
  type is reduced to that name and the URL is rebuilt from it, so custom domains, IP addresses,
  `user@host`, ports and lookalikes such as `x.myshopify.com.evil.example` are refused when you
  save. Requests never follow redirects. All of them still go through the server's SSRF guard
  (public addresses only, DNS pinned).
- **Read-only.** Shopify credentials with any write permission are refused on every sync (the
  installed app's scopes are checked each time). Square can't be scoped, see the note in the Square
  section. Square OAuth with `ITEMS_READ` and `MERCHANT_PROFILE_READ` only is the planned fix.
- **Tenancy.** A data source belongs to one workspace. Other workspaces and organizations get
  `404` for it and can't borrow its credential in a test.

---

## Using the same connection for Experiments (sales)

[Experiments](experiments.md) can judge a test by what sold. They reuse a Square or Shopify data
source from this page; no second credential is stored. Reading sales needs **one more read
permission**:

| Provider | Extra permission | What is read |
|---|---|---|
| Square | `ORDERS_READ` (a personal access token already has it) | `POST /v2/orders/search` — completed orders by location and closing time. `POST` because Square's order search takes its query as a body; it changes nothing. |
| Shopify | `read_orders` (add it to the app's scopes and reinstall) | GraphQL `orders` by processed time. Without `read_all_orders` Shopify returns only the last 60 days. Optional `read_locations` lets the Experiments page list your locations by name. |

Write permissions are still refused, for orders as for products. Every order is reduced, as it
arrives, to totals per location, hour and item; no customer, card, receipt or order id is read
into storage. The same encryption, same-store rule and fixed hosts described under **Security**
apply. See [docs/experiments.md](experiments.md).

---

## For administrators and self-hosters

- **Nothing to configure.** There's no ScreenTinker API key, no environment variable and no
  registered app. Each shop brings its own token, so this works the same self-hosted and hosted.
- **Outbound access.** The server must be able to reach `connect.squareup.com` (and
  `connect.squareupsandbox.com` for Sandbox) and `*.myshopify.com` on port 443. The requests go through the same SSRF guard as every
  other data source ([outbound-requests.md](outbound-requests.md)). These are public hosts, so no
  allow-list setting is needed.
- **API versions are pinned**, so a provider release can't change the response shapes:
  `Square-Version: 2026-09-16` (`SQUARE_VERSION` in `server/lib/data-sources/square-resolver.js`)
  and Shopify Admin API `2026-07` (`API_VERSION` in `shopify-resolver.js`). Shopify supports each
  version for at least 12 months. Move to a newer version before `2026-07` is retired (mid-2027),
  after reading the changelog, and run `server/test/pos-menus.test.js`.
- **Code**: `server/lib/data-sources/square-resolver.js`, `shopify-resolver.js`, `pos-common.js`
  (rows, money, filters), registered in `builtin-types.js`. The dashboard forms are in
  `frontend/js/views/data-sources.js`, and the shortcut is in
  `frontend/js/components/menu-board-editor.js`.
- **Tests**: `server/test/pos-menus.test.js` with response shapes in
  `server/test/fixtures/pos-responses.js`. The tests use a fake transport and never touch the
  network.

### Planned, not built

- **Square OAuth** (scoped `ITEMS_READ` + `MERCHANT_PROFILE_READ`, refresh tokens). This needs a
  registered ScreenTinker application and a redirect URL every self-hoster would have to own, so
  the personal access token comes first.
- **Webhooks** (`catalog.version.updated`, Shopify `products/update`) for updates within seconds
  instead of minutes. These need a public inbound endpoint and signature verification.
- **Stock counts.** Square's Inventory API and Shopify's `read_inventory` scope would allow "only
  3 left". Today, sold-out is the POS's own sold-out mark or availability.
- **Modifiers and add-ons** (Square modifier lists, Shopify options beyond variants).

---

## Why not Toast, Clover or Lightspeed?

We checked each one for API access that a restaurant can turn on **itself, without a partner
application**, and that can be limited to reading the menu:

| System | Verdict |
|---|---|
| **Toast** | Not added. Toast's *standard API access* is self-service and read-only (menus API v2, `GET` only), but it needs an RMS Essentials subscription or higher and an employee with *Manage Integrations*. Toast's API terms restrict the credentials to the restaurant's own permitted use, not a third-party product. An integration offered by a software vendor goes through Toast's partner program (application and certification). |
| **Clover** | Not added. Self-service tokens only work in the sandbox. Production access needs an OAuth app approved through Clover's developer program / App Market. |
| **Lightspeed Restaurant (K-Series)** | Not added. API access is only available after approval as a Lightspeed partner. |
| **Lightspeed Retail (X-Series)** | Open, but not added. Retailers on the Plus plan can create a personal token. The token can't be limited to read-only, and X-Series is a retail system, not a restaurant one. It's the best candidate if there's demand. |

Sources: Toast [standard API access requirements](https://doc.toasttab.com/doc/devguide/devApiAccessRequirements.html),
[overview](https://doc.toasttab.com/doc/devguide/devApiAccessUserGuide.html),
[API terms of use](https://pos.toasttab.com/api-terms-of-use); Clover
[test API tokens](https://docs.clover.com/docs/generate-a-test-api-token); Lightspeed X-Series
[authorization](https://x-series-api.lightspeedhq.com/docs/authorization); Shopify
[legacy custom apps (2026-01-01)](https://community.shopify.dev/t/starting-january-1-2026-you-will-not-be-able-to-create-new-legacy-custom-apps-this-will-not-impact-any-existing-apps/26798),
[client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant);
Square [access tokens](https://developer.squareup.com/docs/build-basics/access-tokens),
[ListCatalog](https://developer.squareup.com/reference/square/catalog-api/list-catalog).

---

## Troubleshooting

| Message | What to do |
|---|---|
| *Square did not accept the access token* | You may have copied the Sandbox token for a Production source, or the other way round. Square shows one of each. Or the token was replaced. |
| *That location is not in this Square account any more* | Test the connection and pick the location again. |
| Sold-out items never show as sold out (Square) | Choose a location. Sold-out marks are per location. |
| *There is no Shopify store at that address* | Use the `.myshopify.com` name from Settings → Domains, not your own domain. |
| *This app can change the store (write_products …)* | Make an app with only `read_products`, or remove the write scopes and reinstall. |
| *The app is missing the read_products permission* | Add `read_products` to the app's scopes and reinstall it. |
| *Shopify did not accept the client ID and secret* | Check both, and that the Dev Dashboard app is installed on this store. |
| *There is no collection with the handle "…"* | Use the handle (`hot-drinks`), not the title (`Hot drinks`). The test lists your collections. |
| *… is rate-limiting requests* | Nothing to do: the next sync tries again. Choose a longer refresh if it keeps happening. |
| Only the first 100 items appear | Use *Only these categories* / collections to show what this screen needs. |
