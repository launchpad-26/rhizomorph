import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModeProvider } from '../app/ModeContext.js'
import { StreamProvider } from '../app/StreamContext.js'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import type { FetchLike as ReplayFetchLike } from '../replay/api.js'
import { ConnectPage, type ConnectPageProps, DEFAULT_REFRESH_MS, STATE_GLYPH, STATE_WORD } from './index.js'
import { DOCTOR_URL, META_URL, type FetchLike } from './meta.js'

/**
 * THE HANDSHAKE CHECKLIST, AS A PAGE.
 *
 * The two laws this issue states outright are here, both driven through the
 * real seams rather than around them: the refusal law over a genuine fold,
 * and the live-flip law over the mock SSE source (`createSource`), because
 * "without a page reload" is a claim about the stream and is only proved by
 * an assertion that never re-renders the page itself.
 */

afterEach(cleanup)

let f = createEventFactory()
beforeEach(() => {
  f = createEventFactory()
})

/** Pinned so `StreamProvider`'s fixture clock never arms a timer under these tests. */
const NOW = Date.UTC(2026, 7, 10, 12, 0, 0)
const LOCATION = { port: '4317', protocol: 'http:' }

class FakeEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null

  open() {
    this.onopen?.(new Event('open'))
  }

  emit(event: RhizomorphEvent) {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>)
  }

  close() {}
}

/** `ModeProvider`'s own read — an instrument with no recordings yet. */
const modeFetch = (async (url: string | URL | Request) => {
  if (String(url) === '/api/sessions') return { ok: true, status: 200, json: async () => ({ sessions: [] }) }
  throw new Error(`unexpected fetch: ${String(url)}`)
}) as unknown as ReplayFetchLike

const META_BODY = {
  repoPath: '/home/x/repo',
  repoName: 'repo',
  sessionId: 'sess-ours',
  startedAt: NOW,
  resumedCount: 1,
  resumeWindowMs: 3_600_000,
  lastBootReason: 'resumed',
  rung: 'L2',
  capabilities: {},
  connection: {
    git: { source: 'git', firstEventTs: null, lastEventTs: null, count: 0 },
    tmux: { source: 'tmux', firstEventTs: null, lastEventTs: null, count: 0 },
    workmux: { source: 'workmux', firstEventTs: null, lastEventTs: null, count: 0 },
    sessionlog: { source: 'sessionlog', firstEventTs: null, lastEventTs: null, count: 0 },
    otel: { source: 'otel', firstEventTs: null, lastEventTs: null, count: 0 },
    uninstrumentedSessions: [],
    refusals: { count: 0, instance: null, expectedInstance: null },
  },
}

const DOCTOR_BODY = [
  { id: 'node', status: 'ok', message: 'Node v22.22.2 satisfies the required >=22.22.2' },
  { id: 'session-logs', status: 'ok', message: 'Claude Code session logs found at /home/x/.claude/projects' },
  { id: 'cli-version-drift', status: 'warn', message: 'claude 2.1.300 does not match the pinned trace fixture version 2.1.220' },
]

function stubFetch(meta: unknown = META_BODY, doctor: unknown = DOCTOR_BODY): FetchLike {
  return async (input) => {
    if (input === META_URL) return { ok: meta !== null, json: async () => meta }
    if (input === DOCTOR_URL) return { ok: doctor !== null, json: async () => doctor }
    throw new Error(`unexpected fetch: ${input}`)
  }
}

async function renderConnect(props: Partial<ConnectPageProps> = {}) {
  let source: FakeEventSource | null = null

  await act(async () => {
    render(
      <ModeProvider fetchImpl={modeFetch}>
        <StreamProvider
          url="/api/stream"
          now={NOW}
          createSource={() => {
            source = new FakeEventSource()
            return source
          }}
        >
          <ConnectPage fetchImpl={stubFetch()} refreshMs={0} now={NOW} location={LOCATION} {...props} />
        </StreamProvider>
      </ModeProvider>,
    )
  })

  const live = source as FakeEventSource | null
  if (live === null) throw new Error('the stream never asked for a source')
  act(() => live.open())
  return { source: live }
}

function stateOf(id: string): string {
  return screen.getByTestId(`connect-state-${id}`).textContent?.trim() ?? ''
}

