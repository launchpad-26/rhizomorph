You are a worker agent on rhizomorph (prd9: the trace era, rolling).
You own exactly one issue. Read the files your issue names IN FULL
before changing anything; import from @rhizomorph/core; laws
restated stronger, never weakened.

YOUR ISSUE — #141:

## Direction

Operator-ruled stubbed-metric wiring (grooming rule: wire a metric only
when a surface reads it — this one has its surface). Claude Code exports
`claude_code.active_time.total` (seconds, counter) with every metrics POST;
the receiver silently ignores it today. The fleet table shows AGE but not
how much of that age was ALIVE — the strongest of the ignored metrics
(research note §"Live-dashboard gaps").

1. **Additive event** — `agent.activeTime` in
   `packages/core/src/events/telemetry.ts` (same attribution block +
   `role`; payload: `activeSeconds` cumulative as reported, `sessionId`
   required-nullable like its siblings). Registered in the union +
   `EVENT_SOURCE_BY_TYPE` (source `otel`), `fixtures.ts` `oneOfEach()`.
   Full fan-out fenced up front (the scar): census tests, fixtures tests,
   reduce tests.
2. **Parse** — `collectors/otel/parse-metrics.ts` reads
   `claude_code.active_time.total` datapoints through the existing
   attribute allowlist; unknown metrics stay silently ignored.
3. **Fold** — records kept whole (telemetry-slice pattern); nothing
   accumulated in the fold.
4. **Selector** — new `packages/core/src/selectors/activity.ts`:
   per-lane active seconds (latest cumulative value per session, summed
   per lane — counters may reset on session restart: take
   max-per-session then sum, and say so in a comment), exported via the
   barrels.
5. **Surface** — `buildFleet` gains the vital; the fleet table's AGE
   column becomes `AGE / ACTIVE` (mono, tabular — law 11), with the
   existing gap-honesty: a lane with no OTel shows AGE alone, never an
   invented zero.

## Fence (may touch ONLY)

- `packages/core/src/events/telemetry.ts`
- `packages/core/src/events/index.ts`
- `packages/core/src/events/events.test.ts`
- `packages/core/src/events/telemetry.test.ts`
- `packages/core/src/fixtures.ts`
- `packages/core/src/fixtures.test.ts`
- `packages/core/src/state.ts`
- `packages/core/src/reduce.ts`
- `packages/core/src/reduce.test.ts`
- `packages/core/src/reduce.telemetry.test.ts`
- `packages/core/src/selectors/activity.ts` (new)
- `packages/core/src/selectors/activity.test.ts` (new)
- `packages/core/src/selectors/index.ts`
- `packages/core/src/index.ts`
- `packages/server/src/collectors/otel/parse-metrics.ts`
- `packages/server/src/collectors/otel/parse-metrics.test.ts`
- `packages/server/src/collectors/otel/types.ts`
- `packages/web/src/fleet/buildFleet.ts`
- `packages/web/src/fleet/buildFleet.test.ts`
- `packages/web/src/panels/fleet/index.tsx`
- `packages/web/src/panels/fleet/index.test.tsx`
- `packages/web/src/panels/fleet/format.ts`

## Blocked by

Nothing (fence-disjoint from the parallel rolling lanes). **Model:**
sonnet. **Wave:** rolling. NOTE: the attention-chips lane (#142) will
stack AFTER this one — do not touch `panels/attention/`.

## Definition of done

- A captured-shape metrics body with `active_time.total` produces
  `agent.activeTime` events (fixture-tested); counter-reset summation
  tested; fleet shows AGE/ACTIVE with honest gaps; census tests extended.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
