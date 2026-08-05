import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { FetchLike } from '../fleet/manifest.js'
import {
  IDLE_TRANSCRIPT,
  foldChunk,
  foldEarlierChunk,
  transcriptBeforeUrl,
  transcriptTailUrl,
  transcriptUrl,
  useTranscript,
  type TranscriptEntry,
} from './useTranscript.js'

afterEach(cleanup)

/**
 * The tail-first open (#134). `Conversation.test.tsx` exercises the hook
 * again through the component, but the eager catch-up burst and the "load
 * earlier" cursor are properties of the hook itself — proven here directly,
 * via `renderHook`, with no DOM in the way (this file has no `.tsx` sibling
 * fence entry, so it stays JSX-free).
 */

/** A turn, in the wire shape the endpoint actually sends. */
function said(role: TranscriptEntry['role'], text: string): TranscriptEntry {
  return { role, blocks: [{ kind: 'text', text }] }
}

function chunk(entries: TranscriptEntry[], nextOffset: number, extra: Record<string, unknown> = {}) {
  return {
    available: true,
    lane: '84-chat-drawer',
    sessionId: 'sess-84',
    offset: 0,
    nextOffset,
    size: nextOffset,
    eof: true,
    restarted: false,
    entries,
    ...extra,
  }
}

/** A fetch that serves a scripted list of bodies, one per call, and records the URLs asked for. */
function scriptedFetch(bodies: unknown[]): FetchLike & { urls: string[] } {
  const urls: string[] = []
  let call = 0
  const impl = (async (input: string) => {
    urls.push(input)
    const body = bodies[Math.min(call, bodies.length - 1)]
    call += 1
    return {
      ok: (body as { available?: boolean })?.available !== false,
      json: async () => body,
    }
  }) as FetchLike & { urls: string[] }
  impl.urls = urls
  return impl
}

function textOf(entry: TranscriptEntry | undefined): string {
  const block = entry?.blocks[0]
  return block !== undefined && 'text' in block ? block.text : ''
}

describe('transcriptTailUrl / transcriptBeforeUrl', () => {
  it('the tail-open is a GET carrying only the lane', () => {
    expect(transcriptTailUrl('84-chat-drawer')).toBe('/api/transcript/84-chat-drawer?tail=1')
  })

  it('encodes a lane name that would otherwise break the path', () => {
    expect(transcriptTailUrl('feature/84')).toBe('/api/transcript/feature%2F84?tail=1')
  })

  it('"load earlier" is a GET carrying the lane and the offset to page before', () => {
    expect(transcriptBeforeUrl('84-chat-drawer', 700)).toBe('/api/transcript/84-chat-drawer?before=700')
  })
})

describe('foldChunk — tracking the loaded window\'s earliest edge (#134)', () => {
  it('takes the first chunk\'s own offset as the earliest edge, tail-opened or not', () => {
    const state = foldChunk(IDLE_TRANSCRIPT, chunk([said('assistant', 'newest')], 900, { offset: 700 }))

    expect(state.earliestOffset).toBe(700)
  })

  it('does not move the earliest edge when a later forward page lands', () => {
    const first = foldChunk(IDLE_TRANSCRIPT, chunk([said('assistant', 'newest')], 900, { offset: 700 }))
    const second = foldChunk(first, chunk([said('assistant', 'even newer')], 950, { offset: 900 }))

    expect(second.earliestOffset).toBe(700)
    expect(second.entries).toEqual([said('assistant', 'newest'), said('assistant', 'even newer')])
  })

  it('resets the earliest edge to the new window\'s own offset on a restart', () => {
    const first = foldChunk(IDLE_TRANSCRIPT, chunk([said('user', 'old session')], 900, { offset: 700 }))
    const second = foldChunk(first, chunk([said('user', 'new session')], 12, { offset: 0, restarted: true }))

    expect(second.earliestOffset).toBe(0)
    expect(second.entries).toEqual([said('user', 'new session')])
  })

  it('clears loadingEarlier on any fold — a forward or tail page always resolves it', () => {
    const loading = { ...IDLE_TRANSCRIPT, loadingEarlier: true }
    const state = foldChunk(loading, chunk([said('assistant', 'x')], 6))

    expect(state.loadingEarlier).toBe(false)
  })
})

