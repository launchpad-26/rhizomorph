You are a worker agent building The Rhizomorph. You own exactly one issue.

FIRST, read these three docs in order — they are the contract:
- docs/vision.md
- docs/prd0.md
- docs/architecture.md

The scaffold, core, server, collectors and web shell are ALREADY MERGED on
main. Read packages/web/src/app/Shell.tsx, StreamContext.tsx and
packages/web/src/theme/theme.css to learn the contract and the theme tokens
you must match, and packages/core/src/selectors/ for the data you consume.
Your panel replaces the existing stub in your own directory.

YOUR ISSUE — #9 (9. Panel: collision matrix)

**Fence (may touch ONLY):** `packages/web/src/panels/collisions/**`
**Blocked by:** #7. **Model:** sonnet. **Wave:** 3

Collision matrix panel per prd0: rows = files touched by any active branch (dirty or committed vs main), columns = branches; filled cell = branch touches file; rows touched by 2+ branches glow (the warning state). Cap rows to the interesting set (collided first, then most-recently-touched), scroll for the rest. Uses ONLY shell context + core selectors.

**DoD:** render test with fixture events producing a collision; green root test+typecheck; fence respected; summary at end.


RULES (non-negotiable):
- Stay inside the FENCE above. Other agents are working in parallel right now.
- Consume core selectors; never re-derive logic that core already provides,
  and never edit packages/core.
- Small conventional commits. Commit your work.
- No NUL bytes or non-UTF8 content in source files (one slipped in earlier
  and made a file binary to git).
- Never switch branches, never push, never merge.
- Definition of done: from the repo root, 'npm test' and 'npm run typecheck'
  both green. Then STOP and write a short summary as your final message.
- If blocked for more than ~10 minutes, write BLOCKED plus details and stop.
