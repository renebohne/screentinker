# Move your organization to another server

ScreenTinker 3.0 can move an organization from one server to another as a guided job, instead of
rebuilding it by hand. Typical moves:

- from shared hosting (screentinker.com) to your own dedicated or self-hosted server;
- from one self-hosted server to a new machine;
- **recovery**: the old server is gone (crashed, deleted, unreachable) and all you have is an export
  zip you downloaded earlier.

There are two modes:

| Mode | Who | What |
| --- | --- | --- |
| **Import an organization** | an organization's owner or admin (or a platform admin) | one organization's export restored into **one** organization on this server: a new one (the default) or an empty one you own or administer |
| **Export / import the whole server** | platform admins only | one bundle with every organization, the accounts (with platform roles) and the instance settings that are safe to carry; each organization is restored through the same per-organization path |

An organization import never reads or writes anything outside its target organization: no other
organization, no platform users or roles, no app settings, plans, catalogs, mesh links or instance
branding. Only the whole-server mode touches instance-level state, and only to add what is missing.

Where to find it:

- **Settings → Data & privacy → Move to another server → Import an organization** (org owners and admins)
- **Settings → Data & privacy → Send your screens to a new server** (on the *old* server, after the import)
- **Platform → Data & privacy → Export or import the whole server** (platform admins)

---

## Step by step: shared hosting → your own server

### 1. Set up the new server (10–20 minutes)

Install ScreenTinker 3.0 (see `docs/operations.md` / the Docker compose example) and open it. The
first account you create is the platform administrator. You do not need to create anything else —
the import creates the organization for you.

> **"Rebuild after a disaster" is the same three steps:** install → create the admin account →
> restore from the zip (step 3, *Upload the file* or *imports folder*).

### 2. Export the organization on the old server (minutes; longer for large media libraries)

On the old server: **Settings → Data & privacy → Export the organization**. The export is prepared in
the background; when it is ready, either **Download** it, or keep the page open and use the download
link in step 3.

The export contains every row of the organization's data (secrets removed), its media and fonts, and
a manifest listing the **SHA-256 of every file in the zip**. That list is what the new server checks
everything against — it needs nothing else from the old server.

### 3. Bring the export in (new server)

**Settings → Data & privacy → Import an organization**, then one of:

- **Fetch it from the old server** (best for large organizations while the old server is up): on the
  old server, prepare the export, copy its download link (**it works for 15 minutes**) and paste it.
  The new server downloads it directly, resumes with HTTP `Range` if the connection drops (paste a
  fresh link if the old one expired), and checks the whole file against the `X-Export-SHA256` the old
  server sent. Outbound requests follow the usual rules (`docs/outbound-requests.md`): a private or
  internal address is refused unless the operator opened it with `OUTBOUND_ALLOW_HOSTS` /
  `OUTBOUND_ALLOW_PRIVATE`.
- **Upload the file**: choose the zip. It is sent in 8 MB chunks; a dropped connection or a closed tab
  continues from where it stopped (choose the same file again).
- **From this server's imports folder** (platform admins only): copy the zip onto the server with
  `scp`/`rsync` into `$DATA_DIR/imports/` (for Docker, the `imports` folder of the data volume), then
  pick it from the list. **Recommended for very large organizations and for disaster recovery.** The
  list shows only plain `.zip` files directly in that folder; symbolic links, sub-folders and any path
  typed in a browser are refused, and the file itself is never deleted by the import.

### 4. Check (seconds to minutes)

Before anything is written, every entry of the zip is checked against the manifest's SHA-256 list,
and every row is checked to belong to the exported organization. You then see:

- the workspaces, screens, people and everything else in it;
- the media size against the room on your plan and the free disk on this server — an organization
  that does not fit is refused **before a byte is written**;
- what will not come across, and why (below);
- what you will need to reconnect.

### 5. Choose and import

