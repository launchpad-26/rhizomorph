import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createEventFactory, initialSessionState, reduce } from '@rhizomorph/core'
import { afterEach, describe, expect, it } from 'vitest'
import { ModeProvider, useReplay } from '../../app/ModeContext.js'
import { StreamProvider } from '../../app/StreamContext.js'
import { Conversation } from '../../drawer/Conversation.js'
import { FleetProvider } from '../../fleet/FleetContext.js'
import type { FetchLike } from '../../fleet/manifest.js'
import { SelectionProvider } from '../../fleet/selection.js'
import type { EventSourceLike } from '../../hooks/useEventStream.js'
import { TraceTree } from '../../trace/TraceTree.js'
import FeedPanel from '../feed/index.js'
import { SearchField } from './SearchField.js'
import { setSessionQuery } from './session.js'

/**
 * ONE SEARCH, THREE SURFACES (prd-31 ruling 4 / S3, #559).
 *
 * S3's acceptance: *filtering states the hidden count **on every surface it
 * touches***. So this file is one block per surface, each asserting the same
 * two things — the list narrows, and the surface says by how much — plus the
 * claim the three blocks together make and none of them makes alone: **it is
 * one query**, written once and read by all three, which is what makes it a
 * search over the session rather than three searches over three lists.
 */

afterEach(() => {
  setSessionQuery('')
  cleanup()
})

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)
const LANE = '84-search'
const WORKTREE = `/repo-wt/${LANE}`

const noLaneManifest: FetchLike = async () => ({ ok: false, json: async () => null })

class ScriptedEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  close() {}
}

/** Two commits, so a query can keep one and hide the other. */
function feedHistory() {
  const f = createEventFactory({ startTs: NOW - 60_000, stepMs: 1_000 })
  f.sessionStarted({ repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' })
  f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-main', isMain: true })
  f.worktreeDiscovered({ path: WORKTREE, branch: LANE, head: 'sha-84', isMain: false })
  f.commitLanded({
    branch: LANE,
    sha: 'aaa1111',
    message: 'feat(search): the retarget lands',
    files: [{ path: 'a.ts', status: 'added' }],
    insertions: 1,
    deletions: 0,
    worktreePath: WORKTREE,
  })
  f.commitLanded({
    branch: LANE,
    sha: 'bbb2222',
    message: 'chore(deps): bump the toolchain',
    files: [{ path: 'b.ts', status: 'added' }],
    insertions: 1,
    deletions: 0,
    worktreePath: WORKTREE,
  })
  return f.all()
}

async function renderFeed() {
  let source: ScriptedEventSource | null = null
  render(
    <StreamProvider
      url="/api/stream"
      now={NOW}
      createSource={() => {
        source = new ScriptedEventSource()
        return source
      }}
    >
      <FleetProvider now={NOW} fetchLanes={noLaneManifest}>
        <SelectionProvider>
          <SearchField surface="test" />
          <FeedPanel />
        </SelectionProvider>
      </FleetProvider>
    </StreamProvider>,
  )
  await act(async () => {
    source?.onopen?.(new Event('open'))
    for (const event of feedHistory()) {
      source?.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>)
    }
  })
}

async function type(value: string) {
  await act(async () => {
    fireEvent.change(screen.getByTestId('session-search-test'), { target: { value } })
  })
}

function entries(): HTMLElement[] {
  return screen.queryAllByTestId('feed-entry')
}

describe('the feed declares what it hid', () => {
  it('narrows the list and says the count, the total and the query', async () => {
    await renderFeed()
    const before = entries().length
    expect(before).toBeGreaterThanOrEqual(2)
    expect(screen.queryByTestId('session-search-hidden-feed')).not.toBeInTheDocument()

    await type('retarget')

    expect(entries()).toHaveLength(1)
    const line = screen.getByTestId('session-search-hidden-feed')
    expect(line.textContent).toContain(`1 of ${before} events`)
    expect(line.textContent).toContain(`${before - 1} hidden by “retarget”`)
    expect(line.getAttribute('data-hidden')).toBe(String(before - 1))
  })

  it('says what was searched when nothing matches, rather than going blank', async () => {
    await renderFeed()
    await type('zzzz-nothing-here')

    expect(entries()).toHaveLength(0)
    const line = screen.getByTestId('session-search-hidden-feed')
    expect(line.textContent).toContain('NO EVENTS MATCH “zzzz-nothing-here”')
    expect(line.textContent).toContain('in the loaded session were searched')
  })

  it('stops declaring anything once the query is cleared', async () => {
    await renderFeed()
    const before = entries().length

    await type('retarget')
    expect(screen.getByTestId('session-search-hidden-feed')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByTestId('session-search-clear-test'))
    })

    expect(entries()).toHaveLength(before)
    expect(screen.queryByTestId('session-search-hidden-feed')).not.toBeInTheDocument()
  })

  it('matches on words the row actually shows, and only those', async () => {
    await renderFeed()

    // The branch is rendered on a commit row, so it is fair game…
    await type(LANE)
    expect(entries().length).toBeGreaterThan(0)

    // …and the sha, which the commit row does not render, is not. A match on
    // an invisible fact makes the hidden count unexplainable from the screen.
    await type('aaa1111')
    expect(entries()).toHaveLength(0)
  })
})

