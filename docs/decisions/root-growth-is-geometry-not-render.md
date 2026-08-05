# The mass's growth is a geometry fact, not a render one (prd6 ruling 2, #118)

`packages/web/src/scene/marks/root.ts` — `depthsFor`, `DEPTH.reach`,
`DEPTH.rind`/`rindFull`, the `root-halo` mark's radius.

## Context

prd6 ruling 2 asks for the mass to visibly grow with the session's landed
work. The first version of that lived here, as `ROOT_GROWTH.maxGirth` — a
fixed 30% multiplier applied to a fixed `geometry.rootRadius`. #118's finding
against it was the whole picture: a night of thirty-eight landings still
drew a small blob in a large empty middle, so the fact the encoding exists to
state was invisible.

## Decision

The growth math moved entirely to `geometry.ts`'s `rootRadiusFor` — the same
absolute, two-ended-log, hard-capped discipline, but with the cap expressed
as a fraction of the scene's own clearance to the retirement band instead of
as a fraction of the mass. It moved because it was never a *drawing*
decision: the newborn nodes, the bundle trunk and the threads' exit from the
surface all have to make room for a mass that has grown, and every one of
them is laid out before this file runs. So the radius is a geometry fact this
builder only reads (`geometry.rootRadius`), exactly as it reads the centre.

Three things followed from that:

- **The halo's radius dropped its own growth term.** It used to carry a
  `+1.4 × fullness` bonus on top of the fixed multiple, to compensate for the
  old 30% cap. Now that `radius` already doubles on its own, that bonus was
  the same fact stated twice, and it put the halo's outer edge two thirds of
  the way across the panel.
- **`DEPTH.rind` deliberately does not scale with the growth.** A skin is a
  material fact — how far light travels through the edge of the stuff — so a
  mass that has doubled has the same skin, not one twice as thick. Left
  proportional it came out at six or seven pixels on a full centre and read
  as exactly the thing #117 removed: a lighter stripe laid round a fill.
  `DEPTH.rindFull` is the same three-or-four pixels in units of a full mass's
  radius.
- **What *does* vary with fullness is resolution, not size.** `depthsFor`
  moves exactly one number with `SceneGeometry.rootFullness`: the shell
  count, from `DEPTH.count` (18) to `DEPTH.countFull` (26). A multi-octave
  field's deeper levels break into two, three or four separate components,
  and a stack fine enough to land between them is what makes a full mass
  read as having an inside rather than a middle — the same argument that set
  the count at eighteen in the first place, applied at a size where eighteen
  is no longer enough.

`DEPTH.reach` (how far in the innermost shell sits) was tried the other way
first: taking it to 0.76 on a full mass bought five shells that enclosed
nothing at all, because the field bottoms out around 0.58 of the radius —
where the trunk's own falloffs run out of depth. A level asked for past that
point is an empty ring, walked and allocated and skipped every frame for no
picture. 0.62 puts the last one just past the bottom, at any size, which is
why `reach` stays fixed while the count moves.
