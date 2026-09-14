# prd-47 — the answering hand: the picture answers the hand, not the model

> **Status:** **SHIPPED** — 2026-09-02. Milestone `prd47`: six issues, all closed, three waves;
> wave 4 was never groomed and its ruling was answered NO-GO. The closeout, including what the
> plan got wrong, is the last section of this document.
> Blessed by ciaran-slow, 2026-08-28, in session. Drafted
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

> **SUPERSEDED** by ruling 4's NO-GO (closeout, 2026-09-02): the gate this wave was declared
> behind was measured and did not open, so no issue was ever filed against it and none will be.
> The condition under which the question is re-asked is prd-49 and issue #190, not this
> paragraph. Marked rather than deleted, so citations to it keep resolving — and marked at all
> because a wave left declared with no issue reads to `scripts/dev/prd-reconcile.sh` as a hole
> where the work went missing, which is the opposite of what happened here. No issue claims w4,
> so retiring it strands nothing.

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
  **prd-49** (`docs/prds/done/prd-49-potential-change.md`) with issue #190 — a tripwire in the backlog
  rather than a paragraph in a closed PRD.
- **Does `mergeProps`-style context selection (ruling 3's deferred refactor) come here or its own
  PRD?** 25 call sites is a fence question before it is a code question. Open, not ruled.

## The four rulings, as they landed

**Ruling 1 — a camera change repaints; it never rebuilds.** Landed in wave 1 (#156, PR #164) as
`ScenePainter.repaint()`. The candidate mechanism survived contact, and the reason is recorded on
the issue: the seam already existed — `submit(frame, panel, camera)` and
`overlay.draw(frame, panel, camera)` have always taken the camera separately, and `buildFrame`'s
output contains zero reads of `panel.camera`, which is what makes replaying a retained frame under
a new camera *correct* rather than approximate. Held by counting laws, not measurements
(`useFrameLoop.test.ts:147`), including the one that matters most —
*"five camera moves in a row still build nothing — where a rebuild would hide"*.

**Ruling 2 — an identical frame is skipped at the build, proven at the inputs.** Landed across
wave 2 (#157 and #178, PR #182): the build skip and, as its sibling, the vertex upload a repaint
no longer re-sends. Ten laws, `L1`–`L10`. **The ruling's named residual became one of them** —
`L8: the pin is honest at a frozen clock` is `PulseField.step()`'s idempotence, which the ruling
required be verified before the pin included it. A residual that turns into a law is the best
outcome available to a residual.

**Ruling 3 — the beat is honoured where it is already claimed.** Landed in wave 3 (#158, PR #194).
`FleetContext.tsx:45` cites the ruling in the file it governs. The scope discipline held: the
25-site `useStream` selector refactor was explicitly not ruled, and was not smuggled in.

**Ruling 4 — variance is measured before it is fixed.** **The only ruling in this document whose
outcome was a NO**, and it worked exactly as written. The spike ran (#160, PR #194,
`research/2026-08-28-variance-attribution.md` at `74007f3`), the falsifier the ruling itself
specified was applied, and it was **not met**: worst/median *rose* under forced out-of-band
collection, 1.25x → 1.66x, rather than collapsing. GC was 0.74 % of animation-frame time and 0 of
764 frames missed budget. So the pooling was never built, the wave was never groomed, and the
report line gained its `worst` column either way, as the ruling required
(`perf.test.ts:486-489`).

## The six success criteria, assessed

1. **A pure camera change runs no mark builder and no tessellation — MET.** Counting laws, not a
   wall clock, per criterion 6.
2. **The hand is answered inside the frame it moved in — MET as specified**, which is to say as
   counts of stage invocations. The document was careful to define it that way and the laws honour
   it; see the open question below for what that leaves unmeasured.
3. **A byte-identical frame is not rebuilt — MET.** `L1`–`L10`, including the frozen-clock pin.
4. **The fleet is rebuilt on its stated beat — MET.** The 1 Hz tick is the only scheduled rebuild,
   and while replaying the beat stops entirely (`#155`'s one-clock rule).
5. **The tail is visible — MET.** The model-floor report prints `worst` beside its median.
6. **Every claim is a counting law that fails when broken — MET**, and this is the criterion that
   carried the others: ruling 4's spike is the one place a measurement appears, it is reported
   rather than asserted, and its verdict lives in prose and on the issue rather than in a
   wall-clock assertion. `EXECUTED` 2026-09-02: `useFrameLoop.test.ts`, `hitTest.test.ts` and
   `fleet/` → 8 files, 125 passed.

## The three open questions, answered

**What does the overlay's camera-dependent pass cost during a repaint-only frame?**
**Answered as far as it can be here, and the limit is stated.** PR #164 records it plainly: *it
cannot be timed under jsdom* — `getContext('2d')` is null, so `overlay.draw` no-ops — **and no
number was invented**. What was produced instead is the countable work the pass walks per repaint,
at three scales: 30 lanes → 331 marks / 75 overlay items / 104 draw calls; 90 → 983 / 225 / 224;
180 → 1972 / 451 / 404. A wall-clock figure for this pass still does not exist, which is the same
gap prd-49 names from the other side: **the only browser trace this PRD produced was a dev-server
one**. Refusing to invent the number was the right call and is why this reads as a gap rather than
as a wrong answer.

**Is the variance GC?** **NO**, and conditionally so. Answered in the Open questions section above
with its evidence; the condition is carried by **prd-49** and issue **#190**, which is open. This
is the whole reason prd-47 could not simply be closed out in silence.

**Does `mergeProps`-style context selection come here or its own PRD?** **Still open, and still
unowned.** Ruling 3 deferred it, wave 3 did not touch it, and nothing since has taken it. It
remains a fence question before it is a code question — 25 `useStream` call sites.

## What the plan got wrong

**Almost nothing, and that is the finding.** prd-47 is the first PRD in this cohort drafted after
prd-44's closeout lessons, and it applied them: every mechanism in its rulings is marked
*candidate* and explicitly loses to measurement without amendment. Ruling 1's candidate mechanism
survived; ruling 4's gate closed. **Neither outcome required an amendment**, because the document
had already said which parts were allowed to be wrong. Compare prd-45, whose ruling 4 named
`if: always()` as though the mechanism were the ruling and needed a superseding note when it was
falsified. This is that lesson working.

**The one thing it got wrong is the record, not the plan.** Wave 4's paragraph stayed declared
after its gate closed, so the milestone read as having a hole in it — `prd-reconcile.sh` reported
`VACANT wave 4` — while the truth was a decision, not an omission. The 2026-09-01 edit added the
prose; this closeout adds the marker the corpus already has for exactly this, which is what
actually clears the row.

**And a scope note worth keeping.** Wave 3 bundled three fenced-apart issues into one PR (#194)
and the third of them, #160, was the ruling-4 spike whose *only* deliverables were a research note
and one report column. Bundling a spike with two behavioural fixes worked here because the fences
were disjoint, but it means the NO-GO — the most consequential single fact this PRD produced —
landed inside a PR whose title is about three other things. That is how it came to need a separate
PRD to be visible at all.

## Residuals, with owners

- **The conditional NO-GO.** **prd-49**, issue **#190**, open, `Later` / `Low`. The trigger and
  the re-measurement order (production build first, pooling never on the trigger alone) are on the
  issue. **Owned.**
- **A wall-clock cost for the overlay's camera-dependent pass**, and more generally a browser
  measurement against a production rather than dev-server build. Named by open question 1 here and
  by prd-49's evidence section. **No owner.**
- **`mergeProps`-style context selection**, 25 `useStream` sites. Deferred by ruling 3, still
  unowned, still a fence question first.
- **The unfiled work this PRD described but never numbered** — the GPU-side harness
  (`EXT_disjoint_timer_query_webgl2`) and everything queued behind it, the StreamContext selector
  layer, the SSE parse-off-thread question, `content-visibility` on dock panels, `powerPreference`,
  and input prediction, the last of which is gated on a ruling nobody has made about whether the
  camera is the instrument's claim or the operator's hand. **No owner**, and named here rather
  than re-described: the Sequencing paragraph above is still the list.
