import {
  initialSessionState,
  reduceAll,
  type ObservatoryEvent,
  type SessionState,
} from '@observatory/core'

/**
 * The events at or before scrub time T, in fold order. `StreamContext` uses
 * this directly to serve panels the same raw-event shape they read live;
 * `foldUpTo` uses it to produce the folded `SessionState` for the replay
 * controls' own summary line.
 */
export function eventsUpTo(
  events: readonly ObservatoryEvent[],
  ts: number,
): ObservatoryEvent[] {
  return events.filter((event) => event.ts <= ts).sort((a, b) => a.ts - b.ts)
}

/**
 * State at scrub time T: the same core reducer, folding only the events at or
 * before T. Live and replay must never disagree, so this is the only logic
 * replay owns — everything else comes from `reduceAll`.
 */
export function foldUpTo(events: readonly ObservatoryEvent[], ts: number): SessionState {
  return reduceAll(eventsUpTo(events, ts), initialSessionState())
}

export interface TimeRange {
  start: number
  end: number
}

/** The scrubber's bounds — null for a session with no events yet. */
export function timeRangeOf(events: readonly ObservatoryEvent[]): TimeRange | null {
  if (events.length === 0) return null
  let start = events[0]!.ts
  let end = events[0]!.ts
  for (const event of events) {
    if (event.ts < start) start = event.ts
    if (event.ts > end) end = event.ts
  }
  return { start, end }
}
