import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { FIXTURE_REPO_PATH, fixtureSession, fx } from '@observatory/core'
import { afterEach, describe, expect, it } from 'vitest'
import { StreamProvider } from '../../app/StreamContext.js'
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

  it('shows a calm empty state once connected with events but no collisions', () => {
    const { source } = renderPanel()
    act(() => source()?.open())
    act(() => source()?.emit(fx.sessionStarted()))
    act(() =>
      source()?.emit(
        fx.worktreeDiscovered({ path: FIXTURE_REPO_PATH, branch: 'main', isMain: true }),
      ),
    )

    expect(
      screen.getByText('No collisions — no two branches touch the same file.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Waiting for the stream…')).not.toBeInTheDocument()
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
})
