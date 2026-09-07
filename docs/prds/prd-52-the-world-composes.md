# prd-52 — the world composes: the scene holds several colonies, and the size it holds is a law

> **Status:** **BLESSED** — Lachlan Kelliher, 2026-09-07, in session. Milestone `prd52`. Drafted
> the same session from an audit of `scene/**` against prd-33 ruling 7's composition claim.
> Blessed with prd-49's tripwire amendment landing first, in the same branch, because prd-52
> changes what that trigger refers to and the ruling belonged before the change.
> Consumes prd-51 (the split) and prd-37 (parked) as **neither dependency nor product**:
> this PRD is the rendering half, and it is the half that waits on nothing. prd-33 is closed;
> ruling 1 below records what this PRD takes from it and why.

## Problem

The scene renders exactly one colony, and the multiplayer conversion arrives on top of it.

`prd-33` ruling 7 declared the scene *"composed as a world that holds several colonies"* and
promised that when the team layer landed, *"no redesign is required."* That promise is what the
conversion is about to be built against. It does not hold: the composition it describes was
anticipated in comments and one cache constant, and never written. A conversion that discovers
this on the day pays for it in the worst possible place — in the renderer, under time pressure,
with a data layer already in flight above it.

The second half of the problem is that nothing currently makes a scale regression fail. The
supported size is a sentence in a shipped PRD. The costs that would break it — a per-colony term
that turns out to be per-world, a detail level that quietly eats a channel carrying meaning —
have no test that goes red. When colonies become real, the fleet gets three times larger in one
step, and the first signal would be a session that feels wrong.

## Evidence

- **`layoutScene` takes one fleet and centres it in the whole viewport.**
  `packages/web/src/scene/geometry/layout.ts:217-229` — one `Fleet`, one
  `centre = { x: width / 2, y: height / 2 }`, one `rootRadius`, `rx`/`ry` from the box handed in.
  There is no placement step and no second centre.
- **The camera fits one geometry.** `packages/web/src/scene/camera.ts:154-170` — `contentBounds`
  unions one `SceneGeometry`'s threads; `fitCamera` fits that one box. No union-of-N form exists.
- **The display list is built for one frame object.** `packages/web/src/scene/marks/index.ts:48`,
  and `SceneFrame.fleet` is singular at `packages/web/src/scene/marks/frame.ts:38-48`.
- **Selection collides across masses.** `packages/web/src/fleet/selection.tsx:58` —
  `MAIN_SELECTION = 'main'` is one hardcoded pseudo-lane id for the root mass. N colonies are N
  masses and one id.
- **One file was genuinely built for N masses, and it proves the rest were not.**
  `packages/web/src/scene/contour.ts:317-332` sizes its bake cache for *"Three colonies is three
  masses (prd-33 ruling 7)"* and keys purely on shape, not caller.
- **The binding cost is the model stage, before any painter runs.**
  `docs/adr/0021-webgl2-for-the-living-scene.md` — *"the shared model layer dominates either way,
  and no renderer swap touches it… it does not buy 180 threads."* `docs/operational-targets.md:85`
  — 17.1 ms at the 180-thread model floor, **of which `sceneMarks` is 15.0 ms**.
- **Within marks, the thread builder dominates.** `docs/design-notes/geometry-cache-audit-178.md`
  — at 160 lanes, `sceneMarks` 16.7 ms of which `threadMarks` 9.75 ms.
- **The measured cells are a floor, not the feature.** `packages/web/src/scene/perf.test.ts`'s
  `colonyFleet` (~1334-1347) fakes a colony by building a separate `Fleet` and summing
  independent `layoutScene`+`sceneMarks` calls, each given the full unshrunk viewport. It charges
  nothing for placement, a shared camera, cross-colony marks or merged hit-testing.
- **A growing lane misses the whole cache chain.** `geometry/layout.ts:~359` keys the living
  spine on `growth.toFixed(6)`; `layout.ts:142` builds the full spine then truncates; and
  `ribbon.ts:170`'s outline cache is a `WeakMap` keyed on the path array's **object identity**,
  which the fresh truncated array destroys every frame.
