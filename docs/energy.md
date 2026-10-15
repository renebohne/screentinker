# Energy & carbon

**Insights → Energy** (Advanced view) estimates how much electricity your screens use, the CO2e
that comes with it, and what your display power schedules save. It also suggests where more
switch-off time would pay off, and exports the figures for an ESG or CSRD appendix.

> **These are estimates, not meter readings.** ScreenTinker observes *when* each panel is lit; it
> looks up *how many watts* that panel draws and *how much carbon* a kWh carries where the screen is.
> Every figure on the page and in the exports says how it was derived. For audited numbers, enter
> figures from a plug-in meter or a sub-meter as per-screen overrides.

## What you see

- **Totals for a period** (this month, last month, last 30 days, this year, last year, or any
  dates up to 400 days): kWh, kg CO2e, kWh and CO2e **saved by power schedules**, number of screens,
  hours lit, and the change against the previous period of the same length.
- **How sure we are**, right under the totals: the share of on-time inferred from "the player is
  online" (no panel signal), the hours left out because a player was offline, and how many screens
  use an estimated wattage.
- **Electricity per day** (bar chart; hover a bar for kWh, CO2e and savings), **by group** and
  **by screen** tables.
- **What if**: pick a window (default 22:00–06:00, every day / weeknights / weekends). From the
  last four weeks, it shows how much switching screens off then would save a year, grouped by the
  group a power schedule would be set on ("Lobby — 6 screens · lit about 336 hours a week in this
  window · saves about 1,750 kWh (590 kg CO2e) a year"). **Set a power schedule** opens the existing
  group power-schedule editor; a screen in no group links to its own page.
- **Screen wattage**: every screen's watts (lit / standby), where they come from (entered,
  datasheet with a link to the source, estimated from size, workspace default, guess) and its grid
  intensity. Editors and admins can enter figures per screen, or for a whole group at once.
- **Grid and defaults** (workspace admins): the workspace's country, your own gCO2e/kWh figure
  (e.g. from your electricity contract), and default watts for screens nothing is known about.
- **Across your organization** (organization owners/admins, when the organization has more than
  one workspace): one line per workspace, with a CSV.
- **Simple view**: admins and editors see one line on the home page — "Your screens used about
  42 kWh this month — power schedules saved 18 kWh." — with a link to the page.

### Exports

| Download | Contents |
|---|---|
| Export CSV | One row per screen: hours lit / off by schedule / off otherwise / offline, inferred share, watts and their source, gCO2e/kWh and its source, country, kWh, kg CO2e, kWh and kg saved; a total row. |
| Daily CSV | One row per day: kWh, kg CO2e, kWh saved. |
| ESG appendix | Plain text: the period's figures and the methodology below in prose, with the counts of screens per wattage source, ready to paste into a report. |
| Organization CSV | One row per workspace of the organization, and a total. |

Cells that start with `=`, `+`, `-`, `@` are prefixed with `'` so a screen name cannot become a
spreadsheet formula.

## Methodology

### 1. On-time (observed)

Once a minute the server that owns the screens puts each one in one state and credits the seconds
since the previous sample to it:

| State | Meaning | Counted as |
|---|---|---|
| `on` | lit | on-power |
| `sched_off` | dark because its display power schedule says so | standby power, and **saved** |
| `panel_off` | dark for another reason the player reported | standby power |
| `offline` | the player is not connected: unknown | **nothing** (shown as "offline hours") |

Evidence, best first:

1. A fresh (≤ 15 min) **panel power report** (`telemetry.panel` / `device_info.panel`, from
   HDMI-CEC, RS-232 or DDC/CI — see [screen verification](screen-verification.md)).
2. The **power schedule** the screen obeys (`lib/device-power-schedule.js`, evaluated with the
   same `lib/power-window.js` the players run), **only when the player declares
   `display.power_schedule`**. A schedule a player cannot obey darkens nothing, so that time counts
   as lit.
3. The player's own **`display_off`** event since it last connected (Android, Pi, Windows, Tizen).
4. Otherwise an online player means a lit panel. These seconds are counted as **inferred** and the
   report shows their share.

Each credit is the elapsed time since the previous sample, **capped at 180 s**: a stalled loop or a
restart never invents on-time. A longer gap (server down) is missing data. The first sample after a
start only sets the baseline.

