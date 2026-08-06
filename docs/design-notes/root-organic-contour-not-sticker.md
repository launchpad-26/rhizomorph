# One organic contour, not a sticker (prd7 ruling 5, #117)

`packages/web/src/scene/marks/root.ts` — `BODY`, `MELT`, `CELL`, `DEPTH`,
`depthsFor`, and the `root-mass`/`root-core` marks in `rootMarks`.

## Context

prd7 ruling 5 asked for the root-mass to read as one organic contour, not a
set of shapes. What was there before was fifty-four curls inside a pair of
concentric glows — the most obviously *drawn* thing in the picture, at
exactly the place the eye rests longest.

## The first pass, and the #117 finding against it

The first attempt at ruling 5 got the *idea* right and the material wrong: a
flat opaque fill, a 1px lighter outline round it, and a radial-gradient core
sitting inside the silhouette without being aligned to it. Three objects
pretending to be one, in a substance nothing else on screen shares —
everything else in the instrument is thin, translucent and ice-toned. It read
as a sticker: an outline states a boundary, and a boundary is exactly the
wrong thing for a surface that is supposed to have depth behind it.

## The fix

The mass is painted from the field rather than over it:

- **One body, no outline.** `depthsFor` walks the same scalar field at up to
  eighteen levels (more when the mass is full), each nearly transparent, so
  what the eye reads is the *accumulation* through the material rather than a
  fill plus a stroke. `DEPTH.rind` is the material's own skin — three or four
  pixels where the light travels furthest through the edge — not a stroke
  laid on a boundary.
- **Three octaves in the silhouette, not one.** The single-octave body (six
  falloffs of roughly one size) had one wavelength, so every lobe was the
  same lobe and the whole thing read as a shape rather than a thing. `BODY`
  is now a trunk of four large falloffs, five shoulders at half their size,
  and eight grains at a fifth of it near the skin — features at three
  scales, which is what "multi-octave" buys.
- **`MELT` (0.13) and `CELL` (0.078) both had to come down** when the second
  and third octaves were added, for the same reason: a fillet is a low-pass
  filter over the silhouette, and a lattice can't resolve a feature smaller
  than about two of its cells. At the single-octave body's `MELT` of 0.24, a
  grain of radius 0.13 sat entirely inside the weld and changed the outline
  not at all — paid for and then smoothed away. At the old `CELL` of 6px
  (down to ~4px), the grid would have quantised the grain octave (0.11–0.17
  of the radius) into the same smooth outline as before.
- **The core glow shrank.** It used to be a half-radius radial gradient
  sitting inside a silhouette it had no relationship to. The depth is the
  shells' job now, so the core only needs to be the light at the bottom of
  them — and a light at the bottom of something is small.

## Tuning notes on the depth stack

Three properties of `DEPTH` were found by looking at a rendered frame at 2×,
each taking more than one attempt:

- Evenly spaced levels put most of the ramp in the first fifth and gave the
  mass a hard shoulder again — the spacing widens toward the skin instead.
- The step *count* is what kills banding, not the total alpha: nine levels
  at 0.06 is the same density as eighteen at 0.03 but comes out as a visible
  contour map, because a 6% alpha step is an edge the eye finds. Fifteen at
  0.058 still showed it faintly around the core; eighteen at 0.05 does not.
- The interior stays lumpy on purpose: a multi-octave body has a
  multi-octave inside, so the deeper levels break into two or three
  components rather than one disc. At these alphas it reads as mottling,
  which is the honest picture and a better one than a smooth ball.

The `rgb` ramp's exponent (1.35, in `depthsFor`) is tuned the same way:
squaring it put nearly all the brightening in the last few shells and made
the body read as faint against the vignette; taking it under 1 lifted the
middle and brought the banding straight back, because the colour step per
level is largest exactly where the levels are furthest apart. 1.35 is the
most lift the ramp gives before a step becomes an edge. The per-level
`alpha` has to thin as the stack deepens for the same reason the stack
exists at all — without it, a full mass renders as a solid disc and the
depth stops reading as depth.
