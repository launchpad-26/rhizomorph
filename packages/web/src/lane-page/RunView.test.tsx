import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createEventFactory, fixtureTraceSpans, type RhizomorphEvent } from '@rhizomorph/core'
import { afterEach, describe, expect, it } from 'vitest'
import { StreamProvider } from '../app/StreamContext.js'
import { FleetProvider } from '../fleet/FleetContext.js'
import type { FetchLike } from '../fleet/manifest.js'
import { SelectionProvider } from '../fleet/selection.js'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import { LanePage } from './LanePage.js'
import type { LaneIndexEntry, LaneIndexSlice } from './laneIndex.js'

afterEach(cleanup)

/**
 * THE RUN VIEW, AFTER THE LANE IS GONE (prd-31 ruling 5, S2 · #556).
 *
 * The ruling's acceptance is "a test deletes a worktree and asserts the page
 * still renders every region". The hard case is not the one where the worktree
 * is removed inside the session you are looking at — the fold still holds
 * everything then. It is the one where the lane's whole life is in a recording
 * **the page never loaded**, which is what a reader has a week later. So the
 * durability tests below stream a session about a *different* lane entirely and
 * then ask for `/lane/556-run-view`: the page has nothing but the lane index to
 * read from, and every region still has to render.
 */

const NOW = Date.UTC(2026, 7, 16, 20, 0, 0)
const LANE = '556-run-view'
const WORKTREE = '/repo-wt/556-run-view'
const SESSION_LIVE = '1000'
const SESSION_OLD = '900'

class ScriptedEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  close() {}
}

// ── the index's wire shape, as the server sends it ──────────────────────────

function slice(overrides: Partial<LaneIndexSlice> = {}): LaneIndexSlice {
  return {
    sessionId: SESSION_OLD,
    startedAt: Number(SESSION_OLD),
    label: null,
    recordingPresent: true,
    gap: null,
    firstTs: NOW - 3_600_000,
    lastTs: NOW - 3_000_000,
    branch: LANE,
    worktreePath: WORKTREE,
    worktreeRemoved: true,
    outputTokens: 41_200,
    costUsd: 0.31,
    costIsAuthoritative: false,
    estimateSources: ['langfuse-prices@cfac485'],
    toolCallCount: 9,
    toolCounts: { Edit: 4, Read: 5 },
    models: ['claude-opus-5'],
    interactionCount: 3,
    files: ['packages/web/src/lane-page/LanePage.tsx'],
    commits: [
      {
        sha: 'abc1234def5678',
        message: 'feat(lane-page): the run view (#556)',
        landedAt: NOW - 3_100_000,
        branch: LANE,
        fileCount: 4,
      },
    ],
    transcript: { captured: true, bytes: 4_096, reason: null },
    ...overrides,
  }
}

function entry(overrides: Partial<LaneIndexEntry> = {}): LaneIndexEntry {
  return {
    handle: LANE,
    issue: '556',
    aliases: [LANE],
    branch: LANE,
    worktreePath: WORKTREE,
    worktreeRemoved: true,
    firstSeenAt: NOW - 3_600_000,
    lastSeenAt: NOW - 3_000_000,
    sessions: [slice()],
    missingSessionIds: [],
    partialVoice: null,
    ...overrides,
  }
}

// ── the harness ─────────────────────────────────────────────────────────────

interface Harness {
  /** Events streamed into the fold — the recording the page has loaded. */
  events?: RhizomorphEvent[]
  /** The index body, or `null` for a 404 (an unknown handle). */
  index?: LaneIndexEntry | null
  handle?: string
  transcript?: FetchLike
}

/** Every URL the page asked for, in order — the outbound-call ledger. */
function ledger() {
  const urls: string[] = []
  return { urls, record: (url: string) => urls.push(url) }
}

