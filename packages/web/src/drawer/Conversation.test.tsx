import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FetchLike } from '../fleet/manifest.js'
import { Conversation, TAIL_SLACK_PX, isAtTail } from './Conversation.js'
import {
  IDLE_TRANSCRIPT,
  foldChunk,
  parseEntries,
  transcriptBeforeUrl,
  transcriptTailUrl,
  transcriptUrl,
  useTranscript,
  type TranscriptEntry,
} from './useTranscript.js'

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

/**
 * A real session-log window, in the shape the endpoint sends it: a human prompt,
 * the agent answering, tool calls with their results (which a session log
 * records on `user` lines), a subagent's turn, and a line the parser could not
 * read. Every branch of the CLI view is in here.
 */
const FIXTURE: TranscriptEntry[] = [
  {
    ts: '2026-08-01T11:59:00.000Z',
    role: 'user',
    blocks: [{ kind: 'text', text: 'restructure the transcript endpoint' }],
  },
  {
    ts: '2026-08-01T11:59:04.000Z',
    role: 'assistant',
    blocks: [
      { kind: 'text', text: 'Reading the route and its tests first.' },
      { kind: 'tool_use', name: 'Read', hint: 'packages/server/src/api/transcript.ts' },
      { kind: 'tool_use', name: 'Bash', hint: 'npm test -- transcript' },
    ],
  },
  { role: 'user', blocks: [{ kind: 'tool_result', text: '40 passed (40)', dropped: 0 }] },
  { role: 'user', blocks: [{ kind: 'tool_result', text: 'a'.repeat(40), dropped: 1_400 }] },
  { role: 'subagent', blocks: [{ kind: 'text', text: 'swept the drawer for other callers' }] },
  { role: 'system', blocks: [{ kind: 'text', text: '⟨unreadable line⟩' }] },
]

describe('transcriptUrl', () => {
  it('is a GET path carrying the lane and the offset — the whole protocol', () => {
    expect(transcriptUrl('84-chat-drawer', 0)).toBe('/api/transcript/84-chat-drawer?offset=0')
  })

  it('encodes a lane name that would otherwise break the path', () => {
    expect(transcriptUrl('feature/84', 12)).toBe('/api/transcript/feature%2F84?offset=12')
  })
})

describe('parseEntries — the wire shape, checked', () => {
  it('keeps the turns and blocks it understands', () => {
    expect(
      parseEntries([
        { ts: '2026-08-01T12:00:00.000Z', role: 'user', blocks: [{ kind: 'text', text: 'go' }] },
        { role: 'assistant', blocks: [{ kind: 'tool_use', name: 'Read', hint: 'a.ts' }] },
        { role: 'user', blocks: [{ kind: 'tool_result', text: 'ok', dropped: 3 }] },
      ]),
    ).toEqual([
      { ts: '2026-08-01T12:00:00.000Z', role: 'user', blocks: [{ kind: 'text', text: 'go' }] },
      { role: 'assistant', blocks: [{ kind: 'tool_use', name: 'Read', hint: 'a.ts' }] },
      { role: 'user', blocks: [{ kind: 'tool_result', text: 'ok', dropped: 3 }] },
    ])
  })

  it('skips a block kind this bundle has never heard of rather than rendering it raw', () => {
    const entries = parseEntries([
      {
        role: 'assistant',
        blocks: [{ kind: 'hologram', text: 'from the future' }, { kind: 'text', text: 'hi' }],
      },
      { role: 'assistant', blocks: [{ kind: 'hologram' }] },
    ])

    expect(entries).toEqual([{ role: 'assistant', blocks: [{ kind: 'text', text: 'hi' }] }])
  })

  it('falls back to the parser\'s own voice for a role it does not know', () => {
    expect(parseEntries([{ role: 'oracle', blocks: [{ kind: 'text', text: 'x' }] }])[0]?.role).toBe('system')
  })

  it('is empty, not thrown, for a body that is not a list of turns at all', () => {
    expect(parseEntries(undefined)).toEqual([])
    expect(parseEntries('entries')).toEqual([])
    expect(parseEntries([null, 7])).toEqual([])
  })
})

