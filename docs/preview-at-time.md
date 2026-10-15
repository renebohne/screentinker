# Preview at a time: "What will this screen show?"

Pick a screen and any date and time, and ScreenTinker shows what that screen will play then and
why. You also get a timeline of the day or the next 7 days. There is no need to stand in front of
the screen and wait.

The forecast uses **the same rules the screen follows**. It does not use a second scheduler. The
server asks its live rules about another moment:

| Question | Answered by (the live code) |
|---|---|
| Which schedule wins | the scheduler's own functions (`services/scheduler.js`) |
| Which playlist plays | the playlist resolver (schedule > screen > wall > group, with head office above all) |
| What the screen is sent | the same payload builder every screen is fed by |
| Which items play | `lib/schedule-eval.js`, the module the players run (dayparts, play windows, "play when") |
| Is the screen switched off | `lib/power-window.js`, the module the players run |
| Weather / area conditions | `lib/local-conditions.js` (optionally with a "what if" weather) |
| Content expiry | the content's expiry date, which the expiry sweep acts on |

## For everyone (Simple view)

Each screen card on the home page has a **What's coming up** link. Open it to see what the screen
shows now, then the next few changes today and tomorrow. For example: "Today 11:00 PM the screen
turns off", "Tomorrow 07:00 AM shows "Breakfast"". It is read-only. To change what a screen shows,
use *Change what a screen shows*.

## For power users (Advanced view)

Open a screen and select the **Preview at…** tab.

- **Date and time at the screen.** Times are in the screen's own time zone, because its schedules
  run on that clock. The zone is shown next to the picker. If the screen has never reported a zone,
  the server's clock is used and the page says so. Quick buttons: *Now*, *Tomorrow 9:00*,
  *Next Monday 9:00*.
- **Weather.** Leave it on *As it is now* to use the latest weather reading. Future weather is not
  known, so the page says when it is using today's reading. You can also pick an outcome
  ("what if it rains?").
- **Timeline.** A strip of the chosen day, or 7 days from it. Each block is a period where nothing
  changes. The color shows the playlist. A hatched block means the screen is off, and grey means
  there is nothing to show. Select a block to jump to its start. The legend names every color.
- **Preview frame.** The real player in preview mode, sized to the screen's orientation. This is
  the same renderer as the existing *Preview* button. It plays the items due at that moment. When
  the screen is switched off, or has nothing to show, the frame says so.
- **Why.** In plain language:
  - every schedule that applies to the screen, and whether it **won**, was **outranked** (a screen
    schedule beats a group schedule, then higher priority, then the older one), has **not started**,
    has **ended**, does **not run on this day**, or is **outside its hours**;
  - when no schedule runs, which tier decided: head office, the screen's own playlist, the video
    wall, or which group (by priority, with the groups that lost);
  - each item: plays, or why not: expired (with the moment), not started yet, ended, outside its
    days and times, or its "play when" condition not met;
  - items **not sent to this player** because it cannot play them, such as a live HLS or RTSP
    stream, HDMI in, or a hold on a player that does not declare it. Items the player does not say
    it supports are marked **May not play here**;
  - **Can interrupt:** triggers assigned to the screen. They fire at unpredictable moments, so they
    are listed rather than forecast;
  - notes: the screen is offline, the time zone is assumed, the power schedule is ignored by this
    player, standby content shows, or an emergency alert, public alert or automation is on the
    screen *right now*.
- **Compare with a whole group.** Below the panel, pick a group to see what every screen in it shows
  at the same moment.

## What the forecast does not predict

- **Live overrides.** A head office emergency alert, a public (CAP) alert or an automation
  override. These are states of the present. When one is on the screen right now, the page notes it.
- **Triggers firing.** These are listed under *Can interrupt*.
- **New content.** Content added later, or picked up later by a smart playlist's rules. The forecast
  uses the currently published loop.
- **Offline screens.** A screen that is offline does not switch until it reconnects. The forecast
  shows what it *should* show.
- **Timing.** The scheduler checks every 60 seconds, so a screen switches within a minute of the
  forecast edge.

## API

All three are read-only GET routes. They need read access to the screen's workspace, the same
access as the screen page, so workspace viewers may use them. API tokens need the `read` scope.

### `GET /api/devices/:id/simulate?at=<ISO 8601>`

`at` defaults to now. It must be within a year back and five years ahead. Optional `weather`
(`clear|cloudy|fog|rain|snow|storm`) and `temp_c` set a what-if weather reading.

Returns:

- `resolved`: `{playlist_id, playlist_name, source, layout_id}`. `source` is one of `schedule`,
  `device`, `group`, `wall`, `corporate` or `null`.
- `active_schedule`.
- `schedules[]`: each with `state` (`won`, `outranked`, `mandate_overrides`, `not_started`, `ended`,
  `wrong_day` or `outside_hours`).
- `fallback[]`: the steps of the resolution, as codes.
- `items[]`: each with `plays`, `reason` and `may_not_play`.
- `skipped[]`: `unsupported`, `weather` or `geo`.
- `power`: `{schedule, supported, off, ignored}`.
- `triggers[]`.
- `local`: the wall-clock stamps.
- `timezone`, `timezone_assumed`, `offline`, `live_now[]`.
- `resolver_check`: `ok`, or `mismatch` if the forecast's resolver disagrees with the live one for
  the current schedule. Please report a mismatch.

### `GET /api/devices/:id/simulate/payload?at=`

Returns the payload the preview frame renders. It holds only the items that play at that instant,
with their time gates removed. Triggers, listener settings, endpoints and the power schedule are
always left out.

### `GET /api/devices/:id/timeline?from=<ISO>&to=<ISO>`

`to` defaults to 24 hours after `from`. The range can be at most 14 days (400 otherwise). Returns
`segments[]` of constant state:
`{from, to, local, schedule_id, schedule_title, playlist_id, playlist_name, source, power, playing, total, items[], default_content}`.

### `GET /api/groups/:id/simulate?at=`

Returns every member of the group at that instant: the first 200 members, and only members in the
group's own workspace.

## For admins and developers

- **No new settings, environment variables, tables or migrations.** Nothing is written: a forecast
  never touches the scheduler's columns or pushes a payload.
- **How the timeline stays fast.** Every rule works at minute resolution in local wall-clock time.
  The timeline walks the range a minute at a time with a cheap clock: one time-zone lookup per
  15 minutes. It only re-evaluates on a minute where some rule has an edge, at local midnight, on
  a UTC-offset change, or when content expires. A 14-day timeline takes tens of milliseconds.
- **How the live path stays the same.** The scheduler gained `nowOverride`, a test seam the timer
  never passes, and its "which schedules, on whose clock, which wins" steps became shared functions.
  The payload builder takes an optional second argument that only the forecast uses. Weather
  conditions take an optional reading.
  `test/device-simulate-equivalence.test.js` loads these modules as they were before this feature,
  from git, and checks over a matrix of fixtures and instants (including the DST changes) that
  the scheduler writes the same thing and every screen is sent the same payload. It also checks that
  the forecast equals the live result after a real scheduler tick.
- The forecast's copy of the resolver view's rule (`resolveFromInputs`) is tested against the view
  for every device and schedule combination. It is also re-checked on every call (`resolver_check`).
