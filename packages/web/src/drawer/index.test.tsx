import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discloseText } from '../disclosure/testing.js'
import { StreamProvider } from '../app/StreamContext.js'
import { FleetProvider } from '../fleet/FleetContext.js'
import { MAIN_SELECTION } from '../fleet/index.js'
import type { FetchLike } from '../fleet/manifest.js'
import { SelectionProvider } from '../fleet/selection.js'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import { costCellText, outputCellText } from '../panels/fleet/format.js'
import LaneDrawer from './index.js'

/**
 * THE PEEK (prd-36 ruling 2 / S2, #562) — what used to be the four-tab drawer.
 *
 * S2's acceptance is two sentences and this file is those two sentences:
 * *a test asserts the peek issues no `/api/transcript` request*, and *a test
 * asserts it renders at most the four elements above* (vitals · latest activity
 * · one line of why · one action).
 *
 * Both are written so they cannot pass vacuously. The fetch assertion installs
 * a spy on the global `fetch` **and on the seam the drawer used to take**, and
 * a companion test proves the spy fires when something in the tree does reach
 * for the route — otherwise "no request was made" is indistinguishable from "no
 * component was mounted". The four-element assertion counts what is actually in
 * the DOM rather than checking four testids are present, because a fifth
 * element returning is exactly the regression S2 forbids and a positive check
 * cannot see it.
 */

afterEach(cleanup)

/** Pinned, so the fixture, the derived fleet and every age string are still. */
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

