import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createEventFactory } from '@rhizomorph/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FleetProvider } from '../fleet/FleetContext.js'
import type { FetchLike } from '../fleet/manifest.js'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import { ModeProvider, useReplay } from './ModeContext.js'
import { StatusBar, type StatusBarProps } from './StatusBar.js'
import { StreamProvider } from './StreamContext.js'

afterEach(cleanup)

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

/** A server that has not shipped `.swarm/lanes.json` — not this test's concern. */
const noLaneManifest: FetchLike = async () => ({ ok: false, json: async () => null })

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

function renderBar(fetchMeta?: StatusBarProps['fetchMeta']) {
  let source: FakeEventSource | undefined
  const utils = render(
    <StreamProvider
      url="/api/stream"
      now={NOW}
      createSource={() => {
        source = new FakeEventSource()
        return source
      }}
    >
      <FleetProvider now={NOW} fetchLanes={noLaneManifest}>
        <StatusBar fetchMeta={fetchMeta} />
      </FleetProvider>
    </StreamProvider>,
  )
  return { ...utils, source: () => source }
}

/** A `/api/meta` response body that never resolves — the loading state, held open on purpose. */
function pendingMetaFetch(): NonNullable<StatusBarProps['fetchMeta']> {
  return () => new Promise(() => {})
}

/** A resolved `/api/meta` fetch — `ok: false` or a thrown rejection both settle the hook to `absent`, same as `body`. */
function metaFetch(body: unknown, ok = true): NonNullable<StatusBarProps['fetchMeta']> {
  return async () => ({ ok, json: async () => body })
}

function pill(container: HTMLElement, key: 'git' | 'tmux' | 'workmux' | 'sessionlog' | 'otel'): HTMLElement {
  const el = container.querySelector(`[data-source="${key}"]`)
  if (el === null) throw new Error(`no pill for ${key}`)
  return el as HTMLElement
}

describe('StatusBar', () => {
  it('shows every source as waiting before any collector event or folded record arrives (prd19 ruling 4)', () => {
    const { container } = renderBar()

    for (const key of ['git', 'tmux', 'workmux', 'sessionlog', 'otel'] as const) {
      expect(pill(container, key).dataset.health).toBe('waiting')
    }
  })

  it('surfaces a disabled collector with its reason on hover/focus', () => {
    const { container, source } = renderBar()
    const f = createEventFactory()

    act(() => {
      source()?.emit(f.collectorDisabled({ collector: 'workmux', reason: 'workmux not found on PATH' }))
    })

    const workmux = pill(container, 'workmux')
    expect(workmux.dataset.health).toBe('disabled')
    expect(workmux.title).toBe('workmux not found on PATH')
    expect(workmux.getAttribute('aria-label')).toContain('workmux not found on PATH')

    // Untouched sources have proved no flow either, so ruling 4 reads them
    // waiting — never the removed "live by default".
    expect(pill(container, 'git').dataset.health).toBe('waiting')
    expect(pill(container, 'tmux').dataset.health).toBe('waiting')
    expect(pill(container, 'sessionlog').dataset.health).toBe('waiting')
    expect(pill(container, 'otel').dataset.health).toBe('waiting')
  })

  it('surfaces a disabled sessionlog collector — the most likely stranger failure — with its reason', () => {
    const { container, source } = renderBar()
    const f = createEventFactory()

    act(() => {
      source()?.emit(f.collectorDisabled({ collector: 'sessionlog', reason: 'no Claude session logs found' }))
    })

    const sessionlog = pill(container, 'sessionlog')
    expect(sessionlog.dataset.health).toBe('disabled')
    expect(sessionlog.title).toBe('no Claude session logs found')
  })

  it('surfaces an errored collector with its last message on hover/focus', () => {
    const { container, source } = renderBar()
    const f = createEventFactory()

    act(() => {
      source()?.emit(f.collectorError({ collector: 'tmux', message: 'capture-pane timed out' }))
    })

    const tmux = pill(container, 'tmux')
    expect(tmux.dataset.health).toBe('errored')
    expect(tmux.title).toBe('capture-pane timed out')
    expect(tmux.getAttribute('aria-label')).toContain('capture-pane timed out')
  })

  it('renders no gap voice while nothing has degraded', () => {
    const { queryAllByTestId } = renderBar()
    expect(queryAllByTestId('gap-voice')).toHaveLength(0)
  })

  it('speaks the gap voice — WHAT, WHY, and the command — for a dead collector', () => {
    const { source, queryAllByTestId } = renderBar()
    const f = createEventFactory()

    act(() => {
      source()?.emit(f.collectorDisabled({ collector: 'workmux', reason: 'workmux not found on PATH' }))
    })

    const lines = queryAllByTestId('gap-voice')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveTextContent('WORKMUX COLLECTOR DISABLED')
    expect(lines[0]).toHaveTextContent('workmux not found on PATH')
    expect(lines[0]).toHaveTextContent('rhizomorph doctor')
  })

  it('does not speak the gap voice for a merely errored (not dead) collector', () => {
    const { source, queryAllByTestId } = renderBar()
    const f = createEventFactory()

    act(() => {
      source()?.emit(f.collectorError({ collector: 'tmux', message: 'capture-pane timed out' }))
    })

    // Errored already reads on the pill above, and escalates to the
    // attention strip separately (buildFleet's ladder) — this bar's gap
    // voice is reserved for the dead (disabled), not the merely broken.
    expect(queryAllByTestId('gap-voice')).toHaveLength(0)
  })

  it('reflects the live SSE connection state', () => {
    const { container, source } = renderBar()

    act(() => source()?.open())

    const sse = container.querySelector('[aria-label^="Stream:"]') as HTMLElement | null
    expect(sse?.title).toBe('live')
  })
})