/** One lane, two interactions, each with a distinctly-named tool under it. */
function traceState() {
  const f = createEventFactory({ startTs: NOW - 60_000, stepMs: 500 })
  f.sessionStarted({ repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' })
  f.worktreeDiscovered({ path: WORKTREE, branch: LANE, head: 'sha-84', isMain: false })

  const interaction = (traceId: string, tool: string, base: number) => {
    f.traceSpan({
      lane: LANE,
      branch: LANE,
      traceId,
      spanId: `${traceId}-root`,
      parentSpanId: null,
      kind: 'interaction',
      name: 'interaction',
      startTs: base,
      endTs: base + 4_000,
    })
    f.traceSpan({
      lane: LANE,
      branch: LANE,
      traceId,
      spanId: `${traceId}-tool`,
      parentSpanId: `${traceId}-root`,
      kind: 'tool',
      name: tool,
      toolName: tool,
      startTs: base + 100,
      endTs: base + 900,
    })
  }
  interaction('t-1', 'GrepTheThing', NOW - 50_000)
  interaction('t-2', 'WriteTheOther', NOW - 20_000)

  return f.all().reduce(reduce, initialSessionState())
}

describe('the trace declares what it hid', () => {
  function renderTrace() {
    render(
      <>
        <SearchField surface="test" />
        <TraceTree state={traceState()} lane={LANE} />
      </>,
    )
  }

  function interactions(): HTMLElement[] {
    return screen.queryAllByTestId('trace-interaction')
  }

  it('hides whole interactions, counts them, and keeps the ordinals stable', async () => {
    renderTrace()
    expect(interactions()).toHaveLength(2)
    // Newest first, so the newest is #2.
    expect(interactions()[0]?.textContent).toContain('interaction #2')

    await type('GrepTheThing')

    expect(interactions()).toHaveLength(1)
    const line = screen.getByTestId('session-search-hidden-trace')
    expect(line.textContent).toContain('1 of 2 interactions')
    expect(line.textContent).toContain('1 hidden by “GrepTheThing”')

    // THE ORDINAL IS UNCHANGED. "interaction #1" is a fact about the lane's
    // life, not about the query; renumbering the survivors would give the same
    // interaction two names depending on what was typed, which is exactly what
    // a person searching to find one again cannot afford.
    expect(interactions()[0]?.textContent).toContain('interaction #1')
  })

  it('matches a span buried under a root, not only the root itself', async () => {
    // A trace is a tree, and the thing a person remembers is usually a leaf.
    renderTrace()
    await type('WriteTheOther')
    expect(interactions()).toHaveLength(1)
    expect(interactions()[0]?.textContent).toContain('interaction #2')
  })

  it('keeps the honest gap apart from the empty filter', async () => {
    // "no trace telemetry from this lane" is a claim about the collectors;
    // "nothing matches what you typed" is a claim about the query. Rendering
    // the first for the second would blame the wrong thing.
    render(
      <>
        <SearchField surface="test" />
        <TraceTree state={initialSessionState()} lane={LANE} />
      </>,
    )
    expect(screen.getByText(/NO TRACE TELEMETRY/)).toBeInTheDocument()

    cleanup()
    renderTrace()
    await type('zzzz-nothing-here')
    expect(screen.queryByText(/NO TRACE TELEMETRY/)).not.toBeInTheDocument()
    expect(screen.getByTestId('session-search-hidden-trace').textContent).toContain(
      'NO INTERACTIONS MATCH',
    )
  })
})

describe('the conversation declares what it hid', () => {
  const transcript: FetchLike = async () => ({
    ok: true,
    json: async () => ({
      available: true,
      lane: LANE,
      offset: 0,
      entries: [
        { role: 'user', blocks: [{ kind: 'text', text: 'please retarget the fleet' }] },
        { role: 'assistant', blocks: [{ kind: 'text', text: 'bumping the toolchain instead' }] },
      ],
    }),
  })

  async function renderConversation() {
    render(
      <>
        <SearchField surface="test" />
        <Conversation lane={LANE} fetchImpl={transcript} pollMs={0} />
      </>,
    )
    await act(async () => {})
  }

  it('narrows the turns and says the count', async () => {
    await renderConversation()
    expect(screen.getAllByTestId('turn')).toHaveLength(2)

    await type('retarget')

    expect(screen.getAllByTestId('turn')).toHaveLength(1)
    expect(screen.getByTestId('session-search-hidden-conversation').textContent).toContain(
      '1 of 2 turns — 1 hidden by “retarget”',
    )
  })

  it('matches the role too — "assistant" is how a person names the turn they want', async () => {
    await renderConversation()
    await type('assistant')
    expect(screen.getAllByTestId('turn')).toHaveLength(1)
  })
})

/**
 * S3'S REPLAY STATE — "searching in replay searches the loaded slice".
 *
 * This is structural rather than a switch: every surface here reads
 * `useStream()`, and `StreamContext` is the one seam that serves the live fold
 * or the scrub prefix (ADR-0002: one reducer for live and replay). The search
 * filters whatever that seam hands over and has no second source to get out of
 * step with. But "structural" is a claim about today's construction, so it is
 * driven for real: a recorded session is loaded, the playhead is parked between
 * two events, and the search is asked to filter what is *loaded* — where a
 * search wired to the live stream instead would find nothing at all.
 */
describe('searching in replay searches the loaded slice (S3)', () => {
  const T0 = Date.UTC(2020, 0, 1)
  const BRANCH = 'replay-search-lane'
  const PATH = `/repo-wt/${BRANCH}`

  function replayEvents() {
    const f = createEventFactory({ startTs: T0, idPrefix: 'searchreplay' })
    f.sessionStarted({ repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' })
    f.at(T0 + 1_000).worktreeDiscovered({ path: PATH, branch: BRANCH, head: 'sha-0', isMain: false })
    f.at(T0 + 5_000).commitLanded({
      branch: BRANCH,
      sha: 'ccc3333',
      message: 'feat(replay): the recorded retarget',
      files: [{ path: 'a.ts', status: 'added' }],
      insertions: 1,
      deletions: 0,
      worktreePath: PATH,
    })
    // After the parked playhead: in the slice on disk, not in the slice loaded.
    f.at(T0 + 900_000).commitLanded({
      branch: BRANCH,
      sha: 'ddd4444',
      message: 'feat(replay): the retarget nobody scrubbed to',
      files: [{ path: 'b.ts', status: 'added' }],
      insertions: 1,
      deletions: 0,
      worktreePath: PATH,
    })
    return f.all()
  }

  function replayFetch() {
    return (async (url: string | URL | Request) => {
      const href = String(url)
      if (href === '/api/sessions') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sessions: [{ id: 'sr', fileName: 'sr.jsonl', startedAt: T0, sizeBytes: 100 }],
          }),
        } as unknown as Response
      }
      if (href === '/api/sessions/sr/events') {
        return { ok: true, status: 200, json: async () => ({ events: replayEvents() }) } as unknown as Response
      }
      throw new Error(`unexpected fetch: ${href}`)
    }) as never
  }

  function ReplayDriver() {
    const { sessions, selectSession, playback } = useReplay()
    return (
      <div>
        <button type="button" onClick={() => selectSession(sessions[0]?.id ?? null)}>
          select session
        </button>
        <button type="button" onClick={() => playback.seek(T0 + 10_000)}>
          seek
        </button>
      </div>
    )
  }

  it('filters the scrubbed slice, and its count is of that slice', async () => {
    await act(async () => {
      render(
        <ModeProvider fetchImpl={replayFetch()}>
          <StreamProvider url="/api/stream" createSource={() => new ScriptedEventSource()}>
            <FleetProvider fetchLanes={noLaneManifest}>
              <SelectionProvider>
                <ReplayDriver />
                <SearchField surface="test" />
                <FeedPanel />
              </SelectionProvider>
            </FleetProvider>
          </StreamProvider>
        </ModeProvider>,
      )
    })

    await act(async () => {
      fireEvent.click(screen.getByText('select session'))
    })
    await act(async () => {
      fireEvent.click(screen.getByText('seek'))
    })

    // The recording is loaded and scrubbed: the first commit is in view, the
    // second is past the playhead. A live-wired search would see neither.
    expect(screen.getByText(/the recorded retarget/)).toBeInTheDocument()
    expect(screen.queryByText(/nobody scrubbed to/)).not.toBeInTheDocument()

    await type('recorded retarget')
    expect(screen.getByText(/the recorded retarget/)).toBeInTheDocument()

    // And a term that only appears BEYOND the playhead finds nothing, with the
    // count taken from the loaded slice — never from the whole file on disk.
    await type('nobody scrubbed to')
    const line = screen.getByTestId('session-search-hidden-feed')
    expect(line.textContent).toContain('NO EVENTS MATCH')
  })
})

