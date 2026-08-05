import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('ChapterMarks — full-height ticks, not a 9px glyph (issue #186 defect 2)', () => {
  it('renders a tick as a button with a real hit target, never a text diamond', () => {
    const events = log((fx) => {
      fx.at(100).agentStatus({ handle: 'ke5', status: 'working' })
    })
    render(<ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={() => {}} seekEnabled />)

    const mark = screen.getByTestId('chapter-mark')
    expect(mark.textContent).not.toContain('◆')
  })

  it('carries no native title — the hover card is the only discoverable surface now', () => {
    const events = log((fx) => {
      fx.at(100).agentStatus({ handle: 'ke5', status: 'working' })
    })
    render(<ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={() => {}} seekEnabled />)

    expect(screen.getByTestId('chapter-mark')).not.toHaveAttribute('title')
  })

  it('still carries the full who/what/when as its accessible name', () => {
    const events = log((fx) => {
      fx.at(100).agentStatus({ handle: 'ke5', status: 'working' })
    })
    render(<ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={() => {}} seekEnabled />)

    expect(screen.getByTestId('chapter-mark')).toHaveAccessibleName(/ke5 born/)
  })
})

describe('ChapterMarks — the styled hover card replaces the native title (issue #186 defect 2, research note §4 R2)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows no card until hovered', () => {
    const events = log((fx) => {
      fx.at(100).agentStatus({ handle: 'ke5', status: 'working' })
    })
    render(<ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={() => {}} seekEnabled />)
    expect(screen.queryByTestId('chapter-mark-card')).not.toBeInTheDocument()
  })

  it('shows the card ~150ms after hover starts, not instantly and not after 1s', () => {
    const events = log((fx) => {
      fx.at(100).agentStatus({ handle: 'ke5', status: 'working' })
    })
    render(<ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={() => {}} seekEnabled />)

    fireEvent.mouseEnter(screen.getByTestId('chapter-mark').parentElement as HTMLElement)
    expect(screen.queryByTestId('chapter-mark-card')).not.toBeInTheDocument()

    act(() => vi.advanceTimersByTime(149))
    expect(screen.queryByTestId('chapter-mark-card')).not.toBeInTheDocument()

    act(() => vi.advanceTimersByTime(2))
    expect(screen.getByTestId('chapter-mark-card')).toBeInTheDocument()
  })

  it('hides the card immediately on mouse leave, cancelling a pending show', () => {
    const events = log((fx) => {
      fx.at(100).agentStatus({ handle: 'ke5', status: 'working' })
    })
    render(<ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={() => {}} seekEnabled />)

    const wrapper = screen.getByTestId('chapter-mark').parentElement as HTMLElement
    fireEvent.mouseEnter(wrapper)
    fireEvent.mouseLeave(wrapper)
    act(() => vi.advanceTimersByTime(500))
    expect(screen.queryByTestId('chapter-mark-card')).not.toBeInTheDocument()
  })

  it("a cluster's card lists every member, each its own exact-seek row", () => {
    const onSeek = vi.fn()
    const events = log((fx) => {
      fx.at(5_000).agentStatus({ handle: 'a', status: 'working' })
      fx.at(5_010).agentStatus({ handle: 'b', status: 'working' })
    })
    render(<ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={onSeek} seekEnabled />)

    const wrapper = screen.getByTestId('chapter-mark').parentElement as HTMLElement
    fireEvent.mouseEnter(wrapper)
    act(() => vi.advanceTimersByTime(150))

    const rows = screen.getAllByTestId('chapter-mark-card-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('a born')
    expect(rows[1]?.textContent).toContain('b born')

    fireEvent.click(rows[1] as HTMLElement)
    expect(onSeek).toHaveBeenCalledWith(5_010)
  })

  it('a card row seek does not also trigger the tick\'s own click-to-seek', () => {
    const onSeek = vi.fn()
    const events = log((fx) => {
      fx.at(5_000).agentStatus({ handle: 'a', status: 'working' })
      fx.at(5_010).agentStatus({ handle: 'b', status: 'working' })
    })
    render(<ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={onSeek} seekEnabled />)

    const wrapper = screen.getByTestId('chapter-mark').parentElement as HTMLElement
    fireEvent.mouseEnter(wrapper)
    act(() => vi.advanceTimersByTime(150))
    fireEvent.click(screen.getAllByTestId('chapter-mark-card-row')[1] as HTMLElement)

    expect(onSeek).toHaveBeenCalledTimes(1)
    expect(onSeek).toHaveBeenCalledWith(5_010)
  })
})

