# Rhizomorph prd7 — renderer ruling: canvas 2D, hybrid, or WebGL?

> Researched **2026-08-02**, for the decision: **groom the prd7 renderer ruling**.
> Operator wants the scene "smooth, less janky, procedurally generated".
> Dominating constraint: the scene emits a **display list of typed marks**
> (role/ink/geometry) that vitest+jsdom queries *as data* — laws like "no alarm
> ink on a calm fleet" are assertions over that list, and there is **no headless
> GPU**. Grades: `[Ran]` measured, reproducible · `[Verified]` primary source ·
> `[Consensus]` · `[Thin]`. Companion to `2026-08-01-obs-prd5-implementation-vehicles.md`.

## Headline verdict

**Stay canvas 2D for prd7. Spend the budget on painter craft, not a renderer
swap.** Then, *only if* a measured frame budget demands it, add **one** WebGL
layer for the glow/field background behind the same display list — fenced,
flagged, never load-bearing. Three reasons, by weight:

1. **The jank is almost certainly not fill-rate.** Every named cause of
   canvas-2D jank — DPR, half-pixel blur, `shadowBlur`, per-frame gradient
   allocation, state thrash — is a painter bug with a known fix `[Verified]`,
   and none is cured by WebGL. Swapping first buys a *differently* janky scene.
2. **WebGL costs coverage and buys zero testability.** `[Ran]` jsdom 27.0.1
   returns `null` for `getContext('webgl')`, `('webgl2')` *and* `('2d')`. The
   display list survives any painter, but a WebGL painter is one the suite can
   never execute — whereas today's 2D painter at least *could* run under
   node-canvas. That is a downgrade, not a wash.
3. **The only WebGL option with real ergonomics blows the bundle.** `[Ran]`
   PixiJS 8.19.0 floors at **137 KB gz** for `Application`+`Graphics` alone —
   ~**2.2× the app's entire current bundle** (61.8 kB gz, per the prd5 note).
   The cheap options are cheap because you hand-write the shaders.

**Cost:** three prd7 issues (painter hygiene; glow off `shadowBlur`;
marching-squares blob). **Zero new dependencies.** The hybrid stays available at
~11 KB gz whenever we want it, because the display list already makes the
painter swappable — *which is exactly why we need not decide now.*

## 1. Canvas 2D quality ceiling

MDN's optimization guide is load-bearing here; bullets are `[Verified]` against
it unless marked.

- **`shadowBlur` — prime suspect.** MDN: "Avoid the `shadowBlur` property
  whenever possible"; web.dev calls it "very expensive". It is
  **per-draw-operation**, so N glowing marks = N blur passes. Worse, its value
  "doesn't correspond to a number of pixels, and is not affected by the current
  transformation matrix" — so **under d3-zoom our glow radius does not scale
  with the camera**, which reads as jank by itself. Implementations approximate
  the Gaussian with three successive box blurs `[Verified, ariya.io]`.
- **devicePixelRatio.** Backing store = `cssSize * dpr`, scale the context, pin
  CSS size; otherwise everything is resampled soft. `[Ran]` jsdom reports
  `devicePixelRatio: 1`, so DPR must be injectable to stay testable.
- **Half-pixel alignment.** "Odd-integer-width thickness lines do not appear
  crisp" — a 1px stroke on an integer coord spans two columns at 50%; offset by
  0.5. Separately, "sub-pixel rendering occurs when you render objects on a
  canvas without whole values" (`drawImage`). **Nuance:** snapping is right for
  *static* edges, wrong for *moving* marks, where it causes stair-stepping
  `[Consensus]`. Snap the grid and rings; never snap animated positions.
- **Pre-render, batch, don't thrash.** Pre-render repeated primitives offscreen;
  one polyline not N lines; avoid state changes; avoid text. **Layered
  canvases:** MDN explicitly recommends stacking `<canvas>` by update frequency
  (static bg / per-frame scene / UI) — cheapest structural win, zero
  architectural risk. Add `alpha:false` on the opaque background layer.
