You are a worker agent on The Observatory (prd2: anyone, anywhere).
You own exactly one issue.

FIRST read docs/prd2.md — why this work exists — then
research/2026-07-31-prd2-audit-findings.md (file:line evidence) and
research/2026-07-31-prd2-live-baseline.md (what the dashboard showed
before wave A). Wave B goal: identity that cannot collide — declared
at the source, namespaced by instance, never inferred from strings.

YOUR ISSUE — #61 (61. otel attribution: role only from the declared attribute; no hash lanes)

**Fence (may touch ONLY):** `packages/server/src/collectors/otel/attribution.ts`, `packages/server/src/collectors/otel/attribution.test.ts`
**Blocked by:** — . **Model:** sonnet. **Wave: B**

Identity is inferred where it must be declared
(audit `research/2026-07-31-prd2-audit-findings.md` §B):

- `attribution.ts:49` books any lane literally named `conductor` as
  `role: conductor`. A worker whose branch happens to be called `conductor`
  becomes conductor spend; a conductor lane named anything else becomes a
  worker. **Role comes only from the explicit `role` resource attribute**
  (which `observatory env` already emits). No lane-string matching, ever.
  An accepted post with no `role` attribute defaults to `worker` — document
  in a comment that post-#60 every accepted post came from our own env
  block, so this default is a backstop, not an inference channel.
- `attribution.ts:28` falls back to `shortHash(session.id)` for an untagged
  agent, minting a brand-new lane on every restart (lane churn the baseline
  can't aggregate). Fall back to `UNATTRIBUTED_LANE` instead — one stable,
  visible bucket; never a synthetic lane name.

**DoD:** root `npm test` + `npm run typecheck` green; deterministic tests (no
waitFor racing an async boundary); no NUL bytes. Tests must prove: a lane
named `conductor` with `role=worker` books as worker; an explicit
`role=conductor` books as conductor whatever the lane is called; an untagged
session lands on `UNATTRIBUTED_LANE` and stays there across a simulated
restart (no hash lanes). Never push, merge, or run git in a sibling worktree
— committing on YOUR branch is required. Finish with a short summary
including any live evidence the issue asks for.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @observatory/core, never redefine its types; small
conventional commits; committing on YOUR branch is REQUIRED; never push,
merge, or run git in a sibling worktree; no NUL bytes; STOP when done.