describe('ChapterMarks — the hover card escapes the dock\'s flow (issue #189 defect 1, FATAL)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 12,
      height: 18,
      top: 100,
      left: 200,
      right: 212,
      bottom: 118,
      x: 200,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function renderHoveredCard() {
    const events = log((fx) => {
      fx.at(100).agentStatus({ handle: 'ke5', status: 'working' })
    })
    const view = render(
      <div data-testid="clipped-ancestor" style={{ overflow: 'hidden', position: 'static' }}>
        <ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={() => {}} seekEnabled />
      </div>,
    )
    const wrapper = screen.getByTestId('chapter-mark').parentElement as HTMLElement
    fireEvent.mouseEnter(wrapper)
    act(() => vi.advanceTimersByTime(150))
    return view
  }

  it('renders the card as a child of document.body, never inside the clipped ancestor', () => {
    renderHoveredCard()
    const card = screen.getByTestId('chapter-mark-card')
    const clipped = screen.getByTestId('clipped-ancestor')

    expect(card.parentElement).toBe(document.body)
    expect(clipped.contains(card)).toBe(false)
  })

  it('gives the card its own explicit stacking (position: fixed, never static)', () => {
    renderHoveredCard()
    const card = screen.getByTestId('chapter-mark-card')
    expect(getComputedStyle(card).position).toBe('fixed')
    expect(getComputedStyle(card).position).not.toBe('static')
  })

  it('positions the card from the tick\'s own getBoundingClientRect, below it', () => {
    renderHoveredCard()
    const card = screen.getByTestId('chapter-mark-card')
    // The mocked rect: left 200, width 12, bottom 118 -> centre x 206, top 118 + 4px gap.
    expect(card.style.left).toBe('206px')
    expect(card.style.top).toBe('122px')
  })

  // NOTE: the assertion that would have caught the original regression —
  // `document.elementFromPoint` at the card's centre resolving to the card
  // itself, never the band or the scrubber underneath it — cannot be stated
  // here. jsdom has no layout engine, so `elementFromPoint` never hit-tests;
  // this needs a real-browser check (see the verification notes), the same
  // "passive-wheel" lesson #186 already restates for this file's own
  // `wheel` listener one lane earlier.
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
    // 10ms apart are well under it and must render as a single tick.
    const events = log((fx) => {
      fx.at(5_000).agentStatus({ handle: 'a', status: 'working' })
      fx.at(5_010).agentStatus({ handle: 'b', status: 'working' })
    })

    render(<ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={() => {}} seekEnabled />)

    const marks = screen.getAllByTestId('chapter-mark')
    expect(marks).toHaveLength(1)
    expect(marks[0]?.dataset.count).toBe('2')
  })

  it('never renders an unhoverable mark: every tick, coalesced or not, carries its full facts as an accessible name', () => {
    const events = log((fx) => {
      fx.at(5_000).agentStatus({ handle: 'a', status: 'working' })
      fx.at(5_010).agentStatus({ handle: 'b', status: 'working' })
      fx.at(9_000).agentStatus({ handle: 'c', status: 'working' })
    })

    render(<ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={() => {}} seekEnabled />)

    for (const mark of screen.getAllByTestId('chapter-mark')) {
      expect(mark.getAttribute('aria-label')?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it("a cluster's accessible name lists every member, one per line", () => {
    const events = log((fx) => {
      fx.at(5_000).agentStatus({ handle: 'a', status: 'working' })
      fx.at(5_010).agentStatus({ handle: 'b', status: 'working' })
    })

    render(<ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={() => {}} seekEnabled />)

    const [mark] = screen.getAllByTestId('chapter-mark')
    const lines = (mark?.getAttribute('aria-label') ?? '').split('\n')
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

describe('ChapterMarks — label-when-fits (research note §4 R2, "the band\'s own law reused")', () => {
  it('shows a short self-legending label beside an isolated mark with room to spare', () => {
    const events = log((fx) => {
      fx.at(0).agentStatus({ handle: 'ke5', status: 'working' })
    })
    render(<ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={() => {}} seekEnabled />)
    expect(screen.getByText('ke5 ▸')).toBeInTheDocument()
  })

  it('shows a count label for a cluster with room to spare', () => {
    const events = log((fx) => {
      fx.at(5_000).agentStatus({ handle: 'a', status: 'working' })
      fx.at(5_010).agentStatus({ handle: 'b', status: 'working' })
    })
    render(<ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={() => {}} seekEnabled />)
    expect(screen.getByText('×2 ▸')).toBeInTheDocument()
  })

  it('never renders a label when neighbouring marks leave no room — never clipped text', () => {
    // Many marks packed just above the coalescing threshold, so each
    // renders its own tick but with almost no room between ticks — and the
    // window ends right after the last one, so even its trailing gap (to
    // the track's own right edge) stays just as tight as every inner gap.
    const STEP_MS = 70
    const COUNT = 40
    const localEnd = STEP_MS * COUNT
    const events = log((fx) => {
      for (let i = 0; i < COUNT; i += 1) {
        fx.at(i * STEP_MS).agentStatus({ handle: `lane-with-a-long-handle-${i}`, status: 'working' })
      }
    })
    render(<ChapterMarks events={events} start={T0} end={localEnd} width={900} onSeek={() => {}} seekEnabled />)

    const marks = screen.getAllByTestId('chapter-mark')
    expect(marks).toHaveLength(COUNT)
    for (const mark of marks) {
      expect(mark.textContent).toBe('')
    }
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

describe('ChapterMarks — mode-dependent height (issue #186 defect 4)', () => {
  it('defaults to the original compact row height', () => {
    const events = log((fx) => {
      fx.at(100).agentStatus({ handle: 'ke5', status: 'working' })
    })
    render(<ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={() => {}} seekEnabled />)
    expect(screen.getByTestId('chapter-marks').style.height).toBe('10px')
  })

  it('honours an explicit taller height (replay breathing room)', () => {
    const events = log((fx) => {
      fx.at(100).agentStatus({ handle: 'ke5', status: 'working' })
    })
    render(
      <ChapterMarks events={events} start={T0} end={T_END} width={900} onSeek={() => {}} seekEnabled height={24} />,
    )
    expect(screen.getByTestId('chapter-marks').style.height).toBe('24px')
  })
})
