# RetireGeometry's shape: from remnant to strand (prd10 rulings 2, 13-15)

`packages/web/src/scene/geometry.ts` — `RetireGeometry`, `persistence()`.

See `retire.ts`'s own record (`retire-transformation-not-deletion.md`) for the
ruling history. This note is the geometry-side implementation fallout.

## What `RetireGeometry.path` used to be

It used to describe a **remnant**: the stub left after a cord was severed
from the mass, shortening frame by frame until ruling 2's dissolve erased it
altogether. It describes a **strand** now — the same curve the lane always
had, root-mass rim to node, threaded into the mass for the rest of the
session. Nothing in this file shortens it, nothing returns an empty path, and
there is no severance parameter left to shorten it from.

It is still carried beside the living geometry (`ThreadGeometry.path`) rather
than replacing it: `path` is the undeformed spine, which is what light
already in flight finishes its journey along (a landing packet takes 2.8s to
reach the mass, the settle takes 1.4) and what the returning motes ride.
`RetireGeometry.path` is that spine with the release folded into it.

## `persistence()`'s severance parameter is gone

`persistence()` used to take a severance parameter and return
`span(path, from, …)` — the stretch from the cut to the node, shortening on
the withdraw's own spring until ruling 2's dissolve took even that away.
Ruling 13 rescinds both, so what it hands the mark builders now is the strand
it always had. There is no code path left in this function that can shorten
or empty it.

The strand keeps the whole thread's taper, so "thread width = work size"
survives the transformation intact: the *encoding* lives here
(`persistence()`/`geometry.ts`) and the *hierarchy* (how much thinner a
finished strand draws) lives in `retire.ts`'s `PERSIST_WIDTH_SCALE`, applied
where the ribbon is actually built (`marks/thread.ts`) — which is what keeps
a retune of one from silently changing the other.

## The second polyline walk is gone with the remnant

`layoutScene` used to walk the drawn polyline twice for a retiring lane: once
to build it, once to re-measure its arc length after the release bowed it,
because ruling 1 originally measured a lane's work by the length of the stub
left at the rim. There is no stub to measure now (the work-size channel is
the strand's own width, unbroken from mass to node), so a retiring lane costs
one polyline walk a frame instead of two.
