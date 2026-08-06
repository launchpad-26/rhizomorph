# prd7 — procedural form

> **Outcome:** shipped.

prd6 finished the instrument's behaviour. The operator's note: "the
function should remain the same, that's locked in, but now that we've got
the shape of it sorted, we can make it more procedurally generated,
smooth, unique, less janky, less shapes… there must be a repo, skill, or
something to that effect we can use as inspiration or guidance."

Research ran first (`docs/research/2026-08-02-*`), and its measurement
**reframed the prd**: the live scene is already locked at 60fps (median
16.70 ms, p95 16.80, one dropped frame in 179) with **zero shadowBlur**.
"Janky" is therefore the FORM LANGUAGE — stroked centre-lines, hard
edges, discrete glyph shapes — not the renderer. Rulings from the
interview, operator, 2026-08-02:

## Rulings

1. **This is a form prd, not a renderer prd. Stay canvas 2D.** No WebGL:
   it cures nothing measured, and jsdom returns `null` for
   `webgl`/`webgl2`, so a WebGL painter is one our suite could never
   execute. The `shadowBlur` ban stands and gains a second reason — it is
   not affected by the transformation matrix, so it would not scale under
   the prd5 camera. The display list stays plain data (guarded by a
   `structuredClone` conformance test), which keeps the painter swappable
   if a later prd ever earns a shader layer.
2. **Semantic roles before any visual change (the prerequisite).** Our
   laws are pinned to shape-named roles — `chevron ×3`, `cut ×2`,
   `raised-hand`, `rogue-barb`: 31 assertions across 9 names, 51 role
   usages in source. Those names ARE the shapes being removed. Roles are
   renamed to what they MEAN (`expensive-mark`, `severed`, `summons`),
   the assertions restated on top, and **the conductor reviews that diff
   specifically for weakened laws**. No visual diff in this issue.
3. **Stop stroking lines; start filling ribbons.** A thread becomes a
   closed polygon whose width varies along its length
   (`perfect-freehand`, MIT — probed: deterministic, 0.172 ms/frame for
   30 ribbons). Taper, pinch and swell become available as form, which is
   what lets discrete glyphs disappear. The substitution table, each
   spending zero new objects: chevron → asymmetric taper · cut-mark →
   width pinch · cartouche ring → midpoint-displaced blob · seal →
   hue-only knot · commit dot → travelling width swell · progress arc →
   ribbon length. The spine smooths with centripetal Catmull-Rom
   (`d3-shape`, α=0.5 — it INTERPOLATES waypoints, so encoded positions
   stay exact).
4. **Uniqueness is bounded, and seeded from identity.** Variation comes
   from `simplex-noise` seeded by a hash of the lane handle (probed:
   identical from a fresh instance, so replay is safe). A **channel
   table** governs permission: sideways wander ≤ ~0.3× lane spacing,
   width ±10% low-frequency, curl phase free; position-along-life, hue
   and encoded width are LOCKED. Every lane looks hand-grown; no lane
   misreads.
5. **The root-mass becomes one smooth organic contour** via marching
   squares on a ~6px grid (measured 1.28 ms/frame) — and it emits a
   contour polygon, so it stays a typed mark the tests can query.
   Per-pixel metaballs are rejected on measurement (42.8 ms/frame; 108.5
   with SDF+smin). `smin` is non-associative: blend order sorts by stable
   id or the geometry flaps.
6. **Read for technique, never vendor.** inconvergent's Hyphae and
   Differential Line (the published art form closest to our metaphor),
   Tyler Hobbs on flow fields and soft edges, Inigo Quilez on smin and
   palettes, Sighack's Chaikin curves (MIT, portable). **Licence traps
   that must appear in every brief:** jasonwebb's differential-growth and
   space-colonization repos are CC BY-NC-SA (non-commercial — never
   vendor); thebookofshaders' repo is All Rights Reserved; p5.js is LGPL.
   Growth algorithms are accepted only as OFFLINE geometry authoring on
   topology change, never live per frame. Workers load
   `ui-ux-pro-max` (its "Biomimetic / Organic 2.0" card is the
   checklist), `emil-design-eng` and `frontend-design`.

## Implementation waves (issues #112–#115)

Serial by necessity — the scene is one module and each wave rewrites what
the next builds on. Wave 1: **#112** semantic roles (opus, no visual
change). Wave 2: **#113** ribbons, substitutions and bounded variation
(opus — the form keystone). Wave 3: **#114** the root-mass contour.
Wave 4: **#115** docs/demo/screenshots. Conductor browser verification
per wave, including a re-profile to prove 60fps survived; gates run the
bounded busy-box standard (prd3 rulings 33–34).
