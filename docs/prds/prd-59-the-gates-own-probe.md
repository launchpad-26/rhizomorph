# prd-59 — the gate's own probe: a default timeout is not a budget

> **Status:** **BLESSED** — gabriel-canaan, 2026-09-17, in session. Milestone `prd59`. Drafted
> 2026-09-17 from #593, because the landing gate's load probe cannot pass on `main` for any lane,
> and the file that blocks it is one no lane touches.
> Homed here rather than in prd-49 at the operator's ruling, 2026-09-17: prd-49 shipped
> 2026-09-14 and states it is not a programme of work, and the two PRDs that reference the file
> (prd-57, prd-58) are proposed rather than blessed and cite it as a constraint rather than
> claiming it.

## Problem

`scripts/gate.sh <handle> <fence> <load-batches>` runs the suite **four times at once** per
batch, each bounded at `--maxWorkers=5`. That is the point: a suite green 8/8 serially has
failed 67% at 4x concurrency, so the probe is the only condition under which a landing is
tested against the machine it will actually share.

The probe creates ~1.7x oversubscription on a 12-core box by design. A test that is merely
**slow** — not racy, not timing-asserting — then fails on vitest's **default 5s per-test
timeout**, which nobody chose and which no file states. The gate reports this as
`flaky under load — remove the race`, holds the merge, and names the lane.

The lane did not write that file, cannot fence it, and has no way to land. Every lane pays,
and the toll is per-landing rather than per-change.

## Evidence

Measured 2026-09-17 on clean `main` at `7b260e43` — the reporting lane's work absent from the
tree. Re-derive rather than trust; the tree moves.

- **The probe fails 4 runs out of 4 on an unmodified trunk.** Reproduced with the gate's own
  invocation (`scripts/gate.sh:735-738`): four concurrent `npm test -- --maxWorkers=5` with the
  timing-set exclusions the gate builds. Failures: 6x
  `packages/web/src/scene/tripwire-law.test.ts`, plus the then-live
  `doc-citation-law.test.ts` red since fixed.
- **It is a timeout, not a failed assertion.** `Error: Test timed out in 5000ms`, at 5116ms,
  5843ms, 6163ms and 7347ms across the four runs. The law's assertion is
  `expect(count, …).toBeLessThanOrEqual(TRIPWIRE_THREADS)` (`tripwire-law.test.ts:99`) — a
  **thread count, not a clock**. Nothing in the file measures time on purpose.
- **The margin is 2.5x against a number nobody chose.** Unloaded, the two failing cases run
  **1993ms** and **1668ms**; vitest's default per-test timeout is **5000ms**. The file as a
  whole is 3.75s. What overruns is the work each case does to get a count —
  `reduceAll(fixtureHistory(...))`, then `buildFleet`, then `layoutScene`, over an over-sized
  synthetic spec.
- **It is the probe, not the file.** The same file run **four times concurrently on its own**,
  clean `main`: all four exit 0. The margin only disappears at the concurrency the gate creates.
- **The file is not in the timing set.** `grep -c 'gate-timing'` on it returns **0**. The gate
  derives that set from a `// @gate-timing` marker or a `*.bench.test.ts` name
  (`scripts/gate.sh:646-659`); today it holds 3 marked files and 4 bench-named ones.
- **The gate's own remedy text does not fit.** It says *"flaky under load — remove the race
  (never widen a timeout)"*. There is no race here, and no timeout of the file's own to
  widen — the 5000ms is vitest's default.

## Success

1. **A landing that supplies `load-batches` can pass on an unmodified trunk.** Not met while
   any file fails the probe on a tree the lane did not change.
2. **A slow test is distinguishable from a racy one, by the gate's own output.** Not met while
   a default-timeout overrun is reported as `remove the race`.
3. **The remedy chosen is stated in the file it applies to, with its measurement.** Not met
   while a marker or a budget sits in a file with no note saying what it was measured against.
