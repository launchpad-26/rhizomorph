You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

Read #160 and its landed diff FIRST. It fixed half of this exact bug and
its machinery is what you extend — do not build a second one beside it.

YOUR ISSUE — #162:

## Direction

BUG, measured by the conductor 2026-08-04 against the real 46,459-event
dogfooding session. **#160 is closed but the stall the operator feels is
real**, because there are TWO full re-folds and #160 only reached one.

The surviving one is `packages/web/src/app/StreamContext.tsx:116-118`:

```
const replayState = useMemo(
  () => foldStreamEvents(initialStreamState(REPLAY_CONNECTED_AT), replay.eventsAtScrubTime),
  [replay.eventsAtScrubTime],
)
```

`eventsAtScrubTime` is `sessionIndex.events.slice(0, cursor.index)`
(`useReplaySession.ts:129`) — **a new array identity every tick** — so this
memo misses every tick and re-folds the whole prefix from
`initialStreamState`. This is the state that feeds **every panel**. #160's
incremental `foldFrom` feeds only the replay controls' own summary, so the
expensive path was never on its critical path.

Measured (node/tsx over the real log, medians of 5 — the *ratio* is the
finding; absolute ms differ in-browser):

| prefix | slice | full re-fold | per tick | frames dropped @60fps |
|---|---|---|---|---|
| 5,000 | 0.00 ms | 14.83 ms | 14.8 ms | 0.9 |
| 15,000 | 0.01 ms | 83.59 ms | 83.6 ms | 5.0 |
| 30,000 | 0.17 ms | 380.10 ms | 380.3 ms | 22.8 |
| 46,459 | 0.15 ms | 1137.29 ms | **1137.4 ms** | **68.2** |
| incremental (20 crossed) | — | 0.70 ms | 0.70 ms | 0.04 |

Three facts that shape the fix:

1. **The slice is NOT the problem** — 0.15 ms at 46k. Do not "optimise" it.
   The entire cost is the fold. If you find yourself tuning the slice you
   have misread the measurement.
2. **It is superlinear**: 3x the events costs 5.6x the time (5k→15k). It
   degrades faster than sessions grow, and one day of dogfooding is 46k.
3. **It hits playback too**, not only dragging — every playback tick
   advances `currentTs` and triggers the same full re-fold.

Fix direction: give `StreamContext`'s replay fold the same cursor-cache
treatment #160 gave `foldFrom` — fold forward from the last
`(prefixLength, StreamState)` when the prefix grew, fall back to a keyframe
when it shrank (a backward scrub). **Reuse the machinery already in
`replayFold.ts`.** Also kill the identity churn: handing out a fresh array
every tick makes every downstream memo miss — prefer exposing the prefix
length alongside one shared array over a per-tick slice.

Laws that must survive, test-stated:

- Live and replay produce IDENTICAL `StreamState` for the same events —
  assert incremental === full re-fold at many random scrub points,
  **including backward jumps**.
- Scrubbing stays exactly reversible (#155's law).
- No user-visible behaviour change except speed.

**Measure and report** before/after at 5k / 15k / 30k / 46k, in INTERLEAVED
rounds under matched load — #157's lesson: the same code measured 6.6 ms
quiet and 22 ms under sibling load, and a naive comparison invents
regressions it then "fixes".

## Fence (may touch ONLY)

- `packages/web/src/app/StreamContext.tsx`, `packages/web/src/app/StreamContext.test.tsx`
- `packages/web/src/app/streamState.ts`, `packages/web/src/app/streamState.test.ts`
- `packages/web/src/replay/replayFold.ts`, `packages/web/src/replay/replayFold.test.ts`
- `packages/web/src/replay/useReplaySession.ts`, `packages/web/src/replay/useReplaySession.test.ts`

## Blocked by

Nothing. **Model:** sonnet. **Wave:** the defects.

## Definition of done

- Identity law proven forward AND backward; before/after timings reported
  at all four sizes; a 46k-event session scrubs without blocking the main
  thread.
- Root `npm test` + `npm run typecheck` green.
- Say what you would show the operator first.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
