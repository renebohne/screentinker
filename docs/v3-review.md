# ScreenTinker 3.0 — review, design and security notes

Branch `v3.0`, cut from `main` at 2.6.1 (`c0d8f097`). This document records:

- the review that shaped 3.0;
- the design decisions taken from it;
- the security findings, what was fixed and what stays open.

Operator-facing upgrade steps are in [upgrading-to-3.0.md](upgrading-to-3.0.md).

**Goals:**
1. A non-technical person gets "a screen is playing something I chose" in about five minutes.
2. The hosted trial converts to paid by showing value, not by walls.
3. Node 22 is enforced, with a clean in-place upgrade from 2.6.

**Constraints:**
- No capability is removed.
- No player protocol, pairing code or API contract changes.
- Self-hosted stays first-class.

---

## 1. Review

### 1.1 Architecture at a glance

| Area | Where | Notes |
|---|---|---|
| Server | `server/` — Express 5, SQLite (better-sqlite3 13; node:sqlite fallback), Socket.IO | ~80 route modules, 330 lib files, 5,900+ `node --test` tests |
| Schema | `server/db/schema.sql` + an idempotent per-boot `migrations[]` loop and one-time steps keyed in `schema_migrations` (`server/db/database.js`); `lib/schema-check.js` repairs/asserts required columns | No numeric schema version; ALTERs are "duplicate column"-tolerant |
| Tenancy | org → workspace → resources; `lib/tenancy.js`, `resourceAccess()`; API tokens bound to one workspace | Well-factored; a 20-module IDOR sweep found two gaps (§4) |
| Dashboard | `frontend/` — vanilla JS ES modules, hash router (`js/app.js`), 40+ views, 9 locales (`js/i18n/en.js` is the source of truth) | No build step; static-analysis tests guard i18n keys, API calls and XSS sinks |
| Players | Android, web (`server/player`), Tizen, webOS, Roku, BrightSign, Vega, iOS/tvOS, native (Pi/Windows/macOS), e-paper | Untouched in 3.0 apart from version literals |
| Ops | `Dockerfile`(s) on `node:22-slim`, `scripts/upgrade.sh`, the instance updater (`scripts/updater`), setup scripts for Debian/Pi | |

### 1.2 First-run, pairing and empty states (as found in 2.6)

- **The onboarding wizard was unreachable for new signups.** The only redirect into `#/onboarding`
  fired when a signed-in user loaded `#/login`. Signup's `onAuthSuccess` goes to `#/` and reloads, so
  every new account landed on an empty dashboard. Completion was stored in `localStorage` only.
- **Pairing:** Dashboard → "Add Display" → a modal that opened with the vMix "can't stay paired"
  checkbox *above* the code field. Below it came four downloads, a device-owner QR and the server URL.
  It took about 3 clicks plus typing, after installing a player somewhere else.
- **Content to screen took ~9 clicks across 3 pages**, and the last step was easy to miss. Adding to
  a screen creates its own playlist as a **draft** (`routes/assignments.js` `markDraft`). The screen
  stays blank until someone presses Publish in an amber banner. The device picker could not upload.
- **25 menu links from day one**, across six groups, with no simple/advanced concept.
- **Terminology:** the same object was a "Display" (nav, dashboard, dialog), a "Device" (group
  header, tabs) and a "Screen" (checklist) — sometimes on the same page.
- **No sample content** at all; a first-time user without a ready file stalled at the upload step.
- **Checklist step 4** was a 40-word run-on about layouts and zones.
- **Mobile:** the Screens toolbar was a non-wrapping row of fixed-width inline-styled controls and
  overflowed at phone width.

**Top friction points, ranked:**
1. Draft/publish is invisible.
2. The wizard is unreachable.
3. Too many menu items.
4. Upload and assign happen on different pages.
5. The screen page opens on "Now Playing" rather than its content.
6. The add dialog leads with edge cases.
7. No starter content.
8. Terminology drift.
9. A crowded first dashboard.
10. Jargon in the checklist.

