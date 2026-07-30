import { act, renderHook, waitFor } from '@testing-library/react'
import { createEvent, createIdFactory } from '@observatory/core'
import { describe, expect, it } from 'vitest'
import { useEventStream, type EventSourceLike } from './useEventStream.js'

class FakeEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  closed = false

  open() {
    this.onopen?.(new Event('open'))
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>)
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