Import into **a new organization** (the default; you become its owner) or **an empty organization**
you own or administer ("empty": no screens, media, playlists, widgets, layouts, schedules, signs or
data sources yet; the import adds its workspaces beside the existing ones). Choose whether to bring
the history (proof of play, version history, the activity log as read-only history).

The import runs in the background and survives a restart of the server: it resumes at the batch it
had reached. If it fails it **rolls back by itself** — a new organization is deleted with everything
it received; in an existing organization the workspaces and organization-level rows the import
created are removed. If even the rollback fails, the job is marked **partly imported** with a
*Delete the partial organization* button.

### 6. Invite your people

Members arrive as **pending invites** with the roles they had (workspace role, and organization role
for owners and admins). The importing admin is the owner and needs no invite. If this server can send
email you can email the invites; otherwise copy each link and send it yourself. Someone who already
has an account on this server joins the organization when they accept; nothing else about their
account changes. Invites last 14 days.

### 7. Move your screens

Every screen arrives with its name, groups, playlist, schedules and settings — but no player is
attached yet: device tokens never leave a server. The new server gives each screen a fresh enrolment
key. Then, the first way that applies:

**a. Handover (old server still running, and on 3.0 with this feature).**

1. New server: *Move your screens → Download the handover file*. It lists, per old screen id, this
   server's address and the enrolment key that screen should arrive with. **Treat it like a password**
   (it lets a player join as your screen) and delete it once used.
2. Old server: **Settings → Data & privacy → Send your screens to a new server**, choose the file,
   check the list, confirm. Each screen of *this organization* named in the file gets the existing
   "switch server" command (`set_server_url`, the same command as the workspace's *Move to a new
   server*); screens of any other organization are ignored whatever the file says.
3. What each player does:

| Player | What happens |
| --- | --- |
| **Android app** | checks the new address answers, switches, is told its old id is unknown here, clears it and asks for a pairing code — and the **fingerprint** it presents is the one the imported screen carries (`device_fingerprints` travels with the export), so it is handed the imported screen at once. No pairing code to type. |
| **Web player** (browser, kiosk, vMix, BrightSign web) | navigates to the new server's `/player?k=<new key>` and arrives already enrolled as the imported screen. |
| **Other native players** | if the player supports `set_server_url`, it switches and shows a pairing code; type it next to the screen (*Pair*), and the player takes over the imported screen. If it does not, change the server address on the device, then pair the same way. |
| **Offline screens** | they get the command when they next connect to the old server — while it still runs. Otherwise use b/c/d. |

**b. DNS.** If the old server's address can be pointed at the new machine, Android players reconnect
on their own: their device token is not on the new server (tokens are never exported), so they are
told their id is unknown, re-pair with their fingerprint and land on the imported screen exactly as
in (a). Web players opened with an old enrolment link show a pairing code instead (the key belonged
to the old server) — use (d).

**c. The enrolment link** (web players): copy the screen's *Player link* and open it on the screen.

**d. Pair into the imported screen**: once the player reaches the new server it shows a pairing code;
type it next to the screen in the list. The player keeps its own identity and takes over the imported
screen's name, groups, wall seat, playlist, schedules and history.

When the old server is **gone** (recovery), (a) is not possible: nothing can tell its players to
switch, and they keep trying the dead address until the address is pointed here (b) or they are moved
by hand (c/d).

### 8. Reconnect your integrations

Secrets never leave a server, so these arrive **switched off** with a checklist: single sign-on
(client secret; verify the domain again), SCIM (new token), Microsoft 365 and cloud folders, Canva,
dashboard (BI) connections, social connections, meeting-room connections and ICS calendars, storage
buckets, AI providers (API keys), data sources with credentials (e.g. **Square / Shopify access
tokens**, authenticated REST feeds), automation hooks (rotate to get a new URL), triggers (copy the
new trigger address), API tokens and outgoing webhooks (create new ones). **Passkeys** are bound to
the old server's address and cannot move: people sign in with their password or SSO and add a
passkey again. Site cache boxes must be set up again (`docs/site-cache.md`).

