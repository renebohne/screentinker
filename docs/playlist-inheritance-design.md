# Playlist inheritance

**Status: BUILT. Ladder settled (specificity); resolver, backfill, all writers, schedules-as-a-tier
and the UI are committed. One open question remains, at the bottom.**
How a screen resolves which playlist it plays.

Decided 2026-08-23: walls beat groups; groups get a `priority` column (shipped, inert, `d58bf10`);
clearing an override falls back to inherited.

⚠️ **Reopened, then closed the same day: the specificity ladder stands.** Industry research across
17 vendors found that **"the most specific level wins" is nobody's model** — see *"What the research
changed"* — and FWI's per-assignment Behavior selector was the strongest alternative. Decision: keep
the ladder, because it fixes the actual defect (twelve eager writers and no precedence), and because
mirroring `schedules.js` means our two inheritance systems cannot drift. The Behavior selector
remains the natural next step if per-assignment intent is ever needed; nothing here forecloses it.

Separable from playlists-of-playlists and worth doing first: this is a defect-shaped problem that
exists today, independent of whatever we decide about nesting.

## The problem, stated precisely

`devices.playlist_id` has **one reader and twelve writers.**

The reader is `buildPlaylistPayload()` (`server/ws/deviceSocket.js`), which does exactly this:

```js
if (device?.playlist_id) { …load that playlist's published_snapshot… }
```

The writers are spread across seven files — group join, group leave, group-playlist change, direct
device assign, playlist→device assign, video-wall create, video-wall playlist change, video-wall
delete, workspace import, and an explicit clear:

```
routes/device-groups.js   4 sites   join / leave / set / fan-out to all members
routes/video-walls.js     3 sites   wall playlist change, delete, membership
routes/playlists.js       1 site    POST /playlists/:id/assign
routes/assignments.js     1 site    device assignment path
routes/devices.js         1 site    clear
routes/status.js          2 sites   workspace import / restore
```

**Precedence requires one resolver. We have twelve writers and none of them is the resolver**, so
there is no precedence — only whoever wrote last. Three consequences, none documented:

1. **A device in two groups has no defined winner.** The leave-handler picks "any remaining group
   that has a playlist", which is whatever SQLite returns first.
2. **A hand-set per-device playlist is silently destroyed** the next time anyone touches that
   device's group, or the wall it belongs to.
3. **"This screen overrides its group" cannot be expressed at all**, because the copy erases the
   distinction between *inherited* and *chosen*. Nothing in the row records which it was.

## ⚠️ We already have the answer, in the same codebase

Schedules resolve the same shape correctly — lazily, at read time, with an explicit rule
(`server/routes/schedules.js`):

```sql
ORDER BY
  CASE WHEN s.device_id IS NOT NULL THEN 1 ELSE 0 END DESC,   -- device beats group
  s.priority DESC,
  s.created_at ASC
```

Device-specific beats group; then priority; then oldest wins. Change a group schedule and every
member picks it up on the next read, because nothing was ever copied.

So the design question is not "what should inheritance look like" — it is **"why do our two
inheritance systems disagree, and can base playlists adopt the one that already works?"**

## Proposed model

**One resolver, `resolveDevicePlaylist(deviceId)`, in `server/lib/`, called by
`buildPlaylistPayload()` and by every UI path that needs to show what a screen will play.**

Resolution order, deliberately mirroring the schedule rule so the two cannot drift:

| # | Source | Notes |
|---|---|---|
| 0 | **Active schedule** | `scheduled_playlist_id`, written by the scheduler while it runs |
| 1 | **Device override** | explicitly chosen for this screen |
| 2 | **Video wall** | a wall member plays the wall's playlist — the wall IS the intent |
| 3 | **Group**, highest `priority`, then oldest | via a new `device_groups.priority`, as schedules have |
| 4 | *(nothing)* | the existing "nothing scheduled" idle path |

⚠️ **Walls above groups. DECIDED — do not re-open without a reason this does not cover.**

A wall is a physical construction: several panels showing one image, with geometry, and members
that are followers of a leader. A group is an organisational convenience — "the lobby screens".
When the two disagree, honouring the group tears the picture in half across the seam, which an
operator sees instantly and cannot explain from the UI, because nothing on the wall page would say
a group had overruled it.

