import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { FetchLike } from '../fleet/manifest.js'
import { TAIL_SLACK_PX, TranscriptPanel, isAtTail } from './Transcript.js'
import { IDLE_TRANSCRIPT, foldChunk, transcriptUrl, useTranscript } from './useTranscript.js'

afterEach(cleanup)

/**
 * A fetch that serves a scripted list of bodies, one per call, and records the
 * URLs it was asked for. Nothing is timed: the component is driven with
 * `pollMs: 0`, so every assertion is about a request the test itself caused.
 */
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

function chunk(text: string, nextOffset: number, extra: Record<string, unknown> = {}) {
  return {
    available: true,
    lane: '84-chat-drawer',
    sessionId: 'sess-84',
    offset: 0,
    nextOffset,
    size: nextOffset,
    eof: true,
    restarted: false,
    text,
    ...extra,
  }
}

describe('transcriptUrl', () => {
  it('is a GET path carrying the lane and the offset — the whole protocol', () => {
    expect(transcriptUrl('84-chat-drawer', 0)).toBe('/api/transcript/84-chat-drawer?offset=0')
  })

  it('encodes a lane name that would otherwise break the path', () => {
    expect(transcriptUrl('feature/84', 12)).toBe('/api/transcript/feature%2F84?offset=12')
  })
})

describe('foldChunk', () => {
  it('appends a chunk to what is already read and advances the offset', () => {
    const first = foldChunk(IDLE_TRANSCRIPT, chunk('one\n', 4))
    const second = foldChunk(first, chunk('two\n', 8))

    expect(second.text).toBe('one\ntwo\n')
    expect(second.offset).toBe(8)
    expect(second.status).toBe('ready')
  })

  it('replaces rather than appends when the server says the log restarted', () => {
    const first = foldChunk(IDLE_TRANSCRIPT, chunk('old session\n', 12))
    const second = foldChunk(first, chunk('new session\n', 12, { restarted: true }))

    expect(second.text).toBe('new session\n')
  })

  it('becomes absent, carrying the server\'s reason, for a lane with no session log', () => {
    const state = foldChunk(IDLE_TRANSCRIPT, {
      available: false,
      lane: 'ghost',
      reason: 'NO SUCH LANE "ghost" — nothing in this session\'s event log names it',
    })

    expect(state.status).toBe('absent')
    expect(state.reason).toContain('NO SUCH LANE')
  })

  it('is loud, not silent, when the body carries no reason at all', () => {
    const state = foldChunk(IDLE_TRANSCRIPT, {})

    expect(state.status).toBe('absent')
    expect(state.reason).toContain('NO TRANSCRIPT')
  })
})

describe('isAtTail', () => {
  it('is true at the bottom and within a line of it', () => {
    expect(isAtTail({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true)
    expect(isAtTail({ scrollTop: 900 - TAIL_SLACK_PX, scrollHeight: 1000, clientHeight: 100 })).toBe(true)
  })

  it('is false once the reader has scrolled up past the slack', () => {
    expect(isAtTail({ scrollTop: 400, scrollHeight: 1000, clientHeight: 100 })).toBe(false)
  })

  it('is true for content that does not overflow at all', () => {
    expect(isAtTail({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 })).toBe(true)
  })
})

/**
 * A poll driven by hand. The interval is off (`pollMs: 0`) and the button
 * fires the exact call the interval would have — so the tail is tested without
 * a single test ever waiting on a clock.
 */
function TailHarness({ fetchImpl }: { fetchImpl: FetchLike }) {
  const tail = useTranscript('84-chat-drawer', { fetchImpl, pollMs: 0 })
  return (
    <div>
      <button type="button" onClick={() => void tail.refresh()}>
        poll
      </button>
      <pre data-testid="tail-text">{tail.text}</pre>
      <span data-testid="tail-offset">{tail.offset}</span>
    </div>
  )
}

describe('useTranscript — the tail', () => {
  it('resumes from the offset the last chunk handed back, and appends', async () => {
    const fetchImpl = scriptedFetch([chunk('first\n', 6), chunk('second\n', 13, { offset: 6 })])

    await act(async () => {
      render(<TailHarness fetchImpl={fetchImpl} />)
    })
    expect(screen.getByTestId('tail-text').textContent).toBe('first\n')
    expect(screen.getByTestId('tail-offset').textContent).toBe('6')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'poll' }))
    })

    expect(fetchImpl.urls).toEqual([
      '/api/transcript/84-chat-drawer?offset=0',
      '/api/transcript/84-chat-drawer?offset=6',
    ])
    expect(screen.getByTestId('tail-text').textContent).toBe('first\nsecond\n')
  })

  it('only ever issues GETs — the fetch is called with a URL and nothing else', async () => {
    const calls: unknown[][] = []
    const recording = (async (...args: unknown[]) => {
      calls.push(args)
      return { ok: true, json: async () => chunk('x\n', 2) }
    }) as unknown as FetchLike

    await act(async () => {
      render(<TailHarness fetchImpl={recording} />)
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(1)
    expect(typeof calls[0]?.[0]).toBe('string')
  })
})

