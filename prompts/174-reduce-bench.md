You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

MEASUREMENT LANE — you change no production code. The audit report is docs/research/2026-08-05-adversarial-audit.md; read its reducer finding first, and the scene perf test for the reporting-not-asserting discipline.

YOUR ISSUE — #174:

## Direction

From the 2026-08-05 adversarial audit; mechanisms conductor-verified:
`packages/core/src/reduce.ts` scans growing arrays per telemetry event —
`dedupedUsage` `findIndex` (:473), `foldSessionCoverage` `.some` (:510), and
`placeCosts`/`placeLanes` full-array maps (:711-773) on every telemetry
event. A real day holds ~18.6k telemetry events, so a from-scratch fold is
quadratic in shape. Where it is paid: boot recovery
(`cli/index.ts` `reduceAll(recorder.eventsSoFar())`) and the replay index
build. #171 removes the per-event re-payer.

**This lane MEASURES. It does not fix.** (Operator's rule: research → verify
→ build; the fix is a core state-shape change with wide selector fan-out and
gets groomed only if the curve confirms.)

1. A deterministic bench: `reduceAll` at N = 5k / 15k / 30k / 55k events with
   a realistic type mix (the audit's census: ~49% pane.activity, ~19%
   llm.usage, 13% trace.span, plus tool.activity/activeTime/cost). Use the
   existing fixture generators; no wall-clock ASSERTIONS — report timings,
   assert only a generous hang timeout, exactly the scene perf test's
   discipline (its file documents why).
2. Report ms and ms/event at each N. A straight line KILLS the finding — say
   so plainly if it does. A curve confirms it — then STOP; the index fix
   (usage by requestId, costs/lanes by sessionId) is a separate groomed lane.
3. Note for the conductor in your summary: whether the bench file needs
   adding to the gate's timing-test exclusion list (it runs serial there).

## Fence (may touch ONLY)

- ONE new file: `packages/core/src/reduce.bench.test.ts`

## Blocked by

Nothing. **Model:** sonnet. **Wave:** audit-measure.

## Definition of done

- The curve, reported honestly at all four sizes; a clear
  confirmed/killed verdict; zero production-code changes.
- Root `npm test` + `npm run typecheck` green.


RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
