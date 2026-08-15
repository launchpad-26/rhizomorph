# The renderer spike — canvas 2D against WebGL2, at prd-33's workload

> ## VERDICT: **WEBGL NEEDED**
>
> …for prd-33's stated composition, and **CANVAS HOLDS for the scene as it ships
> today**. The line between those two sentences is the colony count, and nothing
> else.
>
> At **three colonies of thirty lanes**, 1440×900 at dpr 2, canvas 2D runs at
> **40.2 ms/frame on this machine's discrete GPU (25 fps)** and **127.8 ms on its
> integrated one (8 fps)**. The same display list through a WebGL2 painter runs
> at **15.9 ms (63 fps)** and **17.1 ms (59 fps)**. Canvas misses the 16.67 ms
> budget by 2.4× on the best hardware in this box and by 7.7× on the kind of GPU
> most people have. WebGL lands on budget on both.
>
> At **one colony of thirty lanes** canvas costs 11.5 ms and 15.6 ms — inside
> budget on both adapters. ADR-0006 is not wrong about the scene it was written
> for.
>
> **One condition before this is acted on.** Every number was taken under WSL2
> through ANGLE onto D3D12. That layer is real for this operator and
> unrepresentative of a native install, and it is the likeliest way this is
> wrong. **Confirm on one native machine before ADR-0021 moves from `proposed` to
> `accepted`** — §"What would change the verdict" names the result that overturns
> this.

*Issue #566 · prd-33 ruling 11 · 2026-08-15 · rig, raw JSON and screenshots in
`research/spikes/renderer/`.*

---

## The bigger finding, which is not about the renderer

**The shared JS model layer alone costs ~9.5 ms at 30 lanes × 3 colonies and
14.6–16.5 ms at 60 × 3, against a 16.67 ms budget.** That is `layoutScene` +
`sceneMarks` — the same code in both arms, on the CPU, before either painter
touches a pixel. It is ~57% and **88–99%** of the frame.

At 60 × 3 on the integrated adapter, **the scene spends the entire frame budget
deciding what to draw and has nothing left to draw it in.** No renderer swap
moves that by a millisecond. §"The model floor" states what it implies and the
three available responses; prd-33's waves 2–3 need that section more than they
need the verdict.

---

## What was measured

Both arms consume **the same `Mark[]`**, built by the shipping `layoutScene` and
`sceneMarks` and augmented to prd-33's material load. The canvas arm is not a
re-implementation — it is `packages/web/src/scene/paint.ts` itself, imported and
called. **Nothing in `packages/web/src/scene/` was modified by this issue.**

| prd-33 requirement | how it is in the frame |
| --- | --- |
| threads from a central mass, real geometry | the real `layoutScene` — Catmull-Rom spines, `perfect-freehand` outlines, the bundle trunk, the rim ellipse |
| translucent tissue, overlaps blend | the mass's nested iso-shells (`contour.ts`) and the ribbons' own alphas, unchanged |
| depth haze | the existing `depth-fog` and `vignette` washes |
| ~200 drifting ambient particles | one `motes` mark of exactly 200, added |
| one directional light | every living ribbon's flat ink becomes a 3-stop `LinearPaint` across a fixed light axis, added |
| subsurface light | a `glow` under each living thread's body, added |
| continuous growth on every living thread | `growth` advances per lane per frame, so spines genuinely rebuild each frame (ruling 9) |
| a second and third colony | three full fleets, each with its own mass, ring and two cords mid-withdraw (ruling 7) |

**`lanes` is per colony.** "30 × 3" is 90 threads on screen; the 1-colony cells
are the direct analogue of a single fleet as it ships today.

**What is actually in the 30 × 3 frame** — 1060 marks: **646 ribbons carrying
32,534 outline vertices**, 174 glows, 215 glyph paths, 302 motes in 10 marks,
3 contours carrying 60 shells (8,920 vertices), 6 baked, 3 texts, 2 washes,
1 grain. The threads are the frame; everything else is trim. That matters below.

### Parity is evidenced, not asserted

