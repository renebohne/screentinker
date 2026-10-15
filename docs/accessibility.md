# Accessibility checker

ScreenTinker checks **what goes on the screens** for the problems that make signage hard or unsafe
to read: text that does not stand out from its background, text too small for the distance people
read it from, videos that flash, and videos with sound but no captions. It explains every finding in
plain words, says how to fix it, and fixes it in one click where it can.

It also makes **captions** for a video with one click, using a speech-to-text service you choose
(OpenAI, or a Whisper server on your own network).

Why now: the ADA Title II rule makes WCAG 2.1 AA the bar for US state and local government digital
content, with compliance due **April 26, 2027** (2028 for small entities); the **European
Accessibility Act** has applied since **28 June 2025**; and signage standards such as Utah State's
ask for WCAG 2.1 AA contrast, readable text, captions on video with audio, and no flashing. Most signage CMSs make their own *interface*
accessible; this checks the *content*.

> The checker is a tool, not a certificate. It checks what can be measured automatically, says plainly
> what it could not measure, and never claims more.

## For everyone

### Where you see it

| Where | What |
|---|---|
| **Accessibility** (Advanced view, left menu) | The workspace report: everything that needs attention, worst first, with fixes |
| Media, Playlists, Slides | A small **Hard to read** (error) or **Check readability** (warning) badge on items with findings. It links to the report |
| Before publishing | When a playlist or slide deck has errors or warnings, a short list appears with **Go back and fix** and **Publish anyway**. It never stops you on its own (unless your workspace turned on blocking, below) |
| Make a sign (Simple view) | If a colour you picked is hard to read, one sentence says so — *“This text may be hard to read — try the suggested colour.”* — with a **Use the suggested colour** button. If the words may be too small for your screens' viewing distance, a sentence says that too |
| Media → a video → Edit | **Generate captions** and **Edit captions** |

### What is checked

| Check | Applies to | Severity | Standard and threshold |
|---|---|---|---|
| Text contrast | Slides, slide decks, Make-a-sign signs, slide-kind community templates; clock, weather, ticker (RSS), menu board and directory widgets | **Error** below the threshold | WCAG 2.2 SC 1.4.3 (AA): **4.5:1**, or **3:1** for large text |
| Text over a photo | Slides whose background is a photo | **Error**, or **Warning** when the text colour sits inside the photo's own brightness range | Same thresholds, against the brightness of the photo *under the text* after the slide's *Dim photo* scrim |
| Text size for the viewing distance | The same items | **Warning** below 16′, **Error** below 10′ | ISO 9241-303:2011 minimum character height (16 arcminutes); 10′ is the 20/40-vision limit (see below) |
| Flashing | Uploaded videos and animated GIFs | **Error** | WCAG 2.2 SC 2.3.1: **no more than 3 general flashes and no more than 3 red flashes in any one second** |
| Captions | Uploaded videos with an audio track | **Error** when there is no subtitle track | WCAG 2.2 SC 1.2.2 (A), Captions (Prerecorded) |
| YouTube captions | YouTube items | **Warning** when captions are switched off for the item | SC 1.2.2 |
| Words in a picture | Images whose name suggests a poster, menu, flyer, timetable…; PDFs | **Note** (soft) | SC 1.4.5 asks for real text; the server does not read pictures (no OCR) |

A **note** is not an error: it means *“we could not check this”* (text on a moving video, a widget made
of custom HTML, a video that plays from a link, a photo still being measured). Notes are listed
separately under *Things we could not check*.

### Fixing things

* **Use the suggested colour** — the suggestion is the *same colour*, only lighter or darker until it
  reaches the required contrast, so a brand blue stays that blue. For a slide deck the fix is saved in
  the deck and, if the deck is already on screens, published; for a widget it is saved the way an
  edit in the widget editor is. If your workspace reviews changes, the fix goes to review like any
  other edit.