/**
 * PRD19 RULING 4 — SILENCE IS NEVER LIVE. The rule this replaces:
 * `sourceStatus(undefined)` used to return `'live'`, so a source that never
 * produced a single event wore the same calm dot as a healthy one — the
 * PRD's own worst-case example is a never-connected OTel receiver. `live` now
 * requires proof of flow (#251's `selectConnection`, over the same folded
 * state); absent that, a source with no collector record reads `waiting`
 * ("no data yet") — a muted dot, not an alarm.
 *
 * The two laws the issue states verbatim, for OTel specifically, plus the
 * fix's general shape (it is `selectConnection` over all five sources, not an
 * OTel-only branch) and the one honest wrinkle #251's own review flagged: the
 * three machine collectors' flow can regress, because it is read off entity
 * state rather than an append-only ledger.
 */
describe('StatusBar — source health is proof-of-flow (prd19 ruling 4)', () => {
  it('LAW 1: a fresh state with zero otel-origin events renders `data-health="waiting"` for OTel, never `live`', () => {
    const { container } = renderBar()
    expect(pill(container, 'otel').dataset.health).toBe('waiting')
  })

  it('LAW 2: one folded otel-origin event flips OTel to `live`, with no collector event required', () => {
    const { container, source } = renderBar()
    const f = createEventFactory()

    // `llm.cost`'s primary collector is `otel` (events/index.ts), so this
    // folds as otel flow with no `collector.*` event anywhere in the log —
    // exactly the proof ruling 4 asks for, and nothing else.
    act(() => {
      source()?.emit(f.llmCost())
    })

    const otel = pill(container, 'otel')
    expect(otel.dataset.health).toBe('live')
    // A proven source carries no message — `live` is silent, same as before
    // this ruling touched anything. (No `title` attribute rendered at all;
    // the DOM reflects that as `''`, never `null`.)
    expect(otel.title).toBe('')
  })

  it('the fix is general, not an OTel-only branch: a folded git record flips git to `live` too', () => {
    const { container, source } = renderBar()
    const f = createEventFactory()

    act(() => {
      source()?.emit(f.worktreeDiscovered())
    })

    expect(pill(container, 'git').dataset.health).toBe('live')
  })

  it('a disabled collector still wins outright over proven flow — disabled/errored behavior is untouched', async () => {
    const { container, source } = renderBar()
    const f = createEventFactory()

    // Proof of flow first, awaited on its own so the second emit below does
    // not land in useEventStream's coalescing buffer behind it (#183) —
    // exactly the two-step pattern the session-voice describe block already
    // uses for a sequence of emits.
    await act(async () => {
      source()?.emit(f.llmCost())
    })
    await act(async () => {
      // …then the collector is explicitly turned off. The stronger fact wins,
      // exactly as it did before this ruling touched the `undefined` default.
      source()?.emit(f.collectorDisabled({ collector: 'otel', reason: 'OTLP receiver disabled by flag' }))
    })

    const otel = pill(container, 'otel')
    expect(otel.dataset.health).toBe('disabled')
    expect(otel.title).toBe('OTLP receiver disabled by flag')
  })

  /**
   * PINS, DOES NOT ENDORSE — the same tension `connection.test.ts` pins at
   * the selector level (packages/core/src/selectors/connection.ts's header,
   * "THE SECOND LIMIT"): git/tmux/workmux flow is read off entity state the
   * fold keeps *current*, not an append-only ledger, and `branch.removed`
   * DELETES its record outright (the ghost fix). When that was a source's
   * only evidence, the provenance bar's git dot can walk itself back from
   * `live` to `waiting` while the log it was derived from only ever grew.
   * That is prd-19 ruling 2's open tension, unruled — the candidates are
   * named in the selector's own header, and none of them is taken here. This
   * test states what the bar DOES, not that it is right.
   */
  it('pins, not endorses: a branch.removed can walk a proven git dot back to `waiting`', async () => {
    const { container, source } = renderBar()
    const f = createEventFactory()

    // Each emit awaited on its own — the second must not land in
    // useEventStream's coalescing buffer behind the first's still-pending
    // microtask flush (#183), or it would never fold before this test reads it.
    await act(async () => {
      source()?.emit(f.branchUpdated({ branch: 'gone', head: 'sha-1' }))
    })
    expect(pill(container, 'git').dataset.health).toBe('live')

    await act(async () => {
      source()?.emit(f.branchRemoved({ branch: 'gone' }))
    })
    // The branch record is gone, and it was git's only evidence — the dot
    // regresses to the honest-but-surprising "no data yet", never `errored`
    // or a fabricated "still live".
    expect(pill(container, 'git').dataset.health).toBe('waiting')
  })
})