- **The count-keyed retreat already exists and is already lawful.**
  `packages/web/src/scene/geometry/scale.ts:225` (`LABELS_ALL_MAX = 28`) feeding
  `layout.ts:498`'s `labelPolicy: 'hover'`, named in `geometry/types.ts:193` as ruling 31's
  named cheap retreat.

## Success

1. **The scene renders N colonies from N fleets.** Not met while `layoutScene` is the only entry
   point and a second fleet has nowhere to go.
2. **A solo user's picture is unchanged.** Not met while composing one colony produces any mark
   the current path does not, byte for byte.
3. **The supported size is enforced, not asserted.** Not met while the numbers in prd-33 ruling
   13 can drift without a test going red.
4. **A per-colony cost cannot silently become a per-world cost.** Not met while any term scales
   with total world threads where it should scale with its own colony's.
5. **Detail may thin, and may never lie.** Not met while any substitution level changes thread
   hue, thread brightness, radial position or encoded width.
6. **The composed cost is measured, not extrapolated.** Not met while the only 180-thread number
   is a sum of three independent single-colony renders.

## Non-goals

- **Identity, colour, the veil, the org roll-up.** prd-37's product surfaces, parked, and gated
  on the team server's first law. Nothing here names a person.
- **Any data path.** No transport, no ingest, no projection. The team-server runbook's law is
  *"Diaries only travel up. Nothing comes back down onto anyone's laptop. Not in this version."*
  This PRD takes fleets from wherever it is handed them and reaches for nothing.
- **Correcting the "nothing leaves this machine" prose.** prd-51 wave 5 owns that sweep, last and
  deliberately, *"so it describes what was witnessed rather than what was planned."*
- **The display-list free-list.** prd-47 ruling 4's NO-GO stands; prd-49 and #190 hold the
  condition under which it is re-asked. Nothing here re-opens it.
- **Promising 60 fps at 180 threads.** See ruling 3.

**Rejected alternatives.** *Unparking prd-37 whole* — four of its six success criteria cannot be
met until the first law changes, so most of the document would be blocked on the day it was
blessed. *Amending prd-33* — its closing amendment states rulings 1–13 stand as written and
nothing is renumbered; a closed PRD is not the place to grow a new programme. *Frustum or
priority culling* — refused twice over: prd-03 ruling 22 (*"render everything, always"*) and
ruling 31 (*"Hiding lanes stays off the table"*), and separately it does not work, because
`layoutScene` sizes the layout to the viewport, so at the default camera every lane is inside the
rim by construction and there is nothing off-screen to cull at the moment the budget is missed.
*Frame-time-driven adaptive quality* — collides with `docs/design/ui-2.0-decisions.md` D36,
*"scene quality is a user choice (named levels)"*, and would need its own ruling.

## What already exists (do not rebuild)

- `contour.ts`'s `bakes` LRU (`BAKE_CAPACITY = 12`) — already sized and keyed for N masses.
- `marks/thread.ts:324`'s `PERSIST_RIBBON_CACHE` — the cached-shape / live-ink split, already
  solved for retired lanes; the pattern ruling 4 needs for living ones.
- `marks/thread.ts:101,128` — the shipped quality gate that already draws one ribbon instead of
  three. Ruling 5 keys the existing mechanism off a new input; it does not invent one.
- `geometry/scale.ts:225` + `layout.ts:498` — count-keyed thinning, already lawful, already live.
- `marks/index.ts:68-86`'s `byDepth` — depth ordering to extend across colonies, not replace.
- `geometry/curves.ts:28`'s `truncate` — the seam ruling 4 caches in front of.
- `perf.test.ts`'s `colonyFleet` and the model-floor report loop — the harness to point at the
  real composition rather than re-write.
- `packages/core/src/fixtures.ts`'s `createEventFactory` — the synthetic route to N fleets.

## Rulings

## Ruling 1 — composition is this PRD's territory, and prd-33 ruling 7's claim is superseded on the record