* **Darken the photo** — raises the slide's *Dim photo* setting.
* **Turn on captions** — for YouTube items.
* **Generate captions** — see *Captions* below.
* **Open** — goes to the editor for anything that needs a person (text size, flashing videos).

### Viewing distance and screen size

Text size can only be judged against how far away people stand. On the Accessibility page:

* **Typical viewing distance** (default **3 m**) and **typical screen size** (default **55″**) are the
  workspace's assumptions.
* **Screens** lists every screen; give a screen its own distance or size when it differs (a menu board
  above a counter at 2 m, a lobby wall read from 10 m). Leave a box empty to use the workspace value.
  A screen that reports its physical size (EDID) uses that automatically.
* An item is checked on the **worst** screen that shows it — the one on which its text looks smallest.

### Captions

1. A workspace admin sets up a speech-to-text service once, in the AI settings dialog (Accessibility
   → Captions → **Speech-to-text settings**, or the AI settings button in the Designer or Slides
   editor) → **Speech-to-text (captions)**: base URL, model and, if needed, an API key. Any OpenAI-compatible `/v1/audio/transcriptions` endpoint works:
   * OpenAI — `https://api.openai.com/v1`, model `whisper-1` (or `gpt-4o-transcribe`), your API key;
   * a local Whisper server — faster-whisper-server / Speaches (`http://host:8000/v1`, model e.g.
     `Systran/faster-whisper-small`), the whisper.cpp server, or LocalAI. No key needed for most.
2. On a video with sound, press **Generate captions** (Accessibility page or Media → Edit). It takes
   from seconds to a few minutes.
3. The captions open in an editor: fix any wrong words and **Save**. You can edit them again any time
   (Media → Edit → **Edit captions**).

The captions are the video's normal subtitle track (the same one a `.vtt` upload sets), so every player
that shows subtitles shows them.

**Where the audio goes.** Only the video's **sound** (re-encoded to mono 16 kHz on your server; never
the picture), only to the **one URL your admin entered**, and only when somebody presses **Generate
captions**. With no speech-to-text service set up, captions are off — the button is not shown and a
sentence says why — and nothing is ever sent anywhere. There is no instance-wide default.

## For admins

### Permissions

| Action | Who |
|---|---|
| See the report, badges, checks | every workspace member (view-only members included) |
| Use a one-click fix, generate or edit captions | editors and admins (the server refuses view-only members) |
| Change distance, screen size, per-screen values, the blocking policy | workspace admins |
| Set up speech-to-text | workspace admins |

Everything is scoped to the current workspace. An id from another workspace is answered as *not
found*. A slide may *name* any photo id; the photo is only measured if it belongs to the same
workspace, otherwise the text is reported as *could not check*.

### Blocking publishing (optional)

**Accessibility → Settings → Block publishing when there are accessibility errors.** Off by default.
When on, publishing a playlist or a slide deck that has accessibility **errors** is refused by the
server (HTTP 409, code `accessibility_errors`), whoever or whatever asks — dashboard, Simple view, or
API token. Warnings and notes never block. While a video in it is still being checked for flashing,
publishing is refused with `accessibility_pending` ("try again in a minute") — the policy promises
nothing with a known-dangerous flash rate goes out, and "not looked yet" cannot keep that promise.
Automatic publishes the server makes on its own (schedules, cloud-folder sync) are not blocked.

### How the checks work

**Contrast.** WCAG relative luminance and contrast ratio, exactly as defined in WCAG 2.2. For a slide
the background under each run of text is worked out the way the renderer paints it: the slide colour,
then the photo and its dim scrim, then every box drawn *before* the text (boxes drawn after are on
top). Five points along the text are composed separately and the worst counts. Element and box
opacity are blended.

**Large text.** WCAG's "large" is 18 pt (24 CSS px), or 14 pt bold. On a screen across a room a pixel
rule means nothing, but the CSS reference pixel is itself *defined* as a visual angle (0.0213°), so
text counts as large when its font size subtends at least 0.511° (0.398° when bold) at the viewing
distance — the angle 18 pt subtends on a desktop monitor.

