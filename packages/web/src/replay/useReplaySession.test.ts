import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FetchLike } from './api.js'
import { foldUpTo } from './replayFold.js'
import { useReplaySession } from './useReplaySession.js'

describe('useReplaySession', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function jsonResponse(body: unknown): Response {
    return { ok: true, status: 200, json: async () => body } as unknown as Response
  }

  function makeFetch(sessionId: string, events: readonly RhizomorphEvent[]): FetchLike {
    return (async (url: string | URL | Request) => {
      const href = String(url)
      if (href === '/api/sessions') {
        return jsonResponse({
          sessions: [{ id: sessionId, fileName: 'session.jsonl', startedAt: 1000, sizeBytes: 100 }],
        })
      }
      if (href === `/api/sessions/${sessionId}/events`) {
        return jsonResponse({ events })
      }
      throw new Error(`unexpected fetch: ${href}`)
    }) as unknown as FetchLike
  }

  async function renderSelected(sessionId: string, events: readonly RhizomorphEvent[]) {
    // `fetchImpl` must be created once, outside the `renderHook` callback: a
    // fresh function reference every render would retrigger the sessions-fetch
    // effect (keyed on `[fetchImpl]`) on every render, forever.
    const fetchImpl = makeFetch(sessionId, events)
    const utils = renderHook(() => useReplaySession({ fetchImpl }))
    await act(async () => {
      utils.result.current.selectSession(sessionId)
    })
    return utils
  }

  /**
   * Several distinct worktrees/branches/commits over enough events that
   * scrubbing actually moves through interesting state, without needing
   * thousands of events for a hermetic test to stay fast.
   */
  function buildSession(eventCount: number): RhizomorphEvent[] {
    const f = createEventFactory({ stepMs: 1000 })
    const paths = ['/repo/wt-a', '/repo/wt-b', '/repo/wt-c']

    f.sessionStarted()
    for (const path of paths) {
      f.worktreeDiscovered({
        path,
        branch: path.split('/').pop()!,
        head: 'sha-0',
        isMain: path.endsWith('wt-a'),
      })
    }

    for (let i = 0; i < eventCount; i++) {
      const path = paths[i % paths.length]!
      const branch = path.split('/').pop()!
      if (i % 5 === 0) {
        f.commitLanded({ sha: `sha-${i}`, branch, message: `commit ${i}` })
      } else {
        f.worktreeDirty({ path, branch, files: [{ path: `file-${i}.ts`, status: 'modified' }] })
      }
    }

    return f.all()
  }

  /** The prefix `scrubEvents.slice(0, scrubEventCount)` describes — what `eventsAtScrubTime` used to hand back directly. */
  function scrubPrefix(result: { scrubEvents: readonly RhizomorphEvent[]; scrubEventCount: number }) {
    return result.scrubEvents.slice(0, result.scrubEventCount)
  }

  it('has no session and empty state before anything is selected', () => {
    const fetchImpl = makeFetch('s1', [])
    const { result } = renderHook(() => useReplaySession({ fetchImpl }))
    expect(result.current.selectedId).toBeNull()
    expect(result.current.events).toEqual([])
    expect(scrubPrefix(result.current)).toEqual([])
    expect(result.current.isReplaying).toBe(false)
  })

  it('loads a session and folds up to the scrubber position, in fold order', async () => {
    const events = buildSession(20)
    const { result } = await renderSelected('s1', events)

    const targetTs = events[10]!.ts
    await act(async () => {
      result.current.playback.seek(targetTs)
    })

    expect(scrubPrefix(result.current)).toEqual(events.filter((e) => e.ts <= targetTs))
    expect(result.current.state).toEqual(foldUpTo(events, targetTs))
  })

  /**
   * #162: `eventsAtScrubTime` used to be a fresh `.slice()` every tick, which
   * gave `StreamContext`'s memo a new array identity to miss on every scrub —
   * the whole reason it refolded from scratch. `scrubEvents` must keep the
   * same reference across ticks so a downstream memo keyed on it actually
   * memoizes; only `scrubEventCount` (a cheap primitive) should change.
   */
  it('keeps scrubEvents at a stable identity across ticks — only scrubEventCount moves', async () => {
    const events = buildSession(30)
    const { result } = await renderSelected('s1', events)

    const firstScrubEvents = result.current.scrubEvents
    await act(async () => {
      result.current.playback.seek(events[5]!.ts)
    })
    const afterFirstSeek = result.current.scrubEvents
    await act(async () => {
      result.current.playback.seek(events[20]!.ts)
    })
    const afterSecondSeek = result.current.scrubEvents

    expect(afterFirstSeek).toBe(firstScrubEvents)
    expect(afterSecondSeek).toBe(firstScrubEvents)
  })

  /**
   * #160's identity law: whatever caching `useReplaySession` does internally
   * (folding forward from the last tick, or restoring a keyframe on a
   * backward jump), the `state` it hands back must be bit-for-bit what an
   * independent full refold (`foldUpTo`) produces. The scrub sequence below
   * is deterministic (`* 137` over the event count) but visits indices
   * non-monotonically, so it exercises both directions without an RNG.
   */
  it('matches an independent full refold at many scrub points, forward and backward', async () => {
    const events = buildSession(120)
    const { result } = await renderSelected('s1', events)

    for (let i = 0; i < 40; i++) {
      const eventIndex = (i * 137) % events.length
      const ts = events[eventIndex]!.ts
      await act(async () => {
        result.current.playback.seek(ts)
      })
      expect(result.current.state).toEqual(foldUpTo(events, ts))
      expect(scrubPrefix(result.current)).toEqual(events.filter((e) => e.ts <= ts))
    }
  })

  it('scrubbing is exactly reversible: forward, then back, then forward again lands on identical state (#155)', async () => {
    const events = buildSession(80)
    const { result } = await renderSelected('s1', events)

    const tsA = events[10]!.ts
    const tsB = events[60]!.ts

    await act(async () => {
      result.current.playback.seek(tsA)
    })
    const stateAtAFirst = result.current.state

    await act(async () => {
      result.current.playback.seek(tsB)
    })
    expect(result.current.state).toEqual(foldUpTo(events, tsB))

    await act(async () => {
      result.current.playback.seek(tsA)
    })

    expect(result.current.state).toEqual(stateAtAFirst)
    expect(result.current.state).toEqual(foldUpTo(events, tsA))
  })

  it('folds correctly through ordinary forward playback ticks, not just seeks', async () => {
    vi.useFakeTimers()
    const events = buildSession(50)
    const { result } = await renderSelected('s1', events)

    act(() => {
      result.current.playback.play()
    })
    act(() => {
      vi.advanceTimersByTime(1500)
    })

    expect(result.current.state).toEqual(foldUpTo(events, result.current.playback.currentTs))
    expect(scrubPrefix(result.current)).toEqual(
      events.filter((e) => e.ts <= result.current.playback.currentTs),
    )

    act(() => {
      vi.advanceTimersByTime(3000)
    })

    expect(result.current.state).toEqual(foldUpTo(events, result.current.playback.currentTs))
  })

  /**
   * prd17 ruling 3.4 (#205): the fold never re-sorts. A genuinely unsorted
   * (here, fully reversed) append order folds exactly as loaded — the oracle
   * for `state` is `foldUpTo` over that SAME shuffled order, not the
   * properly-ordered `events` the shuffle was built from. `scrubEvents`
   * (the navigation view) is still `ts`-ascending regardless of load order,
   * so its prefix matches the properly-ordered filter either way.
   */
  it('folds a genuinely unsorted event log in its own append order, without silently re-sorting it', async () => {
    const events = buildSession(30)
    const shuffled = [...events].reverse()
    const { result } = await renderSelected('s1', shuffled)

    const ts = events[15]!.ts
    await act(async () => {
      result.current.playback.seek(ts)
    })

    expect(result.current.state).toEqual(foldUpTo(shuffled, ts))
    expect(scrubPrefix(result.current)).toEqual(events.filter((e) => e.ts <= ts))
  })

  it('reselecting a different session resets the fold instead of reusing the old cursor', async () => {
    const eventsA = buildSession(40)
    const eventsB = buildSession(15)

    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url)
      if (href === '/api/sessions') {
        return jsonResponse({
          sessions: [
            { id: 'a', fileName: 'a.jsonl', startedAt: 1000, sizeBytes: 100 },
            { id: 'b', fileName: 'b.jsonl', startedAt: 1000, sizeBytes: 100 },
          ],
        })
      }
      if (href === '/api/sessions/a/events') return jsonResponse({ events: eventsA })
      if (href === '/api/sessions/b/events') return jsonResponse({ events: eventsB })
      throw new Error(`unexpected fetch: ${href}`)
    }) as unknown as FetchLike

    const { result } = renderHook(() => useReplaySession({ fetchImpl }))

    await act(async () => {
      result.current.selectSession('a')
    })
    await act(async () => {
      result.current.playback.seek(eventsA[30]!.ts)
    })
    expect(result.current.state).toEqual(foldUpTo(eventsA, eventsA[30]!.ts))

    await act(async () => {
      result.current.selectSession('b')
    })

    // A fresh session load resets the scrubber to its own range start
    // (`usePlayback`'s reset-on-new-range effect) — the fold must follow it,
    // not go on folding forward from session `a`'s much larger cursor.
    expect(result.current.events).toEqual(eventsB)
    expect(result.current.playback.currentTs).toBe(result.current.range.start)
    expect(result.current.state).toEqual(foldUpTo(eventsB, result.current.range.start))

    const laterTs = eventsB[10]!.ts
    await act(async () => {
      result.current.playback.seek(laterTs)
    })
    expect(result.current.state).toEqual(foldUpTo(eventsB, laterTs))
  })
})
