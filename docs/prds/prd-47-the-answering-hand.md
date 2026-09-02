# prd-47 — the answering hand: the picture answers the hand, not the model

> **Status:** **BLESSED** — ciaran-slow, 2026-08-28, in session. Milestone `prd47`. Drafted
> 2026-08-28 by KelliherL from `docs/review/2026-08-24-input-latency-audit.md` (six read-only
> lanes at `4140f6b`, re-verified 2026-08-28 at `48c3476`; every cited line checked against
> current main). Consumes prd-44's closeout lessons by name: **a ruling's stated mechanism is
> not a ruling** — every mechanism below is marked *candidate* and loses to measurement without
> amendment — and every extension clause comes with its grooming-time search done. Refuses
> prd-33's model stage, prd-44's shipped territory, and `scripts/gate.sh` (prd-45/46's).

## Problem

The operator's hand is behind the model. Dragging the scene feels laggy and the picture stutters,
and neither is the renderer being slow: a pure camera change — the one thing a drag is — re-runs
the entire model and tessellation stage even though nothing in that stage reads the camera, so at
the shipped 90-thread ceiling the main thread is ~90 % occupied per frame and nearly every
mousemove waits a full extra frame. Separately, the worst frame runs 1.9–3.3× the median at
pinned inputs — intermittent 26–80 ms frames inside a 16.67 ms budget — and no published table
even reports the tail. The same shape repeats above the canvas: the fleet context re-renders five
surfaces on every SSE event against its own "rebuilt on a beat" design, and repeats below it: a
paused, provably identical picture is rebuilt sixty times a second.

The cost tracks the operator's hand and the stream's chatter — two things prd-44's "cost tracks
the swarm" thesis did not reach — and it lands at the exact moments a person is most sensitive:
mid-gesture and mid-glance.

## Evidence

All from `docs/review/2026-08-24-input-latency-audit.md`, re-verified at `48c3476`; box and load
noted there.

- **The display list never reads the camera.** Zero non-comment `camera` hits across
  `scene/geometry.ts` + `scene/marks/*.ts`; the camera enters as one uniform
  (`scene/gl/painter.ts:169`) over world-space vertices. Yet `drawFrame`
  (`scene/view/useFrameLoop.ts`) runs `layoutScene → sceneMarks → buildFrame → 3× bufferData`
  every frame of a pure pan: **9.4 ms @30 threads, ~13 ms @90 on current main**, recomputing data
  the hand did not change. The seam already exists: `painter.last` (`gl/index.ts:68-69`) and
  `submit(frame, panel, camera)`.
- **Occupancy is the felt latency.** 42–90 % of the frame is `drawFrame`; a move dispatched during
  it waits for the next rAF (16.7 ms). The per-event handler itself is 15–21 ns — the input path
  is not the cost.
- **The tail is unreported and unowned.** 30×3: 12.1 ms median / **26.4 ms worst**; 60×3: 27.1 /
  **80.6**. `perf.test.ts:309-326` computes `worstMs` and no report line prints it. ~1,700 mark
  objects and ~40 intermediate arrays are allocated per frame (`marks/index.ts:48-60`,
  `gl/frame.ts:200`); the vertex arrays are pooled, the display list is not. GC attribution is
  **[REASONED]** and gated on its own spike below.
- **The beat is fiction.** `fleet/FleetContext.tsx:74-77` memoises on `state.session` — a fresh
  reference per SSE fold — under the comment "rebuilt on a beat rather than per event"; five
  consumer surfaces re-render per event at a census where `pane.activity` is ~48 % of a busy
  session. Zero `React.memo` in `packages/web/src`; the ledger's four selectors key on
  whole-`session` (`panels/ledger/index.tsx:46-58`). Grooming-time search for the same shape done
  (the prd-44 #104 lesson): `grep -rn "useMemo(.*\[session\]\|\[state.session" packages/web/src`
  — FleetContext and the ledger are the instances; no third found.
- **A paused picture is rebuilt at 60 Hz.** Both clocks pinned (`useFrameLoop.ts:293-296`), rAF
  unconditional (`:445-449`). prd-44 ruling 5's shipped digest cache does not reach the loop
  itself.
- **Hover pays a layout read per move; a cursor change pays a React render per gesture.**
  `view/hitTest.ts:47` (`getBoundingClientRect` per mousemove, hover-only);
  `useFrameLoop.ts:398` → `SceneView.tsx:183` (`setPanning` → subtree render, to change a
  cursor).

## Success

1. A pure camera change runs no mark builder and no tessellation. **Not met while** any counting
   law can observe `layoutScene`, `sceneMarks` or `buildFrame` invoked by a frame whose only
   changed input is the camera.
2. The hand is answered inside the frame it moved in. **Not met while** main-thread occupancy per
   frame during a gesture exceeds the painter's submit cost by more than the overlay's own
   camera-dependent pass — asserted as counts of stage invocations, never a wall clock.
3. A frame whose inputs are byte-identical to the last is not rebuilt. **Not met while** a paused
   scene past settle invokes any build stage, or while the skipped path can produce a pixel that
   differs from the built path (skip the build, never the submit).
4. The fleet is rebuilt on its stated beat. **Not met while** an SSE event that changes nothing
   `buildFleet` reads re-renders a FleetContext consumer; the 1 Hz tick remains the only
   scheduled rebuild.
5. The tail is visible. **Not met while** the model-floor report line prints a median without its
   worst; the variance work itself stays gated behind ruling 4's spike.
6. Every claim above is a counting law that fails when broken (prd-44 success 6's discipline,
   inherited verbatim). **Not met while** any is defended by a reported measurement.

## Non-goals

- **Not the model stage's magnitude.** prd-33 ruling 13's table stands; nothing here moves a cell.
- **Not the retired axis.** prd-44 ruling 5 shipped; the non-reproducing after-table is a filed
  verification issue, not this PRD's.
- **Not the GPU half.** Unmeasured by anything today; the harness is unfiled work below, and every
  GPU-side idea (MSAA, stencil shells, `desynchronized`, interleaving) waits on it.
- **Not `packages/app`.** The shell is clean (audit §6); WSLg's presentation chain is unreachable.
- **Not a motion-class change.** Ambient motion continues during a drag; ruling 1 is decoupling,
  never dropping. A reduced-cadence-during-gesture variant would strain law 10 / prd-33 ruling 12
  and is not proposed.

**Rejected alternatives.** *Pointer-event coalescing* — the handler is nanoseconds; d3-zoom binds
`mousemove`; occupancy is the cost. *Adaptive DPR during drag* — ADR-0021's dpr row: WebGL does
not move. *A glyph atlas / instancing-by-class / UBOs* — rejected where reasoned
(`overlay.ts:8-19`, `batch.ts:14-21`). *"Fixing" the buffer strategy* — the orphaning idiom is
correct. *An unconditional rAF predicate on "did anything move"* — computing the display list to
discover it is identical buys nothing; ruling 2 gates on inputs, not outputs.

## What already exists (do not rebuild)

- `painter.last` (`gl/index.ts:68-69`) and `GlPainter.submit(frame, panel, camera)` — the
  camera-only repaint's whole seam.
- `setPanning` start/end from d3-zoom (`useFrameLoop.ts:398,403`) — the gesture bracket.
- The digest-cache discipline and its closeout lesson (prd-44 ruling 5, PR #102 → #128) — cache
  economics are measured, never assumed.
- `FLEET_TICK_MS` and the clock already in FleetContext's memo key — ruling 3 makes the existing
  design true rather than adding one.
- `worstMs` (`perf.test.ts:309-326`) — ruling 4's report column is computed today, unprinted.
- The ResizeObserver's measured rect (`useFrameLoop.ts:236-242`) — the hover fix publishes two
  fields it already has (and must refresh on scroll — the trap is named in the audit).

## Rulings

## Ruling 1 — a camera change repaints; it never rebuilds

The frame loop keeps the model stage on the rAF exactly as today, and additionally repaints from
the painter's retained frame with the new camera when the camera changed since the last built
frame. The picture says everything it says today; it merely answers the hand sooner.
*Candidate mechanism, not the ruling:* repaint = `submit(painter.last, panel, camera)` plus the
overlay's camera-dependent label pass; `painted.camera` updates so the parity seam cannot go
stale-and-green. The overlay pass's own cost is the first thing the lane measures, and a theme
change invalidates.

## Ruling 2 — an identical frame is skipped at the build, proven at the inputs

When every input to the build (both clocks, size, dpr, theme, quality, toggles, marks-relevant
state) is identical to the previous frame's, the stages are not invoked; the previous Batch is
resubmitted. Gate on **inputs**, never on a computed output. *Candidate mechanism:* an input
signature in `useFrameLoop`; prd-44's rejected world-signature Batch-range is cited as the
warning, not the design — this skips whole builds on exact pin, which has no per-mark economics.
Residual named: `PulseField.step()`'s idempotence at a frozen clock must be verified before the
pin includes it.

## Ruling 3 — the beat is honoured where it is already claimed

`FleetContext` rebuilds on its tick and on the facts `buildFleet` reads — never on reference
churn. The ledger's selectors key on the slices they read. No new architecture: this makes two
comments true. The context-selector refactor (25 `useStream` sites) is explicitly **not** ruled
here — spike first, it re-plumbs half the app.

## Ruling 4 — variance is measured before it is fixed

The tail is attributed before anything pools: a trace with GC events on the rAF timeline plus the
model-floor cells under forced out-of-band collection. If worst/median collapses, the pooling
issue is groomed with the evidence attached; if it does not, the attribution was wrong and the
pooling is never built. Either way the report line gains its `worst` column (one cell,
`perf.test.ts`'s own field).

## Sequencing (waves, each gated as ever)

`scene/view/` and `scene/gl/painter.ts`/`index.ts` are this PRD's territory. `scene/marks/` and
the model stage are **prd-33's** — ruling 4's pooling, if it survives its spike, enters `marks/`
and needs the cross-PRD agreement recorded on the issue. `scene/gl/frame.ts`/`batch.ts` carry
prd-44 ruling 5's shipped cache — read, not reopened. `fleet/FleetContext.tsx` and
`panels/ledger/` are unclaimed. `scripts/gate.sh` is prd-46's; nothing here goes near it.

**Wave 1 — the Keystone.** `prd47 w1: a camera change repaints without rebuilding` (ruling 1,
with its counting laws and the overlay-cost measurement). One lane:
`scene/view/useFrameLoop.ts` + `scene/gl/painter.ts`/`index.ts` + laws.

**Wave 2 — sequential, same file, a stack not a bundle.** `prd47 w2: an identical frame is
skipped at the build` (ruling 2). Follows wave 1 because it edits `useFrameLoop.ts`.

**Wave 3 — parallel, fenced apart:** `prd47 w3: the fleet is rebuilt on its beat`
(`fleet/FleetContext.tsx` + `panels/ledger/index.tsx`) · `prd47 w3: the hover path reads no
layout and the cursor costs no render` (`view/hitTest.ts` + `SceneView.tsx`) · `prd47 w3: the
variance is attributed and the tail is printed` (ruling 4's spike — `research/` note +
`perf.test.ts`'s report line only).

**Wave 4 — gated on wave 3's spike verdict.** `prd47 w4: the display list allocates on a
free-list` — groomed only if the GC attribution holds, with the cross-PRD note for `marks/`.
**It did not hold; wave 4 was never groomed** (see the open question below, and prd-49).

**Unfiled work implied, described not numbered:** the GPU-side harness
(`EXT_disjoint_timer_query_webgl2` on the existing spike rigs) and everything queued behind it —
MSAA, the mass's stencil shells (prd-33's fence), `desynchronized` (WSLg-unknown, the two-canvas
shear risk named), interleaved upload; the StreamContext selector layer; the SSE parse-off-thread
question (`hooks/useEventStream.ts`, unowned by prd-40/44); `content-visibility` on dock panels;
`powerPreference` (stranger-machine); input prediction, gated on a ruling nobody has made about
whether the camera is the instrument's claim or the operator's hand.

## Open questions

- **What does the overlay's camera-dependent pass cost during a repaint-only frame?** Unmeasured;
  wave 1 measures before it lands. Open, not ruled.
- **Is the variance GC?** **Answered NO, 2026-09-01** — `research/2026-08-28-variance-attribution.md`
  (`74007f3`): 0.74 % of animation-frame time at shipped scale, 0 of 764 frames over budget, and
  ruling 4's own falsifier not met (worst/median rose, 1.25x → 1.66x). The pooling was never
  built. The answer is conditional on the scale the instrument renders, and that condition is now
  **prd-49** (`docs/prds/prd-49-potential-change.md`) with issue #190 — a tripwire in the backlog
  rather than a paragraph in a closed PRD.
- **Does `mergeProps`-style context selection (ruling 3's deferred refactor) come here or its own
  PRD?** 25 call sites is a fence question before it is a code question. Open, not ruled.
