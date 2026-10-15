# Free stock photos and videos

Search free photos and videos from **Pexels** and **Pixabay** without leaving ScreenTinker, and add
the ones you pick to your content library. They become ordinary library items: they count toward
your storage, get thumbnails, go through approval if your workspace uses it, and screens download
and cache them like anything you upload.

- [Using it](#using-it)
- [Setting it up (operators and platform admins)](#setting-it-up)
- [How it works](#how-it-works)
- [Provider terms we follow](#provider-terms-we-follow)
- [Troubleshooting](#troubleshooting)

---

## Using it

### Simple view

Wherever Simple view asks you for photos there is a **Free photos** button:

- **Change what a screen shows**, under "Or pick from your photos and videos"
- **Upload photos**, under the drop area
- the setup guide's **upload** step

Press it, then type what you want (or tap a suggestion such as *Coffee*, *Food*, *Retail*, *Office*,
*Nature* or *Abstract backgrounds*). Tap the photos you want; a tick shows which are chosen, and they
play in the order you tapped them. Press **Show selected** (or **Add selected**) and the photos are
added to your library and put on the screen, exactly as if you had uploaded them.

Each result shows who took it ("Photo by Ana on Pexels"), and links to the photo's page.

### Advanced view

In **Content**, choose **Add content → Free stock photos and videos**. You can switch between
**Photos** and **Videos**, choose a provider if both are set up, and filter by orientation
(landscape or portrait, useful for portrait screens). Items go into the destination folder shown
at the bottom of the dialog.

The library's **Details** panel shows a **Credit** line for every item that came from a stock
provider.

### Who can use it

Anyone who can add content to the workspace. View-only members do not see it (and the server
refuses their searches and imports). If no provider is set up, the option is hidden; a platform
admin sees one line saying where to add a key instead.

### What size do I get?

- **Photos**: resized so the long edge is at most 1920 px (a full-HD screen in either orientation).
  Pixabay gives 1280 px unless your key has Pixabay's "full API access", in which case 1920 px.
- **Videos**: the largest MP4 whose long edge is at most 1920 px (HD), never the 4K original.
  Videos are also capped at 300 MB and at your instance's upload limit.

---

## Setting it up

You need a free API key from at least one provider:

- Pexels: <https://www.pexels.com/api/> (photos and videos)
- Pixabay: <https://pixabay.com/api/docs/> (photos and videos)

Then either:

- **Environment** (hosted ScreenTinker does this): set `PEXELS_API_KEY` and/or `PIXABAY_API_KEY`
  and restart.
- **Admin settings** (self-hosters): **Platform → System → Free stock photos**. Paste the key and
  press **Save**, then **Test**. The key is stored encrypted (`lib/secretbox.js`, derived from
  `JWT_SECRET`) and is never shown again. **Remove** turns that provider off.

A key in the environment wins over one saved in settings, and the settings page shows it as
"Set by PEXELS_API_KEY in the environment" with no way to change it there.

> Rotating `JWT_SECRET` makes a saved key unreadable (as it does every other stored secret). Enter
> it again afterwards.

Only platform admins can see or change keys. Saving and removing a key is recorded in the activity
log (`stock_media_key_saved`, `stock_media_key_removed`); each item added is recorded as
`stock_media_added` with the provider, item id and the new content id.

The server makes outbound HTTPS requests to `api.pexels.com`, `images.pexels.com`,
`videos.pexels.com` (and `player.vimeo.com` for older Pexels videos), `pixabay.com` and
`cdn.pixabay.com`. If your server sits behind an egress allowlist, allow those. All of them go
through the same SSRF guard as other outbound requests (see [outbound-requests.md](outbound-requests.md)).

---

## How it works

- **Keys never reach the browser.** The browser asks `GET /api/stock/search`; the server adds the
  key and asks the provider. Responses, error messages and log lines never contain a key (Pixabay
  takes its key in the query string, so request URLs are never logged at all). Provider error
  bodies are not passed on.
- **The browser cannot choose what is downloaded.** `POST /api/stock/import` takes only
  `{ provider, type, id, folder_id }`. The server looks the id up with the provider (or in its
  cache of the provider's own answers), picks the rendition, and downloads it only if it is HTTPS
  on that provider's media host. Every redirect hop is re-checked against private and metadata
  addresses.
- **The bytes decide what it is.** The download is sniffed like an upload (`lib/upload-sniff.js`)
  and must be a JPEG/PNG/WebP for a photo or a video for a video; anything else is discarded.
  Then it goes through the normal ingest (`lib/content-ingest.js`): thumbnail, dimensions,
  duration, storage backend, revision history.
- **Limits.** Plan storage (an import that would not fit is refused before anything is kept), the
  instance's `MAX_FILE_SIZE`, and a 300 MB cap per stock item.
- **Attribution is kept.** Each item records, in `content.attribution` (JSON), the provider, item
  id, title, photographer and their profile link, the item's page, and the licence name and link.
  Replacing the item's file later does not clear it; edit or delete the item if the credit no
  longer applies.
- **Caching and rate limits.** Search results are cached on the server (Pexels 15 minutes,
  Pixabay 24 hours) and shared between workspaces, since they are the provider's public catalogue.
  Each person may run 30 uncached searches a minute, each workspace 300 an hour; each person may
  add 60 items an hour, each workspace 150. `/api/stock` is also limited to 90 requests a minute
  per IP. When a provider says it is busy (HTTP 429) the picker says so and asks to try again.

### API

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| GET | `/api/stock/status` | signed in | `{ enabled, can_add, providers[], setup_hint }` |
| GET | `/api/stock/search?provider=&type=photo\|video&q=&page=&orientation=` | editors and up | proxied, cached |
| POST | `/api/stock/import` `{ provider, type, id, folder_id? }` | editors and up | returns the new content row (201) |
| GET / PUT | `/api/stock/settings` `{ provider, key }` | platform admins | keys are never returned; `key: ""` removes |
| POST | `/api/stock/settings/test` `{ provider }` | platform admins | one tiny search |

These are dashboard (JWT) routes; API tokens cannot reach them.

---

## Provider terms we follow

Read on 2026-10-14. If a provider changes its terms, this is the list to re-check.

### Pexels ([API documentation](https://www.pexels.com/api/documentation/), [licence](https://www.pexels.com/license/))

- *"Whenever you are doing an API request make sure to show a prominent link to Pexels."* The
  picker shows **Photos provided by Pexels** (or Videos) linking to pexels.com under the results.
- *"Always credit our photographers when possible (e.g. 'Photo by John Doe on Pexels' with a link
  to the photo page on Pexels)."* Every result shows "Photo by *name* on Pexels" linking to the
  photo's page; the credit is kept on the library item and shown in its details.
- *"You may not copy or replicate core functionality of Pexels (including making Pexels content
  available as a wallpaper app)."* ScreenTinker adds chosen items to a business's own signage
  library; it is not a browsing or wallpaper product.
- Rate limit: 200 requests an hour and 20,000 a month per key by default. Hence the cache and the
  per-person and per-workspace limits above. Pexels raises limits on request for apps that show
  attribution properly.
- Licence: free to use, attribution not required (we show it anyway, as the API guidelines ask).
  Not allowed: identifiable people shown in a bad light or implying endorsement, selling unaltered
  copies, using content as a trademark.
- Pexels does not forbid downloading; images are resized with the query parameters Pexels' own
  `src` URLs use.

### Pixabay ([API documentation](https://pixabay.com/api/docs/), [Content License](https://pixabay.com/service/license-summary/))

- *"To keep the Pixabay API fast for everyone, requests must be cached for 24 hours."* Search answers and item lookups are cached for 24 hours.
- *"Permanent hotlinking of images (using Pixabay URLs in your app) is not allowed. If you intend to use the images, please download
  them to your server first."* Items are downloaded into the library; only the search thumbnails in
  the picker load from Pixabay, which is how Pixabay expects results to be shown.
- *"Show your users where the images and videos are from, whenever search results are displayed."*
  The picker shows **Images from Pixabay** linking to pixabay.com, and each result names the
  contributor and links to the item's page.
- *"By default, you can make up to 100 requests per 60 seconds."*
- *"Videos may be embedded directly in your applications. Yet, we recommend storing them on your
  server."* We store them.
- `fullHDURL` needs Pixabay's "full API access"; without it the largest image is 1280 px.
- SafeSearch is always on for Pixabay searches.
- Licence: free for commercial use, attribution not required. Not allowed: selling or
  distributing content on a standalone basis, using depicted trademarks or recognisable people in
  a way that suggests endorsement.

### Why not Unsplash

Unsplash's API guidelines require apps to hotlink Unsplash's image URLs for display. Signage players
download and cache media so they keep playing offline, which that rule does not allow.

---

## Troubleshooting

- **I do not see "Free photos".** No provider key is set (ask whoever runs the server), you are a
  view-only member, or you are viewing a linked server's organization.
- **"Pexels refused this server's API key."** The key is wrong or was revoked. A platform admin can
  press **Test** in Platform → System.
- **"Pexels is busy right now."** The key's hourly quota is used up. Searches already made keep
  working from the cache; new ones work again when the hour rolls over.
- **"This item would exceed your storage allowance."** Delete something or move to a bigger plan.
- **"...returned a download address outside its own servers; it was not fetched."** The provider's
  answer pointed somewhere unexpected. Nothing was downloaded. If it keeps happening for one
  provider, report it: the media host list in `server/lib/stock-media.js` may need updating.
