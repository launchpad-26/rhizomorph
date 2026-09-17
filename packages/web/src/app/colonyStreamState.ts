import type { RhizomorphEvent } from '@rhizomorph/core'
import { foldStreamEvents, initialStreamState, type StreamState } from './streamState.js'

/**
 * ONE FOLD PER COLONY — prd-58 ruling 3, wave 0's stream ruling, and the reason
 * the transport question turned out to be smaller than the PRD expected.
 *
 * The operator ruled one stream with a colony tag per frame. That decision was
 * about CONNECTIONS, because the fold layer has to become per-colony either
 * way, and the reading that settles it is in `streamState.ts`:
 * `foldStreamEvents` checks `opensNewSession` **inside** its loop and, on a
 * boundary, resets `events`, `news`, `newsCount` and `session` wholesale. One
 * shared `StreamState` would therefore let a recording rotation in colony A
 * empty colony B's entire window.
 *
 * So the colony is a map key, and each value is exactly the `StreamState` the
 * single-colony client already had. Nothing about the fold itself changes,
 * which is what keeps #166/#183's identity law — batched folding is
 * bit-for-bit identical to folding one at a time — true per colony rather than
 * re-argued.
 *
 * **The ceilings are now per colony**, and that is the cost this transport
 * choice buys. `MAX_EVENTS` (75,000) was chosen against measured 46k–55k-event
 * sessions so a real run would not evict mid-session; N colonies each keeping
 * one means N times that window. Whether 75,000 still holds per colony is a
 * measurement this wave owes and #609 takes.
 */
export interface ColonyStreams {
  /** Keyed by colony id — `repoSlug(repoPath)`, the recorder's own slug. */
  readonly byColony: Readonly<Record<string, StreamState>>
  /**
   * Which colony an untagged frame belongs to.
   *
   * A server that predates the envelope writes a bare event, and
   * `parseStreamFrame` reads it with `colony: null`. That is not an error and
   * must not become a colony called `"null"`: it is a server watching one repo,
   * so its events are this client's pinned colony. The one place that leniency
   * is turned back into a name.
   */
  readonly pinned: string
}

export function initialColonyStreams(pinned: string, connectedAt: number): ColonyStreams {
  return { byColony: { [pinned]: initialStreamState(connectedAt) }, pinned }
}

/**
 * Fold a batch of frames, each into the colony it names.
 *
 * Batched per colony rather than one frame at a time, because
 * `foldStreamEvents` is the O(n) single-pass fold #166 measured and calling it
 * once per frame would reintroduce exactly the per-event cost it was written to
 * remove. Frames are grouped in arrival order, so within a colony the order the
 * fold sees is the order the wire delivered — which is what makes the identity
 * law hold here too.
 */
export function foldColonyFrames(
  state: ColonyStreams,
  frames: readonly { colony: string | null; event: RhizomorphEvent }[],
  connectedAt: number,
): ColonyStreams {
  if (frames.length === 0) return state

  const grouped = new Map<string, RhizomorphEvent[]>()
  for (const frame of frames) {
    // `colony: null` is the untagged case, not a colony of its own.
    const key = frame.colony ?? state.pinned
    const bucket = grouped.get(key)
    if (bucket === undefined) grouped.set(key, [frame.event])
    else bucket.push(frame.event)
  }

  const next: Record<string, StreamState> = { ...state.byColony }
  for (const [colony, events] of grouped) {
    // A colony this client has not seen before gets a fresh fold rather than
    // being dropped: discovery is the server's (#605), and a client that
    // refused an unknown colony would hide the very thing discovery found.
    const before = next[colony] ?? initialStreamState(connectedAt)
    next[colony] = foldStreamEvents(before, events)
  }

  return { byColony: next, pinned: state.pinned }
}

/**
 * The colony the operator is looking at, or the pinned one.
 *
 * Separate from the map on purpose: **which colony is rendered is a view
 * question**, and ruling 1 keeps it away from what is watched and what is
 * recorded. The scene still composes exactly one colony (Success 2), and this
 * is the function that hands it that one.
 */
export function selectedStream(state: ColonyStreams, selected: string | null): StreamState | undefined {
  return state.byColony[selected ?? state.pinned]
}
