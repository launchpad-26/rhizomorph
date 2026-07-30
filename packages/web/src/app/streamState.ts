import type { ObservatoryEvent } from '@observatory/core'

/**
 * `core` will own the real session reducer and selectors (architecture.md);
 * until that lands, the shell folds the raw log so the stream hook, layout
 * and stub panels have something real to render against. `StreamContext`
 * is the only place this is wired in, so swapping in the real reducer later
 * is a one-file change.
 */
export interface RawStreamState {
  events: ObservatoryEvent[]
}

export const initialRawStreamState: RawStreamState = { events: [] }

export function foldRawEvents(state: RawStreamState, event: ObservatoryEvent): RawStreamState {
  return { events: [...state.events, event] }
}