The asymmetry is what settles it: a wall member playing the group's playlist is **visibly broken**;
a grouped screen playing the wall's playlist is merely **not what you asked for**. Where a
precedence rule has to guess, it should guess toward the failure that is legible.

### The migration is the hard part, and it is where this could go wrong

Today `devices.playlist_id` cannot tell us whether it was **chosen** or **copied**. So a naive
"NULL means inherit" reinterpretation would classify every existing device as an explicit override,
and group changes would silently stop propagating — a regression that would look like the feature
was broken, on estates already in the field.

Proposal: add **`devices.playlist_source TEXT`** (`'device' | 'group' | 'wall'`, NULL = unknown) and
backfill it by comparing what is there against what the new resolver *would* pick:

- device's `playlist_id` equals the playlist its group/wall would give it → `'group'` / `'wall'`
  (it was almost certainly a copy — it keeps inheriting, behaviour unchanged)
- differs → `'device'` (someone chose it — it becomes an override, behaviour unchanged)
- `playlist_id IS NULL` → NULL (inherits, behaviour unchanged)

**Every existing device keeps playing exactly what it plays today**, and from then on the
distinction is recorded rather than guessed. That property is the whole point of the backfill: a
migration that changes what is on any screen is not acceptable here.

### What the twelve writers become

They stop writing `devices.playlist_id` except when the user genuinely means "this screen, this
playlist" (then `playlist_source='device'`). Group and wall paths write only the group/wall row and
push — the resolver does the rest. That deletes the fan-out loops entirely, including the one in
`device-groups.js` that walks every member on a group playlist change.

## ⚠️ What building it found — the reader list in this document was wrong

The document said `devices.playlist_id` has **one reader**. It has **seven**, and the six that were
missing are the ones that would have broken silently:

| Reader | What it does with the column |
|---|---|
| `ws/deviceSocket.js` `buildPlaylistPayload` | the known one |
| `groupSyncMembers` | **group sync membership** — `WHERE d.playlist_id = group.playlist_id` |
| `deviceSyncGroup` | the device's own sync group, same match |
| `groupSenderEligible` | decides whose sync broadcasts are **trusted** |
| `routes/assignments.js` `ensureDevicePlaylist` | returns it, or creates one |
| `services/scheduler.js` (×2) | reads it to decide whether to apply/revert a schedule |

Group sync defines an eligible member as *a member whose `playlist_id` equals the group's* — that
is, it reads **the copy the old fan-out left behind** to decide who plays in lockstep. Stop copying
without touching those queries and every member fails the match, so no group ever syncs again, and
nothing errors. They now join `device_resolved_playlist`.

⚠️ **`services/scheduler.js` is a fifteenth writer, and a second inheritance system.** It writes the
active schedule's playlist straight into `devices.playlist_id` and remembers the previous value in
an **in-memory Map** — so a server restart during an active schedule strands that device on the
scheduled playlist permanently. For now the scheduler stamps `playlist_source = 'device'` and
restores the previous *source* as well as the previous id, which preserves today's behaviour exactly.
That is a stopgap and should be read as one: **schedules belong above `device` as their own tier in
the view, resolved live from the schedules table**, which would delete the Map and the bug with it.

### The view broke a migration, on every install

The two views were first defined inside the migrations array. The tenant delete-cascade migration
rebuilds tables the SQLite way — create new, copy, drop old — and SQLite refuses to drop a table a
view still references:

```
[tenant-cascade] Migration FAILED: error in view device_inherited_playlist: no such table: main.devices
```

They now run **after** every table-rebuilding migration. ⚠️ A view is not a statement you can order
casually; it is a dependency on every table it names, enforced against all later schema surgery.

### ⚠️ An unclassified id must still play — the staged-migration property

The first working view resolved `playlist_source IS NULL` as "inherits", full stop. That turned
**12 tests red** the moment it went into `buildPlaylistPayload`, and the reason generalises well
beyond the tests: NULL means *both* "inherits" and "a writer set `playlist_id` and never heard of
this column". The second case is not hypothetical — the group and wall fan-outs are not converted
yet, and workspace import/restore writes the id directly. Every one of those devices resolved to
**nothing**.

The view now falls back to the raw `devices.playlist_id` as a **last resort, below the inherited
sources**. A stale copy still loses to the group (which is the whole point), but an unconverted
writer keeps working exactly as it does today. That is what makes the rest of this migration
stageable: each writer can be converted on its own, and nothing goes dark in between.

