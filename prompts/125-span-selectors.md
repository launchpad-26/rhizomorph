You are a worker agent building rhizomorph (prd9: the trace era).
You own exactly one issue.

FIRST read, in order: docs/prd9.md IN FULL (the rulings bind you),
then research/2026-08-03-trace-era-captures.md (the captured shapes are
your source of truth, not memory). The #123 keystone is LANDED on main:
packages/core/src/events/trace.ts is the contract — import from
@rhizomorph/core, never redefine its types.

YOUR ISSUE — #125:

## Direction

prd9 wave A — span selectors: the pure derivations every trace surface will
read. The keystone (#123, landed) stores spans whole in `state.traces`;
your job is the trees and summaries, derived on read, nothing accumulated.
Shapes to mirror: `research/2026-08-03-trace-era-captures.md` §1 (one trace
per prompt; interaction root; subagent `llm_request` nested under the Agent
tool's `execution` span; cross-trace links exist and are IGNORED in v1).

New `packages/core/src/selectors/traces.ts` (+ tests), exported through
`selectors/index.ts` and the core barrel:

1. `selectTraceTree(state, traceId)` — the nested tree: children sorted by
   `startTs`; a span whose parent never arrived is a root (orphans are
   normal mid-stream); multi-root traces are legal.
2. `selectLaneInteractions(state, lane)` — interaction roots newest-first,
   each with a summary: wall duration (`endTs - startTs`), llm request
   count, tool calls by `toolName`, `ttftMs` of the first `llm_request`,
   and token sums.
3. `selectWaitingOnHuman(state, { lane? })` — from `tool_blocked` spans:
   total wait ms, wait count, decision census (`accept`/`reject`/
   `unknown`), and the longest single wait with its `toolName` and lane.
   Name and document it as RETROSPECTIVE (prd9 ruling 6) — this selector
   reports how long lanes SAT waiting, never who waits now.
4. **Token discipline** (prd9 ruling 4 + the house token rulings): sums
   come ONLY from `kind === 'llm_request'` spans — a tree with tokens
   smuggled onto `tool`/`interaction` spans (the schema permits it)
   contributes nothing from them, proven by test. Report the four tiers
   separately, output-led; NEVER an unlabelled all-tier total. These
   selectors read `state.traces` only — never the spend slice — and no
   spend selector changes.

Build test states with core's real `createEvent`/fixture factory folded
through the real reducer, mirroring the capture shapes (incl. the subagent
nesting and an orphan-parent stream).

## Fence (may touch ONLY)

- `packages/core/src/selectors/traces.ts` (new)
- `packages/core/src/selectors/traces.test.ts` (new)
- `packages/core/src/selectors/index.ts`
- `packages/core/src/index.ts` (barrel export lines only)

## Blocked by

#123 (landed). **Model:** sonnet. **Wave:** A.

## Definition of done

- Tree builder proven against: orphan parent, multi-root trace, multi-trace
  lane, subagent nesting, duplicate-free input (the fold guarantees it).
- llm_request-only summation proven by the smuggled-tokens test; four tiers
  never collapsed into one number anywhere.
- `selectWaitingOnHuman` counts the capture's real `unknown` decisions and
  documents retrospectivity.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE (the gate audits every touched
path); small conventional commits (committing is REQUIRED — review
happens from your branch); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests must be deterministic
(no waitFor racing async work — stub or await the boundary; a flaky
test blocks the gate); build for a stranger's machine (no personal
paths, 127.0.0.1 not [::1], degrade loudly never silently); if you
cannot proceed print "BLOCKED: <need>" and stop; DoD is root
'npm test' + 'npm run typecheck' green, then STOP with a short summary.
