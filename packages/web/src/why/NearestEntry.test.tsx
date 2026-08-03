import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { FetchLike } from '../fleet/manifest.js'
import { MAX_LOOKBACK_PAGES, NearestEntry } from './NearestEntry.js'

afterEach(cleanup)

interface FakeEntry {
  ts: string
  text: string
}

/**
 * A fake session log of `count` turns, one second apart starting at epoch 0,
 * paged `pageSize` entries at a time by ENTRY INDEX (not real bytes — the
 * hook only cares that offsets are monotonic and round-trip, exactly like
 * `useTranscript.test.ts`'s own fixtures).
 */
function fakeLog(count: number): FakeEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: new Date(i * 1_000).toISOString(),
    text: `turn ${i}`,
  }))
}

function fetchStub(log: readonly FakeEntry[], pageSize: number): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = []
  const fetch: FetchLike = async (input: string) => {
    calls.push(input)
    const url = new URL(input, 'http://test')
    const tail = url.searchParams.get('tail') === '1'
    const before = url.searchParams.get('before')

    const endIndex = tail ? log.length : before !== null ? Number(before) : 0
    const startIndex = Math.max(0, endIndex - pageSize)
    const slice = log.slice(startIndex, endIndex)

    return {
      ok: true,
      json: async () => ({
        available: true,
        lane: 'feature',
        sessionId: 'sess-1',
        offset: startIndex,
        nextOffset: endIndex,
        size: log.length,
        eof: endIndex >= log.length,
        restarted: false,
        entries: slice.map((entry) => ({ ts: entry.ts, role: 'assistant', blocks: [{ kind: 'text', text: entry.text }] })),
      }),
    }
  }
  return { fetch, calls }
}

describe('NearestEntry', () => {
  it('pages backward until the loaded window brackets the target, then shows the closest turn', async () => {
    const log = fakeLog(8)
    const { fetch, calls } = fetchStub(log, 2)
    // Target is turn 3's own timestamp — well before the tail (turns 6-7).
    const targetTs = Date.parse(log[3]!.ts)

    render(<NearestEntry lane="feature" targetTs={targetTs} fetchImpl={fetch} />)

    await waitFor(() => expect(screen.getByTestId('why-nearest-entry').textContent).toContain('turn 3'))
    // tail + two "before" pages reaches turn 3 (entries 2..7 loaded).
    expect(calls.length).toBe(3)
  })

  it('never exceeds the lookback cap, even when the target is far older than what loaded', async () => {
    const log = fakeLog(2 * MAX_LOOKBACK_PAGES + 10)
    const { fetch, calls } = fetchStub(log, 1)
    const targetTs = Date.parse(log[0]!.ts)

    render(<NearestEntry lane="feature" targetTs={targetTs} fetchImpl={fetch} />)

    await waitFor(() => expect(calls.length).toBe(MAX_LOOKBACK_PAGES + 1))
    // Give any further (incorrect) requests a chance to land, then confirm none did.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls.length).toBe(MAX_LOOKBACK_PAGES + 1)
    expect(screen.getByTestId('why-nearest-entry')).toBeInTheDocument()
  })

  it('shows the transcript gap line when the lane has no session log at all', async () => {
    const fetch: FetchLike = async () => ({
      ok: false,
      json: async () => ({ available: false, lane: 'feature', reason: 'NO SESSION LOG for this fixture' }),
    })

    render(<NearestEntry lane="feature" targetTs={0} fetchImpl={fetch} />)

    await waitFor(() =>
      expect(screen.getByTestId('why-nearest-entry-gap').textContent).toContain('NO SESSION LOG'),
    )
  })
})
