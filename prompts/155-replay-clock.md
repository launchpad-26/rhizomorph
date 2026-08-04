You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

YOUR ISSUE — #155:

## Direction

BUG (operator-reported, conductor-diagnosed 2026-08-04): in replay
everything renders grey/flatlined/red. Cause, located:
`packages/web/src/fleet/FleetContext.tsx:42-59` builds the fleet with
`now: clock` where `clock = Date.now()` on a 1s timer, with NO replay
override. So a replayed state from hours ago is judged against the REAL
wall clock: every lane's last activity is hours stale, so liveness/
flatline/recency all read dead. The fold is correct; the CLOCK is wrong.
This falsifies the product's own north star — a replay is supposed to
read as growth and life, and instead it reads as a graveyard.

1. **One clock rule, stated and tested**: every derived surface reads the
   MODE's clock — wall-clock in live, the scrub position in replay.
   Thread the replay clock from the replay/mode context (it already knows
   the scrub time) into `FleetProvider`, and stop the 1s wall-clock timer
   entirely while in replay (a paused scrub must not drift).
2. **Audit every other consumer of "now"** inside your fence and fix the
   same way where the same bug exists: `panels/ledger/index.tsx`
   (nowOverride ?? Date.now()), `app/StreamContext.tsx` news-vs-history
   tagging. Each either takes the mode clock or documents in a comment
   WHY wall-clock is correct there (animation frame timing is real time
   even in replay — a legitimate exception; recency/aging/flatline is
   not). NOTE: the scene's own clock consumers (`scene/index.tsx`,
   `scene/SceneView.tsx`) are OUT of your fence and are handled by the
   scene lane (#157) — make the mode clock available to them through the
   context you thread, and say in your summary what you exposed.
3. **Laws, test-stated**:
   - A replayed state scrubbed to a moment when lanes were WORKING
     renders them working — not flatlined (the exact reported bug).
   - Scrubbing backward then forward gives identical fleet output at the
     same position (no wall-clock leakage).
   - A paused replay does not change its derived state over real time.
4. Do NOT change any threshold, palette or law — this is a clock fix.
   If the scene reads more alive afterward, that is the bug leaving.

## Fence (may touch ONLY)

- `packages/web/src/fleet/FleetContext.tsx`, `FleetContext.test.tsx`
- `packages/web/src/app/StreamContext.tsx`, `StreamContext.test.tsx`
- `packages/web/src/app/ModeContext.tsx`
- `packages/web/src/replay/` (all files)
- `packages/web/src/panels/ledger/index.tsx`, `index.test.tsx`
- `packages/web/src/scene/index.tsx`

## Blocked by

Nothing. **Model:** sonnet. **Wave:** replay-truth.

## Definition of done

- The three laws test-stated; every "now" consumer either mode-clocked or
  commented with its justification; no thresholds touched.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
