# The rim's ragged edge: relax reach and drift band (#102, #117)

`packages/web/src/scene/geometry.ts` — `RELAX_REACH_MIN_PX`/`MAX_PX`, `RETIRE_RELAX_PX`.

## Relax reach — why a length, not a fraction (#102)

`RELAX_REACH_MIN_PX`/`MAX_PX` used to size the length of the *remnant* a cut
left at the rim, before ruling 13 took the cut away (see `retire.ts`'s own
decision record, `retire-transformation-not-deletion.md`, for that lineage).
What survives is the half of the number that was always about the picture:
the stretch at the far end that eases outward past the rim as a lane comes to
rest, so thirty finished lanes end at thirty slightly different radii instead
of on one perfect ellipse.

It stayed a length rather than a fraction: the rim is a wide ellipse, so a
lane at three o'clock has a thread three times as long as one at noon, and a
fixed fraction of it would make the bend a fact about the panel's aspect
ratio — nothing means that. It stayed sized by the lane's own work on the
absolute scale (see `geometry-absolute-scale.md`), for the same reason ruling
1 gave when this was a mark: a rim where a 216K lane and an empty one finish
identically has thrown away the only thing it had to say about them.

## Drift band — from one number to a band (#117)

`RETIRE_RELAX_PX` used to be a single number, nine pixels for every lane, and
that was half of why a rim of finished lanes read as eyelashes on a clock
face — thirty-seven ends all sitting on one perfect ellipse. #117 turned it
into a band: each lane relaxes by its own amount between `min` and `max`, so
the rim is as ragged as a rim of things that finished at different times and
sizes ought to be.

It is seeded from the lane's identity (`variation.ts`'s free-phase channel),
not from when the lane retired. "When" is recency, and prd6 ruling 4 already
took recency off the radius on purpose — giving it back for retired lanes
only would be a second meaning for the one channel the ruling settled. What
the picture needed was scatter, and `variation.ts`'s permission system says
scatter may come only from a channel that carries nothing: among lanes that
have all finished, the radius carries nothing (they are all at `lifeFrac` 1),
so this is the free channel it looks like.