describe('it is ONE search, not three', () => {
  it('a query typed once is in force on every surface at the same moment', async () => {
    // The claim none of the blocks above makes on its own. Three surfaces
    // mounted together, one field, one keystroke — if each surface owned its
    // own query, two of these three assertions would fail.
    let source: ScriptedEventSource | null = null
    render(
      <StreamProvider
        url="/api/stream"
        now={NOW}
        createSource={() => {
          source = new ScriptedEventSource()
          return source
        }}
      >
        <FleetProvider now={NOW} fetchLanes={noLaneManifest}>
          <SelectionProvider>
            <SearchField surface="test" />
            <FeedPanel />
            <TraceTree state={traceState()} lane={LANE} />
          </SelectionProvider>
        </FleetProvider>
      </StreamProvider>,
    )
    await act(async () => {
      source?.onopen?.(new Event('open'))
      for (const event of feedHistory()) {
        source?.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>)
      }
    })

    await type('zzzz-nothing-here')

    expect(screen.getByTestId('session-search-hidden-feed')).toBeInTheDocument()
    expect(screen.getByTestId('session-search-hidden-trace')).toBeInTheDocument()
  })

  it('“/” focuses the field from anywhere, and Escape in it clears the query', async () => {
    render(
      <>
        <SearchField surface="test" />
        <input data-testid="other-field" />
      </>,
    )
    const field = screen.getByTestId('session-search-test')

    await act(async () => {
      fireEvent.keyDown(window, { key: '/' })
    })
    expect(document.activeElement).toBe(field)

    await act(async () => {
      fireEvent.change(field, { target: { value: 'retarget' } })
    })
    expect((field as HTMLInputElement).value).toBe('retarget')

    await act(async () => {
      fireEvent.keyDown(field, { key: 'Escape' })
    })
    expect((field as HTMLInputElement).value).toBe('')
  })

  it('“/” does not fire while a person is typing into something else', async () => {
    // The standard guard, and the reason it matters here specifically: this
    // field is itself a text input, so an unguarded handler would steal focus
    // out of the very field it just gave it to on the next slash typed.
    render(
      <>
        <SearchField surface="test" />
        <input data-testid="other-field" />
      </>,
    )
    const other = screen.getByTestId('other-field')
    other.focus()

    await act(async () => {
      fireEvent.keyDown(other, { key: '/' })
    })

    expect(document.activeElement).toBe(other)
  })
})
