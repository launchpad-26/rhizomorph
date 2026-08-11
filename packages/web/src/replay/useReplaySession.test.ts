import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FetchLike } from './api.js'
import { foldUpTo } from './replayFold.js'
import { useReplaySession, type FrameScheduler } from './useReplaySession.js'

/**
 * A hand-driven `requestAnimationFrame` (#269). jsdom has a real one, but it
 * fires on a ~16 ms timer that no `act()` drives, so a coalescer asserted
 * against it would be asserting when this box's scheduler happened to land —
 * the quiet-machine green `CONTRIBUTING.md` warns about. `frame()` is the only
 * thing that advances a frame here, so "one derive per frame" is counted
 * rather than hoped for.
 */
function createFrameDriver() {
  let pending: (() => void) | null = null

  const scheduleFrame: FrameScheduler = (callback) => {
    pending = callback
    return () => {
      if (pending === callback) pending = null
    }
  }

  /** Runs whatever is waiting on the next frame — exactly one frame's worth. */
  function frame() {
    const callback = pending
    pending = null
    if (callback === null) return
    act(() => callback())
  }

  return { scheduleFrame, frame }
}

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
    const driver = createFrameDriver()
    const utils = renderHook(() =>
      useReplaySession({ fetchImpl, scheduleFrame: driver.scheduleFrame }),
    )
    await act(async () => {
      utils.result.current.selectSession(sessionId)
    })
    return { ...utils, frame: driver.frame }
  }

  /**
   * Seek, then let the frame that fold is coalesced onto happen (#269) — what
   * a scrub looks like when the operator is not dragging faster than the
   * screen refreshes. The seek itself is still synchronous either way; the
   * frame is what guarantees the *next* seek is too, whatever this one did to
   * the coalescer's gate.
   */
  async function seekAndSettle(
    utils: { result: { current: { playback: { seek(ts: number): void } } }; frame(): void },
    ts: number,
  ) {
    await act(async () => {
      utils.result.current.playback.seek(ts)
    })
    utils.frame()
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
    const utils = await renderSelected('s1', events)
    const { result } = utils

    const targetTs = events[10]!.ts
    await seekAndSettle(utils, targetTs)

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
    const utils = await renderSelected('s1', events)
    const { result } = utils

    const firstScrubEvents = result.current.scrubEvents
    await seekAndSettle(utils, events[5]!.ts)
    const afterFirstSeek = result.current.scrubEvents
    await seekAndSettle(utils, events[20]!.ts)
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
    const utils = await renderSelected('s1', events)
    const { result } = utils

    for (let i = 0; i < 40; i++) {
      const eventIndex = (i * 137) % events.length
      const ts = events[eventIndex]!.ts
      await seekAndSettle(utils, ts)
      expect(result.current.state).toEqual(foldUpTo(events, ts))
      expect(scrubPrefix(result.current)).toEqual(events.filter((e) => e.ts <= ts))
    }
  })

  it('scrubbing is exactly reversible: forward, then back, then forward again lands on identical state (#155)', async () => {
    const events = buildSession(80)
    const utils = await renderSelected('s1', events)
    const { result } = utils

    const tsA = events[10]!.ts
    const tsB = events[60]!.ts

    await seekAndSettle(utils, tsA)
    const stateAtAFirst = result.current.state

    await seekAndSettle(utils, tsB)
    expect(result.current.state).toEqual(foldUpTo(events, tsB))

    await seekAndSettle(utils, tsA)

    expect(result.current.state).toEqual(stateAtAFirst)
    expect(result.current.state).toEqual(foldUpTo(events, tsA))
  })

  it('folds correctly through ordinary forward playback ticks, not just seeks', async () => {
    vi.useFakeTimers()
    const events = buildSession(50)
    const utils = await renderSelected('s1', events)
    const { result } = utils

    act(() => {
      result.current.playback.play()
    })
    // Fifteen transport ticks land inside this advance; the frame after them
    // folds the position they left behind, exactly as a drag's seeks do.
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    utils.frame()

    expect(result.current.state).toEqual(foldUpTo(events, result.current.playback.currentTs))
    expect(scrubPrefix(result.current)).toEqual(
      events.filter((e) => e.ts <= result.current.playback.currentTs),
    )

    act(() => {
      vi.advanceTimersByTime(3000)
    })
    utils.frame()

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
    const utils = await renderSelected('s1', shuffled)
    const { result } = utils

    const ts = events[15]!.ts
    await seekAndSettle(utils, ts)

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

    const driver = createFrameDriver()
    const { result } = renderHook(() =>
      useReplaySession({ fetchImpl, scheduleFrame: driver.scheduleFrame }),
    )

    await act(async () => {
      result.current.selectSession('a')
    })
    await act(async () => {
      result.current.playback.seek(eventsA[30]!.ts)
    })
    expect(result.current.state).toEqual(foldUpTo(eventsA, eventsA[30]!.ts))

    // Deliberately no `frame()` here: session `b` arrives with `a`'s seek
    // still holding the coalescer's gate shut, and a new recording must fold
    // on the frame it lands anyway — never one frame later than the session it
    // replaced.
    await act(async () => {
      result.current.selectSession('b')
    })

    // A fresh session load resets the scrubber to its own range start
    // (`usePlayback`'s reset-on-new-range effect) — the fold must follow it,
    // not go on folding forward from session `a`'s much larger cursor.
    expect(result.current.events).toEqual(eventsB)
    expect(result.current.playback.currentTs).toBe(result.current.range.start)
    expect(result.current.state).toEqual(foldUpTo(eventsB, result.current.range.start))

    // Still no `frame()`: the first seek into a freshly loaded recording folds
    // on the spot, because the load's own fold was free of the frame budget.
    const laterTs = eventsB[10]!.ts
    await act(async () => {
      result.current.playback.seek(laterTs)
    })
    expect(result.current.state).toEqual(foldUpTo(eventsB, laterTs))
  })
})

