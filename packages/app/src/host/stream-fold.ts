import {
  buildFleet,
  initialSessionState,
  opensNewSession,
  parseEvent,
  reduce,
  type Fleet,
  type LaneManifest,
  type SessionState,
} from '@rhizomorph/core'
import type { SseFrame } from './sse.js'

/**
 * THE SAME FOLD THE WINDOW PERFORMS (#564; ruling 8's "the badge and the
 * notifications never disagree with the instrument — both read the same derived
 * fleet").
 *
 * Every function that decides anything here is imported from
 * `@rhizomorph/core`: `parseEvent` validates the frame exactly as
 * `hooks/useEventStream.ts` does — strictly, dropping what this era's union
 * does not recognise, so the shell and the window drop the same events —
 * `opensNewSession` and `reduce` fold it exactly as `app/streamState.ts` does,
 * and `buildFleet` derives the ladder exactly as `fleet/FleetContext.tsx` does.
 * **A second implementation of any of them is how a tray starts lying**, which
 * is why `no-fork.ts` permits importing core and nothing else.
 *
 * What the window keeps and this does not: the raw event window, the news
 * queue, and the connection instant. Those exist for surfaces — the feed panel,
 * the scene's flares, the events-window label — and the shell has no surfaces.
 * Keeping them here would be carrying a copy of `StreamState` for nobody.
 */

/** The shell's whole model of the stream: one folded session. */
export interface FoldedStream {
  session: SessionState
  /** Events folded since this feed opened. The honest denominator for "nothing has arrived". */
  folded: number
  /**
   * Frames this era could not parse. Never silently zero: a shell that quietly
   * dropped half the log would show a calm tray over a fleet on fire, and a
   * count is the cheapest way for that to be visible rather than invisible.
   */
  unparsed: number
}

export function emptyFold(): FoldedStream {
  return { session: initialSessionState(), folded: 0, unparsed: 0 }
}

/** One frame, folded. A frame that is not an event of this era increments `unparsed` and changes nothing else. */
export function foldFrame(current: FoldedStream, frame: SseFrame): FoldedStream {
  let value: unknown
  try {
    value = JSON.parse(frame.data)
  } catch {
    return { ...current, unparsed: current.unparsed + 1 }
  }

  const parsed = parseEvent(value)
  if (!parsed.ok) return { ...current, unparsed: current.unparsed + 1 }

  // The session-boundary reset is core's own question, asked the same way
  // `foldStreamEvents` asks it: a rotation (#592) or a retarget (#390) starts a
  // new recording, and folding the new one onto the old would leave the badge
  // describing two sessions at once.
  const session = opensNewSession(current.session, parsed.event)
    ? reduce(initialSessionState(), parsed.event)
    : reduce(current.session, parsed.event)

  return { session, folded: current.folded + 1, unparsed: current.unparsed }
}

export function foldFrames(current: FoldedStream, frames: readonly SseFrame[]): FoldedStream {
  return frames.reduce(foldFrame, current)
}

/** The derived fleet, built the one way the window builds it. */
export function fleetOf(fold: FoldedStream, now: number, manifest: LaneManifest | null): Fleet {
  return buildFleet(fold.session, { now, manifest })
}
