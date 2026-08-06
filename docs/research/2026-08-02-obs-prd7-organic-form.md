# Observatory prd7 — organic form for the mycelium canvas

**Date:** 2026-08-02 · **For:** groom prd7 rendering rulings · **Method:** WebSearch/WebFetch,
primary sources preferred. Claims graded `[Verified]` (primary source fetched, URL cited),
`[Consensus]` (multiple/secondary sources agree), `[Thin]` (single weak source or inference).

**Decision this serves:** the operator wants the scene "more procedurally generated, smooth,
unique, less janky, less shapes." Semantics are LOCKED (thread = lane, width = work size,
hue = state, distance = lifecycle, pulses = commits). This note is a form-only change list:
same meanings, organic rendering, still deterministic, still a queryable display list.

**The one-line thesis:** stop *stroking* lines and start *filling ribbons*. Almost every item
below follows from that single substitution.

---

## Steal-list (ranked)

1. **perfect-freehand's `getStrokeOutlinePoints` — a variable-width stroke as one closed
   filled polygon.** It walks a point list, pushes left/right offset points at `radius`
   perpendicular to the local direction, detects sharp corners by dot product (`prevDpr < 0`,
   i.e. >90°) and emits a rounded cap there, plus round start/end caps — the end cap spans
   `1.5 * PI` "to handle sharp end turns correctly". Taper is `radius *= min(taperStart,
   taperEnd)` clamped at `MIN_RADIUS`. MIT licensed. [Verified —
   `getStrokeOutlinePoints.ts`, repo README]
   **Why it fits:** the thread mark stops being `{path, lineWidth}` and becomes
   `{role:'lane-thread', outline:[[x,y]…]}` — *richer geometry inside the same typed mark*,
   exactly what the constraint asks for. One `fill()` per thread instead of a stroke.
   **The key mapping:** set `simulatePressure: false` and feed our own per-point "pressure" =
   the encoded width function (work size × lifecycle taper). Their velocity-based pressure
   simulation is nondeterministic-feeling and must be off.
2. **Centripetal Catmull–Rom (`d3.curveCatmullRom`, α = 0.5) for the spine.** d3's docs state
   α = 0.5 is centripetal and "Centripetal splines are recommended to avoid self-intersections
   and overshoot"; α = 0 is uniform, α = 1 chordal. [Verified — d3js.org/d3-shape/curve]
   It *interpolates* its control points, so any data-meaningful waypoint stays on the curve.
   **Trick:** d3 curves write to a context object (`moveTo`/`lineTo`/`bezierCurveTo`) — pass a
   fake recording context to harvest sample points instead of drawing, then feed those points
   to the ribbon builder. [Consensus — d3-shape context interface]
3. **Chaikin corner-cutting as the cheap smoother.** Replace each pair A,B with
   `C = 0.75A + 0.25B` and `D = 0.25A + 0.75B`; iterate. [Verified — smarx.com] It converges to
   a quadratic B-spline and needs only lerps — no trig, no matrix. [Consensus] Use it on the
   *outline polygon* after perturbation to kill hairpins. 2–3 iterations only (point count is
   2ⁿ).
4. **simplex-noise v4 + alea, seeded from a hash of the lane id.** MIT, "about 2k minified and
   gzipped", "about 20 nanoseconds for a sample of 2d noise", zero deps, tree-shakeable;
   built-in PRNG was removed in v4 so you pass one: `createNoise2D(alea('seed'))`. [Verified —
   github.com/jwagner/simplex-noise.js] Convert lane id → numeric seed with `cyrb128`/`xmur3`
   feeding `sfc32` or `mulberry32` — bryc's PRNG notes are the practitioner reference.
   [Consensus — github.com/bryc/code jshash/PRNGs.md]
5. **Bounded normal-only perturbation** (the rule that keeps encodings readable — see §2).
6. **Flow field for the *non-semantic* haze only** (Tyler Hobbs). Grid of angles, resolution
   ~0.5–1% of image width, extended 50% beyond the canvas so curves turn back into frame, step
   length 0.1–0.5% of image width "small enough that you don't see any sharp points".
   [Verified — tylerxhobbs.com/words/flow-fields] Steal his "objects distort the grid" idea so
   the ambient filaments visibly bend around real lane anchors.
