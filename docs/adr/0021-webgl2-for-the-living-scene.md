# 0021. WebGL2 for the living scene, superseding canvas 2D

- **Status:** accepted — supersedes ADR-0006
- **Date:** 2026-08-15

> **Accepted by operator ruling, on the multiplayer case.** The spike wrote this
> record `proposed` and gated it on a native (non-WSL) confirmation run, because
> every number below was measured through ANGLE onto D3D12. That gate was
> **overruled deliberately, and the reasoning is on the record**: the native
> caveat bears on whether canvas is adequate *today*, not on whether canvas can
> carry **several colonies in one frame** — and several colonies is the product
> (prd-37; "the team layer is the whole point"). On ordinary integrated
> graphics canvas needs **127.8 ms** at 30 × 3. A native install would have to be
> better than **seven times** faster to reach 60 fps, and better than four times
> to reach even 30. No plausible ANGLE correction is that large. **The verdict is
> robust to its own caveat for the case that decides it**, so the confirmation run
> is a courtesy, not a gate.
>
> The falsification line stands as a **revisit trigger** rather than a
> precondition: if anyone later measures native canvas under ~17 ms at 30 × 3,
> reopen this record. See Confirmation.

## Context and Problem Statement

ADR-0006 chose canvas 2D over WebGL on 2026-08-06, and it chose it **by
measurement**: a live Chrome profile of the running scene found it already locked
to 60 fps — 180 frames, median 16.70 ms, p95 16.80 ms, one dropped frame. There
was no renderer bottleneck to fix, so "janky" was reframed as a *form* problem
and prd-07 became a form PRD. That reasoning was correct, and it remains correct
about the workload it was taken against: **flat marks, one colony, a 900×260
panel, no atmosphere.**

prd-33 creates a different workload — translucent tissue with subsurface light,
depth haze, drifting particles, directional shading, continuous growth, and
**several colonies in one frame** (ruling 7). Ruling 11 anticipated that this is
the class where the trade changes, and required that only measurement overturn
measurement.

The spike built the target scene in both renderers. Both arms consume **the same
`Mark[]`**, produced by the shipping `layoutScene` and `sceneMarks`; the canvas
arm is `paint.ts` itself, imported and called rather than re-implemented, so one
side of the comparison is the production painter.

## Considered Options

- **A — Keep canvas 2D**, and cut prd-33's composition to fit it.
- **B — Keep canvas 2D**, and buy the frame back with canvas-side technique —
  bake the root-mass to an offscreen raster and blit it.
- **C — A hand-written WebGL2 painter** behind the existing display list, with a
  layered 2D canvas for type and glyphs.
- **D — A 3D library** (three.js, PixiJS), as ADR-0006 considered under its **B**.

## Decision Outcome

Chosen: **C**.

**The measurement.** 30-second steady-state runs, **3 runs per cell, 78 runs
total**, on a 13th Gen i9-13900H under WSL2/WSLg, Chromium 151 headful, 1440×900
CSS at dpr 2, 1060 marks. `lanes` is per colony. Frame ms is a mean — wall clock
÷ frames, one pipeline sync at the end, GPU included. Full data and method:
`research/2026-08-15-renderer-spike.md`, raw JSON in
`research/spikes/renderer/results.json`.

| adapter | lanes × colonies | canvas 2D | WebGL2 | budget |
| --- | --- | --- | --- | --- |
| RTX 4070 Laptop | 30 × 3 | **40.2 ms** (25 fps) | **15.9 ms** (63 fps) | 16.67 |
| RTX 4070 Laptop | 60 × 3 | 61.6 ms (16 fps) | 17.7 ms (56 fps) | 16.67 |
| RTX 4070 Laptop | 30 × 1 | 11.5 ms (87 fps) | 6.1 ms (165 fps) | 16.67 |
| Intel Iris Xe | 30 × 3 | **127.8 ms** (8 fps) | **17.1 ms** (59 fps) | 16.67 |
| Intel Iris Xe | 60 × 3 | 154.2 ms (6 fps) | 28.1 ms (36 fps) | 16.67 |
| Intel Iris Xe | 30 × 1 | 15.6 ms (64 fps) | 9.8 ms (102 fps) | 16.67 |

