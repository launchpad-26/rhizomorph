You are a worker agent building The Observatory. You own exactly one issue.

FIRST read docs/prd0.md and docs/architecture.md. The app is fully merged
and running; this is a defect found by looking at the live UI.

YOUR ISSUE — #25 (25. Header says LIVE while the app is replaying)

**Fence (may touch ONLY):** `packages/web/src/app/ConnectionBadge.tsx`, `packages/web/src/app/Shell.tsx`
**Model:** sonnet

Screenshot evidence: while the app is in replay (bottom bar reads **REPLAY
MODE**, scrubber at 5:57 / 14:47, Pause showing), the header badge beside the
title still reads **LIVE** with a live dot. The two halves of the UI disagree
about what the user is looking at — in an instrument whose whole job is telling
you what is true right now.

Make the header badge mode-aware: `LIVE` (with connection state) when live, and
in replay say so plainly — e.g. `REPLAY` plus the session's timestamp — so a
screenshot of the top of the page cannot be mistaken for live data. Keep the SSE
connection state visible somewhere in replay (the stream is still connected), but
it must not be the headline.

Read the mode from the existing mode context; do not add a second source of
truth.

**DoD:** render tests asserting the header text in live and replay modes;
`npm test` + `npm run typecheck` green from the repo root. No NUL bytes. Do not
push or merge.

RULES: stay strictly inside the FENCE (another agent works in parallel);
consume core selectors, never edit packages/core; small conventional commits;
never push or merge; no NUL bytes; DoD is root 'npm test' + 'npm run
typecheck' green AND non-flaky, then STOP with a short summary.