/** One lane's whole life, close enough to `NOW` that it reads as working. */
function laneHistory(): RhizomorphEvent[] {
  const f = createEventFactory({ startTs: NOW - 40_000, stepMs: 2_000 })
  return [
    f.sessionStarted({ repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' }),
    f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-main', isMain: true }),
    f.worktreeDiscovered({ path: WORKTREE, branch: LANE, head: 'sha-84', isMain: false }),
    f.paneDiscovered({
      paneId: '%7',
      sessionName: 'rhizomorph',
      windowName: LANE,
      windowIndex: 3,
      currentPath: WORKTREE,
      worktreePath: WORKTREE,
    }),
    // `model` is pinned to an id no vendored pricing pattern covers (prd9
    // ruling 7): this fixture's `$` cell means "no cost feed reached the
    // lane" (law 12), and the real default model (`claude-opus-5`) is now a
    // real vendored entry that would earn a selector-side estimate instead.
    f.llmUsage({
      lane: LANE,
      branch: LANE,
      worktreePath: WORKTREE,
      sessionId: 'sess-84',
      model: 'test-model-unpriced',
      thread: 'main',
      tokens: { input: 10, output: 4_200, cacheRead: 90_000, cacheCreation: 1_000 },
    }),
    f.toolActivity({ lane: LANE, branch: LANE, worktreePath: WORKTREE, sessionId: 'sess-84', tool: 'Read' }),
    f.toolActivity({ lane: LANE, branch: LANE, worktreePath: WORKTREE, sessionId: 'sess-84', tool: 'Write' }),
    f.worktreeDirty({
      path: WORKTREE,
      branch: LANE,
      files: [{ path: 'packages/web/src/drawer/index.tsx', status: 'added' }],
    }),
    f.commitLanded({
      branch: LANE,
      sha: 'abc1234def5678',
      message: 'feat(drawer): the lane peek\n\nbody',
      files: [{ path: 'packages/web/src/drawer/index.tsx', status: 'added' }],
      insertions: 90,
      deletions: 0,
      worktreePath: WORKTREE,
    }),
  ]
}

interface HarnessOptions {
  events?: RhizomorphEvent[]
  selected?: string | null
}

async function renderPeek(options: HarnessOptions = {}) {
  const events = options.events ?? laneHistory()
  let source: ScriptedEventSource | null = null

  const result = render(
    <StreamProvider
      url="/api/stream"
      now={NOW}
      createSource={() => {
        source = new ScriptedEventSource()
        return source
      }}
    >
      <FleetProvider now={NOW} fetchLanes={noLaneManifest}>
        <SelectionProvider initialSelectedId={options.selected === undefined ? LANE : options.selected}>
          <LaneDrawer />
        </SelectionProvider>
      </FleetProvider>
    </StreamProvider>,
  )

  await act(async () => {
    source?.onopen?.(new Event('open'))
    for (const event of events) {
      source?.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>)
    }
  })

  return result
}

describe('the peek renders nothing at all with nothing selected', () => {
  it('is not a panel — no frame, no heading, no empty state', async () => {
    const { container } = await renderPeek({ selected: null })
    expect(screen.queryByTestId('lane-drawer')).not.toBeInTheDocument()
    expect(container.textContent).toBe('')
  })
})

describe('the peek is four things and one action (S2)', () => {
  it('renders vitals, the latest activity line, one line of why, and the action', async () => {
    await renderPeek()

    expect(screen.getByTestId('drawer-vitals')).toBeInTheDocument()
    expect(screen.getByTestId('peek-latest-activity')).toBeInTheDocument()
    expect(screen.getByTestId('peek-why')).toBeInTheDocument()
    expect(screen.getByTestId('drawer-open-page')).toBeInTheDocument()
  })

  it('renders AT MOST those four — a fifth region returning is the regression', async () => {
    await renderPeek()
    const peek = screen.getByTestId('lane-drawer')

    // The frame's own header (title + Esc) plus exactly four content children.
    // Counted rather than asserted-about: a returning CONVERSATION tab, an
    // ATTACH button or a trace section would each be a fifth child here and
    // pass every positive check above.
    const regions = [...peek.children].filter((node) => node.tagName !== 'HEADER')
    expect(regions).toHaveLength(4)

    // …and none of the four tabs came back in any form.
    for (const tab of ['activity', 'conversation', 'why', 'trace']) {
      expect(screen.queryByTestId(`drawer-tab-${tab}`)).not.toBeInTheDocument()
    }
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.queryByTestId('drawer-attach')).not.toBeInTheDocument()
    expect(screen.queryByTestId('drawer-trace')).not.toBeInTheDocument()
    expect(screen.queryByTestId('drawer-conversation')).not.toBeInTheDocument()
  })

  it('quotes the vitals from the fleet table’s own cells, not its own arithmetic', async () => {
    await renderPeek()
    const vitals = screen.getByTestId('drawer-vitals')
    // The lane the fixture builds, formatted by `panels/fleet/format.ts` —
    // proving the peek and the row an operator just clicked cannot disagree.
    const lane = { outputTokens: 4_200, costEventCount: 0, costUsd: 0, costIsAuthoritative: null }
    expect(vitals.textContent).toContain(outputCellText(lane as never))
    expect(vitals.textContent).toContain(costCellText(lane as never))
  })

  it('discloses every vital, by hover and by focus alike (#220)', async () => {
    await renderPeek()
    const vitals = screen.getByTestId('drawer-vitals')

    // Twelve `<Vital>` call sites funnelled into one native `title=` before
    // #220; they now funnel into one `<Disclosure>` on the `<dd>`. Walking
    // them all rather than sampling one is the point: the funnel is what makes
    // this a single change, so a regression in it takes every vital with it.
    const marks = vitals.querySelectorAll('[data-testid="disclosure"]')
    expect(marks.length, 'the vitals grid discloses nothing').toBeGreaterThanOrEqual(6)

    for (const mark of marks) {
      // Throws unless the card opens on hover AND on focus with identical
      // markup, and unless it renders — which means its evidence and its age
      // survived `disclosureLines`.
      expect(discloseText(mark as HTMLElement).length).toBeGreaterThan(0)
    }
  })

  it('says the latest activity as one line — the newest thing the lane did', async () => {
    await renderPeek()
    // The commit is the last event in the fixture, so it is the top of the fold.
    expect(screen.getByTestId('peek-latest-activity').textContent).toContain('abc1234')
    expect(screen.getByTestId('peek-latest-activity').textContent).toContain('the lane peek')
  })

  it('says the honest absence when the fold holds no activity for the lane', async () => {
    const f = createEventFactory({ startTs: NOW - 40_000, stepMs: 2_000 })
    await renderPeek({
      events: [
        f.sessionStarted({ repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' }),
        f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-main', isMain: true }),
        f.worktreeDiscovered({ path: WORKTREE, branch: LANE, head: 'sha-84', isMain: false }),
      ],
    })
    expect(screen.getByTestId('peek-latest-activity').textContent).toContain('nothing recorded')
  })

  it('carries prd-30’s condition — the label and the reason, and not the remedy', async () => {
    await renderPeek()
    const why = screen.getByTestId('peek-why').textContent ?? ''
    // The label is the condition's own word (uppercased by the sheet, not by
    // this component — `selectLaneCondition` returns `working`).
    expect(screen.getByTestId('peek-why-label').textContent).toBe('working')
    expect(why).toContain('active within the last window')
    // The remedy is the run view's; a peek that carried it would invite acting
    // on a glance. `selectLaneCondition`'s remedies all read as instructions.
    expect(why).not.toMatch(/interrupt|check the pane|answer the lane/)
  })
})

describe('the peek never fetches (S2’s data source is the fold)', () => {
  /** A spy that answers every request, so a stray call is recorded rather than exploding. */
  function spyOnFetch() {
    const fetchSpy = vi.fn(async (_input: unknown) => ({ ok: false, status: 404, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchSpy)
    return fetchSpy
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('issues no /api/transcript request for a selected lane', async () => {
    const fetchSpy = spyOnFetch()
    await renderPeek()

    const asked = fetchSpy.mock.calls.map((call) => String(call[0]))
    expect(asked.filter((url) => url.startsWith('/api/transcript'))).toEqual([])
  })

  it('issues no /api/transcript request for MAIN either', async () => {
    const fetchSpy = spyOnFetch()
    await renderPeek({ selected: MAIN_SELECTION })
    expect(screen.getByTestId('drawer-main-vitals')).toBeInTheDocument()

    const asked = fetchSpy.mock.calls.map((call) => String(call[0]))
    expect(asked.filter((url) => url.startsWith('/api/transcript'))).toEqual([])
  })

  it('the spy bites — it records a transcript request when one is actually made', async () => {
    // Without this, both assertions above would be equally green against a
    // stub that never installed, a component that never mounted, or a spy
    // that recorded nothing at all.
    const fetchSpy = spyOnFetch()
    await fetch('/api/transcript/84-chat-drawer')
    expect(fetchSpy.mock.calls.map((call) => String(call[0]))).toEqual(['/api/transcript/84-chat-drawer'])
  })

  it('names no transcript route in its own source at all', async () => {
    // The structural half: `useTranscript` is not imported here any more, so
    // there is no seam through which a poll could be reintroduced without the
    // import showing up in a diff. `readonly.test.ts` sweeps the directory;
    // this pins the one file S2 is about.
    const [{ readFileSync }, path, { fileURLToPath }] = await Promise.all([
      import('node:fs'),
      import('node:path'),
      import('node:url'),
    ])
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.tsx'),
      'utf8',
    )
    // The component, not the barrel: this module still RE-EXPORTS the
    // transcript hook at the bottom for `why/NearestEntry.tsx`, which is the
    // run view's reader and legitimately fetches. What S2 forbids is the peek
    // itself reaching for it, so the sweep stops at the re-export block.
    const component = source.slice(0, source.indexOf('export { LaneDrawer }'))
    const code = component.replace(/\/\*[\s\S]*?\*\//g, ' ')
    expect(code).not.toMatch(/useTranscript|\/api\//)
    // …and the split itself is real, so this cannot pass by slicing to nothing.
    expect(component.length).toBeGreaterThan(1000)
    expect(source.slice(component.length)).toMatch(/useTranscript/)
  })
})

describe('the one action opens the run view (S2)', () => {
  it('is a real link to /lane/:handle, so modifier-click still opens a tab', async () => {
    await renderPeek()
    const action = screen.getByTestId('drawer-open-page')
    expect(action.tagName).toBe('A')
    expect(action.getAttribute('href')).toBe(`/lane/${LANE}`)
  })

  it('routes in place on a plain click rather than reloading', async () => {
    await renderPeek()
    try {
      await act(async () => {
        fireEvent.click(screen.getByTestId('drawer-open-page'), { button: 0 })
      })
      expect(window.location.pathname).toBe(`/lane/${LANE}`)
    } finally {
      window.history.replaceState(null, '', '/')
    }
  })

  it('MAIN’s action opens the conductor’s own run view', async () => {
    await renderPeek({ selected: MAIN_SELECTION })
    expect(screen.getByTestId('drawer-open-page').getAttribute('href')).toBe(`/lane/${MAIN_SELECTION}`)
  })

  it('a finished lane says so and the action still stands (S2’s *selected, finished*)', async () => {
    const f = createEventFactory({ startTs: NOW - 40_000, stepMs: 2_000 })
    await renderPeek({
      events: [
        ...laneHistory(),
        // The worktree goes away — `workmux merge`, the moment a person most
        // wants to read what happened.
        f.worktreeRemoved({ path: WORKTREE }),
      ],
    })

    expect(screen.getByTestId('peek-finished').textContent).toContain('worktree is gone')
    expect(screen.getByTestId('drawer-open-page').getAttribute('href')).toBe(`/lane/${LANE}`)
  })

  it('a lane that left the fleet entirely still offers the durable run view', async () => {
    await renderPeek({ selected: 'never-existed' })
    expect(screen.getByTestId('drawer-unknown-lane').textContent).toContain('never-existed')
    expect(screen.getByTestId('drawer-open-page').getAttribute('href')).toBe('/lane/never-existed')
  })
})
