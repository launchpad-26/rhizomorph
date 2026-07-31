import { act, cleanup, render, screen } from '@testing-library/react'
import { FIXTURE_START_TS, fixtureSession, fixtureTelemetrySession, fx } from '@observatory/core'
import { afterEach, describe, expect, it } from 'vitest'
import { StreamProvider } from '../../app/StreamContext.js'
import type { EventSourceLike } from '../../hooks/useEventStream.js'
import WorktreesPanel from './index.js'

afterEach(cleanup)

class FakeEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null

  open() {
    this.onopen?.(new Event('open'))
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>)
  }

  close() {}
}

/** 7 minutes in: 2-core and 3-git panes are alive, 7-web's has gone quiet past 5m. */
const NOW = FIXTURE_START_TS + 7 * 60_000

function renderPanel(events: ReturnType<typeof fixtureSession> = fixtureSession()) {
  let source: FakeEventSource | undefined
  const utils = render(
    <StreamProvider
      url="/api/stream"
      createSource={() => {
        source = new FakeEventSource()
        return source
      }}
    >
      <WorktreesPanel now={NOW} />
    </StreamProvider>,
  )
  act(() => {
    for (const event of events) source?.emit(event)
  })
  return utils
}

function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll('tbody tr'))
}

function cells(row: HTMLTableRowElement): string[] {
  return Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent ?? '')
}

function liveDot(row: HTMLTableRowElement): string | null {
  return row.querySelector('[role="status"]')?.getAttribute('title') ?? null
}

describe('WorktreesPanel', () => {
  it('renders a header even before any connection or data', () => {
    render(
      <StreamProvider url="/api/stream" createSource={() => new FakeEventSource()}>
        <WorktreesPanel now={NOW} />
      </StreamProvider>,
    )
    expect(screen.getByText('Worktrees')).toBeInTheDocument()
    expect(screen.getByText('Waiting for the stream…')).toBeInTheDocument()
  })

  it('shows a calm empty state once connected with events but no worktrees discovered', () => {
    let source: FakeEventSource | undefined
    render(
      <StreamProvider
        url="/api/stream"
        createSource={() => {
          source = new FakeEventSource()
          return source
        }}
      >
        <WorktreesPanel now={NOW} />
      </StreamProvider>,
    )
    act(() => source?.open())
    act(() => source?.emit(fx.sessionStarted()))

    expect(screen.getByText('No worktrees discovered yet.')).toBeInTheDocument()
    expect(screen.queryByText('Waiting for the stream…')).not.toBeInTheDocument()
  })

  it('renders one row per worktree, active stations first, flatline dimmed', () => {
    const { container } = renderPanel()

    const rows = bodyRows(container)
    expect(rows).toHaveLength(4)

    // Sort: active first (2-core, 3-git), then the untouched main worktree,
    // then 7-web whose pane has gone quiet for 5 minutes.
    const branches = rows.map((row) => cells(row)[0])
    expect(branches[0]).toContain('2-core')
    expect(branches[1]).toContain('3-git')
    expect(branches[2]).toContain('main')
    expect(branches[3]).toContain('7-web')

    expect(liveDot(rows[0]!)).toBe('active')
    expect(liveDot(rows[1]!)).toBe('active')
    expect(liveDot(rows[3]!)).toBe('flatline')

    // Agent status (workmux) is independent of liveness: 7-web's agent last
    // reported "working" and never updated, even though its pane flatlined.
    const sevenWeb = cells(rows[3]!)
    expect(sevenWeb[1]).toBe('working')
    expect(sevenWeb[3]).toBe('6m ago')
    expect(sevenWeb[4]).toBe('0')
    expect(sevenWeb[5]).toBe('2')

    const core = cells(rows[0]!)
    expect(core[1]).toBe('working')
    expect(core[3]).toBe('2m ago')
    expect(core[4]).toBe('2')
    expect(core[5]).toBe('4')
    // No telemetry events in this fixture — cost and model stay honestly blank.
    expect(core[6]).toBe('—')
    expect(core[7]).toBe('—')

    const git = cells(rows[1]!)
    expect(git[1]).toBe('waiting')
    expect(git[4]).toBe('1')
    expect(git[5]).toBe('3')
    expect(git[6]).toBe('—')
    expect(git[7]).toBe('—')
  })
})

describe('WorktreesPanel — cost and model', () => {
  function findRow(rows: HTMLTableRowElement[], branchSubstring: string): HTMLTableRowElement {
    const row = rows.find((candidate) => cells(candidate)[0]?.includes(branchSubstring))
    if (row === undefined) throw new Error(`no row for branch "${branchSubstring}"`)
    return row
  }

  it('shows dollars when a lane is authoritative, tokens when it is not, per the per-lane spend selectors', () => {
    const { container } = renderPanel(fixtureTelemetrySession())
    const rows = bodyRows(container)

    // 2-core and 3-git both carry only authoritative OTel dollars.
    const core = cells(findRow(rows, '2-core'))
    expect(core[6]).toBe('$0.42')
    expect(core[7]).toBe('claude-opus-5')

    const git = cells(findRow(rows, '3-git'))
    expect(git[6]).toBe('$0.28')
    expect(git[7]).toBe('claude-opus-5')

    // 7-web's only cost event is an estimate, so the honest cell falls back to
    // output-led tokens (2_400), never the unlabelled all-tier sum (101_702).
    const web = cells(findRow(rows, '7-web'))
    expect(web[6]).toBe('2.4K out')
    expect(web[7]).toBe('claude-opus-5')

    // main never spent anything — stays blank, not a fabricated zero.
    const main = cells(findRow(rows, 'main'))
    expect(main[6]).toBe('—')
    expect(main[7]).toBe('—')
  })

  it('titles the cost cell with why it shows tokens instead of an estimate', () => {
    const { container } = renderPanel(fixtureTelemetrySession())
    const rows = bodyRows(container)
    const web = findRow(rows, '7-web')
    const costCell = web.querySelectorAll('td')[6]
    expect(costCell?.getAttribute('title')).toMatch(/estimate/i)

    const main = findRow(rows, 'main')
    const mainCostCell = main.querySelectorAll('td')[6]
    expect(mainCostCell?.getAttribute('title')).toMatch(/no telemetry/i)
  })

  it('names all four token tiers in the fallback tooltip, never just the total', () => {
    const { container } = renderPanel(fixtureTelemetrySession())
    const rows = bodyRows(container)
    const web = findRow(rows, '7-web')
    const costCell = web.querySelectorAll('td')[6]
    const title = costCell?.getAttribute('title') ?? ''
    expect(title).toMatch(/output/)
    expect(title).toMatch(/input/)
    expect(title).toMatch(/cache read/)
    expect(title).toMatch(/cache write/)
    expect(title).not.toContain('101.7K')
  })
})
