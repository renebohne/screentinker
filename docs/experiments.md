# Experiments: test what's on screen against real results

**Experiments** show two to four versions of one thing on your screens — a sign, a menu panel, a
promo video — and tell you which one did better, in a sentence:

> **B sold 12% more of the item** (likely real: 95% interval 4% to 20%)

or, honestly, *"Not enough data yet. Needs about 9 more days."*

"Better" is measured against something that matters: **sales from Square or Shopify**, **QR code
scans**, **how many people looked** (audience counting), or **your own numbers** uploaded as a CSV
from any other till. What each screen *actually* played comes from proof of play.

Experiments are in the Advanced view under **Insights → Experiments**. There is deliberately no
Simple-view version: a fair test needs a playlist slot, a second version and a way to measure, which
is more than one question per screen can carry. Results are written so anyone can read them.

---

## For everyone

### Setting one up

1. **Insights → Experiments → New experiment.**
2. **What to test.** Choose a playlist and the item in it that the versions replace. The page says
   how many screens and locations play that playlist.
3. **Versions.** Version **A** starts as what plays now — the *control*, which the others are
   compared with. Add one to three more: an image or video, a **sign or slide deck** (signs made
   with *Make a sign* are here), or a widget. To compare QR scans, give each version its own
   tracked QR code (**QR codes** page) and put it on that version.
4. **How to split the screens.**
   - **By location** — each store shows one version for the whole test. Use this when you have
     several stores and sales are counted per store. Screens with the same *location* (set on each
     screen) are one store and always show the same version. You need at least one store per
     version; three or more per version for a verdict.
   - **By time of day** — every screen shows every version, taking turns every 1–4 hours. The turns
     rotate by weekday, so version A does not get every Monday morning. Use this for a single site.
5. **How to judge it.** Pick the main result and, optionally, one more to show:
   *units sold*, *sales revenue*, *orders*, *QR scans*, *people who looked*, *how long people
   looked*, or *your own numbers (CSV)*. For sales, choose the Square/Shopify connection and,
   optionally, **only these items** — names, SKUs or catalogue ids — to count just the promoted item.
6. **Save**, then on the experiment's page press **Start the test**. The playlist is published with
   the versions in it; the screens pick it up like any other change.

The playlist must have **no unpublished changes** when you start (publish or discard them first), or
starting the test would publish them too.

### While it runs

The experiment's page shows, live:

- the **verdict** for each version against A, with a bar showing the 95% interval around zero;
- a table per result: hours on screen, total, per hour on screen, per store per day, and the change
  compared with A;
- **checks**: a version that has not played yet, versions that did not get a fair share of every
  weekday, stores on each side that sold very differently before the test, stale or failed sales
  imports;
- the **locations** and which version each one shows.

Sales are imported every hour automatically; **Import sales now** fetches them immediately.

### Ending it

- **Stop the test** — the original item goes back on every screen. Results are kept.
- An **end date** (optional) does the same automatically.
- **Keep this version** — "roll out the winner": the chosen version replaces the item for good, on
  every screen, and the extra rows the test added are removed. You can do this while it runs or
  after it ended.

### Uploading your own numbers (any till)

Choose **Your own numbers (CSV upload)** and upload a file like:

```
location,date,hour,value
Main Street,2026-10-14,9,42
Main Street,2026-10-14,10,57
Harbour,2026-10-14,9,18
```

- `location` — the location name shown on the experiment's page (or its Square/Shopify location id).
  May be left empty when the test has one location.
- `date` — `YYYY-MM-DD`; `hour` — 0 to 23, **local time at that location**.
- `value` — a number of zero or more (use `.` for decimals): covers, sales, footfall, anything.

The file is checked row by row and imported **only if every row is valid**; problems are listed by
row number. Up to 2 MB / 50,000 rows per upload; uploading the same location and hour again replaces
the value. For a test by location, include the weeks before the start too, so each store can be
compared with its normal.

---

## How the result is worked out

**Exposure comes from proof of play.** For every screen in the test, the plays of each version are
counted per hour from `play_logs` and copied into the experiment (raw plays are pruned after
`PLAY_LOG_RETENTION_DAYS`, and the long-term hourly rollup does not keep widget ids). A screen that
was off, or a version whose file never arrived, simply has no exposure — nothing is assumed from the
schedule.

**An hour counts for a version only if that version was alone on screen.** For per-location results
(sales, CSV), the unit is a *location-hour*: it is attributed to version B only when that location's
screens played B — and nothing else — during that hour **and the attribution window before it**
(*Count sales up to: the same hour / 1–3 hours after*). With 2-hour turns and a 1-hour window, the
first hour of each turn is left out. Ambiguous hours are left out rather than guessed at, and hours
with no plays at all (screens off, store closed) do not count. Rates are therefore **per hour on
screen**.

**By location, each store is compared with itself.** Stores differ far more than signs do. When
sales from before the test are available (*Compare with before*, default 28 days, imported
automatically for sales; include it in the CSV otherwise), each location-hour is divided by what
that store normally does at that hour of that weekday. The comparison becomes "B's stores beat their
own normal by more than A's stores did". Without a before-period the raw rates are compared, and the
page says so. Stores are also **assigned in balanced pairs**: sorted by their before-period sales and
split so each version gets a similar mix of big and small stores, with arm sizes differing by at most
one. The assignment is decided once, at start, and never changes.

**By time of day, turns rotate through the week.** Version *k* plays at local hour *h* on weekday *w*
when `(⌊h / turn⌋ + w) mod N = k`. Each version gets every hour block on some weekdays and the same
number of hours on every weekday. The *weekday balance* check reports how close the actual exposure
came to that.

