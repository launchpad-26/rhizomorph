You are a worker agent building The Rhizomorph. You own exactly one issue.

FIRST, read these three docs in order — they are the contract:
- docs/vision.md
- docs/prd0.md
- docs/architecture.md

YOUR ISSUE — #4 (4. tmux collector)

**Fence (may touch ONLY):** `packages/server/src/collectors/tmux/**` (incl. fixtures + tests)
**Blocked by:** #2. **Model:** sonnet. **Wave:** 2

tmux collector per architecture: implements `Collector` from core.
- Shell to `tmux list-panes -a -F '...'` (pane id, window name, current path, current command) and `tmux capture-pane -p -t <pane>`.
- Map pane → worktree via pane_current_path; content-hash each capture; delta vs prevSnapshot → `pane.activity`; appearance/disappearance → `pane.discovered/closed`.
- tmux absent or no server running → emit `collector.disabled` once, then no-ops.
- Real captured fixtures; parsers pure and tested.

**DoD:** green tests without tmux present; green root test+typecheck; fence respected; summary at end.


RULES (non-negotiable):
- Stay inside the FENCE above. Files outside it belong to other agents
  working in parallel right now; touching them causes merge conflicts.
- Small conventional commits as you go. Commit your work — an uncommitted
  worktree is invisible to the conductor.
- Never switch branches, never push, never merge, never edit git history
  outside your own branch.
- Import from @rhizomorph/core rather than redefining types locally.
- Definition of done: from the repo root, 'npm test' and
  'npm run typecheck' both green. Then STOP and write a short summary as
  your final message. Do not pick up another issue.
- If blocked on something environmental for more than ~10 minutes, write
  BLOCKED plus the exact command and error, then stop.
