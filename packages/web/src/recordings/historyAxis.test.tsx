import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ModeProvider } from '../app/ModeContext.js'
import { REPRESENTATION_INSTANCES } from '../fleet/TwoRepresentations.js'
import type { FetchLike } from '../replay/api.js'
import { CAPABILITY_META_NAME } from './capability.js'
import { laneOutcome } from './laneFormat.js'
import { parseLaneIndexPage } from './laneIndex.js'
import { RecordingsPage } from './RecordingsPage.js'

/**
 * THE HISTORY SURFACE'S TWO AXES (prd-31 ruling 8 / S4, #558).
 *
 * S4's acceptance, clause by clause: *both axes render from the same underlying
 * data*, *a lane in the lane axis opens its run view*, *a session opens into
 * replay*, *a rigged unreadable record is counted and voiced*, and *cost renders
 * with provenance in both axes*. Each has an `it` below and each is written so
 * it cannot pass for the wrong reason — the toggle is driven the way a person
 * drives it (the shared component's own keystroke and buttons), and the
 * unreadable case is *rigged*, not asserted about a fixture that happens to be
 * clean.
 */

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

const SESSION = {
  id: '1000',
  fileName: 'session-1000.jsonl',
  startedAt: 1000,
  sizeBytes: 4096,
  title: 'the morning run',
  label: 'the morning run',
  lanes: 2,
  landed: 1,
  durationMs: 65_000,
  outputTokens: 12_345,
  costUsd: 4.5,
  costIsAuthoritative: true,
}

/** Landed: a worktree that went away with commits behind it, across two sessions. */
const LANDED_LANE = {
  handle: '556-run-view',
  issue: '556',
  branch: '556-run-view',
  worktreeRemoved: true,
  firstSeenAt: 1_000,
  lastSeenAt: 121_000,
  missingSessionIds: [],
  sessions: [
    {
      sessionId: '1000',
      tokens: { output: 5_000 },
      costUsd: 2.5,
      costIsAuthoritative: true,
      commits: [{ sha: 'aaa1111' }],
    },
    {
      sessionId: '2000',
      tokens: { output: 3_000 },
      costUsd: 1.25,
      costIsAuthoritative: true,
      commits: [{ sha: 'bbb2222' }],
    },
  ],
}

/** No cost telemetry anywhere — the gap, not a zero. */
const NO_COST_LANE = {
  handle: '999-quiet',
  issue: '999',
  branch: '999-quiet',
  worktreeRemoved: false,
  firstSeenAt: 5_000,
  lastSeenAt: 6_000,
  missingSessionIds: [],
  sessions: [{ sessionId: '1000', tokens: { output: 700 }, costUsd: 0, costIsAuthoritative: null, commits: [] }],
}

interface IndexFixture {
  lanes?: unknown[]
  unreadableSessionIds?: string[]
  laneIndexOk?: boolean
}

function fetchImplFor(sessions: unknown[], index: IndexFixture = {}): FetchLike {
  return (async (url: string | URL | Request) => {
    const href = String(url)
    if (href === '/api/sessions') {
      return { ok: true, status: 200, json: async () => ({ sessions }) } as Response
    }
    if (href === '/api/lane-index') {
      if (index.laneIndexOk === false) return { ok: false, status: 404, json: async () => ({}) } as Response
      return {
        ok: true,
        status: 200,
        json: async () => ({
          lanes: index.lanes ?? [LANDED_LANE, NO_COST_LANE],
          unreadableSessionIds: index.unreadableSessionIds ?? [],
        }),
      } as Response
    }
    throw new Error(`unexpected fetch: ${href}`)
  }) as unknown as FetchLike
}

async function renderHistory(index: IndexFixture = {}, sessions: unknown[] = [SESSION]) {
  const fetchImpl = fetchImplFor(sessions, index)
  const utils = render(
    <ModeProvider fetchImpl={fetchImpl}>
      <RecordingsPage fetchImpl={fetchImpl} />
    </ModeProvider>,
  )
  await act(async () => {})
  return utils
}

/** The axis switch, driven the way a person drives it — the shared component's own control. */
async function showLaneAxis() {
  await act(async () => {
    fireEvent.click(screen.getByTestId('history-representation-lane'))
  })
}

