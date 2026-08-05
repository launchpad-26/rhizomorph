You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

Lever A of #166 — read #166's landed diff first (SSE resume + the identity law). Your buffer must compose with resume: a reconnect burst and a first-load burst go through the same batch path.

YOUR ISSUE — #183:

## Direction

Operator-felt 2026-08-05 ("INCREDIBLY slow right now"), mechanism long since
located: #166 shipped SSE resume (reconnects now cheap) but deliberately
deferred its lever A. On a FRESH page load there is no Last-Event-ID, so the
server replays the entire session and useEventStream.ts applies it one
setState per event; foldStreamEvent copies the whole events array per event
(streamState.ts:67). A 55k-event session = ~1.5 billion element copies plus
55k React updates before first usable paint.

Fix — lever A, exactly as #166 specced it:

1. Coalesce arriving SSE events into a buffer; fold once per animation frame
   via foldStreamEvents (the batch fold that exists for precisely this,
   its docstring says so). One setState per frame, not per event.
2. The identity law, already test-stated by #166: batched === per-event for
   the same input, including out-of-order and duplicate ids — extend, do not
   weaken.
3. News semantics unchanged: isNews reads event.ts vs connectedAt, so
   batching cannot turn history into news — assert it.
4. Measure and report first-load time-to-interactive at 5k/15k/55k, before
   and after, interleaved rounds on a quiet box (#157 discipline).

## Fence (may touch ONLY)

- packages/web/src/hooks/useEventStream.ts, useEventStream.test.ts
- packages/web/src/app/StreamContext.tsx, StreamContext.test.tsx
- packages/web/src/app/streamState.ts, streamState.test.ts

## Blocked by

Nothing (the #166 fence is free). **Model:** sonnet. **Wave:** audit-fix.

## Definition of done

- Fresh load of a 55k-event session is interactive without a replay storm;
  identity + news laws green; before/after reported at three sizes.
- Root npm test + npm run typecheck green.


RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
