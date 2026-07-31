You are a worker agent on The Observatory (prd2: anyone, anywhere).
You own exactly one issue.

FIRST read docs/prd2.md — why this work exists — then
research/2026-07-31-prd2-audit-findings.md (file:line evidence).
Wave B goal: identity that cannot collide. #60 and #61 have landed:
the role enum now includes unattributed, and identity is declared,
never inferred.

YOUR ISSUE — #63 (63. Spend queryable by lane x role; unattributed visible in the split)

**Fence (may touch ONLY):** `packages/core/src/selectors/spend.ts`, `packages/core/src/selectors/spend.test.ts`
**Blocked by:** #60. **Model:** sonnet. **Wave: B**

Role and lane both sit on every telemetry record but are never keyed jointly
(audit §C): "conductor spend within lane X" is unaskable, and the role split
hard-codes the three declared roles so the new `unattributed` value (#60/#62)
would vanish from the totals.

- **`selectSpendByLaneRole`** — spend jointly keyed by (lane, role), same
  shape conventions as the existing by-lane/by-branch selectors, honouring
  `SpendFilter`.
- **The role split carries `unattributed`** as a first-class bucket alongside
  worker/conductor/auxiliary, so undeclared spend is visible in the split the
  ticker renders — a setup gap with a number, not a silent omission. The
  overhead ratio's definition does not change: conductor tokens ÷ worker
  tokens, unattributed excluded from both sides (comment why: an undeclared
  session must never silently inflate either side of the headline number).

**DoD:** root `npm test` + `npm run typecheck` green; deterministic tests (no
waitFor racing an async boundary); no NUL bytes. Tests must prove: lane×role
totals reconcile with the existing by-lane totals on the same fixture state;
unattributed spend appears in the split and never in the overhead ratio.
Never push, merge, or run git in a sibling worktree — committing on YOUR
branch is required. Finish with a short summary including any live evidence
the issue asks for.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @observatory/core, never redefine its types; small
conventional commits; committing on YOUR branch is REQUIRED; never push,
merge, or run git in a sibling worktree; no NUL bytes; STOP when done.
