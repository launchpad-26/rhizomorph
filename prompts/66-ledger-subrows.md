You are a worker agent on The Observatory (prd2: anyone, anywhere).
You own exactly one issue.

FIRST read docs/prd2.md. Wave C context: #64 landed — per-thread sub-totals exist in the selectors. Your tests are fixture-driven; live thread data arrives with #65 separately.

YOUR ISSUE — #66 (66. Ledger: thread sub-rows under the parent lane)

**Fence (may touch ONLY):** `packages/web/src/panels/ledger/` (the whole directory)
**Blocked by:** #64, #65. **Model:** sonnet. **Wave: C**

Threads are invisible: a lane that spawned ten subagents shows one
undifferentiated number. The prd ruling: **threads are sub-rows under the
parent lane — the lane stays the unit of work.**

- In the ledger panel, a lane with thread data renders collapsible sub-rows
  (main / subagent / auxiliary) under its row, using #64's per-thread
  selectors. Sub-row columns mirror the parent (cost, tokens, models) at
  thread granularity.
- A lane with no thread data renders exactly as today — no empty sub-rows,
  no "unknown" noise.
- The parent row's numbers remain the lane totals; sub-rows must visibly sum
  to their parent (same reconciliation the selectors guarantee).

**DoD:** root `npm test` + `npm run typecheck` green; deterministic tests (no
waitFor racing an async boundary); no NUL bytes. Tests must prove: a lane
with mixed thread spend renders sub-rows that sum to the parent; a lane
without thread data renders no sub-rows; expand/collapse state doesn't leak
between lanes. Never push, merge, or run git in a sibling worktree —
committing on YOUR branch is required. Finish with a short summary including
any live evidence the issue asks for.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @observatory/core, never redefine its types; build for a
stranger machine — no personal paths or names, no OS or tool
assumptions beyond documented prerequisites, machine-specific behavior
degrades loudly; small conventional commits; committing on YOUR branch
is REQUIRED; never push, merge, or run git in a sibling worktree; no
NUL bytes; STOP when done.
