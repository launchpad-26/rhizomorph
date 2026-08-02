You are a worker agent building The Rhizomorph. You own exactly one issue.

FIRST read docs/architecture.md (§Web: 'live and replay are the same
reducer'), packages/web/src/app/StreamContext.tsx and
packages/web/src/replay/index.tsx.

YOUR ISSUE — #23 Replay drives the clock but not the panels

**Fence (may touch ONLY):** `packages/web/src/app/StreamContext.tsx`, `packages/web/src/app/ModeContext.tsx`, `packages/web/src/replay/`, and `packages/web/src/app/Shell.tsx` (wiring only)
**Model:** sonnet. **This is the demo centrepiece.**

Replay half-works, and the broken half is the point of the feature.

Verified in a real browser against the 778-event session
`2026-07-30T01:51:08.971Z`: selecting it and pressing Play at 16x advances the
replay clock (scrubber 4:22 / 14:47) and the replay module's own summary line
correctly reports `4 worktrees · 1 commits · 3 agents as of scrub time`. But
every panel keeps showing the **live** state at the same moment: the collisions
panel says "No collisions — no two branches touch the same file", the ticker says
"No commits yet this session", and the worktree table lists only `main`.

Cause: the panels consume the live SSE state from `StreamContext`, while replay
folds a separate state inside `packages/web/src/replay/`. Two states, one set of
panels, wired to the wrong one.

Architecture already prescribes the fix ("live and replay are the same
reducer"): make `StreamContext` expose the state for the **current mode** — live
SSE state when `mode === 'live'`, the replay fold at the current scrub time when
`mode === 'replay'`. Panels should not know which mode is active; they keep
reading one hook. Keep the replay fold where it is; just make it the state the
provider serves while replaying, and make "Return to live" restore the live
state.

**DoD:**
1. A test asserting panels render replay-derived state while in replay mode and
   live state otherwise (fails today).
2. `npm test` + `npm run typecheck` green from the repo root.
3. State the manual check in your summary: with the server on port 4400, select
   session `2026-07-30T01:51:08.971Z`, press 16x then Play, and confirm the
   worktree table and ticker fill in as the scrubber advances.

No NUL bytes. Do not push or merge.

RULES: stay in the fence; small conventional commits; never push or merge;
no NUL bytes; DoD is root 'npm test' + 'npm run typecheck' green, then STOP
with a short summary.
