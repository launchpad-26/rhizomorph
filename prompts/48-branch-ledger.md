You are a worker agent on The Observatory (prd1: the money layer).

FIRST read docs/prd1.md and packages/core/src/selectors/spend.ts (the
existing spend selectors you are extending, not replacing).

YOUR ISSUE — #48

**Fence (may touch ONLY):** `packages/core/src/selectors/spend.ts`, `packages/core/src/selectors/spend.test.ts`, `packages/web/src/panels/ledger/**` (new)
**Model:** sonnet

Per-lane cost exists (`selectLaneSpend`, `selectSpendForLane`,
`selectSpendByWorktree`) and renders while a lane is alive. **It dies when the
lane does.** `workmux merge` removes the worktree and deletes the branch on
landing, so the row disappears from the live table and the spend is unreachable
— even though every event is still in the session log.

Consequence: the question this product exists to answer — *"what did that
feature cost me?"* — cannot be answered for any **finished** piece of work,
which is all of the interesting ones.

Cause: spend is keyed on **worktree path**, which is ephemeral by design. The
durable identity of a unit of work is its **branch** (and in the fenced-issue
convention the branch name carries the issue number, e.g.
`34-sessionlog-collector`).

Build:
1. **Core:** spend keyed by branch, surviving the worktree's removal —
   `selectSpendByBranch` returning, per branch: tokens by tier, cost (with
   provenance — see #47), model mix, first/last activity, elapsed working time,
   and whether the branch is still live or has landed (derive "landed" from
   the existing worktree-removed / branch events; do not invent a new source).
   Where the branch name starts with digits, expose that as an `issue` field
   so a lane can be traced to its issue.
2. **A ledger panel** (`panels/ledger/`): one row per branch this session has
   seen, live and finished together, sorted by cost — the "what did each
   feature cost" table. Show provenance and the honesty note per #47; no
   invented dollars.

Do NOT touch the existing worktree table or spend ticker (other agents own
them) and do not rename existing selectors — add alongside.

**DoD:** dense selector tests over a fixture log where a branch accrues spend,
is then removed as a worktree, and still reports its full cost afterwards
(this is the behaviour that fails today); render tests for the panel with live
and landed branches; root `npm test` + `npm run typecheck` green; deterministic
tests only. No NUL bytes; never push/merge; no git in sibling worktrees.

RULES: stay strictly inside the FENCE (two other agents work in parallel on
the sessionlog collector and the spend panel); import from @observatory/core
types; small conventional commits; committing on YOUR branch is REQUIRED;
never push, merge, or run git in a sibling worktree; deterministic tests
only; no NUL bytes; STOP with a short summary.
