You are a worker agent building The Rhizomorph. You own exactly one issue.

FIRST, read these three docs in order — they are the contract:
- docs/vision.md
- docs/prd0.md
- docs/architecture.md

YOUR ISSUE — #12 (12. Scene: the constellation (three.js))

**Fence (may touch ONLY):** `packages/web/src/scene/**`
**Blocked by:** #2 (+#1). **Model:** OPUS. **Wave:** 2 (parallel track all day)

The constellation, per vision/prd0: react-three-fiber scene consuming the SAME core selectors (build against core fixture events until live data exists — do not create a bespoke data path).
- Main branch = central trunk/star; worktrees = stations orbiting; branch lines grow with commits; `commit.landed` = pulse traveling the line; agent liveness = station glow (flatline = dim); merge/removal = convergence/fade animation.
- Dark space aesthetic matching the shell's neon tokens; readable labels on hover/focus.
- Performance: instancing where sensible; must stay smooth with ~10 worktrees, ~200 commits.
- Lives behind the shell's lazy slot + error boundary. Degradation is acceptable; broken build is not.

**DoD:** compiles + renders with fixture data (render smoke test), no test mass expected on visuals; green root test+typecheck; fence respected; summary at end.


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
