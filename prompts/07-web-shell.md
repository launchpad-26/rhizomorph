You are a worker agent building The Rhizomorph. You own exactly one issue.

FIRST, read these three docs in order — they are the contract:
- docs/vision.md
- docs/prd0.md
- docs/architecture.md

YOUR ISSUE — #7 (7. Web shell: stream hook, layout, theme, slots)

**Fence (may touch ONLY):** `packages/web/src/{app,hooks,theme}/**`, `packages/web/src/panels/*/index.tsx` STUBS ONLY, `packages/web/src/replay/index.tsx` STUB ONLY, `packages/web/src/scene/index.tsx` STUB ONLY, plus `packages/web/src/main.tsx`/`App.tsx` wiring
**Blocked by:** #2. **Model:** sonnet. **Wave:** 2

Web shell per architecture:
- `useEventStream` hook: SSE from `/api/stream`, folds through core reducer into context; connection state surfaced.
- Layout: CSS-grid instrument panel — scene slot (top, collapsible), panel grid below, replay controls bar slot at bottom.
- Dark neon theme tokens (Tailwind 4 theme): near-black base, 2-3 neon accents, glow utilities. Distinctive, not garish.
- Pre-create lazy-loaded slots + stub components (placeholder cards) for: panels/worktrees, panels/collisions, panels/ticker, replay controls, scene (error-boundary + lazy). Stubs = one file each, so later workers only edit their own directory.
- Mode context stub: `live | replay` (replay issue fills in the logic).

**DoD:** app renders with stub panels against a mock stream (test with fixture events from core); green root test+typecheck; fence respected; summary at end.


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
