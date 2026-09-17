import { createEvent, type RhizomorphEvent } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { type ColonyStreams, foldColonyFrames, initialColonyStreams, selectedStream } from './colonyStreamState.js'

/**
 * prd-58 wave 0's stream ruling: one stream, a colony tag per frame, one fold
 * per colony.
 *
 * The property that decided the ruling and that a single-colony test cannot
 * see: **a session boundary in one colony must not touch another's window.**
 */

const PINNED = 'main-aaaa1111'
const OTHER = 'other-bbbb2222'
const AT = 1_000_000

let nextId = 0
function evt(type: string, payload: unknown, ts: number): RhizomorphEvent {
  nextId += 1
  return createEvent(type as never, payload as never, { id: `e${nextId}`, ts })
}

/** A `session.started` — what `opensNewSession` reads as a boundary. */
function started(sessionId: string, ts: number): RhizomorphEvent {
  return evt('session.started', { sessionId, repoPath: '/repo', repoName: 'repo' }, ts)
}

function usage(lane: string, ts: number): RhizomorphEvent {
  return evt(
    'llm.usage',
    {
      lane,
      role: 'worker',
      model: 'claude-sonnet-4',
      tokens: { input: 10, output: 20, cacheRead: 0, cacheCreation: 0 },
      sessionId: `sess-${lane}`,
      worktreePath: `/repo-wt/${lane}`,
      branch: lane,
      thread: 'main',
    },
    ts,
  )
}

function frames(...pairs: [string | null, RhizomorphEvent][]) {
  return pairs.map(([colony, event]) => ({ colony, event }))
}

function fold(state: ColonyStreams, ...pairs: [string | null, RhizomorphEvent][]): ColonyStreams {
  return foldColonyFrames(state, frames(...pairs), AT)
}

describe('foldColonyFrames — one fold per colony', () => {
  it('a session boundary in one colony leaves the other byte-identical', () => {
    /**
     * THE CASE THE RULING TURNS ON.
     *
     * `foldStreamEvents` checks `opensNewSession` inside its loop and resets
     * `events`, `news`, `newsCount` and `session` wholesale. A shared
     * `StreamState` would let a rotation here empty the other colony's entire
     * window — and no test that drives one colony can see it, because there is
     * nothing else to lose.
     */
    let state = initialColonyStreams(PINNED, AT)
    state = fold(state, [PINNED, started('s1', AT)], [OTHER, started('t1', AT)])
    state = fold(state, [PINNED, usage('a', AT + 1)], [OTHER, usage('b', AT + 2)], [OTHER, usage('c', AT + 3)])

    const otherBefore = state.byColony[OTHER]
    expect(otherBefore?.events).toHaveLength(3)

    // The pinned colony rotates to a new recording.
    state = fold(state, [PINNED, started('s2', AT + 10)])

    expect(state.byColony[PINNED]?.events).toHaveLength(1)
    expect(state.byColony[PINNED]?.session.session?.sessionId).toBe('s2')
    // And the other colony is untouched — the same object, not merely equal.
    expect(state.byColony[OTHER]).toBe(otherBefore)
  })

  it('events are folded into the colony their frame names, and nowhere else', () => {
    let state = initialColonyStreams(PINNED, AT)
    state = fold(state, [PINNED, started('s1', AT)], [OTHER, started('t1', AT)])
    state = fold(state, [OTHER, usage('b', AT + 1)], [OTHER, usage('c', AT + 2)])

    expect(state.byColony[PINNED]?.events).toHaveLength(1)
    expect(state.byColony[OTHER]?.events).toHaveLength(3)
  })

  it('an UNTAGGED frame folds into the pinned colony, never a colony called null', () => {
    // `parseStreamFrame` reads a bare event from a server that predates the
    // envelope as `colony: null`. That is a server watching one repo, not an
    // unnamed colony, and this is the one place that leniency becomes a name.
    let state = initialColonyStreams(PINNED, AT)
    state = fold(state, [null, started('s1', AT)], [null, usage('a', AT + 1)])

    expect(Object.keys(state.byColony)).toEqual([PINNED])
    expect(state.byColony[PINNED]?.events).toHaveLength(2)
  })

  it('a colony this client has not seen before gets a fold rather than being dropped', () => {
    // Discovery is the server's (#605). A client that refused an unknown colony
    // would hide the very thing discovery found.
    let state = initialColonyStreams(PINNED, AT)
    state = fold(state, [OTHER, started('t1', AT)])

    expect(Object.keys(state.byColony).sort()).toEqual([PINNED, OTHER].sort())
    expect(state.byColony[OTHER]?.events).toHaveLength(1)
  })

  it('folding no frames returns the same state, not a copy', () => {
    const state = initialColonyStreams(PINNED, AT)
    expect(foldColonyFrames(state, [], AT)).toBe(state)
  })

  it('a batch folds identically to the same frames one at a time — per colony', () => {
    // #166/#183's identity law, which has to keep holding now that the batch is
    // split by colony. If grouping reordered within a colony, this would part.
    const batchInput: [string | null, RhizomorphEvent][] = [
      [PINNED, started('s1', AT)],
      [OTHER, started('t1', AT)],
      [PINNED, usage('a', AT + 1)],
      [OTHER, usage('b', AT + 2)],
      [PINNED, usage('c', AT + 3)],
    ]

    const batched = fold(initialColonyStreams(PINNED, AT), ...batchInput)

    let oneByOne = initialColonyStreams(PINNED, AT)
    for (const pair of batchInput) oneByOne = fold(oneByOne, pair)

    expect(batched.byColony[PINNED]?.events).toEqual(oneByOne.byColony[PINNED]?.events)
    expect(batched.byColony[OTHER]?.events).toEqual(oneByOne.byColony[OTHER]?.events)
    expect(batched.byColony[PINNED]?.session).toEqual(oneByOne.byColony[PINNED]?.session)
  })
})

describe('selectedStream — which colony is rendered is a VIEW question', () => {
  it('falls back to the pinned colony when nothing is selected', () => {
    const state = initialColonyStreams(PINNED, AT)
    expect(selectedStream(state, null)).toBe(state.byColony[PINNED])
  })

  it('returns the selected colony when it is one this client holds', () => {
    let state = initialColonyStreams(PINNED, AT)
    state = fold(state, [OTHER, started('t1', AT)])
    expect(selectedStream(state, OTHER)).toBe(state.byColony[OTHER])
  })

  it('returns undefined for a colony this client has never folded — not the pinned one', () => {
    // Silently showing the pinned colony's fleet under another colony's name is
    // the worst available answer: the operator would be reading one repo's
    // lanes believing they are another's.
    const state = initialColonyStreams(PINNED, AT)
    expect(selectedStream(state, 'never-seen-9999')).toBeUndefined()
  })
})