describe('one surface, two axes (ruling 8)', () => {
  it('uses prd-36’s two-representation component rather than a third implementation', async () => {
    await renderHistory()

    // S4: "the same idiom as organism⇄list". Registered, so the law test
    // (`fleet/two-representations-law.test.ts`) starts holding this surface to
    // the keyboard behaviour and the persistence shape as well.
    const instance = REPRESENTATION_INSTANCES.find((entry) => entry.surface === 'history')
    expect(instance?.representations).toEqual(['session', 'lane'])
    expect(screen.getByTestId('history-representation-session')).toHaveAttribute('aria-pressed', 'true')
    // The component's own marker — a toggle drawn anywhere else in the package
    // fails the law.
    expect(document.querySelector('[data-representation-toggle="history"]')).not.toBeNull()
  })

  it('switches on the instance’s own keystroke, and back', async () => {
    await renderHistory()
    await waitFor(() => expect(screen.getByTestId('recordings-table')).toBeInTheDocument())

    await act(async () => {
      fireEvent.keyDown(window, { key: 'h' })
    })
    expect(screen.getByTestId('history-lane-table')).toBeInTheDocument()
    expect(screen.queryByTestId('recordings-table')).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.keyDown(window, { key: 'h' })
    })
    expect(screen.getByTestId('recordings-table')).toBeInTheDocument()
  })

  it('costs the switch no re-fetch — both axes are loaded before either is asked for', async () => {
    // prd-36 S1's third guarantee, which this instance inherits: "toggling
    // preserves selection, scroll position intent and any filter", and the
    // switch does not cost a re-fetch. A lazily-read lane index would make the
    // first toggle a spinner.
    const asked: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      asked.push(String(url))
      return fetchImplFor([SESSION])(url as never)
    }) as unknown as FetchLike

    render(
      <ModeProvider fetchImpl={fetchImpl}>
        <RecordingsPage fetchImpl={fetchImpl} />
      </ModeProvider>,
    )
    await act(async () => {})
    const before = asked.filter((href) => href === '/api/lane-index').length
    expect(before).toBe(1)

    await showLaneAxis()
    expect(screen.getByTestId('history-lane-table')).toBeInTheDocument()
    expect(asked.filter((href) => href === '/api/lane-index')).toHaveLength(before)
  })
})

describe('the lane axis (S4 — by lane)', () => {
  it('renders handle, issue, when, outcome, spend and the sessions it spans', async () => {
    await renderHistory()
    await showLaneAxis()

    const row = screen.getByTestId('history-lane-row-556-run-view')
    expect(row).toHaveTextContent('556-run-view')
    expect(row).toHaveTextContent('#556')
    expect(row).toHaveTextContent('landed')
    // 2.50 + 1.25, folded from the slices the server computed.
    expect(row).toHaveTextContent('$3.75')
    expect(row).toHaveTextContent('2 sessions')
  })

  it('OPENS: every lane in the axis has a run view to go to', async () => {
    // S4's first "what would make it wrong" is a lane that cannot be opened.
    await renderHistory()
    await showLaneAxis()

    for (const handle of ['556-run-view', '999-quiet']) {
      const link = screen.getByTestId(`history-lane-open-${handle}`)
      expect(link.tagName).toBe('A')
      expect(link.getAttribute('href')).toBe(`/lane/${handle}`)
    }

    await act(async () => {
      fireEvent.click(screen.getByTestId('history-lane-open-556-run-view'), { button: 0 })
    })
    expect(window.location.pathname).toBe('/lane/556-run-view')
  })

  it('renders cost with provenance, and never a fabricated $0.00', async () => {
    await renderHistory()
    await showLaneAxis()

    const quiet = screen.getByTestId('history-lane-row-999-quiet')
    expect(quiet).not.toHaveTextContent('$0.00')
    expect(quiet).toHaveTextContent('700 tok out')
    expect(screen.getByTestId('history-lane-cost-gap-999-quiet')).toBeInTheDocument()
  })

  it('reads a lane spanning an authoritative session and an estimated one as ESTIMATED', async () => {
    // The fold that matters, and the one a naive `every`/`some` gets backwards:
    // a lane is only as authoritative as its weakest session, so mixing must
    // not read as authoritative.
    const mixed = {
      ...LANDED_LANE,
      handle: '700-mixed',
      issue: '700',
      sessions: [
        { sessionId: '1000', tokens: { output: 10 }, costUsd: 1, costIsAuthoritative: true, commits: [] },
        { sessionId: '2000', tokens: { output: 10 }, costUsd: 1, costIsAuthoritative: false, commits: [] },
      ],
    }
    await renderHistory({ lanes: [mixed] })
    await showLaneAxis()

    const row = screen.getByTestId('history-lane-row-700-mixed')
    expect(row).toHaveTextContent('$2.00')
    expect(row).toHaveTextContent('est.')
  })

  it('says the honest gap when the index cannot be read at all — and the session axis is unaffected', async () => {
    await renderHistory({ laneIndexOk: false })
    await waitFor(() => expect(screen.getByTestId('recordings-table')).toBeInTheDocument())

    await showLaneAxis()
    expect(screen.getByTestId('history-lanes-error').textContent).toContain('NO LANE INDEX')

    // Law 12's "what is unaffected": the other axis still works.
    await act(async () => {
      fireEvent.click(screen.getByTestId('history-representation-session'))
    })
    expect(screen.getByTestId('recordings-table')).toBeInTheDocument()
  })
})