**The interval is a cluster bootstrap.** Hours on the same day, and days in the same store, move
together; treating them as independent would make every result look certain. So the data is
re-sampled **2,000 times by whole clusters** — by day in a time-of-day test (each day carries both
versions, so day-to-day swings cancel out), by store in a by-location test (stores re-sampled within
their own version). The 95% interval is the middle 95% of those re-sampled lifts. It is seeded, so
the same data always gives the same answer. Welch's t-test on per-cluster rates is shown underneath
for reference; it is not used for the verdict because a ratio of sums over a handful of stores is not
normally distributed.

**The verdict:**

| Verdict | When |
|---|---|
| *B sold 12% more … (likely real)* | the 95% interval is entirely above zero |
| *… less / fewer …* | the 95% interval is entirely below zero |
| *No real difference* | enough data, and the interval is narrower than the *smallest difference worth knowing* (default 10%) |
| *Not enough data yet* | fewer than 7 days (time of day) or 3 stores per version (by location), or an interval still too wide to rule out a difference worth knowing |

**"Needs about N more days"** assumes the interval narrows with the square root of the time run:
`days needed = days so far × (current half-width ÷ target)²`, where the target is the larger of the
smallest difference worth knowing and the difference seen so far. An estimate, labelled as one; over
180 days it says the difference is probably too small to matter.

**QR scans** are per version (each has its own link), counted per day against that version's hours
on screen, both modes. **Audience** looks are attributed by the player to the item on screen, so they
are compared per hour of on-screen time (and look length per look) without the location-hour rule.

---

## Privacy

- **Sales are imported as totals only**: per location, per hour, per item filter — the number of
  orders, units and revenue. Orders are reduced to those totals the moment they arrive. Customer
  ids, names, addresses, card details, receipts, order ids and line items are **never requested
  (Shopify) or never stored (Square, whose order search returns them in the same answer)**, and
  nothing is kept at a finer grain than the hour. The table that holds outcomes has exactly six
  columns: experiment, source, metric, location, hour, value.
- QR scans and audience counts are already anonymous aggregates (see their own docs); experiments
  only read them.
- Deleting an experiment deletes its stored exposure and outcomes.

---

## For administrators and self-hosters

### Requirements and permissions

- **Who:** workspace editors and admins create, start, stop and roll out experiments. A workspace
  **viewer** can open every experiment and its results but change nothing (every write returns 403).
  Experiments are per workspace; another workspace gets 404 for them.
- **API:** `/api/experiments`, dashboard sessions only (JWT; not reachable with API tokens), because
  a test switches screen content and reads sales through a stored POS credential. Sales imports and
  POS location lookups are rate-limited per client (6 and 10 a minute).
- **Approvals:** in a workspace that reviews changes before they reach screens, starting or rolling
  out an experiment is refused with an explanation (a test would change screens without review).
  Stopping and automatic ends are allowed: they only restore what was approved.
- **Head office (corporate) playlists and smart playlists cannot be tested**, nor a head-office
  slot. Experiments run on a store's own ordinary playlists.

### Sales permissions

Experiments reuse a Square or Shopify [data source](pos-menus.md); no new key, env var or setting is
needed. The extra read permission is **`ORDERS_READ`** (Square — personal access tokens already carry
it) or **`read_orders`** (Shopify). Tokens stay where the data-source module keeps them: encrypted at
rest, never returned to the browser, sent only to the provider's fixed host (`connect.squareup.com`
/ `<store>.myshopify.com`) with redirects off, through the SSRF guard. Credentials that can write are
refused. An experiment can only name a data source of its own workspace. With no POS connected, the
sales options are hidden and explained, and the other outcomes work as normal.

### How a test reaches the screens — players need no changes

Starting a test rewrites the one playlist row into one row per version and publishes the playlist,
the same way an editor would:

- **By time of day:** each row gets ordinary per-item schedule blocks (dayparting) for its turns,
  intersected with any schedule the item already had. Every player already evaluates these offline.
- **By location:** each row gets a `play_when` condition of type `screens`, evaluated **on the
  server** when a screen's payload is built and stripped before it is sent — exactly like the
  weather and area conditions. The control's condition is "not on the other versions' screens", so a
  screen added mid-test shows the control instead of a gap.

Stopping restores the original row and its schedule blocks from a copy taken at start: the published
snapshot is byte-for-byte what it was before the test. If the end date passes while the playlist has
unpublished edits, the rows are restored but not published (that would publish someone's draft); the
experiment page says so.

### Data model (all additive)

| Table | What |
|---|---|
| `experiments` | definition, status, the slot row as it was (`original`), dates, sales sync state |
| `experiment_units` | one row per location: its screens, its version (location mode), its Square/Shopify location |
| `experiment_exposure` | plays and seconds per screen, hour and version, copied from `play_logs` |
| `experiment_outcomes` | `(experiment, source, metric, location, hour) → value` — imported sales and CSV uploads |
| `playlist_items.experiment_id` | marks the rows a running test owns (never part of a published snapshot) |

A background sweep every 10 minutes ends tests whose end date has passed, copies exposure, and
imports sales hourly for running tests.

### Known limits

- Exposure is counted by what played, by content/widget id: if the control's content also appears
  elsewhere in the same playlist, those plays count as control exposure too.
- Square refunds and Shopify returns are not subtracted.
- Shopify returns at most the last 60 days of orders without `read_all_orders`; keep the
  before-period within that (the maximum offered is 56 days). Orders are read a week at a time; a week
  with more than 6,000 Shopify orders, or 30,000 Square orders per 10 locations, stops the import with
  a message rather than counting part of it.
- A screen whose location changes mid-test keeps the version its old location was given until the
  test ends.
