You are a worker agent on The Rhizomorph (prd2: anyone, anywhere).
You own exactly one issue.

FIRST read docs/prd2.md — why this work exists — then
research/2026-07-31-prd2-audit-findings.md (file:line evidence).
Wave B context, already landed: #60 (instance identity; role enum
gained unattributed; telemetry.refused events exist and reduce.ts
passes them through with a comment pointing at YOUR issue), #61
(role only from declared attributes). #63 (lane x role selectors)
is gated separately — do not depend on its selectors; render your
gap lines from the state you can already reach.

YOUR ISSUE — #62 (62. The repo root is not a worker: unattributed root sessions, gaps shown in the spend panel)

**Fence (may touch ONLY):** `packages/server/src/collectors/sessionlog/collector.ts`, `packages/server/src/collectors/sessionlog/collector.test.ts`, `packages/web/src/panels/spend/` (the whole directory)
**Blocked by:** #57, #60. **Model:** sonnet. **Wave: B**

`collector.ts` hard-codes `role: 'worker'` for every entry `git worktree
list` returns — **including the main working tree** — so a conductor driving
the repo root is silently booked as worker spend (the baseline booked 287.7K
tokens of root-session activity as a worker with a model badge).

- **Linked worktrees stay workers.** They exist because the swarm made them;
  `role: 'worker'` is correct there.
- **The main checkout is not a worker.** Sessions tailed from the repo
  root's project dir get `lane: UNATTRIBUTED_LANE, role: 'unattributed'`
  (the role value #60 added) unless the operator declared them (an
  `--extra-sessions` spec covering that dir keeps its declared lane/role,
  exactly as today). Identify the main working tree from the porcelain
  output's first entry — worktree order is stable in git — and comment why.
- **The gap is shown, not implied.** In the spend panel: an `unattributed`
  bucket with copy telling the operator exactly how to claim it
  (`--extra-sessions <dir>:<lane>` or `rhizomorph env`), and a line
  surfacing #60's `telemetry.refused` counts ("N posts refused from unknown
  instance") when any exist. Follow the existing
  "CONDUCTOR NOT INSTRUMENTED" pattern in this panel: explicit gap, never a
  substitute number.

**DoD:** root `npm test` + `npm run typecheck` green; deterministic tests (no
waitFor racing an async boundary); no NUL bytes. Tests must prove: root
sessions book as unattributed while linked-worktree sessions stay workers; a
declared root (via extra-sessions) keeps its declared identity; the panel
renders both gap lines from state containing them. Never push, merge, or run
git in a sibling worktree — committing on YOUR branch is required. Finish
with a short summary including any live evidence the issue asks for.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @rhizomorph/core, never redefine its types; small
conventional commits; committing on YOUR branch is REQUIRED; never push,
merge, or run git in a sibling worktree; no NUL bytes; STOP when done.