`research/spikes/renderer/shot-canvas.png` and `shot-webgl.png` are one frame
from each arm, same seed, same content. A painter that draws nothing is the
fastest painter there is, and these are the only thing standing between this
spike and that failure mode.

Two visible deltas, both **measured** rather than argued — see the diagnostic
table. The WebGL arm also builds ribbons as triangle strips off the encoded spine
and widths rather than tessellating `perfect-freehand`'s outline, so it loses the
rounded reversal caps; that is the fast path a real GPU port would take, and it
is booked as a migration cost in ADR-0021.

---

## The numbers

**Hardware.** `13th Gen Intel(R) Core(TM) i9-13900H`, 20 threads, 31.2 GiB, WSL2
(kernel `6.6.87.2-microsoft-standard-WSL2`) under WSLg. Chromium 151 **headful**,
GL through ANGLE onto D3D12. Two adapters on the one box, which is how this
machine supplies both "this machine" and "a weaker configuration":

- **discrete** — `ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 4070 Laptop GPU), OpenGL 4.6)`
- **integrated** — `ANGLE (Microsoft Corporation, D3D12 (Intel(R) Iris(R) Xe Graphics), OpenGL 4.1)`

Panel 1440×900 CSS. **30-second steady-state run, 3 runs per cell**, spread
reported. Raw data: `research/spikes/renderer/results.json`.

**frame ms is a mean by construction** — wall clock over the run ÷ frames drawn,
with one pipeline sync at the end, so GPU time is included. **p95 is CPU-side
per-frame** (model + submit); §"Why the p95 is CPU-side" says why an end-to-end
p95 is not separable for canvas on this rig.

### dpr 2 — the operator's own display

| adapter | lanes × colonies | arm | frame ms (mean) | spread | fps | p95 (CPU) | model | submit | GPU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| discrete | 30 × 3 | canvas | **40.2** | 38.6–40.3 | 25 | 19.3 | 9.4 | 3.4 | — |
| discrete | 30 × 3 | **webgl** | **15.9** | 14.8–15.9 | **63** | 17.5 | 9.7 | 2.6 | 4.4 |
| discrete | 60 × 3 | canvas | **61.6** | 60.5–62.4 | 16 | 30.7 | 14.6 | 5.9 | — |
| discrete | 60 × 3 | **webgl** | **17.7** | 17.1–34.8 | 56 | 20.4 | 10.5 | 3.4 | 5.0 |
| discrete | 30 × 1 | canvas | **11.5** | 10.7–11.8 | 87 | 6.3 | 2.9 | 1.4 | — |
| discrete | 30 × 1 | **webgl** | **6.1** | 6.1–6.1 | 165 | 6.1 | 2.9 | 0.9 | 1.6 |
| integrated | 30 × 3 | canvas | **127.8** | 125.8–128.6 | 8 | 17.9 | 9.9 | 3.6 | — |
| integrated | 30 × 3 | **webgl** | **17.1** | 16.5–18.0 | **59** | 19.8 | 10.3 | 3.0 | 6.1 |
| integrated | 60 × 3 | canvas | **154.2** | 153.7–154.5 | 6 | 34.2 | 16.2 | 6.4 | — |
| integrated | 60 × 3 | **webgl** | **28.1** | 27.6–30.4 | 36 | 33.8 | 16.5 | 5.2 | 8.6 |
| integrated | 30 × 1 | canvas | **15.6** | 14.9–20.0 | 64 | 9.4 | 3.6 | 1.7 | — |
| integrated | 30 × 1 | **webgl** | **9.8** | 9.2–10.6 | 102 | 9.0 | 3.5 | 1.1 | 4.3 |

**The one loose cell, disclosed rather than dropped.** `discrete 60 × 3 webgl`
spreads 17.1–34.8 because run 1 of its three stalled: it drew **862 frames
against runs 2 and 3's 1691 and 1757**, and its CPU p95 was **120.3 ms** against
their 20.4 and 19.0 — a stall on the JS side, not the GPU (its timer query read
1.2 ms). Runs 2 and 3 agree tightly at 17.7 and 17.1. The table reports the
median of all three (17.7) and the full spread; the honest reading of that cell
is **~17.4 ms with one outlier caused by the box, not the painter.** Its model
median moved with it — 12.6 ms in the stalled run against 10.5 and 10.1 — which
is the signature of machine load rather than of renderer behaviour, and is the
same confounder `AGENTS.md` records for the scene suite.

