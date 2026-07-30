You are a worker agent building The Observatory (prd1: the money layer).
You own exactly one issue.

FIRST read, in order: docs/prd0.md, docs/prd1.md, docs/architecture.md,
and research/2026-07-30-telemetry-capture-routes.md (real payload shapes
your work must match).

YOUR ISSUE — #39 (39. Collapsible panels (collisions default-on))

**Fence (may touch ONLY):** `packages/web/src/app/PanelGrid.tsx`, `packages/web/src/app/panelPrefs.ts` (new), and a shared panel-chrome component `packages/web/src/app/PanelFrame.tsx` (new) if you need one
**Blocked by:** #33 not required — independent. **Model:** sonnet. **Wave:** 2

Collapsible/configurable panels per docs/prd1.md:

- Every panel gets collapse/expand chrome; collapsed state persisted
  (localStorage); collisions default-ON (a deliberate product ruling — do
  not default it off).
- Do NOT edit individual panels' internals; wrap at the grid/frame level.
- Keyboard accessible; theme tokens.

**DoD:** render tests incl. persistence round-trip; green root
test+typecheck; fence respected; summary. No NUL bytes; never push/merge; no
git in sibling worktrees.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @observatory/core, never redefine its types; small
conventional commits; NEVER switch branches, push, merge, or run git in a
sibling worktree; no NUL bytes; tests must be deterministic (no waitFor
racing async work — stub or await the boundary; a flaky test blocks the
gate); DoD is root 'npm test' + 'npm run typecheck' green, then STOP with
a short summary.
