# Playlists of playlists

**Status: PHASE 1 BUILT (stateless). Phase 2 (cursored) not started.** A playlist that can contain
another playlist as an item.

Researched against 17 vendors in three tiers (open/SMB, enterprise, hardware-vendor CMS). Where a
claim below is sourced it is because it changes a decision; where the industry could not be
established, that is said rather than smoothed over.

## ⚠️ The finding that decides the architecture

Two research tiers appeared to contradict each other outright:

- Open/SMB and hardware tiers: *"nesting is resolved before the player sees it."* Xibo flattens in
  `expandWidgets()` before the XLF is built; BrightSign inlines super states into `autoplay-*.json`.
- Enterprise tier: *"unanimous — the player resolves nesting at runtime. Not one vendor flattens."*

**Both are correct. The split is not by vendor, it is by whether the nested playlist has a CURSOR.**

A cursored sub-playlist plays *some* of its items per parent rotation and remembers where it got to.
Scala: *"play this many items each time"* — five ads at N=1 means *"all five will have played once
the entire master playlist has repeated five times."* Signagelive's "Play one" mode: *"sequentially
playing the next asset with each rotation."*

**A flat list cannot express "on the third loop of the parent, play items 5–6 of the child."** The
state lives across parent rotations, so resolution must live in the player. Corroboration is strong
rather than inferred: `Pick N media items from a sub-playlist` appears as a **certified player
capability** in Scala's per-model matrix, and Korbyt's embedded-playlist support is a **versioned
firmware** feature (Samsung SoC agent 3.7.1).

BrightSign's super states *are* inlined — because they are **copies**, and a copy has no cursor.

### So the decision is not "flatten or not". It is:

| If we ship | Then |
|---|---|
| **Stateless nesting** ("always play the whole child") | Flatten at publish. Player unchanged. Snapshot, pinning, trigger offline-guard all keep working as they are. |
| **Cursored nesting** ("play 2 of the corporate block each rotation") | Player-side resolution, player-side state, and a new class of bug on every platform we ship. |

✅ **DECIDED 2026-08-23: stateless first, cursored as a separate later feature.**

The cursor is what ad-insertion needs; reusing a shared corporate block does not. Shipping the flat
version does not foreclose the cursor — but shipping the cursor first commits the player on every
platform we ship, permanently, for a capability nobody has asked for yet.

⚠️ **The one thing phase 1 must not do is make phase 2 impossible.** Concretely: the wire shape must
be able to grow a cursored variant later without a migration that rewrites published snapshots. So
the child reference keeps its identity in the item row even though the snapshot is flattened — see
`child_playlist_id` below. If phase 1 only stored the expansion, phase 2 would have nothing to
attach a cursor to.

## Phase 1 — stateless nesting, concretely

### Data model

One column, mirroring the existing `content_id` / `widget_id` discriminator pattern on
`playlist_items`:

```sql
ALTER TABLE playlist_items ADD COLUMN child_playlist_id TEXT REFERENCES playlists(id) ON DELETE RESTRICT
```

⚠️ **`ON DELETE RESTRICT`, not `SET NULL` or `CASCADE`.** A silent NULL leaves an item row that
references nothing and expands to nothing — the empty-nested-playlist black screen below. A cascade
would delete the *parent's* item. Refusing the delete is the only option that cannot surprise
anyone, and it is what makes the reverse-dependency view a requirement rather than a nicety.

### Expansion happens in `buildSnapshotItems()`, and nowhere else

That function is already the single source of the published snapshot. A child reference expands
in place, inheriting nothing except its position. The snapshot stays a **flat ordered array**, so:

- the player needs **no change at all** — it has no concept of nesting and does not gain one
- offline pinning works unchanged (flattened items are ordinary items with `filepath`)
- the trigger offline-playability guard works unchanged — it walks `published_snapshot`, which is
  post-expansion, so a nested unpinnable item is caught by the rule already shipped

### Depth 1, enforced structurally rather than by a cycle checker

Matching the industry (Signagelive states it twice: *"Double nesting is not supported"*), and
enforced the way MagicINFO does it — **by type, not by traversal**: refuse to add a child that
itself contains a child reference. A→B→A then cannot be constructed, so there is no cycle to detect.

⚠️ But unlike every vendor surveyed, **we say so out loud**: a real error naming the offending
playlist. Nobody documents a depth cap or a cycle error; it is cheap and it is a genuine
differentiator.

### Publish must fan out to ancestors — this is the known bug, one level deeper

`publishPlaylist()` currently pushes to devices whose *base* playlist matches, plus (since
2026-08-23) devices holding it as a trigger target. Nesting adds a third case: **devices whose base
playlist CONTAINS this one.**

⚠️ This is exactly the failure already fixed twice in this codebase — `pushToDevices` selected
`WHERE playlist_id = ?` and missed trigger-target devices; the trigger routes pushed nothing at all.
A fan-out that forgets a case is the recurring bug here, so phase 1 adds the ancestor query to the
same helper rather than a new call site, and a test asserts a child publish reaches a device that
only holds the parent.

### ⚠️ The restart hazard, and the mitigation

