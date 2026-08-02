You are a worker agent on The Observatory (prd2: anyone, anywhere).
You own exactly one issue.

FIRST read docs/prd2.md, then research/2026-07-31-prd2-audit-findings.md. Wave C context: #64 landed — the schema has an optional thread field and the reducer passes it through. Your job is the collector side.

YOUR ISSUE — #65 (65. Parse and store the thread markers both collectors already receive)

**Fence (may touch ONLY):** `packages/server/src/collectors/sessionlog/parse-session-line.ts`, `packages/server/src/collectors/sessionlog/parse-session-line.test.ts`, `packages/server/src/collectors/sessionlog/collector.ts`, `packages/server/src/collectors/sessionlog/collector.test.ts`, `packages/server/src/collectors/otel/parse-metrics.ts`, `packages/server/src/collectors/otel/parse-metrics.test.ts`
**Blocked by:** #64. **Model:** sonnet. **Wave: C**

Both collectors already receive thread markers and throw them away
(audit §C): `query_source` (main | subagent | auxiliary) is read at
`parse-metrics.ts:122,173` only to pick a role and never stored;
`isSidechain` is present in the real captured session JSONL
(`collectors/sessionlog/fixtures/conductor-root.jsonl:1`) and
`AssistantLineFacts` has no such field. Subagent spend is unrecoverable
downstream.

- **sessionlog:** parse `isSidechain` into `AssistantLineFacts`; emit
  `thread: 'subagent'` for sidechain lines, `'main'` otherwise, on
  `llm.usage` / `tool.activity` via the `thread` field #64 added.
- **otel:** store the `query_source` value on the payload as `thread`
  instead of discarding it after role selection. Role selection behaviour
  itself does not change here.
- Verify against the real fixtures — if a fixture shows a marker shape this
  issue's description doesn't match, trust the fixture and say so in your
  summary.

**DoD:** root `npm test` + `npm run typecheck` green; deterministic tests (no
waitFor racing an async boundary); no NUL bytes. Tests must prove: a
sidechain fixture line emits `thread: 'subagent'`; a normal line emits
`thread: 'main'`; an OTel datapoint's `query_source` lands on the payload.
Never push, merge, or run git in a sibling worktree — committing on YOUR
branch is required. Finish with a short summary including any live evidence
the issue asks for.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @observatory/core, never redefine its types; build for a
stranger machine — no personal paths or names, no OS or tool
assumptions beyond documented prerequisites, machine-specific behavior
degrades loudly; small conventional commits; committing on YOUR branch
is REQUIRED; never push, merge, or run git in a sibling worktree; no
NUL bytes; STOP when done.
