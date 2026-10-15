# Web player

The web player is the screen side of ScreenTinker running in a browser: open
`https://<your-server>/player` on the display device and it shows the display's playlist. It runs
in any current browser and in kiosk shells and casting devices built on one (Fully Kiosk Browser,
UniFi Cast / Pro Display, vMix browser inputs, Chrome in kiosk mode, ChromeOS, smart-TV browsers).
Old WebViews get `/player/legacy`, the same player compiled for older engines.

There are two ways to make a browser into a display.

| | Pairing code | Display link (`?k=`) |
|---|---|---|
| Start from | the screen: open `/player`, it shows a 6-digit code | the dashboard: **Add display → "This player can't stay paired"**, which creates the display and gives you its URL |
| You then | type the code into the dashboard | paste the link into the device's browser / kiosk start URL |
| Identity is kept in | the browser's storage | the link itself (and the browser's storage, if it has one) |
| Use it when | the browser keeps its storage | the browser loses its storage (vMix, kiosk shells that wipe on restart), or you want to set the URL up before the device is installed |

## Display links (`/player?k=…`)

A display link names one display. The `k` value is a long random key (a credential: treat the
link like a password). Anyone who opens the link becomes that display, so share it only with the
device it is for.

The display's **Web player** tab in the dashboard shows the link, so you can **Copy** it again later,
or press **New URL** to replace it (the old link stops working; paste the new one into the device).

### Which display does a browser become?

Since 3.0 the link always wins when it is valid:

- **The link's key is valid:** the browser becomes the display the link names, whatever it was
  before. This includes a browser that still has an identity in its storage from an earlier
  pairing or an earlier server, for example a casting device that was paired before you rebuilt the
  server, or a screen you are moving to a different display by giving it a new link.
- **The link's key is unknown to the server** (rolled, revoked, the display was deleted, or the link
  was made on a different server) **and the browser has a working identity of its own:** it keeps
  that identity. A screen that still has an old link in its start URL after you roll the key keeps
  working.
- **The link's key is unknown and the browser has no working identity:** the player shows a pairing
  code, with a note under it explaining that the display link was not recognised. Pair it with the
  code, or copy the display's current link from the dashboard into the device.