Run-to-run spread was under 3% in every cell but one — `RTX 4070 60 × 3 webgl`,
where one run of three stalled on the CPU (862 frames against 1691 and 1757, CPU
p95 120.3 ms against 20.4 and 19.0) and widened the spread to 17.1–34.8. Runs 2
and 3 agree at 17.7 and 17.1.

**A lost on the ruling.** Ruling 7 requires the composition be built for many
colonies from the first line, so prd-37's team layer needs no redesign. Cutting
to one colony to fit the renderer is the renderer deciding the product, which is
the inversion ruling 11 exists to prevent. Noted honestly and prominently: **at
30 × 1 canvas holds on both adapters.** If ruling 7 is ever read down to "one
colony now", this ADR should be **withdrawn rather than accepted**.

**B is refuted by measurement, which is the finding that made this decision
safe.** The masses' 60 nested translucent iso-shells (8,920 vertices) are the
obvious overdraw suspect and the strongest objection to the whole spike. Rather
than argue it, the rig deletes them outright — the *floor* any offscreen cache
could reach, since a cache cannot beat not drawing the thing at all — with the
removal verified against the display list. Canvas does not get faster on either
adapter: **40.2 → 40.3 ms discrete, 127.8 → 128.1 ms integrated**, both inside
spread. The raster time is not in the mass; it is in 646 ribbons carrying 32,534
outline vertices, which ruling 9 requires to keep moving every frame.

*Scope of that refutation, stated precisely:* the filter runs **after**
`sceneMarks`, so `contourLayers` sampled its field and walked its 18–26 levels in
every run reported here (the cell's model time is unchanged, 9.1 → 9.7 ms
discrete and 9.9 → 9.9 ms integrated). B is dead as a **painter** fix. Baking
`contourLayers` in unit space remains a live and untested **model-side** win,
independent of this decision — see the Neutral consequence below.

**D lost on the ground ADR-0006 put it on, and the spike sharpens why.** 0006
measured PixiJS 8.19.0 at 137 kB gzipped for `Application` + `Graphics` — 2.2×
the app's whole bundle — and rejected the ergonomic WebGL option on that. The
measurement was right about *libraries* and was then applied to WebGL as a
category. Measured directly, a hand-written WebGL2 painter adds **1.4 kB
gzipped** over `paint.ts` (2.0 kB against 3.4 kB over a shared baseline). The
weight objection is real for D and does not transfer to C.

**Why C wins on more than one frame number.** The gap is not prd-33's new
material: today's flat display list at three colonies costs canvas 39.0 / 124.2
against the augmented list's 40.2 / 127.8, so the atmosphere is worth 1.2–3.6 ms
of it. It is scale and fill. At dpr 1 canvas costs 26.7 / 26.4 — *identical on
both adapters, i.e. CPU-bound* — and at dpr 2 it costs 40.2 / 127.8, while WebGL
moves 16.2 → 15.9 and 17.2 → 17.1, i.e. not at all. **Canvas's cost grows with
the display and WebGL's does not**, so the gap widens exactly where screens
improve. The WebGL arm draws the whole frame in **2 draw calls** against several
hundred fills, with 4.4 ms of it on the GPU by timer query.

## Consequences

**Good — the display list does not move, and that is why the migration is
affordable.** ADR-0006's own recorded upside was that the display list stays
plain data, guarded by a `structuredClone` conformance test, *"so a shader layer
stays possible later without re-deciding this."* That is the option being
exercised. Concretely: `paint()` has **one** production call site
(`scene/view/useFrameLoop.ts:266`), and only **3 of `marks.test.ts`'s 156 tests**
call `paint({…})` — against a recording stub, not a raster. The other 153, and
the ~11.5k lines of scene tests that assert computed values, do not move.