- **`Path2D` reuse** lets the browser re-tessellate less; Chrome replays draw
  commands out-of-process so retained paths avoid re-transfer `[Consensus]` — no
  primary benchmark found. **Blocker:** `[Ran]` **`Path2D` does not exist in
  jsdom**, so it may live in the painter, never in a mark.
- **API status:** `ctx.roundRect` Baseline since April 2023 `[Verified]`.
  `ctx.filter` is "**not Baseline** because it does not work in some of the most
  widely-used browsers" `[Verified]` — do not build glow on it.
  `OffscreenCanvas`+worker Baseline since March 2023 `[Verified]`, but it fixes
  main-thread *contention*, not visual quality, and `[Ran]` jsdom has neither it
  nor `transferControlToOffscreen`. Defer.

**Ceiling with best practice: high.** Canvas 2D is GPU-rasterized via Skia; the
documented software fallbacks are anti-aliased *concave* paths and some blur
paths `[Consensus, Skia/Chromium threads]`. Rings, dots, links and one blob at a
few hundred marks is nowhere near a fill-rate wall. **The ceiling we are hitting
is craft, not the API.**

## 2. Smooth glow without `shadowBlur`

- **Pre-rendered radial-gradient sprite + `globalCompositeOperation='lighter'` —
  the recommendation.** Bake the glow offscreen *once* (a few sizes), then
  `drawImage` per mark under `'lighter'`, which "determines the color by adding
  color values", Baseline since July 2015 `[Verified]`. Cost/frame ≈ N textured
  blits — same order as drawing the marks, far below N blur passes
  `[Consensus]`. Gradients are expensive to *create*, cheap to *reuse*: cache
  the gradient canvas `[Verified, Illuminated.js]`.
- **Dual-canvas downsampled bloom** for a whole-scene wash (not per-mark): draw
  emitters at ¼ res, `drawImage` back up with smoothing on, composite
  `'lighter'`. Downsampling for a cheap wide radius is the standard bloom
  construction `[Consensus, gamedev.net]`; on canvas 2D the bilinear upscale
  largely *is* the blur, so an explicit blur pass is often unneeded `[Thin]`.
- **Avoid:** `ctx.filter='blur()'` (not Baseline) and hand-rolled JS box blur
  over `ImageData` — see §4 for what per-pixel JS costs at this canvas size.

## 3. The WebGL option, honestly

Sizes `[Ran]` 2026-08-02: latest `npm i`, esbuild `--bundle --minify
--format=esm`, `gzip -9`, minimal realistic entry (fullscreen shader quad; Pixi
= `Application`+`Graphics`).

| lib | version | license | min+gzip | note |
|---|---|---|---|---|
| twgl.js | 7.0.0 | MIT | **10.6 KB** | thin WebGL sugar; you write everything |
| ogl | 1.0.11 | **Unlicense** | **12.5 KB** | tree-shakes well; **no LICENSE file shipped** |
| regl | 2.1.1 | MIT | **27.8–40.3 KB** | 27.8 vendor `regl.min.js`; 40.3 bundling pkg `main` (ships runtime checks); 30.5 from `regl.unchecked.js` |
| pixi.js | 8.19.0 | MIT | **137 KB** | floor — adding a `Filter` changed it <1 KB |

- **(a) Display-list tests** — neutral for all four *iff* marks stay plain data.
  The list is renderer-agnostic by construction; the risk is not the library but
  letting `Texture`/`Path2D`/`Program` handles leak into marks. **Rule for the
  prd: a mark must survive `structuredClone`.**
- **(b) jsdom** — `[Ran]` `webgl` and `webgl2` both `null`, so **any WebGL
  painter is 0% covered**. `headless-gl` can supply WebGL in Node `[Consensus]`
  but is a native build, painful on Windows `[Thin]`, and would test the
  painter, which is not where our laws live. Pixi additionally hard-errors
  without WebGL unless you pull `pixi.js-legacy` `[Verified, pixijs#5778]`.
- **(c) reduced-motion / pause** — neutral; lives in the rAF driver above the
  painter. `[Ran]` raw jsdom has **no `window.matchMedia`**, so the preference
  must be injected as a port, not read inline. WCAG wants explicit pause/stop
  for non-essential motion over five seconds `[Consensus]`.