4. **The fix does not weaken what the law asserts.** Not met while the tripwire case can pass
   without exercising the count it exists to check.

## Non-goals

- **Not a change to prd-49 ruling 3's tripwire value.** The threshold is not in question; the
  time taken to compute a count against it is.
- **Not a rewrite of `scripts/gate.sh`'s probe design.** Four-at-once is load-bearing and
  measured; this PRD takes it as given.
- **Not a survey of every slow test in the repo.** Today exactly one file blocks the probe.
  If a second appears the class is real and this PRD says so — see Open question 2.

**Rejected alternatives.** *Widen the per-test timeout in the file* — the cheapest edit, and it
buys a green bar by moving the line rather than by knowing where the line should be; the gate's
own text refuses it, and a number chosen to clear today's contention is stale at the next
machine. *Lower `load-batches` repo-wide, or drop the probe* — that is the friendlier condition
`AGENTS.md` already warns is not the same landing, and it retires the only check that sees
concurrency failures at all. *Exclude the file from the suite* — a check that does not run is
not a check, which is prd-54's whole subject one directory over.

## What already exists (do not rebuild)

- `scripts/gate.sh:646-662` — the timing-set derivation, including the loud failure when the
  pass matches zero files (`#209`'s trap).
- `packages/web/src/scene/tripwire-law.test.ts` — the law, its fixtures and `TRIPWIRE_THREADS`.
- `packages/server/src/shell-suite-law.test.ts` — the worked example of a file that opts into
  the timing set and states in its header why.

## Rulings

## Ruling 1 — the timing set means "must not run under contention", not "asserts a clock"

**Verdict.** A file opts into the gate's serial timing pass when its result is **invalidated by
contention**, whatever the mechanism — a wall-clock assertion, or a cost that exceeds a timeout
it did not choose. `tripwire-law.test.ts` qualifies on the second ground.

**Why.** The marker's existing users assert time directly, so "timing test" has been read as
"asserts a clock". That reading leaves a gap the probe falls into: a test can be perfectly
deterministic in what it asserts and still produce a meaningless verdict under 1.7x
oversubscription. Both cases fail for the same reason — the measurement was taken under the
wrong conditions — and the remedy the gate already ships is the same one.

**Extent.** Opting in is a claim about *conditions*, not about slowness; a merely slow test that
still passes under the probe stays out. The claim is stated in the file with the measurement
behind it, so a later reader can re-derive it rather than inherit it.

## Ruling 2 — a default is not a budget: a file that opts in states the number it needs

**Verdict.** Vitest's 5000ms default may not be the thing a landing depends on. A file in the
timing set that needs more than the default declares an explicit per-test timeout **with its
measured baseline beside it**. Declaring it is not "widening a timeout" in the sense the gate
forbids — that prohibition is about masking a race, and it stands.

**Why.** The failures here are against a number no one in this repo chose and no file records.
An explicit number with a measurement is checkable and re-derivable; an inherited default is
neither, and it moves when the tooling upgrades.

**Extent.** Applies only inside the timing set. A file outside it that needs a longer timeout is
telling you it belongs inside.

## Ruling 3 — the gate names the file and says whose it is

**Verdict.** When the probe fails, the gate reports **which file** failed and whether that file
is inside the lane's fence. A failure outside the fence is reported as such.

**Why.** `GATE FAILED: flaky under load` plus the lane's handle reads as an accusation of the
lane. On 2026-09-17 it held a landing whose diff could not reach the failing file, and
establishing that took a full reproduction against a clean trunk. The gate already knows both
facts at that moment.

**Extent.** Reporting only. The failure stays fatal and still holds the merge — an out-of-fence
failure is still a red trunk, and this ruling does not make it landable.

## Sequencing (waves, each gated as ever)

`packages/web/src/scene/tripwire-law.test.ts` is cited as a constraint by prd-57 and prd-58;
neither is blessed and neither claims it. No wave here enters `scripts/gate.sh`'s probe design,
and none changes `TRIPWIRE_THREADS`.

**Wave 1 — the Keystone: the probe passes on an unmodified trunk.** One issue, #593. The marker
under Ruling 1 and, if the measurement calls for it, the explicit timeout under Ruling 2, both
stated in the file with what they were measured against. Proven by re-running the gate's own
probe on a clean trunk, and by a mutation showing the tripwire case still fails when the count
it guards is broken.

**Wave 2 — the gate says whose failure it is, and the ledger perf law runs where its clock
assertion means something.** Two issues, #627 and #628. Blocked on wave 1 only in the sense
that wave 1 removes the live instance.

- **#627, ruling 3, in `scripts/gate.sh`** — plus `packages/server/src/gate-honesty-law.test.ts`,
  the law that pins the gate's own text and encodes the load-flake path this changes, fenced
  with it up front rather than discovered at landing.
- **#628, ruling 1, in `packages/web/src/panels/ledger/perf.test.ts`** — this file asserts a
  sub-millisecond median and runs inside the load batches, which is ruling 1's ORIGINAL ground
  rather than wave 1's.

**Why one wave and not two, recorded because the first draft had it the other way.** These were
declared as waves 2 and 3 on 2026-09-18 and merged the same day, at the operator's decision.
The case for splitting them was reviewability — a change to the landing gate and an unrelated
test marker in one diff is the grab-bag shape the working agreement warns about. The case for
merging won on the agreement's own arithmetic: nothing in either issue depends on the other,
their fences are disjoint (proven by `scripts/fence-lint.sh 627 628`), and the queue is a fixed
per-PR toll of about 21 hours against a review cost that two commits in one PR barely move.
Wave membership is a claim about DEPENDENCY, not about topic; these are independent, so they are
one wave. The commit rule carries the reviewability half — one commit per issue, reviewed
commit by commit.

**Unfiled work implied, described not numbered:** whether the probe should report each run's
slowest tests, so the next one is seen before it blocks a landing.

## Open questions

1. **Should the timing set's serial pass have a cost ceiling?** It runs alone and once, so it is
   the cheapest place to put an expensive test — which is also an argument for it growing without
   anyone noticing. **Open, not ruled.**
2. **Is one file an instance or a class?** **ANSWERED 2026-09-18 — an instance, plus one
   unrelated member of ruling 1's other ground.** The margin census this question asked for was
   taken after wave 1 landed, alone at `--maxWorkers=1`, worst case per file against the 5000ms
   default: `panels/ledger/perf.test.ts` 6005-10063ms, `doc-citation-law.test.ts` 1294ms,
   `world.test.ts` 1084ms, `view/useFrameLoop.test.ts` 526ms, `api/route-class-law.test.ts`
   under 1000ms — against the 1993ms of `tripwire-law.test.ts`, the file that actually blocked
   the probe. So the timeout-overrun class has exactly one member and it is fixed; nothing else
   is within a small factor, and the probe runs green.

   The census did surface something the question did not anticipate, which is why this is not a
   plain "no": `panels/ledger/perf.test.ts` asserts `rows.every(row => row.afterMs < 1)` — a
   genuine wall-clock claim — while running inside the load batches under its own 300s budget.
   Contention cannot time it out; it invalidates what it measures instead. That is ruling 1's
   ORIGINAL ground, not wave 1's, and it qualifies under the criterion this PRD replaced as
   readily as under the one it wrote. It is #628, in wave 2 above.

   One measurement is recorded as refuted rather than dropped: a review seat reported
   `view/useFrameLoop.test.ts` failing the probe 2 of 4 runs. It was not reproducible — the
   probe ran 4/4 green, and that file's slowest case is 526ms, a ~10x margin. The seat's own
   report put its box at loadavg ~50 with a second seat running, which is far past the probe's
   ~1.7x. Recorded because a margin that large failing under enough load is still a fact about
   the machine, and the next census should expect it.
