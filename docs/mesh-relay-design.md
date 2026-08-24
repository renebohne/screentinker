# The relay / cache tier

**Status: blocked, deliberately, on two preconditions written into the source.** Not "not started".

```
lib/mesh/capabilities.js   'redistributes-content' … phase5: true — REFUSED by validation
                           "This is the one that inverts I2's direction, so it gets its own
                            security review."
lib/mesh/pairing.js        maxDepth 2 — "Raise MESH_MAX_DEPTH only once a two-tier mesh has
                            been proven on real hardware."
```

Neither is met. This document exists so the review those notes ask for has something to review.

## Why it cannot simply be built now

**There is no topology for it to serve.** A relay "caches and serves media to its subtree", and at
`MESH_MAX_DEPTH = 2` there is no subtree: a hub has children and the children have nothing below
them. Every child already pulls directly from the hub it enrolled with. Building the relay before
raising the cap produces code that cannot be exercised — and the cap is itself gated on proving the
two-tier mesh on real hardware first, which has not happened.

That ordering is not bureaucracy. The content transfer that shipped this week has never run over a
real WAN link between two real sites; its resume path was inert for its first hour of existence and
looked fine, because the file arrived anyway. Stacking an untested tier on an unproven one means the
first failure is ambiguous between them.

## What it actually inverts

Every other mesh capability moves data **upward** or lets a parent **ask**. I5 is explicit that a
relayed envelope is *relayed, not interpreted, not stored*. A cache stores. That single word is the
whole security review:

- **A relay holds bytes belonging to a customer who never agreed to that node holding them.** Today
  a customer grants a specific hub a storage allowance on their own disk. In a three-tier mesh, the
  hub pushes through a regional node — which now stores that customer's media, on hardware the
  customer has no relationship with. Nobody in the current consent model is asked.
- **A relay serves content it did not originate.** The pull ticket is minted by the node that owns
  the file and is checked against a live read of *its* edge. A relay serving a cached copy must
  either mint its own tickets (making it an authority for content it does not own) or proxy the
  originator's (making every transfer depend on a node that may be offline — which is precisely what
  the cache was for).
- **Revocation stops meaning what it means.** A customer revoking write access today stops future
  writes and can then delete what was pushed. With a cache in between, their content persists on a
  third node with its own retention, and the revoke reaches nothing.

## The questions that need a decision, not an implementation

1. **Does a relay cache a customer's content at all, or only content the relay's own operator owns?**
   The second is far weaker and far safer, and may be enough: an MSP pushing *their* campaign to
   forty sites is the actual bandwidth case, and that content belongs to the MSP.
2. **If it does cache customer content — who consents?** The child whose bytes they are has no edge
   to the relay and no page on which to be asked. A consent model where the party giving something
   up cannot see the request is the failure this whole design was built against (see I10).
3. **Whose storage allowance pays for a cached copy?** It is not the child's disk and not the
   originating hub's. A third accounting axis, or the cache is unbounded.
4. **Does a relay verify before serving?** It must — digest-check on ingest and on serve. A relay
   serving one wrong file puts that file on every screen beneath it, which is a larger blast radius
   than any single node has today.
5. **What happens when the originator revokes or deletes?** Either the cache honours a purge it can
   be told about (a new downward verb, with all that implies) or cached content outlives the
   relationship that created it.

## The design I would propose, if the answers are the conservative ones

Scoped to question 1's safer half: **a relay caches only content its own operator pushed.** Then:

- No new consent surface. The relay's operator owns the bytes; the child already consents to
  receiving them from that operator's hub.
- Tickets stay honest. The relay is the originator of its own pushes, so it mints tickets for
  content it owns, exactly as a hub does today.
- Accounting is unchanged. The child's allowance covers what lands on the child; the relay's disk is
  the relay operator's own problem.
- The digest makes it verifiable end to end: a child checks size, digest and type on arrival
  regardless of which node it fetched from, so a compromised relay cannot substitute a file.
- Revocation still works, because there is no third party's content to strand.

What this does **not** solve is the case where a customer's own content needs distributing across
their own sites — which is the same feature with question 2 answered, and should be a separate
decision taken deliberately rather than inherited.

## Preconditions to lift before writing any of it

1. A two-tier mesh running on real hardware across a real WAN link, with the content transfer
   exercised on a link that genuinely drops. Not a lab.
2. An answer to question 1 — because the conservative and permissive versions are different
   features, not different settings.
3. `MESH_MAX_DEPTH` raised only after 1, and only for topologies that have been drawn out. A depth
   of 3 with N regional nodes is a different failure surface from a chain of 3.