/**
 * Every reading a state cell is allowed to hold, derived from the page's own
 * two maps rather than typed out here (#367).
 *
 * The cell renders the glyph *and* the word — `<span>✓</span> VERIFIED` — so
 * its `textContent` is the pair, and a law that only looked at the word would
 * be blind to a row whose glyph and word disagree. The assertion this replaces
 * was `toMatch(/(VERIFIED|BROKEN|UNPROVEN)/)`: unanchored, with no exactness
 * constraint, so a cell reading `VERIFIED BROKEN` or `UNPROVENISH` satisfied
 * the one property the test's name promises. Membership of an exact set is
 * that property, stated so it can fail.
 */
const LEGAL_STATE_READINGS = Object.keys(STATE_WORD).map(
  (s) => `${STATE_GLYPH[s as keyof typeof STATE_GLYPH]} ${STATE_WORD[s as keyof typeof STATE_WORD]}`,
)

describe('the connect page', () => {
  it('renders one row per link in the chain, each in exactly one of the three states', async () => {
    await renderConnect()

    for (const id of ['browser-server', 'repo-git', 'agents-tmux', 'transcripts-slug', 'transcripts-flow', 'otel', 'uninstrumented-conductor']) {
      expect(screen.getByTestId(`connect-link-${id}`), id).toBeInTheDocument()
      expect(LEGAL_STATE_READINGS, `${id} rendered "${stateOf(id)}"`).toContain(stateOf(id))
    }
  })

  it('names the rung, the instance and the boot facts /api/meta serves', async () => {
    await renderConnect()

    expect(screen.getByTestId('connect-rung').textContent).toBe('L2')
    expect(screen.getByTestId('connect-instance').textContent).toBe('sess-ours')
    expect(screen.getByTestId('connect-boot').textContent).toContain('resumed')
  })

  /** `parseBootFacts`' precedent, rendered: a fact this page could not read says so in one word. */
  it('says "unavailable" for every fact a silent server never served', async () => {
    await renderConnect({ fetchImpl: stubFetch(null, null) })

    expect(screen.getByTestId('connect-rung').textContent).toBe('unavailable')
    expect(screen.getByTestId('connect-instance').textContent).toBe('unavailable')
    // #381: and the doctor note points at the route, not the payload.
    expect(screen.getByTestId('connect-doctor-unavailable').textContent).toContain('no usable answer')
    expect(stateOf('transcripts-slug')).toContain('UNPROVEN')
  })

  /**
   * The other nothing (#381): the route answered a non-empty report and this
   * build could not read one entry of it. The panel must say the route is not
   * the suspect — through the real fetch-and-parse path, not a stubbed
   * reading.
   */
  it('says the doctor route answered when its payload, not the route, is unreadable', async () => {
    await renderConnect({ fetchImpl: stubFetch(META_BODY, [{ id: 'node' }, 42]) })

    const note = screen.getByTestId('connect-doctor-unavailable').textContent ?? ''
    expect(note).toContain('answered')
    expect(note).toContain('readable by this build')
    expect(note).not.toContain('no usable answer')
    expect(stateOf('transcripts-slug')).toContain('UNPROVEN')
  })

  /**
   * **THE BLANK PAGE.** `/connect` has no ErrorBoundary above it (`App.tsx`'s
   * route switch), so a `RangeError` thrown out of `toISOString` during
   * render takes the whole page with it.
   *
   * The gap is real and this fixture sits inside it: the envelope's own
   * `timestampSchema` is `z.number().int().nonnegative()`, whose ceiling is
   * `Number.MAX_SAFE_INTEGER` (~9.007e15), while a `Date` refuses anything
   * past ±8.64e15. A `ts` between the two validates, folds, and throws only
   * when something finally renders it — no malformed HTTP body required.
   */
  it('survives an unrenderable timestamp from the fold, and says so, rather than blanking the route', async () => {
    const { source } = await renderConnect()
    const beyondDate = 9e15
    expect(() => new Date(beyondDate).toISOString()).toThrow(RangeError)

    act(() => source.emit(f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, { ts: beyondDate })))

    expect(screen.getByTestId('connect-page')).toBeInTheDocument()
    expect(stateOf('repo-git')).toContain('VERIFIED')
    expect(screen.getByTestId('connect-fact-repo-git').textContent).toContain('unavailable')
  })

  it('shows doctor\'s own answer for the facts the fold cannot know', async () => {
    await renderConnect()

    expect(screen.getByTestId('connect-doctor-node').textContent).toContain('Node v22.22.2')
    expect(screen.getByTestId('connect-doctor-cli-version-drift').textContent).toContain('2.1.220')
    expect(stateOf('transcripts-slug')).toContain('VERIFIED')
  })
})

