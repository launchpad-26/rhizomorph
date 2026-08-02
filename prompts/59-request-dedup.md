You are a worker agent on The Rhizomorph (prd2: anyone, anywhere).
You own exactly one issue.

FIRST read docs/prd2.md — why this work exists — then
research/2026-07-31-prd2-audit-findings.md (file:line evidence) and
research/2026-07-31-prd2-live-baseline.md (what the dashboard showed
before your fix), then the files your issue names. Wave A goal: a
fresh boot starts at zero, timestamps are the source own, a restart
resumes instead of re-recording.

YOUR ISSUE — #59 (59. Count a request once: cross-collector dedup by requestId)

**Fence (may touch ONLY):** `packages/core/src/reduce.ts`, `packages/core/src/reduce.telemetry.test.ts`, `packages/server/src/collectors/otel/parse-metrics.ts`, `packages/server/src/collectors/otel/parse-metrics.test.ts`
**Blocked by:** — . **Model:** sonnet. **Wave: A**

One agent watched by both collectors is counted twice: sessionlog emits its
tokens per `requestId`, the OTel receiver emits the same request's tokens
again, and `reduce.ts:354-357` appends unconditionally. Cross-origin dedup is
impossible today because OTel usage hard-codes `requestId: null`
(`parse-metrics.ts:142`).

- **Surface the request id where it truly exists.** Inspect the captured OTLP
  fixtures next to `parse-metrics.ts`. If the datapoints genuinely carry a
  request id attribute, extract it. If they do not, say so in a code comment
  and in your summary — do NOT invent a synthetic id or a fuzzy join
  (sessionId+model+token-equality guessing is worse than double-counting,
  because it deletes real spend).
- **Dedup in the reducer, by identity only.** When an `llm.usage` arrives
  whose `requestId` has already been counted, fold rather than append:
  sessionlog wins for token detail (it has cache tiers; OTel splits
  input/output only), and the duplicate must not inflate any total,
  whichever order the two arrive in. Events with no `requestId` are never
  deduped against each other.
- This is telemetry-reduction only — do not touch selectors, collectors
  other than the two named files, or the event schema.

**DoD:** root `npm test` + `npm run typecheck` green; deterministic tests (no
waitFor racing an async boundary); no NUL bytes. Tests must prove: the same
requestId arriving from both sources in either order counts once with
sessionlog's tier detail preserved; distinct requestIds still accumulate;
null-requestId events are untouched. Never push, merge, or run git in a
sibling worktree — committing on YOUR branch is required. Finish with a short
summary including any live evidence the issue asks for.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @rhizomorph/core, never redefine its types; small
conventional commits; committing on YOUR branch is REQUIRED; never push,
merge, or run git in a sibling worktree; no NUL bytes; STOP when done.
