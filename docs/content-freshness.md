# Content freshness

Screens rot quietly. Content gets uploaded once, the screen keeps playing it, and nobody decides it
should stay up for a year. Industry telemetry puts the median screen's content at about 17 days old,
and over a quarter of scheduled creative at more than a year old. Content freshness shows you where
that is happening in your workspace and why, and gives you a one-click fix for each case.

Nothing here changes a screen by itself. It reads what played and what is assigned, then reports.

## Where you see it

| Where | What |
|---|---|
| **Insights → Freshness** (Advanced view) | The workspace report: average age of what played, stale screens, items that mention a past date, items that expired but are still in a playlist. Then the items that need a look (worst first), screens, stale playlists, snoozed things and the settings. |
| **Screens, Playlists, Content** (Advanced view) | Chips on the cards: **Stale**, **Very stale**, **Mentions a past date**, **Expired**, **Out of season**. Hover a chip to see why. |
| **Home** (Simple view) | One line when screens have been showing the same thing for a long time, e.g. "2 screens haven't changed in 3 months. Freshen them up?". It links to *Change what a screen shows*, and goes straight to the screen when there is only one. **Not now** hides it for a week on that browser. View-only members don't see it. |
| **Weekly email** | A digest of what is going stale on the screens you edit, with links. See [The weekly digest](#the-weekly-digest). |

## How a screen's age is worked out

A screen's age is the **average age of what it actually played** in the last 7 days (the *play
window*), **weighted by play time**. A 3-second logo bumper that is two years old barely moves the
number. The 40-second promo that runs every loop decides it.

- An item's age counts from the later of **when it last changed** and **when it was added to the
  playlist**. A two-year-old photo added to the lobby playlist yesterday is new to everyone walking
  past the lobby.
- **What counts as a change:** uploading it, or replacing its file. For slides and widgets, any edit.
  Renaming an item or setting its expiry date is **not** a change to what anybody sees, so it doesn't
  make the item fresh. Otherwise the page's own *Set an expiry* button would hide the problem it reports.
- **Live things don't go stale:** web pages, live streams, camera feeds, clocks, weather, RSS, social
  and other live widgets change by themselves, so they carry no age and don't count towards a screen's
  average. Their names still get the date checks below. Slides, text, menu boards and directory boards
  are authored, so they do age.
- **Expired items** no longer play, so they don't count towards the average either. They are reported
  separately.
- When a screen has **no plays** in the window (it is offline, or proof-of-play is off for its items),
  its age comes from its playlist, weighted by how long each item shows. The tooltip says which basis
  was used.

A screen, playlist or item is **Stale** once its age reaches the *stale* mark (default 30 days) and
**Very stale** at the *very stale* mark (default 90 days).

Only items that are **in use** are judged: on a screen's playlist, in a published playlist, or played
in the window. An old file sitting unused in the library is not rot on a screen.

## The detectors

