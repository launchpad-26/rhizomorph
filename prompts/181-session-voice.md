You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

Web half of the sessions pair. #180 is LANDED — /api/meta now carries resumedCount, eventCount, resumeWindowMs, lastBootReason; read its diff first. The mode-clock discipline (#155) governs replay.

YOUR ISSUE — #181:

## Direction

Web half of #180 (read its landed diff first — `/api/meta`'s additive fields
are your contract). Today the live UI never mentions the current session: a
multi-day 55k-event session is indistinguishable from a fresh one.

1. **The provenance line** (bottom strip — git/tmux/sessionlog/otel — NOT a
   new panel, prd3's curated order stands) gains the session voice:
   `session 3d4h · 55k events · resumed x7`. Compact, figures-styled,
   ice-400 floor respected (#136 law untouched).
2. **Hover explains the boundary**: the title/tooltip carries the boot
   reason and the window (`resumed: newest event 2h04m < 4h window —
   --fresh or --resume-window to force a boundary`). Teaching lives in
   hover, not in permanent pixels.
3. **Replay mode**: the line reads the REPLAYED session's identity (id,
   span, event count) — the mode clock discipline (#155) applies; never
   show the live session's facts against a replayed scene.
4. Honest-gap voice if meta lacks the new fields (an old server): render
   the session id alone with an em dash, never invented figures.

## Fence (may touch ONLY)

- `packages/web/src/app/StatusBar.tsx`, `StatusBar.test.tsx`
- `packages/web/src/lib/` meta-fetch seam ONLY if one already exists there
  (if the meta read lives elsewhere, BLOCKED: <need> — do not create a
  second fetch path)

## Blocked by

#180 (its meta fields are the contract). **Model:** sonnet. **Wave:** sessions.

## Definition of done

- Live and replay both name their session honestly; gap voice for old
  servers; #136 law green; browser-verified live AND in replay.
- Root `npm test` + `npm run typecheck` green.


RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
