# 87 — Suite cost under load: the real-fleet fixtures get cheap (remediation keystone)

## Why this issue exists (operator rulings 33–34, 2026-08-01)

The landing gate now measures the suite at 4× concurrency on a BUSY box —
agents computing beside it, no waiting for quiet. Under that standard the
suite failed 11 of 12 runs: five different tests across replay/scene/shell/
fleet, all timing out at ~5–6.5s (vitest's 5s default). The quiet suite is
green (870 tests). A test near the timeout ceiling is a latent flake.

The shared cost: many tests each rebuild a real 20-lane fleet through
`reduceAll(fixtureHistory(spec, NOW))` + `buildFleet(...)` inside the test
body, per test.

Failing tests observed across the gate's load runs:

- `keys 2 and 3 swap the driving log, folded by the same reducer` — `app/StreamContext.test.tsx`
- `renders every registered panel expanded by default, collisions included` — `app/PanelGrid.test.tsx`
- `renders every lane, in the fleet object's own order` and
  `renders the fixture swarm without a GPU` and
  `reads ALL CLEAR with its evidence on the twenty-lane fleet` — these live in
  `scene/SceneView.test.tsx` and `fleet/FleetContext.test.tsx`

## Direction

Make the real-fixture philosophy cheap **at the source**, so consumers get
fast without being edited:

- Preferred: memoise inside `packages/web/src/fleet/fixtures.ts` — stable
  spec identities (`fleet20Spec()`/`pathologySpec()` returning frozen
  singletons or memo-keyed values) and memoised `fixtureHistory(spec, now,
  seed)`; add a memoised fleet-building helper if it helps consumers. The
  scene tests are OUTSIDE your fence (an in-flight lane owns them) — they
  must get fast purely through your source-level work.
- Where a test file inside your fence still rebuilds per test, hoist the
  build to describe/module scope.
- The fixtures stay REAL: same events, same reducer, same buildFleet.
  Memoise, don't mock. Guard against shared-fixture mutation leaking
  between tests (freeze what you return, or prove immutability with a
  test) — a fixture one test mutates is a new class of flake.

FORBIDDEN: raising `testTimeout` anywhere; `.skip`; weakening or deleting
assertions; replacing real fixtures with hand-rolled fakes.

## Fence (may touch ONLY)

- `packages/web/src/fleet/fixtures.ts`
- `packages/web/src/fleet/buildFleet.test.ts`
- `packages/web/src/fleet/FleetContext.test.tsx`
- `packages/web/src/app/StreamContext.test.tsx`
- `packages/web/src/app/PanelGrid.test.tsx`

Do NOT touch `packages/web/src/scene/**` (in-flight lane 81) or
`packages/web/src/panels/**` (lanes 77/78/80 own parts of it).

## Definition of done

- Root `npm test` green and `npm run typecheck` green.
- Duration evidence in your final report: the slowest ~5 tests before and
  after (vitest prints slow tests in its output). After your change no
  test should sit near the ceiling — aim for the slowest well under 2s
  quiet.
- Load evidence measured on THIS box while the fleet is busy — 3 batches
  of 4 concurrent full-suite runs from your worktree root:

  ```sh
  for b in 1 2 3; do
    for c in 1 2 3 4; do (npm test >/tmp/l87-$b-$c.log 2>&1; echo $? >/tmp/l87-$b-$c.rc) & done
    wait
  done
  grep -L '^0' /tmp/l87-*.rc || echo "12/12 GREEN"
  ```

  If a residual failure lands in a file OUTSIDE your fence, do not touch
  the file — report the test name and timing verbatim in your final
  report/commit message.

## RULES

- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED.** Never push, never merge, never
  switch branches.
- Build for a stranger's machine — no user-specific paths, nothing that
  assumes this box.
- If blocked, print `BLOCKED: <need>` and stop.