Two other cells carry visible spread for the same reason and neither changes a
reading: `integrated 30 × 1 canvas` (14.9–20.0) and `integrated 60 × 3 webgl`
(27.6–30.4).

### The diagnostic cells — what is *not* causing the gap

Each of these was run because it is an objection somebody would raise. All are
30 × 3 at dpr 2, 3 runs each, against the baselines above (canvas 40.2 discrete /
127.8 integrated).

| variant | adapter | canvas | vs base | webgl | vs base |
| --- | --- | --- | --- | --- | --- |
| **dpr 1** (a quarter of the pixels) | discrete | 26.7 | **−13.5** | 16.2 | +0.3 |
| **dpr 1** | integrated | 26.4 | **−101.4** | 17.2 | +0.1 |
| **today's flat material** (no prd-33) | discrete | 39.0 | −1.2 | 16.2 | +0.3 |
| **today's flat material** | integrated | 124.2 | −3.6 | 18.7 | +1.6 |
| **no film grain** | discrete | 41.8 | +1.6 | — | — |
| **no film grain** | integrated | 135.5 | +7.7 | — | — |
| **no root-mass shells** | discrete | 40.3 | +0.1 | 15.9 | 0.0 |
| **no root-mass shells** | integrated | 128.1 | +0.3 | 16.9 | −0.2 |

Four things fall out, and three of them kill an objection.

**prd-33's material is not the problem.** The directional-shading gradients, the
subsurface glows and the 200 ambient motes together cost canvas 1.2 ms (discrete)
and 3.6 ms (integrated). So the honest reading of ADR-0006 is *not* "the new
material broke canvas". It is: **canvas was already at 39 ms / 124 ms for three
colonies of today's marks at this panel size.** ADR-0006's workload was one
colony on a 900×260 panel. Scale did this, not atmosphere.

**The film grain is not the problem.** Removing the one mark the WebGL arm does
not implement made canvas *slower* on both adapters. The omission is not carrying
the result.

**Baking the root-mass would not save the painter, and this is the important
one.** The masses' 60 nested translucent iso-shells (8,920 vertices) are the
obvious overdraw suspect, and "cache them to an offscreen canvas and blit" is the
strongest available objection to this whole spike. So the rig deletes them
outright — the **floor** such a cache could ever reach, since a cache cannot beat
not drawing the thing at all — and canvas does not get faster on either adapter
(+0.1, +0.3, both inside spread). *The shells are not where the raster time
goes.* It goes to 646 ribbons and 32,534 outline vertices, which is the one thing
prd-33 cannot cache, cannot cut, and cannot stop animating (ruling 9).

> **What this cell does *not* say, stated explicitly so it is not misread as
> saying it.** The filter strips `shells` **after** `sceneMarks` has returned, so
> `contourLayers` has already sampled the scalar field and walked its 18–26
> levels by the time anything is deleted. The evidence is in the cell's own model
> numbers, which are unchanged: **9.1 → 9.7 ms discrete, 9.9 → 9.9 ms
> integrated.** So this refutes the caching objection **on the painter side
> only**. It says nothing whatever about the model-side win of baking
> `contourLayers` in unit space — that cost was paid in every one of these runs
> and remains entirely on the table. See response 1 in "The model floor".

**dpr is the other half.** At dpr 1, canvas costs 26.7 / 26.4 — **identical on
both adapters**, i.e. CPU-bound, with the GPU no longer the limit. At dpr 2 it is
40.2 / 127.8. WebGL moves 16.2 → 15.9 and 17.2 → 17.1, i.e. not at all. Canvas's
cost grows with the display and WebGL's does not, so the gap widens exactly where
screens improve.

### Is the canvas arm actually GPU-accelerated?