**Text size.** The physical height of a capital letter (0.7 × the font size) on the screen, from the
screen's size and the text's size relative to the screen (slides are sized in % of the screen width,
menu boards in % of the shorter side, the other widgets in CSS px of a full-screen widget), turned
into the angle it makes at the viewing distance:

* **≥ 16 arcminutes** — fine. ISO 9241-303:2011 (and ANSI/HFES 100-2007) give 16′ as the minimum
  character height for reading, 20–22′ preferred. In everyday terms, *capital height ≥ distance ÷ 215*;
  the common signage rule of thumb *letter height ≥ distance ÷ 200* is the same place (≈17′).
* **10–16′** — warning.
* **< 10′** — error: about twice the 5′ letter of the 20/20 Snellen line, i.e. what a person with
  20/40 vision can just make out.

At the defaults (55″ 1080p, 3 m) that is a font size of at least ~20 mm on the screen: about 1.6% of
the screen width for slides.

**Flashing.** A worker thread runs ffmpeg on the file (never on the event loop), sampling 30 frames a
second, scaled to a 48×27 grid. It follows the mean relative luminance — and, separately, WCAG's red
measure `(R − G − B) × 320` for pixels with `R/(R+G+B) ≥ 0.8` — of each ninth of the frame (WCAG's
"25% of a 10° visual field" is 341×256 px on 1024×768, exactly one ninth), each quarter and the whole
frame. A transition is a change of ≥ 0.10 in luminance where the darker state is below 0.80 (≥ 20 on
the red scale), with hysteresis so a slow fade or compression shimmer is not one. More than 6
transitions (3 flashes) inside any one second is a failure. At most the first **10 minutes** of a video
are analysed (a note says so for longer ones), one video at a time, with a 5-minute limit per file.
Results are cached per file revision; replacing the file checks it again. Videos are checked as soon as
they are uploaded, and on demand for older ones.

**Captions.** ffprobe: an audio stream and no subtitle track (uploaded `.vtt`, or a subtitle stream
inside the file) is an error.

**Photos behind text.** The shared image worker reduces the photo to a 64-cell-wide luminance grid
once (cached); the checker reproduces `background-size: cover` cropping and takes the 10th–90th
percentile brightness of the cells under the text. Photos over 25 MB, or not stored on this server,
are "could not check".

### Limits (said plainly)

* **Not checked:** custom HTML widgets, web pages, social walls, code (HTML) community templates,
  layouts' zone backgrounds behind transparent widgets, PDFs and pictures of words (no OCR), and
  videos that play from a URL. Each appears as a *could not check* note where relevant.
* Text box heights are estimated from the number of characters; very unusual fonts may wrap
  differently.
* The size check assumes a widget fills the screen; a widget in a small zone is smaller still, so the
  check can miss small text but does not invent it.
