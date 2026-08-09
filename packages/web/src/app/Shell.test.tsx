import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
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
function laneHistory(): RhizomorphEvent[] {
  const f = createEventFactory({ startTs: NOW - 20_000, stepMs: 2_000 })
  return [
    f.sessionStarted({ repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' }),
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

/**
 * prd5 ruling 1+6 mounts `useIdleWorkerJump` here (`Shell()`'s own body) so
 * the idle-worker jump is page-global rather than any one panel's. This is
 * deliberately a smoke test, not a re-run of `app/keyboard.test.ts`'s own
 * coverage: it exists to prove the hook is actually wired into `Shell`
 * without breaking the Esc precedence chain the drawer tests above already
 * pin (untouched by this change — see `keyboard.ts`'s own comment on why
 * `f`/`a` do not live here at all).
 */
describe('Shell — the idle-worker jump (prd5 ruling 1+6)', () => {
  it('mounts the jump: "n" is a harmless no-op when nothing needs you, and Esc still closes the drawer', async () => {
    await renderShell(LANE)
    expect(screen.getByTestId('lane-drawer')).toBeInTheDocument()

    // The lane fixture here is a single quiet tool call — nothing on the
    // ladder — so "n" has nowhere to jump and must leave the open drawer be.
    await act(async () => {
      fireEvent.keyDown(window, { key: 'n' })
    })
    expect(screen.getByTestId('lane-drawer')).toBeInTheDocument()

    // The existing Esc chain (drawer/selection first) is untouched by
    // mounting the jump alongside it.
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(screen.queryByTestId('lane-drawer')).toBeNull()
  })
})

/**
 * THE PRIMARY NAV (#229, fourth hand added by #252/prd19 ruling 1) — before
 * #229, `/lab` and `/recordings` rendered complete surfaces with no anchor
 * anywhere in the UI; a stranger could only reach them by being told the
 * URL. This proves the balcony now carries a real, clickable way to each of
 * the four hands, and that exactly the one matching the current route reads
 * as active — never hardcoded to Observatory (the law #252 states: "exactly
 * one nav hand carries aria-current="page" on every route").
 */
describe('Shell — the primary nav (#229, #252)', () => {
  it('links to all four hands with real anchors, SPA-routed rather than a full reload', async () => {
    await renderShell(null)

    const observatory = screen.getByTestId('nav-observatory')
    const recordings = screen.getByTestId('nav-recordings')
    const lab = screen.getByTestId('nav-lab')
    const connect = screen.getByTestId('nav-connect')

    for (const link of [observatory, recordings, lab, connect]) {
      expect(link.tagName).toBe('A')
    }
    expect(observatory.getAttribute('href')).toBe('/')
    expect(recordings.getAttribute('href')).toBe('/recordings')
    expect(lab.getAttribute('href')).toBe('/lab')
    expect(connect.getAttribute('href')).toBe('/connect')
  })

  it('marks Observatory as the active link on the balcony route', async () => {
    await renderShell(null)

    expect(screen.getByTestId('nav-observatory').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('nav-recordings').getAttribute('aria-current')).toBeNull()
    expect(screen.getByTestId('nav-lab').getAttribute('aria-current')).toBeNull()
    expect(screen.getByTestId('nav-connect').getAttribute('aria-current')).toBeNull()
  })

  it('derives the active hand from the actual route rather than hardcoding Observatory (#252)', async () => {
    window.history.replaceState(null, '', '/connect')
    await renderShell(null)

    // Exactly one hand active, and it is the one the route actually names.
    // Honesty note (PR #285 review): in production the nav renders only on
    // the balcony — App's route switch mounts pages, not Shell, everywhere
    // else — so the old hardcoded check produced no *observable* bug. This
    // pins the abstraction's law for any tree that does mount the nav
    // off-balcony (#258's design question).
    expect(screen.getByTestId('nav-connect').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('nav-observatory').getAttribute('aria-current')).toBeNull()
    expect(screen.getByTestId('nav-recordings').getAttribute('aria-current')).toBeNull()
    expect(screen.getByTestId('nav-lab').getAttribute('aria-current')).toBeNull()

    window.history.replaceState(null, '', '/')
  })

  it('pins the deliberate fallback: a route with no matching hand activates Observatory', async () => {
    // activeHref's default arm maps every unhandled Route member (today:
    // lane) to '/'. A future route added without a case lands here too —
    // this makes the silent mapping a stated fact rather than an accident
    // (PR #285 review, seat B finding 2).
    window.history.replaceState(null, '', '/lane/some-handle')
    await renderShell(null)

    expect(screen.getByTestId('nav-observatory').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('nav-connect').getAttribute('aria-current')).toBeNull()
    expect(screen.getByTestId('nav-recordings').getAttribute('aria-current')).toBeNull()
    expect(screen.getByTestId('nav-lab').getAttribute('aria-current')).toBeNull()

    window.history.replaceState(null, '', '/')
  })

  it('navigates via pushState on a plain click, not a full reload', async () => {
    await renderShell(null)
    window.history.replaceState(null, '', '/')

    await act(async () => {
      fireEvent.click(screen.getByTestId('nav-connect'), { button: 0 })
    })

    expect(window.location.pathname).toBe('/connect')
    window.history.replaceState(null, '', '/')
  })

  it('leaves a modifier-clicked link to the browser default (new tab), same convention as the drawer', async () => {
    await renderShell(null)
    window.history.replaceState(null, '', '/')

    await act(async () => {
      fireEvent.click(screen.getByTestId('nav-recordings'), { button: 0, metaKey: true })
    })

    // preventDefault was skipped, so the SPA router never ran.
    expect(window.location.pathname).toBe('/')
  })
})

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
    // #163: one tab body at a time. #164: it opens on ACTIVITY, the tab most
    // reliably populated for any lane, live or folded — not on CONVERSATION,
    // which can be a gap voice alone.
    expect(screen.getByTestId('drawer-tab-activity').getAttribute('aria-selected')).toBe('true')
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

    expect(closedMarks).toEqual(['THE OBSERVATORY', 'Scene', 'Fleet', 'Ledger', 'Collisions', 'Activity'])
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
   * collapsed until asked for". prd4 ruling 4 retired that fold; #164 (ACTIVITY
   * now the default tab) means CONVERSATION goes back to not reading on open
   * either, but for a different reason — it simply is not the tab that
   * mounted. Either way, *nothing transcript-shaped* is requested while no
   * lane is selected, because then no drawer is mounted at all — that is the
   * half of the claim that matters, since it is what keeps a fleet-only page
   * silent on the drawer's own concern.
   *
   * #181 fallout: `StatusBar` (mounted here regardless of selection) now
   * fetches `/api/meta` once for its session voice — a real, independent
   * fetch this suite's blanket "nothing was requested" proxy predates.
   * `fetchSpy` needs a resolving default so that fetch doesn't crash the
   * effect, and the assertions below narrow to transcript calls specifically
   * — the thing this describe block is actually about.
   */
  function transcriptCalls(fetchSpy: ReturnType<typeof vi.fn>): unknown[][] {
    return fetchSpy.mock.calls.filter(([url]) => String(url).startsWith('/api/transcript'))
  }

  it('issues no transcript request while nothing is selected', async () => {
    const fetchSpy = vi.fn(async (input: string) => ({ ok: false, url: input, json: async () => null }))
    const original = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    try {
      await renderShell(null)
      expect(transcriptCalls(fetchSpy)).toHaveLength(0)
    } finally {
      globalThis.fetch = original
    }
  })

  it('issues no transcript request on open either — ACTIVITY is the default tab (#164), not CONVERSATION', async () => {
    const fetchSpy = vi.fn(async (input: string) => ({ ok: false, url: input, json: async () => null }))
    const original = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    try {
      await renderShell(LANE)
      expect(transcriptCalls(fetchSpy)).toHaveLength(0)
    } finally {
      globalThis.fetch = original
    }
  })

  it('reads the selected lane\'s conversation once its own tab is picked, and only ever GETs it', async () => {
    const fetchSpy = vi.fn(async (input: string) => ({ ok: false, url: input, json: async () => null }))
    const original = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    try {
      await renderShell(LANE)

      await act(async () => {
        fireEvent.click(screen.getByTestId('drawer-tab-conversation'))
      })

      // #134: the conversation opens at the tail, not offset zero.
      expect(transcriptCalls(fetchSpy).map((call) => call[0])).toEqual([
        `/api/transcript/${LANE}?tail=1`,
      ])
      // One argument: a URL. No init object means no verb but GET.
      expect(transcriptCalls(fetchSpy)[0]).toHaveLength(1)
    } finally {
      globalThis.fetch = original
    }
  })
})