describe('foldChunk', () => {
  it('appends a page of turns to what is already read and advances the offset', () => {
    const first = foldChunk(IDLE_TRANSCRIPT, chunk([said('user', 'one')], 4))
    const second = foldChunk(first, chunk([said('assistant', 'two')], 8))

    expect(second.entries).toEqual([said('user', 'one'), said('assistant', 'two')])
    expect(second.offset).toBe(8)
    expect(second.status).toBe('ready')
  })

  it('replaces rather than appends when the server says the log restarted', () => {
    const first = foldChunk(IDLE_TRANSCRIPT, chunk([said('user', 'old session')], 12))
    const second = foldChunk(first, chunk([said('user', 'new session')], 12, { restarted: true }))

    expect(second.entries).toEqual([said('user', 'new session')])
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
      <span data-testid="tail-count">{tail.entries.length}</span>
      <span data-testid="tail-offset">{tail.offset}</span>
    </div>
  )
}

describe('useTranscript — the tail', () => {
  it('resumes from the offset the last chunk handed back, and appends', async () => {
    const fetchImpl = scriptedFetch([
      chunk([said('user', 'first')], 6),
      chunk([said('assistant', 'second')], 13, { offset: 6 }),
    ])

    await act(async () => {
      render(<TailHarness fetchImpl={fetchImpl} />)
    })
    expect(screen.getByTestId('tail-count').textContent).toBe('1')
    expect(screen.getByTestId('tail-offset').textContent).toBe('6')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'poll' }))
    })

    expect(fetchImpl.urls).toEqual([
      transcriptTailUrl('84-chat-drawer'),
      '/api/transcript/84-chat-drawer?offset=6',
    ])
    expect(screen.getByTestId('tail-count').textContent).toBe('2')
  })

  it('only ever issues GETs — the fetch is called with a URL and nothing else', async () => {
    const calls: unknown[][] = []
    const recording = (async (...args: unknown[]) => {
      calls.push(args)
      return { ok: true, json: async () => chunk([said('assistant', 'x')], 2) }
    }) as unknown as FetchLike

    await act(async () => {
      render(<TailHarness fetchImpl={recording} />)
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(1)
    expect(typeof calls[0]?.[0]).toBe('string')
  })
})

/** The geometry a scrolled-up reader would have. jsdom performs no layout. */
function giveGeometry(body: HTMLElement): void {
  Object.defineProperty(body, 'scrollHeight', { value: 1000, configurable: true })
  Object.defineProperty(body, 'clientHeight', { value: 100, configurable: true })
}