A child edit changes every ancestor's flattened items, so the structural fingerprint changes and
every screen showing any ancestor restarts at item 1. That is the #234 shape and it is the single
thing that would make this feature feel broken.

Phase 1 mitigation, in order of cost:

1. **Change-detection before republish.** If expansion produces a byte-identical snapshot, do not
   write a new one and do not push. Steals BrightSign's `CONTENT_DATA_FEED_UNCHANGED` path — the
   reset must be change-triggered, not publish-triggered. Cheap, and it covers the common case of
   an edit that does not alter the resolved list.
2. **Accept a boundary restart for genuine changes.** Neither vendor that documented this shipped a
   true mid-loop splice; Navori's non-disruptive option is *apply-at-next-loop*. Matching that is
   the pragmatic target.
3. **Deferred to its own change: a player-side diff.** Carousel proved the resume-vs-restart
   decision cannot live in the manifest — fixing CSL-9211 required a player release. Doing this
   properly means the player diffs incoming against currently-playing and preserves position. Out
   of scope for phase 1, and noted so it is not discovered later.

### Refuse to publish an empty expansion

*"Three or more 'empty' nested playlists in succession… may fail to skip… Affected: Samsung Tizen,
**BrightSign XD (8.5.47)**."* We ship BrightSign. A nested reference that expands to zero items is
refused at publish, naming the child — rather than shipping the vendor workaround of *"even if it's
just a 1-second image"*.

### Properties do NOT inherit disjunctively

⚠️ Scala's `Full Screen` and `Audio Ducking` OR across every level — *"employed if the feature is
set to On in any applicable location"* — so a child cannot defend itself against a parent, and a
fullscreen sub-playlist destroys a multi-zone layout for its turn. Ours must not do this. Item
properties belong to the item at its placement; the parent reference carries none.

### ⚠️ Found while building: a child publish must republish its ancestors

Flattening at publish means a parent's snapshot holds a **copy** of the child's items as they were
at the parent's last publish. So editing and publishing a child alone updates nothing any screen
reads — and pushing to the parent's devices (which the fan-out above already did) delivers the
parent's **stale** snapshot, so the fan-out looks correct while the content is still wrong.

This was caught by a test, not by review. It is the flatten-at-publish tax: the price of keeping the
player ignorant of nesting. Worth paying, but only if it is paid once, in the shared publish path.
`publishPlaylist()` now republishes published ancestors; drafts stay drafts.

### Deferred to phase 2 (cursored), deliberately

- the cursor itself (`play N per rotation`, advancing across parent loops)
- player-side nesting state, and the diff that preserves it
- per-placement property overrides (Scala's third state — content shared live, presentation settings
  copied per placement)
- daypart composition on the reference itself. **Phase 1 has no daypart on the reference at all**,
  which sidesteps the 4-way industry split entirely — the child's own item schedules are the only
  ones that apply, and they already work.

## What the industry agrees on

**Effective depth is 1.** Signagelive states it twice — *"Double nesting is not supported"* — and
every other reference-based implementation is one level through a layout. Only *copy*-based nesting
(BrightSign super states) goes deeper, precisely because copies cannot recurse.

**Nobody documents cycle detection. Six of six in the enterprise tier, and none elsewhere.** They
make cycles structurally unreachable instead:

- **by type** — MagicINFO's Nested playlist can only hold content, not playlists
- **by copy semantics** — BrightSign super states are embedded objects
- **by schema shape** — Carousel has no recursive edge at all

⚠️ Three vendors have a **latent indirect cycle** nobody documents: playlist → layout/slide/app →
zone → playlist. If we allow both nesting axes we inherit that, and we would be the only ones to
have noticed.

**The parent caps the block; it does not reach inside.** Five of six are explicit. Duration belongs
to the item at its placement. Xibo's `Spot Length` is the sole exception.

**Editing a child reaches every parent, live.** Nobody snapshots at attach time. The universal tell
is that deleting a child *damages* every parent — which copy semantics could not do.

## ⚠️ Where vendors genuinely disagree, and we must therefore choose

### Daypart composition — a real 4-way split

| Model | Vendors |
|---|---|
| **Intersect (AND)** — parent window AND child window; a parent daypart cannot *widen* a child's | Scala, Poppulo, Korbyt |
| **Per-dimension override with fall-through** — parent wins per dimension (validity / days / times independently), child fills the unset ones | Signagelive |
| **Undocumented** | Navori, 22Miles, and everyone in the other two tiers |

These produce **different content on screen for identical author input**. Signagelive has a
dedicated KB article for exactly this question — and its main nesting article still contradicts
itself on the answer. If a vendor with a dedicated article cannot keep it straight, neither will our
users.

**Proposed: intersect.** It is the majority, it is the only one that cannot surprise someone into
showing content outside a window they set, and it composes with the per-item schedule blocks we
already have. It must go into `shared/schedule-vectors.json` so both players are held to it.

### Temporal vs spatial — the deepest fork

Scala and Signagelive nest *in the loop*. Navori, Korbyt, 22Miles and Poppulo nest *into a region of
a layout*. The zone-based vendors literally cannot ask "which zone does this sub-playlist target",
because the answer is inherent in where it was placed.

