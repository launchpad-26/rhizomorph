# Four facts in the layout, and what each one replaced

`packages/web/src/scene/geometry.ts` — the ring, the lifecycle radius, and the spine's sideways wander.

## The four facts

Four things about a lane's geometry carry meaning, and each is a recorded fact
rather than a decoration:

- distance from the root-mass = how far through its life the lane is (prd6 ruling 4)
- thread width = work size, on an absolute scale (prd6 ruling 1)
- angular position = identity, stable for the session (graft g7)
- length of the drawn thread = how grown-in it is (graft g3)

## Distance replaced recency (prd6 ruling 4 vs prd3 graft g6)

prd3 graft g6 originally read distance-from-mass as recency. That needed
explaining and failed the layman bar, so prd6 ruling 4 moved distance to mean
lifecycle progress instead — born against the mass, travelling outward as it
works, retiring at the rim, where the cord-cut already happens, so the two now
tell one story. Recency did not lose its channel: it kept thread lightness
(`thread.ts`'s `freshness`), so no fact was dropped when the radius changed
hands.

## What prd7 added, and what it was not allowed to touch

prd7 made a thread's spine sparse waypoints off the lifecycle curve, nudged
sideways by a noise field seeded from the lane's own handle, and interpolated
by centripetal Catmull-Rom (`ribbon.ts`) — the treatment that stops twenty
lanes from reading as twenty drafted arcs. The nudge is bounded twice (by
`WANDER_MAX_SPACING` of the inter-lane gap, and by an envelope that is exactly
zero at both ends) so every one of the four facts above survives it bit for
bit: the node is still at its lifecycle radius on its own angle.
`geometry.test.ts` recomputes both from the fleet to prove it.

## The one caveat

The ring is re-spaced whenever the seat count changes (a new dispatch adds a
seat), which is a different fact from the one g7 protects: a lane must not
move because its mood changed, but even spacing is what keeps twenty labels
legible (ruling 31's collision trigger). A *returning* lane is the exception
that proves this: a re-dispatched handle grows out of the seed it left behind
and shares that seat rather than claiming a new one (prd6 ruling 3), so the
ring is not re-spaced at all when a handle comes home.