| Chip | Meaning |
|---|---|
| **Mentions a past date** | The item's name, or the words on its slide, mention a date that has passed. |
| **Out of season** | It mentions a holiday (Christmas, Halloween, Easter, Valentine's Day, Black Friday, Thanksgiving, St Patrick's Day, Hanukkah, New Year's Eve) with no year, and it is well past that holiday. |
| **Expired** | Its expiry date has passed, so it no longer plays, but it is still in a playlist. |
| **Stale / Very stale** | Nobody has changed it in that many days. |

### Reading dates: conservative on purpose

A false "mentions a past date" on a sign that is fine teaches people to ignore the chip, so the
detector only reads dates a person would read with confidence. Every finding comes with the sentence
saying how it was read.

It reads:

- a month **name** with a day or a year: `Oct 3`, `3rd October 2025`, `October 2025`, `3rd-5th Oct`;
- a holiday or season **with a year**: `Christmas 2025`, `Easter 2026`, `Summer 2025`. Seasons count
  as over only when both hemispheres are done with them, so `Summer 2025` is over after February 2026;
- a weekday with an ordinal day and no month (`Friday 12th`), only when exactly one month near the
  item's last change has a Friday the 12th;
- numeric dates **with a four-digit year** (`2025-10-03`, `03/10/2025`), on slides only. When the day
  and month order is ambiguous, it counts only if **both** readings have passed.

It deliberately ignores numbers with no month name and no year (`24/7`, `3/4 cup`, `9-5`), bare years
(`est. 2019`, `© 2024`), URLs, and numeric dates in **file names**. Cameras and screenshot tools stamp
the capture date into the name (`IMG_20230512`, `Screenshot 2025-03-04`), and that says when the photo
was taken, not that an event is over.

**A date with no year is read against when the item was last changed**, not against today. "Sale
ends Oct 3" uploaded in September means *this* October 3rd. The tooltip says so: *"Mentions "Oct 3".
It was last changed on 2026-09-20, so this reads as 3 October 2026, which has passed."*

**The latest date decides.** A slide that says "Was Oct 3, now through Dec 1" is not flagged.

**A date is past only once that whole day is over everywhere.** The detector waits until the latest
time zone (UTC+14) has finished the day.

**Out of season flags leftovers only.** Christmas artwork in February is flagged. Christmas artwork
in September is somebody planning ahead and is not: anything within 60 days before a holiday's season
is left alone.

### Dark workspaces

When no workspace admin or editor (or organization owner/admin) has signed in for **90 days**, the
Freshness page says so: the screens keep playing, but nobody is looking after them. A workspace younger
than 90 days is never dark.

## One-click fixes

On the Freshness page, each item has:

| Action | What it does |
|---|---|
| **Replace** | Opens the item in the content library, where you can upload a new file in its place. Every screen showing it updates. |
| **Take off screens** | Sets the item's expiry to now. Within a minute the expiry sweep removes it from every published playlist and screens update. It stays in your library, and setting a new expiry date brings it back. Not shown for items that have already expired. |
| **Set an expiry** | Pick the last day it should show. |
| **Edit** | For slides and widgets: opens the editor. |
| **Snooze** | "I know, leave it." The item, screen or playlist isn't flagged for 30 days, 90 days or a year, and doesn't count towards averages. Snoozed things are listed at the bottom of the page with **Unsnooze**. |

These go through the same endpoints as the content library, so **approval applies**: in a workspace
that reviews changes, a replacement waits for review exactly as it would from the library. Expiry
dates are not reviewed, the same as in the library.

Editors and admins see the fixes. **View-only members** see the report but no buttons. The server
refuses their writes in any case.

## Settings (per workspace)

At the bottom of the Freshness page. **Only workspace admins** (and organization owners/admins) can change them.

| Setting | Default | Range |
|---|---|---|
| Stale after (days) | 30 | 1–3650 |
| Very stale after (days) | 90 | must be more than *stale* |
| Look at plays from the last (days) | 7 | 1–90 |
| Send the weekly digest for this workspace | on | |

Changes are written to the activity log (`freshness_settings_updated`), as are snoozes
(`freshness_snoozed` / `freshness_unsnoozed`).

## The weekly digest

Once a week, each **workspace admin and editor** gets one email covering every workspace they edit. It
lists the stale screens (with links to each one) and the items that mention a past date, expired or are
out of season, with the reason for each. A **Review and freshen up** link opens the Freshness page in
the right workspace. A week with nothing stale sends nothing.

- **On by default** for admins and editors. **Viewers never** get it. Organization owners and admins
  who are not members of a workspace are not mailed about it (on a large estate that would be a wall of
  mail); they can open the page.
- **Turning it off:** the **Unsubscribe** link in every digest (one click, and it works without signing
  in), or untick **Email me a weekly digest** on the Freshness page. The digest link turns off **only the
  digest**: alerts about your screens, such as a display going offline, keep coming.
- **Alert email off means no digest.** If you turned off alert email for your account (Settings, or the
  unsubscribe link in an alert email), you get no digest either.
- An admin can switch the digest off **for a whole workspace** in its settings.
- The email is sent once a day at 09:00 UTC to whoever is due, so each person gets at most one a week.
  A send that fails is retried the next day.

### Self-hosted

The digest needs a mail transport (`EMAIL_TRANSPORT` with Graph or SMTP settings) **and** `APP_URL`,
because without an absolute address there is no working link, and no unsubscribe link. Bulk mail
without an unsubscribe link is not something ScreenTinker sends. With either missing, the digest is
**not sent, without errors**, and the Freshness page says so next to the digest switch. Everything
else (the page, the chips, the Simple line) works with no email at all.

`GRAPH_DEV_RESTRICT_TO` (the development allow-list) applies as it does to every other email.

| Environment variable | Effect |
|---|---|
| `FRESHNESS_DIGEST=off` | Switch the weekly digest off for the whole instance. |

### Scale-out (mesh)

The digest is sent by the **primary** only. On a replica, every copied workspace, and every user who
belongs to one, is skipped (the same rule as the other email sweeps), so nobody gets two digests.
Freshness settings, snoozes and digest preferences are not replicated. A replica showing a copied
workspace uses the default thresholds, and a change made there (a snooze, a setting) is forwarded to
the primary like every other write. An unsubscribe link clicked against a replica is forwarded to the
primary.

## API

JWT-authenticated (signed-in dashboard sessions), scoped to the caller's active workspace. API tokens
cannot reach it.

| Method | Path | Who |
|---|---|---|
| GET | `/api/freshness` | any member: the full report |
| GET | `/api/freshness/chips` | any member: the compact per-id map behind the chips |
| GET | `/api/freshness/settings` | any member |
| PUT | `/api/freshness/settings` | workspace admin: `{ stale_days, very_stale_days, window_days, digest_enabled }` |
| POST | `/api/freshness/snooze` | editor/admin: `{ type: content\|widget\|device\|playlist, id, days: 1–365 }` |
| DELETE | `/api/freshness/snooze/:type/:id` | editor/admin |
| GET / PUT | `/api/freshness/digest` | the caller's own digest preference: `{ enabled }` |

A snooze names a resource **in the active workspace**. Any other id gets the same `404` as one that
doesn't exist.

## Limits worth knowing

- Proof-of-play is the source for "what played". Items with proof-of-play switched off are weighed by
  their playlist dwell instead, and only when the screen has no plays at all in the window.
- Smart playlists choose their items by rule, so they have no fixed item list to age. A screen on one is
  judged by what it played.
- Head office (corporate) content playing in a store belongs to the head office workspace. It doesn't
  count towards the store screen's age, and its items are reported in the head office workspace, from
  its published playlists.
- The date reader understands English month and weekday names.
