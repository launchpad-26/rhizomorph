# Rhizomorph prd7 — reference repos, essays and tools for the graphics rebuild

> Researched 2026-08-02 to serve one decision: **give prd7 workers their reading
> list** — the operator wants the mycelium canvas to read "procedurally
> generated, smooth, unique, less janky, less shapes" in the existing ice-neon
> dark theme (green=working / amber=blocked / red=dead).
>
> Grading: **[Verified]** = I fetched the page or queried the GitHub API today
> and quote what I found. **[Consensus]** = multiple secondary sources agree,
> primary not fetched. **[Thin]** = one weak source or I could not verify.
> Licenses come from the GitHub API `license.spdx_id` plus, where that returned
> `NOASSERTION`, the actual LICENSE text.

## The shortlist (ranked — read these first)

1. **inconvergent — "On Generative Algorithms": Hyphae + Differential Line.**
   The published art form closest to our metaphor, by the person who named it;
   growth rules in prose, no code reading needed. Repos MIT but archived
   Python/Cython — **read for technique, do not vendor**. [Verified]
2. **Tyler Hobbs — "Flow Fields" (2020) + "Simulating Watercolor Paint" (2017).**
   Smooth non-jagged curves from a grid of angles; soft shapeless edges from
   stacked 4%-opacity deformed polygons. The direct answer to "smooth, less
   shapes". No stated licence → reimplement, don't copy. [Verified]
3. **Inigo Quilez — `smin`, `palettes`, `distfunctions2d`.** Smooth-minimum is
   how two blobs *melt* instead of intersecting; the cosine palette is one line
   for a coherent ice-neon ramp. No licence → the maths is free, our code. [Verified]
4. **Sighack (Manohar Vanga) — `chaikin-curves`, `easing-functions`,
   `perlin-noise-fields`, `fifteen-lines`.** All **MIT**. Chaikin corner-cutting
   is the cheapest possible de-jank of a polyline. **Safe to port.** [Verified]
5. **MDN "Optimizing canvas" + mattdesl's canvas-sketch (MIT).** Jank is often
   not aesthetics: MDN says *avoid `shadowBlur`*, pre-render offscreen, layer
   canvases, integer coords, `alpha:false`. canvas-sketch is the play-pen. [Verified]
6. **jasonwebb/morphogenesis-resources** — 2.3k★ curated index of every
   differential-growth / space-colonization / physarum resource; the fan-out
   when the five above run out. **No licence file** → link, don't copy. [Verified]
7. **Anthropic's own `algorithmic-art` skill** (anthropics/skills) — installable,
   flow fields and particle systems in p5.js. [Verified]
8. **Grafana node-graph panel** — the one *shipped dark dataviz* whose encodings
   are documented (border arcs, 200-node cap, layered vs force). [Verified]

## 1. Practitioners with written technique

