# A tissue undertone in the mass's own interior (prd10 ruling 3, #157)

`packages/web/src/scene/marks/root.ts` — `DEPTH_TISSUE`.

## Context

The operator's review of the "gorgeous round" asked for more vibrancy live,
including a deeper tissue undertone in the heart's interior. `DEPTH_TISSUE`
was raised from 0.32 to 0.44 in response — the sibling dial to the vibrancy
work `docs/decisions/palette-vibrancy-dials.md` covers for `palette.ts`, but
scoped to this file's own depth stack.

## Why this is the cheapest vibrancy available in the scene

`depthsFor` mixes the wash in squared in `t`, so it is nearly absent at the
skin and concentrated in the core — the one region of the picture that is
large, still, and carries no state. Nothing legible is tinted; the material
the fleet is threaded into simply stops reading as thickening ice.

It is also a **colour** change rather than a brightness one: the mix target
is `TISSUE_700`, which sits near the deep shells' own luminance, so the mass
gains an undertone without gaining a single hundredth against
`CALM_CEILING`. The rind stays untouched — the picture's edge never picks up
a hue it would need explaining — and the accent stays in the one place
ruling 5 permits it: organic tissue.
