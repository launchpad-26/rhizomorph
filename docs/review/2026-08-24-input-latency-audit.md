# Input latency and frame variance — a six-lane audit of the drag path

A dated artefact, in the discipline of `2026-08-24-performance.md`: every figure was
**[EXECUTED]** on one box (WSL2, i9-13900H 20-core, 31 GiB, ANGLE D3D12 / Intel Iris Xe) unless
labelled **[REASONED]**, in which case it is argued from the code with nothing run. Measured
2026-08-24 at `4140f6b` by six read-only lanes (input-path, render-loop, react-dom,
electron-shell, measurements, avant-garde; lane transcripts retained by the operator);
re-verified 2026-08-28 at `48c3476` — the addendum at the end records what prd-44's landing
changed and one thing it did not. The repo was verified byte-untouched after the audit.

The operator's report, verbatim: *"dragging around has some latency and lack of responsiveness,
and things stutter a bit"* — felt in the packaged Electron shell under WSLg.

## The short version

| # | Finding | Cost, measured | Confidence |
|---|---|---|---|
| 1 | A pure camera change re-runs the whole model + tessellation, though the camera is one `uniform3f` and nothing upstream reads it | 9.4 ms/frame @30 threads, 17.5 ms @90 — 42–90 % frame occupancy, directly the probability a mousemove waits a full frame | `EXECUTED` |
| 2 | The worst frame runs 1.9–3.3× the median at pinned inputs; ~1,700 mark objects + ~40 arrays are allocated per frame | 30×3: 12–16 ms median, **26–48 ms worst** | `EXECUTED` (variance) / `REASONED` (GC attribution) |
| 3 | `FleetContext` re-renders five consumer surfaces on **every SSE event**; its own comment says "rebuilt on a beat, not per event" | one render generation per event at ~48 % `pane.activity` share; zero `React.memo` anywhere | `EXECUTED` |
| 4 | The rAF loop rebuilds and re-submits unconditionally — including a byte-identical frame while paused | 16–34 ms/frame of CPU at 60 Hz for a still picture | `EXECUTED` |
| 5 | The GPU half of the frame is measured by nothing: `perf.test.ts` times `buildFrame` and calls it "paint" | every GPU claim anywhere is `REASONED` by construction | `EXECUTED` (the gap) |
| 6 | The per-event input path is near-free — 15–21 **ns** per zoom event; hit-test 0.9–2.2 µs | the cost is frame occupancy, not event handling | `EXECUTED` |

Findings 1+2 are the symptom. 3 and 4 are the same defect shape one layer up and down. 5 is the
evidence gap that keeps half of this `REASONED`. 6 kills a family of tempting fixes.

## 1. The camera cannot reach the screen without the model running first

The display list is camera-independent, provably: `grep -rn "camera"` over
`scene/geometry.ts` + `scene/marks/*.ts` returns zero non-comment hits; the camera enters only as
`gl.uniform3f(own.marks.uCam, …)` (`scene/gl/painter.ts:169`) and the overlay's `toScreen`.
Vertex positions are built in world space (`gl/frame.ts`). Yet `drawFrame`
(`scene/view/useFrameLoop.ts`) runs `layoutScene → sceneMarks → buildFrame → 3× bufferData →
draw` on every frame of a pure pan. Every piece of a camera-only repaint already exists: the
painter retains `last: GlFrame` (`gl/index.ts:68-69`), `submit(frame, panel, camera)` takes the
camera separately, and d3-zoom already announces gesture start/end (`setPanning`,
`useFrameLoop.ts:398,403`). The loop simply never takes the path.

Occupancy is the latency: a mousemove dispatched while `drawFrame` executes queues behind it and
waits for the next rAF — a full 16.7 ms. At 42 % occupancy (30 threads) two of five moves pay it;
at 90 % (the shipped 90-thread ceiling) nearly all do. A frame that overruns drops the next vsync
entirely, which is the stutter rather than the latency.

Adjacent, hover-only (skipped during drag by d3's capture-phase `stopImmediatePropagation`):
`pickAt` opens with `canvas.getBoundingClientRect()` per mousemove (`view/hitTest.ts:47`), a
forced-layout risk the ResizeObserver already has the data to remove; and `setPanning` routes a
cursor change through React state on the first move of every gesture (`SceneView.tsx:183`).

## 2. The variance is the stutter, and nothing owns variance

At pinned inputs the workload is identical frame to frame, so worst/median of 1.9–3.3× cannot be
workload. Per frame: `sceneMarks` builds ~1,700 fresh mark objects at 60×3
(`marks/index.ts:48-60`, eleven builders each returning fresh arrays), `frame.ts:200` allocates
one `layers.slice` per label, plus `Runs`, `DrawRun`s, per-glow falloff arrays
(`tessellate.ts:201`). The vertex arrays are already pooled (`Batch`, held for the painter's
life); the display list above them has no equivalent — that asymmetry is the finding. GC
attribution is `REASONED`, not proven: the falsifier is a trace with GC events on the rAF
timeline, plus the same cells under forced out-of-band collection — if worst/median collapses,
proven. Every published ruling table reports medians only; the tail is invisible to the repo's
own numbers (the `worstMs` field already computed at `perf.test.ts:309-326` is simply not
threaded into the report line).

## 3. The React layer does not honour its own beat

`fleet/FleetContext.tsx:74-77` memoises `buildFleet` on `[state.session, clock, manifest]` under
a comment stating the design — *"the fleet is rebuilt on a beat rather than per event"* — but
`state.session` is a fresh reference from `reduce()` per SSE event, so the beat is fiction:
`buildFleet` and five consumer subtrees re-render per event. #183's batching (confirmed live:
55k-event fold 28,832 → 20.6 ms) fixed the layer below; this sibling one layer up was never
re-checked. Behind it: 25 `useStream()` sites on one whole-object context, zero `React.memo` in
`packages/web/src`, and the ledger's selectors keyed on whole-`session`
(`panels/ledger/index.tsx:46-58`). Verified clean: hidden dock tabs do not render
(`PanelGrid.tsx` mounts only the active tab); the SSE burst coalescing is real and shipped.