The comparison would be worthless if Chrome had quietly demoted the 2D canvas to
software raster — a real hazard, since repeated readback provokes exactly that.
It did not, and the control is clean: **the same CPU, the same code and the same
frames cost 40.2 ms on one adapter and 127.8 ms on the other.** A CPU rasteriser
does not get 3.2× slower when you change which GPU it is not using. The canvas
arm is on the GPU.

### The WebGL arm's own internals

`EXT_disjoint_timer_query_webgl2` puts **4.4 ms** of the 15.9 on the GPU. The 2D
overlay carrying type, glyphs and chips costs **0.4 ms**. The whole frame is
**2 draw calls** — one source-over batch, one additive — against canvas's several
hundred individual fills.

### Bundle cost

Measured by differencing three bundles (shared model / model + `paint.ts` /
model + `webgl.ts`), minified then gzipped:

| arm | adds over the shared model, gzipped |
| --- | --- |
| canvas 2D (`paint.ts`) | **2.0 kB** |
| WebGL2 (`webgl.ts`) | **3.4 kB** |
| **difference** | **+1.4 kB** |

**ADR-0006's bundle objection does not survive this.** It was measured against
PixiJS 8.19.0 at 137 kB gzipped for `Application` + `Graphics` — "roughly 2.2×
the app's entire bundle". A hand-written WebGL2 painter with no library costs
1.4 kB more than the 2D painter it replaces. 0006's measurement was right about
*libraries* and was then applied to WebGL as a category.

---

## The model floor

> `layoutScene` + `sceneMarks`, CPU, identical code in both arms:
>
> | lanes × colonies | threads | model ms (across all arms and adapters) | share of a 60 fps frame |
> | --- | --- | --- | --- |
> | 30 × 1 | 30 | **2.9 – 3.6** | 17–22% |
> | 30 × 3 | 90 | **9.4 – 10.5** | 56–63% |
> | 60 × 3 | 180 | **14.6 – 16.5** | **88–99%** |

At 60 lanes × 3 colonies the scene spends nearly the whole frame budget deciding
what to draw. On the integrated adapter the model alone is 16.2–16.5 ms against a
16.67 ms budget: **the frame is gone before the painter is called.** The measured
WebGL total for that cell is 28.1 ms, of which 16.5 is this.

**Even a renderer that cost literally nothing would leave 60 × 3 at ~16 ms**,
which is not 60 fps with anything to spare — it is 60 fps with zero margin and no
room for a camera move, a hover, or a React render on the same thread.

So the renderer verdict buys 30 × 3 comfortably and buys headroom everywhere. It
does not buy 180 threads. Three responses are available, and prd-33's waves 2–3
must pick at least one **before** they assume a budget:

1. **Make the model cheaper.** The repo has already located the offender and
   written down the estimate. `perf.test.ts` records that `contourLayers`
   re-samples the heart's scalar field and re-walks 18–26 levels every frame for
   a shape that differs by the breath's ±1.6%, and that baking it in unit space
   and *placing* it by transform — exactly what `BakedMark` already does for the
   rim flora — takes ~1.3 ms out of 6.4 for one colony. At three colonies that is
   ~3.9 ms of ~15. It was correctly declined while the frame sat at 38% of
   budget; at 88–99% it is the first thing to do.
   **This win is intact and this spike did not test it.** The `noShells` cell
   above strips the shells *after* `sceneMarks` has built them, so
   `contourLayers` ran in full in every run reported here — its model cost is
   present in all of them (the cell's own model time is unchanged: 9.1 → 9.7 ms
   discrete, 9.9 → 9.9 ms integrated). What that cell refutes is the *painter*
   caching objection. The CPU sampling is a separate, untested, still-available
   ~3.9 ms.
2. **Memoise across frames.** `layoutScene` already caches settled retired spines
   and drops the generation when the world moves (`geometry/layout.ts`). Ruling
   9's continuous growth deliberately invalidates that for every *living* lane —
   correctly, since growth is the point. But a growing thread's spine is *the
   same curve truncated further along*: `layoutSpine` already builds the full
   smoothed spine and then calls `truncate(full, easeOut(growth))`. Caching the
   full spine per lane and re-truncating per frame would keep ruling 9 intact and
   remove the dominant per-frame cost. **This looks like the cheapest large win
   available and it does not require a renderer decision.**
