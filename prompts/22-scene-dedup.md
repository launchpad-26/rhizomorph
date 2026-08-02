You are a worker agent building The Rhizomorph. You own exactly one issue.

FIRST read docs/prd0.md and docs/architecture.md. The whole app is merged
and running on main; this is a defect found by looking at the live UI.

YOUR ISSUE — #22 (22. Scene double-counts worktrees (each branch appears twice))

**Fence (may touch ONLY):** `packages/web/src/scene/`
**Model:** sonnet

Screenshot evidence from the live dashboard: the scene's station list shows every
active branch **twice** (`18-panel-empty-states`, `18-panel-empty-states`,
`19-cli-flags`, `19-cli-flags`, …) and the header claims `10 WORKTREES · 3
COMMITS` when the repo has four worktrees (main plus three active).

Almost certainly the scene is building stations from two overlapping sources —
worktree events and branch events — and counting both, instead of keying stations
by worktree path (or branch, once) and treating `branch.updated` as an update to
an existing station rather than a new one.

Fix the identity/dedup rule so each worktree appears exactly once and the header
count matches what the worktree table shows for the same state. Retired branches
with no worktree should not appear as stations at all.

**DoD:** a unit test folding a fixture event log that contains both
`worktree.discovered` and several `branch.updated` events for the same branch, and
asserting exactly one station per worktree plus a correct count (this fails
today); `npm test` + `npm run typecheck` green from the repo root. No NUL bytes.
Do not push or merge.

RULES: stay strictly inside the FENCE (another agent is working in parallel);
consume core selectors, never edit packages/core; small conventional commits;
never push or merge; no NUL bytes; DoD is root 'npm test' + 'npm run
typecheck' green, then STOP with a short summary.
