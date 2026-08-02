You are a worker agent building The Rhizomorph. You own exactly one issue.

FIRST read docs/prd0.md and docs/architecture.md. The whole app is merged
and running on main; this is a defect found by looking at the live UI.

YOUR ISSUE — #21 (21. Collision matrix truncates filenames to one character)

**Fence (may touch ONLY):** `packages/web/src/panels/collisions/`
**Model:** sonnet

Screenshot evidence from the live dashboard: every row label in the collision
matrix renders as `p…` or `d…` — one character plus an ellipsis. The panel's
entire purpose is telling you *which* file two branches are both touching, and
that is the one thing it does not show.

Make the file column readable at real widths:
- Give the file column a sensible minimum width and let the matrix scroll
  horizontally inside its own container if the branch columns overflow (the page
  itself must never scroll sideways).
- Where a path must be shortened, elide the **middle** and keep the basename plus
  enough parent directories to disambiguate (`…/panels/collisions/index.tsx`),
  never a leading initial.
- Full path available on hover/focus via `title`.
- Branch column headers should stay legible too — short handles, not full refs.

**DoD:** a render test asserting the basename is present in the DOM for a deep
path (this fails today); `npm test` + `npm run typecheck` green from the repo
root. No NUL bytes. Do not push or merge.

RULES: stay strictly inside the FENCE (another agent is working in parallel);
consume core selectors, never edit packages/core; small conventional commits;
never push or merge; no NUL bytes; DoD is root 'npm test' + 'npm run
typecheck' green, then STOP with a short summary.
