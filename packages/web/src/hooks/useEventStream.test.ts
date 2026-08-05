import { act, renderHook, waitFor } from '@testing-library/react'
import { createEvent, createIdFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEventStream, type EventSourceLike } from './useEventStream.js'

type MessageListener = (event: MessageEvent<string>) => void

/**
 * Mirrors real `EventSource` framing: `emit` drives unnamed frames (the
 * default `message` type) through `onmessage`, while `emitNamed` drives named
 * frames (`event: <type>`) through listeners registered via
 * `addEventListener` — exactly like the server, which names every frame.
 */
class FakeEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  closed = false
  private listeners = new Map<string, Set<MessageListener>>()

  addEventListener(type: string, listener: MessageListener) {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type: string, listener: MessageListener) {
    this.listeners.get(type)?.delete(listener)
  }

  open() {
    this.onopen?.(new Event('open'))
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>)
  }

  emitNamed(type: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }

  fail() {
    this.onerror?.(new Event('error'))
  }

  close() {
    this.closed = true
  }
}

const nextId = createIdFactory('evt')

function sessionStarted(ts: number) {
  return createEvent(
    'session.started',
    { sessionId: 's1', repoPath: '/repo', repoName: 'repo', mainBranch: 'main' },
    { id: nextId(), ts },
  )
}

/**
 * Stubs `requestAnimationFrame`/`cancelAnimationFrame` with a manually-driven
 * queue (same technique as `scene/SceneView.test.tsx`'s `mountFlying`) so a
 * frame fires exactly when the test says so, rather than racing jsdom's real
 * ~16ms timer-backed implementation.
 */