| Who | Read this | What it hands us | Grade |
|---|---|---|---|
| Tyler Hobbs | `essays/2020/flow-fields` | Grid resolution 0.5–1% of width; bounds 50% larger than canvas; step length 0.1–0.5% of width; `num_steps` is the texture dial — short steps = "fur", long = "fluid". Warns Perlin is over-used; suggests quantised angles (π/10, π/4) and custom continuous functions instead. | [Verified] |
| Tyler Hobbs | `essays/2017/a-generative-approach-to-simulating-watercolor-paints` | Recursive midpoint displacement: for edge A→C take midpoint B, draw B′ from a Gaussian around B, replace with A→B′→C. Base polygon ≈7 passes; then 30–100 layers of 4–5 further passes at **~4% opacity each**. Variance is **inherited parent→child**, which is what makes some edges crisp and others fade. This is the recipe for "less shapes". | [Verified] |
| Inigo Quilez | `articles/smin` | Quadratic polynomial smin: `k*=4; h=max(k-abs(a-b),0)/k; return min(a,b)-h*h*k*0.25;`. Notes the CD (clamped-difference) family avoids distorting the field outside the blend zone. `k` is literally the "how melted" knob. | [Verified] |
| Inigo Quilez | `articles/palettes` | `color(t)=a+b*cos(6.283185*(c*t+d))` — four vec3s give an entire coherent palette; keep `c` at integer multiples of 0.5 to cycle. Cheaper and better-behaved than HSV lerping for our state colours. | [Verified] |
| Inigo Quilez | `articles/distfunctions2d` | 2D SDFs for segment, arc, vesica, rounded box, quadratic Bézier, plus rounding and annular ops. The vocabulary for drawing our edges as fields rather than strokes. | [Verified] |
| Sighack | `post/fifteen-ways-to-draw-a-line`, `post/chaikin-curves`, `post/easing-functions-in-processing` | Fifteen ways to draw one line = the anti-jank catalogue; Chaikin = corner cutting for smooth polylines; his Procedural Color series (HSB vs RYB, tonal keys, monochrome schemes) is unusually practical. All code on GitHub under **MIT**. | [Verified] |
| Anders Hoff | `inconvergent.net/generative/` (13 sections) | See §3. Site 403s WebFetch; fetched successfully with a browser UA via curl. | [Verified] |
| Book of Shaders | `thebookofshaders.com` ch. 5 (shaping functions), 11 (noise), 12 (cellular noise) | Still the best noise/shaping tutorial — but see licensing caution. | [Consensus] |
| generativeartistry.com | 9 tutorials (Tiled Lines, Joy Division, Circle Packing, Hours of Dark…) by Ruth John & Tim Holman | Beginner-tier; useful only for the circle-packing tutorial. License not stated on the page. | [Verified] |
| Piter Pasma | — | **Could not find substantive written technique.** His Universal Rayhatcher docs live inside the fxhash viewer (press `h`/`d`), and interviews describe but don't teach. Deprioritise. | [Thin] |

## 2. Repos, with licences

**Safe to depend on** (permissive, maintained):

| Repo | Licence | Why |
|---|---|---|
| `mattdesl/canvas-sketch` (+`-util`) | MIT | Sketch harness, seeded random, export. Active (pushed 2026-06). |
| `jwagner/simplex-noise.js` | MIT | Fast 2D/3D/4D simplex, TypeScript. |
| `d3/d3-shape` | ISC | `curveCatmullRom`, `curveBasis`, `curveBundle` — smoothing our existing polylines with zero new deps. |
| `d3/d3-interpolate`, `d3/d3-delaunay` | ISC | Colour/number interpolation; Voronoi/nearest-neighbour queries. |
| `mourner/rbush`, `kchapelier/poisson-disk-sampling` | MIT | R-tree collision index hyphae needs; even non-gridded seed points. |
| `jonobr1/two.js`; `paperjs/paper.js` | MIT (paper.js: API says NOASSERTION, LICENSE.txt is verbatim MIT) | Renderer-agnostic 2D API; boolean ops and path smoothing if we go vector. |
| `pixijs`, `regl`, `three.js`; `vasturiano/force-graph`, `sigma.js`, `cosmograph-org/cosmos` | MIT | If prd7 escalates to WebGL / graph rendering at scale. |
| `gka/chroma.js` | BSD-style (API: NOASSERTION; LICENSE is 3-clause BSD) | Perceptual (Lab/LCh) interpolation — stops ice-neon ramps going muddy. |

**Read for technique, do not vendor:**

- `inconvergent/{hyphae,differential-line,differential-mesh}` — MIT but archived
  (2014/2018/2016), Python + Cython, 98/697/89★.
- `fogleman/physarum` — MIT, Go, 919★. Clean reference to port.
- `jasonwebb/2d-differential-growth-experiments` (270★) and
  `2d-space-colonization-experiments` (225★) — **CC BY-NC-SA 4.0** (LICENSE text
  verified). Excellent JS, non-commercial. Read the README, write our own code.
- `jasonwebb/morphogenesis-resources` — **no licence file**. Index only.
- `processing/p5.js` — **LGPL-2.1**. Prototypes yes; bundling, think first.

## 3. Differential growth / hyphae — the closest published art form

