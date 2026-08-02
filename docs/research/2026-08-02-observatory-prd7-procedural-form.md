# Rhizomorph prd7 — procedural form: what to change, and what the evidence says not to

> Researched + measured 2026-08-02 for one decision: **how to rebuild the
> scene's graphics** after the operator's note — "the function should remain
> the same, that's locked in… more procedurally generated, smooth, unique,
> less janky, less shapes… there must be a repo, skill, or something to that
> effect we can use as inspiration or guidance."
>
> Companions (same directory, all claims graded there):
> `-obs-prd7-organic-form.md` · `-obs-prd7-renderer.md` ·
> `-obs-prd7-reference-repos.md`

## The measurement that reframes the whole prd [Ran]

Profiled the live scene in a real browser (180 frames, 1720×960, the full
33-lane session):

```
frame intervals: median 16.70 ms · p95 16.80 ms · worst 33.3 ms · 1 dropped
shadowBlur assignments in 2s: 0
```

**The scene is already locked to 60fps and the painter already avoids the
expensive primitive.** So "janky" is not performance and not renderer
choice — it is the FORM LANGUAGE: stroked centre-lines, hard edges,
discrete glyph shapes. This kills the two expensive answers before we
spend anything on them:

- **No WebGL.** It cures nothing measured here, and it costs test coverage:
  jsdom returns `null` for `webgl`/`webgl2` [Verified, renderer note], so a
  WebGL painter is one our suite could never execute. (Bundle costs if it
  ever IS justified: twgl 10.6 kB, ogl 12.5 kB, regl 27.8–40.3 kB, PixiJS
  137 kB gz — Pixi alone is 2.2× our whole app.)
- **No painter-hygiene rescue.** Already clean: no shadowBlur, no filter,
  DPR handled, 60fps at 33 lanes.

One latent bug found on the way: `shadowBlur` "is not affected by the
current transformation matrix" [Verified, MDN] — if glow is ever
reintroduced that way it will not scale under the prd5 camera. Keep the
ban.

## Verified vehicles [Ran] — probed in our own stack before recommending

| Vehicle | Licence | Evidence |
|---|---|---|
| `perfect-freehand` 1.2.3 | MIT | 24-pt spine → 88-pt **closed ribbon outline**, byte-identical across calls (deterministic). Our width encoding feeds in as `pressure` with `simulatePressure:false` |
| `simplex-noise` 4.0.3 + seeded PRNG (cyrb128→mulberry32) | MIT | Same lane id → identical samples from a **fresh instance** (replay-safe); different lanes differ |
| `d3-shape` 3.2.0 | ISC | Centripetal Catmull-Rom (α=0.5) headless, and it **interpolates** waypoints so encoded positions stay exact |
| Cost | — | 30 ribbons × 24 pts = **0.172 ms/frame** (~1% of budget); **+14.3 kB gz** on a 62.1 kB bundle |

## The thesis

**Stop stroking lines; start filling ribbons.** Nearly every improvement
follows from that one substitution: a thread becomes a closed polygon whose
width varies along its length, so taper, pinch and swell become available
as *form* — which is what lets discrete glyphs disappear.

The companion's six one-for-one substitutions, each spending **zero new
objects**: chevron → asymmetric taper · cut-mark → width pinch · cartouche
ring → midpoint-displaced blob · seal → hue-only knot · commit dot →
travelling width swell · progress arc → ribbon length.

## The architectural prerequisite (found by inspection, not theory)

Our laws are pinned to **shape-named roles** — `chevron ×3`, `cut ×2`,
`raised-hand`, `node-thorn`, `rogue-barb`: **31 assertions across 9 role
names, 51 role usages in source**. Those names *are* the shapes being
removed. Renaming roles to what they MEAN (`expensive-mark`, `severed`,
`summons`) decouples the law layer from the form layer permanently, and it
is a mechanical, reviewable change with no visual diff. **Do it first, as
its own issue, and review the test diff for weakening** — this is the one
place a worker could quietly soften a law while "migrating" it.

Guard worth adding [Consensus, renderer note]: a `structuredClone`
conformance test on the display list — marks must stay plain data, which is
what keeps the painter swappable (and keeps the WebGL door open for a later
prd without re-litigating).

## The root-mass, specifically [Ran, renderer note]

Concentric rings → an organic blob, but **not** by per-pixel metaballs:
measured **42.8 ms/frame** (108.5 ms with SDF+smin) at 1200×800/12 balls —
unshippable and untestable. **Marching squares on a ~6px grid: 1.28 ms**,
and it emits a *contour polygon* — a typed mark the tests can still query.
Note IQ's `smin` is non-associative: blend order must be sorted by stable
id or the geometry flaps between frames.

## The reading list the operator asked for

1. **inconvergent (Anders Hoff) — "Hyphae" and "Differential Line"** — the
   published art form closest to our metaphor, rules written in prose.
   Repos MIT but archived Python: **read, do not vendor.**
2. **Tyler Hobbs — "Flow Fields" (2020), "Simulating Watercolor" (2017)** —
   smooth curves from angle grids; soft edges from many layers of
   gaussian-displaced polygons at low opacity. This is the "less shapes"
   answer. No licence stated → reimplement, never copy.
3. **Inigo Quilez — smin, 2D distance functions, cosine palettes** — blobs
   that melt rather than intersect.
4. **Sighack (Manohar Vanga) — Chaikin curves, MIT** — the cheapest
   de-jank available, safe to port.
5. **MDN "Optimizing canvas"** — the hygiene baseline we already meet.
6. Installed locally: `ui-ux-pro-max`'s **"Biomimetic / Organic 2.0"** style
   card (cellular/fluid, breathing, generative growth; Canvas 10/10) as a
   checklist, plus `emil-design-eng` and `frontend-design` for polish.

**Licence traps to state in every brief:** jasonwebb's differential-growth
and space-colonization repos are **CC BY-NC-SA** (non-commercial — never
vendor); thebookofshaders' repo is **All Rights Reserved** (site readable,
code not copyable); p5.js is **LGPL**.

## Verdict

prd7 is a **form** prd, not a renderer prd. Stay canvas 2D, add ~14 kB of
MIT/ISC geometry helpers, and spend the effort on: semantic roles first,
then ribbons + seeded bounded variation, then the shape-substitution table,
then the blob. Growth algorithms (space colonization, differential growth,
Physarum) are accepted only as **offline geometry authoring** on topology
change — never live per frame.

## Open questions for the operator

- How far does "unique" go: bounded per-lane variation, or a visible
  per-lane signature?
- Watercolour-style soft edges (many translucent layers) — beautiful, but
  it multiplies draw calls; worth measuring before committing?
- Do discrete glyphs disappear entirely from the scene (the fleet table is
  already the legend), or does a minimal set survive for legibility?

## Sources

Per-claim in the three companion notes (URLs + access dates). Probes:
`~/prd7-verify/{a,b,c,d}.mjs` and the live profile script, outputs quoted
verbatim above.