### 1.3 Trial and billing (as found in 2.6)

- **Plans** (`plans` table) — Free: 2 screens / 500 MB; Starter: 8 / 2 GB; Pro: 25 / 10 GB;
  Enterprise: unlimited. Enforced in `middleware/subscription.js` (`DEVICE_LIMIT`, `STORAGE_LIMIT`,
  `FEATURE_LOCKED`) and on the player (`checkDeviceAccess` → "Trial Expired" / "Device Limit
  Reached" cards).
- **Trial:** 14-day Pro, no card. It lapses to Free, and nothing is deleted.
  `services/trialExpiry.js` sends T-3 and expiry emails.

**Conversion gaps:**
1. **The trial was visible only on the Subscription page.** No banner, no day count elsewhere.
2. **Limit refusals were dead ends:** a red toast of the server's sentence. Nothing in the frontend
   read the `code`.
3. **Paused screens were not shown on the dashboard;** owners learned from the screen itself or the
   email.
4. **The past-due banner was broken:** it read `user.subscription_status`, which `/api/auth/me`
   never returned, so it vanished on the first `/me` refresh.
5. **Copy drift:** "Free plan (1 device)", "Pro (15 devices)" against seeded values of 2 and 25.
6. **No plan recommendation; `?payment=cancelled` unhandled.**
7. **No funnel instrumentation at all.**
8. **Self-hosted nagging:** every non-first self-hosted signup got a 14-day trial that dropped them
   to Free (2 screens), and the white-label upsell showed on self-hosted.

### 1.4 Node 20 → 22 surface

Already on 22 before this branch:
- `server/package.json` `engines >=22.14.0`
- Dockerfiles (`node:22-slim`)
- CI (`node-version: '22'`)
- the Debian/Pi setup scripts
- `upgrade.sh`'s pre-flight

Gaps:
- **`scripts/remotedisplay.service`** hard-coded `/home/owner/.nvm/versions/node/v20.20.1/bin/node`.
- **`upgrade.sh` checked the Node on PATH**, not the one the service's `ExecStart` runs. That allowed
  a restart onto Node 20 and a crash loop.
- **The boot check only warned** (`preflight-deps.js`). Below 22.14 better-sqlite3 segfaults, so the
  practical result was a crash loop whose last log line was a warning.
- **No general pre-migration backup.** Only `upgrade.sh` and the updater took one; `git pull` and
  `docker pull` did not.
- **Stale docs and comments:** README said "20.6+". Several comments claimed node:sqlite needs
  `--experimental-sqlite` on 22.x; it is unflagged from 22.13.
- **CI never ran the actual 22.14.0 floor.**
- **No deprecated Node APIs were found.** `require(esm)` of `uuid` relies on 22.12+, which is fine at
  the floor.

---

## 2. Design

### 2.1 New user journey (hosted trial and self-hosted alike)

1. **Sign up → the first-run guide** (`#/onboarding`), reached by default now:
   - **Who is sent there:** an account whose `users.onboarded_at` is null, arriving at an empty
     dashboard.
   - **Who is not:**
     - viewers;
     - anyone joining a workspace that already has screens (they are marked done);
     - every account that existed before 3.0 (backfilled as done).
2. **Open the player.** The first card is *"No TV handy? Try it in this browser"*. The web player in
   a new tab shows a pairing code immediately, so the whole loop works with no hardware. Hardware
   tiles and "all downloads" follow.
3. **Connect your screen:** a 6-digit code, then a name.
4. **Choose what it shows:** upload a photo/video **or "Use a sample image"** (a brand-neutral
   1080p "This screen is live." card, uploaded as ordinary content). It is assigned to the new
   screen and **published**, so the screen changes in seconds.
5. **"It's live!"**
   - On a hosted trial, one calm block: *"Your Pro trial: N days left — everything is unlocked…
     No card needed"* with *Compare plans*.
   - "What's next" lists only first-week actions: next screen, playlist, schedule, templates, and
     "Switch to Advanced view".
6. Finishing or skipping is saved on the account (`PUT /api/auth/me {onboarded:true}`).
7. **Every later screen uses the same guide.** In Simple view, Add screen opens `#/add-screen`: the
   same steps without the welcome. The last step adds "Or show the same as another screen", which
   assigns an existing playlist and publishes it if it was never published. Advanced view keeps the
   Add screen dialog with its options (no-storage players, device-owner QR).

Step 4 accepts several photos and videos at once (file picker or drag and drop). They go up through
the library uploader, are all added to the screen, and are published once.

**Time-to-first-content:** about 2 minutes on the browser player with the sample image; under 5 on
real hardware.

### 2.2 Progressive disclosure

**Simple view is guide-style, with no sidebar** (`views/simple-home.js`, routes `#/` and
`#/simple/*`):
- Home is "What would you like to do?" with four big tasks:
  - **Add a screen** (`#/add-screen`).
  - **Change what a screen shows**: pick the screen, then *replace* or *add*, using upload (several
    files), the sample, or "same as another screen". Replace detaches the screen from its old list,
    so other screens using that list are untouched. Add warns when another screen shares the list.
  - **Upload photos**: files first, then tick the screens.
  - **Get help.**
- Your screens are listed below the tasks; tapping one opens "Change what it shows".
- A top bar carries the Simple | Advanced switch and an account menu (plan, settings, help, sign out).
- Every write goes through the same endpoints as the full product, so review gates and plan limits
  apply.

The menu rules below apply wherever the sidebar is shown in Simple view (pages opened from a link).

A per-account `users.ui_mode` (`simple` | `advanced`):
- New accounts start `simple`; pre-3.0 accounts are migrated to `advanced`.
- A **Simple | Advanced** switch sits at the top of the menu, under the workspace name. Simple also hides
  power-user controls inside pages (`data-advanced-ui`): on a screen's page, Remote, Controls,
  Terminal, the reboot/kiosk row, the layout picker (unless the screen already uses one) and
  "Copy to"; on the Screens page, the card-field picker, the drag hint and "Set server URL".
- Hidden items are marked `data-advanced` in `index.html` and hidden by `html.ui-simple`, which
  `nav-prime.js` sets before first paint so the full menu never flashes.
- **Nothing is removed:** every route still works from a link or bookmark.

| Visible in Simple view | Advanced view only |
|---|---|
| Screens, Content, Playlists, Schedule | Video walls, Servers, NOC, Layouts (multi-zone), Reviews (approvals) |
| Templates, Slides | QR codes, Social feeds, Widgets, Kiosk, Designer (deprecating) |
| Reports (proof of play) | Triggers, Alerts, Emergency feeds, Automation, Data sources |
| Members, Settings, Subscription, Help | Audience, Activity |
| *(Corporate / Head office appears in both, when it applies)* | Dashboard: card-field picker, drag hint, "Set server URL" |

In simple mode, **adding content on a screen's page publishes it**. Publishing goes through the
normal release gate, so a workspace that requires review still gets a draft and its Submit banner.
The full mode keeps the explicit draft/publish workflow.

**Terminology:** "Screen" is the user-facing noun (Screens, Add screen, Connect screen, Screen
name). "Device" remains in technical tabs. This changes `en.js` only; other locales fall back or
keep their wording.

### 2.3 Trial-to-paid conversion moments (hosted only)

Every surface below checks `plansVisible()`. It is false on self-hosted, under `HIDE_BILLING`, and
for support/recovery sessions, so **self-hosted sees none of it**.

| Moment | Surface | Message (en) | CTA |
|---|---|---|---|
| First screen lights up | Onboarding "It's live!" | "Your Pro trial: N days left. Everything is unlocked… No card needed." | Compare plans |
| First pair from the dashboard | One-time green bar | "Your first screen is live! Add more screens, schedules and locations while your trial runs." | What the plans include |
| Every session during trial (org owner only) | Trial banner, dismissible per day | Days >3: "Pro trial: N days left. Everything is unlocked while you try it." Days ≤3: "Your Pro trial ends in N days. Choose a plan to keep every screen running — your content stays either way." | See plans / Choose a plan |
| Trial ended (≤14 days ago) | Trial banner | "Your Pro trial has ended. Nothing was deleted — screens beyond the Free plan are paused until you choose a plan." | Bring my screens back |
| Hits a limit | Upgrade prompt (modal) | Names the limit in plain terms, three value bullets, and **the one plan that fixes it** (`suggested_plan` from the server: "Starter gives you up to 8 screens for $9.99/month"), plus "Monthly, cancel any time. Your screens and content are never deleted because of a plan change." | Upgrade to Starter · **Not now** (equal weight) · Manage content (storage) |
| Paid feature, before the form | "Pro" pill on *Media URL* in Add content | — | Tile still opens: a soft lock, not a wall |
| A screen is paused by the plan | Badge on the screen card | "Paused — trial ended. Choose a plan to resume" | → Subscription |
| Subscription page | Recommended plan | "Recommended — fits your 6 screens, with room to grow" (or the plan a prompt sent them for, scrolled into view) | Monthly / Yearly |
| Before the trial ends | Subscription page | "When the trial ends, you keep: all content, playlists and schedules; your first N screens; your account and team. Paused until you choose a plan: screens beyond N; media from a link; …" (real Free-plan limits, not hard-coded) | — |
| Closed checkout | Toast | "Checkout closed — nothing was charged. Your trial and screens are unchanged." | — |

**Anti-dark-pattern rules applied:**
- Every prompt has an equally visible "Not now".
- Banners are dismissible.
- No countdown timers.
- No claims about features that aren't gated. The remote-URL copy was corrected to "media from a
  link", because scheduling and live streams are on every plan.
- "Nothing is deleted" is stated wherever loss might be feared, and it is true.

**Measurement** (`lib/conversion-events.js`, table `conversion_events`, hosted only):

- **Events:** `signup → onboarding_completed → first_pair → first_publish → limit_hit → upgrade_prompt_clicked → billing_view → checkout_start → checkout_complete`, plus `trial_expired`, `sample_content_used`, `trial_banner_clicked`.
- **Rules:**
  - closed vocabulary;
  - client events limited to a subset;
  - meta reduced to short scalars;
  - once-only events recorded once;
  - repeats deduped for 10 minutes;
  - rows deleted with the user.
- **Readout:** platform admins see the cohort funnel under **Platform → Overview → Trial to paid**,
  with limit hits by code (`GET /api/subscription/funnel`).

**Self-hosted sponsor ask:** the trial banner's slot carries a GitHub Sponsors request
(https://github.com/sponsors/screentinker) on self-hosted installs.
- Platform admins only, after setup.
- Shown at once on an install upgraded from an earlier version (`app_settings.last_upgraded_at`),
  after 3 days on a fresh one (`sponsorEligible()` in `routes/auth.js`).
- Snoozed for 30 days by "Not now", for 180 days by opening the link, and permanently by "Don't ask
  again".
- `ST_HIDE_SPONSOR=true` turns it off; a permanent link sits in Settings → About.

**Self-hosted respect:**
- Later self-hosted signups are now `enterprise` with no trial clock, unless
  `SELF_HOSTED_SIGNUP_PLAN=trial` restores 2.x.
- No prompt, banner or pill renders; limit errors keep the plain message.

### 2.4 Branch and upgrade constraints

- `v3.0` was branched from `main` (2.6.1). `release/2.6.x` keeps receiving fixes, which can be
  merged forward. CI now builds `v3.0` pushes and PRs.
- The version on the branch is `3.0.0` (VERSION, server, webOS/Tizen/Vega literals, OpenAPI,
  release notes). The Android `versionCode` and the tag are left to `scripts/bump-version.sh` at
  release time.
- Every DB change is additive: 3 columns, 1 table, 1 one-time backfill. A code-only rollback to 2.6
  runs.

---

## 3. What changed (implementation map)

**Node 22**
- `server/lib/node-guard.js`: refuses to start below `engines.node` (exit 78) and runs first in
  `server.js`.
- `server/lib/upgrade-snapshot.js` (first boot of every new version).
- `RestartPreventExitStatus=78` in every shipped unit.
- `install-service.sh` templating.
- `upgrade.sh` checks the service's own `ExecStart` Node.
- CI matrix on `22.14.0` and `22`.
- `.nvmrc`.
- Docs.

**Server**
- `middleware/auth.js`: `tv` claim and `bumpTokenVersion`.
- `routes/auth.js`:
  - `accountSummary()` in `/me`: `trial`, `plan_name`, `plan_limits`, `plan_features`,
    `self_hosted`, `subscription_status`, `ui_mode`, `onboarded_at`;
  - `PUT /me` `ui_mode` / `onboarded`;
  - `POST /sessions/revoke-others`;
  - `signupPlan()`.
- `middleware/subscription.js`: `suggested_plan` on limit refusals, and `limit_hit` events.
- `routes/devices.js`: `plan_paused` per screen, using the player's own access check.
- `routes/subscription.js`: `POST /events`, `GET /funnel`.
- `lib/conversion-events.js`.
- `server.js`: content reads off the 30/min write budget.

**Frontend**
- `components/ui-mode.js`, `components/plan-nudges.js`.
- `views/onboarding.js`: browser-player path, sample image, trial block, server-side completion.
- `app.js`: first-run routing, banners on every `/me`.
- `index.html`: Add screen dialog reorder; `data-advanced` markers; menu switch.
- `views/billing.js`, `views/dashboard.js` (paused badge, toolbar), `views/device-detail.js`
  (simple-mode publish), `components/library/add-content.js` (Pro pill), `views/settings.js`
  (sign out everywhere else), `views/admin.js` (funnel), `main.css`, `en.js`.

---

## 4. Security review

**Scope:**
- **Auth and tenancy:** JWT, roles, SSO (SAML/OIDC), 2FA, API/agency tokens, support access,
  WebSockets, pairing.
- **Content and outbound:** uploads, zip handling, image decoding, SSRF on every outbound call
  site, the server-side Chromium, plugin loading, storage backends, OTA/updaters, webhooks.

**Overall:** the codebase is unusually well hardened. There is one `resourceAccess()` tenancy gate;
HS256 pinned with audiences; careful SAML/OIDC; a central SSRF guard with IP pinning; content-sniffed
uploads served sandboxed; signed template catalogue; no `eval`/`vm`. **No critical findings.**

### 4.1 Fixed in 3.0 (all additive, low-risk for an in-place upgrade, each with a test)

| # | Sev | Finding | Location | Fix |
|---|---|---|---|---|
| S1 | High | Server-side Chromium rendered layout zones and HTML/text widgets with **no request vetting**. A zone `remote_url` could screenshot cloud metadata or LAN pages through `GET /api/embedded/render-layout?preview=1`. | `lib/embedded-render.js` `renderWidgetOrHtml`, `renderLayout` | Same interception as the raster path (`guardRasterRequests`), and zone URLs through `assertSafeUrl` |
| S2 | High (support) / Med | Revoking access (support grant, removal, demotion, deletion, password change) did not reach **open dashboard sockets**, including PTY and device commands. | `ws/dashboardSocket.js`, `lib/pty-relay.js` | Write-tier socket actions re-resolve the session; PTY input re-authorised every 5 s; sockets dropped on deletion/revocation/role change, and removed from workspace rooms on membership removal |
| S3 | Med-High | Data-source `PUT` merged stored secrets into a config whose URL had moved to an attacker host. | `routes/data-sources.js` | Merge only when `sameSecretDestination` holds (as `/test` did) |
| S4 | Med | JWTs survived password change/reset, 2FA changes and logout-everywhere (7-day bearer). | `middleware/auth.js`, `routes/auth.js` | `users.token_version` + `tv` claim; bumped on password change/reset (self and admin), TOTP enable/disable, "Sign out everywhere else". The calling tab gets a fresh token. 2.x tokens count as version 0. |
| S5 | Med | Password-reset / verification / invite links built from the request **Host** when `APP_URL` was unset (reset-token theft). | `services/signupEmails.js`, `routes/workspaces.js`, `routes/admin.js` | `lib/public-origin.js`: `APP_URL` → `PUBLIC_HOSTS` allowlist → (self-hosted) request host → safe fallback; boot warning |
| S6 | Med | Workspace **viewers could pair screens** and receive an enrol key. | `server.js` `/api/devices/web-player`, `/api/provision/pair` | `denyReadOnly` |
| S7 | Med | Agency tokens and token targets kept write power after the owner was demoted to viewer. | `middleware/apiToken.js` `agencyGate`, `routes/tokens.js` | Re-check the owner's current role at use and on edit |
| S8 | Med | Zip bomb in HTML bundles: `unzipper.buffer()` inflated with no cap (an OOM reachable from a public bundle URL). | `lib/html-bundle.js`, `lib/bundle-inline.js` | `lib/zip-inflate.js`: real-byte capped inflate |
| S9 | Med | Import route: an **unauthenticated 2 GB upload** was left on disk; unbounded extraction was never removed. | `routes/status.js` | Auth before multer; cleanup in `finally`; capped extraction; startup sweep |
| S10 | Med | Cross-tenant content poisoning via **digest-named files** in an import. | `routes/status.js`, `lib/mesh/content-sync.js` | Digest names kept only when the bytes hash to them; never overwrite; mesh dedup re-verifies |
| S11 | Low-Med | Reports read play history by the device's *current* workspace (a moved screen leaked its history); CSV formula injection. | `routes/reports.js` | Filter on snapshotted `play_logs.workspace_id`; `csvCell()` escaping |
| S12 | Low-Med | Image decompression bomb; one shared decode worker with no limits. | `lib/image-ops*.js` | Header-dimension cap (~52 MP), worker `resourceLimits`, 60 s job timeout |
| S13 | Low | Org-admin could re-point an `allow_private` storage profile at LAN/loopback. | `routes/storage-profiles.js` | Reset `allow_private` on endpoint change by non-platform admins |
| S14 | Low | `group-talk-stop` cut another tenant's PA broadcast. | `ws/dashboardSocket.js` | Write access on the scope |
| S15 | Low | Workspace admin could set an org owner's/admin's direct row to viewer. | `routes/workspaces.js` | Mirror the DELETE guard |
| S16 | Low | `default_content_id` accepted from another workspace. | `routes/devices.js` | Same rule as `device-move` |
| S17 | Low | `certs/.jwt_secret` written world-readable; placeholder `JWT_SECRET` accepted. | `config.js` | 0600 on create and at boot; placeholder refused in production |
| S18 | Low | Device socket IP took `X-Forwarded-For` from anyone, so a remote device could claim loopback and get the host framebuffer on server-on-a-player builds. | `ws/deviceSocket.js` | Resolve with the same trusted-proxy list as Express |
| S19 | Low | Widget telemetry keyed by a bare device id (forge/read any screen's diagnostics). | `routes/widgets.js` | Namespaced by widget id |
| S20 | Low | Remote-thumbnail proxy used a bare `fetch` with redirects. | `server.js` | `guardedRequest` |
| S21 | Low | Import accepted arbitrary `remote_url` / `mime_type`. | `routes/status.js` | Same validators as `PUT /content/:id` |

### 4.2 Left open (deliberately), with reasons

| Sev | Item | Why deferred / recommendation |
|---|---|---|
| Med | **Fingerprint "reclaim"** re-issues a device token to anyone presenting a claimed device's fingerprint (`ws/deviceSocket.js` ~2548-2655). Fingerprints are not secret. | Changing reclaim changes field-recovery UX for every player. Recommend operator-approved re-adopt in 3.1, and stop returning fingerprints from `GET /api/devices/removed`. |
| Low-Med | **Device tokens stored in plaintext**, and the raw device row (token included) emitted in `dashboard:device-added` from `provisionViaReplica`; `live-publish-ws` accepts `?token=`. | Hashing at rest needs a token migration across every player family. Recommend stripping emits first (small), hashing in 3.1. |
| Low-Med | **CSP allows inline event handlers** (`script-src-attr 'unsafe-inline'`) while the session JWT lives in localStorage. | Needs a frontend sweep of inline `on*=`; pilot with `Content-Security-Policy-Report-Only`. |
| Low | `/api/reports/uptime` is still scoped by the device's current workspace. | Needs `workspace_id` on `device_telemetry` (schema change). |
| Low | Pairing codes are client-generated (Tizen uses `Math.random`); the lockout is per-IP and in-memory. | Server-issued codes with ≥40 bits and a TTL change the pairing protocol: plan for a player release. |
| Low | `player_url` for no-storage screens and the `/download` pages still build URLs from Host; OIDC/SAML `publicOrigin()` too. | Not emailed. IdPs validate redirect URIs, and changing SSO redirects without `APP_URL` would break hosted SSO. |
| Low | Admins cannot list or revoke *other members'* API tokens. | Additive endpoint; product decision. |
| Info | Org admins can opt out of widget sandbox isolation (by design, with confirmation). | Consider refusing on hosted, or a `sandbox` CSP on the render route. |
| Info | The instance updater does `git checkout v$X` without `git verify-tag`. | Requires signed tags in the release process first. |
| Info | ffmpeg/ffprobe run without `-protocol_whitelist file,pipe`. | Cheap hardening; uploads are content-sniffed first. |

**Checked and sound:**
- JWT algorithm and audience pinning; MFA-pending and typed transaction tokens.
- Login/TOTP/reset rate limits and lockouts; hashed single-use recovery and reset tokens.
- OIDC: PKCE, state, nonce, `email_verified`, no multi-tenant `common`, domain-verified org providers.
- SAML: signed assertions, audience, InResponseTo, replay.
- API token scope ladder and workspace binding.
- The IDOR sweep over ~20 route modules.
- WebSocket handshake auth with no client room joins.
- The central SSRF guard and its call sites; plugin install (platform-admin approval of a pinned
  tree hash).
- Template signing; Stripe/inbound webhook verification; `execFile`-only subprocesses.
- Parameterised SQL.

---

## 5. Verification

- **Unit and integration:** `cd server && npm test` on Node 22. The baseline before any change was
  5,897/5,897. Final totals are in the release summary.
- **Browser smoke:** `npm run smoke`, 58/58. It adds "a new signup is sent to the first-run guide"
  and "skipping is remembered by the account, not just this browser".
- **Simulated 2.6 → 3.0:**
  1. A 2.6.1 checkout seeded an account, an image and a playlist.
  2. The 3.0 branch then booted on the same data directory.
  3. It took `remote_display.pre-upgrade-…-from-pre-3.0.db` before migrating, applied the 3.0
     columns, kept the account on the full menu, and logged in with all data intact.
- **Node guard:** `node server.js` on Node 20.20 and on 18.19 exits 78 with the message;
  `ST_ALLOW_OLD_NODE=1` downgrades it to a warning.