### `playlist_source` has four values, not two

`'device'` / `'group'` / `'wall'` was the proposal. Building the backfill produced a fourth:
**`'none'`** — *deliberately plays nothing*. Devices that sit in a group with a playlist but hold no
playlist of their own are dark today (usually because the old clear wrote `playlist_id = NULL`).
Letting them simply inherit is correct under the new model and would **light up screens during an
upgrade**, which this document forbids. They are stamped `'none'`, which an operator can revert.

⚠️ The first cut of the view ignored `'none'` entirely, so those screens inherited anyway. Caught by
the migration-invariant test, not by review — the backfill and the view have to agree about a value,
and only one of them knew about it.

Note that `'group'` and `'wall'` never need storing: they are *derived*, so the view computes them.
Only `'device'` and `'none'` are facts about the row.

## What this fixes, concretely

- A group playlist change reaches members **because nothing was copied**, not because a loop
  remembered to visit them. (Same class as the trigger bug fixed on 2026-08-23, where
  `pushToDevices` selected `WHERE playlist_id = ?` and missed devices referencing a playlist only
  as a trigger target — a fan-out that forgot a case.)
- Multi-group membership gets a **stated** winner instead of a query-order accident.
- A per-device choice survives group edits, and the UI can finally say *"overridden — revert to
  group"*, because the row knows.

## ⚠️ What the research changed

Three agents, 17 vendors, three tiers. Two findings move this design and one validates it.

### 1. Nobody implements "most specific wins"

The ladder below is a specificity rule: device beats wall beats group. **No surveyed vendor does
this.** The alternatives actually in use are:

- **Additive rotation** — every applicable playlist plays, in turn. Korbyt: *"A Normal schedule will
  rotate with other playlists… from the most recently updated playlists to the oldest."* 22Miles
  puts one player in three groups *plus* its own schedule and expects them to combine. Xibo returns
  every matching event across all nested groups and lets the player sort it out.
- **Structurally impossible** — Navori, Poppulo Cloud, BrightSign, MagicINFO, Appspace and Carousel
  all enforce **one group per device**, so the conflict cannot arise. The industry largely *designed
  the problem away* rather than solving it.

We allow multi-group membership, so we cannot take the second option without removing a feature.
That leaves specificity (nobody's model) or additive (several vendors' model).

### 2. ⭐ The best answer found: precedence as an explicit per-assignment choice

Legacy Four Winds attaches a four-valued **Behavior** selector to each location-level playlist
assignment:

> • **Include only if the player is empty** • **Always include before** player templates
> • **Always include after** player templates • **Override** player templates

This is better than either alternative, and it is worth restructuring around. It makes precedence an
**author's stated intent per assignment** rather than a global rule buried in a resolver, and it
covers fallback-only, merge-before, merge-after and hard-override in one control. It also dissolves
the specificity-vs-additive argument: *both* are expressible, per assignment.

⚠️ It does not remove the need for `device_groups.priority` — with several group assignments all set
to "include after", something still has to order them. Priority remains the tiebreak.

### 3. Validated: live resolution, never copy-on-assign

**Unanimous across all 17.** Nobody copies content down a hierarchy at assign time. The universal
proof is that deleting a child *damages* every parent, which copy semantics could not do. Scala:
*"Deleting playlists in use will remove them from schedules or master playlists."* Navori:
*"Changes made to a global playlist will affect every sub-group where the playlist is used."*

So the core of this document — replace twelve eager writers with one lazy resolver — is the industry
norm, and our current eager-copy fan-out is the outlier. That part is not in question.

⚠️ **One qualification worth stealing (Scala): placement-scoped properties.** Content is shared live,
but duration/transition/conditions are stored **per placement** — *"applies to the item only in that
playlist."* A third state between "inherited" and "overridden" that our two-valued
`playlist_source` does not model.

### 4. Delegation is a real feature elsewhere, and we have nothing like it

"Locked slots" and "share of voice" are **not** the enterprise vocabulary for corporate-vs-local —
both terms exist but mean ad inventory. The purpose-built mechanism is **Signagelive's Local
Playlists + Local Users**: corporate places a control asset at a chosen position in the master and
sets guardrails (**Maximum Number of Assets** — the reserved-slot cap — plus play mode, duration,
order, and per-player variants). Local users are a separate privilege tier, tag-restricted to a
content subset. The admin never fills the slot: *"How do I add content to my Local Playlist? The
short answer is you don't."*