/** A session about a lane that is NOT the one being opened. */
function otherLaneEvents(): RhizomorphEvent[] {
  const f = createEventFactory({ startTs: NOW - 60_000, stepMs: 1_000, idPrefix: 'other' })
  return [
    f.sessionStarted({ sessionId: SESSION_LIVE, repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' }),
    f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-main', isMain: true }),
    f.worktreeDiscovered({ path: '/repo-wt/999-elsewhere', branch: '999-elsewhere', head: 'sha-x', isMain: false }),
    f.llmUsage({
      lane: '999-elsewhere',
      branch: '999-elsewhere',
      worktreePath: '/repo-wt/999-elsewhere',
      sessionId: 'claude-x',
      model: 'test-model-unpriced',
      tokens: { input: 1, output: 10, cacheRead: 0, cacheCreation: 0 },
    }),
  ]
}

/** A session in which THIS lane works and then has its worktree removed. */
function laneThenRemovedEvents(): RhizomorphEvent[] {
  const f = createEventFactory({ startTs: NOW - 120_000, stepMs: 1_000, idPrefix: 'live' })
  return [
    f.sessionStarted({ sessionId: SESSION_LIVE, repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' }),
    f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-main', isMain: true }),
    f.worktreeDiscovered({ path: WORKTREE, branch: LANE, head: 'sha-1', isMain: false }),
    f.llmUsage({
      lane: LANE,
      branch: LANE,
      worktreePath: WORKTREE,
      sessionId: 'claude-1',
      model: 'test-model-unpriced',
      tokens: { input: 1, output: 4_200, cacheRead: 90_000, cacheCreation: 1_000 },
    }),
    ...fixtureTraceSpans({ lane: LANE, sessionId: 'claude-1', startTs: NOW - 100_000 }),
    f.commitLanded({
      branch: LANE,
      sha: 'abc1234def5678',
      message: 'feat(lane-page): the run view (#556)',
      files: [{ path: 'packages/web/src/lane-page/LanePage.tsx', status: 'modified' }],
      insertions: 90,
      deletions: 2,
      worktreePath: WORKTREE,
    }),
    // The deletion the ruling is about: `workmux merge`, mid-session.
    f.worktreeRemoved({ path: WORKTREE }),
  ]
}

async function renderRunView(options: Harness = {}) {
  const seen = ledger()
  const events = options.events ?? otherLaneEvents()
  const index = options.index === undefined ? entry() : options.index

  const fetchLaneIndex: FetchLike = async (url) => {
    seen.record(url)
    return index === null
      ? { ok: false, json: async () => ({ error: `NO LANE "${options.handle ?? LANE}" IN ANY RECORDING — searched every lane handle, branch, worktree name and issue number` }) }
      : { ok: true, json: async () => ({ lane: index, unreadableSessionIds: [] }) }
  }

  const fetchTranscript: FetchLike =
    options.transcript ??
    (async (url) => {
      seen.record(url)
      return {
        ok: true,
        json: async () => ({
          available: true,
          lane: LANE,
          sessionId: 'claude-1',
          offset: 0,
          nextOffset: 10,
          size: 10,
          eof: true,
          restarted: false,
          entries: [
            {
              ts: new Date(NOW - 100_000 + 1_000).toISOString(),
              role: 'assistant',
              blocks: [{ kind: 'text', text: "I'll add the lane index first. Then the run view can read it." }],
            },
          ],
        }),
      }
    })

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
      <FleetProvider now={NOW} fetchLanes={async () => ({ ok: false, json: async () => null })}>
        <SelectionProvider>
          <LanePage
            handle={options.handle ?? LANE}
            fetchTranscript={fetchTranscript}
            fetchLaneIndex={fetchLaneIndex}
            transcriptPollMs={0}
          />
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
  // Let the index request and the transcript's first read settle.
  await act(async () => {})
  await act(async () => {})

  return { ...utils, urls: seen.urls }
}

// ── the durability case ─────────────────────────────────────────────────────

describe('the run view renders for a lane whose worktree no longer exists', () => {
  it('renders every region from the index alone — the fold holds a different session entirely', async () => {
    await renderRunView()

    // The fold knows nothing about this lane: the page is reading history.
    expect(screen.getByTestId('lane-page')).toBeTruthy()
    expect(screen.queryByTestId('lane-page-unknown')).toBeNull()

    // Region 1 — identity and outcome, with evidence.
    expect(screen.getByTestId('run-outcome')).toBeTruthy()
    // Region 2 — the phase spine.
    expect(screen.getByTestId('run-spine')).toBeTruthy()
    // Region 3 — conversation beside trace.
    expect(screen.getByTestId('lane-page-conversation')).toBeTruthy()
    expect(screen.getByTestId('lane-page-trace')).toBeTruthy()
    // Region 4 — spend and activity, carried per recording on the spine.
    expect(screen.getByTestId('run-spine-output')).toBeTruthy()
    expect(screen.getByTestId('run-spine-cost')).toBeTruthy()
  })

  it('says the worktree is gone rather than reporting emptiness', async () => {
    await renderRunView()
    const gone = screen.getByTestId('run-worktree-gone')
    expect(gone.textContent).toContain('WORKTREE GONE')
    expect(gone.textContent).toContain(WORKTREE)
    expect(screen.getByTestId('lane-page')?.getAttribute('data-worktree-gone')).toBe('true')
  })

  it('claims its outcome WITH the commits that are its evidence', async () => {
    await renderRunView()
    expect(screen.getByTestId('run-outcome').getAttribute('data-outcome')).toBe('landed')
    const commits = screen.getAllByTestId('run-outcome-commit')
    expect(commits).toHaveLength(1)
    expect(commits[0]?.textContent).toContain('abc1234')
    expect(commits[0]?.textContent).toContain('#556')
  })

  it('refuses to call it LANDED when the worktree went with no commit behind it', async () => {
    // The mutation on the outcome claim: same removed worktree, no evidence.
    await renderRunView({ index: entry({ sessions: [slice({ commits: [] })] }) })
    expect(screen.getByTestId('run-outcome').getAttribute('data-outcome')).toBe('folded')
    expect(screen.getByTestId('run-outcome-no-evidence')).toBeTruthy()
  })

  it('reads the conversation out of the captured transcript, scoped to that recording', async () => {
    const { urls } = await renderRunView()
    // The one thing that makes a conversation legible after the worktree is
    // deleted: the request names the recording, so the route prefers the
    // capture beside it over a live path that no longer exists.
    expect(urls.some((url) => url.includes('/api/transcript/') && url.includes(`session=${SESSION_OLD}`))).toBe(true)
  })

  it('carries the identity a reader deep-linked to, with no fabricated live state', async () => {
    await renderRunView()
    const header = screen.getByTestId('lane-page-header')
    expect(header.textContent).toContain(LANE)
    expect(header.textContent).toContain('#556')
    expect(screen.getByTestId('lane-page-run-outcome').textContent).toBe('landed')
    // No state sigil: there is no live rank to glyph, and inventing one would
    // be reporting a measurement nothing made.
    expect(header.querySelector('svg[data-sigil]')).toBeNull()
    expect(screen.getByTestId('lane-page-branch').textContent).toBe(LANE)
  })

  it('makes no outbound call but the two reads it is built on', async () => {
    const { urls } = await renderRunView()
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      expect(url).toMatch(/^\/api\/(lane-index|transcript)\//)
    }
    // Nothing that could be a model call, by construction as well as by grep
    // (`interaction/no-model-call-law.test.ts`).
    expect(urls.some((url) => /anthropic|openai|summari/i.test(url))).toBe(false)
  })
})

describe('a lane spanning two recordings reads as one life', () => {
  const spanning = entry({
    sessions: [
      slice({ sessionId: SESSION_OLD, startedAt: Number(SESSION_OLD) }),
      slice({ sessionId: SESSION_LIVE, startedAt: Number(SESSION_LIVE), interactionCount: 1, commits: [] }),
    ],
  })

  it('shows one row per recording, oldest first', async () => {
    await renderRunView({ index: spanning })
    const rows = screen.getAllByTestId('run-spine-session')
    expect(rows.map((row) => row.getAttribute('data-session'))).toEqual([SESSION_OLD, SESSION_LIVE])
  })

  it('marks the recording the page actually loaded, and only that one', async () => {
    await renderRunView({ index: spanning })
    const loaded = screen
      .getAllByTestId('run-spine-session')
      .filter((row) => row.getAttribute('data-loaded') === 'true')
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.getAttribute('data-session')).toBe(SESSION_LIVE)
  })

  it('says where the other recording’s spans are rather than showing nothing', async () => {
    await renderRunView({ index: spanning })
    const elsewhere = screen.getAllByTestId('run-spine-elsewhere')
    expect(elsewhere).toHaveLength(1)
    expect(elsewhere[0]?.textContent).toContain(SESSION_OLD)
  })

  it('NAMES a missing recording instead of quietly shortening the life', async () => {
    const MISSING = '950'
    await renderRunView({
      index: entry({
        sessions: [
          slice({ sessionId: SESSION_OLD }),
          slice({
            sessionId: MISSING,
            startedAt: Number(MISSING),
            recordingPresent: false,
            gap: `RECORDING MISSING for session ${MISSING} — this lane's captured transcript is beside it but its event log is not`,
            outputTokens: 0,
            costIsAuthoritative: null,
            costUsd: 0,
            commits: [],
            interactionCount: 0,
          }),
        ],
        missingSessionIds: [MISSING],
        partialVoice: `1 session of this lane's 2 could not be read (${MISSING}) — this reading is partial`,
      }),
    })

    expect(screen.getByTestId('run-partial').textContent).toContain(MISSING)
    const gap = screen.getByTestId('run-spine-gap')
    expect(gap.textContent).toContain('RECORDING MISSING')
    expect(gap.textContent).toContain(MISSING)
    // No invented figures in the row that could not be read.
    const missingRow = screen
      .getAllByTestId('run-spine-session')
      .find((row) => row.getAttribute('data-session') === MISSING)
    expect(missingRow?.getAttribute('data-recording-present')).toBe('false')
    expect(missingRow?.textContent).not.toContain('$0.00')
  })

  it('is silent about partiality when the life is whole — the gap is not always on', async () => {
    await renderRunView({ index: spanning })
    expect(screen.queryByTestId('run-partial')).toBeNull()
    expect(screen.queryByTestId('run-spine-gap')).toBeNull()
  })
})

describe('the live lane keeps everything it had, and gains the run view', () => {
  it('renders the spine’s interaction cards for the recording it is holding', async () => {
    await renderRunView({
      events: laneThenRemovedEvents(),
      index: entry({ sessions: [slice({ sessionId: SESSION_LIVE, startedAt: Number(SESSION_LIVE) })] }),
    })

    // The loaded row opens by default — it is the one the reader came for.
    const cards = screen.getAllByTestId('interaction-card')
    expect(cards).toHaveLength(1)
    // The fixture's interaction: 14.1 s wall over 13.6 s of leaf spans. Both
    // round to 0:14 at the card's second resolution — the exact millisecond
    // arithmetic, and the mutation that breaks it, are `model.test.ts`'s.
    expect(screen.getByTestId('interaction-wall').textContent).toContain('0:14')
    expect(screen.getByTestId('interaction-work').textContent).toContain('0:14')
    // What the card is built on, asserted where it is visible: the leaves, and
    // never the containers that enclose them.
    fireEvent.mouseEnter(
      screen.getByTestId('interaction-why-gap').closest('[data-testid="disclosure"]') as HTMLElement,
    )
    expect(screen.getByTestId('disclosure-why').textContent).toContain('3 leaf spans summed')
  })

  it('quotes the agent’s own words on the card, verbatim from the transcript', async () => {
    await renderRunView({
      events: laneThenRemovedEvents(),
      index: entry({ sessions: [slice({ sessionId: SESSION_LIVE, startedAt: Number(SESSION_LIVE) })] }),
    })
    expect(screen.getByTestId('interaction-quote').textContent).toContain("I'll add the lane index first.")
  })

  it('still renders spend, activity and the why surface for a lane the fold knows', async () => {
    await renderRunView({
      events: laneThenRemovedEvents(),
      index: entry({ sessions: [slice({ sessionId: SESSION_LIVE, startedAt: Number(SESSION_LIVE) })] }),
    })
    expect(screen.getByTestId('lane-page-spend')).toBeTruthy()
    expect(screen.getByTestId('drawer-activity')).toBeTruthy()
    expect(screen.getByTestId('why-surface')).toBeTruthy()
  })

  it('degrades to what is loaded — never to nothing — when the index cannot answer', async () => {
    // A server older than this page has no `/api/lane-index`. The fold still
    // holds this lane, so the run view renders from it alone and says, in the
    // index's own words, which half of the reading is missing.
    await renderRunView({ events: laneThenRemovedEvents(), index: null })

    expect(screen.getAllByTestId('interaction-card')).toHaveLength(1)
    expect(screen.getAllByTestId('run-spine-session')).toHaveLength(1)
    expect(screen.getByTestId('run-index-gap').textContent).toContain('searched every lane handle')
    // With no index there is no commit list to justify an outcome word, and the
    // page says so rather than claiming one.
    expect(screen.getByTestId('run-outcome').getAttribute('data-outcome')).toBe('unknown')
    expect(screen.getByTestId('run-outcome-no-evidence')).toBeTruthy()
  })

  it('says the worktree is gone even mid-session, once the log has said so', async () => {
    await renderRunView({
      events: laneThenRemovedEvents(),
      index: entry({ sessions: [slice({ sessionId: SESSION_LIVE, startedAt: Number(SESSION_LIVE) })] }),
    })
    expect(screen.getByTestId('lane-page').getAttribute('data-worktree-gone')).toBe('true')
  })
})

describe('an unknown handle', () => {
  it('says what the SERVER searched, alongside what this session could see', async () => {
    await renderRunView({ handle: 'never-existed', index: null })

    expect(screen.getByTestId('lane-page-unknown').textContent).toContain('never-existed')
    expect(screen.getByTestId('lane-page-unknown').textContent).toContain('this session')
    const fromIndex = screen.getByTestId('lane-page-unknown-index')
    expect(fromIndex.textContent).toContain('searched every lane handle, branch, worktree name and issue number')
    expect(screen.queryByTestId('lane-page-header')).toBeNull()
  })

  it('offers the way back rather than a dead end', async () => {
    window.history.replaceState(null, '', '/lane/never-existed')
    await renderRunView({ handle: 'never-existed', index: null })
    await act(async () => {
      fireEvent.click(screen.getByTestId('lane-page-back'))
    })
    expect(window.location.pathname).toBe('/')
    window.history.replaceState(null, '', '/')
  })
})