/**
 * THE SESSION VOICE (#181) — `/api/meta`'s additive boot facts (#180) named
 * on the same provenance line: age, event count, resume count while live;
 * the replayed session's own identity while replaying; the honest gap
 * (session id + em dash, never an invented figure) whenever those facts
 * aren't available yet or the server predates them.
 */
describe('StatusBar — session voice', () => {
  const RESUME_WINDOW_MS = 4 * 60 * 60 * 1000 // matches session-log.ts's RESUME_WINDOW_MS
  const THREE_DAYS_FOUR_HOURS_MS = (3 * 24 + 4) * 60 * 60 * 1000
  const TWO_HOURS_FOUR_MIN_MS = (2 * 60 + 4) * 60 * 1000

  function sessionVoice(container: HTMLElement): HTMLElement {
    const el = container.querySelector('[data-testid="session-voice"]')
    if (el === null) throw new Error('no session-voice element rendered')
    return el as HTMLElement
  }

  it('renders nothing before any session.started event has arrived', () => {
    const { queryByTestId } = renderBar(pendingMetaFetch())
    expect(queryByTestId('session-voice')).toBeNull()
  })

  it('renders the session id alone with an em dash while boot facts are still loading', () => {
    const { container, source } = renderBar(pendingMetaFetch())
    const f = createEventFactory()

    act(() => {
      source()?.emit(f.sessionStarted({ sessionId: 'sess-live' }))
    })

    expect(sessionVoice(container)).toHaveTextContent('session sess-live —')
  })

  it('renders the session id alone with an em dash on a server that predates the additive fields', async () => {
    // The pre-#180 shape: startedAt was already there, but none of the boot facts.
    const oldShape = { repoPath: '/repo', repoName: 'rhizomorph', sessionId: 'sess-live', startedAt: 0 }
    const { container, source } = renderBar(metaFetch(oldShape))
    const f = createEventFactory()

    await act(async () => {
      source()?.emit(f.sessionStarted({ sessionId: 'sess-live' }))
    })

    const el = sessionVoice(container)
    expect(el).toHaveTextContent('session sess-live —')
    expect(el.title).toContain('boot facts unavailable')
  })

  it('speaks age, event count and resume count once the boot facts arrive', async () => {
    const startedAt = NOW - THREE_DAYS_FOUR_HOURS_MS
    const { container, source } = renderBar(
      metaFetch({
        resumedCount: 7,
        eventCount: 55_049,
        resumeWindowMs: RESUME_WINDOW_MS,
        lastBootReason: 'resumed',
      }),
    )
    const f = createEventFactory()

    await act(async () => {
      source()?.emit(f.sessionStarted({ sessionId: 'sess-live' }, { ts: startedAt }))
    })

    // The event COUNT rendered is the live running total this instrument has
    // folded (one event so far), never `/api/meta`'s boot-time snapshot —
    // a snapshot would go stale the moment the session keeps running past
    // the boot that measured it.
    const el = sessionVoice(container)
    expect(el).toHaveTextContent('session 3d4h · 1 events · resumed x7')
    expect(el.title).toContain('resumed:')
    expect(el.title).toContain('4h')
  })

  it('omits the resumed clause for a session that has never been resumed', async () => {
    const { container, source } = renderBar(
      metaFetch({ resumedCount: 0, eventCount: 1, resumeWindowMs: RESUME_WINDOW_MS, lastBootReason: 'first-run' }),
    )
    const f = createEventFactory()

    await act(async () => {
      source()?.emit(f.sessionStarted({ sessionId: 'sess-live' }, { ts: NOW }))
    })

    const el = sessionVoice(container)
    expect(el.textContent).not.toMatch(/resumed/)
    expect(el.title).toContain('starting:')
  })

  it('explains a stale boundary in the hover text', async () => {
    const { container, source } = renderBar(
      metaFetch({ resumedCount: 0, eventCount: 1, resumeWindowMs: RESUME_WINDOW_MS, lastBootReason: 'stale' }),
    )
    const f = createEventFactory()

    await act(async () => {
      source()?.emit(f.sessionStarted({ sessionId: 'sess-live' }, { ts: NOW }))
    })

    expect(sessionVoice(container).title).toContain("previous session's activity was outside the 4h window")
  })

  it('does not re-fetch /api/meta after switching to replay, and names the REPLAYED session — not the live one', async () => {
    const f = createEventFactory()
    const replayedEvents = [
      f.at(0).sessionStarted({ sessionId: 'replayed-1' }),
      f.at(TWO_HOURS_FOUR_MIN_MS).worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-1', isMain: true }),
    ]

    const modeFetchImpl = (async (url: string | URL | Request) => {
      const href = String(url)
      if (href === '/api/sessions') {
        return {
          ok: true,
          json: async () => ({
            sessions: [{ id: 'replayed-1', fileName: 'replayed-1.jsonl', startedAt: 0, sizeBytes: 100 }],
          }),
        }
      }
      if (href === '/api/sessions/replayed-1/events') {
        return { ok: true, json: async () => ({ events: replayedEvents }) }
      }
      throw new Error(`unexpected fetch: ${href}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any

    // A live boot-facts fetch a stranger could mistake for this replayed
    // session's own facts, if the honest-gap discipline (point 3) ever slipped.
    const liveMetaFetch = vi.fn(
      metaFetch({ resumedCount: 99, eventCount: 1, resumeWindowMs: RESUME_WINDOW_MS, lastBootReason: 'resumed' }),
    )

    // A plain button rather than a mount-time effect: selecting a session is
    // a real user action, which happens in its OWN render cycle well after
    // the app has already booted live (and already fetched its own boot
    // facts) — not in the same tick as the initial mount.
    function DriveReplay({ id }: { id: string }) {
      const replay = useReplay()
      return (
        <button type="button" onClick={() => replay.selectAndPlay(id)}>
          go replay
        </button>
      )
    }

    let source: FakeEventSource | undefined
    let utils!: ReturnType<typeof render>
    await act(async () => {
      utils = render(
        <ModeProvider fetchImpl={modeFetchImpl}>
          <StreamProvider
            url="/api/stream"
            now={NOW}
            createSource={() => {
              source = new FakeEventSource()
              return source
            }}
          >
            <FleetProvider now={NOW} fetchLanes={noLaneManifest}>
              <DriveReplay id="replayed-1" />
              <StatusBar fetchMeta={liveMetaFetch} />
            </FleetProvider>
          </StreamProvider>
        </ModeProvider>,
      )
    })

    // Booting live legitimately fetches its own boot facts once.
    expect(liveMetaFetch).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: 'go replay' }))
    })

    const el = sessionVoice(utils.container)
    expect(el).toHaveTextContent('session replayed-1 · 2h04m · 2 events')
    expect(el.textContent).not.toMatch(/resumed/)
    // The switch itself must not trigger a second request — replaying reads
    // a different session's identity entirely, never `/api/meta` again.
    expect(liveMetaFetch).toHaveBeenCalledTimes(1)
  })
})
