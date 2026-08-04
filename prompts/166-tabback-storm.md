You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

Read #160 AND #162 and their landed diffs FIRST. This is the same pathology a
third time, and their machinery is what you extend — do not build a third fold
beside them.

YOUR ISSUE — #166:

## Direction

BUG, operator-reported 2026-08-05: *"when I move away from the web app, then tab
back in, it replays a bunch of stuff in a really slow laggy way for a bit BEFORE
it becomes usable."* Diagnosed by the conductor from the code; **the worker must
measure before and after.**

**This is the third appearance of one pathology.** #160 fixed the replay
controls' fold. #162 fixed the panel-feeding replay fold. The **live** fold was
never batched — and the batch function already exists, with a docstring
describing this exact scenario.

The chain, all located [Ran]:

1. `packages/server/src/api/stream.ts:13` — *"SSE stream: **replays the session
   so far**, then live-tails."* Every connect replays the WHOLE session. The
   live session is currently ~46,000 events.
2. Tab away → the browser suspends the tab and the SSE connection drops. Tab
   back → `EventSource` reconnects → the server replays all ~46,000 events.
3. `packages/web/src/app/StreamContext.tsx:106` wires the live stream to
   `foldStreamEvent` — the **singular** reducer.
4. `packages/web/src/hooks/useEventStream.ts:61` applies it one event at a time:
   `setState((prev) => reduce(prev, result.event))`.
5. `foldStreamEvent` does `events: [...state.events, event]` — **an O(n) array
   copy per event.** N events cost O(N²), plus N React state updates.

`foldStreamEvents` (plural, same file) exists precisely for this and says so:
*"A replay burst is thousands of events, and folding them one state object at a
time is quadratic in the event array alone — which is exactly the shape such a
burst has."* The live path never used it.

**Two independent levers. Measure each; ship what the numbers justify.**

- **A — batch the burst (client).** Coalesce arriving events into a buffer and
  fold once per animation frame via `foldStreamEvents`, instead of one
  `setState` per event. Turns O(N²) into O(N) and 46,000 renders into a handful.
  This alone should fix the symptom.
- **B — stop re-sending what the client has (server).** SSE has `Last-Event-ID`:
  a reconnecting client can resume from its last delivered id instead of
  replaying from zero. This is the more fundamental fix — the cheapest burst is
  the one never sent — but it is a wire-contract change, so state clearly what
  happens to a client that sends no id (full replay, as today).

Laws that must survive, test-stated:

- **Live and replay remain the same reducer over the same events** — batching
  must not change the resulting state by one field. Assert batched === per-event
  for the same input, including out-of-order and duplicate ids.
- Resume must not drop or duplicate events. If you ship B, prove a reconnect
  with `Last-Event-ID` yields the identical final state to a full replay.
- The instrument stays honest: if a reconnect cannot resume, it must fall back
  to full replay rather than silently showing a partial fold.

**Measure and report** the time from tab-back to interactive, before and after,
at a realistic session size (the live log is ~46k events; use it or a fixture of
that scale). Use interleaved rounds under matched load — #157's lesson: the same
code measured 6.6 ms quiet and 22 ms under sibling load, and a naive comparison
invents regressions it then "fixes".

## Fence (may touch ONLY)

- `packages/web/src/app/StreamContext.tsx`, `packages/web/src/app/StreamContext.test.tsx`
- `packages/web/src/app/streamState.ts`, `packages/web/src/app/streamState.test.ts`
- `packages/web/src/hooks/useEventStream.ts`, `packages/web/src/hooks/useEventStream.test.ts`
- `packages/server/src/api/stream.ts`, `packages/server/src/api/stream.test.ts`

## Blocked by

Nothing. **Model:** sonnet. **Wave:** the small defects.

Sibling lanes own surfaces you must not enter: #164 owns the drawer and Shell's
test; #165 owns the sessionlog collector. If your change appears to need either,
print `BLOCKED: <need>` and stop — the conductor widens fences on the record.

## Definition of done

- Tab away for long enough to drop the connection, tab back: the app is usable
  immediately, with no visible replay storm.
- Batched fold proven identical to per-event fold; if B ships, resume proven
  identical to full replay.
- Before/after timings reported at ~46k events.
- Root `npm test` + `npm run typecheck` green.
- Say what you would show the operator first.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