describe('foldEarlierChunk — paging backward (#134)', () => {
  it('prepends the earlier page and moves the earliest edge back to its offset', () => {
    const opened = foldChunk(IDLE_TRANSCRIPT, chunk([said('assistant', 'newest')], 900, { offset: 700 }))
    const state = foldEarlierChunk(opened, chunk([said('assistant', 'earlier')], 700, { offset: 400 }))

    expect(state.entries).toEqual([said('assistant', 'earlier'), said('assistant', 'newest')])
    expect(state.earliestOffset).toBe(400)
  })

  it('never touches the forward cursor — paging into history does not move where following resumes', () => {
    const opened = foldChunk(IDLE_TRANSCRIPT, chunk([said('assistant', 'newest')], 900, { offset: 700 }))
    const state = foldEarlierChunk(opened, chunk([said('assistant', 'earlier')], 700, { offset: 400 }))

    expect(state.offset).toBe(opened.offset)
    expect(state.eof).toBe(opened.eof)
    expect(state.size).toBe(opened.size)
  })

  it('clears loadingEarlier without touching the entries when the server has nothing for it', () => {
    const opened = {
      ...foldChunk(IDLE_TRANSCRIPT, chunk([said('assistant', 'newest')], 900, { offset: 700 })),
      loadingEarlier: true,
    }
    const state = foldEarlierChunk(opened, { available: false, lane: '84-chat-drawer', reason: 'gone' })

    expect(state.loadingEarlier).toBe(false)
    expect(state.entries).toEqual(opened.entries)
    expect(state.earliestOffset).toBe(opened.earliestOffset)
  })
})

describe('useTranscript — opening at the tail (#134)', () => {
  it('mounts by asking for the tail, not offset zero, and lands one round trip in', async () => {
    const fetchImpl = scriptedFetch([chunk([said('assistant', 'the newest turn')], 900, { offset: 700 })])

    const { result } = renderHook(() => useTranscript('84-chat-drawer', { fetchImpl, pollMs: 0 }))
    await act(async () => {})

    expect(fetchImpl.urls).toEqual([transcriptTailUrl('84-chat-drawer')])
    expect(result.current.entries).toHaveLength(1)
    expect(textOf(result.current.entries[0])).toBe('the newest turn')
    expect(result.current.offset).toBe(900)
    expect(result.current.earliestOffset).toBe(700)
  })

  it('a poll after the tail-open follows forward from the tail\'s own nextOffset', async () => {
    const fetchImpl = scriptedFetch([
      chunk([said('assistant', 'newest')], 900, { offset: 700 }),
      chunk([said('assistant', 'appended')], 950, { offset: 900 }),
    ])

    const { result } = renderHook(() => useTranscript('84-chat-drawer', { fetchImpl, pollMs: 0 }))
    await act(async () => {})
    await act(async () => {
      await result.current.refresh()
    })

    expect(fetchImpl.urls).toEqual([transcriptTailUrl('84-chat-drawer'), transcriptUrl('84-chat-drawer', 900)])
    expect(result.current.entries).toHaveLength(2)
    expect(result.current.offset).toBe(950)
    // Following forward never moves the earliest edge the tail-open set.
    expect(result.current.earliestOffset).toBe(700)
  })
})