/**
 * #269. The live path got animation-frame coalescing in #183; the seek path
 * never did, so a pointer drag — up to ~120 `onChange`s a second onto a screen
 * that can show 60 — refolded and handed every consumer a fresh `state`
 * identity that many times, each one a full `buildFleet` rebuild, React commit
 * and canvas repaint.
 *
 * Counted here, not eyeballed, and counted against frames this test drives
 * itself: jsdom's own `requestAnimationFrame` has no frame cadence to assert
 * against (see `createFrameDriver`).
 */
describe('useReplaySession — seek coalescing (#269)', () => {
  /** A recording the size the issue's measurement used. */
  const DRAG_SESSION_EVENTS = 25_000

  function jsonResponse(body: unknown): Response {
    return { ok: true, status: 200, json: async () => body } as unknown as Response
  }

  function dragFetch(events: readonly RhizomorphEvent[]): FetchLike {
    return (async (url: string | URL | Request) => {
      const href = String(url)
      if (href === '/api/sessions') {
        return jsonResponse({
          sessions: [{ id: 'drag', fileName: 'drag.jsonl', startedAt: 1000, sizeBytes: 100 }],
        })
      }
      if (href === '/api/sessions/drag/events') return jsonResponse({ events })
      throw new Error(`unexpected fetch: ${href}`)
    }) as unknown as FetchLike
  }

  /**
   * Three worktrees taking turns, a commit every hundredth event.
   *
   * That rate is deliberate and worth not "fixing" back to `buildSession`'s
   * every-fifth: the fold keeps a per-branch commit list, so each landed
   * commit makes every later fold step copy a longer array — quadratic in
   * commits, not in events. Measured here, `buildSessionIndex` over 25,000
   * events costs 5 ms with no commits in the log, 3.3 s with 5,000 of them.
   * 250 commits across a 25,000-event session is both realistic and cheap,
   * which is what lets this test carry the issue's own recording size without
   * spending seconds on the fixture before the first seek. (The quadratic
   * itself is real and is `replayFold.ts`'s to answer for, not this issue's.)
   */
  function dragSession(eventCount: number): RhizomorphEvent[] {
    const f = createEventFactory({ stepMs: 100 })
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
      if (i % 100 === 0) {
        f.commitLanded({ sha: `sha-${i}`, branch, message: `commit ${i}` })
      } else {
        f.worktreeDirty({ path, branch, files: [{ path: `file-${i}.ts`, status: 'modified' }] })
      }
    }
    return f.all()
  }

  /**
   * Renders the hook with a counted derive: every time `state`'s identity
   * changes, something downstream (`StreamContext`'s `replayState`,
   * `FleetContext`'s `buildFleet`) rebuilds off it. That count IS the cost
   * this issue is about.
   */
  async function renderDrag(events: readonly RhizomorphEvent[]) {
    const fetchImpl = dragFetch(events)
    const driver = createFrameDriver()
    const counts = { derives: 0 }
    let lastState: unknown = null

    const utils = renderHook(() => {
      const session = useReplaySession({ fetchImpl, scheduleFrame: driver.scheduleFrame })
      if (session.state !== lastState) {
        lastState = session.state
        counts.derives++
      }
      return session
    })

    await act(async () => {
      utils.result.current.selectSession('drag')
    })
    // The load's own fold is not what is being counted.
    counts.derives = 0
    return { ...utils, frame: driver.frame, counts }
  }

  /**
   * The issue's own recording size. The assertions lean on `scrubEventCount`
   * rather than a second full `foldUpTo` refold, which at this size would cost
   * more than everything else in this file put together — the
   * fold-matches-an-independent-refold law is asserted above, at sizes where
   * that oracle is cheap. What needs 25,000 events here is only the claim the
   * issue makes: that a drag over a recording this size derives once per frame.
   */
  it('folds at most once per animation frame across a drag, however many seeks land in one', async () => {
    const events = dragSession(DRAG_SESSION_EVENTS)
    const { result, frame, counts } = await renderDrag(events)

    const { start, end } = result.current.range
    const FRAMES = 12
    const SEEKS_PER_FRAME = 10

    for (let f = 0; f < FRAMES; f++) {
      for (let i = 0; i < SEEKS_PER_FRAME; i++) {
        const progress = (f * SEEKS_PER_FRAME + i + 1) / (FRAMES * SEEKS_PER_FRAME)
        act(() => {
          result.current.playback.seek(start + progress * (end - start))
        })
      }
      frame()
    }

    // One fold per frame, plus the drag's single leading edge — the first seek
    // of a burst folds on the spot (a lone click or arrow key must never wait
    // for a frame), and every one after it inside the same frame is coalesced.
    // Without this, the number below is 120: one per seek.
    expect(counts.derives).toBe(FRAMES + 1)
    // …and the position it settled on is the last one the finger asked for,
    // folded through to the end of the log — a coalesced drag drops nothing.
    expect(result.current.derivedTs).toBe(end)
    expect(result.current.derivedTs).toBe(result.current.playback.currentTs)
    expect(result.current.scrubEventCount).toBe(events.length)
  })

  it('never makes the thumb wait for the fold: currentTs moves on every seek', async () => {
    const events = dragSession(200)
    const { result, counts } = await renderDrag(events)
    const { start, end } = result.current.range

    // A whole frame's worth of seeks with no frame in between — the fold is
    // pinned to the first of them, the scrubber's own value is not.
    const positions: number[] = []
    for (let i = 1; i <= 8; i++) {
      const ts = start + (i / 8) * (end - start)
      act(() => {
        result.current.playback.seek(ts)
      })
      positions.push(result.current.playback.currentTs)
      expect(result.current.playback.currentTs).toBe(ts)
    }

    expect(positions).toHaveLength(8)
    expect(counts.derives).toBe(1)
    expect(result.current.derivedTs).toBe(positions[0])
  })

  it('folds a seek in isolation immediately, without waiting for a frame', async () => {
    const events = dragSession(200)
    const { result, frame, counts } = await renderDrag(events)
    const target = events[100]!.ts

    await act(async () => {
      result.current.playback.seek(target)
    })

    // No `frame()` yet: a click on the track, an arrow key, a jump to a chapter
    // marker — one seek at a time is visible the instant its handler returns.
    expect(counts.derives).toBe(1)
    expect(result.current.state).toEqual(foldUpTo(events, target))
    expect(result.current.derivedTs).toBe(target)

    // The frame after it has nothing to coalesce and must derive nothing.
    frame()
    expect(counts.derives).toBe(1)
  })

  it('folds the last seek of a drag, even though the frame it landed in was already spent', async () => {
    const events = dragSession(400)
    const { result, frame, counts } = await renderDrag(events)
    const first = events[100]!.ts
    const last = events[300]!.ts

    act(() => {
      result.current.playback.seek(first)
    })
    act(() => {
      result.current.playback.seek(last)
    })
    // The pointer went up here — nothing will seek again to carry the tail
    // forward, so the frame has to.
    expect(result.current.state).toEqual(foldUpTo(events, first))

    frame()

    expect(counts.derives).toBe(2)
    expect(result.current.state).toEqual(foldUpTo(events, last))
    expect(result.current.derivedTs).toBe(last)
  })

  /**
   * Switching recordings mid-drag leaves a seek coalesced with a frame armed to
   * fold it, and the coalescer's reset cancels that frame. Usually the
   * transport re-bases `currentTs` onto the new range a commit later and the
   * free fold lands there — but that reset is keyed on `[start, end]`, so two
   * recordings spanning the identical range never re-base, and the position the
   * finger last asked for was left unfolded until the operator touched the
   * scrubber again: the thumb at one instant, the fleet reading another. Both
   * sessions below deliberately span the same range, which is the only shape
   * that reaches it.
   */
  it('adopts the scrub position when a recording is switched mid-drag, rather than stranding it', async () => {
    const sameRange = (branch: string, prefix: string) => {
      const f = createEventFactory({ stepMs: 1000, idPrefix: prefix })
      f.sessionStarted()
      f.worktreeDiscovered({ path: `/repo/${branch}`, branch, head: 'sha-0', isMain: true })
      for (let i = 0; i < 40; i++) {
        f.worktreeDirty({
          path: `/repo/${branch}`,
          branch,
          files: [{ path: `file-${i}.ts`, status: 'modified' }],
        })
      }
      return f.all()
    }
    const eventsA = sameRange('alpha', 'a')
    const eventsB = sameRange('beta', 'b')
    expect(eventsB.at(-1)!.ts).toBe(eventsA.at(-1)!.ts)

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

    const driver = createFrameDriver()
    const { result } = renderHook(() =>
      useReplaySession({ fetchImpl, scheduleFrame: driver.scheduleFrame }),
    )
    await act(async () => {
      result.current.selectSession('a')
    })

    // Mid-drag: the first seek folds on the spot and shuts the gate, the second
    // is left coalesced onto a frame that is never going to run.
    act(() => {
      result.current.playback.seek(eventsA[10]!.ts)
    })
    act(() => {
      result.current.playback.seek(eventsA[20]!.ts)
    })
    expect(result.current.derivedTs).toBe(eventsA[10]!.ts)

    await act(async () => {
      result.current.selectSession('b')
    })

    // The new recording is read at the position the scrubber is actually at,
    // and it is session `b` being read there.
    expect(result.current.derivedTs).toBe(result.current.playback.currentTs)
    expect(result.current.state).toEqual(foldUpTo(eventsB, result.current.playback.currentTs))

    // …and the exemption was not spent getting there: the first seek into the
    // new recording still lands without waiting for a frame.
    const target = eventsB[8]!.ts
    await act(async () => {
      result.current.playback.seek(target)
    })
    expect(result.current.derivedTs).toBe(target)
    expect(result.current.state).toEqual(foldUpTo(eventsB, target))
  })

  it('uses the browser\'s own frames when no scheduler is injected', async () => {
    const events = dragSession(200)
    const fetchImpl = dragFetch(events)
    const { result } = renderHook(() => useReplaySession({ fetchImpl }))

    await act(async () => {
      result.current.selectSession('drag')
    })
    await act(async () => {})

    const first = events[50]!.ts
    const last = events[150]!.ts
    act(() => {
      result.current.playback.seek(first)
    })
    act(() => {
      result.current.playback.seek(last)
    })

    // Deliberately not asserting *when* — only that the default
    // `requestAnimationFrame` path arms and flushes at all, so the coalescer
    // cannot silently strand a scrub position outside a test's fake scheduler.
    await waitFor(() => {
      expect(result.current.derivedTs).toBe(last)
    })
    expect(result.current.state).toEqual(foldUpTo(events, last))
  })
})
