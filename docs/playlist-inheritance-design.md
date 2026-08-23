# Playlist inheritance

**Status: design settled, NOT built.** How a screen resolves which playlist it plays.

Decided 2026-08-23: walls beat groups; groups get a `priority` column; clearing an override falls
back to inherited. Still open: whether industry research (in flight) surfaces a tier we have not
modelled — tags, locations, or folder hierarchies — which would change the ladder, not the mechanism.

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

## What this fixes, concretely

- A group playlist change reaches members **because nothing was copied**, not because a loop
  remembered to visit them. (Same class as the trigger bug fixed on 2026-08-23, where
  `pushToDevices` selected `WHERE playlist_id = ?` and missed devices referencing a playlist only
  as a trigger target — a fan-out that forgot a case.)
- Multi-group membership gets a **stated** winner instead of a query-order accident.
- A per-device choice survives group edits, and the UI can finally say *"overridden — revert to
  group"*, because the row knows.

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

1. ~~Wall above group?~~ **Settled 2026-08-23: walls win.** See the note under the table.
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