## 4. A picture that cannot change is rebuilt sixty times a second

Pause pins both clocks (`useFrameLoop.ts:293-296`); the rAF chain is unconditional (`:445-449`).
Past settle, every input to the three stages is pinned and the frame is provably identical —
rebuilt at 60 Hz indefinitely. prd-44 ruling 5's shipped form (the per-mark digest cache) does
not reach this: the loop still walks every stage. The unconditionally-correct form is
skip-the-build, reuse the Batch, **still submit** — no pixel can differ. Note prd-44's closeout
lesson before speccing any mechanism here: its own world-signature `Batch` range *"was tried and
rejected on its own measurement"* — mechanisms below are candidates, not rulings.

## 5. The unmeasured GPU half, and what waits on it

`perf.test.ts` brackets `buildFrame` with timers and labels it `paint`; no test or bench anywhere
measures upload, draw submission, or the ANGLE/D3D12 translation. Waiting on a harness
(`EXT_disjoint_timer_query_webgl2` wired into the existing `research/spikes/renderer/` /
`scene/parity/capture.mjs` rigs): the mass's 18 stencil shells (54 regions / 108 draw calls / 54
full-footprint fills per frame at 3 colonies — `root.ts:165`, `painter.ts:238-262`),
`antialias: true`'s 4× MSAA on a scene whose soft edges are mostly alpha-falloff quads,
`desynchronized: true` (absent; the one context attribute aimed at input-to-photon; the capture
seam `preserveDrawingBuffer: options.capture` already distinguishes the runs), and the
interleaved-buffer question (the current orphaning idiom is *correct*; measure before touching).

## 6. Refuted, with the numbers — so nobody re-proposes

- **Pointer coalescing / `pointerrawupdate`**: d3-zoom binds `mousemove`, not pointer events, and
  the per-event handler is 15–21 ns. The cost is occupancy, not event count.
- **Adaptive DPR during drag**: ADR-0021's own dpr row — WebGL 16.2→15.9 / 17.2→17.1 ms from
  dpr 1→2, "i.e. not at all"; the only dpr-sensitive surface left is the 0.4 ms type overlay.
- **Glyph atlas · instancing-by-blend-class · UBOs**: rejected where they were reasoned —
  `overlay.ts:8-19`, `batch.ts:14-21` ("`lighter` does not commute with `source-over`").
- **Buffer-strategy "fixes"**: `bufferData(STREAM_DRAW)` with a fresh view is the orphaning
  idiom, `.subarray()` is a view not a copy — "this is good code."
- **`backgroundThrottling: false`**: throttling fires on occlusion, never during interaction.
- **Quadtree hit-testing**: linear scan is 0.9–2.2 µs, skipped during drag anyway.
- **Electron 43.4.0 → 43.4.1**: same-minor patch; nothing input-relevant.
- **`packages/app` generally**: the shell is clean — GPU plan correct (prd-34), no
  transparency/throttling tax, main-process work is a 1 Hz native-tray tick that never crosses
  IPC. The two structural residues are WSLg's presentation chain (unreachable from this repo) and
  the adapter honesty line landing on a stderr nobody keeps in tray launches.

## Addendum — re-verified 2026-08-28 at `48c3476`, after prd-44 landed

- Findings 1, 3, 4, 5, 6 are **unchanged** — re-grepped and re-run on current main; the camera
  path, FleetContext memo key, unconditional rAF, and the `paint`-is-CPU-only labelling all stand.
- Model floors on a quiet box (load 0.78): 30×1 **5.8 ms median / 27.1 worst** · 30×3 **12.1 /
  26.4** · 60×3 **27.1 / 80.6** — medians improved since #579's contour bake; the worst/median
  tail (finding 2) is intact and remains the stutter signature.
- **One thing does not reproduce.** The after-table committed with #32's digest cache says
  persistent200 = 11.95 ms median with paint 2.58 ms. On this box the same cell reads
  **21.4–24.6 ms median with paint 17.1–19.5 ms** at each of `6b2256c1` (immediately post-#32,
  post-#579), `1de8a870` (the #551 palette carrier) and `609935cd` (the quality dials) — the two
  newest scene commits are thereby **exonerated** (deltas within noise), and the divergence from
  the committed table is ~7× on the paint stage across all three. Either the table was measured
  under conditions the suite does not reproduce, or the cache does not hit on a second box's run
  shape. A counting law over cache hits would settle it in one run; the wall-clock table cannot
  (prd-44 success 6's own point). Filed as a verification issue rather than assumed either way.
- Run-shape sensitivity is real and larger than load sensitivity: the full 8-test suite reads the
  persistent cells ~2× worse than the same cells filtered (heap/JIT state carried across cells),
  on the same box minutes apart. One more reason every proposal here asserts counts.