**Assumption where a player reports no panel state:** the panel is lit whenever the player is
connected and its schedule (if it can obey one) does not say off. A TV switched off at the wall
while its player box stays online is counted as lit; an online player with a panel that sleeps by
its own timer is too. **After a server restart**, a `display_off` from before the restart is not
remembered (the evidence lives in memory, as screen verification's does) until the player reports
again.

### 2. Storage, time zones, retention

- `energy_hourly`: per screen per **UTC hour**: lit / off-by-schedule / off-otherwise seconds, only
  while online. UTC has no DST, so no hour is ever counted twice or skipped. Kept **35 days**
  (`ENERGY_HOURLY_RETENTION_DAYS`); it feeds the what-if suggestions.
- `energy_daily`: per screen per **local day of the screen** (its effective time zone): the same plus
  offline and inferred seconds and the watts in force. A local day around a DST change is 23 or 25
  hours long, which is the truth. Kept **400 days** (`ENERGY_DAILY_RETENTION_DAYS`): a year's
  report plus a month. A year of hourly rows for 1,000 screens would be ~9 M rows for no question
  anybody asks; daily rows answer every period report at 1/24th of the size.
- Every span is split at UTC hours and at the screen's local midnight (including half-hour zones such
  as Asia/Kolkata), so nothing is attributed to the wrong day.
- Both tables carry the workspace the screen was in **at the time**: a screen moved between
  workspaces leaves its history where it happened. Pruning is chunked and runs on the sampler.