`scene/geometry/`, `scene/marks/` and `scene/camera.ts` are prd-52's for composition work.
prd-33 is closed (`docs/prds/done/`); its ruling 7 is not renegotiated with a finished document
and not renumbered. What is recorded here is narrower than an overturn: ruling 7 holds at the
**architecture** level — nothing in the existing design must be torn up — and fails at the
**implementation** level, because placement, a union camera fit, cross-colony depth order and
namespaced selection were never written. `contour.ts`'s bake cache is the one part that was.
Citations to prd-33 ruling 7 keep resolving and keep meaning what they meant; this ruling says
only that the promise was about shape, not about code.

## Ruling 2 — one colony renders byte-identically to today

Composition is additive or it is a regression. With N=1 the composed path produces the same marks
as the current path, byte for byte, and a law proves it against the shipped `fleet20` fixture.
This is also how prd-37 ruling 6 (*solo must never show team scaffolding*) is satisfied here
without this PRD touching any of prd-37's surfaces: a solo user's picture is not "close enough",
it is the same picture.

## Ruling 3 — the supported size is restated by measurement, never by promise

prd-33 ruling 13 stands: 90 threads at 60 fps, 180 threads at 30 fps, and *"raising the ceiling
is a measurement, not a decision."* This PRD does not promise 60 fps at 180 threads and must not
be read as having done so. It ships the two instruments with real evidence behind them (rulings 4
and 5) and then measures what they bought on the composed scene (wave 5). If the number moves,
the ceiling is restated **in a later ruling citing that measurement**. A ceiling raised on
optimism is the failure this ruling exists to prevent.

## Ruling 4 — the cache chain is repaired at both links, or at neither

A growing lane misses the spine cache and then misses the outline cache, because the truncated
path is a new array every frame and the outline cache is keyed on array identity. Caching the
pre-truncation spine alone addresses the ~2 ms layout term and leaves the 15 ms marks term
untouched — an optimisation that measures as a rounding error and reads as a fix. So the two land
together: cache the full spine keyed without growth, and re-key the outline cache off raw
identity so a growing lane can hit it.

The scope of "growing" is wider than it looks and the implementation must account for it:
`GROWTH.thickenTau = 30_000` (`motion.ts:223`) keeps `thicken` moving for as long as a lane does
work, and `sizeFrac` feeds `rim` through `lifecycleFrac` (`geometry/scale.ts:194-205`), so the
living key churns for most of a busy fleet rather than for a few new arrivals.

## Ruling 5 — detail substitutes, never hides, and the trigger is the count, not the clock

Under load the scene thins material — the bloom and underglow passes the quality dial already
drops at `calm` — and never removes a lane. This sits inside `marks/index.ts:76`'s existing law,
*"density is managed by thinness, stillness and depth layering, never by removal"*, and inside
prd-33's "material, bounded" channels; the locked channels (thread hue, thread brightness, radial
position, encoded width) are identical at every level, and a law proves it.

The trigger is **world thread count**, a property of the scene, following the precedent already
shipped at `geometry/scale.ts:225`. It is deliberately not measured frame time: that would make
the app change a setting the operator chose, which D36 rules is the operator's, and would need a
ruling nobody has made.

## Ruling 6 — this PRD reaches for no data

The world layer takes fleets as an argument. It does not fetch, subscribe, project or infer where
they came from, and no wave adds a code path that could. The team server's first law — *nothing
comes back down onto anyone's laptop* — is not something this PRD is careful around; it is
something this PRD has no mechanism to violate. When the law changes, the composition layer is
already built and takes its fleets from a new caller.

## Sequencing (waves, each gated as ever)

`scene/gl/` is not entered by any wave — composition happens above the painter, and the display
list it receives is unchanged in kind. `packages/core/`'s `Fleet` is **not** given a colony
dimension: the world composes N fleets, it does not fold them, so `buildFleet` and the derived
fleet object are read and never rewritten. `scripts/gate.sh` is prd-46's. prd-51's shipper,
protocol and team-server surfaces are untouched; prd-37's product surfaces are untouched.

