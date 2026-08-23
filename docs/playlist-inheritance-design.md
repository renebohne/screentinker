# Playlist inheritance

**Status: mechanism settled, LADDER REOPENED by research. Not built.**
How a screen resolves which playlist it plays.

Decided 2026-08-23: walls beat groups; groups get a `priority` column (shipped, inert, `d58bf10`);
clearing an override falls back to inherited.

⚠️ **Reopened the same day.** Industry research across 17 vendors found that
**"the most specific level wins" is nobody's model** — which is precisely what the ladder below
assumes. See *"What the research changed"*. The single-resolver mechanism survives intact; what is
in question is the rule it applies.

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

0. ⚠️ **REOPENED — is the ladder a specificity rule at all?** Research says nobody resolves content
   by "most specific level wins". The strongest alternative is FWI's per-assignment **Behavior**
   selector (empty-only / before / after / override), which expresses both models and makes the
   intent explicit. This is now the biggest open question in the document, and it sits *above* the
   three below — they are all tiebreaks within a rule we may be replacing.

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
