import { buildFleet, fixtureHistory, manifestFor, pathologySpec, reduceAll } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { emptyFold, fleetOf, foldFrame, foldFrames } from './stream-fold.js'
import type { SseFrame } from './sse.js'

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0)

function frameOf(event: unknown): SseFrame {
  return { id: null, type: 'message', data: JSON.stringify(event) }
}

/** The staged-pathology fixture — the same one the SPA shows in demo mode, as SSE frames. */
function pathologyFrames() {
  const spec = pathologySpec()
  const events = fixtureHistory(spec, NOW, 7)
  return { events, frames: events.map(frameOf), manifest: manifestFor(spec) }
}

describe('the shell folds what the window folds', () => {
  it('reaches the same fleet the window would build from the same events', () => {
    const { events, frames, manifest } = pathologyFrames()

    const folded = foldFrames(emptyFold(), frames)
    const mine = fleetOf(folded, NOW, manifest)
    const theirs = buildFleet(reduceAll(events), { now: NOW, manifest })

    // Not "looks similar": the same object, because it is the same derivation
    // over the same fold. If this ever drifts, the tray is lying about a fleet
    // the window is drawing correctly.
    expect(mine).toEqual(theirs)
  })

  it('reaches the same LADDER — the thing the badge actually reads', () => {
    const { events, frames, manifest } = pathologyFrames()
    const mine = fleetOf(foldFrames(emptyFold(), frames), NOW, manifest)
    const theirs = buildFleet(reduceAll(events), { now: NOW, manifest })

    expect(mine.rank).toBe(theirs.rank)
    expect(mine.ladder.items.map((item) => item.id)).toEqual(theirs.ladder.items.map((item) => item.id))
    // Guard against a vacuous pass: the staged-pathology fixture is staged, so
    // an empty ladder here would mean the fold did nothing.
    expect(mine.ladder.items.length).toBeGreaterThan(0)
  })

  it('counts every event it folded', () => {
    const { frames } = pathologyFrames()
    const folded = foldFrames(emptyFold(), frames)
    expect(folded.folded).toBe(frames.length)
    expect(folded.unparsed).toBe(0)
  })
})

describe('what the fold refuses, it counts', () => {
  it('counts a frame that is not JSON at all', () => {
    const folded = foldFrame(emptyFold(), { id: null, type: 'message', data: 'not json' })
    expect(folded.unparsed).toBe(1)
    expect(folded.folded).toBe(0)
  })

  it('counts a frame this era does not recognise, and folds nothing from it', () => {
    const folded = foldFrame(emptyFold(), frameOf({ id: 'x', ts: 1, type: 'from.a.later.era', source: 'git', payload: {} }))
    expect(folded.unparsed).toBe(1)
    expect(folded.session.eventCount).toBe(0)
  })

  it('drops exactly what the window drops — both use core\'s strict parse', () => {
    // `useEventStream.ts` calls `parseEvent` and returns early when it fails.
    // A shell that folded leniently would show a badge for events the window
    // never counted.
    const suspect = { id: 'x', ts: 1, type: 'session.started', source: 'git', payload: { nope: true } }
    expect(foldFrame(emptyFold(), frameOf(suspect)).unparsed).toBe(1)
  })
})

describe('a session boundary resets the fold, the way core says', () => {
  it('starts over rather than folding two recordings into one badge', () => {
    const first = fixtureHistory(pathologySpec(), NOW, 1)
    const folded = foldFrames(emptyFold(), first.map(frameOf))
    expect(folded.session.eventCount).toBeGreaterThan(0)

    const boundary = {
      id: 'evt-boundary',
      ts: NOW,
      type: 'session.started',
      source: 'system',
      payload: { sessionId: 'another', repoPath: '/somewhere/else', repoName: 'else' },
    }
    const after = foldFrame(folded, frameOf(boundary))

    expect(after.session.session?.repoPath).toBe('/somewhere/else')
    expect(after.session.eventCount).toBe(1)
    // The counter is the feed's own tally and does NOT reset: it counts what
    // this connection folded, which is a different question from what the
    // current recording contains.
    expect(after.folded).toBe(folded.folded + 1)
  })
})