**Wave 1 — the Keystone.** `prd52 w1: the scene lays out a world of colonies, and one colony is
unchanged` — `layoutWorld(fleets, options)` above `layoutScene`, placement into non-overlapping
allocated boxes, `WorldGeometry` holding N `SceneGeometry`, and ruling 2's identity law. One lane:
`scene/geometry/world.ts` (new) + `scene/geometry/layout.ts` + laws. Everything downstream
consumes it; nothing else can start.

**Wave 2 — parallel, fenced apart:** `prd52 w2: the camera frames the whole world`
(`scene/camera.ts` + `scene/view/useCamera.ts`) · `prd52 w2: the display list is composed across
colonies, and each colony pays its fixed costs once` (`scene/marks/index.ts`, extending `byDepth`;
carries the per-colony count law and the off-fence containment law) · `prd52 w2: a selection names
its colony` (`fleet/selection.tsx` + `scene/view/hitTest.ts`, retiring the bare `MAIN_SELECTION`).

**Wave 3 — sequential after wave 1, a stack not a bundle.** `prd52 w3: a growing thread answers
from cache at both links` (ruling 4) — `scene/geometry/layout.ts` + `scene/ribbon.ts`. Follows
wave 1 because it edits `layout.ts`.

**Wave 4 — parallel with wave 3, fenced apart.** `prd52 w4: the scene thins its material as the
world grows, and the encoded channels do not move` (ruling 5) — `scene/marks/thread.ts` +
`scene/geometry/scale.ts` + the locked-channel law.

**Wave 5 — last, and it is a sweep.** `prd52 w5: the model floor is measured on the composed
world` — `perf.test.ts`'s cells run through `layoutWorld` at 1×30, 3×30, 1×180 and 3×60, reported
by builder and growing-versus-pinned, replacing the sum-of-three proxy. Last because it measures
what waves 1–4 actually built, and it carries the deferred one-line cross-reference at
`perf.test.ts:1555-1572` naming #190 and prd-49, which #190 asks be done in the same change as a
re-measurement.

**Wave 0 — operator acts, booked not skipped, not dispatchable.** Blessing this document;
creating the `prd52` milestone; and the ruling on whether a multi-colony demo fixture ships as a
user-visible `StreamSource` or stays a test-only fixture (see Open questions).

**Unfiled work implied, described not numbered:** the GPU-side cost of a composed world (still
unmeasured anywhere, as prd-47's own residual says); whether a colony's allocated box shrinking
actually reduces per-colony cost given the fixed `THREAD_SAMPLES`, `SPINE_SEGMENTS` and
`MAX_HALF` constants; `contour.ts`'s `BAKE_CAPACITY = 12` re-derived for real team sizes;
cross-colony collision geometry (prd-37 ruling 4's surface, not a rendering primitive);
whether `1×180` and `3×60` should carry different supported sizes once measured.

## Open questions

- **Does a multi-colony fixture ship where a user can select it?** A test-only fixture proves the
  laws and shows nobody team scaffolding; a selectable one is how a human ever sees the composed
  scene before the team server is real. prd-37 ruling 6 pulls one way and dogfooding pulls the
  other. — **ANSWERED (operator ruling, Lachlan Kelliher, 2026-09-07): no.** The multi-colony
  fixture is test-only and does not join `StreamSource`. Two things follow. prd-37 ruling 6 holds
  without this PRD touching it — a solo user is shown no team scaffolding because there is none
  to select. And prd-49's trigger keeps its meaning: its clause 1 fires on *a real session or
  shipped fixture* above ~90 threads, and a synthetic 3×30 would have tripped it on our own test
  data. Recorded as an amendment on prd-49 ruling 1 and on #190. The cost is accepted: nobody
  sees the composed scene by hand until either a real multi-colony source exists or this is
  re-ruled.
- **Does the world place colonies by a fixed arrangement or by their own mass?** Placement is
  wave 1's to implement but not wave 1's to rule; a radial arrangement and a packed grid have
  different answers when one colony is much larger than its neighbours. Open, not ruled.
- **Is `1×180` a configuration this product should support at all,** or is a colony always
  bounded and the world is what grows? The answer changes whether `victimLaneId`'s containment is
  a performance law or a correctness one. Open, not ruled.
