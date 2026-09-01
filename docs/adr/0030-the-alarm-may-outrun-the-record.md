# 0030. The alarm may outrun the record

- **Status:** accepted
- **Date:** 2026-08-26

## Context and Problem Statement

prd-40 ruling 1 put the append ahead of publication: `SessionRecorder.record`
awaits `SessionLogWriter.append` before it pushes to the buffer, advances the
fold or emits to subscribers. Success 1 states the property that buys — "an
event that reaches a subscriber has reached the log".

That ordering silences the one event whose whole job is to report that the log
cannot be written. On a full disk a collector's append fails, the poll loop
builds a `collector.error` to say so, and that alarm's own append fails too —
so under ruling 1 it reaches no subscriber. The dashboard goes on looking
healthy while nothing is being recorded. `console.error` is the only remaining
channel, and `api/lab.ts:484-488` replaces `process.stderr.write` process-wide
for the duration of a lab fork.

prd-40 success 1 already carves this out in words. This record fixes the
mechanism, and states the cost.

## Considered Options

1. **A type-narrowed `recordAlarm` on the recorder** that appends if it can and
   emits either way.
2. **Make the emitter public**, and let the poll loop publish directly.
3. **A boolean option on `record()`** — `record(event, { publishEvenIfAppendFails: true })`.
4. **Retry the append** before giving up.
5. **Do nothing** — keep `console.error` as the only degrade channel.

## Decision Outcome

**Option 1.** `recordAlarm(event: EventOf<'collector.error'>)` appends when it
can, emits unconditionally, and returns whether the append landed.

The narrowing is the point. prd-40 success 1 requires the exemption to be
"asserted **by name** in the law rather than inferred from a category", and a
parameter typed `EventOf<'collector.error'>` makes that a compile-time
property: no collector-derived event can reach the method at all.

Option 2 loses because a public emitter lets *anything* publish an unappended
event — the exemption is for one type on one path, and a public emitter cannot
express that. Option 3 loses for the same reason one level down: a boolean at
the call site is a claim any caller can make, and a law asserting "by name"
would have to inspect call sites rather than types. Option 4 loses because a
full disk does not empty while the loop waits, and an unbounded retry parks the
poll loop in exactly the condition it is trying to report. Option 5 loses
because it is the current behaviour and it fails prd-40 success 2.

**The exemption is for emission only.** Success 1 also forbids leaving "the
fold ahead of the file after a rejected append", and that clause is *not*
carved out — so on a failed append the alarm enters neither `buffer` nor
`foldState`. `eventsSoFar()` and `foldSoFar()` remain exactly as honest as the
file. Only subscribers hear it.

## Consequences

- **A live stream may now contain a `collector.error` that a replay of the same
  session does not.** This is the converse of [ADR-0029](0029-a-recording-may-repeat-a-fact.md),
  which permitted the record to hold a fact twice; this permits the stream to
  hold a fact the record never got. Anyone diffing a live session against its
  replay must expect this event type to differ, and only this one.
- **The durability boundary now has a named hole**, and it will be reached for
  again. The type narrowing is what keeps it from widening: extending it to
  another event means changing the signature, which is a visible act.
- Because nothing enters `buffer` or `foldState` on a failed append, the
  in-memory fold cannot be used to prove the alarm fired. **The proof is the
  subscriber**, which is what the laws assert.
- A throwing subscriber can no longer silence the alarm, but the alarm now
  swallows that subscriber's error into `console.error` rather than surfacing
  it — the same trade `closeWith` already makes.
