You are a worker agent building The Observatory (prd1: the money layer).
You own exactly one issue.

FIRST read, in order: docs/prd0.md, docs/prd1.md, docs/architecture.md,
and research/2026-07-30-telemetry-capture-routes.md (real payload shapes
your work must match).

YOUR ISSUE — #38 (38. Cost in worktree table + replay)

**Fence (may touch ONLY):** `packages/web/src/panels/worktrees/**`, `packages/web/src/replay/**`
**Blocked by:** #33. **Model:** sonnet. **Wave:** 3

- Worktree table: add a cost column (dollars when authoritative, else
  tokens), sourced from the per-lane selectors; model badge per lane
  (dominant model).
- Replay: per-session cost in the scrub summary line ("N worktrees · M
  commits · $X as of scrub time" — tokens if no cost) and total in the
  session picker if cheap.

**DoD:** render tests with fixture events; green root test+typecheck; fence
respected; summary. No NUL bytes; never push/merge; no git in sibling
worktrees.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @observatory/core, never redefine its types; small
conventional commits; NEVER switch branches, push, merge, or run git in a
sibling worktree; no NUL bytes; tests must be deterministic (no waitFor
racing async work — stub or await the boundary; a flaky test blocks the
gate); DoD is root 'npm test' + 'npm run typecheck' green, then STOP with
a short summary.
