# Make a sign

**Make a sign** puts a professional-looking sign on a screen in about a minute, with no photos and
no design work: pick a ready-made design, type your words, choose screens. It ships with 14 built-in
designs that work offline on every install, including a fresh self-hosted one with the template
catalog switched off.

Every sign is an ordinary **slide deck**, so it plays on every player that plays slides, and stays
editable in **Advanced → Slides**.

## For everyone

### Making a sign

1. On the Simple home page, tap **Make a sign**. (In Advanced view: **Slides → New from template**.)
2. **Pick a design.** Each card is a live preview of the real sign. Use **Landscape / Portrait** at
   the top for screens mounted on their side.
3. **Fill it in.** Change any text; the preview updates as you type. Lists (menu items, opening
   hours, room details) have **Add a line** and **×** buttons. **More options** holds the colours,
   your logo on/off, and a few labels most people never need to touch.
4. **Choose screens.** Tick the screens that should show it and choose **Add to what it shows now**
   or **Replace what it shows now**. Untick them all to just save the sign.
5. Done. It says **It's live!** — or **Sent for review** if your workspace reviews changes before
   they go on screens. In that case nothing is shown until a reviewer approves it.

### The designs

| Design | Typical use | Fields |
|---|---|---|
| Today's specials | menu board, daily specials | business name, headline, line under it, up to 6 items with prices |
| Sale or offer | promotion | big number or word ("20%"), headline, details, button text |
| Opening hours | front door | headline, up to 7 day/hours lines, small print (values without digits such as "Closed" are highlighted) |
| Welcome | entrance, reception | business name, headline, message, extra info (e.g. Wi‑Fi name) |
| Event or live music | what's on | when, headline, details |
| Announcement | notices | label, headline, text (up to 5 lines), footer |
| Now hiring | recruitment | headline, jobs (one per line), how to apply, optional link (shown as a QR code) |
| Holiday closure | closures | headline, dates, message, when you reopen |
| Wi‑Fi | guest network | headline, network name, password, security; a QR code phones can scan to join |
| Safety notice | workplaces | band text, headline, instructions |
| Birthday or celebration | staff, events | greeting, name, message |
| Countdown | openings, launches | headline, date and time, message when the time comes, subtitle — counts down live on the screen |
| Room or reception | meeting rooms | small heading, room name, subtitle, up to 4 detail lines, optional clock |
| Scan a QR code | link to a menu, a form, a website | headline, message, link, link text |

Every design is laid out for **1920×1080 landscape** and **1080×1920 portrait**. Long text is
measured with the real fonts and shrunk to fit, so a long headline pushes the lines below it down
instead of running into them.

### Your brand (brand kit)

Set your business name, logo, colours and headline font once and every new sign starts with them.

* Simple view: account menu → **Your brand**, or the **Set up your brand** / **Edit brand** link on
  the Make a sign pages.
* Advanced view: **Settings → Brand kit**.

| Setting | What it does |
|---|---|
| Business name | Pre-fills the business line on designs that have one |
| Logo | Shown in a corner of every design (switch it off per sign under More options). A PNG with a transparent background looks best |
| Colours | **Background**, **Accent** and **Extra** (used for decorations, e.g. confetti). Any colour can be left unset; the design's own colour is used for that slot |
| Headline font | One of the fonts slides already ship with (Inter, Archivo, Oswald, Bitter, JetBrains Mono) |

Text colour is never chosen by you: it is whichever of white or near-black reads better on the
background (pure black when near-black is not enough), and an accent that would be hard to read is
made lighter or darker — same colour family — until it meets WCAG AA (4.5:1). A sign can be
off-brand; it cannot be unreadable. If a colour you picked had to be adjusted, the fill step says so
and offers the adjusted colour (see [Accessibility](accessibility.md)).

Changing the brand kit affects signs you make **afterwards**. Signs already on screens keep their
look; to restyle one, make it again (or edit it in Slides).

### Changing a sign later

* Make it again from **Make a sign**, or
* **Advanced → Slides**: the sign is a deck named after its headline. Edit it like any deck and press
  **Publish**; every screen showing the sign updates, because the deck updates the same slide the
  screens play.

### First run

In the setup guide, the **Choose what it shows** step offers **Make a sign** next to **Use a sample
image**. It opens Make a sign with the screen you just paired already chosen, so the first thing on
the screen is a real sign.

## For admins

### Permissions

| Action | Who |
|---|---|
| See designs, previews and the brand kit | every workspace member |
| Make a sign, change the brand kit | workspace editors and admins (a view-only member is refused by the server and Simple view does not offer the task) |

Everything is scoped to the **current workspace**: each workspace has its own brand kit, and a logo
must be an image in that workspace's own library.

### What a sign creates

Making a sign writes, in the current workspace:

* a **slide deck** (the editable source, listed in Slides), and
* the deck's **slide widget**.

It does **not** publish anything. The dashboard then adds the widget to each chosen screen's
playlist and publishes that playlist through the normal endpoint, so the **release policy, review,
plan limits and head-office locks all apply** exactly as for any other change. In a workspace that
requires review, the change is submitted for review (`POST /api/approvals/submit`) and the person is
told so.

No playlist is created for the deck itself until somebody publishes it from Slides.

### API (dashboard session only; not on the API-token door)

| Method & path | Purpose |
|---|---|
| `GET /api/signs/templates` | the designs, their fields, and this workspace's brand kit |
| `POST /api/signs/preview` | `{template, aspect, values}` → `{html, errors}`; or `{items:[…]}` → `{previews}` |
| `POST /api/signs` | `{template, aspect, values, name?}` → `{deck_id, widget_id, name, dwell_sec}` (400 with `errors[]` naming the field) |
| `GET /api/brand-kit` | `{kit, logo_url, can_edit, fonts}` |
| `PUT /api/brand-kit` | `{business_name?, logo_content_id?, colors?, font?}`; absent fields are kept |

`aspect` is `16:9` or `9:16`. Field types: `text`, `multiline`, `rows` (`[{label, value}]`),
`datetime` (an ISO instant or epoch ms), `color` (`#RGB`/`#RRGGBB`), `toggle`, `select`, `url`.
Previews are rate-limited to 120 per minute.

### Security notes

* Every field is user text. It is stored only in the slide's field record and escaped by the slide
  renderer at the one place it meets HTML; layout values are numbers and allowlisted hex colours.
  Tests push markup through every field of every design, in previews and in the published widget.
* Previews are shown in an iframe with an **empty sandbox** (no script, no same-origin) and carry no
  script at all.
* Colours outside `#RGB`/`#RRGGBB`, unknown fonts, unknown templates, over-long text and a logo from
  another workspace (or a non-image) are refused.
* Brand kit changes and sign creation are written to the audit log (`brand_kit:update`,
  `sign:create`).

### Database

One additive table, `brand_kits` (one row per workspace, created on first save). Nothing else in the
schema changes; signs are ordinary `slide_decks` and `widgets` rows.

### Adding or changing a design (developers)

Designs live in `server/lib/sign-templates.js`: each has field specs and a `build(stage, values)`
that places elements in stage units (1 unit = 1cqw). Sample text is translated in
`frontend/js/i18n/en.js` under `signs.sample.*`, names under `signs.tpl.*`. Text measurement uses the
glyph widths in `server/lib/sign-font-metrics.js`; regenerate that file if a bundled font changes.
`test/sign-templates.test.js` checks every design in both shapes, the escaping, and that every
computed i18n key exists.
