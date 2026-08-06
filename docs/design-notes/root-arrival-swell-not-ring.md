# An arrival swells the surface; it no longer draws a ring (prd7 ruling 5)

`packages/web/src/scene/marks/root.ts` — `ARRIVAL`, `arrivalSwell`,
`rootFalloffs`.

## Context

What used to be drawn here was `root-arrival`: an expanding hairline circle,
drawn over the mass whenever the surge was decaying. It was a concentric
ring — the exact form prd7 ruling 5 removes everywhere else in this file —
and it is gone, deliberately not replaced. The fact it carried (something is
arriving) is now carried by the surface itself: each cord still parting adds
a falloff of its own at that lane's bearing, so the surface swells toward the
lane the work is coming from and settles back as the strand stills. An
arrival is something the mass *does* now, not a shape drawn on top of it. The
light half of the same fact stays where it was, in the halo and the core.

## Why `ARRIVAL` is small and sits at the rim

Getting the swell's shape right took three passes at a rendered frame. A
large falloff parked deep inside the body does not read as a bulge at all:
its own arc is nearly flat at that scale, so what appears on the silhouette
is a *facet*, and three arrivals at once turn the mass into a crystal. A
small falloff at the rim reads as the surface being pushed out from within,
which is the thing that is actually happening. At full swell it reaches
about 1.16 of the radius on that bearing — unmissable, and still inside the
slack the mass's hit target (`SceneView`'s `ROOT_HIT_SLACK`) already carries.

## Why it never pops in or out

This also falls out of the geometry rather than needing a rule. Below about
half swell the falloff is still entirely inside the body and changes the
silhouette not at all, so the bulge emerges *from* the surface in the last
third of the withdraw instead of popping into existence beside it, and melts
away the same way as the strand settles.
