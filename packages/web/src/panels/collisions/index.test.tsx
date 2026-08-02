import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import {
  FIXTURE_REPO_PATH,
  createEventFactory,
  fixtureSession,
  initialSessionState,
  reduceAll,
  fx,
} from '@rhizomorph/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StreamProvider } from '../../app/StreamContext.js'
import { buildFleet } from '../../fleet/buildFleet.js'
import type { EventSourceLike } from '../../hooks/useEventStream.js'
import CollisionsPanel from './index.js'

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

function renderPanel() {
  let source: FakeEventSource | undefined
  const utils = render(
    <StreamProvider
      url="/api/stream"
      createSource={() => {
        source = new FakeEventSource()
        return source
      }}
    >
      <CollisionsPanel />
    </StreamProvider>,
  )
  return { ...utils, source: () => source }
}

describe('CollisionsPanel', () => {
  it('shows a waiting-for-stream state before any connection or data', () => {
    renderPanel()
    expect(screen.getByText('Collisions')).toBeInTheDocument()
    expect(screen.getByText('Waiting for the stream…')).toBeInTheDocument()
  })

  it('shows the ambient evidence line once connected with events but no collisions', () => {
    const { source } = renderPanel()
    act(() => source()?.open())
    act(() => source()?.emit(fx.sessionStarted()))
    act(() =>
      source()?.emit(
        fx.worktreeDiscovered({ path: FIXTURE_REPO_PATH, branch: 'main', isMain: true }),
      ),
    )

    // Never a bare "no collisions" — ruling 14 asks for the checked counts.
    expect(screen.getByText('collisions: 0 — checked 0 branches / 0 files')).toBeInTheDocument()
    expect(screen.queryByText('Waiting for the stream…')).not.toBeInTheDocument()
  })

  it("cannot disagree with the fleet ladder's own ALL CLEAR evidence", async () => {
    const f = createEventFactory({ stepMs: 1000 })
    const events = [
      f.sessionStarted({ mainBranch: 'main' }),
      f.worktreeDiscovered({ path: FIXTURE_REPO_PATH, branch: 'main', head: 'sha0', isMain: true }),
      f.worktreeDiscovered({
        path: `${FIXTURE_REPO_PATH}-wt/feature`,
        branch: 'feature',
        head: 'sha0',
        isMain: false,
      }),
      f.worktreeDirty({
        path: `${FIXTURE_REPO_PATH}-wt/feature`,
        branch: 'feature',
        files: [{ path: 'src/a.ts', status: 'modified' }],
      }),
    ]

    // Built independently of the component, straight from the same model layer
    // the strip reads — the ladder floor (g5) only exposes its evidence line
    // once every pathology and every collision is genuinely absent.
    const session = reduceAll(events, initialSessionState())
    const fleet = buildFleet(session, { now: f.now() })
    expect(fleet.ladder.rank).toBe('calm')
    const expectedLine = fleet.ladder.rank === 'calm' ? fleet.ladder.evidence.line : null

    const { source } = renderPanel()
    act(() => source()?.open())
    for (const event of events) act(() => source()?.emit(event))

    expect(await screen.findByText(expectedLine as string)).toBeInTheDocument()
  })

  it('renders the matrix from fixture events and glows the collided rows', async () => {
    const { source } = renderPanel()
    act(() => source()?.open())

    for (const event of fixtureSession()) {
      act(() => source()?.emit(event))
    }

    // packages/core/src/index.ts is touched by 2-core (commit), 3-git (dirty)
    // and 7-web (dirty) in the fixture — the three-way collision.
    await waitFor(() => expect(screen.getByTitle('packages/core/src/index.ts')).toBeInTheDocument())

    const columnHeaders = screen.getAllByRole('columnheader')
    expect(columnHeaders.map((header) => header.textContent)).toEqual([
      'File',
      'main',
      '2-core',
      '3-git',
      '7-web',
    ])

    const collidedCell = screen.getByTitle('packages/core/src/index.ts')
    const collidedRow = collidedCell.closest('tr')
    expect(collidedRow).toHaveAttribute('data-collided', 'true')
    expect(within(collidedRow as HTMLElement).getAllByText('●')).toHaveLength(3)

    // docs/architecture.md: 2-core (commit) vs 3-git (dirty) — also a collision.
    expect(screen.getByTitle('docs/architecture.md').closest('tr')).toHaveAttribute(
      'data-collided',
      'true',
    )

    // packages/web/src/app/Shell.tsx: only 7-web has touched it.
    const soleRow = screen.getByTitle('packages/web/src/app/Shell.tsx').closest('tr')
    expect(soleRow).toHaveAttribute('data-collided', 'false')
    expect(within(soleRow as HTMLElement).getAllByText('●')).toHaveLength(1)

    // Collided rows sort ahead of the rest, worst contention first.
    const rowPaths = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.querySelector('td')?.title)
    expect(rowPaths[0]).toBe('packages/core/src/index.ts')
    expect(rowPaths.slice(0, 2)).toEqual(
      expect.arrayContaining(['packages/core/src/index.ts', 'docs/architecture.md']),
    )
  })

  it('shows the basename of a deep path, not a single truncated character', async () => {
    const { source } = renderPanel()
    act(() => source()?.open())

    const deepPath = 'packages/web/src/panels/collisions/index.tsx'
    act(() => source()?.emit(fx.sessionStarted()))
    act(() =>
      source()?.emit(fx.worktreeDiscovered({ path: FIXTURE_REPO_PATH, branch: 'main', isMain: true })),
    )
    act(() =>
      source()?.emit(
        fx.worktreeDirty({
          path: FIXTURE_REPO_PATH,
          branch: 'main',
          files: [{ path: deepPath, status: 'modified' }],
        }),
      ),
    )

    const cell = await screen.findByTitle(deepPath)
    expect(cell.textContent).toContain('index.tsx')
    expect(cell.textContent).not.toBe('p…')
    expect(cell.textContent?.length).toBeGreaterThan(2)
  })

  it('names each colliding pair as evidence, and clicking one scrolls/marks the matrix', async () => {
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView

    const { source } = renderPanel()
    act(() => source()?.open())
    for (const event of fixtureSession()) act(() => source()?.emit(event))

    await waitFor(() => expect(screen.getByTitle('packages/core/src/index.ts')).toBeInTheDocument())

    // 2-core × 3-git contend over two files (index.ts and architecture.md);
    // the worst-first file leads the evidence string (g4: never a bare label).
    const chip = screen.getByRole('button', {
      name: 'collision: 2-core × 3-git — packages/core/src/index.ts (+1 more)',
    })

    const targetRow = screen.getByTitle('packages/core/src/index.ts').closest('tr') as HTMLElement
    const otherRow = screen.getByTitle('packages/web/src/app/Shell.tsx').closest('tr') as HTMLElement
    expect(targetRow).toHaveAttribute('data-focused', 'false')

    act(() => chip.click())

    expect(scrollIntoView).toHaveBeenCalled()
    expect(targetRow).toHaveAttribute('data-focused', 'true')
    // Only the pointed-at pair's rows mark themselves — not every collided row.
    expect(otherRow).toHaveAttribute('data-focused', 'false')
  })

  it('keeps the needs-you hue confined to genuinely collided cells (law 9)', async () => {
    const { source } = renderPanel()
    act(() => source()?.open())
    for (const event of fixtureSession()) act(() => source()?.emit(event))

    await waitFor(() => expect(screen.getByTitle('packages/core/src/index.ts')).toBeInTheDocument())

    const collidedRow = screen.getByTitle('packages/core/src/index.ts').closest('tr') as HTMLElement
    for (const dot of within(collidedRow).getAllByText('●')) {
      expect(dot.className).toContain('text-needs-you')
    }

    // packages/web/src/app/Shell.tsx: only one branch touches it — no collision,
    // so its dot must carry no ladder hue at all.
    const soleRow = screen.getByTitle('packages/web/src/app/Shell.tsx').closest('tr') as HTMLElement
    const soleDot = within(soleRow).getByText('●')
    expect(soleDot.className).not.toMatch(/text-(needs-you|notice|broken|calm)/)

    // The evidence chip itself is the one other needs-you surface — never a
    // second colour standing in for the same alarm.
    const chips = screen.getAllByRole('button')
    expect(chips.length).toBeGreaterThan(0)
    for (const chip of chips) expect(chip.className).toContain('text-needs-you')
  })
})