### 9. Finish

Check the new server, point your DNS at it if you kept the address, then delete the organization on
the old server (*Settings → Data & privacy → Delete everything*) or cancel the hosted plan.

---

## What moves, and what you must redo

| | Moves | You redo |
| --- | --- | --- |
| Workspaces, media (files and thumbnails, re-hashed), folders, fonts, shaders | ✓ | |
| Playlists (nested, per-item schedules, published snapshots), layouts and zones, schedules, power schedules | ✓ | |
| Signs and slide decks, brand kits, translations, widgets, kiosk pages, QR links | ✓ (a QR or request-form code already taken on the new server gets a new one) | reprint QR codes whose code changed, or keep the old address pointing here |
| Screens, groups, walls, endpoints, saved screen settings, energy and language settings | ✓ (offline, no token) | move the screens (step 7) |
| Data sources, CAP/social/room feeds, experiments, request forms, content requests | ✓ (credentials removed) | re-enter credentials |
| Alerts, screen verification settings, freshness, accessibility, energy settings | ✓ | |
| Version history, approvals, proof of play, device logs, activity log | optional, as read-only history (the activity log keeps who did what as text) | |
| People | as pending invites (organization import) or accounts (whole server) | accept invites / set passwords |
| SSO, SCIM, M365, Canva, BI, social, rooms, storage buckets, AI keys | configuration only, switched off | reconnect (step 8) |
| API tokens, outgoing webhooks, trigger tokens, hook secrets, device tokens, passkeys, 2FA secrets | never | create new ones |
| AI credits, plugin approvals, the old server's outbound log, scheduled deletions, site cache boxes | never (they belong to the old server) | |

Every table the export carries is either restored or listed as "not restored" with its reason;
`server/lib/trust/import-tables.js` is the complete list and `test/trust-export.test.js` fails if a new
table or id column is left undecided.

## Whole server (platform admins)

**Platform → Data & privacy → Export or import the whole server.**

- **Export** makes one bundle: `instance-manifest.json` (every organization with its SHA-256, the
  instance tables, and the digest of every entry), `orgs/<id>.zip` (each organization's ordinary
  export, byte for byte, with its own manifest and digests) and `instance/tables/*.jsonl`: the
  accounts (no password hashes, 2FA secrets or other secrets — the same redaction as every export,
  platform roles included), the plan catalog (no billing ids), app settings minus anything
  credential-like or install-specific, and template catalogs added by hand. Same background job,
  15-minute download link, 24-hour retention and audit rules as organization exports; at most three a
  day.
- **Import** (pull, upload, or the imports folder — recommended for big instances and recovery):
  every organization becomes a child job restored through the same per-organization path. One
  damaged organization does not stop the others: it is listed with the reason and can be retried on
  its own. Each organization is given back to its own owner.
- **Accounts** are recreated **without passwords** (the export never contains them): people use
  *Forgot password* (when email is configured) or a **set-password link** the platform admin copies
  from the result page (valid one hour). SSO accounts sign in through their provider once it is
  reconnected. An email address that already has an account on the new server keeps that account
  unchanged. Platform roles are restored only in this mode.
- Instance settings are only **added**: a plan, setting or catalog the new server already has is
  never overwritten.

## Who can do what

| Action | Who |
| --- | --- |
| Import into a new organization | organization owners/admins, platform admins |
| Import into an existing empty organization | its owners/admins, platform admins |
| See an import | the person who started it, owners/admins of the organization it restored into, platform admins |
| Use the imports folder, export/import the whole server, set-password links | platform admins only |
| Send screens to a new server (old server) | owners/admins of that organization; only its own screens |
| Pair a screen into an imported screen | owners/admins of the imported organization |

An organization admin can never target another organization. Storage and screen limits are the
importing person's plan's, checked before anything is written. One import runs at a time per
organization, and at most ten are started per organization per day.