> **Before 3.0 (2.6.x and earlier)** a browser with a stored identity ignored the key in its URL.
> If the server had been rebuilt or the display deleted, such a device showed a pairing code and
> appeared as a new, separate display, while the display the link was made for stayed offline. On
> those versions, clear the device browser's site data for your ScreenTinker address (or reinstall
> the casting app) and open the link again. (GitHub #630)

### Any display can have a display link

A display paired with a code has no link to start with. Its **Web player** tab offers **Create a
web player link** (editors and admins; view-only members see that there is none). The link is just
another way to identify the same display: the player it already has keeps its own credentials and
carries on undisturbed. Open the link anywhere else and that browser shows the same display.

### Opening one link in several places: mirrors

A display link may be open in more than one place at the same time, for example the lobby TV and
the reception PC, or Chrome and Firefox on the same machine. The first place is the display itself.
Every other place that opens the link while the display is on becomes a **mirror**:

- It shows exactly what the display shows: playlist, layout, schedules, power schedule, background,
  orientation, emergency alerts. Change content on the original display; a mirror has no content
  settings of its own (its page says so and links back).
- It is a screen of its own for everything about the physical screen: online/offline status,
  screenshots and the live view, screen verification, proof-of-play (reports show where content
  actually played), energy. It is named "*Display* (mirror 1)", shows where it is open
  ("Chrome on Windows · 10.0.0.5"), and can be renamed. Its preview is stored like any screen's
  (the first frame at once, then every few minutes while it is online), and its **Now playing**
  says "Mirroring *Display*: playing *playlist*" (and the item, from its own play reports).
- A [screen share](screen-share.md) to the display, and the display's meeting-room code, show on
  every mirror too.
- The original's **Web player** tab lists its mirrors (status, where, last seen, **Remove**). Screen
  cards show "+2 mirrors"; the Simple view lists them under their display.
- **It counts as a screen** on your plan. If the plan has no screen to spare, the new place shows
  "This display is already showing somewhere else" with the reason, instead of a blank "Waiting for
  content".
- The same browser reopening the link (a reload, a reboot) comes back as **the same mirror**, never a
  new one. A browser restarting on the original's own machine is the original again, not a mirror:
  only a *different* browser (a different install) opening the link while the original is on makes a
  mirror.
- **Remove** disconnects that place for good: it shows "This mirror was removed" and stops. Only
  opening the link there again brings it back. (A player older than 3.0 does not know this message;
  it re-pairs and, if the display is on, comes back as a new mirror. Update it or close the link
  there.) Removing the original display removes its mirrors.
- **New URL** on the original stops new mirrors (the old link no longer works). Existing mirrors keep
  working with their own credentials until you remove them.

Before 3.0 every opening of a link registered as the same display and pushed the previous one off;
the screens took turns playing, the other one said "Waiting for content", and the remote view
flipped between them. If one identity is still claimed by two live connections (two tabs of the
same link in the same browser profile, or a copied player install), the server stops the
alternation after a short burst and keeps the one that is connected.

### Several display links in one browser

Each display link keeps its own storage in the browser (identity, install id, playlist and layout
caches, trigger and sync settings, offline proof-of-play), named after the link. Two different
links open in two windows of one browser are two independent displays: reloading either one, or
starting either one offline, never turns it into the other. Plain `/player` (no `k=`) keeps the
storage it always had, so existing screens keep their identity. A link page from before 3.0 moves
its identity into its own storage the first time it loads. Use separate windows, not background
tabs, for screens people watch: a hidden tab is not drawn and browsers throttle it.

The service worker's media cache is shared (files are named by their content), and it keeps what
every display open in the browser needs rather than only the last one that asked.

These mechanisms are standard browser storage and Socket.IO, so they behave the same in Chrome,
Edge, Firefox and Safari. The automated end-to-end tests run in headless Chrome.

### Troubleshooting a display link

| What the screen shows | What it means | What to do |
|---|---|---|
| The playlist | Working | Nothing |
| A pairing code **with** a note about the display link | The server does not know this key | Copy the display's current link from its dashboard page into the device, or pair with the code |
| A pairing code **without** that note | The device was not opened with a `?k=` link (check the start URL; some devices drop the query string) | Check the start URL carries `?k=…` |
| "Tap anywhere to start" | Normal cold start, see sound below | Nothing, it continues by itself after 5 seconds |
| "This mirror was removed" | Someone removed this place's mirror on the dashboard | Press **Show it here again**, or open the link again |
| "This display is already showing somewhere else" | The link is open elsewhere and a mirror could not be added (the plan has no screen to spare) | Free a screen or upgrade, then **Try again** |

## Starting with sound (`?autoplay_audio=1`)

Browsers do not let a page play sound until someone has interacted with it. So on every cold start
the player shows **Tap anywhere to start / Audio requires user interaction**. Without a tap it
continues after 5 seconds **muted**. That is the right default for ordinary browsers.

Some kiosk browsers can lift that restriction, for example Fully Kiosk Browser with its
**Autoplay Audio** setting (`autoplayAudio`) turned on. For those, add `autoplay_audio=1` to the start
URL:

```
https://signage.example.com/player?k=<key>&autoplay_audio=1
https://signage.example.com/player?autoplay_audio=1          (a display paired with a code)
```

With the parameter, the player asks the browser whether sound is allowed by starting a tenth of a
second of silence unmuted. If the browser allows it, the tap screen is skipped and the display
starts with sound straight away, after every reboot or power cut. If the browser refuses (the kiosk
setting is off, or it is an ordinary browser), nothing changes: the tap screen is shown and the
player continues muted after 5 seconds, as without the parameter. The browser console then logs
`autoplay_audio=1, but this browser refused unmuted playback`.

Notes:

- The parameter is opt-in. A normal browser opening `/player` behaves exactly as before.
- Only `1` or `true` turns it on.
- The ScreenTinker Android app does not need it: it lifts the WebView restriction itself and never
  shows the tap screen.
- Items you have muted in the playlist stay muted, and video-wall followers stay silent, with or
  without the parameter.
- In Chrome you can test it with `--autoplay-policy=no-user-gesture-required`.

## How changes reach the screen

The server pushes every published change to the player over its live connection, and the player
also re-checks every 5 minutes in case a push was missed. On reconnect (after a network drop, server
restart or sleep) it receives the current playlist straight away.

What happens on screen when the playlist changes:

- Items that are still in the playlist keep playing; the new order takes effect at the next item.
  An item is not cut off mid-play.
- A removed item that is on screen finishes and then rotates out (at most 60 seconds later).
- A playlist that had **one item** and gains more: the single item was playing on a loop. It now
  finishes its current pass and the playlist rotates on. A YouTube item rotates at the end of its
  current play-through; a widget after its duration.
- Edits only reach screens once the playlist is **published**. An unpublished playlist shows
  "Unpublished changes" in the dashboard and screens keep showing the last published version.

> **Before 3.0 (2.6.x and earlier)** an item added to a playlist that had a single **video** or
> **YouTube** item never appeared: the one item kept looping until the browser was restarted.
> Workaround on those versions: reload the player page or restart the browser after adding the
> item. (GitHub #632)