- **(d) d3-zoom camera** — canvas 2D consumes the transform directly as
  `ctx.setTransform(k,0,0,k,x,y)`, already proven headlessly `[Ran, prd5 note]`.
  WebGL means rebuilding it as a projection uniform: not hard, but re-doing
  solved work, and it is the seam most likely to drift in a hybrid.

**Verdict:** Pixi disqualified on bundle alone. regl has the nicest API but is
2–4× the size for one shader layer. If we ever go hybrid it is **twgl** (MIT,
smallest) over ogl — ogl publishes `"license": "Unlicense"` with no LICENSE file
in the package `[Ran]`, which some scanners flag.

**Hybrid, specified:** canvas 2D keeps *all* marks; one WebGL canvas sits
*underneath* as a background field/glow driven by the same camera and a few
uniforms (time, agent positions, alarm weight). It draws **no marks**, asserts
nothing, and can be dropped at runtime with zero law breakage. That is the only
hybrid worth having — and it is a prd8 conversation.

## 4. SDF / metaballs for the root-mass blob

`[Ran]` 2026-08-02, node 22.9.0, 1200×800, 12 balls, pure JS field math (V8 cost
only — the dominating term). 60 fps = 16.67 ms/frame for *everything*.

| technique | ms/frame |
|---|---|
| per-pixel inverse-square, full res (1200×800) | **42.8** |
| per-pixel inverse-square, ¼ res (300×200) | 2.70 |
| per-pixel inverse-square, ⅛ res (150×100) | 0.69 |
| **marching squares, 6px cells (200×134)** | **1.28** |
| marching squares, 10px cells (120×80) | 0.44 |
| SDF + IQ quadratic `smin`, 6px cells | 3.07 |
| SDF + IQ quadratic `smin`, full res | **108.5** |

- **Per-pixel metaballs on the CPU are off the table** — 42.8 ms/frame is 2.5×
  the whole budget before a pixel is written `[Ran]`.
- **Marching squares at a 6px grid wins: 1.28 ms/frame** `[Ran]`, and it yields a
  **contour polygon, not pixels**. Decisive for us: a polygon is *a typed mark
  with geometry* — it goes straight into the display list and stays assertable.
  Pixel-threshold approaches produce nothing the tests can query. Also matches
  practitioner consensus as the efficient 2D-metaball route `[Consensus]`.
- **IQ smooth-minimum** is the right blend. Quadratic, normalized:
  `k *= 4.0; h = max(k-|a-b|,0)/k; return min(a,b) - h*h*k*0.25;` `[Verified]`.
  Caveats to respect: **not associative** — `smin(a,smin(b,c)) ≠
  smin(smin(a,b),c)`, so **blend order matters** and must be deterministic (sort
  by agent id, never iteration order, or the blob is non-reproducible and
  snapshots flap) `[Verified]`. The `k *= 4` normalization makes `k` equal the
  max thickening `[Verified]`. Costs ~2.4× the plain field (3.07 vs 1.28 ms)
  `[Ran]` — affordable, but only on a coarse grid.
- **Construction to groom:** agents → SDF circles → IQ `smin` on a 6–8px grid →
  marching squares → one smoothed contour → emit as a single `role:'root-mass'`
  mark → painter fills it with the §2 glow. Concentric rings become one
  breathing blob and the mark count *drops*.

## 5. Determinism + testability

**No, there is nothing better than what we do — our architecture is the good
one.** Confirmations: **Vega** is the strongest precedent (a real scenegraph with
`sceneToJSON`/`sceneFromJSON`), and its maintainers note pixel-level canvas
comparison "can differ across operating systems" `[Verified]` — the trap we
avoid. **`jest-canvas-mock`** records draw calls via `__getEvents()`/`__getPath()`
`[Verified]`, but that is the *weaker* pattern: it asserts on the painter's call
log, so it breaks on every legitimate refactor. Marks-as-data asserts on
**intent**. Golden-image/pixelmatch needs a GPU and is OS-fragile `[Consensus]`.

Three upgrades worth grooming as issues:

1. **`structuredClone` conformance test** — clone the display list, deep-equal
   it. Mechanically enforces marks-stay-data and pre-blocks the
   `Path2D`/`Texture` leak that would kill any future painter swap.
2. **Golden-geometry snapshots with a rounding serializer** (floats to ~3dp).
   Catches blob shape regressions without OS float flap; Vega's approach minus
   the pixels `[Consensus]`.
3. **Seeded determinism law** — "procedurally generated" implies a PRNG. Make the
   seed an explicit input; assert same seed + same state ⇒ deep-equal display
   list. Without it the blob is untestable by construction. Pairs with the
   `smin` ordering rule.

## What to avoid

- `shadowBlur` for glow — expensive, per-op, **and does not scale with the
  d3-zoom transform** `[Verified]`.
- `ctx.filter` — not Baseline `[Verified]`.
- Per-pixel CPU metaball fields — 42.8 ms/frame `[Ran]`.
- **PixiJS** — 137 KB gz floor `[Ran]`, ~2.2× the whole current bundle.
- `Path2D`/textures/any live handle **inside a mark** — `Path2D` is absent from
  jsdom `[Ran]`; this is the one change that could permanently break the test
  architecture.
- Snapping *animated* positions to integers — cures blur, causes stair-stepping.
- Migrating tests to painter-call-log snapshots — a strict downgrade.
- `OffscreenCanvas`/worker as a *quality* fix — wrong problem, absent in jsdom.

## Open questions (need a measurement, not a source)

1. **What is the actual frame time today, and where does it go?** Nothing above
   should be actioned before a Chrome performance profile of the live scene. At
   3 ms/frame this is a visual-design problem and the renderer question is moot.
2. **Frame *time* or frame *pacing*?** Steady 45 fps vs 60→20 hitches have
   different cures (paint cost vs GC from per-frame allocation in the rAF loop).
3. **Does "procedurally generated" mean the *blob* or the *whole scene*?** §4
   answers the blob; a fully procedural background field is the one requirement
   that genuinely argues for the §3 hybrid.
4. **Mark count at peak fleet?** §1's ceiling assumes hundreds — revisit at tens
   of thousands. And: is ogl's Unlicense-without-a-LICENSE-file acceptable to
   repo policy, if we ever go hybrid?

## Sources (all accessed 2026-08-02)

- MDN *Optimizing canvas* — https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas
- MDN *shadowBlur* — https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/shadowBlur
- MDN *filter* — https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/filter
- MDN *globalCompositeOperation* — https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/globalCompositeOperation
- MDN *roundRect* — https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/roundRect
- MDN *OffscreenCanvas* — https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas
- MDN *Applying styles and colors* (lineWidth/crisp lines) — https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Applying_styles_and_colors
- MDN *prefers-reduced-motion* — https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
- web.dev *Improving HTML5 Canvas performance* — https://web.dev/articles/canvas-performance
- Inigo Quilez *Smooth minimum* — https://iquilezles.org/articles/smin/
- Ariya Hidayat *The art of blurring the shadow* — https://ariya.io/2010/09/the-art-of-blurring-the-shadow
- greweb *Illuminated.js* (cached radial-gradient lights) — https://greweb.me/2012/05/illuminated-js-2d-lights-and-shadows-rendering-engine-for-html5-applications
- vega/vega-scenegraph — https://github.com/vega/vega-scenegraph
- jest-canvas-mock — https://www.npmjs.com/package/jest-canvas-mock
- pixijs/pixijs#5778 *Cannot run unit tests in chrome --headless due to WebGL* — https://github.com/pixijs/pixijs/issues/5778
- Google *Introducing Skia Graphite* — https://blog.google/chromium/introducing-skia-graphite-chromes/
- Henry Schmale *2D Metaballs using Marching Squares* — https://www.henryschmale.org/2022/04/04/metaballs.html

`[Ran]` measurements reproduce from `scratchpad/bsize/`: `mb.mjs` (metaball
benchmark), `probe.mjs` (jsdom capability probe), `e_*.js` + esbuild (bundle
sizes). Environment: node 22.9.0, jsdom 27.0.1, Windows 11.