## Security notes

- **Integrity:** each entry is checked against the manifest's SHA-256 at the scan and again while it is
  restored; a missing, extra, truncated or altered entry refuses the archive. In a pull, the whole file
  is also checked against the digest the old server sent. The manifest itself is not signed: the check
  catches damage and edits of the archive's contents, not someone forging a whole new export — treat
  export files as sensitive (they contain your organization's data).
- **Untrusted input:** names are normalised (no `..`, absolute paths or drive letters — zip slip),
  symbolic links and unexpected entries refuse the archive, and every entry is inflated counting real
  bytes against the size the manifest lists (zip bombs).
- **Tenancy:** a row that does not belong to the exported organization refuses the whole archive, and a
  reference to anything not in the archive is dropped rather than kept (it could name another
  organization's row on this server). Ids inside JSON that are not in the archive are replaced with
  ones that name nothing (except inside URLs).
- **Never overwrites:** every row gets a new id; media files keep their names only where the name is free
  (or already holds the same bytes) and otherwise get new ones; unique public codes that are taken get
  fresh ones.
- **SSRF:** the pull goes through the outbound guard (no loopback, link-local, metadata or private
  addresses unless the operator allowed them; redirects re-checked).
- **The handover file** carries enrolment keys for your screens: keep it private and delete it after use.
- Every step is audited (`trust.import_*`, `trust.screens_handed_over`, `trust.export_instance_*`).

## How long it takes

Rough figures on ordinary hardware; media transfer dominates.

| Organization | Export | Transfer | Check + import |
| --- | --- | --- | --- |
| Small shop: 5 screens, 200 MB media | < 1 min | < 1 min | < 1 min |
| Chain: 100 screens, 20 GB media, a year of proof of play | 5–15 min | 5–30 min (link speed) | 5–15 min |
| Large estate: 1,000+ screens, 200 GB+ | 1 h+ | use the imports folder (rsync) | 30 min – 2 h |

Moving the screens takes seconds per screen with the handover (online Android and web players), and
a minute or two per screen by hand.

## Troubleshooting

- **"This export has no integrity list"** — it was made before this feature. Export again on the old server.
- **"…does not match the manifest"** — the zip was damaged in transit or edited. Download it again.
- **"rows that do not belong to its organization"** — the archive was edited by hand. Export again.
- **"This server will not fetch from that address"** — the old server is on a private address; allow it
  with `OUTBOUND_ALLOW_HOSTS=<host>` on the new server, or upload the file instead.
- **The pull stopped ("Interrupted")** — paste a fresh download link for the same export; it continues.
- **"It does not fit here"** — free disk space, or a plan with more storage/screens, then try again.
- **A screen did not move** — it was offline, or its player cannot switch by itself: point it at the new
  address on the device and pair it into its imported row.

## API (all JWT-only, under `/api/org-import`)

`GET /context` · `GET /disk` (platform) · `GET|POST /jobs` · `GET /jobs/:id` ·
`PATCH /jobs/:id/upload` (raw bytes, `Upload-Offset`) · `POST /jobs/:id/link` (fresh pull link) ·
`POST /jobs/:id/restore` `{ target: { mode: 'new'|'existing', name?, organization_id? }, options }` ·
`POST /jobs/:id/cancel` · `POST /jobs/:id/discard-partial` · `GET /jobs/:id/invites` ·
`POST /jobs/:id/invites/send` · `GET /jobs/:id/screens` · `GET /jobs/:id/handover` ·
`POST /jobs/:id/screens/:deviceId/pair` · `POST /handover` (old server) ·
`GET|POST /instance-exports`, `POST /instance-exports/:id/link`, `GET /jobs/:id/accounts`,
`POST /accounts/:userId/password-link` (platform). Public: `GET /api/public/instance-export/:id?key=`.
The organization export download (`/api/public/trust-export/:id`) now honours `Range` and sends
`X-Export-SHA256`.
