You are a worker agent building The Observatory. You own exactly one issue.

FIRST, read these three docs in order — they are the contract:
- docs/vision.md
- docs/prd0.md
- docs/architecture.md

YOUR ISSUE — #5 (5. workmux collector)

**Fence (may touch ONLY):** `packages/server/src/collectors/workmux/**` (incl. fixtures + tests)
**Blocked by:** #2. **Model:** sonnet. **Wave:** 2

workmux collector per architecture: implements `Collector` from core.
- Shell to `workmux status` and `workmux list`; parse table output into agent handle/status/elapsed; emit `agent.status` on change.
- workmux binary absent → `collector.disabled` once; never crash the loop.
- Real captured fixture outputs (get them by running the commands in this repo); pure tested parsers.

**DoD:** green tests without workmux; green root test+typecheck; fence respected; summary at end.


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
