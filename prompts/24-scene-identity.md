You are a worker agent building The Rhizomorph. You own exactly one issue.

FIRST read docs/prd0.md and docs/architecture.md. The app is fully merged
and running; this is a defect found by looking at the live UI.

YOUR ISSUE — #24 (24. Scene still lists every branch twice (header count disagrees with the table))

**Fence (may touch ONLY):** `packages/web/src/scene/`
**Model:** sonnet

Issue #22 reduced the problem but did not fix it. Current screenshot evidence
from the live app (and again in replay):

- The scene's station list shows **each active branch twice** —
  `18-panel-empty-states` (1), `18-panel-empty-states` (0), `19-cli-flags` (0),
  `19-cli-flags` (0), `20-decisions-log` (1), `20-decisions-log` (0) — one entry
  carrying a commit count and one carrying zero.
- The scene header reads `6 WORKTREES · 3 COMMITS` at the same moment the
  worktree table (same state, same selectors) shows **4** rows.

The duplicate-with-zero pattern says two different keys are being minted for the
same thing — most likely one station from the worktree record (keyed by path) and
another from the branch record (keyed by branch name), with the branch-derived one
never receiving commits.

Fix it at the identity level: one station per **worktree**, keyed by worktree
path; branch data attaches to the station for that path; branches without a
worktree produce no station. The header count must equal the number of worktrees
the worktree panel would list for the same state — derive both from the same core
selector rather than counting locally.

**DoD:**
1. A unit test folding a fixture log with `worktree.discovered` **plus**
   `branch.updated` for the same branch **plus** a branch with no worktree, and
   asserting: one station per worktree, no duplicate labels, and header count ==
   worktree count. This must fail against the current code — say so in your
   summary after checking.
2. `npm test` + `npm run typecheck` green from the repo root.
3. Tests must not be flaky: run `npm test --workspace packages/web` 5 times and
   report 5/5.

No NUL bytes. Do not push or merge.

RULES: stay strictly inside the FENCE (another agent works in parallel);
consume core selectors, never edit packages/core; small conventional commits;
never push or merge; no NUL bytes; DoD is root 'npm test' + 'npm run
typecheck' green AND non-flaky, then STOP with a short summary.