describe('useTranscript — per-lane cache, switching back never blanks (#191)', () => {
  it('shows a previously-read lane\'s own entries instantly on switching back, and resumes forward instead of re-opening the tail', async () => {
    const fetchImpl = scriptedFetch([
      chunk([said('user', 'lane a turn 1')], 10), // lane-a tail-open
      chunk([said('user', 'lane b turn 1')], 10), // lane-b tail-open
      chunk([said('user', 'lane a turn 2')], 20, { offset: 10 }), // lane-a resumed forward
    ])

    const { result, rerender } = renderHook(
      ({ lane }: { lane: string }) => useTranscript(lane, { fetchImpl, pollMs: 0 }),
      { initialProps: { lane: 'lane-a' } },
    )
    await act(async () => {})
    expect(result.current.entries).toHaveLength(1)
    expect(textOf(result.current.entries[0])).toBe('lane a turn 1')

    act(() => rerender({ lane: 'lane-b' }))
    await act(async () => {})
    expect(textOf(result.current.entries[0])).toBe('lane b turn 1')

    // Switching back to lane-a: its own entry is on screen the instant this
    // commits — no empty or loading frame — read BEFORE the resumed fetch
    // below is even awaited.
    act(() => rerender({ lane: 'lane-a' }))
    expect(result.current.entries).toHaveLength(1)
    expect(textOf(result.current.entries[0])).toBe('lane a turn 1')
    expect(result.current.status).toBe('ready')

    await act(async () => {})

    // Resumed from the cached offset (10), not re-opened at the tail — the
    // tail would have re-fetched the same page and doubled it.
    expect(fetchImpl.urls).toEqual([
      transcriptTailUrl('lane-a'),
      transcriptTailUrl('lane-b'),
      transcriptUrl('lane-a', 10),
    ])
    expect(result.current.entries).toHaveLength(2)
    expect(textOf(result.current.entries[1])).toBe('lane a turn 2')
  })

  it('never shows the outgoing lane\'s entries once a genuinely new lane is selected', async () => {
    const fetchImpl = scriptedFetch([
      chunk([said('user', 'lane a turn 1')], 10),
      chunk([said('user', 'lane b turn 1')], 10),
    ])

    const { result, rerender } = renderHook(
      ({ lane }: { lane: string }) => useTranscript(lane, { fetchImpl, pollMs: 0 }),
      { initialProps: { lane: 'lane-a' } },
    )
    await act(async () => {})

    act(() => rerender({ lane: 'lane-b' }))
    // A lane never seen before shows loading/empty, never lane-a's turn.
    expect(result.current.entries).toHaveLength(0)
    expect(result.current.status).toBe('loading')

    await act(async () => {})
    expect(result.current.entries).toHaveLength(1)
    expect(textOf(result.current.entries[0])).toBe('lane b turn 1')
  })

  it('clearing to no lane, then reselecting the same one, still recovers from cache rather than refetching from empty', async () => {
    const fetchImpl = scriptedFetch([
      chunk([said('user', 'lane a turn 1')], 10),
      chunk([said('user', 'lane a turn 2')], 20, { offset: 10 }),
    ])

    const { result, rerender } = renderHook(
      ({ lane }: { lane: string | null }) => useTranscript(lane, { fetchImpl, pollMs: 0 }),
      { initialProps: { lane: 'lane-a' as string | null } },
    )
    await act(async () => {})
    expect(result.current.entries).toHaveLength(1)

    // A parent that briefly loses the lane (this hook's own #191 worry) and
    // then resolves back to the same one — never a re-fetch from byte zero.
    act(() => rerender({ lane: null }))
    expect(result.current.entries).toHaveLength(0)

    act(() => rerender({ lane: 'lane-a' }))
    expect(result.current.entries).toHaveLength(1)
    expect(textOf(result.current.entries[0])).toBe('lane a turn 1')

    await act(async () => {})
    expect(fetchImpl.urls).toEqual([transcriptTailUrl('lane-a'), transcriptUrl('lane-a', 10)])
    expect(result.current.entries).toHaveLength(2)
  })
})

