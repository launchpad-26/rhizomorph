import { useMemo, type ReactElement } from 'react'
import type { RhizomorphEvent } from '@rhizomorph/core'
import { formatClockSeconds } from './duration.js'

/**
 * THE LOUPE (prd21 ruling 2, #273) — the events the recording actually
 * captured at a chosen instant, read verbatim.
 *
 * The dock's mark lane coalesces everything into four glance-fact kinds and
 * stops: a `Chapter` carries `kind`, `ts`, `lane`, `toolName` and nothing else
 * (`chapters.ts`), which is the right shape for a glance and the wrong shape
 * for reading a moment. An operator could see *that* a lane landed at 14:32 and
 * not the commit, the diffstat, the token burst or the trace span the log holds
 * there — all of it preserved verbatim on disk (`docs/record-format.md`) and
 * unreachable through the one surface built to replay it.
 *
 * **The trigger is zoom past the mark lane's cap** (operator ruling,
 * 2026-08-13). Below `usefulMaxZoomLevel` the lane thins marks as it always
 * has; past it, marks stop thinning and events begin appearing. The cap becomes
 * a threshold rather than a stop, so no new control enters the button cluster
 * and prd13 ruling 1 needs no argument. **The cap's own value and the mark
 * lane's coalescing law are untouched** — this is a second, additive reading of
 * the same instant, not a fifth chapter kind.
 *
 * Two laws it holds, both from the ruling:
 *
 * 1. **Append order, never re-sorted (#205).** {@link loupeSlice} chooses
 *    *which* events to show by nearness in `ts`, then hands them back in the
 *    log's own order. Those are two different operations and only the first
 *    one involves time: a loupe that sorted its output by `ts` would show a
 *    different sequence than the fold that produced the state beside it, which
 *    is exactly the disagreement #205 exists to forbid.
 * 2. **It reads; it does not re-summarise.** Every line is `source`, `type` and
 *    the payload the record carries. Nothing here derives a second summary that
 *    could disagree with the fleet object.
 *
 * Two details are **defaults rather than rulings** (the operator ruled the
 * trigger and left these to be seen working first — recorded on #273):
 *
 * - **Neighbourhood is a fixed event count**, not the zoom window and not a
 *   fixed span in ms. Both of those are unbounded in output — a burst inside
 *   the window lists thousands of events — where a count bounds the read-out at
 *   the price of representing a variable amount of time. The span it happens to
 *   cover is printed in the header, so the variable part is stated rather than
 *   hidden.
 * - **Payloads truncate and declare**, reusing the vocabulary `useTranscript`'s
 *   `dropped` already carries, rather than handing heavy ones to the lane
 *   drawer. Keeps one reading act on one surface. Nothing is hidden silently.
 *
 * Either is a small diff to change and neither needs a re-ruling.
 */

/** How many events the loupe reads around the chosen instant. A default, not a ruling — see the module note. */
export const LOUPE_EVENT_COUNT = 20

/** Payload characters rendered before truncate-and-declare. A default, not a ruling. */
export const LOUPE_PAYLOAD_CHARS = 160

export interface LoupeProps {
  /** The raw log, in the record's own append order — never a `ts`-sorted view. */
  events: readonly RhizomorphEvent[]
  /** The instant to read around, normally the playhead. */
  ts: number
  count?: number
}

/**
 * The `count` events nearest `ts`, returned **in the log's own append order**.
 *
 * Selection is by `|event.ts - ts|`, ties broken by the earlier append
 * position, so the choice is deterministic on a log with repeated timestamps
 * (which real recordings have in quantity — a burst shares a millisecond). The
 * returned order is then append order, not distance order and not `ts` order:
 * see law 1 in the module note.
 *
 * Linear in the log with a bounded insert, rather than a sort of the whole
 * thing. At `count` = 20 the inner loop is 20 comparisons worst case and
 * usually none, which matters because prd21 exists to stop the scrub path
 * paying O(log-size) work per frame — replacing one such cost with another
 * would be a poor joke.
 */
export function loupeSlice(
  events: readonly RhizomorphEvent[],
  ts: number,
  count: number = LOUPE_EVENT_COUNT,
): readonly RhizomorphEvent[] {
  if (count <= 0) return []

  /** Sorted by (distance, index) ascending; length never exceeds `count`. */
  const best: { index: number; distance: number }[] = []

  for (let index = 0; index < events.length; index += 1) {
    const distance = Math.abs((events[index] as RhizomorphEvent).ts - ts)
    if (best.length === count && distance >= (best[best.length - 1] as { distance: number }).distance) {
      // Ties at the boundary keep the earlier append position, which is
      // already held: `>=` refuses an equal-distance later event.
      continue
    }
    let at = best.length
    while (at > 0 && (best[at - 1] as { distance: number }).distance > distance) at -= 1
    best.splice(at, 0, { index, distance })
    if (best.length > count) best.pop()
  }

  best.sort((a, b) => a.index - b.index)
  return best.map(({ index }) => events[index] as RhizomorphEvent)
}

/**
 * The payload as the record carries it, cut to a readable length with the cut
 * *stated* — never silently elided. The count is characters because that is the
 * unit being cut; an event's payload has no other natural grain that holds
 * across a diffstat and a token count alike.
 */
export function payloadText(payload: unknown, limit: number = LOUPE_PAYLOAD_CHARS): string {
  let text: string
  try {
    text = JSON.stringify(payload) ?? String(payload)
  } catch {
    // A payload that will not serialise is still a fact the log holds; saying
    // so beats rendering nothing and beats throwing inside a read-out.
    return '(unserialisable payload)'
  }
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}… +${text.length - limit} more characters`
}

export function Loupe({ events, ts, count = LOUPE_EVENT_COUNT }: LoupeProps): ReactElement {
  const slice = useMemo(() => loupeSlice(events, ts, count), [events, ts, count])

  const span =
    slice.length === 0
      ? null
      : { first: Math.min(...slice.map((e) => e.ts)), last: Math.max(...slice.map((e) => e.ts)) }

  return (
    <div
      data-testid="tide-loupe"
      className="col-span-3 mt-1 max-h-40 overflow-y-auto rounded border border-ice-800 bg-ice-950 p-1 normal-case tracking-normal"
    >
      <div className="figures mb-1 text-[10px] leading-none text-ice-400" data-testid="tide-loupe-header">
        {slice.length === 0
          ? `the record at ${formatClockSeconds(ts)} · no events`
          : `the record at ${formatClockSeconds(ts)} · ${slice.length} events · ${formatClockSeconds(span!.first)}–${formatClockSeconds(span!.last)}`}
      </div>
      <ol className="flex flex-col gap-px">
        {slice.map((event, index) => (
          // The log may repeat an id across a re-read; the append position is
          // what is unique here, and it is also the order being asserted.
          <li
            key={`${event.id}-${index}`}
            data-testid="tide-loupe-row"
            className="figures flex gap-2 text-[10px] leading-tight text-ice-100"
          >
            <span className="shrink-0 text-ice-400">{formatClockSeconds(event.ts)}</span>
            <span className="shrink-0 text-ice-300">{event.source}</span>
            <span className="shrink-0">{event.type}</span>
            <span className="min-w-0 break-all text-ice-400">{payloadText(event.payload)}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
