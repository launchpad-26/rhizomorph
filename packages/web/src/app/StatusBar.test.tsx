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

function pill(
  container: HTMLElement,
  key: 'git' | 'tmux' | 'workmux' | 'sessionlog' | 'otel' | 'beacon',
): HTMLElement {
  const el = container.querySelector(`[data-source="${key}"]`)
  if (el === null) throw new Error(`no pill for ${key}`)
  return el as HTMLElement
}

describe('StatusBar', () => {
  it('shows every source as waiting before any collector event or folded record arrives (prd19 ruling 4)', () => {
    const { container } = renderBar()

    for (const key of ['git', 'tmux', 'workmux', 'sessionlog', 'otel', 'beacon'] as const) {
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

  /**
   * prd-27 ruling 3 (#283, #307). The Beacon pill's flow now comes from
   * `selectConnection`'s own `beacon` source like every other pill's — #283
   * derived it locally here because `CONNECTION_SOURCES` was still five, and
   * #307 widened the constant and deleted the workaround. These two tests are
   * unchanged by that move, deliberately: they are the proof that the fold
   * still reaches the bar, and they would have gone red had the widening
   * changed what the pill reads. The second is the one that matters: a pill
   * wired to "any beacon arrived" rather than to declared attention passes the
   * first and fails this one.
   */
  it('the Beacon pill reads waiting until a lane\'s attention is declared, then live', () => {
    const { container, source } = renderBar()
    const f = createEventFactory()

    expect(pill(container, 'beacon').dataset.health).toBe('waiting')
    expect(pill(container, 'beacon').getAttribute('aria-label')).toContain('Beacon')

    act(() => {
      source()?.emit(
        f.beaconReceived({
          writer: 'claude-hook',
          kind: 'waiting',
          lane: '2-core',
          digest: 'a'.repeat(64),
          file: 'claude-hook.jsonl',
          offset: 0,
        }),
      )
    })

    expect(pill(container, 'beacon').dataset.health).toBe('live')
  })

  it('a beacon of a kind outside the vocabulary does not make the pill live', () => {
    const { container, source } = renderBar()
    const f = createEventFactory()

    act(() => {
      source()?.emit(
        f.beaconReceived({
          writer: 'gate',
          kind: 'landed',
          lane: '2-core',
          digest: 'b'.repeat(64),
          file: 'gate.jsonl',
          offset: 0,
        }),
      )
    })

    expect(pill(container, 'beacon').dataset.health).toBe('waiting')
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
    // voice is reserved for the dead (disabled) and the retrying
    // (degraded), not the merely one-off broken.
    expect(queryAllByTestId('gap-voice')).toHaveLength(0)
  })

  it('does not speak the gap voice for a fully healthy collector', () => {
    const { queryAllByTestId } = renderBar()
    expect(queryAllByTestId('gap-voice')).toHaveLength(0)
  })

  it('surfaces a degraded-retrying collector with its retry reason on hover/focus (#304, ruling 2)', () => {
    const { container, source } = renderBar()
    const f = createEventFactory()

    act(() => {
      source()?.emit(
        f.collectorDegraded({
          collector: 'sessionlog',
          reason: 'no Claude session logs found (attempt 1/3 — retrying)',
          consecutiveFailures: 1,
        }),
      )
    })

    const sessionlog = pill(container, 'sessionlog')
    expect(sessionlog.dataset.health).toBe('degraded')
    expect(sessionlog.title).toBe('no Claude session logs found (attempt 1/3 — retrying)')

    // Untouched sources have proved no flow either, so they still read waiting.
    expect(pill(container, 'git').dataset.health).toBe('waiting')
    expect(pill(container, 'tmux').dataset.health).toBe('waiting')
    expect(pill(container, 'workmux').dataset.health).toBe('waiting')
    expect(pill(container, 'otel').dataset.health).toBe('waiting')
  })

  it('speaks the gap voice — WHAT, WHY, and the command — for a degraded-but-retrying collector (#304, ruling 2)', () => {
    const { source, queryAllByTestId } = renderBar()
    const f = createEventFactory()

    act(() => {
      source()?.emit(
        f.collectorDegraded({
          collector: 'sessionlog',
          reason: 'no Claude session logs found (attempt 1/3 — retrying)',
          consecutiveFailures: 1,
        }),
      )
    })

    const lines = queryAllByTestId('gap-voice')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveTextContent('SESSIONLOG COLLECTOR DEGRADED')
    expect(lines[0]).toHaveTextContent('no Claude session logs found (attempt 1/3 — retrying)')
    expect(lines[0]).toHaveTextContent('rhizomorph doctor')
  })

  it('a collector that recovers reads live again, not stuck on errored (#304)', async () => {
    const { container, source } = renderBar()
    const f = createEventFactory()

    await act(async () => {
      source()?.emit(f.collectorError({ collector: 'tmux', message: 'capture-pane timed out' }))
    })
    expect(pill(container, 'tmux').dataset.health).toBe('errored')

    await act(async () => {
      source()?.emit(f.collectorRecovered({ collector: 'tmux' }))
    })

    const tmux = pill(container, 'tmux')
    expect(tmux.dataset.health).toBe('live')
    expect(tmux.title).toBe('')
  })

  it('a second consecutive degraded poll updates the same pill and gap line, never adds a second (#304)', async () => {
    const { container, source, queryAllByTestId } = renderBar()
    const f = createEventFactory()

    await act(async () => {
      source()?.emit(f.collectorDegraded({ collector: 'tmux', reason: 'capture-pane timed out', consecutiveFailures: 1 }))
    })
    await act(async () => {
      source()?.emit(f.collectorDegraded({ collector: 'tmux', reason: 'tmux exited with code 1', consecutiveFailures: 2 }))
    })

    const tmux = pill(container, 'tmux')
    expect(tmux.dataset.health).toBe('degraded')
    expect(tmux.title).toBe('tmux exited with code 1')

    const lines = queryAllByTestId('gap-voice')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveTextContent('tmux exited with code 1')
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

  /**
   * THE DRIFT, AS THE OPERATOR MET IT (#384). `writer-alive` has been served
   * by `/api/meta` since #187 — `api/meta.test.ts` pins that it carries it —
   * and `KNOWN_BOOT_REASONS` never learned the word, so `parseBootFacts`
   * returned `null` and the whole session voice collapsed to the em-dash
   * "unavailable" gap. The bar had the fact and rendered "I don't know".
   *
   * Read through the rendered bar rather than through `bootExplanation`
   * directly, because the failure was never in the sentence — it was one
   * `.includes()` upstream of it, and only an assertion that starts at the
   * fetch can see that.
   */
  it('explains a boot another live writer forced, instead of collapsing the whole voice to "unavailable"', async () => {
    const { container, source } = renderBar(
      metaFetch({ resumedCount: 0, eventCount: 1, resumeWindowMs: RESUME_WINDOW_MS, lastBootReason: 'writer-alive' }),
    )
    const f = createEventFactory()

    await act(async () => {
      source()?.emit(f.sessionStarted({ sessionId: 'sess-live' }, { ts: NOW }))
    })

    const el = sessionVoice(container)
    // The facts parsed at all — the pre-#384 bar rendered `session sess-live —`
    // here and called the boot facts unavailable.
    expect(el).toHaveTextContent('session 0m · 1 events')
    expect(el.title).not.toContain('boot facts unavailable')
    expect(el.title).toContain('another live rhizomorph still holds the previous session')
    // It cannot name the pid — `liveWriter` is `SessionBootDecision`'s, not
    // `/api/meta`'s — so it names the command that can, rather than guessing.
    expect(el.title).toContain('rhizomorph doctor')
  })

  /**
   * prd20 ruling 5's boot, learned before the route that reports it (#390)
   * exists — the point of #384. The sentence deliberately does NOT reuse
   * `rotated`'s "the closed recording is in the replay picker": after a
   * retarget the closed log is under the OLD repo's slug dir, and the picker
   * only ever lists this repo's `sessionDir`.
   */
  it('explains a retargeted boot, and does not promise the closed recording is in this repo\'s picker', async () => {
    const { container, source } = renderBar(
      metaFetch({ resumedCount: 0, eventCount: 1, resumeWindowMs: RESUME_WINDOW_MS, lastBootReason: 'retargeted' }),
    )
    const f = createEventFactory()

    await act(async () => {
      source()?.emit(f.sessionStarted({ sessionId: 'sess-live' }, { ts: NOW }))
    })

    const el = sessionVoice(container)
    expect(el.title).not.toContain('boot facts unavailable')
    expect(el.title).toContain('retargeted:')
    expect(el.title).toContain('different repo')
    expect(el.title).toContain("not in this repo's replay picker")
  })

  it('still reads a reason nobody has heard of as unavailable — forward-compat is not half-trust', async () => {
    // The posture the local list exists for, unchanged by the widening: a
    // server ahead of this dashboard must never have its vocabulary guessed
    // at. Unknown stays unavailable; it does not fall through to a neighbour.
    const { container, source } = renderBar(
      metaFetch({ resumedCount: 3, eventCount: 1, resumeWindowMs: RESUME_WINDOW_MS, lastBootReason: 'teleported' }),
    )
    const f = createEventFactory()

    await act(async () => {
      source()?.emit(f.sessionStarted({ sessionId: 'sess-live' }, { ts: NOW }))
    })

    const el = sessionVoice(container)
    expect(el).toHaveTextContent('session sess-live —')
    expect(el.title).toContain('boot facts unavailable')
    // And it takes the resume count down with it rather than half-trusting
    // one field out of a body it could not read.
    expect(el.textContent).not.toMatch(/resumed/)
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