describe('the OTel row — the two laws this issue states', () => {
  /**
   * **LAW 1.** A folded `telemetry.refused` with zero otel events renders
   * BROKEN with the expected-instance remedy — not UNPROVEN. Driven through
   * the stream so the state under test is a real fold, not an argument
   * handed to the derivation.
   */
  it('renders BROKEN, with the wrong-instance remedy from the refusal\'s own payload, when a refusal folds and nothing otel-origin ever arrives', async () => {
    const { source } = await renderConnect()
    expect(stateOf('otel')).toContain('UNPROVEN')

    act(() => source.emit(f.make('telemetry.refused', { instance: 'sess-stale', expectedInstance: 'sess-ours', count: 4 }, { ts: NOW - 1_000 })))

    expect(stateOf('otel')).toContain('BROKEN')
    const reason = screen.getByTestId('connect-reason-otel').textContent ?? ''
    expect(reason).toContain('sess-ours')
    expect(reason).toContain('sess-stale')

    // Ruling 7: the exact command, port interpolated from `location`, with
    // the same-process SCAR beside it, verbatim.
    expect(screen.getByTestId('connect-command-otel').textContent).toBe('rhizomorph env <lane> --port 4317')
    expect(screen.getByTestId('connect-warning-otel').textContent).toBe(
      'the env block must be exported in the process that execs the agent',
    )
  })

  /**
   * **LAW 2.** One otel-origin event flips the row to VERIFIED with no page
   * reload — asserted through the mock SSE seam, with nothing re-rendered,
   * refetched or remounted between the two reads below.
   */
  it('flips to VERIFIED the moment one otel-origin event folds, without a reload', async () => {
    const { source } = await renderConnect()
    expect(stateOf('otel')).toContain('UNPROVEN')

    act(() => source.emit(f.llmUsage({ lane: 'lane-a', sessionId: 'sess-a' }, { ts: NOW - 2_000, source: 'otel' })))

    expect(stateOf('otel')).toContain('VERIFIED')
    expect(screen.getByTestId('connect-fact-otel').textContent).toContain('OTel')
  })

  it('names the uninstrumented conductor, with the relaunch command beside it, once the grace window has passed', async () => {
    const { source } = await renderConnect()

    act(() =>
      source.emit(
        f.toolActivity({ lane: 'conductor', role: 'conductor', sessionId: 'sess-gabe', tool: 'Bash' }, { ts: NOW - 10 * 60_000, source: 'sessionlog' }),
      ),
    )

    expect(stateOf('uninstrumented-conductor')).toContain('BROKEN')
    expect(screen.getByTestId('connect-reason-uninstrumented-conductor').textContent).toContain('sess-gabe')
    expect(screen.getByTestId('connect-command-uninstrumented-conductor').textContent).toBe(
      'rhizomorph env conductor --role conductor --port 4317',
    )
    expect(screen.getByTestId('connect-warning-uninstrumented-conductor').textContent).toBe(
      'the env block must be exported in the process that execs the agent',
    )
  })
})

describe('the page\'s only action', () => {
  async function renderRefused(onCopy: (text: string) => Promise<void>) {
    const { source } = await renderConnect({ onCopy })
    act(() => source.emit(f.make('telemetry.refused', { instance: 'sess-stale', expectedInstance: 'sess-ours', count: 1 }, { ts: NOW - 1_000 })))
  }

  it('copies the exact command it shows', async () => {
    const copied: string[] = []
    await renderRefused(async (text) => {
      copied.push(text)
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-copy-otel'))
    })

    expect(copied).toEqual(['rhizomorph env <lane> --port 4317'])
    expect(screen.getByRole('status').textContent).toContain('copied to clipboard')
  })

  /** The drawer's precedent: what it copied is always shown, whether the copy worked or not. */
  it('leaves the command selectable, and says so, when the clipboard refuses', async () => {
    await renderRefused(async () => Promise.reject(new Error('no clipboard')))

    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-copy-otel'))
    })

    expect(screen.getByRole('status').textContent).toContain('clipboard unavailable')
    expect(screen.getByTestId('connect-command-otel').textContent).toBe('rhizomorph env <lane> --port 4317')
  })
})