Out of scope here, but it is the feature this design would eventually need to support, and the
resolver should not make it harder to add.

## Where this stands, and what is left

**Built and committed** (this is the mechanism, not the cleanup):

- `device_inherited_playlist` / `device_resolved_playlist` views — the rule, in SQL, once
- `lib/resolve-device-playlist.js` — the point lookup
- `devices.playlist_source` + `lib/playlist-source-backfill.js`, with `verifyNoDeviceChanged`
  running at boot and aborting the migration rather than changing what a screen plays
- every **reader** converted: the payload builder, the three group-sync queries,
  `ensureDevicePlaylist`, the device-detail page
- every **fan-out** converted (`pushToDevices`, display count, delete-affected, mute, zone guard) —
  these keyed on the copy, so they skipped precisely the devices that inherit
- explicit choices stamp `'device'`; clearing an override falls back to inherited

Backfill verified against a real database (35 devices: 20 overrides, 15 inheriting, **0 changed**).

**The eager copies are gone.** Group join/leave/assign-playlist, wall playlist-change/delete/
membership, and workspace import/restore no longer write a playlist onto a device row. Membership
*is* the assignment. Three consequences are now covered by tests:

- joining a group no longer destroys a playlist chosen for that screen
- a group playlist change reaches members that joined afterwards, because nothing was copied
- leaving a group or wall no longer strands the screen on the shared playlist

⚠️ **Leaving needs `clearInheritedCopy`.** The view's last-resort branch would otherwise resurrect a
stale copy the moment inheritance ended — "remove this panel from the wall" would leave the wall's
content playing on it. The helper drops the copy and *only* the copy: a row marked
`playlist_source = 'device'` is an operator's decision and is left alone.

⚠️ **Two more readers of the copy, found the same way as the first six**: `syncDecisionFor`
(`device-groups.js`), which would have told the dashboard a group's sync was downgraded when every
member merely inherited; and the content-delete fan-out (`routes/content.js`), which would have left
inheriting screens showing content no longer on disk. **Eight readers, not one.**