3. **Cap lanes × colonies honestly.** If neither lands, prd-33 should state the
   supported ceiling as a number rather than discover it in the field. On this
   hardware with the WebGL painter, 60 fps holds to roughly **90 threads** and
   30 fps to about **180**.

Whichever is chosen, **the number to watch is the model stage, not the frame.** A
regression here will present as a renderer problem and will not be one.

---

## What each implementation cost to write

| | canvas 2D | WebGL2 |
| --- | --- | --- |
| the painter | `packages/web/src/scene/paint.ts` — **already shipping** | `research/spikes/renderer/webgl.ts` — all new |
| lines, total / non-comment | 616 / 365 | 609 / 484 |
| **new code for this spike** | **none** | **484** |
| mark kinds drawn natively | 12 of 12 | 8 of 12 |
| kinds delegated to a 2D overlay | — | 3 — `text`, `path`, `chip` |
| kinds not implemented | — | 1 — `grain` |
| draw calls per frame | one fill per polygon, several hundred | **2** |

Stated plainly: **the WebGL painter is about 1.3× `paint.ts`'s non-comment size
and still does less.** It hands type and glyphs to a layered 2D canvas and skips
the grain entirely. A production version has to close both, which is more code
again. Against that, `paint.ts`'s 365 lines are the residue of many PRDs of
craft, and the WebGL arm reached picture-parity in one sitting — the display list
is what made that possible.

What it is *not* is a rewrite of the scene. The WebGL painter consumed an
**unmodified** `Mark[]`, and that is the whole demonstration: ADR-0006's own
recorded upside — *the display list stays plain data, so a shader layer stays
possible later without re-deciding this* — is precisely what made this spike
cheap. 0006 bought that option deliberately. This is it being exercised.

---

## How it was measured, and three ways the instrument nearly lied

Full detail in `research/spikes/renderer/README.md` and the header of `bench.ts`.
Each was caught by a control; each would have produced a confident wrong answer.

1. **Headless Chrome silently falls back to SwiftShader.** The first probe
   returned `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))` — software. Every
   number would have been a CPU rasteriser in both arms, presented as a GPU
   comparison. The rig now runs headful under WSLg and **refuses** any result
   whose `UNMASKED_RENDERER_WEBGL` names a software device.
2. **`requestAnimationFrame` is not a clock here.** Under WSLg an *empty* rAF
   callback returns a median period of 34.4 ms whatever the page draws, and
   `--disable-gpu-vsync --disable-frame-rate-limit` do not lift it. Read off that
   clock, both arms measure 29 fps and the spike concludes nothing. Replaced with
   a `MessageChannel`-paced loop.
3. **The first canvas result was 198 ms/frame and was mostly the instrument.**
   Syncing each frame with a 1×1 `getImageData` costs ~150 ms of GPU→CPU readback
   under WSL2 *and* provokes Chrome into demoting the canvas to software raster.
   WebGL's `clientWaitSync` does neither, so the two arms' sync primitives are not
   comparable per frame and cannot be made so. The headline metric therefore
   syncs **once per run** and divides elapsed by frames. That is the difference
   between the reported 2.4× and a fabricated 13×.

A fourth, for the record: the first full matrix died at cell 62 of 66 when the
Chrome profile cleanup raced `SIGKILL` and threw `ENOTEMPTY`, taking forty
minutes of unwritten results with it. The runner now writes `results.json` after
every cell. That session's log survives as
`research/spikes/renderer/results-session1.log` and is an **independent
reproduction** of the headline cells — 37.9 / 15.3 discrete and 120.2 / 16.3
integrated at 30 × 3, against this session's 40.2 / 15.9 and 127.8 / 17.1. Both
sessions agree on every reading; the second ran ~5% slower because the box was
also running the spike's own tooling.

### Why the p95 is CPU-side