describe('Conversation — the CLI-style session (prd4 ruling 4)', () => {
  it('is the default view: it reads the session log on mount, with no fold to open first', async () => {
    const fetchImpl = scriptedFetch([chunk([said('assistant', 'on it')], 6)])

    await act(async () => {
      render(<Conversation lane="84-chat-drawer" fetchImpl={fetchImpl} pollMs={0} />)
    })

    expect(fetchImpl.urls).toEqual([transcriptTailUrl('84-chat-drawer')])
    expect(screen.getByTestId('conversation-body').textContent).toContain('on it')
    expect(screen.queryByRole('button', { name: /expand|conversation/i })).toBeNull()
  })

  it('renders a real session window the way a CLI session shows it', async () => {
    const fetchImpl = scriptedFetch([chunk(FIXTURE, 900)])

    await act(async () => {
      render(<Conversation lane="84-chat-drawer" fetchImpl={fetchImpl} pollMs={0} />)
    })

    // Chronological: the turns are in the order the log recorded them.
    const turns = screen.getAllByTestId('turn')
    expect(turns.map((turn) => turn.getAttribute('data-role'))).toEqual([
      'user',
      'assistant',
      'user',
      'user',
      'subagent',
      'system',
    ])

    // A user turn is prompt-like, and nothing here is a <pre> wall (law 11).
    const prompt = turns[0]
    expect(prompt?.textContent).toContain('restructure the transcript endpoint')
    expect(prompt?.getAttribute('title')).toBe('2026-08-01T11:59:00.000Z')
    expect(screen.getByTestId('conversation-body').querySelector('pre')).toBeNull()

    // Tool calls are quiet one-liners between the assistant's prose.
    const calls = screen.getAllByTestId('tool-call')
    expect(calls).toHaveLength(2)
    expect(calls[0]?.textContent).toContain('Read')
    expect(calls[0]?.textContent).toContain('packages/server/src/api/transcript.ts')
    expect(calls[1]?.textContent).toContain('npm test -- transcript')
    expect(calls[0]?.className).toContain('font-mono')

    // Assistant prose is readable copy in the page's own face — mono is for figures.
    const prose = turns[1]?.querySelector('[data-testid="turn-prose"]')
    expect(prose?.textContent).toBe('Reading the route and its tests first.')
    expect(prose?.className).not.toContain('font-mono')

    // Results are quiet, and a truncated one says that it was cut.
    const results = screen.getAllByTestId('tool-result')
    expect(results[0]?.textContent).toContain('40 passed (40)')
    expect(results[1]?.textContent).toContain('+1.4K more')

    // The subagent is marked as such and reads quieter than the lane's own voice.
    expect(turns[4]?.textContent).toContain('subagent')
    expect(turns[4]?.querySelector('[data-testid="turn-prose"]')?.className).toContain('text-ice-400')

    // An unreadable line stays visible rather than vanishing.
    expect(turns[5]?.textContent).toContain('⟨unreadable line⟩')
  })

  it('shows a tool call with no hint as just its name, with no dangling dash', async () => {
    const fetchImpl = scriptedFetch([
      chunk([{ role: 'assistant', blocks: [{ kind: 'tool_use', name: 'TodoWrite', hint: '' }] }], 40),
    ])

    await act(async () => {
      render(<Conversation lane="84-chat-drawer" fetchImpl={fetchImpl} pollMs={0} />)
    })

    expect(screen.getByTestId('tool-call').textContent).toBe('●TodoWrite')
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
      render(<Conversation lane="ghost" fetchImpl={fetchImpl} pollMs={0} />)
    })

    expect(screen.queryByTestId('conversation-body')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('NO SESSION LOG')
  })

  it('says so when the log is readable but has said nothing yet', async () => {
    const fetchImpl = scriptedFetch([chunk([], 0)])

    await act(async () => {
      render(<Conversation lane="84-chat-drawer" fetchImpl={fetchImpl} pollMs={0} />)
    })

    expect(screen.getByRole('status').textContent).toContain('NOTHING SAID YET')
  })

  it('follows the tail, pauses when the reader scrolls up, and goes back on request', async () => {
    const fetchImpl = scriptedFetch([chunk([said('assistant', 'a lot of conversation')], 20)])

    await act(async () => {
      render(<Conversation lane="84-chat-drawer" fetchImpl={fetchImpl} pollMs={0} />)
    })

    const body = screen.getByTestId('conversation-body')
    giveGeometry(body)
    body.scrollTop = 0

    await act(async () => {
      fireEvent.scroll(body)
    })

    expect(screen.getByTestId('conversation-tail-state').textContent).toContain('paused')
    expect(screen.getByRole('button', { name: /paused — jump to the tail/i })).toBeTruthy()
    // Paused means paused: the reader stays exactly where they scrolled to.
    expect(body.scrollTop).toBe(0)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /paused — jump to the tail/i }))
    })

    // Following again, and following means the view is at the bottom.
    expect(screen.queryByRole('button', { name: /paused — jump to the tail/i })).toBeNull()
    expect(screen.getByTestId('conversation-tail-state').textContent).toContain('tailing')
    expect(body.scrollTop).toBe(body.scrollHeight)
  })

  it('resumes following, on the new lane\'s own tail, when the drawer moves lane', async () => {
    const fetchImpl = scriptedFetch([chunk([said('user', 'lane a')], 7), chunk([said('user', 'lane b')], 7)])

    const { rerender } = render(<Conversation lane="lane-a" fetchImpl={fetchImpl} pollMs={0} />)
    await act(async () => {})

    const body = screen.getByTestId('conversation-body')
    giveGeometry(body)
    body.scrollTop = 0
    await act(async () => {
      fireEvent.scroll(body)
    })
    expect(screen.getByTestId('conversation-tail-state').textContent).toContain('paused')

    await act(async () => {
      rerender(<Conversation lane="lane-b" fetchImpl={fetchImpl} pollMs={0} />)
    })

    // Lane b's conversation, opened at its own tail, and following again.
    expect(fetchImpl.urls).toEqual([transcriptTailUrl('lane-a'), transcriptTailUrl('lane-b')])
    expect(screen.getByTestId('conversation-body').textContent).toContain('lane b')
    expect(screen.getByTestId('conversation-body').textContent).not.toContain('lane a')
    expect(screen.getByTestId('conversation-tail-state').textContent).toContain('tailing')
  })

  /**
   * The operator's 2026-08-05 report: "whenever there is an update it flips
   * back to not displaying as it updates". A poll landing `available: false`
   * over entries already read is staleness, not absence — `foldChunk` already
   * keeps `entries` on that fold; this is the renderer holding up its end.
   */
  it('keeps showing held entries through a transient "absent" poll, with a quiet reason instead of the gap voice (#191)', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = scriptedFetch([
        chunk([said('assistant', 'steady turn')], 40),
        { available: false, lane: '84-chat-drawer', reason: 'RE-RESOLVING — try again shortly' },
      ])

      await act(async () => {
        render(<Conversation lane="84-chat-drawer" fetchImpl={fetchImpl} pollMs={5} />)
      })

      expect(screen.getByTestId('conversation-body').textContent).toContain('steady turn')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5)
      })

      // Still the same turn on screen — never the gap line in its place.
      expect(screen.getByTestId('conversation-body').textContent).toContain('steady turn')
      expect(screen.getByTestId('conversation-stale-reason').textContent).toContain('RE-RESOLVING')
      expect(screen.getByTestId('conversation-tail-state').textContent).toContain('stale')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps showing held entries through a poll that fails outright, same as a transient "absent"', async () => {
    vi.useFakeTimers()
    try {
      const failingFetch: FetchLike & { calls: number } = Object.assign(
        async (input: string) => {
          failingFetch.calls += 1
          if (failingFetch.calls === 1) {
            return { ok: true, json: async () => chunk([said('user', 'one turn on record')], 10) }
          }
          throw new Error('network dropped')
        },
        { calls: 0 },
      )

      await act(async () => {
        render(<Conversation lane="84-chat-drawer" fetchImpl={failingFetch} pollMs={5} />)
      })

      expect(screen.getByTestId('conversation-body').textContent).toContain('one turn on record')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5)
      })

      expect(screen.getByTestId('conversation-body').textContent).toContain('one turn on record')
      expect(screen.getByTestId('conversation-stale-reason').textContent).toContain('TRANSCRIPT UNREACHABLE')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows a "load earlier" affordance when the loaded window does not start at byte zero, and pages backward on click', async () => {
    const fetchImpl = scriptedFetch([
      chunk([said('assistant', 'newest turn')], 900, { offset: 700 }),
      chunk([said('assistant', 'earlier turn')], 700, { offset: 400 }),
    ])

    await act(async () => {
      render(<Conversation lane="84-chat-drawer" fetchImpl={fetchImpl} pollMs={0} />)
    })

    const loadEarlier = screen.getByRole('button', { name: /load earlier/i })
    expect(screen.getByTestId('conversation-body').textContent).toContain('newest turn')
    expect(screen.getByTestId('conversation-body').textContent).not.toContain('earlier turn')

    await act(async () => {
      fireEvent.click(loadEarlier)
    })

    expect(fetchImpl.urls).toEqual([transcriptTailUrl('84-chat-drawer'), transcriptBeforeUrl('84-chat-drawer', 700)])
    // Prepended, not appended — the earlier turn reads before the newest one.
    const turns = screen.getAllByTestId('turn-prose')
    expect(turns.map((turn) => turn.textContent)).toEqual(['earlier turn', 'newest turn'])
  })

  it('has nothing to load earlier once the loaded window reaches byte zero', async () => {
    const fetchImpl = scriptedFetch([chunk([said('assistant', 'the whole log')], 40, { offset: 0 })])

    await act(async () => {
      render(<Conversation lane="84-chat-drawer" fetchImpl={fetchImpl} pollMs={0} />)
    })

    expect(screen.queryByRole('button', { name: /load earlier/i })).toBeNull()
  })
})