⚠️ **Carousel's variant is the most elegant thing found in the whole survey**: they share the
**zone**, one level *below* the assignable object. Cycles, depth limits and resolution order all
stop existing. Worth weighing seriously against nesting proper before we build either.

## ⚠️ Restart-on-edit — the risk this feature actually carries

Our structural fingerprint restarts playback when it changes (`server/player/index.html`). A child
edit changes every parent's flattened items, so **editing a shared "corporate news" playlist would
restart every screen in the estate at item 1** — the #234 shape.

The industry confirms the fear and has *not* solved it well:

- **Navori — restarts by DEFAULT.** *"the currently running playlist resets itself and jumps back to
  its beginning."* The opt-out, **"No Media Interruption"**, is still only *apply-at-next-loop*, not
  a splice.
- **22Miles — restarted until `7.5.50416` (Apr 2025)**, fixed since — *"Don't restart when playlist
  updating"* — but **still restarts for layout and player-setting changes.**
- **BrightSign — resets `playbackIndex%` to `startIndex%`** on `CONTENT_DATA_FEED_LOADED`. Does not
  cut mid-item; the reset lands at the next item boundary.
- **Four vendors publish no continuity guarantee at all.**

**Three things to steal:**

1. ⭐ **Make the reset change-triggered, not poll-triggered.** BrightSign's mitigation already exists
   in the product: a `CONTENT_DATA_FEED_UNCHANGED` path driven by *"optimize feed updates (use HEAD
   calls)"* skips the repopulate entirely when nothing changed. Cheap change-detection is the whole
   fix for the common case.
2. ⭐ **The resume-vs-restart decision belongs in the PLAYER, not the manifest.** Carousel shipped
   our exact bug — CSL-9211, *"BrightSign players would restart a single bulletin playing in a zone
   **when a different zone's content changes**"* — and fixing it required a **player-app release**.
   Their `BulletinSpec.lastUpdate` per item is what makes the diff cheap. The player must diff
   incoming against currently-playing and preserve position per zone.
3. **Defer to the loop boundary.** Neither vendor that documented this implemented a true mid-loop
   splice. Apply-at-next-boundary is the pragmatic target, not a compromise.

Anthias is the honourable exception and the cleanest pattern: on a content change it skips *only*
the currently-displayed asset if it became invalid, and leaves the rest of the loop alone
(issue #2430 → PR #2875).

## Things that will bite us, taken from other people's scars

- ⚠️ **Deletions propagate silently.** Appspace red-boxes it: *"deleting content from a source
  affects every zone and channel linked to it"* — with no reverse-dependency view and no
  confirmation. **BrightSign's answer is cheap and better: a lock icon on any item used in an active
  presentation, which cannot be deleted.** Build the reverse index before shipping shared children.
- ⚠️ **Empty nested playlists cause hardware-specific black screens.** *"Three or more 'empty'
  nested playlists in succession… may fail to skip… Affected: Samsung Tizen, **BrightSign XD
  (8.5.47)**."* Vendor workaround is *"even if it's just a 1-second image"*. Directly relevant to
  our BrightSign work — we should refuse to publish an empty nested reference rather than ship one.
- ⚠️ **Scala's Full Screen / Audio Ducking OR across every level** — *"employed if the feature is set
  to On in **any applicable location**"*. A child cannot defend itself against a parent. A clean
  example of a property that must **not** inherit disjunctively; ours must not either.
- ⚠️ **Scala's placement-scoped properties are a third state most designs miss.** Content is shared
  live, but duration/transition/conditions are stored **per placement**: *"applies to the item only
  in that playlist."* We should decide this deliberately rather than discover it.
- ⚠️ **Scala's Manual plan-generation mode silently strands child edits** — a shared sub-playlist
  edit reaches zero screens until a human clicks Generate Plan. Any publish gate we add needs to
  make that state visible.

## What is NOT established, and should not be assumed

- **Restart-on-edit for Scala, Signagelive, Korbyt, Poppulo, MagicINFO, Appspace, LG, OptiSigns,
  Rise Vision.** All three agents exhausted their web-search budgets and lost forum access; this is
  the question vendors do not document and practitioners answer on forums. Answered only for
  Navori, 22Miles, BrightSign and Anthias.
- **Cycle detection anywhere.** Not "no limit found" — genuinely undocumented by all 17.
- **How a short parent cap interacts with a child cursor next rotation** (Signagelive).
- Navori's `ZonePlaylist.UponCompletion` appears in the API schema with **zero prose**; its value set
  would settle once-vs-loop-vs-hold.

## Open questions for the user

1. ~~Stateless or cursored?~~ **Settled 2026-08-23: stateless first, cursored later.**
2. ~~Depth cap and a real cycle error?~~ **Settled: yes** — depth 1, enforced by type, with a named
   error. Nobody else documents either.
3. **Still open — nest in the loop, or share a zone (Carousel's model)?** Phase 1 as specified nests
   in the loop. Carousel's zone-sharing makes cycles, depth limits and resolution order all
   disappear, and is worth a decision before phase 2 rather than after.
