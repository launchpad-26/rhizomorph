import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { discloseText } from '../disclosure/testing.js'
import { ModeProvider } from '../app/ModeContext.js'
import type { FetchLike } from '../replay/api.js'
import { CAPABILITY_META_NAME } from './capability.js'
import { RecordingsPage } from './RecordingsPage.js'
import type { DownloadEnv } from './export.js'
import type { LabelFetchLike } from './label.js'

/** Stands in for what `server/static.ts` stamps into `index.html` on a real boot (#249). */
beforeAll(() => {
  const meta = document.createElement('meta')
  meta.setAttribute('name', CAPABILITY_META_NAME)
  meta.setAttribute('content', 'test-capability-token')
  document.head.appendChild(meta)
})

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/recordings')
})

const AUTHORITATIVE = {
  id: '1000',
  fileName: 'session-1000.jsonl',
  startedAt: 1000,
  sizeBytes: 4096,
  title: 'the morning run',
  label: 'the morning run',
  lanes: 3,
  landed: 2,
  durationMs: 65_000,
  outputTokens: 12_345,
  costUsd: 4.5,
  costIsAuthoritative: true,
}

const ESTIMATED = {
  id: '2000',
  fileName: 'session-2000.jsonl',
  startedAt: 2000,
  sizeBytes: 2048,
  title: '2 lanes, 1 landed',
  label: null,
  lanes: 2,
  landed: 1,
  durationMs: 30_000,
  outputTokens: 5_000,
  costUsd: 1.1,
  costIsAuthoritative: false,
}

const NO_COST_FEED = {
  id: '3000',
  fileName: 'session-3000.jsonl',
  startedAt: 3000,
  sizeBytes: 1024,
  title: 'no telemetry',
  label: null,
  lanes: 1,
  landed: 0,
  durationMs: 10_000,
  outputTokens: 900,
  costUsd: 0,
  costIsAuthoritative: null,
  transcriptCapture: null,
}

function fetchImplFor(
  recordings: unknown[],
  options: { comparisons?: unknown[]; comparisonReads?: Record<string, unknown> } = {},
): FetchLike {
  const comparisons = options.comparisons ?? []
  const comparisonReads = options.comparisonReads ?? {}
  return (async (url: string | URL | Request) => {
    const href = String(url)
    if (href === '/api/sessions') {
      return { ok: true, status: 200, json: async () => ({ sessions: recordings }) } as Response
    }
    // The lane axis's own read (#558) — answered rather than thrown, so these
    // session-axis tests are not quietly running beside a lane-index error
    // banner. The axis itself is exercised in `historyAxis.test.tsx`.
    if (href === '/api/lane-index') {
      return { ok: true, status: 200, json: async () => ({ lanes: [], unreadableSessionIds: [] }) } as Response
    }
    // The comparisons library row (prd-14 ruling 5, #214) — answered rather
    // than thrown by default, so every pre-existing session-axis test here is
    // not quietly running beside a swallowed comparisons-fetch error. The
    // section itself is exercised below.
    if (href === '/api/lab/comparisons') {
      return { ok: true, status: 200, json: async () => ({ comparisons }) } as Response
    }
    const readMatch = /^\/api\/lab\/comparisons\/([^/]+)$/.exec(href)
    if (readMatch !== null) {
      const id = readMatch[1] as string
      if (id in comparisonReads) {
        return { ok: true, status: 200, json: async () => comparisonReads[id] } as Response
      }
    }
    throw new Error(`unexpected fetch: ${href}`)
  }) as unknown as FetchLike
}

