# 0006. Canvas 2D for the scene, with no 3D library

- **Status:** accepted (supersedes the react-three-fiber scaffold, `e83bf9e`)
- **Date:** 2026-08-06

## Context and Problem Statement

> **Reconstructed.** Written 2026-08-06. The decision was ruled 2026-07-31
> (`d1222dd`, prd3 ruling 28) and re-confirmed by measurement 2026-08-02
> (`4323685`). Every claim below is cited. The supporting research note
> `docs/research/2026-08-02-obs-prd7-renderer.md` was deleted from the tree in
> `676faad` and is readable only via
> `git show 4323685:docs/research/2026-08-02-obs-prd7-renderer.md`.

The scene is the product's centrepiece — a living mycelial network standing in
for a fleet of agents. The web package was scaffolded with `three`,
`@react-three/fiber` and `@react-three/drei` (`e83bf9e`, 2026-07-30) and the
first scene, the Constellation, shipped on them.

The operator's review then asked for the scene to be *"smooth, less janky,
procedurally generated"*. "Janky" is a renderer complaint on its face, so the
question was whether to keep going in 3D, move to raw WebGL, or retreat to
canvas 2D.

A hard constraint sat underneath: the scene emits a display list of typed marks
that the test suite queries **as data** — laws like "no alarm ink on a calm
fleet" are assertions over that list — and there is no headless GPU.

## Considered Options

- **A — Keep three.js / react-three-fiber.** Already scaffolded and shipping.
- **B — Move to raw WebGL** (or a thin wrapper such as PixiJS).
- **C — Hand-rolled canvas 2D painter, no 3D dependency.**
- **D — Hybrid:** canvas 2D display list with one WebGL layer for the glow field.

## Decision Outcome

Chosen: **C**, and the three.js dependencies were removed.

The decisive input was a measurement, not a preference. A live Chrome profile of
the *running* scene found it already locked to 60fps — **180 frames, median
16.70 ms, p95 16.80 ms, one dropped frame, and zero `shadowBlur` calls**
(`architecture.md:940-957`). There was no renderer bottleneck to fix. "Janky" was
the *form language* — stroked centre-lines, hard edges, discrete glyph shapes —
so prd7 was reframed from a renderer prd into a form prd.

**A** lost on weight for what it bought: `dbcc20e` dropped `three`,
`@react-three/fiber`, `@react-three/drei` and `@types/three`, along with the
`vendor-three` chunk — *"the whole scene is now 29 kB."*

**B** lost on two independent grounds. It cures nothing measured: every named
cause of canvas-2D jank is a painter bug with a known fix, not a fill-rate wall,
so a renderer swap buys a differently-janky scene. And it costs test coverage
while buying none — jsdom 27.0.1 returns `null` for `getContext('webgl')`,
`('webgl2')` *and* `('2d')`, so a WebGL painter is one this suite could never
execute, whereas a 2D painter at least *could* run under `node-canvas`. The
ergonomic WebGL option was also measured: PixiJS 8.19.0 floors at 137 KB gzipped
for `Application` + `Graphics` alone — roughly 2.2× the app's entire bundle at
the time.

**D** was not rejected so much as **deferred**, deliberately. The display list
already makes the painter swappable, so the hybrid remains available at ~11 KB
gzipped whenever a measured frame budget demands it. Quoting the research note:
*"which is exactly why we need not decide now."*

## Consequences

**Good.** Zero new dependencies; the scene is 29 kB. The display list stays plain
data, guarded by a `structuredClone` conformance test (`marks.test.ts`, #112), so
a shader layer stays possible later without re-deciding this.

**Good.** The `shadowBlur` ban gained a second, independent reason: it is not
affected by the current transform, so glow would not have scaled under the prd5
camera.

**Bad — and known at the time.** The canvas draw path cannot be tested in jsdom.
This was measured and accepted as part of the decision, not overlooked: the scene
suite emits 65 `getContext` "not implemented" warnings, and its ~11.5k lines of
tests assert computed values, never rendered pixels. `node-canvas` was already
identified as the way out if that becomes unacceptable. Tracked as issue #244 —
which should be read as revisiting a known trade-off, not fixing an oversight.

**Neutral.** The painter is hand-written, so scene work is craft rather than
library configuration. That has been the intended cost from the start.