describe('the outcome column says only what the log can claim', () => {
  it('calls a removed worktree with commits behind it LANDED, and one without FOLDED', () => {
    expect(laneOutcome({ worktreeRemoved: true, commitCount: 2, lastSeenAt: 1 }).word).toBe('landed')
    expect(laneOutcome({ worktreeRemoved: true, commitCount: 2, lastSeenAt: 1 }).inferred).toBe(false)

    // A worktree that vanished with nothing behind it is abandoned or landed
    // elsewhere. Calling that "landed" would be the instrument inventing a
    // success out of an absence.
    expect(laneOutcome({ worktreeRemoved: true, commitCount: 0, lastSeenAt: 1 }).word).toBe('folded')
    // …and a lane still on disk with nothing behind it is neither.
    expect(laneOutcome({ worktreeRemoved: false, commitCount: 0, lastSeenAt: 1 }).word).toBe('no outcome')
  })

  it('marks everything softer as inferred, so it reads dim rather than as a finding', () => {
    expect(laneOutcome({ worktreeRemoved: false, commitCount: 3, lastSeenAt: 1 }).inferred).toBe(true)
    expect(laneOutcome({ worktreeRemoved: false, commitCount: 0, lastSeenAt: null }).word).toBe('—')
    expect(laneOutcome({ worktreeRemoved: false, commitCount: 0, lastSeenAt: null }).inferred).toBe(true)
  })
})

describe('an unreadable record is named and counted, never silently skipped (ADR-0011)', () => {
  it('voices a rigged unreadable recording, with its id and its count', async () => {
    await renderHistory({ unreadableSessionIds: ['4000', '5000'] })

    const notice = screen.getByTestId('history-unreadable')
    expect(notice.getAttribute('data-count')).toBe('2')
    expect(notice.textContent).toContain('4000')
    expect(notice.textContent).toContain('5000')
    expect(notice.textContent).toContain('incomplete')
  })

  it('is visible from BOTH axes, because it is a fact about the reading', async () => {
    await renderHistory({ unreadableSessionIds: ['4000'] })
    expect(screen.getByTestId('history-unreadable')).toBeInTheDocument()

    await showLaneAxis()
    expect(screen.getByTestId('history-unreadable')).toBeInTheDocument()
  })

  it('says nothing at all when every recording read', async () => {
    // The mutation: without this the assertions above would be equally green
    // against a notice that rendered unconditionally.
    await renderHistory()
    expect(screen.queryByTestId('history-unreadable')).not.toBeInTheDocument()
  })

  it('names the unreadable sessions a single LANE is missing, on its own row', async () => {
    const partial = { ...LANDED_LANE, handle: '800-partial', missingSessionIds: ['6000'] }
    await renderHistory({ lanes: [partial] })
    await showLaneAxis()

    const row = screen.getByTestId('history-lane-row-800-partial')
    expect(row).toHaveTextContent('1 unreadable')
    expect(row.querySelector('[title*="6000"]')).not.toBeNull()
  })

  it('voices the lines a recording lost, which the listing has carried and never shown', async () => {
    // prd17 ruling 3's own accounting: `unreadableLinesVoice` existed on every
    // listing and no surface rendered it, so a recording that lost lines looked
    // exactly like one that did not.
    await renderHistory({}, [{ ...SESSION, unreadableLinesVoice: 'could not read 3 lines' }])
    await waitFor(() => expect(screen.getByTestId('recordings-table')).toBeInTheDocument())

    expect(screen.getByTestId('recording-unreadable-lines-1000').textContent).toContain('could not read 3 lines')
  })
})

describe('the wire shape is re-declared and then CHECKED', () => {
  it('degrades a body from an unknown server to fewer facts, never to a thrown render', () => {
    expect(() => parseLaneIndexPage(null)).not.toThrow()
    expect(parseLaneIndexPage(null)).toEqual({ lanes: [], unreadableSessionIds: [] })
    expect(parseLaneIndexPage({ lanes: 'nope' })).toEqual({ lanes: [], unreadableSessionIds: [] })
    // A lane with no handle is not a lane; one with only a handle is.
    expect(parseLaneIndexPage({ lanes: [{}, { handle: 'x' }] }).lanes.map((l) => l.handle)).toEqual(['x'])
  })

  it('reads a handle-only lane as every-fact-unknown rather than as zeros', () => {
    const [lane] = parseLaneIndexPage({ lanes: [{ handle: 'x' }] }).lanes
    expect(lane?.costIsAuthoritative).toBeNull()
    expect(lane?.firstSeenAt).toBeNull()
    expect(lane?.sessionIds).toEqual([])
    expect(lane?.worktreeRemoved).toBe(false)
  })
})