function renderPage(options: {
  recordings?: unknown[]
  comparisons?: unknown[]
  comparisonReads?: Record<string, unknown>
  fetchImpl?: FetchLike
  /** The balcony's own separate session-list fetch (`ModeContext`) — defaults to the same fixture as `fetchImpl`, distinct only where a test needs to tell the two caches apart. */
  modeFetchImpl?: FetchLike
  labelFetchImpl?: LabelFetchLike
  downloadEnv?: DownloadEnv
} = {}) {
  const fetchImpl =
    options.fetchImpl ??
    fetchImplFor(options.recordings ?? [AUTHORITATIVE, ESTIMATED, NO_COST_FEED], {
      comparisons: options.comparisons,
      comparisonReads: options.comparisonReads,
    })
  return render(
    <ModeProvider fetchImpl={options.modeFetchImpl ?? fetchImpl}>
      <RecordingsPage fetchImpl={fetchImpl} labelFetchImpl={options.labelFetchImpl} downloadEnv={options.downloadEnv} />
    </ModeProvider>,
  )
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

describe('RecordingsPage', () => {
  it('renders the persistent nav (#549, prd-32 ruling 10) — this surface was reachable by URL only before', async () => {
    window.history.replaceState(null, '', '/recordings')
    renderPage()

    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
    expect(screen.getByTestId('nav-recordings').getAttribute('aria-current')).toBe('page')
  })

  it('lists every recording with what GET /api/sessions already computed — nothing recomputed', async () => {
    renderPage()

    await waitFor(() => expect(screen.getByTestId('recordings-table')).toBeInTheDocument())

    expect(screen.getByTestId('rename-start-1000')).toHaveTextContent('the morning run')
    const row = screen.getByTestId('recording-row-1000')
    expect(row).toHaveTextContent('3') // lanes
    expect(row).toHaveTextContent('2') // landed
    expect(row).toHaveTextContent('1:05') // duration
    expect(row).toHaveTextContent('$4.50')
  })

  it('discloses cost provenance and capture state, identically by hover and by focus (#220)', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('recordings-table')).toBeInTheDocument())

    const row = screen.getByTestId('recording-row-2000')
    // `discloseText` opens each card both ways and refuses to return unless the
    // two markups match, so these are charter §6 assertions as much as content
    // ones. Named per column — a row has a card on more than one cell now.
    const cost = row.querySelector('[aria-label$=", cost"]')
    expect(cost, 'no cost disclosure on this row').not.toBeNull()
    expect(discloseText(cost as HTMLElement)).toContain('estimated')

    const capture = row.querySelector('[aria-label$=", capture"]')
    expect(capture, 'no capture disclosure on this row').not.toBeNull()
    expect(discloseText(capture as HTMLElement)).toMatch(/captur/)
  })

  it('shows the honest gap for an estimated cost — a real dollar figure, marked, not hidden', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('recordings-table')).toBeInTheDocument())

    const row = screen.getByTestId('recording-row-2000')
    expect(row).toHaveTextContent('$1.10')
    expect(row).toHaveTextContent('est.')
  })

  it('never renders a null costIsAuthoritative as $0 — tokens and the gap marker instead', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('recordings-table')).toBeInTheDocument())

    const row = screen.getByTestId('recording-row-3000')
    expect(row).not.toHaveTextContent('$0.00')
    expect(row).toHaveTextContent('900 tok out')
    expect(screen.getByTestId('recording-cost-gap-3000')).toBeInTheDocument()
  })

  it('says so honestly when transcript capture never ran for a session', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('recordings-table')).toBeInTheDocument())

    const row = screen.getByTestId('recording-row-3000')
    expect(row).toHaveTextContent('no transcripts captured')
    expect(screen.getByTestId('recording-capture-gap-3000')).toBeInTheDocument()
  })

  it('shows an empty state rather than a bare blank page', async () => {
    renderPage({ recordings: [] })
    await waitFor(() => expect(screen.getByTestId('recordings-empty')).toBeInTheDocument())
  })

  it('shows the fetch failure rather than silently rendering nothing', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as FetchLike
    renderPage({ fetchImpl })
    await waitFor(() => expect(screen.getByTestId('recordings-error')).toBeInTheDocument())
  })

  it('renaming a row updates its title in place, without a full reload of the page\'s own listing', async () => {
    const labelFetchImpl: LabelFetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ sessionId: '2000', label: 'renamed run' }),
    }))
    const fetchImpl = vi.fn(fetchImplFor([AUTHORITATIVE, ESTIMATED, NO_COST_FEED]))
    const modeFetchImpl = vi.fn(fetchImplFor([AUTHORITATIVE, ESTIMATED, NO_COST_FEED]))
    renderPage({ fetchImpl, modeFetchImpl, labelFetchImpl })
    await waitFor(() => expect(screen.getByTestId('recordings-table')).toBeInTheDocument())

    const initialCalls = fetchImpl.mock.calls.length
    const initialModeCalls = modeFetchImpl.mock.calls.length
    await click(screen.getByTestId('rename-start-2000'))
    await act(async () => {
      fireEvent.change(screen.getByTestId('rename-input-2000'), { target: { value: 'renamed run' } })
    })
    await click(screen.getByTestId('rename-save-2000'))

    expect(labelFetchImpl).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('rename-start-2000')).toHaveTextContent('renamed run')
    // No re-fetch of the page's own listing — the row updated from the save's own answer.
    expect(fetchImpl.mock.calls.length).toBe(initialCalls)
    // The balcony's separate session picker DOES get told to refresh, so it
    // does not keep showing the stale auto-title after this rename.
    await waitFor(() => expect(modeFetchImpl.mock.calls.length).toBeGreaterThan(initialModeCalls))
  })

  it('opening a row selects it in the existing replay session and returns to the balcony', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('recordings-table')).toBeInTheDocument())

    await click(screen.getByTestId('recording-open-1000'))

    expect(window.location.pathname).toBe('/')
  })

  it('exporting a row triggers exactly one download of the portable record', async () => {
    const anchor = { href: '', download: '', click: vi.fn() }
    const downloadEnv: DownloadEnv = {
      createObjectURL: vi.fn(() => 'blob:fake'),
      revokeObjectURL: vi.fn(),
      createAnchor: vi.fn(() => anchor),
      appendAnchor: vi.fn(),
      removeAnchor: vi.fn(),
    }
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url)
      if (href === '/api/sessions') {
        return { ok: true, status: 200, json: async () => ({ sessions: [AUTHORITATIVE] }) } as Response
      }
      if (href === '/api/meta') {
        return { ok: true, status: 200, json: async () => ({ repoName: 'demo' }) } as Response
      }
      if (href === '/api/sessions/1000/events') {
        return { ok: true, status: 200, json: async () => ({ events: [] }) } as Response
      }
      throw new Error(`unexpected fetch: ${href}`)
    }) as unknown as FetchLike

    renderPage({ fetchImpl, downloadEnv })
    await waitFor(() => expect(screen.getByTestId('recordings-table')).toBeInTheDocument())

    await click(screen.getByTestId('recording-export-1000'))
    await waitFor(() => expect(anchor.click).toHaveBeenCalledTimes(1))
    expect(anchor.download).toBe('demo-1000.rhizorecord.json')
  })

  it('renders no live-fleet surface — no scene, no panel, no fleet strip', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('recordings-table')).toBeInTheDocument())

    expect(screen.queryByTestId('fleet-table')).toBeNull()
    expect(document.querySelector('[data-panel]')).toBeNull()
  })

  describe('comparisons (prd-14 ruling 5, #214)', () => {
    const AVAILABLE = { id: 'c1', sizeBytes: 512, available: true, savedAt: '2026-09-01T00:00:00.000Z', arms: 2 }
    const REFUSED = { id: 'c2', sizeBytes: 64, available: false, reason: 'unsupported comparison artifact version: 3' }
    const ARTIFACT = {
      version: 1,
      savedAt: '2026-09-01T00:00:00.000Z',
      input: {
        arms: [
          { id: 'a1', model: 'opus', brief: 'x', runs: [{ id: 'r1', status: 'complete', verdict: 'pass', value: 4 }] },
          { id: 'a2', model: 'sonnet', brief: 'y', runs: [{ id: 'r2', status: 'complete', verdict: 'pass', value: 2 }] },
        ],
      },
    }

    it('lists a saved comparison as its own kind — a separate table, never a session row with a different label', async () => {
      renderPage({ comparisons: [AVAILABLE] })
      await waitFor(() => expect(screen.getByTestId('comparisons-table')).toBeInTheDocument())

      // The existing session table is untouched: still there, still exactly
      // the fixture rows this describe block did not pass — this issue adds a
      // kind, it does not re-cut the list.
      expect(screen.getByTestId('recordings-table')).toBeInTheDocument()
      expect(screen.getByTestId('recording-row-1000')).toBeInTheDocument()

      const row = screen.getByTestId('comparison-row-c1')
      expect(row).toHaveTextContent('2026-09-01T00:00:00.000Z')
      expect(row).toHaveTextContent('2') // arms
      expect(screen.getByTestId('comparison-open-c1')).toBeInTheDocument()
    })

    it('renders nothing when there are no saved comparisons — no permanent empty section', async () => {
      renderPage({ comparisons: [] })
      await waitFor(() => expect(screen.getByTestId('recordings-table')).toBeInTheDocument())

      expect(screen.queryByTestId('comparisons-table')).toBeNull()
      expect(screen.queryByTestId('comparisons-heading')).toBeNull()
    })

    it('a refused row in the LIST shows its own parser refusal inline, by name', async () => {
      renderPage({ comparisons: [REFUSED] })
      await waitFor(() => expect(screen.getByTestId('comparisons-table')).toBeInTheDocument())

      expect(screen.getByTestId('comparison-refused-c2')).toHaveTextContent('unsupported comparison artifact version: 3')
      expect(screen.queryByTestId('comparison-open-c2')).toBeNull()
    })

    it('selecting an available comparison reopens it into ComparisonSurface, not the replay surface', async () => {
      renderPage({ comparisons: [AVAILABLE], comparisonReads: { c1: { id: 'c1', available: true, artifact: ARTIFACT } } })
      await waitFor(() => expect(screen.getByTestId('comparisons-table')).toBeInTheDocument())

      await click(screen.getByTestId('comparison-open-c1'))

      await waitFor(() => expect(screen.getByTestId('comparison-surface')).toBeInTheDocument())
      // Never the replay surface — the URL stays on the recordings library.
      expect(window.location.pathname).toBe('/recordings')
      expect(screen.getAllByTestId('arm-panel')).toHaveLength(2)
      expect(screen.queryByTestId('recordings-table')).toBeNull()

      await click(screen.getByTestId('comparison-open-close'))
      await waitFor(() => expect(screen.getByTestId('recordings-table')).toBeInTheDocument())
    })

    /**
     * REVIEW ROUND 2, BLOCKING FINDING 1: a reviewer saved a duration
     * comparison, reopened it, and found the value rendered under a `cost`
     * basis (`data-measure="cost"`), because `ComparisonSurface`'s own
     * default filled the gap a reopened artifact cannot know. The artifact
     * schema carries no measure at all (`compare/types.ts`), so this asserts
     * the honest alternative: no measure claimed, ever, on this path — not
     * that some particular wrong one is avoided.
     *
     * REVIEW ROUND 3: round 2's own fix kept the numeric spread and only
     * dropped its label — which is exactly wrong for a `verified`-saved
     * comparison, whose `Run.value` is `1`/`0` and not a quantity at all.
     * `ComparisonSurface.test.tsx` carries the dedicated case for that
     * (`arm-basis-unknown`, no `arm-spread`, no `arm-verified-counts`); this
     * test stays scoped to what `RecordingsPage` itself owns — the reopen
     * wiring — and now asserts no spread renders here either, for the same
     * reason.
     */
    it('never claims a measure on reopen — the artifact carries none, so none is guessed, and no numeric summary is shown', async () => {
      const DURATION_ARTIFACT = {
        version: 1,
        savedAt: '2026-09-01T00:00:00.000Z',
        input: {
          arms: [
            {
              id: 'a1',
              model: 'opus',
              brief: 'x',
              runs: [
                { id: 'r1', status: 'complete', verdict: 'pass', value: 300 },
                { id: 'r2', status: 'complete', verdict: 'pass', value: 300 },
                { id: 'r3', status: 'complete', verdict: 'pass', value: 300 },
              ],
            },
          ],
        },
      }
      renderPage({
        comparisons: [AVAILABLE],
        comparisonReads: { c1: { id: 'c1', available: true, artifact: DURATION_ARTIFACT } },
      })
      await waitFor(() => expect(screen.getByTestId('comparisons-table')).toBeInTheDocument())

      await click(screen.getByTestId('comparison-open-c1'))

      await waitFor(() => expect(screen.getByTestId('comparison-surface')).toBeInTheDocument())
      expect(screen.getByTestId('comparison-surface').hasAttribute('data-measure')).toBe(false)
      expect(screen.getByTestId('comparison-basis').textContent).toMatch(/measure not recorded/)
      // No numeric summary at all — an unknown basis cannot support one.
      expect(screen.queryByTestId('arm-spread')).toBeNull()
      expect(screen.getByTestId('arm-basis-unknown')).toBeInTheDocument()
      // The run itself still shows its verdict, never the raw 300.
      expect(screen.getByTestId('run-dots').textContent).toContain('passed')
      expect(screen.getByTestId('run-dots').textContent).not.toContain('300')
    })

    /**
     * THE MUTATION THE REVIEWER NAMED EXACTLY, AT THE `RecordingsPage` LEVEL:
     * a saved "verified" comparison, reopened through the real reopen flow
     * (not a direct `ComparisonSurface` render), must not render a numeric
     * spread. `1`/`0` is `fromExperiment`'s own `verified` encoding — reached
     * in one operator act (switch to verified, save, reopen) — and reverting
     * the `measure === null` branch in `ArmPanel` reddens this: `arm-spread`
     * would exist and read `min 0 · median 1 · max 1`.
     */
    it('a saved "verified" comparison, reopened, never renders a numeric spread over its 1/0 encoding', async () => {
      const VERIFIED_ARTIFACT = {
        version: 1,
        savedAt: '2026-09-01T00:00:00.000Z',
        input: {
          arms: [
            {
              id: 'a1',
              model: 'opus',
              brief: 'x',
              runs: [
                { id: 'r1', status: 'complete', verdict: 'pass', value: 1 },
                { id: 'r2', status: 'complete', verdict: 'fail', value: 0 },
                { id: 'r3', status: 'complete', verdict: 'pass', value: 1 },
              ],
            },
          ],
        },
      }
      renderPage({
        comparisons: [AVAILABLE],
        comparisonReads: { c1: { id: 'c1', available: true, artifact: VERIFIED_ARTIFACT } },
      })
      await waitFor(() => expect(screen.getByTestId('comparisons-table')).toBeInTheDocument())

      await click(screen.getByTestId('comparison-open-c1'))

      await waitFor(() => expect(screen.getByTestId('comparison-surface')).toBeInTheDocument())
      expect(screen.queryByTestId('arm-spread')).toBeNull()
      expect(screen.queryByTestId('arm-verified-counts')).toBeNull()
      expect(screen.getByTestId('arm-basis-unknown')).toBeInTheDocument()
    })

    /**
     * THE MUTATION THIS TEST SURVIVES, NAMED IN THE ISSUE ITSELF: a test that
     * asserts only "the library still renders" survives a surface that shows
     * an empty state or swallows the refusal into a console error. This
     * asserts the parser's own sentence is the text on screen — the assertion
     * that actually matters.
     */
    it("an artifact from an older format version puts the parser's refusal on screen BY NAME when reopened — never an empty state, never a console error", async () => {
      renderPage({
        comparisons: [AVAILABLE],
        comparisonReads: { c1: { id: 'c1', available: false, reason: 'unsupported comparison artifact version: 3' } },
      })
      await waitFor(() => expect(screen.getByTestId('comparisons-table')).toBeInTheDocument())

      await click(screen.getByTestId('comparison-open-c1'))

      await waitFor(() => expect(screen.getByTestId('comparison-open-refused')).toBeInTheDocument())
      expect(screen.getByTestId('comparison-open-refused')).toHaveTextContent('unsupported comparison artifact version: 3')
      expect(screen.queryByTestId('comparison-surface')).toBeNull()
    })

    /**
     * PRD14 RULING 6: a v2 artifact restores the measure switch on a
     * REOPENED comparison — the whole point of storing facts instead of one
     * resolved value. Switching to `duration` here must re-derive through
     * `runForMeasure` and show the durations this artifact actually carries,
     * not the `cost` it opened on.
     */
    it('a v2 comparison reopens with a real measure switch, and switching measure re-derives the summary from the stored facts', async () => {
      const V2_ARTIFACT = {
        version: 2,
        savedAt: '2026-09-11T00:00:00.000Z',
        measure: 'cost',
        provenance: { verifyCommand: 'npm test', source: 'compare-cli', measuredAt: 1000 },
        input: {
          arms: [
            {
              id: 'a1',
              model: 'opus',
              brief: 'x',
              runs: [
                { id: 'r1', status: 'complete', verdict: 'pass', cost: 4, duration: 900, commits: 2 },
                { id: 'r2', status: 'complete', verdict: 'pass', cost: 6, duration: 700, commits: 1 },
                { id: 'r3', status: 'complete', verdict: 'pass', cost: 8, duration: 500, commits: 3 },
              ],
            },
          ],
        },
      }
      renderPage({
        comparisons: [AVAILABLE],
        comparisonReads: { c1: { id: 'c1', available: true, artifact: V2_ARTIFACT } },
      })
      await waitFor(() => expect(screen.getByTestId('comparisons-table')).toBeInTheDocument())

      await click(screen.getByTestId('comparison-open-c1'))

      await waitFor(() => expect(screen.getByTestId('comparison-surface')).toBeInTheDocument())
      expect(screen.getByTestId('comparison-surface').getAttribute('data-measure')).toBe('cost')
      expect(screen.getByTestId('measure-switch')).toBeInTheDocument()
      expect(screen.getByTestId('arm-spread')).toHaveTextContent('min 4 · median 6 · max 8')

      await click(screen.getByTestId('measure-duration'))

      expect(screen.getByTestId('comparison-surface').getAttribute('data-measure')).toBe('duration')
      expect(screen.getByTestId('arm-spread')).toHaveTextContent('min 500 · median 700 · max 900')
    })

    /**
     * PRD14 RULING 6's second certified mutation: a v2 artifact whose
     * `measure` was dropped (never written, or stripped after the fact)
     * still READS — the surface falls back to the same verdict-only,
     * no-summary treatment a v1 artifact has always had, and never guesses a
     * basis.
     */
    it('a v2 comparison with its measure dropped falls back to the v1 no-summary path, and offers no switch', async () => {
      const V2_NO_MEASURE = {
        version: 2,
        savedAt: '2026-09-11T00:00:00.000Z',
        input: {
          arms: [
            {
              id: 'a1',
              model: 'opus',
              brief: 'x',
              runs: [
                { id: 'r1', status: 'complete', verdict: 'pass', cost: 4, duration: 900, commits: 2 },
                { id: 'r2', status: 'complete', verdict: 'pass', cost: 6, duration: 700, commits: 1 },
                { id: 'r3', status: 'complete', verdict: 'pass', cost: 8, duration: 500, commits: 3 },
              ],
            },
          ],
        },
      }
      renderPage({
        comparisons: [AVAILABLE],
        comparisonReads: { c1: { id: 'c1', available: true, artifact: V2_NO_MEASURE } },
      })
      await waitFor(() => expect(screen.getByTestId('comparisons-table')).toBeInTheDocument())

      await click(screen.getByTestId('comparison-open-c1'))

      await waitFor(() => expect(screen.getByTestId('comparison-surface')).toBeInTheDocument())
      expect(screen.getByTestId('comparison-surface').hasAttribute('data-measure')).toBe(false)
      expect(screen.queryByTestId('measure-switch')).toBeNull()
      expect(screen.getByTestId('comparison-basis').textContent).toMatch(/measure not recorded/)
      expect(screen.getByTestId('arm-basis-unknown')).toBeInTheDocument()
      expect(screen.getByTestId('run-dots').textContent).toContain('passed')
      expect(screen.getByTestId('run-dots').textContent).not.toContain('4')
    })
  })
})
