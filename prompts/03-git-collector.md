You are a worker agent building The Observatory. You own exactly one issue.

FIRST, read these three docs in order — they are the contract:
- docs/vision.md
- docs/prd0.md
- docs/architecture.md

YOUR ISSUE — #3 (3. Git collector)

**Fence (may touch ONLY):** `packages/server/src/collectors/git/**` (incl. its fixtures + tests)
**Blocked by:** #2. **Model:** sonnet. **Wave:** 2

Git collector per architecture: implements `Collector` from core.
- Shell out (thin exec wrapper) to: `git worktree list --porcelain`, `git for-each-ref` (branch heads), `git log` (new commits w/ diffstat + files, `--name-status`), `git status --porcelain` per worktree (dirty file set), merge-base vs main.
- Pure parsers over command OUTPUT TEXT; capture real fixture outputs into the fixture dir and unit-test parsers against them (both healthy and edge cases: detached HEAD, no worktrees, renamed files).
- Emit only diffs vs prevSnapshot: worktree.discovered/removed, branch.updated, commit.landed, worktree.dirty.

**DoD:** parser tests green on fixtures; no git needed to run tests; green root test+typecheck; conventional commits; fence respected; summary at end.


RULES (non-negotiable):
- Stay inside the FENCE above. Files outside it belong to other agents
  working in parallel right now; touching them causes merge conflicts.
- Small conventional commits as you go. Commit your work — an uncommitted
  worktree is invisible to the conductor.
- Never switch branches, never push, never merge, never edit git history
  outside your own branch.
- Import from @observatory/core rather than redefining types locally.
- Definition of done: from the repo root, 'npm test' and
  'npm run typecheck' both green. Then STOP and write a short summary as
  your final message. Do not pick up another issue.
- If blocked on something environmental for more than ~10 minutes, write
  BLOCKED plus the exact command and error, then stop.
