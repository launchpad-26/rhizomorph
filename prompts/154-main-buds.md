You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests must be HERMETIC under 4x concurrency
(unique temp paths, no shared fixture state) — a recent lane was
held by exactly that.

YOUR ISSUE — #154:

## Direction

Close the gap #144 filed honestly against itself: prd10 ruling 9 says the
conductor's subagents bud from MAIN's anatomy, but `RootMass` carries no
subagent vital, so a replayed conductor grows no bud. The data already
exists — `selectSubagentActivity` (#143) covers the conductor's telemetry
lane, and `buildFleet` already exposes `Lane.subagents`.

1. Give the fleet model's root/MAIN object the same subagent vital the
   lanes have (mirror `Lane.subagents` exactly — same shape, same
   detection-honesty markers; one object, four surfaces).
2. The scene's root-mass grows buds from ITS anatomy using the SAME
   bud grammar the threads use (#144's implementation — reuse, never
   fork it): spawn = event class, completion absorbs.
3. Replay-safe: a recorded conductor session with sidechain activity
   grows buds at the right moments when scrubbed (test it — this is the
   exact case that was missing).
4. No new hues, no motion-budget changes, no law weakened.

## Fence (may touch ONLY)

- `packages/web/src/fleet/buildFleet.ts`, `buildFleet.test.ts`
- `packages/web/src/scene/` (all files)

## Blocked by

#143, #144 (both landed). **Model:** sonnet. **Wave:** prd10-completion.

## Definition of done

- MAIN grows buds from conductor sidechain activity, live and in replay
  (test-stated); bud grammar shared with threads, not duplicated.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
