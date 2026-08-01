import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createEventFactory, type ObservatoryEvent } from '@observatory/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FleetProvider } from '../fleet/FleetContext.js'
import type { FetchLike } from '../fleet/manifest.js'
import { SelectionProvider } from '../fleet/selection.js'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import { Shell } from './Shell.js'
import { StreamProvider } from './StreamContext.js'

/**
 * The panels are stubbed for the same reason `App.test.tsx` stubs them: this
 * file is about *what the shell mounts*, and a real fleet table or scene would
 * make it about them instead. The drawer is deliberately NOT stubbed — it is
 * the thing under test.
 */
vi.mock('../panels/attention/index.js', () => ({ default: () => <div>Attention strip</div> }))
vi.mock('../panels/burn/index.js', () => ({ default: () => <div>Burn strip</div> }))
vi.mock('../panels/fleet/index.js', () => ({ default: () => <h2>Fleet</h2> }))
vi.mock('../panels/ledger/index.js', () => ({ default: () => <h2>Ledger</h2> }))
vi.mock('../panels/collisions/index.js', () => ({ default: () => <h2>Collisions</h2> }))
vi.mock('../panels/feed/index.js', () => ({ default: () => <h2>Activity</h2> }))
vi.mock('../scene/index.js', () => ({ default: () => <div>Scene stub</div> }))

afterEach(cleanup)

/** Pinned, so nothing in the derived fleet moves on a timer under the test. */
const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

const LANE = '84-chat-drawer'
const WORKTREE = '/repo-wt/84-chat-drawer'

const noLaneManifest: FetchLike = async () => ({ ok: false, json: async () => null })

class ScriptedEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  close() {}
}

/** Just enough log for one real lane to exist in the derived fleet. */
function laneHistory(): ObservatoryEvent[] {
  const f = createEventFactory({ startTs: NOW - 20_000, stepMs: 2_000 })
  return [
    f.sessionStarted({ repoPath: '/repo', repoName: 'observatory', mainBranch: 'main' }),
    f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-main', isMain: true }),
    f.worktreeDiscovered({ path: WORKTREE, branch: LANE, head: 'sha-84', isMain: false }),
    f.toolActivity({ lane: LANE, branch: LANE, worktreePath: WORKTREE, sessionId: 'sess-84', tool: 'Read' }),
  ]
}

/**
 * Preloads every lazily-imported module *before* mounting, then flushes React's
 * one mandatory suspend-then-resume tick with `act`. Same reasoning as
 * `App.test.tsx`: `lazy()` suspends for at least one promise tick even on a
 * stubbed module, and racing that tick against a timed `waitFor` deadline is
 * the flake class this suite must not reintroduce (ruling 33).
 */
async function renderShell(selected: string | null) {
  await Promise.all([
    import('../panels/attention/index.js'),
    import('../panels/burn/index.js'),
    import('../panels/fleet/index.js'),
    import('../panels/ledger/index.js'),
    import('../panels/collisions/index.js'),
    import('../panels/feed/index.js'),
    import('../scene/index.js'),
    import('../drawer/index.js'),
  ])

  let source: ScriptedEventSource | null = null
  const utils = render(
    <StreamProvider
      url="/api/stream"
      now={NOW}
      createSource={() => {
        source = new ScriptedEventSource()
        return source
      }}
    >
      <FleetProvider now={NOW} fetchLanes={noLaneManifest}>
        <SelectionProvider initialSelectedId={selected}>
          <Shell />
        </SelectionProvider>
      </FleetProvider>
    </StreamProvider>,
  )

  await act(async () => {
    source?.onopen?.(new Event('open'))
    for (const event of laneHistory()) {
      source?.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>)
    }
  })

  return utils
}

describe('Shell — the lane drawer mount (ruling 17)', () => {
  it('mounts no drawer while nothing is selected', async () => {
    await renderShell(null)

    expect(screen.getByText('Fleet')).toBeInTheDocument()
    expect(screen.queryByTestId('lane-drawer')).toBeNull()
  })

  it('mounts the drawer on the selected lane', async () => {
    await renderShell(LANE)

    const drawer = screen.getByTestId('lane-drawer')
    expect(drawer.getAttribute('data-lane')).toBe(LANE)
    expect(screen.getByTestId('drawer-vitals')).toBeInTheDocument()
    expect(screen.getByTestId('drawer-activity')).toBeInTheDocument()
    expect(screen.getByTestId('drawer-attach')).toBeInTheDocument()
  })

  it('keeps the fleet visible beside it — it is a drawer, not a page', async () => {
    await renderShell(LANE)

    expect(screen.getByTestId('lane-drawer')).toBeInTheDocument()
    expect(screen.getByText('Fleet')).toBeInTheDocument()
    expect(screen.getByText('Attention strip')).toBeInTheDocument()
    expect(screen.getByText('THE OBSERVATORY')).toBeInTheDocument()
  })

  it('unmounts the drawer when Esc clears the selection', async () => {
    await renderShell(LANE)
    expect(screen.getByTestId('lane-drawer')).toBeInTheDocument()

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })

    expect(screen.queryByTestId('lane-drawer')).toBeNull()
    expect(screen.getByText('Fleet')).toBeInTheDocument()
  })

  it('leaves the curated order untouched whether the drawer is open or shut', async () => {
    const closed = await renderShell(null)
    const closedMarks = [...closed.container.querySelectorAll('h1, h2')].map((node) => node.textContent)
    cleanup()

    const open = await renderShell(LANE)
    const openMarks = [...open.container.querySelectorAll('h1, h2')]
      .map((node) => node.textContent)
      // The drawer's own heading is the lane name; the sequence beneath it is
      // what must not have moved.
      .filter((mark) => mark !== LANE)

    expect(closedMarks).toEqual(['THE OBSERVATORY', 'Fleet', 'Scene', 'Ledger', 'Collisions', 'Activity'])
    expect(openMarks).toEqual(closedMarks)
  })

  it('is out of flow, so it adds no row to the shell grid', async () => {
    await renderShell(LANE)

    const drawer = screen.getByTestId('lane-drawer')
    expect(drawer.className).toContain('fixed')
    expect(drawer.tagName).toBe('ASIDE')
  })

  /**
   * The pin this replaces said "no transcript request on mount — the tail is
   * collapsed until asked for". prd4 ruling 4 retires the fold: the
   * conversation is the drawer's main view and reads as soon as it is open. The
   * half of the claim that still holds — and is the half that matters, since it
   * is what keeps a fleet-only page silent — is that *nothing* is requested
   * while no lane is selected, because then no drawer is mounted at all.
   */
  it('issues no transcript request while nothing is selected', async () => {
    const fetchSpy = vi.fn()
    const original = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    try {
      await renderShell(null)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = original
    }
  })

  it('reads the selected lane\'s conversation once it is open, and only ever GETs it', async () => {
    const fetchSpy = vi.fn(async (input: string) => ({ ok: false, url: input, json: async () => null }))
    const original = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    try {
      await renderShell(LANE)

      expect(fetchSpy.mock.calls.map((call) => call[0])).toEqual([
        `/api/transcript/${LANE}?offset=0`,
      ])
      // One argument: a URL. No init object means no verb but GET.
      expect(fetchSpy.mock.calls[0]).toHaveLength(1)
    } finally {
      globalThis.fetch = original
    }
  })
})