describe('useTranscript — eager catch-up burst, never one page per tick (#134)', () => {
  it('a single refresh() awaits every page the server says is left, in one call', async () => {
    const fetchImpl = scriptedFetch([
      chunk([said('assistant', 'opened')], 100, { offset: 100 }), // the tail-open
      chunk([said('assistant', 'page a')], 200, { offset: 100, eof: false }),
      chunk([said('assistant', 'page b')], 300, { offset: 200, eof: false }),
      chunk([said('assistant', 'page c')], 400, { offset: 300, eof: true }),
    ])

    const { result } = renderHook(() => useTranscript('84-chat-drawer', { fetchImpl, pollMs: 0 }))
    await act(async () => {})
    expect(fetchImpl.urls).toEqual([transcriptTailUrl('84-chat-drawer')])

    // One poll tick, one refresh() call — but the server had three pages
    // queued up behind eof:false, and all three land before this awaits.
    await act(async () => {
      await result.current.refresh()
    })

    expect(fetchImpl.urls).toEqual([
      transcriptTailUrl('84-chat-drawer'),
      transcriptUrl('84-chat-drawer', 100),
      transcriptUrl('84-chat-drawer', 200),
      transcriptUrl('84-chat-drawer', 300),
    ])
    expect(result.current.entries).toHaveLength(4)
    expect(result.current.offset).toBe(400)
  })

  it('stops the burst the moment a page says eof, even mid-way through a long tail', async () => {
    const fetchImpl = scriptedFetch([
      chunk([said('assistant', 'opened')], 100, { offset: 100 }),
      chunk([said('assistant', 'the only new page')], 200, { offset: 100, eof: true }),
    ])

    const { result } = renderHook(() => useTranscript('84-chat-drawer', { fetchImpl, pollMs: 0 }))
    await act(async () => {})
    await act(async () => {
      await result.current.refresh()
    })

    // Only one forward request — the burst does not keep asking once eof is true.
    expect(fetchImpl.urls).toEqual([transcriptTailUrl('84-chat-drawer'), transcriptUrl('84-chat-drawer', 100)])
  })
})

describe('useTranscript — loading earlier history (#134)', () => {
  it('loadEarlier() asks before the loaded window\'s own start and prepends the answer', async () => {
    const fetchImpl = scriptedFetch([
      chunk([said('assistant', 'newest')], 900, { offset: 700 }),
      chunk([said('assistant', 'earlier')], 700, { offset: 400 }),
    ])

    const { result } = renderHook(() => useTranscript('84-chat-drawer', { fetchImpl, pollMs: 0 }))
    await act(async () => {})
    await act(async () => {
      await result.current.loadEarlier()
    })

    expect(fetchImpl.urls).toEqual([transcriptTailUrl('84-chat-drawer'), transcriptBeforeUrl('84-chat-drawer', 700)])
    expect(result.current.entries).toHaveLength(2)
    // Prepended: the earlier turn is now the first entry, not the last.
    expect(textOf(result.current.entries[0])).toBe('earlier')
    expect(result.current.earliestOffset).toBe(400)
  })

  it('does nothing — no request at all — once the loaded window already reaches byte zero', async () => {
    const fetchImpl = scriptedFetch([chunk([said('assistant', 'the whole log')], 40, { offset: 0 })])

    const { result } = renderHook(() => useTranscript('84-chat-drawer', { fetchImpl, pollMs: 0 }))
    await act(async () => {})
    await act(async () => {
      await result.current.loadEarlier()
    })

    expect(fetchImpl.urls).toEqual([transcriptTailUrl('84-chat-drawer')])
    expect(result.current.entries).toHaveLength(1)
  })

  it('clears loadingEarlier once the page lands', async () => {
    const fetchImpl = scriptedFetch([
      chunk([said('assistant', 'newest')], 900, { offset: 700 }),
      chunk([said('assistant', 'earlier')], 700, { offset: 400 }),
    ])

    const { result } = renderHook(() => useTranscript('84-chat-drawer', { fetchImpl, pollMs: 0 }))
    await act(async () => {})
    await act(async () => {
      await result.current.loadEarlier()
    })

    expect(result.current.loadingEarlier).toBe(false)
  })
})
