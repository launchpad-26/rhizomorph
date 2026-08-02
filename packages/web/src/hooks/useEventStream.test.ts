import { act, renderHook, waitFor } from '@testing-library/react'
import { createEvent, createIdFactory } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
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

describe('useEventStream', () => {
  it('starts connecting, then folds validated events as they arrive', async () => {
    let source: FakeEventSource | undefined
    const { result } = renderHook(() =>
      useEventStream<number>('/api/stream', {
        initialState: 0,
        reduce: (count) => count + 1,
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
    await waitFor(() => expect(result.current.status).toBe('open'))

    act(() => source?.emit(sessionStarted(1)))
    await waitFor(() => expect(result.current.state).toBe(1))

    act(() => source?.emit(sessionStarted(2)))
    await waitFor(() => expect(result.current.state).toBe(2))
  })

  it('folds named SSE frames the way the real server sends them', async () => {
    let source: FakeEventSource | undefined
    const { result } = renderHook(() =>
      useEventStream<number>('/api/stream', {
        initialState: 0,
        reduce: (count) => count + 1,
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
    await waitFor(() => expect(result.current.state).toBe(1))

    const branchUpdated = createEvent(
      'branch.updated',
      { branch: 'main', head: 'def456' },
      { id: nextId(), ts: 2 },
    )

    act(() => source?.emitNamed('branch.updated', branchUpdated))
    await waitFor(() => expect(result.current.state).toBe(2))
  })

  it('ignores malformed payloads instead of throwing', async () => {
    let source: FakeEventSource | undefined
    const { result } = renderHook(() =>
      useEventStream<number>('/api/stream', {
        initialState: 0,
        reduce: (count) => count + 1,
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
        reduce: (count) => count + 1,
        createSource: (url) => {
          source = new FakeEventSource()
          return source
        },
      }),
    )

    unmount()
    expect(source?.closed).toBe(true)
  })
})
