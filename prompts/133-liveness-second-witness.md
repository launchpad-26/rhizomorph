You are a worker agent on rhizomorph (prd9: the trace era).
You own exactly one issue — a dogfooding-born liveness fix with the
operator's live evidence embedded below.

FIRST read: docs/prd9.md rulings 1 and 6, then
packages/core/src/selectors/liveness.ts and packages/web/src/fleet/
(buildFleet + detectors) to locate where the silence inference
actually lives before changing anything.

YOUR ISSUE — #133:

## Direction

Dogfooding-born (operator observed live, 2026-08-03 ~20:5x): the attention
strip summoned for lane `132-trace-surfaces` while it was healthy and
working. Evidence from the session log
(`~/.local/share/rhizomorph/worktrees-challenge-71202028/session-1785739192605.jsonl`,
events ~evt-002003..002132):

- workmux NEVER declared waiting — the lane's only `agent.status` is
  `working` (launch hook). The summons came from an inference.
- `pane.activity` for the agent pane shows 65s and 93s gaps with no
  content-hash change — because the worker was delegating to a subagent
  (visually still pane, 45k tokens flowing) and reading docs. Silence-based
  liveness inference fires exactly when a delegating lane is busiest.
- Meanwhile the SAME lane's telemetry (`llm.usage`, `tool.activity` —
  and `trace.span` since wave A) was arriving continuously.

Fix: **liveness gets a second witness.**

1. In the liveness/pathology derivation (core `selectors/liveness.ts` and
   the web `fleet/buildFleet` detectors — wherever the relevant threshold
   actually lives; identify precisely and say so in your summary):
   a lane is only flatline/attention-worthy on silence across BOTH
   witnesses — pane stillness AND telemetry recency (latest
   `llm.usage`/`tool.activity`/`trace.span` event for the lane). Visually
   still + telemetrically recent = `working`, with detection-honesty
   marking preserved (inferred states stay marked `~`; certainty still
   only from workmux declarations).
2. Thresholds named at the top of the file per house style; telemetry
   recency window justified in a comment (suggest: same window the pane
   silence threshold uses).
3. **Regression test from the real recording**: reconstruct the false
   positive as a fixture — a lane whose pane events go silent for 90s+
   while telemetry events keep arriving — and assert it reads `working`,
   not a summons. Then the inverse law, restated stronger: silence on
   BOTH witnesses within the window still summons (the real flatline must
   not be weakened).
4. A lane with NO telemetry at all (uninstrumented setups — the common
   junior case) must behave exactly as today: pane silence alone governs.
   Test it — degraded setups must not lose their flatline detection.

## Fence (may touch ONLY)

- `packages/core/src/selectors/liveness.ts`
- `packages/core/src/selectors/liveness.test.ts`
- `packages/web/src/fleet/` (buildFleet + its tests)

## Blocked by

Nothing (fence-disjoint from #132/#133). **Model:** sonnet.
**Wave:** hygiene/dogfood.

## Definition of done

- The recorded false-positive shape reads `working`; both-witness silence
  still summons; uninstrumented lanes unchanged — all three test-stated.
- Detection-honesty markers preserved; no threshold weakened.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; no
threshold weakened, no timeout widened; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