⚠️ **A bug the resolver does NOT fix, found on the way.** `POST /groups/:id/assign-content` loops
over member *devices*, and members of a group with a shared playlist all resolve to the *same*
playlist — so adding one image to a group of five inserted it five times. Pre-existing (the old copy
made every member's `playlist_id` identical too). Now de-duplicated by playlist.

### Schedules are a tier now, and the Map is gone

⚠️ **It cannot be a subquery.** "Active now" depends on the device's timezone and is evaluated in JS
(`lib/schedule-eval`), so the resolver cannot derive it. The scheduler still decides — it just
records its decision somewhere that does not destroy the operator's:

- `devices.scheduled_playlist_id` and `scheduled_layout_id` are the view's **top tier**, above a
  device override and above `'none'` (a deliberately dark screen must still be schedulable).
- The scheduler writes *only* those columns. It never touches `playlist_id`, `playlist_source` or
  `layout_id`.
- "Revert" is **clearing a column**, not restoring something remembered. `activeOverrides` is
  deleted, and with it the bug where a restart during an active schedule lost the Map and stranded
  the device on the scheduled playlist *permanently* — nothing on the row had recorded that the
  change was temporary. Every tick is now idempotent and self-healing across a restart.

`resolvedLayoutId()` covers the layout half, which had the identical bug one column over.

**Left to do:**

1. `assignments.js` `ensureDevicePlaylist` still returns the shared playlist for an inheriting
   device, so "add content to this screen" edits the group's playlist and therefore every screen in
   it. Pre-existing, deliberately unchanged here, and worth its own decision.

### The view SQL lives in one module, because a fixture pasted a schema

`routes/content.js`'s delete fan-out started resolving inheritance, and
`test/operator-permissions.test.js` went red with *"no such table: device_resolved_playlist"*. That
test hand-builds a minimal in-memory schema and injects it as the db module, so the migrations never
run — a fixture that had quietly drifted from the real database.

Pasting `CREATE VIEW` into the fixture would have made the drift worse. The definition now lives in
`server/lib/playlist-resolver-sql.js` and both the boot migration and the fixture call
`applyResolverViews(db)`. ⚠️ Any fixture that hand-builds `devices` now needs `playlist_source` and
`wall_id` on it, plus `video_walls`, `device_groups` and `device_group_members` — which is the point:
the failure is loud instead of a test proving things about a database that does not exist.

### UI

The device page now shows where its playlist came from — *"Inherited from Lobby"* or *"Set for this
screen"* with a **Use inherited** button. This is the question the dashboard could not previously
answer at all: the id was copied down, so a chosen playlist and an inherited one were the same byte.
`GET /api/devices/:id` returns `playlist_source` and `playlist_source_name` (naming the group or wall
rather than saying "inherited" and leaving the operator to hunt).

⚠️ **Run both SQLite drivers.** CI's `node:sqlite` job caught a resolver test that compared a result
row with `deepEqual`: `node:sqlite` returns **null-prototype** rows, better-sqlite3 returns plain
ones. `resolveDevicePlaylist` now normalises its own return shape. A local run exercises one driver
only — `ST_SQLITE_DRIVER=node node --test` runs the other.

## Risks, and the one that matters most

⚠️ **The structural fingerprint.** The player restarts playback when this changes
(`server/player/index.html`):

```js
`${a.content_id}|${a.widget_id}|${a.widget_rev}|${a.zone_id}|${a.remote_url}|${a.filepath}|…`
```

Resolution changing which playlist a device gets is a *legitimate* restart. But a refactor that
changes the resolved playlist for a device that should not have changed causes an estate-wide
restart at item 1 — the `#234` shape. **The backfill above is what prevents this**, and it is the
one part that must be verified against a copy of real data before it runs anywhere.

Lesser risks:

- **Read cost.** Resolution moves from a column read to a small join, on every payload build. Bounded
  and cacheable, but it is on a hot path.
- **`assignments.js:56`** (`if (device?.playlist_id) return device.playlist_id`) is a second, older
  reader that must move to the resolver or it will disagree with the device.
- **Import/restore** (`routes/status.js`) rebuilds these ids wholesale and must set
  `playlist_source` too, or restored workspaces come back with every device an override.

## Verification

- A migration test against a **copy of a real database**: assert that for every device, the playlist
  the new resolver returns is byte-identical to `devices.playlist_id` before migration. Anything
  else is a screen changing content during an upgrade.
- Table-driven resolver tests: device-only, group-only, wall-only, device+group, device+wall,
  two groups (priority), two groups (equal priority → oldest), nothing.
- ⚠️ Mutation-test every one of those. A resolver test that passes against a broken precedence
  ordering is worth nothing, and this session has already produced three tests that could not fail.

## Open questions for the user

0. ~~Is the ladder a specificity rule at all?~~ **Settled: yes, keep it.** FWI's per-assignment
   Behavior selector is the better long-term model and is recorded above, but the ladder is what
   fixes the defect in front of us and it keeps base playlists and schedules resolving the same way.

1. ~~Wall above group?~~ **Settled 2026-08-23: walls win** — and this survives either model, because
   a wall member playing anything but the wall's playlist is visibly broken. See the note under the
   table.
2. ~~Group `priority` column?~~ **Settled 2026-08-23: add `device_groups.priority INTEGER DEFAULT 0`**,
   matching `schedules.priority`, with the same `priority DESC, created_at ASC` tiebreak.

   ⚠️ The reason is *explainability*, not determinism — join-order would also be deterministic. When
   an operator asks "why is this screen showing the wrong thing?", the answer must not be "because
   of the order it joined two groups eighteen months ago", which is invisible in the UI and
   unfixable without understanding it. A priority is a number they set and can see.

3. ~~Clearing an override?~~ **Settled 2026-08-23: falls back to INHERITED**, never to nothing.

   Matches the mental model already written into `device-groups.js` ("joining a group means using
   its playlist, or none"). Clearing an override means "stop being special", not "go blank" — and a
   clear that blanks a screen is a destructive action wearing the costume of an undo.

   Concretely: clearing sets `playlist_source = NULL` and leaves `playlist_id` to the resolver. It
   does **not** write `playlist_id = NULL`, which is what `routes/devices.js` does today and is why
   clearing currently strands a screen.