/**
 * THE SAMPLE-FLEET AFFORDANCE, MOUNTED (#259). `sample.test.tsx` already
 * drives `SampleFleetControl`'s own law in isolation; this restates it
 * reached from the page itself — the fence-widening note on this issue is
 * explicit that "a button that is never rendered is not an affordance" — and
 * ties it to the page's own pre-existing provenance banner (ruling 6).
 */
describe('the sample-fleet affordance, mounted (#259)', () => {
  it('flips the whole page\'s provenance reading when activated, and back when returned to live', async () => {
    await renderConnect()

    expect(screen.queryByTestId('connect-not-live')).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-sample-activate'))
    })

    expect(screen.getByTestId('connect-not-live').textContent).toContain('synthetic · 20 lanes · real schema events')
    expect(screen.getByTestId('connect-sample-banner').textContent).toContain('synthetic · 20 lanes · real schema events')

    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-sample-return'))
    })

    expect(screen.queryByTestId('connect-not-live')).not.toBeInTheDocument()
    expect(screen.getByTestId('connect-sample-activate')).toBeInTheDocument()
  })
})

/**
 * #344 — THE POLL INTERVAL AGAINST THE PROBE CACHE TTL. `refreshMs > 0` had
 * zero coverage before this: every other test in this file pins `refreshMs:
 * 0` precisely to avoid racing a timer.
 *
 * The prop is deliberately NOT passed here. The mismatch #344 is about
 * survived being *written about in a comment* because every test chose its
 * own interval, so nothing ever exercised the number the page ships with:
 * a test that passes `refreshMs={5000}` passes just as happily when the
 * default is 60s. This drives `DEFAULT_REFRESH_MS` itself, and both GETs are
 * counted — meta was polled but unasserted, so an interval that re-read
 * doctor alone used to pass.
 */
describe('the poll interval (#344)', () => {
  afterEach(() => vi.useRealTimers())

  it('re-reads both GETs every DEFAULT_REFRESH_MS, and stops polling once unmounted', async () => {
    vi.useFakeTimers()

    let doctorCalls = 0
    let metaCalls = 0
    const fetchImpl: FetchLike = async (input) => {
      if (input === META_URL) {
        metaCalls++
        return { ok: true, json: async () => META_BODY }
      }
      if (input === DOCTOR_URL) {
        doctorCalls++
        return { ok: true, json: async () => DOCTOR_BODY }
      }
      throw new Error(`unexpected fetch: ${input}`)
    }

    let source: FakeEventSource | null = null
    let unmount: (() => void) | undefined
    await act(async () => {
      const result = render(
        <ModeProvider fetchImpl={modeFetch}>
          <StreamProvider
            url="/api/stream"
            now={NOW}
            createSource={() => {
              source = new FakeEventSource()
              return source
            }}
          >
            <ConnectPage fetchImpl={fetchImpl} now={NOW} location={LOCATION} />
          </StreamProvider>
        </ModeProvider>,
      )
      unmount = result.unmount
    })
    const live = source as FakeEventSource | null
    if (live === null) throw new Error('the stream never asked for a source')
    act(() => live.open())

    // The immediate read, on mount, before any timer fires.
    expect([doctorCalls, metaCalls]).toEqual([1, 1])

    // One tick short of the interval: nothing has fired yet. This is what
    // catches a default that has quietly grown — at `refreshMs = 60000` the
    // page would still be on its mount read here and at the next assertion.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_REFRESH_MS - 1)
    })
    expect([doctorCalls, metaCalls]).toEqual([1, 1])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect([doctorCalls, metaCalls]).toEqual([2, 2])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_REFRESH_MS)
    })
    expect([doctorCalls, metaCalls]).toEqual([3, 3])

    unmount?.()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * DEFAULT_REFRESH_MS)
    })
    // The unmount's cleanup cleared the interval — no polling a torn-down page.
    expect([doctorCalls, metaCalls]).toEqual([3, 3])
  })
})

