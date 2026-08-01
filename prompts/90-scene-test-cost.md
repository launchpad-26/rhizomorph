## What was found (regate evidence, 2026-08-01)

The mycelium scene landed by #81 brought its own scale test, and it sits
near vitest's 5s ceiling under busy-box load:

- `threads all twenty lanes of the scale fixture on key 2`
  (`packages/web/src/scene/SceneView.test.tsx`) failed 3/12 at 5.4–5.9s in
  #79's regate — a branch whose fence contains no scene files. The hold
  was root-caused to main's own suite; #79 is innocent.

Same disease #87 cured elsewhere: an expensive fixture built per test
instead of shared/memoised.

## Direction

The established pattern (see #87's commit and `fleet/fixtures.ts`):
share the singleton spec + memoised history where the test builds through
the fleet fixtures; hoist any per-test scale build to describe/module
scope with `beforeAll` warming. The test's meaning stays intact — twenty
real lanes, real fold, real render.

FORBIDDEN: raising `testTimeout`, `.skip`, retries, weakening assertions.

## Fence (may touch ONLY)

- `packages/web/src/scene/**`

## Blocked by

#81 (landed — the scene has no owner now). **Model:** sonnet.
**Wave:** remediation (gate-unblocker: #78, #79, #83, #88, #89 regate
behind this).

## Definition of done

- Root `npm test` + `npm run typecheck` green.
- Load evidence: 3 batches x 4 concurrent full-suite runs from the
  worktree root, 12/12 green; out-of-fence failures reported verbatim,
  files untouched.
- **Committing your work is REQUIRED.** Never push, never merge. Work
  only in this worktree. Stranger-machine rule. `BLOCKED: <need>` if
  stuck.