describe('TranscriptPanel', () => {
  it('is collapsed by default and issues no request until it is opened', async () => {
    const fetchImpl = scriptedFetch([chunk('hello\n', 6)])

    await act(async () => {
      render(<TranscriptPanel lane="84-chat-drawer" fetchImpl={fetchImpl} pollMs={0} />)
    })

    expect(screen.queryByTestId('transcript-body')).toBeNull()
    expect(fetchImpl.urls).toEqual([])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /transcript/i }))
    })

    expect(fetchImpl.urls).toEqual(['/api/transcript/84-chat-drawer?offset=0'])
    expect(screen.getByTestId('transcript-body').textContent).toBe('hello\n')
  })

  it('shows the honest absence line instead of an empty pane', async () => {
    const fetchImpl = scriptedFetch([
      {
        available: false,
        lane: 'ghost',
        reason: 'NO SESSION LOG for "ghost" — the transcript is not on disk where the collector tails it',
      },
    ])

    await act(async () => {
      render(<TranscriptPanel lane="ghost" fetchImpl={fetchImpl} pollMs={0} initiallyExpanded />)
    })

    expect(screen.queryByTestId('transcript-body')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('NO SESSION LOG')
  })

  it('stops following when the reader scrolls up, and offers the way back', async () => {
    const fetchImpl = scriptedFetch([chunk('a lot of transcript\n', 20)])

    await act(async () => {
      render(
        <TranscriptPanel lane="84-chat-drawer" fetchImpl={fetchImpl} pollMs={0} initiallyExpanded />,
      )
    })

    const body = screen.getByTestId('transcript-body')
    // jsdom has no layout, so the scrolled-up geometry is set explicitly —
    // the rule under test is `isAtTail`, and this drives it through the event.
    Object.defineProperty(body, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(body, 'clientHeight', { value: 100, configurable: true })
    body.scrollTop = 0

    await act(async () => {
      fireEvent.scroll(body)
    })

    expect(screen.getByRole('button', { name: /paused — jump to the tail/i })).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /paused — jump to the tail/i }))
    })

    expect(screen.queryByRole('button', { name: /paused — jump to the tail/i })).toBeNull()
  })

  it('re-collapses when the drawer moves to another lane', async () => {
    const fetchImpl = scriptedFetch([chunk('lane a\n', 7)])

    const { rerender } = render(
      <TranscriptPanel lane="lane-a" fetchImpl={fetchImpl} pollMs={0} initiallyExpanded />,
    )
    await act(async () => {})
    expect(screen.getByTestId('transcript-body').textContent).toBe('lane a\n')

    await act(async () => {
      rerender(<TranscriptPanel lane="lane-b" fetchImpl={fetchImpl} pollMs={0} />)
    })

    expect(screen.queryByTestId('transcript-body')).toBeNull()
  })
})