function stubFrames() {
  let nextFrameId = 1
  const pending = new Map<number, FrameRequestCallback>()

  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrameId
    nextFrameId += 1
    pending.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    pending.delete(id)
  })

  return {
    /** Fires every frame currently queued, as one real animation frame would. */
    draw: () => {
      const callbacks = [...pending.values()]
      pending.clear()
      for (const callback of callbacks) act(() => callback(0))
    },
    pendingFrames: () => pending.size,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useEventStream', () => {
  it('starts connecting, then folds validated events once the frame flushes', () => {
    const { draw } = stubFrames()
    let source: FakeEventSource | undefined
    const { result } = renderHook(() =>
      useEventStream<number>('/api/stream', {
        initialState: 0,
        reduce: (count, events) => count + events.length,
        createSource: (url) => {
          source = new FakeEventSource()
          expect(url).toBe('/api/stream')
          return source
        },
      }),
    )

    expect(result.current.status).toBe('connecting')
    expect(result.current.state).toBe(0)

    act(() => source?.open())
    expect(result.current.status).toBe('open')

    act(() => source?.emit(sessionStarted(1)))
    // Buffered, not applied yet: the fold is deferred to the next frame.
    expect(result.current.state).toBe(0)
    draw()
    expect(result.current.state).toBe(1)

    act(() => source?.emit(sessionStarted(2)))
    draw()
    expect(result.current.state).toBe(2)
  })

  it('folds named SSE frames the way the real server sends them', () => {
    const { draw } = stubFrames()
    let source: FakeEventSource | undefined
    const { result } = renderHook(() =>
      useEventStream<number>('/api/stream', {
        initialState: 0,
        reduce: (count, events) => count + events.length,
        createSource: (url) => {
          source = new FakeEventSource()
          return source
        },
      }),
    )

    const worktreeDiscovered = createEvent(
      'worktree.discovered',
      { path: '/repo', branch: 'main', head: 'abc123', isMain: true },
      { id: nextId(), ts: 1 },
    )

    act(() => source?.emitNamed('worktree.discovered', worktreeDiscovered))
    draw()
    expect(result.current.state).toBe(1)

    const branchUpdated = createEvent(
      'branch.updated',
      { branch: 'main', head: 'def456' },
      { id: nextId(), ts: 2 },
    )

    act(() => source?.emitNamed('branch.updated', branchUpdated))
    draw()
    expect(result.current.state).toBe(2)
  })

  it('ignores malformed payloads instead of throwing', async () => {
    const { draw } = stubFrames()
    let source: FakeEventSource | undefined
    const { result } = renderHook(() =>
      useEventStream<number>('/api/stream', {
        initialState: 0,
        reduce: (count, events) => count + events.length,
        createSource: (url) => {
          source = new FakeEventSource()
          return source
        },
      }),
    )

    act(() => source?.emit({ type: 'not-a-real-event' }))
    draw()
    act(() => source?.fail())

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.state).toBe(0)
  })

  it('closes the source on unmount', () => {
    stubFrames()
    let source: FakeEventSource | undefined
    const { unmount } = renderHook(() =>
      useEventStream<number>('/api/stream', {
        initialState: 0,
        reduce: (count, events) => count + events.length,
        createSource: (url) => {
          source = new FakeEventSource()
          return source
        },
      }),
    )

    unmount()
    expect(source?.closed).toBe(true)
  })

  /**
   * #183: the fix itself, stated as hook behaviour. `/api/stream` replays a
   * fresh session as a synchronous burst of `message` events (no
   * `Last-Event-ID` yet, #166) — before this issue, every one of those drove
   * its own `setState`, which is the per-event O(n) copy inside
   * `foldStreamEvent` that starved the frame loop (see this file's `useEventStream`
   * docstring for the measured cost). Now they land in a buffer and fold once,
   * on the next frame — proven here by counting `reduce` calls, not by timing.
   */
  describe('coalescing a burst (#183)', () => {
    it('buffers every event that arrives before a frame and folds them in one reduce call', () => {
      const { draw, pendingFrames } = stubFrames()
      let source: FakeEventSource | undefined
      const reduce = vi.fn((state: number[], events: readonly RhizomorphEvent[]) => [
        ...state,
        ...events.map((event) => event.ts),
      ])
      const { result } = renderHook(() =>
        useEventStream<number[]>('/api/stream', {
          initialState: [],
          reduce,
          createSource: (url) => {
            source = new FakeEventSource()
            return source
          },
        }),
      )

      expect(pendingFrames()).toBe(0)

      act(() => {
        source?.emit(sessionStarted(1))
        source?.emit(sessionStarted(2))
        source?.emit(sessionStarted(3))
      })

      // Three arrivals, one scheduled frame — not three.
      expect(pendingFrames()).toBe(1)
      expect(reduce).not.toHaveBeenCalled()

      draw()

      expect(reduce).toHaveBeenCalledTimes(1)
      const [, batch] = reduce.mock.calls[0]!
      expect(batch.map((event) => event.ts)).toEqual([1, 2, 3])
      expect(result.current.state).toEqual([1, 2, 3])
    })

    it('a first-load burst and a later reconnect burst both fold through the same one-frame batch', () => {
      const { draw } = stubFrames()
      let source: FakeEventSource | undefined
      const reduce = vi.fn((count: number, events: readonly unknown[]) => count + events.length)
      const { result } = renderHook(() =>
        useEventStream<number>('/api/stream', {
          initialState: 0,
          reduce,
          createSource: (url) => {
            source = new FakeEventSource()
            return source
          },
        }),
      )

      // First load: the whole-session replay burst, all before the first frame.
      act(() => {
        for (let i = 0; i < 50; i += 1) source?.emit(sessionStarted(i))
      })
      draw()
      expect(result.current.state).toBe(50)
      expect(reduce).toHaveBeenCalledTimes(1)

      // A reconnect resume burst later — smaller (#166 sends only the
      // backlog), but the identical buffer-then-flush path, not a special case.
      act(() => {
        for (let i = 0; i < 5; i += 1) source?.emit(sessionStarted(100 + i))
      })
      draw()
      expect(result.current.state).toBe(55)
      expect(reduce).toHaveBeenCalledTimes(2)
    })

    it('does not flush a stray frame after unmount', () => {
      const { pendingFrames } = stubFrames()
      let source: FakeEventSource | undefined
      const { unmount } = renderHook(() =>
        useEventStream<number>('/api/stream', {
          initialState: 0,
          reduce: (count, events) => count + events.length,
          createSource: (url) => {
            source = new FakeEventSource()
            return source
          },
        }),
      )

      act(() => source?.emit(sessionStarted(1)))
      expect(pendingFrames()).toBe(1)

      unmount()

      expect(pendingFrames()).toBe(0)
    })
  })
})
