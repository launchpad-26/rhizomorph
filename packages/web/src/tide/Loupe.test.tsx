import type { RhizomorphEvent } from '@rhizomorph/core'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Loupe, LOUPE_PAYLOAD_CHARS, loupeSlice, payloadText } from './Loupe.js'

afterEach(cleanup)

/**
 * A hand-built log rather than `createEventFactory`, because every assertion
 * here is about *order* and the factory's whole job is to hand out
 * monotonically increasing timestamps — the one shape that cannot tell an
 * append-ordered loupe apart from a `ts`-sorted one.
 */
function event(id: string, ts: number, type = 'worktree.dirty'): RhizomorphEvent {
  return { id, ts, source: 'git', type, payload: { note: id } } as unknown as RhizomorphEvent
}

describe('loupeSlice', () => {
  it('returns the events nearest the instant, however few the log holds', () => {
    const events = [event('a', 1_000), event('b', 2_000), event('c', 3_000)]
    expect(loupeSlice(events, 2_000, 10).map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('bounds the read-out at the count, keeping the nearest', () => {
    const events = [
      event('far-early', 0),
      event('near-1', 9_000),
      event('near-2', 10_000),
      event('near-3', 11_000),
      event('far-late', 90_000),
    ]
    expect(loupeSlice(events, 10_000, 3).map((e) => e.id)).toEqual(['near-1', 'near-2', 'near-3'])
  })

  /**
   * The #205 law, and the reason this file builds its own fixture. The log is
   * append-ordered and its timestamps are deliberately NOT monotonic — a real
   * recording interleaves collectors, and one can report an instant its
   * neighbour already passed.
   *
   * A loupe that sorted by `ts` would answer `['early', 'mid', 'late']` here.
   * The record's own order is `['late', 'early', 'mid']`, and that is what the
   * fold beside it consumed, so that is what must be read back.
   */
  it('reads in the log\'s own append order, never re-sorted by ts', () => {
    const events = [event('late', 3_000), event('early', 1_000), event('mid', 2_000)]

    const slice = loupeSlice(events, 2_000, 10)
    expect(slice.map((e) => e.id)).toEqual(['late', 'early', 'mid'])
    // Stated as the negative too, so the assertion above cannot be read as an
    // accident of a fixture that happened to already be sorted.
    expect(slice.map((e) => e.id)).not.toEqual(['early', 'mid', 'late'])
  })

  it('selects by nearness even when the nearest events sit late in the log', () => {
    const events = [
      event('first-but-far', 50_000),
      event('second-but-far', 60_000),
      event('near-a', 1_100),
      event('near-b', 900),
    ]
    // Selection is by distance; presentation is by append position — so the two
    // chosen events come back in the order the log holds them, not nearest-first.
    expect(loupeSlice(events, 1_000, 2).map((e) => e.id)).toEqual(['near-a', 'near-b'])
  })

  it('breaks a distance tie on the earlier append position, deterministically', () => {
    // A burst sharing one millisecond is ordinary in a real log.
    const events = [event('a', 5_000), event('b', 5_000), event('c', 5_000)]
    expect(loupeSlice(events, 5_000, 2).map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('is empty for an empty log or a count of zero', () => {
    expect(loupeSlice([], 1_000, 10)).toEqual([])
    expect(loupeSlice([event('a', 1_000)], 1_000, 0)).toEqual([])
  })
})

describe('payloadText', () => {
  it('renders a small payload whole', () => {
    expect(payloadText({ files: 2 })).toBe('{"files":2}')
  })

  it('truncates and declares the cut rather than eliding it silently', () => {
    const long = { note: 'x'.repeat(400) }
    const text = payloadText(long)

    expect(text.length).toBeLessThan(JSON.stringify(long).length)
    expect(text).toContain('more characters')
    // The declared figure is the actual remainder, not a round number: a
    // truncation that lies about how much it dropped is worse than one that
    // does not declare at all.
    const dropped = JSON.stringify(long).length - LOUPE_PAYLOAD_CHARS
    expect(text).toContain(`+${dropped} more characters`)
  })

  it('says so rather than throwing when a payload will not serialise', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(payloadText(circular)).toBe('(unserialisable payload)')
  })
})

describe('Loupe', () => {
  it('lists the record verbatim — source, type and payload, one row per event', () => {
    const events = [event('a', 1_000, 'commit.landed'), event('b', 2_000, 'llm.usage')]
    render(<Loupe events={events} ts={1_500} />)

    const rows = screen.getAllByTestId('tide-loupe-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('commit.landed')
    expect(rows[0]!.textContent).toContain('git')
    expect(rows[0]!.textContent).toContain('"note":"a"')
    expect(rows[1]!.textContent).toContain('llm.usage')
  })

  it('paints the rows in append order, matching the slice', () => {
    const events = [event('late', 3_000), event('early', 1_000), event('mid', 2_000)]
    render(<Loupe events={events} ts={2_000} />)

    const painted = screen.getAllByTestId('tide-loupe-row').map((row) => row.textContent ?? '')
    expect(painted[0]).toContain('"note":"late"')
    expect(painted[1]).toContain('"note":"early"')
    expect(painted[2]).toContain('"note":"mid"')
  })

  it('states the instant and the span its fixed count happened to cover', () => {
    const events = [event('a', 60_000), event('b', 120_000)]
    render(<Loupe events={events} ts={90_000} />)

    // The neighbourhood is a fixed event count, so the time it represents
    // varies; the header says which time it turned out to be rather than
    // leaving the reader to assume a window.
    const header = screen.getByTestId('tide-loupe-header').textContent ?? ''
    expect(header).toContain('00:01:30')
    expect(header).toContain('2 events')
    expect(header).toContain('00:01:00–00:02:00')
  })

  it('says the record is empty here rather than rendering a bare box', () => {
    render(<Loupe events={[]} ts={1_000} />)
    expect(screen.getByTestId('tide-loupe-header').textContent).toContain('no events')
    expect(screen.queryAllByTestId('tide-loupe-row')).toHaveLength(0)
  })
})