The brief asks for a p95 because "a smooth 60 fps with periodic 40 ms hitches is
not 60 fps", and that is right. What is reported is the p95 of **per-frame CPU
wall time** (model + submit) inside the streamed run. An end-to-end per-frame p95
needs a per-frame GPU sync, and §3 above is why that instrument is unusable for
canvas here — the measurement would cost 10× the thing measured.

Two things are worth reading off it anyway. **The two arms' CPU p95s are close**
(19.3 vs 17.5 at 30 × 3 discrete) **because they are the same code** — the shared
model dominates the CPU side, which is the model-floor finding arriving from
another direction. And neither arm shows CPU-side hitching far beyond its own
median: canvas's problem is sustained throughput, not spikes.

**This is a real gap in the evidence, named rather than papered over.** The
native-machine confirmation below should take the end-to-end p95 this rig could
not.

---

## What would change the verdict

In the order most likely to actually do it.

1. **A native (non-WSL) machine where canvas 2D holds 60 fps at 30 × 3, dpr 2.**
   Everything here runs through ANGLE onto D3D12 under WSLg. Chrome on native
   macOS drives Skia through Metal and on native Windows through D3D directly.
   The translation layer plausibly costs canvas more than it costs WebGL, because
   the canvas arm issues several hundred draws per frame and the WebGL arm issues
   two — and per-call overhead is exactly what a translation layer adds. **If
   canvas comes in under ~17 ms at 30 × 3 dpr 2 on a native machine, this verdict
   is wrong and ADR-0021 should be rejected.** This is the gate the ADR names.
2. **prd-33 settling for one colony.** At 30 × 1 canvas costs 11.5 ms and 15.6 ms
   — inside budget on both adapters. If ruling 7's "several colonies" turns out to
   mean *one colony now, with the camera merely able to frame more later*, then
   **CANVAS HOLDS for what ships**, and this verdict applies only when the second
   colony arrives. Colony count is the single largest lever in the measurement.
3. **A smaller panel.** Canvas's cost is substantially fill-rate: dpr 1 costs
   26.7 against dpr 2's 40.2. Today's scene ships at 900×260, 22% of the 1440×900
   measured here. A scene that stays a panel rather than becoming the window is a
   different question and this spike does not answer it.
4. **A cheaper ribbon.** The frame is 646 ribbons and 32,534 outline vertices. If
   `ribbon.ts`'s sample count were cut hard — `RIBBON_SAMPLES_MAX` is 48, and the
   file itself records that the high count exists for 6× zoom rather than for the
   default view — canvas's fill might come down materially. This spike did not
   test it, and it is the most plausible unexercised canvas optimisation now that
   the mass-cache idea is dead.
5. **Contradicting numbers at all.** Run `node research/spikes/renderer/run.mjs`
   and disagree with the table. The rig, its raw JSON and its screenshots are
   committed for exactly that.

## What would *not* change it

- **Baking the root-mass offscreen, as a *painter* fix.** Deleting the shells
  entirely — the floor any cache could reach — changes canvas by +0.1 ms and
  +0.3 ms. Measured, on both adapters, with the removal verified (60 shells,
  111 rings, 8,920 vertices gone from the list). This was the strongest objection
  to the verdict and it is refuted. It remains untested, and still promising, as
  a *model-side* fix — see response 1 in "The model floor".
- **The film grain.** Removing it made canvas *slower* on both adapters.
- **prd-33's material.** Worth 1.2–3.6 ms of canvas's 40.2 / 127.8. The material
  did not break the budget; three colonies at full-panel scale did.
- **Bundle size.** 1.4 kB gzipped. Whatever decides this, it is not weight.

---

## The draft ADR

Because the verdict is WEBGL NEEDED,
`docs/adr/0021-webgl2-for-the-living-scene.md` accompanies this note, with these
numbers in it and an honest account of what the migration costs. **Its status is
`proposed`, not `accepted`**, and ADR-0006's status line is deliberately left
untouched: 0006 is superseded only when 0021 is accepted, and 0021 should not be
accepted until item 1 above has been run.