**Hyphae** (Anders Hoff's own words, fetched today): place a seed circle with a
radius and a direction of travel; append a new node on the perimeter in that
direction; **perturb the angle each step** ("wobble"); **shrink the radius**
slightly per node. Branch by picking a random node and growing roughly
perpendicular — it either collides (rejected) or becomes a branch. Two look-
governing details: *angle perturbation proportional to radius* (thick branches
run straight, thin ones wander), and *child branches start considerably thinner
than the parent* ("about as much mass before and after an intersection").
Nothing may overlap — that non-overlap constraint is what makes it read as
biology rather than as a graph. [Verified]

**Differential line**: start with connected nodes in a circle; inject new nodes
along the line, **prioritising segments that bend more sharply**; each node
wants to be near-but-not-too-near its two neighbours. It grows intricate and
never self-intersects. Hoff cites Nervous System's *Floraform* as the prior art
and a Toronto DGP mazes paper as related. [Verified]

**The parameter set to expose** (from jasonwebb's README, which documents it
best): max distance before an edge splits; min distance between all nodes;
attraction force; repulsion force; influence radius; and a *growth scheme* that
injects asymmetry. His tuning advice: get attraction/repulsion/alignment stable
first, then play with injection. [Verified]

**Adjacent systems worth one hour each:**
- **Space colonization** — Runions, Lane & Prusinkiewicz, *Modeling Trees with a
  Space Colonization Algorithm*, EG WNP 2007 (free PDF, algorithmicbotany.org).
  Parameters map to visible tree traits; the right algorithm if lanes should
  grow *toward* attractor points (e.g. pending work). [Verified]
- **Physarum** — Sage Jenson: three sensors per agent; params are sensor
  distance/size/angle, step size, rotation angle, deposit, decay, plus a 3×3
  mean-filter diffuse. Built on Jeff Jones (2010). His GPU C++ is unpublished;
  `fogleman/physarum` (MIT, Go) is the portable reference. Gives *network
  reinforcement over time* — the language for "this lane has been busy". [Verified]
- **Curl noise** — Bridson, Hourihan & Nordenstam, SIGGRAPH 2007. Divergence-free
  flow: particles never bunch or stall — exactly the janky-drift failure mode.
  [Consensus — found via search, PDF not fetched]
- **Metaballs + marching squares** — Jamie Wong, 2014. Field `f=Σr²/d²`,
  threshold 1, march a grid, **linearly interpolate the crossing point** (the
  step that turns 45° stair-steps into a smooth contour). The canvas-2D way to
  get IQ's smooth-min look without a shader. [Verified]

## 4. Claude / AI skills for design and graphics

- **`anthropics/skills`** ships `algorithmic-art` ("seeded randomness, noise
  fields, organic systems, particles, flows, fields, forces"; p5.js output;
  two-phase — write a philosophy, then the code), plus `canvas-design`,
  `theme-factory`, `frontend-design`, `web-artifacts-builder`. Per-skill
  LICENSE.txt. [Verified]
- **Already installed here**: `frontend-design`, `ui-ux-pro-max`, `dataviz`
  (colour-in-dark-UI discipline), `emil-design-eng` (motion polish),
  `artifact-design`. [Verified — this session's skill list]
- **`obra/superpowers`** (MIT, largest community framework) has **no design or
  graphics skills** — all 14 are process (TDD, worktrees, review). [Verified]
- **Honest verdict**: beyond `algorithmic-art`, there is no Claude skill
  ecosystem for generative graphics. The essays above are worth more.

## 5. Dark-UI dataviz worth studying

- **Grafana node graph** [Verified]: nodes carry *two stats inside the circle*
  and a **coloured arc around the border whose segments sum to 1** — a health
  ring, not a fill colour. Edges encode via thickness, dash and colour, stats on
  hover. Hard caps: 200 visible nodes by default, layered layout degrades past
  500. **Steal**: the border-arc encoding (frees the node fill for identity) and
  the explicit node budget.
- **cobe** (MIT, 5.5k★, `cobe.vercel.app`) [Verified]: 5KB, zero deps, one
  canvas, DOM elements as bindable markers. **Steal**: the discipline — one
  small canvas plus real DOM for anything interactive.
- **kepler.gl / deck.gl** (both MIT, Uber) and **cosmograph cosmos** (MIT)
  [Verified — licence and activity only]: shipped dark-first visuals whose
  layer/blend conventions for glow-on-dark and "many edges that still look
  calm" are readable in source.
- **Linear, Datadog, Sentry, Stripe** dark canvases: frequently cited as the
  "expensive" look (very low-contrast chrome, one saturated accent, generous
  negative space, motion only on state change). **[Thin]** — could not inspect
  their rendering; treat as vibes. Datadog's service-map doc URL 404'd.

## Licensing cautions

1. **thebookofshaders repo LICENSE is "All rights reserved"** — verbatim: *"You
   cannot host, display, distribute or share this Work in any form."* Read the
   website; **never paste its GLSL into our repo**. [Verified]
2. **jasonwebb's experiment repos are CC BY-NC-SA 4.0** — read-only. [Verified]
3. **iquilezles.org and tylerxhobbs.com state no licence at all** (checked all
   four pages). Algorithms aren't copyrightable; literal code is. Reimplement.
4. **p5.js is LGPL-2.1** — the `algorithmic-art` skill emits p5 sketches; keep
   them as prototypes, not app dependencies. [Verified]
5. `paper.js` and `chroma.js` show `NOASSERTION` on GitHub but are MIT and BSD
   in their LICENSE files — safe, just don't trust the badge. [Verified]

## Open questions for prd7

- **I could not find the Rhizomorph source in this repo** — only JOURNAL and
  the prd5 notes mention "mycelium". Confirm it is canvas 2D only; if WebGL is
  acceptable, IQ's SDF/smin material is usable directly instead of via the
  marching-squares workaround.
- Node budget vs Grafana's ≤200: decides whether hyphae growth runs live
  per-frame or is baked to an offscreen layer.
- Is "unique" per-session (seeded by run id, stable on reload) or per-render?
  Tyler Hobbs's seed essay covers the former; it changes the architecture.
- Is the factory commercial? If ambiguous, the CC-NC read-only rule stands.

## Sources (all accessed 2026-08-02)

- tylerxhobbs.com/essays/2020/flow-fields · /essays/2017/a-generative-approach-to-simulating-watercolor-paints — [Verified]
- iquilezles.org/articles/smin/ · /palettes/ · /distfunctions2d/ — [Verified]
- inconvergent.net/generative/ · /hyphae/ · /differential-line/ — [Verified via curl with a browser UA; WebFetch gets 403]
- sighack.com/post/fifteen-ways-to-draw-a-line · /post/chaikin-curves · /post/getting-creative-with-perlin-noise-fields; github.com/sighack/* (all MIT) — [Verified]
- generativeartistry.com/tutorials/ — [Verified]
- github.com/inconvergent/{hyphae,differential-line,differential-mesh}; github.com/jasonwebb/{morphogenesis-resources,2d-differential-growth-experiments,2d-space-colonization-experiments}; github.com/fogleman/physarum; github.com/patriciogonzalezvivo/thebookofshaders; github.com/anthropics/skills; github.com/obra/superpowers — [Verified via GitHub API + LICENSE text]
- cargocollective.com/sagejenson/physarum — [Verified]
- algorithmicbotany.org/papers/colonization.egwnp2007.html — [Verified]
- cs.ubc.ca/~rbridson/docs/bridson-siggraph2007-curlnoise.pdf — [Consensus, not fetched]
- jamie-wong.com/2014/08/19/metaballs-and-marching-squares/ — [Verified]
- developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas — [Verified]
- grafana.com/docs/grafana/latest/panels-visualizations/visualizations/node-graph/ — [Verified]
- **Could not verify**: any n-e-r-v-o-u-s.com write-up on Hyphae/Floraform (403/404 on both attempts); Datadog service-map docs (404); any written Piter Pasma technique essay.