- Report periods are inclusive local dates (each screen's own). The Simple-view line uses the
  server's UTC calendar month.

### 3. Watts per screen (looked up)

In this order, first answer wins:

1. **Your figure** for the screen (or set for its group, which writes the same per-screen rows).
2. **Datasheet**: the panel model matched in `server/lib/energy/panels.json` against the player's
   reported hardware model, the EDID monitor name, or the attached display name (Samsung order codes
   such as `LH55QMBEBGCXEN` match `QM55B`). 52 entries (Samsung QM/QB/QH B and C series and OM55B,
   LG UH5F/UH5J/SM5KE/UH5N/UH5Q, Philips BDL D-Line/Q-Line/5050, Sharp/NEC ME551/ME552/M552/P556,
   Sony BZ30L/35L/40L, iiyama LH5560UHS). Every entry cites the page its numbers were read from and
   says what kind of figure it is: `typical` (manufacturer's typical power, preferred),
   `eu_label` (P<sub>measured</sub>, SDR, from the EU energy label in
   [EPREL](https://eprel.ec.europa.eu/)), or `max` (only the maximum is published — OM55B, ME551).
   Nothing in the table is estimated; a model without a published figure is simply absent.
3. **From the panel's size**: the diagonal from the EDID physical size (ignored when implausible:
   many TVs write 0×0, 16×9 or 160×90), else from the size in the model number (Samsung, LG,
   Philips, Sharp/NEC, Sony, iiyama naming schemes), through the EU energy label formula
   (Commission Delegated Regulation (EU) 2019/2013, Annex II):

   ```
   EEI = (P + 1) / (3 × [90 × tanh(0.025 + 0.0035 × (A − 11)) + 4] + 3 + corr_l)
   P   = EEI × (3 × [90 × tanh(0.025 + 0.0035 × (A − 11)) + 4] + 3) − 1
   ```

   with A the viewing area in dm² (16:9 assumed). For signage, `corr_l = 0.00062 × (lum − 500) × A`;
   we do not know a screen's luminance, so it is taken as 0 (a 500 cd/m² panel) and the brightness
   a signage panel really runs at is absorbed into the **assumed EEI = 1.18**: the median EEI
   implied by the 46 `typical` and `eu_label` entries of the curated table with 30–130 dm² (range
   0.63–1.59). That puts a 55" panel at ~103 W and a 43" at ~68 W. Signage displays are exempt
   from the ecodesign on-mode limits (Regulation (EU) 2019/2021, Art. 1(3)(f)), which is why they
   sit beyond the label's class G (EEI ≥ 0.90). Displays at ≥ 1,000 cd/m² (window panels) are
   outside the label altogether and can draw 3–4× this: enter their figure.
4. **Workspace default** watts, if an admin set one.
5. **Guess**: a 55" panel by the same formula. Flagged "guess (size unknown)" everywhere: this is
   the common case for streaming sticks and Android boxes, which cannot see the TV they drive.

**Standby**: your figure, else the datasheet's, else the workspace default, else **0.5 W** (the
standby figure every curated panel that publishes one gives). Standby is never allowed above
on-power. **Not included**: the media player, PC or network gear behind the screen, unless your
figure includes them.

The report applies each screen's **current** wattage to its recorded hours, so correcting a figure
corrects the history it is applied to (a report is a recalculation, not a ledger). A screen since
removed uses the watts last recorded with its rows.

### 4. Carbon intensity (looked up)

Annual average grid intensity per country from **Ember, Yearly electricity data, 2024**
([ember-energy.org/data/yearly-electricity-data](https://ember-energy.org/data/yearly-electricity-data/),
CC-BY-4.0; variable "CO2 intensity", power sector, gCO2/kWh), 70 countries plus the world average
(471.5 g/kWh), in `server/lib/energy/grid-intensity.json`. Order:

1. the screen's own country (set in the screen wattage table);
2. the workspace's own gCO2e/kWh figure (e.g. a supplier or market-based figure);
3. the country the screen's time zone implies (only unambiguous zones; an operator-set zone, or a
   reported one that is not an OS default — Raspberry Pi OS reports Europe/London from anywhere);
4. the workspace's country;
5. the world average.

This is the **location-based** method of the GHG Protocol Scope 2 Guidance. kg CO2e = kWh × g/kWh
÷ 1000. Ember's figure covers the power sector's CO2; upstream and transmission losses are not added.

**Live grid intensity is out of scope** (Electricity Maps, WattTime, National Grid ESO carbon
intensity): it needs a third-party key per self-hoster and an hourly join, and annual averages are
what location-based reporting asks for. The table and resolver are built so a live source could be
added later as one more step in the order above.

### 5. Savings and what-if

- **Saved** = hours off **because of the power schedule** × (on-watts − standby-watts). Time dark for
  other reasons is not claimed as a schedule saving.
- **What if** = for each screen, the seconds it was **lit** inside the chosen local window over the
  last 28 days (or since its first hourly row, if newer), ÷ days covered × 365, × (on − standby)
  watts. Screens already dark in the window suggest nothing. Hours are placed in the screen's local
  time by their midpoint. Suggestions are grouped by the screen's lowest-id group — the same
  tie-break the power-schedule resolver uses — and listed individually otherwise; top 20, ≥ 1 kWh/yr.

Context: a signageOS case study reports a bank cutting energy per display by 40% (about €104k a year
across 182 displays) largely through switch-off scheduling; Germany's 2022 energy-saving ordinance
(EnSikuMaV § 11, in force 1 Sep 2022 – 15 Apr 2023) banned illuminated advertising from 22:00 to
06:00, with exceptions for a business's own premises during opening hours.

## API

All under `/api/energy`, JWT sessions only (not API tokens), acting on the active workspace:

| Method | Path | Who |
|---|---|---|
| GET | `/report?start=YYYY-MM-DD&end=YYYY-MM-DD` | any member |
| GET | `/export?start&end[&by=day]` (CSV) | any member |
| GET | `/appendix?start&end[&download=1]` (text) | any member |
| GET | `/suggestions?start=22&end=6[&days=1,2,3,4,5]` | any member |
| GET | `/glance` | any member |
| GET | `/devices` | any member |
| PUT | `/devices/:id` `{on_watts, standby_watts, country}` (null clears) | editors, admins |
| PUT | `/groups/:id` same body, every screen of the group | editors, admins |
| GET / PUT | `/settings` `{country, grid_g_per_kwh, default_on_watts, default_standby_watts}` | read: members; write: admins |
| GET | `/org?start&end`, `/org/export?start&end` | organization owners/admins |

Dates are validated (400 on a bad or reversed range, or more than 400 days). Screen and group ids
outside the active workspace answer 404. Writes are audited (`energy_screen_watts_set`,
`energy_group_watts_set`, `energy_settings_updated`).

## Admin notes

- **Scale-out**: the sampler runs on the server that owns the screens and skips copied workspaces
  (`LOCAL_ROWS_SQL`, like every other sweep). Energy rows are not replicated: on a replica, open the
  report on the primary (the page says so).
- **Env**: `ENERGY_HOURLY_RETENTION_DAYS` (default 35), `ENERGY_DAILY_RETENTION_DAYS` (default 400).
- **Load**: one indexed read and a few UPSERTs per screen per minute, in transactions of 500 screens
  with a yield between them.
- **Updating the reference data**: `server/scripts/energy-build-grid-intensity.py <ember.csv> <out>`
  regenerates the grid table from Ember's long-format CSV; `server/scripts/energy-build-panels.py
  <out>` rebuilds the panel table and its EEI calibration. Add a panel only with a source URL.
- Workspace export/import does not carry energy settings or history.

## Limits

- Estimates. On-time is observed at one-minute resolution; watts and intensity are looked up.
- A panel switched off at the wall, or by its own remote, behind a player that keeps reporting
  online, is counted as lit unless the player reports panel state.
- Offline time is excluded, which under-counts screens that stay lit while their player is offline.
- Brightness, content (a white slide draws more than a black one on most LED-backlit LCDs) and
  ambient-light dimming are not modelled.
- Media players, PCs, LED controllers and networking are not included unless your figure includes
  them. LED walls: enter the cabinet total per screen.
