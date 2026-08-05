import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChapterMarks } from './ChapterMarks.js'

afterEach(cleanup)

const T0 = 0
const T_END = 10_000

function log(build: (fx: ReturnType<typeof createEventFactory>) => void): RhizomorphEvent[] {
  const fx = createEventFactory({ startTs: T0, stepMs: 0 })
  build(fx)
  return fx.all()
}

describe('ChapterMarks — click a mark, seek exactly there', () => {
  it('seeks to the exact event ts, not an interpolation of the click position', () => {
    const onSeek = vi.fn()
    const events = log((fx) => {
      fx.at(4_237).agentStatus({ handle: 'ke5', status: 'working' })
    })

    render(<ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={onSeek} seekEnabled />)

    fireEvent.click(screen.getByTestId('chapter-mark'))
    expect(onSeek).toHaveBeenCalledWith(4_237)
    expect(onSeek).toHaveBeenCalledTimes(1)
  })

  it('does nothing when seeking is disabled', () => {
    const onSeek = vi.fn()
    const events = log((fx) => {
      fx.at(4_237).agentStatus({ handle: 'ke5', status: 'working' })
    })

    render(<ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={onSeek} seekEnabled={false} />)

    fireEvent.click(screen.getByTestId('chapter-mark'))
    expect(onSeek).not.toHaveBeenCalled()
  })
})

describe('ChapterMarks — coalescing under density', () => {
  it('renders one glyph per lane when marks sit far apart', () => {
    const events = log((fx) => {
      fx.at(0).agentStatus({ handle: 'a', status: 'working' })
      fx.at(9_000).agentStatus({ handle: 'b', status: 'working' })
    })

    render(<ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={() => {}} seekEnabled />)

    const marks = screen.getAllByTestId('chapter-mark')
    expect(marks).toHaveLength(2)
    for (const mark of marks) expect(mark.dataset.count).toBe('1')
  })

  it('collapses marks under the hover threshold into one counted cluster', () => {
    // width=900 over a 10s window: 6px hover budget ≈ 67ms. Two lanes born
    // 10ms apart are well under it and must render as a single ◆(2).
    const events = log((fx) => {
      fx.at(5_000).agentStatus({ handle: 'a', status: 'working' })
      fx.at(5_010).agentStatus({ handle: 'b', status: 'working' })
    })

    render(<ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={() => {}} seekEnabled />)

    const marks = screen.getAllByTestId('chapter-mark')
    expect(marks).toHaveLength(1)
    expect(marks[0]?.dataset.count).toBe('2')
    expect(marks[0]?.textContent).toBe('◆(2)')
  })

  it('never renders an unhoverable mark: every glyph, coalesced or not, carries a title', () => {
    const events = log((fx) => {
      fx.at(5_000).agentStatus({ handle: 'a', status: 'working' })
      fx.at(5_010).agentStatus({ handle: 'b', status: 'working' })
      fx.at(9_000).agentStatus({ handle: 'c', status: 'working' })
    })

    render(<ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={() => {}} seekEnabled />)

    for (const mark of screen.getAllByTestId('chapter-mark')) {
      expect(mark.title.length).toBeGreaterThan(0)
    }
  })

  it("a cluster's hover lists every member, one per line", () => {
    const events = log((fx) => {
      fx.at(5_000).agentStatus({ handle: 'a', status: 'working' })
      fx.at(5_010).agentStatus({ handle: 'b', status: 'working' })
    })

    render(<ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={() => {}} seekEnabled />)

    const [mark] = screen.getAllByTestId('chapter-mark')
    const lines = (mark?.title ?? '').split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('a born')
    expect(lines[1]).toContain('b born')
  })

  it("clicking a coalesced cluster seeks to its earliest member's ts, exactly", () => {
    const onSeek = vi.fn()
    const events = log((fx) => {
      fx.at(5_010).agentStatus({ handle: 'b', status: 'working' })
      fx.at(5_000).agentStatus({ handle: 'a', status: 'working' })
    })

    render(<ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={onSeek} seekEnabled />)

    fireEvent.click(screen.getByTestId('chapter-mark'))
    expect(onSeek).toHaveBeenCalledWith(5_000)
  })
})

describe('ChapterMarks — no marks, no glyphs', () => {
  it('renders an empty row for a log with no lane-naming events', () => {
    const events = log((fx) => {
      fx.at(0).paneActivity()
    })

    render(<ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={() => {}} seekEnabled />)

    expect(screen.queryAllByTestId('chapter-mark')).toHaveLength(0)
  })
})
