You are a worker agent building rhizomorph (prd9: the trace era).
You own exactly one issue.

FIRST read, in order: docs/prd9.md IN FULL (rulings 3–6 bind your schema),
then research/2026-08-03-trace-era-captures.md §1 — the captured span
shapes you are modeling; its attribute table is your source of truth, not
memory — then packages/core/src/events/telemetry.ts (the conventions your
new file must mirror exactly) and packages/core/README.md.

YOUR ISSUE — #123 (trace.span keystone: additive span event, idempotent
fold, laws)

## Direction

prd9 Day-1 keystone. One additive event type, `trace.span`, that every
wave-A lane builds against. Schema and fold only — no parser, no
selectors, no UI.

1. **Schema** — new `packages/core/src/events/trace.ts`:
   - Reuse the shared attribution conventions from `events/telemetry.ts`
     exactly: `lane` (required, `UNATTRIBUTED_LANE` fallback), `sessionId?`,
     `worktreePath?`, `branch?`, `thread?`, plus `role` (`agentRoleSchema`).
   - Identity: `traceId` (string), `spanId` (string),
     `parentSpanId` (string | null).
   - Naming: `name` — the RAW span name string, never an enum (beta churn is
     data, not schema). `kind` — parser-derived stable enum, exported as
     `spanKindSchema`: `interaction | llm_request | tool | tool_blocked |
     tool_execution | hook | other`. The schema accepts any `name` and any
     legal `kind`; mapping names→kinds is Day 2's parser, not yours.
   - Time/status: `startTs`, `endTs` (epoch ms ints), `status`
     (`ok | error | unset`).
   - Allowlisted optional facts — ALL optional/nullable, and **NO free-form
     attributes map** (prd9 ruling 5: privacy by construction — there must
     be no field `user.email` or prompt text could land in): `model`,
     `tokens` (existing four-tier `tokenUsageSchema` shape), `ttftMs`,
     `requestId`, `agentId`, `parentAgentId`, `toolName`, `toolUseId`,
     `subagentType`, `decision` (`accept | reject | unknown`).
2. **Union + census** — register `trace.span` in `events/index.ts`
   (discriminated union + `EVENT_SOURCE_BY_TYPE`, source `otel`); extend
   `fixtures.ts` (`oneOfEach()` + a span fixture factory for tests).
3. **State slice** — `state.ts` gains `traces`: spans stored whole in
   observation order, indexed by `traceId` and by `sessionId` (mirror the
   telemetry slice's records-kept-whole pattern; nothing accumulated in the
   fold — totals are future selectors' work).
4. **Fold** — `reduce.ts`: append with **idempotence on
   `(traceId, spanId)`** (OTLP re-delivery must not duplicate a span).
   The existing unknown-type forward-compat guard stays intact.
5. **Laws, test-stated** (this is the point of the keystone):
   - **No spend from spans**: a state built from ONLY `trace.span` events
     yields zero tokens and zero dollars through every existing spend
     selector (prd9 ruling 4).
   - **Idempotent re-delivery**: the same `(traceId, spanId)` folded twice
     → one stored record.
   - **Roundtrip**: a `trace.span` event survives
     JSONL stringify→parse→reduce identical to the live fold.
   - The events census tests (`events.test.ts`) extended, never weakened.

## Fence (may touch ONLY)

- `packages/core/src/events/trace.ts` (new)
- `packages/core/src/events/trace.test.ts` (new)
- `packages/core/src/events/index.ts`
- `packages/core/src/events/events.test.ts`
- `packages/core/src/state.ts`
- `packages/core/src/reduce.ts`
- `packages/core/src/reduce.test.ts`
- `packages/core/src/reduce.telemetry.test.ts`
- `packages/core/src/fixtures.ts`
- `packages/core/src/fixtures.test.ts`
- `packages/core/src/index.ts` (barrel export lines only)

## Blocked by

Nothing. **Model:** opus. **Wave:** 1 (keystone — lands alone).

## Definition of done

- Schema + union + state slice + idempotent fold as above; all four laws
  test-stated and green.
- No selectors, no server/parser, no UI, no docs beyond code comments.
- The payload has no attributes map and no field prompt text could land in.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE (the gate audits every touched
path); follow core's own conventions — zod at the boundary, inferred types
everywhere else, and the schema is strictly ADDITIVE: nothing existing
changes shape; small conventional commits (committing is REQUIRED — review
happens from your branch); NEVER switch branches, push, merge, or run git
in a sibling worktree; no NUL bytes; tests must be deterministic (no
waitFor racing async work — stub or await the boundary; a flaky test
blocks the gate); build for a stranger's machine (no personal paths,
degrade loudly never silently); if you cannot proceed print "BLOCKED:
<need>" and stop; DoD is root 'npm test' + 'npm run typecheck' green, then
STOP with a short summary.