**Good — `scene/palette.ts`'s mirror does not move either.** The WebGL painter
consumes the same `Rgb` constants and divides by 255; `palette.test.ts`'s
token-parity assertions against `theme/theme.css` are untouched. This was
expected to be a migration cost and measurably is not one. The new colour concern
is premultiplied alpha inside the shader, which is painter-internal.

**Bad — type and glyphs have no cheap GPU form.** The spike layers a transparent
2D canvas over the GL canvas and draws `text`, `path` and `chip` into it
(measured: 0.4 ms, and 215 glyph paths per frame). That is what real WebGL
dashboards do, and it is still two canvases, two coordinate systems and a
compositing order to keep straight. A font atlas is the alternative and is more
work again.

**Bad — the film grain is not implemented.** It needs a texture path and a second
program. Measured cost of its absence: removing grain from the canvas arm moved
that arm *the wrong way* on both adapters (+1.6, +7.7 ms), so it does not affect
the decision — but it is unbuilt work.

**Bad — even-odd fill becomes a coupling rather than a primitive.** `paint.ts`
gets `ctx.fill('evenodd')` from the platform. The spike fans contour rings from
their centroid, which is correct **only because** `contour.ts`'s rings come off a
smoothed scalar field and are star-shaped about their centre. That is a real new
constraint on `contour.ts` that nothing currently enforces. A general even-odd
fill needs a stencil pass.

**Bad — `perfect-freehand`'s caps are lost.** The GL arm builds triangle strips
from the encoded spine and widths rather than tessellating the outline, so the
explicit rounded caps `ribbon.ts` inserts wherever direction reverses more than
90° are gone. Either tessellate the outline on the CPU and pay for it, or accept
a slightly different silhouette. `ribbon.ts` exists to remove exactly that notch,
so this is giving back something the repo bought deliberately.

**Bad — a WebGL context can be lost and a 2D context cannot.** New failure mode,
new recovery path, and one the instrument's read-only-observer posture makes
user-visible if unhandled.

**Bad — issue #244 gets worse, not better, and this must be booked honestly.**
ADR-0006 recorded the canvas draw path being untestable in jsdom as a known,
accepted cost, and named `node-canvas` as the way out. jsdom 30 returns `null`
for `webgl`, `webgl2` *and* `2d`, so neither painter runs there — but the 2D
painter has an identified escape and a GL painter has none. **Swapping renderers
forecloses the fix that was booked against the cost.**

**Neutral — the shared model layer dominates either way, and no renderer swap
touches it.** `layoutScene` + `sceneMarks` cost 9.4–10.5 ms at 30 × 3 and
**14.6–16.5 ms at 60 × 3**, against a 16.67 ms budget: ~57% and **88–99%** of the
frame, on the CPU, before any painter runs. On the integrated adapter at 60 × 3
the model alone consumes the whole budget. This ADR buys 30 × 3 comfortably and
buys headroom; **it does not buy 180 threads, and prd-33 must not read it as
though it does.** The spike's "The model floor" names three responses — bake
`contourLayers` (~3.9 ms, untested, unaffected by anything decided here), cache
each lane's full spine and re-truncate per frame under ruling 9's growth, or
state a supported ceiling as a number.

## Confirmation

This record is `proposed` and gated on one thing:

> **Run `node research/spikes/renderer/run.mjs` on a native (non-WSL) machine.**
> If canvas 2D comes in **under ~17 ms at 30 lanes × 3 colonies, dpr 2**, this
> ADR is wrong and should be **rejected**, not accepted — the gap would be the
> ANGLE/D3D12 translation layer penalising several-hundred-draws-per-frame more
> than it penalises two, rather than a property of canvas 2D. That run should
> also take the end-to-end p95 this rig could not (see the spike note's "Why the
> p95 is CPU-side").

Once accepted, ADR-0006's **Status** line gains `superseded by ADR-0021`, per
`docs/adr/README.md`'s append-only rule. Until then it stands unedited.
