You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

YOUR ISSUE — #160:

## Direction

BUG, measured live by the conductor 2026-08-04: the browser's renderer
stopped answering CDP for 45s while replaying a 21,639-event session.
Cause, located in `packages/web/src/replay/useReplaySession.ts:108-115`:

```
eventsAtScrubTime = useMemo(() => eventsUpTo(events, currentTs), [events, currentTs])
state            = useMemo(() => reduceAll(eventsAtScrubTime, initialSessionState()), ...)
```

`eventsUpTo` (replayFold.ts:14) does `events.filter(...).sort(...)` — a
FULL filter AND SORT of every event — and `reduceAll` then re-folds the
whole prefix FROM SCRATCH. Both run on every `currentTs` change, i.e.
every playback tick. At 21k events that is tens-to-hundreds of ms per
tick on the main thread, and it gets worse the longer a session runs.
The operator's 20-hour session is the normal case for this product, not
an edge case.

Fix — three layers, cheapest first, WITHOUT breaking the law that live
and replay fold through the same reducer:

1. **Sort once, then binary-search.** The server serves events in fold
   order; sorting per tick is pure waste. Sort ONCE when a session loads
   (or assert sortedness and skip), then `eventsUpTo` becomes a binary
   search for the boundary index plus a slice — O(log n).
2. **Fold forward incrementally when time moves forward.** Keep the last
   `(ts, state)`; when `currentTs` advances, fold ONLY the events in
   `(lastTs, currentTs]` onto the previous state. Playback then costs
   the new events, not the whole prefix.
3. **Keyframes for backward scrubs.** Rewinding cannot fold backward, so
   precompute snapshots at a bounded interval (every N events — pick N
   from measurement, e.g. 500, and say why) once per session load; a
   scrub to T restores the nearest keyframe ≤ T and folds forward the
   remainder. Bounded work per scrub regardless of session length.

Laws that must survive, test-stated:
- Live and replay produce IDENTICAL state for the same events (the whole
  product rests on this — assert incremental result equals full refold at
  many random scrub points, including backward jumps).
- Scrubbing is still exactly reversible (#155's law).
- No behaviour change visible to the user except speed.

**Measure and report**: full-refold vs incremental timings at 1k / 10k /
25k events, in your summary. If keyframes cost more memory than they save
in time at our scale, say so and ship layers 1–2 only — an honest
measurement beats a speculative optimisation.

## Fence (may touch ONLY)

- `packages/web/src/replay/replayFold.ts`, `replayFold.test.ts`
- `packages/web/src/replay/useReplaySession.ts`, `useReplaySession.test.ts`
- `packages/web/src/replay/usePlayback.ts`, `usePlayback.test.ts`

## Blocked by

Nothing (#156 owns replay/Scrubber.tsx and replay/index.tsx — do NOT
touch those two files). **Model:** sonnet. **Wave:** replay-perf.

## Definition of done

- Identity law proven (incremental === full refold, forward and backward);
  timings reported; playback of a 20k-event session does not block the
  main thread.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