* Files kept only in an external storage bucket (not on this server's disk) are not read for checks.
* Flash detection follows the WCAG thresholds; it is not a clinical (Harding/ITU-R BT.1702) test.
* Speech-to-text output is a draft: always read the captions and correct names and terms.

### Make a sign

Every built-in design passes contrast with its default colours and with any brand colours: the text
colours are derived, never chosen. Since 3.0 the rule guarantees WCAG AA (4.5:1) for every text colour
— the ink falls back to pure black on mid-tone backgrounds where near-black is not enough, the muted
line stops mixing towards the background at 4.5:1, and an accent that would read below 4.5:1 is made
lighter or darker (same hue) until it reads. `test/accessibility-checks.test.js` runs the checker over
every design in both shapes, with defaults and a set of awkward brand colours.

### API (dashboard session only)

All under `/api/accessibility`, JWT only (not on the API-token door), scoped to the active workspace.

| Method & path | Purpose |
|---|---|
| `GET /` | the workspace report: `{settings, counts, sources[], playlists, screens[], stt, can_write, can_admin}` |
| `GET /badges` | `{content, widgets, decks, playlists}` → `{errors, warnings}` per id |
| `GET /check/:type/:id` | `type` = `playlist`, `slide_deck`, `content`, `widget`; plus `block` (what the policy would refuse) |
| `POST /check/sign` | `{template, aspect, values}` → `{issues, chosen}` (rate-limited 120/min) |
| `GET`, `PUT /settings` | `{viewing_distance_m (0.3–100), screen_diagonal_in (7–400), block_on_errors}` |
| `PUT /screens/:id` | `{viewing_distance_m, screen_diagonal_in}`; `null` clears |
| `GET`, `PUT /stt` | `{base_url, model, api_key?, clear_key?}`; the key is never returned (`has_key`) |
| `POST /captions/:id` | start (`{lang?}`); 202, or 409 `stt_not_configured` / `captions_running`, 429 `captions_busy` (rate-limited 10/min) |
| `GET /captions/:id` | `{job: {status: running|done|failed, error}, has_subtitle, stt_configured}` |
| `GET`, `PUT /captions/:id/vtt` | read / save edited captions (`{vtt, lang?}`) |

A finding is `{code, severity: error|warning|note, values, fix?, where?, text?}`. Codes:
`contrast`, `contrast_image`, `contrast_unverified`, `text_small`, `flashing`, `red_flashing`,
`flash_partial`, `no_captions`, `youtube_captions_off`, `media_pending`, `media_remote`,
`media_unchecked`, `text_in_image`, `unverifiable`.

### Security notes

* Every handler is scoped to the active workspace; foreign ids are 404; a view-only member is refused
  every write (`denyReadOnly`); settings and speech-to-text are admin-only; caption writes respect the
  head-office (corporate) media lock like the subtitle upload.
* The speech-to-text key is encrypted at rest with `lib/secretbox` and never returned or logged; the
  audit log records the base URL and model only. On a hosted (non-self-hosted) instance the URL is
  refused if it points at a private address, and the address actually connected to is vetted again
  (`lib/ai-fetch`), so a name that resolves inward is refused too. Redirects are not followed.
* What the endpoint returns is not trusted: it is parsed into cues and rebuilt as WebVTT from times
  and tag-stripped text, capped at 2 MB and 5000 cues. Edited captions go through the same cleaner.
* Media checks never fetch a URL; they read only files already on this server, in a worker thread,
  with time, size and duration bounds.

### Audit log

`accessibility_settings_updated`, `accessibility_screen_updated`, `stt_settings_updated` (no key),
`captions_requested`, `captions_generated` (endpoint host and cue count), `captions_edited`.

### Database

Additive only: `a11y_settings` (one row per workspace, created on first save), `a11y_media_checks`
(cached file results per content revision; removed with the content by a trigger),
`devices.a11y_viewing_distance_m`, `devices.a11y_screen_diagonal_in`, and
`ai_settings.stt_base_url / stt_model / stt_api_key_enc`.

### Sources

* WCAG 2.2: SC 1.2.2 Captions (Prerecorded), SC 1.4.3 Contrast (Minimum), SC 2.3.1 Three Flashes or
  Below Threshold, and the definitions of *relative luminance*, *contrast ratio*, *large scale text*
  and *general flash and red flash thresholds* — <https://www.w3.org/TR/WCAG22/>.
* CSS Values and Units, the reference pixel (visual angle of one pixel at 28 inches).
* ISO 9241-303:2011, *Ergonomics of human-system interaction — Requirements for electronic visual
  displays* (minimum character height 16′, preferred 20–22′); ANSI/HFES 100-2007.
* US DOJ ADA Title II web and mobile accessibility rule (2024); Directive (EU) 2019/882 (European
  Accessibility Act).
