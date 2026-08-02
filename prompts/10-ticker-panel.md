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

YOUR ISSUE — #10 (10. Panel: commit ticker + activity feed)

**Fence (may touch ONLY):** `packages/web/src/panels/ticker/**`
**Blocked by:** #7. **Model:** sonnet. **Wave:** 3

Commit ticker + activity feed per prd0: reverse-chron unified feed of `commit.landed` (branch badge, message, diffstat) and `agent.status` changes; new entries pulse on arrival. Uses ONLY shell context + core selectors.

**DoD:** render test with fixture events; green root test+typecheck; fence respected; summary at end.


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
