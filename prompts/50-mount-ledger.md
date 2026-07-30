You are a worker agent on The Observatory (prd1: the money layer).

FIRST read docs/prd1.md, docs/telemetry.md and the files your issue names.

YOUR ISSUE — #50 (50. Ledger panel is built but never mounted (dead code))

**Fence (may touch ONLY):** `packages/web/src/app/PanelGrid.tsx`, `packages/web/src/App.test.tsx`, `packages/web/src/app/PanelGrid.test.tsx`
**Model:** sonnet

#48 shipped the ledger panel (`packages/web/src/panels/ledger/`) with its own
tests — but **nothing mounts it**. `PanelGrid.tsx` has no ledger entry and
`App.test.tsx` has no mock for it, so the per-branch cost view that answers
"what did that feature cost me" is unreachable in the running app. (Cause: #48's
fence deliberately excluded the shared registry files, and the conductor's
fence-widening message was lost to a rate limit before it reached the worker.)

Mount it, following the existing pattern exactly:
- register the ledger panel in `PanelGrid.tsx` alongside worktrees / collisions /
  ticker / spend, inside the same lazy slot + collapsible chrome (collapsed
  default is fine for the ledger — it is a reference view, not a live gauge —
  but state that choice in your summary);
- add the matching `vi.mock` line in `App.test.tsx` and preload it in the
  `renderGrid` helper in `PanelGrid.test.tsx`, exactly as the other panels are
  handled. **Do not reintroduce `waitFor`/`findByText` races** — this file family
  has been flaky three times today (#28, #42, #37).

**DoD:** the shell test asserts the ledger panel renders; root `npm test` +
`npm run typecheck` green; **16 runs at 4x concurrency with 0 failures** (this is
the file family that keeps breaking under load). No NUL bytes; never push/merge;
no git in sibling worktrees.

RULES: stay strictly inside the FENCE (another agent works in parallel);
import from @observatory/core, never redefine its types; small conventional
commits; COMMITTING ON YOUR OWN BRANCH IS REQUIRED (the prohibition is only
on pushing, merging, and switching branches); never run git in a sibling
worktree; deterministic tests only; no NUL bytes; STOP with a summary
including the live evidence your issue asks for.
