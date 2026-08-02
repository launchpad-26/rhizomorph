You are a worker agent building The Rhizomorph (prd1: the money layer).
You own exactly one issue.

FIRST read, in order: docs/prd0.md, docs/prd1.md, docs/architecture.md,
and research/2026-07-30-telemetry-capture-routes.md (real payload shapes
your work must match).

YOUR ISSUE — #33 (33. prd1 KEYSTONE — telemetry event types, role dimension, cost selectors)

**Fence (may touch ONLY):** `packages/core/**`
**Blocked by:** nothing. **Model:** OPUS. **Wave:** 1 (KEYSTONE — blocks all of prd1)

Per docs/prd1.md: additive telemetry event types + selectors. Read the prd and
`research/2026-07-30-telemetry-capture-routes.md` §S1/§S2 for the real payload
shapes these events must represent.

- New event types (zod, additive — existing types untouched): sources
  `sessionlog` and `otel`;
  - `llm.usage` — tokens by tier (input/output/cache_read/cache_creation),
    `model`, `requestId`, `durationMs`, `lane`, `role`
    (`worker|conductor|auxiliary`), origin source;
  - `llm.cost` — `costUsd`, `model`, `lane`, `role`, `authoritative: true`
    (OTel) vs estimated;
  - `tool.activity` — tool name, ts, `lane` (from sessionlog tool_use).
- Selectors (pure, dense tests): per-lane cost + token totals; spend rate
  over a rolling window (param); per-model breakdown; session totals;
  worker/conductor/auxiliary split + **overhead ratio** (conductor ÷ worker
  tokens; null-safe when either is zero).
- Reducer folds the new events into SessionState additively; old fixtures
  must still pass untouched.
- Extend the fixture factory for the new events.
- Land the schema types as your FIRST commit (keystone pattern).

**DoD:** root `npm test` + `npm run typecheck` green; existing tests
unmodified and passing; dense coverage on every new selector incl. the
overhead ratio edge cases. No NUL bytes. Never push/merge; never run git in
sibling worktrees.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @rhizomorph/core, never redefine its types; small
conventional commits; NEVER switch branches, push, merge, or run git in a
sibling worktree; no NUL bytes; tests must be deterministic (no waitFor
racing async work — stub or await the boundary; a flaky test blocks the
gate); DoD is root 'npm test' + 'npm run typecheck' green, then STOP with
a short summary.
