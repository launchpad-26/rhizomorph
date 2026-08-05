You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

Core state-contract reshape under the fold identity law. Read #174's landed bench (packages/core/src/reduce.bench.test.ts) — it is your before/after instrument. The identity oracle tests are the constitution; they stay green untouched.

YOUR ISSUE — #179:

## Direction

The fix #174's measurement just justified. Its bench (landing with its gate,
`packages/core/src/reduce.bench.test.ts`) confirmed the audit's P2 reducer
finding: µs/event grew 9–18x while N grew 11x — a clean super-linear
signature that held its shape across every run, exactly what re-scanning a
growing array per telemetry event predicts. The mechanisms, conductor-verified:

- `dedupedUsage`: `usage.findIndex(...)` over the full usage array per
  `llm.usage` event (~10.4k/day).
- `foldSessionCoverage`: `usage.some(...)`/`.filter(...)` per event.
- `withTelemetry`: `placeCosts` (full `costs.map`) and `placeLanes` (loop
  over all lanes) on EVERY telemetry event.

Where it is paid now that #171 landed: boot recovery of a long session, and
the replay index build. Fix: **give TelemetryState an index.**

1. Index `usage` by `requestId`, and session-place lookups by `sessionId`
   (Map alongside — or instead of — the arrays; your call, argued in the
   summary). Dedup and coverage become O(1) lookups; `placeCosts`/
   `placeLanes` re-map only entries whose place actually changed.
2. **The fold identity is the product's constitution — prove it survives.**
   Live and replay fold through this reducer; the incremental === full-refold
   oracle tests must stay green untouched, and the bench's own
   deterministic-output assertion (same events → byte-equal state) must hold
   across the reshape.
3. Selector compatibility: every spend/telemetry selector that reads
   `telemetry.usage`/`costs`/`lanes` keeps identical output — enumerate the
   selectors you checked in your summary. If a selector needs the array
   ORDER, preserve it (a Map does not replace the array's role as the
   ordered record unless you prove nothing needs the order).
4. **Re-run the #174 bench before/after** — it is the measuring stick. DoD
   is the curve flattening toward linear (report the same table; the shape
   is the claim, ambient load is not).
5. SessionState is in-memory only (the recorder persists events, not state),
   so the shape change has no wire or disk migration. Say so in your summary
   after verifying it.

## Fence (may touch ONLY)

- `packages/core/src/reduce.ts`, `packages/core/src/reduce.test.ts`
- `packages/core/src/state.ts`, `packages/core/src/state.test.ts`
- `packages/core/src/reduce.bench.test.ts` (re-run + extend, do not weaken)
- `packages/core/src/selectors/` (all files) — compatibility only; behaviour
  changes are out of scope

## Blocked by

#174 landed on main (its bench is the measuring stick). **Model:** opus (a
core state-contract reshape under the identity law; keystone precedent).
**Wave:** audit-fix.

## Definition of done

- Curve re-measured and reported flattening toward linear; identity oracle
  and determinism laws green untouched; selector outputs proven identical;
  root `npm test` + `npm run typecheck` green.
- Say what you would show the operator first.


RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