7. **Space colonization (Runions et al.) run OFFLINE to author geometry.** This is the
   literal mycelium/venation algorithm. Three params: attraction distance, kill distance,
   segment length; each iteration associates attractors to nearby nodes, averages the direction,
   steps one segment, prunes attractors inside kill distance. Needs a spatial index (kdbush)
   or it "gets computationally expensive way too fast". [Verified — jasonwebb Medium;
   Runions et al. SIGGRAPH 2005 / EGWNP 2007]
   Run once per *topology change*, cache the polyline, animate along it. Never per frame.
8. **Recursive midpoint displacement for blobs** (Tyler Hobbs' watercolor): "find the midpoint,
   B. From a Gaussian distribution centered on B, pick a new point B'" — replace edge A→C with
   A→B'→C, recurse. ~7 subdivisions for the base shape. [Verified —
   tylerxhobbs.com/words/a-guide-to-simulating-watercolor-paint-with-generative-art]
   This is the replacement for cartouche rings and seals. **Take the deformation, not his
   layering** — 30–100 layers at 4% opacity is far outside our budget.

---

## 1. Organic curve rendering

**The three ways to get a variable-width stroke in canvas 2D, and which to take.**

| Technique | How | Verdict |
|---|---|---|
| **Polygon ribbon** | Per segment AB with widths w1,w2, emit quad A±N·w1/2, B±N·w2/2 where the normal of (x,y) is (−y,x) normalised. `fill()`. [Verified — gamealchemist] | **Take this**, but in the perfect-freehand form (whole-stroke outline, not per-segment quads) |
| **Stamped circles** | `arc()`+`fill()` per sample at varying r | Reject: hundreds of draw calls/thread; MDN says batch calls, and per-primitive save/restore cycles are the documented slow path [Verified — MDN Optimizing canvas] |
| **N offset strokes** | Stroke the same path several times at different widths/alphas | Reject: N× the stroke cost for a stepped result; strokes carry extra internal drawing work [Thin — Konva's stroke page is qualitative only, no numbers] |

The naive per-segment quad version has a known weakness: consecutive quads meet at a V and
leave a notch on the outside of a turn — gamealchemist's write-up never addresses joins
[Verified: absence confirmed]. perfect-freehand solves it by building **one** outline for the
whole stroke and inserting an explicit rounded corner cap when the direction reverses more
than 90°. That is precisely the "smooth joins without jank" technique to steal.

**Smoothing before widening.** Pipeline order: sparse data-derived control points → centripetal
Catmull–Rom resample → bounded noise perturbation → ribbon outline → optional 2 Chaikin passes.
This mirrors perfect-freehand's own `getStrokePoints` → `getStrokeOutlinePoints` split. Points
below `minDistance = (size * smoothing)²` are dropped [Verified — source]: free decimation.

**Do not use `curveBasis` for the spine.** It is approximating: it triplicates the first and
last points so the ends are hit, but interior control points are not on the curve. [Verified —
d3 docs] If a lane's waypoint carries meaning it must be interpolated → Catmull–Rom.

## 2. Procedural uniqueness from seeded noise

- **Package:** `simplex-noise` v4, MIT, ~2 kB min+gz, ~20 ns/sample, no deps. [Verified]
  The Perlin-simplex patent (US 6,867,776) expired **8 Jan 2022**, so OpenSimplex-as-workaround
  is no longer necessary. [Verified — patents.google.com/patent/US6867776B2, godot-proposals
  discussion #5007]
- **Seeding:** one `alea` instance per noise function created, seeded by a hash of the stable
  lane identity. v4 warns that reusing a single alea across `createNoise2D`/`3D` changes the
  output — so bind seed → noise deterministically and construct fresh. [Verified]
- **Domain warping** (Inigo Quilez): `q = (fbm(p), fbm(p+(5.2,1.3)))`, `r = (fbm(p+4q+(1.7,9.2)),
  fbm(p+4q+(8.3,2.8)))`, result `fbm(p + 4r)`; the `4.0` is the warp intensity.
  [Verified — iquilezles.org/articles/warp/] Cheap in 1D along a curve parameter. Use *one*
  warp level, not two — the second level costs 4 more fbm evaluations for texture nobody will
  read at lane scale.

**The bounding rule — this is the ruling worth writing down.** Classify every geometric channel:

| Channel | Meaning | Perturbation allowed |
|---|---|---|
| position along tangent (arc length) | lifecycle distance | **none** |
| position along normal | nothing | free, up to a hard cap ≈ 0.3× lane spacing |
| ribbon width | work size | ±10% max, and only as a *low-frequency* wobble |
| hue / brightness | state | none |
| tip taper length | nothing | free |

Perturb only rows marked free. Amplitude must be expressed as a fraction of lane spacing, not
in pixels, so it stays sub-threshold at every zoom. [Consensus — this is the standard
"don't perturb the encoding" discipline; no single citation]

## 3. Growth algorithms — which produce mycelium, and can they run live

| Algorithm | Produces | Cost | Live vs offline |
|---|---|---|---|
| **Space colonization** (Runions 2005/2007) | Open (tree-like) or closed (looping) venation — the closest match to "mycelium" | O(attractors × nearby nodes) per iteration; needs kd-tree; "hundreds or thousands of attractors and many thousands of nodes" typical [Verified — jasonwebb] | **Offline / on topology change.** Cache polylines. |
| **Differential growth** | Buckling, undulating, meandering boundaries — lichen/intestine forms. Forces: attraction to neighbours, repulsion from all nearby nodes, alignment to midpoint, plus edge subdivision when edges get long [Verified — jasonwebb/2d-differential-growth-experiments] | O(n²) without a spatial index; node count *grows over time* | **Offline / amortised.** Great for the root-mass outline; unbounded node growth is a hazard. |
| **L-systems** | Self-similar branching | Trivial, fully deterministic | Live is fine — but it reads as *fractal regularity*, not organic. Garnish only (tip filaments, depth ≤3). [Consensus] |
| **Physarum agent sim** (Jones 2010) | The most convincing living-network look. 3 forward sensors, sensor angle β, rotation angle α, sensor offset 9 px, step 1 px, 3×3 mean-filter diffusion with damping 0.1; α>β spontaneously branches, α=β contracts the network [Verified — Jones 2010 params via survey literature] | Sage Jenson ran "between 5 and 10 million particles" on **GPU** [Verified — cargocollective.com/sagejenson/physarum] | **Reject.** Output is a raster trail field, not a display list. Fails the typed-marks constraint outright. |
| **DLA** | Dendritic clusters; stickiness 0.2→0.01 gets "more hairy" | Brute-force random walks; the standard fix is spawning particles near the structure and abandoning strays [Verified — paulbourke.net/fractals/dla/] | **Reject for live.** Random-walk driven → awkward to seed reproducibly, and again a raster. |

## 4. Flow fields as a layout/curve driver

Transferable, with one caveat: a flow field is a *field*, and our threads have fixed data-given
endpoints. So do not trace lanes through the field. Instead:

- Use the field to choose the **slack direction** of the thread between its fixed endpoints —
  sample the field at the midpoint and bend the Catmull–Rom control point along it. Deterministic,
  bounded, and every lane gets a different-but-stable curve for free.
- Use full traced curves only for the **non-semantic haze** behind the scene (Hobbs: short curves
  read as "fur", long curves as "fluid"; step 0.1–0.5% of width). [Verified]
- Steal the **grid-distortion-by-objects** idea so the haze wraps lane anchors — it makes the
  ambient layer look causally connected to the data rather than pasted behind it. [Verified]
- Hobbs' starting-position advice (regular grid = "overly stiff"; circle packing = "evenly
  spaced out, but with enough random variation") maps directly onto how we place haze seeds.
  [Verified]

## 5. "Less shapes" — continuous substitutions for our current primitives

Keep the *mark* in the display list; change only its geometry. Roles/inks/brightness assertions
survive untouched.

| Today | Replace with | Why it stays legible |
|---|---|---|
| **Chevron** (direction) | Asymmetric taper: thick at origin, needle at destination, via `start.taper`/`end.taper` [Verified — perfect-freehand options] | Direction is read from the width gradient, which is already visible along the whole thread — strictly more legible than a 6px arrow |
| **Cut-mark** (a tick at a point) | A **pinch**: a local width minimum in the ribbon at the same arc position | Position preserved exactly; no new object enters the scene |
| **Cartouche ring** (stroked circle) | A closed midpoint-displaced blob at low alpha behind the content (Hobbs' subdivision, 4–5 rounds, no layering) | Enclosure is the signal, not circularity |
| **Seal / badge glyph** (rendered text or icon) | A **knot**: converging filaments plus a small deformed disc, distinguished by hue only | MDN: "Avoid text rendering whenever possible" [Verified] — this removes a perf cost as well as a shape |
| **Commit pulse** (a dot travelling) | A **swell**: a travelling gaussian bump in ribbon width | Uses a channel we already own; no discrete object to collide with anything |
| **Arc** (progress) | Ribbon length + tip taper | Distance already means lifecycle; an arc duplicates it |

The general rule: **replace discrete marks with modulations of a channel the thread already
has.** Every substitution above spends zero new objects.

---

## What to avoid

- `Math.random`, `Date.now()`, or array iteration order anywhere in geometry. Animation clock is
  a separate input from the geometry seed and must never feed the noise field.
- **Per-frame geometry regeneration.** Build outline polygons on data change, cache, and per
  frame only transform/alpha. MDN: "Render screen differences only", "Batch canvas calls
  together", "Avoid unnecessary canvas state changes", "Avoid the `shadowBlur` property
  whenever possible". [Verified — MDN Optimizing canvas]
- Chaikin/subdivision explosion: point count is 2ⁿ. 6 iterations × 200 points × 30 lanes is jank.
  Cap at 3 and cap absolute point count per mark.
- Stamped-circle strokes and multi-pass offset strokes (see §1 table).
- Live Physarum or DLA. Both are raster fields; both break the display-list contract.
- `curveBasis`/`curveBundle` where the control points are data (approximating, not
  interpolating). [Verified — d3 docs]
- MDN's "avoid floating-point coordinates" advice: it is aimed at `drawImage` and integer
  snapping, and applying it to organic curves would reintroduce the jank we're removing.
  [Verified — the tip is stated in a `drawImage`/`Math.floor()` context]
- Re-litigating the simplex patent. Expired 8 Jan 2022. [Verified]

## Open questions (need answers before prd7 issues are fenced)

1. **Do the display-list tests assert on path data or point counts?** If yes, ribbons will churn
   them. Assertions should move to invariants — role, ink, brightness, bbox, width-at-t — *before*
   any of this lands. This is the highest-risk unknown.
2. Do lane spines carry data-meaningful **interior waypoints**? If not, Catmull–Rom is overkill
   and a single bent quadratic per lane is enough.
3. **Antialiasing seams** where adjacent translucent ribbons abut — do we need to union same-hue
   ribbons into one path per fill?
4. No perf harness cited in any prd5 note. 30 lanes × ~24 spine samples → ~60–80 outline points
   per ribbon ≈ 2.4k points/frame total, which *should* be trivial for canvas 2D fill — but that
   is an estimate, not a measurement. [Thin]
5. Offline space colonization needs a home: build step, worker, or memoised at topology change?
6. Does "unique per lane" need to survive a lane being renamed? That decides whether the seed
   hashes the lane id or a stable internal key.

## Sources (all accessed 2026-08-02)

perfect-freehand https://github.com/steveruizok/perfect-freehand + outline source https://raw.githubusercontent.com/steveruizok/perfect-freehand/main/packages/perfect-freehand/src/getStrokeOutlinePoints.ts ·
d3-shape curves https://d3js.org/d3-shape/curve ·
gamealchemist variable-width lines https://gamealchemist.wordpress.com/2013/08/28/variable-width-lines-in-html5-canvas/ ·
Chaikin https://smarx.com/posts/2020/08/chaikin-curves-a-beautifully-simple-algorithm/ ·
simplex-noise.js https://github.com/jwagner/simplex-noise.js ·
bryc PRNGs https://github.com/bryc/code/blob/master/jshash/PRNGs.md ·
US6867776 https://patents.google.com/patent/US6867776B2/en and https://github.com/godotengine/godot-proposals/discussions/5007 ·
IQ domain warping https://iquilezles.org/articles/warp/ ·
Hobbs flow fields https://www.tylerxhobbs.com/words/flow-fields ·
Hobbs watercolor https://www.tylerxhobbs.com/words/a-guide-to-simulating-watercolor-paint-with-generative-art ·
Runions venation 2005 https://algorithmicbotany.org/papers/venation.sig2005.html and space colonization 2007 https://algorithmicbotany.org/papers/colonization.egwnp2007.large.pdf ·
Jason Webb space colonization https://medium.com/@jason.webb/space-colonization-algorithm-in-javascript-6f683b743dc5 and differential growth https://github.com/jasonwebb/2d-differential-growth-experiments ·
Jones 2010 Physarum https://pubmed.ncbi.nlm.nih.gov/20067403/ (params via https://arxiv.org/pdf/2103.00172) ·
Sage Jenson physarum https://cargocollective.com/sagejenson/physarum ·
Bourke DLA https://paulbourke.net/fractals/dla/ ·
MDN Optimizing canvas https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas ·
Konva strokes https://konvajs.org/docs/performance/Optimize_Strokes.html
