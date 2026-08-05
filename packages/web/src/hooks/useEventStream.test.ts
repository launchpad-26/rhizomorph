import { act, renderHook, waitFor } from '@testing-library/react'
import { createEvent, createIdFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { describe, expect, it, vi } from 'vitest'
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
 * Drains whatever the hook queued via `queueMicrotask` — an empty, awaited
 * `act` is what actually flushes a microtask-deferred `setState` (proven by
 * hand: a bare synchronous `act` does not, an awaited async one does, for
 * both `queueMicrotask` and a bare `Promise.resolve().then`). This is also
 * exactly what an existing `await act(async () => { for (...) emit(...) })`
 * caller elsewhere in this package gets for free, which is the whole point —
 * this hook's batching has to be invisible to a caller that never learns
 * about it.
 */
async function flush(): Promise<void> {
  await act(async () => {})
}

describe('useEventStream', () => {
  it('folds a lone arrival immediately, and coalesces anything that lands before the flush drains', async () => {
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

    // Leading edge: nothing already in flight, so a lone arrival folds the
    // instant its own handler returns — no different from before #183.
    act(() => source?.emit(sessionStarted(1)))
    expect(result.current.state).toBe(1)

    // A second arrival lands before the first's flush has actually drained
    // (no await between them) — #183's coalescing means it joins a buffer
    // instead of paying for a `setState` of its own.
    act(() => source?.emit(sessionStarted(2)))
    expect(result.current.state).toBe(1)

    await flush()
    expect(result.current.state).toBe(2)
  })

  it('folds named SSE frames the way the real server sends them', async () => {
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
    expect(result.current.state).toBe(1)

    await flush()

    const branchUpdated = createEvent(
      'branch.updated',
      { branch: 'main', head: 'def456' },
      { id: nextId(), ts: 2 },
    )
    act(() => source?.emitNamed('branch.updated', branchUpdated))
    expect(result.current.state).toBe(2)
  })

  it('ignores malformed payloads instead of throwing', async () => {
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
    act(() => source?.fail())

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.state).toBe(0)
  })

  it('closes the source on unmount', () => {
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
   * fresh session as a burst of `message` events (no `Last-Event-ID` yet,
   * #166) — before this issue, every one of those drove its own `setState`,
   * which is the per-event O(n) copy inside `foldStreamEvent` that starved
   * the frame loop (see this file's `useEventStream` docstring for the
   * measured cost). Now only the burst's first event pays for its own
   * `setState` (the leading edge — what keeps a lone live tick synchronous);
   * everything that lands before that fold has drained joins one buffer and
   * folds together in a single further call — proven here by counting
   * `reduce` calls, not by timing.
   */
  describe('coalescing a burst (#183)', () => {
    it('folds a burst as one eager leading event plus one batched call for the rest', async () => {
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

      act(() => {
        source?.emit(sessionStarted(1))
        source?.emit(sessionStarted(2))
        source?.emit(sessionStarted(3))
      })

      // The first of the three folds eagerly; the other two are still sitting
      // in the buffer, not yet visible.
      expect(reduce).toHaveBeenCalledTimes(1)
      expect(result.current.state).toEqual([1])

      await flush()

      // One more call carries both of the rest — not one call per event.
      expect(reduce).toHaveBeenCalledTimes(2)
      const [, secondBatch] = reduce.mock.calls[1]!
      expect(secondBatch.map((event: RhizomorphEvent) => event.ts)).toEqual([2, 3])
      expect(result.current.state).toEqual([1, 2, 3])
    })

    it('a first-load burst and a later reconnect burst both fold through the same buffer-then-flush path', async () => {
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

      // First load: the whole-session replay burst, all before the flush drains.
      act(() => {
        for (let i = 0; i < 50; i += 1) source?.emit(sessionStarted(i))
      })
      await flush()
      expect(result.current.state).toBe(50)
      expect(reduce).toHaveBeenCalledTimes(2) // 1 eager + 1 batched

      // A reconnect resume burst later — smaller (#166 sends only the
      // backlog), but the identical buffer-then-flush path, not a special case.
      act(() => {
        for (let i = 0; i < 5; i += 1) source?.emit(sessionStarted(100 + i))
      })
      await flush()
      expect(result.current.state).toBe(55)
      expect(reduce).toHaveBeenCalledTimes(4) // 2 more: 1 eager + 1 batched
    })

    it('discards a still-buffered remainder on unmount rather than folding it afterward', async () => {
      let source: FakeEventSource | undefined
      const reduce = vi.fn((count: number, events: readonly unknown[]) => count + events.length)
      const { unmount } = renderHook(() =>
        useEventStream<number>('/api/stream', {
          initialState: 0,
          reduce,
          createSource: (url) => {
            source = new FakeEventSource()
            return source
          },
        }),
      )

      act(() => {
        source?.emit(sessionStarted(1))
        source?.emit(sessionStarted(2))
      })
      // The first folded eagerly; the second is still buffered, unflushed.
      expect(reduce).toHaveBeenCalledTimes(1)

      unmount()
      await flush()

      // The buffered remainder never gets its call — cleanup cleared it.
      expect(reduce).toHaveBeenCalledTimes(1)
    })
  })
})
