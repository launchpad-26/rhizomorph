# Absolute scale: seed size and mass growth (prd6 ruling 1, #118)

`packages/web/src/scene/geometry.ts` — `seedSize`, `ROOT_GROWTH`, `rootRadiusFor`.

## Why absolute, not relative (ruling 1)

`seedSize()`'s reference range is fixed (1,000 to 100,000 output tokens)
rather than scaled to the busiest lane in the fleet. The old reading divided
by the fleet's own busiest lane, so a 20K-token lane visibly shrank the
instant a 500K-token whale started working beside it — growth, the one thing
the operator asked to be able to see, never read at all. An absolute scale
means ten times the reference draws the same as the reference, and a
sibling's growth cannot move another lane's size.

The two references (not one) exist because a bare `log1p(t) / log1p(FULL)`
spends most of its range below a thousand tokens, where no real lane sits (9K
and 120K come out 0.79 and 1.00 — the same "growth never reads" failure in a
different coordinate system). So the ruler runs between the two ends that
exist in practice, and the log does its compressing in between.

## The mass's growth, and the wreath it fixed (#118)

`rootRadiusFor`'s growth used to be a multiplier `marks/root.ts` applied to a
fixed radius, worth 30% at the ceiling. #118's finding against it was the
picture it produced: after thirty-eight landings and 2.5M output tokens, the
scene read as a **wreath** — a ring of retired lanes around a large empty
middle with a small blob at the centre. The encoding was already there and
simply too weak to see.

Three things had to change together:

1. **The ceiling is a fraction of the scene, not of the mass.** A cap of
   "+30% of resting size" says nothing about the picture it sits in; what an
   operator can see is how much of the gap to the retirement band the centre
   has taken. The ceiling is `ROOT_GROWTH.maxReach` of `min(rx, ry)`, so the
   mass cannot crowd the rim or its labels at any panel shape or zoom.
2. **Everything inside the rim makes room.** `bornRadial` and the bundle
   radius are measured off the grown radius, not a resting one — otherwise,
   by the time `marks/root.ts` ran, every thread would already be laid out
   against a radius that was wrong.
3. **The same absolute-scale discipline as `seedSize`** — a two-ended log, an
   absolute reference so a sibling landing cannot move it, a hard cap so
   nothing balloons.

`ROOT_GROWTH.fullTokens` is 2,000,000 because #118's own session had landed
2.5M by the time the ruling was written — the ruler has to run to something
of that order or every session past the first hour draws the same.

## Where 0.5 (`maxReach`) came from

Found by looking at rendered frames at 2×, not reasoned from first
principles. Below about 0.42 the mass never gets past where a newborn node
already sits, so the empty annulus survives and only the blob in it is
slightly larger. Past about 0.55 the lifecycle band (born to rim) is squeezed
into the outer third of the picture and a lane's journey stops being
readable. At 0.5 the centre is unmistakably the biggest thing in the frame
and the living band still has half the radius to run in.