/**
 * #344 — THE TWO NUMBERS, HELD TOGETHER.
 *
 * `DEFAULT_REFRESH_MS` (here) and `PROBE_CACHE_TTL_MS` (`server/src/api/
 * doctor.ts`) only mean anything relative to each other, and #344 was filed
 * because they had drifted apart while a comment said otherwise. Nothing
 * behavioural can hold that: the two live in different packages, `web` does
 * not depend on `server`, and each file's own tests pass at any value —
 * `doctor.test.ts` asserts relative to the constant (`TTL - 1`, `TTL + 1`),
 * so it stays green if the TTL goes back to 3000, which is the defect
 * itself.
 *
 * So this reads the constant out of the server source, the way the ruling-7
 * tests below read this directory's own source: a cheap, honest guard that
 * fails the moment either number moves without the other. It asserts the two
 * claims the comments make, and nothing more — the strict inequality (below
 * it, no poll ever hits) and the 3× sizing both comments state in words.
 */
describe('#344 — the two numbers, held together', () => {
  const DOCTOR_SOURCE = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../server/src/api/doctor.ts',
  )

  function probeCacheTtlMs(): number {
    const text = readFileSync(DOCTOR_SOURCE, 'utf8')
    const digits = text.match(/export const PROBE_CACHE_TTL_MS = ([\d_]+)/)?.[1]
    if (digits === undefined) throw new Error(`PROBE_CACHE_TTL_MS not found in ${DOCTOR_SOURCE} — did the constant move or get renamed?`)
    return Number(digits.replaceAll('_', ''))
  }

  it('polls strictly under the probe cache TTL, so a poll can land inside the window at all', () => {
    // A cache hit never pushes out `cached.at`, so at `>=` every poll is a
    // cold probe again — exactly the state #344 was filed about.
    expect(DEFAULT_REFRESH_MS).toBeLessThan(probeCacheTtlMs())
  })

  it('keeps the 3× sizing both comments state in words', () => {
    // Two of every three polls reuse the last probe; the third pays for a
    // fresh one. Retuning either number is fine — it just has to come with
    // the comments in `index.tsx` and `doctor.ts`, which this line is here
    // to force someone to re-read.
    expect(probeCacheTtlMs()).toBe(3 * DEFAULT_REFRESH_MS)
  })
})

/**
 * RULING 7, ASSERTED AT THE LEVEL OF THE SOURCE TEXT — the tactic
 * `drawer/readonly.test.ts` uses for the read-only constitution, restated
 * for this directory. "This page mutates nothing" is not a property any
 * behavioural test can hold: a request added tomorrow in a branch nothing
 * renders would pass every test above. `replay/mutating-calls-law.test.ts`
 * already enumerates every mutating call across `packages/web/src`; this
 * narrows it to the two routes this page is allowed to touch at all.
 */
describe('ruling 7 — this page mutates nothing', () => {
  const CONNECT_DIR = path.dirname(fileURLToPath(import.meta.url))

  function sourceFiles(): { name: string; text: string }[] {
    return readdirSync(CONNECT_DIR)
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
      .map((name) => ({ name, text: readFileSync(path.join(CONNECT_DIR, name), 'utf8') }))
  }

  it('walks a directory that actually has sources in it', () => {
    expect(sourceFiles().map((file) => file.name).sort()).toEqual(['index.tsx', 'links.ts', 'meta.ts', 'sample.tsx'])
  })

  it('reaches for no request path but the two GETs ruling 5 names', () => {
    const paths = sourceFiles().flatMap((file) => [...file.text.matchAll(/\/api\/[a-z/-]+/gi)].map((match) => match[0]))

    expect(paths.length).toBeGreaterThan(0)
    for (const found of paths) expect(['/api/meta', '/api/doctor']).toContain(found)
  })

  it('names no mutating verb and builds no request init', () => {
    for (const file of sourceFiles()) {
      expect(file.text, `${file.name} names a mutating verb`).not.toMatch(/\b(?:POST|PUT|PATCH|DELETE)\b/)
      expect(file.text, `${file.name} builds a request init`).not.toMatch(/\bmethod\s*:/)
      expect(file.text, `${file.name} reaches for an execution channel`).not.toMatch(
        /child_process|\bexec\s*\(|\bspawn\s*\(|WebSocket|sendBeacon|XMLHttpRequest|new Function|\beval\s*\(/,
      )
    }
  })
})
