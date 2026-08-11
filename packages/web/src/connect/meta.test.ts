import { describe, expect, it } from 'vitest'
import {
  DOCTOR_URL,
  META_URL,
  UNAVAILABLE,
  doctorCheck,
  fetchDoctor,
  fetchMeta,
  isRenderableTs,
  parseDoctor,
  parseMeta,
  type FetchLike,
} from './meta.js'

/**
 * THE DEFENSIVE READ (`parseBootFacts`' precedent, `app/StatusBar.tsx`).
 *
 * Every case here is the same question asked of a different field: **when
 * this page cannot read a fact, does it say so, or does it invent a
 * flattering one?** A page whose entire subject is what has been proven
 * cannot afford a `0` that means "absent", or a rung it half-read.
 */

const FULL_META = {
  repoPath: '/home/x/repo',
  repoName: 'repo',
  sessionId: 'sess-1',
  startedAt: 1_000,
  resumedCount: 2,
  eventCount: 40,
  resumeWindowMs: 3_600_000,
  lastBootReason: 'resumed',
  rung: 'L2',
  capabilities: {
    git: {
      identity: { level: 'provided' },
      liveness: { level: 'partial', reason: 'poll interval', remedy: 'wire the beacon' },
      activity: { level: 'absent', reason: 'git sees no keystrokes' },
      attention: { level: 'absent', reason: 'git sees no keystrokes' },
      telemetry: { level: 'absent', reason: 'git carries no tokens' },
      cost: { level: 'absent', reason: 'git carries no dollars' },
    },
  },
  connection: {
    git: { source: 'git', firstEventTs: 1_000, lastEventTs: 4_000, count: 11 },
    tmux: { source: 'tmux', firstEventTs: null, lastEventTs: null, count: 0 },
    workmux: { source: 'workmux', firstEventTs: null, lastEventTs: null, count: 0 },
    sessionlog: { source: 'sessionlog', firstEventTs: null, lastEventTs: null, count: 0 },
    otel: { source: 'otel', firstEventTs: null, lastEventTs: null, count: 0 },
    uninstrumentedSessions: [{ sessionId: 'sess-gabe', lanes: ['conductor'], roles: ['conductor'], firstEventTs: 5_000, lastEventTs: 6_000 }],
    refusals: { count: 3, instance: 'sess-other', expectedInstance: 'sess-1' },
  },
}

describe('parseMeta', () => {
  it('reads the whole shape #255 serves', () => {
    const facts = parseMeta(FULL_META)

    expect(facts?.sessionId).toBe('sess-1')
    expect(facts?.repoPath).toBe('/home/x/repo')
    expect(facts?.rung).toBe('L2')
    expect(facts?.boot).toEqual({ resumedCount: 2, resumeWindowMs: 3_600_000, lastBootReason: 'resumed' })
    expect(facts?.connection?.sources.git).toEqual({ firstEventTs: 1_000, lastEventTs: 4_000, count: 11 })
    expect(facts?.connection?.refusals).toEqual({ count: 3, instance: 'sess-other', expectedInstance: 'sess-1' })
    expect(facts?.connection?.uninstrumentedSessions[0]?.roles).toEqual(['conductor'])
  })

  it('keeps each collector\'s reason and remedy — the fields a BROKEN row is built out of', () => {
    const git = parseMeta(FULL_META)?.collectors.find((collector) => collector.name === 'git')

    expect(git?.signals.find((signal) => signal.signal === 'liveness')).toEqual({
      signal: 'liveness',
      level: 'partial',
      reason: 'poll interval',
      remedy: 'wire the beacon',
    })
    expect(git?.signals.find((signal) => signal.signal === 'identity')?.reason).toBeNull()
  })

  it('answers null only for a body that is not an object at all', () => {
    expect(parseMeta(null)).toBeNull()
    expect(parseMeta('nope')).toBeNull()
    expect(parseMeta([])).not.toBeNull() // an array is an object; every field below simply reads as absent
  })

  /**
   * A server that predates prd19's additive fields is not a broken server —
   * it is a server that cannot answer these questions, and the honest page
   * shows its rung and instance and says `unavailable` for the rest.
   */
  it('reads an older server\'s body for what it does carry, and nulls for what it does not', () => {
    const facts = parseMeta({ repoPath: '/repo', repoName: 'repo', sessionId: 'sess-1', startedAt: 1 })

    expect(facts?.sessionId).toBe('sess-1')
    expect(facts?.rung).toBeNull()
    expect(facts?.connection).toBeNull()
    expect(facts?.boot).toBeNull()
    expect(facts?.collectors).toEqual([])
  })

  it('refuses a rung it does not know, rather than passing the string through', () => {
    expect(parseMeta({ ...FULL_META, rung: 'L9' })?.rung).toBeNull()
    expect(parseMeta({ ...FULL_META, rung: 7 })?.rung).toBeNull()
  })

  it('drops a flow whose count is not a number — never reading "absent" as zero', () => {
    const facts = parseMeta({ ...FULL_META, connection: { ...FULL_META.connection, git: { count: '11' } } })

    expect(facts?.connection?.sources.git).toBeUndefined()
    expect(facts?.connection?.sources.tmux?.count).toBe(0) // a real, served zero still reads as zero
  })

  it('reads boot facts all-or-nothing — half a sentence is not a shorter truth', () => {
    expect(parseMeta({ ...FULL_META, lastBootReason: undefined })?.boot).toBeNull()
    expect(parseMeta({ ...FULL_META, resumeWindowMs: 'an hour' })?.boot).toBeNull()
    // A reason a newer server invented is restated, not rejected: this page
    // never branches on it.
    expect(parseMeta({ ...FULL_META, lastBootReason: 'something-new' })?.boot?.lastBootReason).toBe('something-new')
  })

  it('drops a capability entry that parses to no signal at all, rather than rendering an empty, flattering row', () => {
    expect(parseMeta({ ...FULL_META, capabilities: { ghost: { identity: 'fine' } } })?.collectors).toEqual([])
  })

  it('reads a collector name it has never heard of — the ladder is the server\'s to grow', () => {
    const facts = parseMeta({ ...FULL_META, capabilities: { beacon: { identity: { level: 'provided' } } } })
    expect(facts?.collectors.map((collector) => collector.name)).toEqual(['beacon'])
  })

  it('never lets a non-finite number stand in for a timestamp', () => {
    const facts = parseMeta({ ...FULL_META, connection: { ...FULL_META.connection, git: { firstEventTs: Number.NaN, lastEventTs: 4_000, count: 11 } } })
    expect(facts?.connection?.sources.git).toEqual({ firstEventTs: null, lastEventTs: 4_000, count: 11 })
  })

  /**
   * **THE RENDER CRASH.** `new Date(8.64e15 + 1).toISOString()` throws a
   * `RangeError`, and `/connect` has no ErrorBoundary above it — so an
   * out-of-range but finite timestamp used to blank the whole page, on the
   * one surface a stranger opens precisely because their setup is already
   * misbehaving. Guarded here, at the parse boundary, because the formatter
   * that would throw (`replay/format.ts`) is shared with replay's chrome.
   */
  it('reads an out-of-range timestamp as unavailable rather than handing the formatter a RangeError', () => {
    const beyond = 8.64e15 + 1
    expect(() => new Date(beyond).toISOString()).toThrow(RangeError)

    const facts = parseMeta({ ...FULL_META, connection: { ...FULL_META.connection, git: { firstEventTs: beyond, lastEventTs: 1e300, count: 11 } } })
    expect(facts?.connection?.sources.git).toEqual({ firstEventTs: null, lastEventTs: null, count: 11 })
    expect(isRenderableTs(beyond)).toBe(false)
    expect(isRenderableTs(8.64e15)).toBe(true)
  })

  it('guards the uninstrumented sessions\' own timestamps the same way', () => {
    const facts = parseMeta({
      ...FULL_META,
      connection: {
        ...FULL_META.connection,
        uninstrumentedSessions: [{ sessionId: 'sess-x', lanes: ['a'], roles: ['worker'], firstEventTs: 1e300, lastEventTs: -1 }],
      },
    })
    expect(facts?.connection?.uninstrumentedSessions[0]).toEqual({ sessionId: 'sess-x', lanes: ['a'], roles: ['worker'], firstEventTs: null, lastEventTs: null })
  })

  /** "0.5 folded records" is not a fact any log can hold, and it must not be able to buy the strongest word this page has. */
  it('refuses a fractional or negative count rather than rendering it as proof', () => {
    for (const count of [0.5, -1, Number.POSITIVE_INFINITY]) {
      const facts = parseMeta({ ...FULL_META, connection: { ...FULL_META.connection, git: { firstEventTs: 1, lastEventTs: 2, count } } })
      expect(facts?.connection?.sources.git, `count ${count}`).toBeUndefined()
    }
  })

  it('holds boot facts to the same integer discipline', () => {
    expect(parseMeta({ ...FULL_META, resumedCount: 1.5 })?.boot).toBeNull()
    expect(parseMeta({ ...FULL_META, resumeWindowMs: -1 })?.boot).toBeNull()
  })
})

describe('parseDoctor', () => {
  it('reads the check array the route serves, `assumed` included', () => {
    const checks = parseDoctor([
      { id: 'node', status: 'ok', message: 'Node v22.22.2 satisfies the required >=22.22.2' },
      { id: 'ladder', status: 'ok', message: 'L1', assumed: true },
    ])

    expect(checks).toEqual([
      { id: 'node', status: 'ok', message: 'Node v22.22.2 satisfies the required >=22.22.2', assumed: false },
      { id: 'ladder', status: 'ok', message: 'L1', assumed: true },
    ])
  })

  it('drops a half-read check rather than rendering a finding with nothing in it', () => {
    expect(parseDoctor([{ id: 'node', status: 'ok' }, { status: 'ok', message: 'no id' }, { id: 'x', status: 'maybe', message: 'm' }])).toEqual([])
  })

  it('answers null for a body that is not an array — never an empty report, which would read as "all clear"', () => {
    expect(parseDoctor({ checks: [] })).toBeNull()
    expect(parseDoctor(null)).toBeNull()
    expect(parseDoctor([])).toEqual([])
  })

  it('finds a named check, and answers null for one the route never reported', () => {
    const checks = parseDoctor([{ id: 'tmux', status: 'warn', message: 'tmux not found on PATH' }])

    expect(doctorCheck(checks, 'tmux')?.message).toContain('not found')
    expect(doctorCheck(checks, 'workmux')).toBeNull()
    expect(doctorCheck(null, 'tmux')).toBeNull()
  })
})

describe('the two reads', () => {
  function stubFetch(bodies: Record<string, { ok?: boolean; body?: unknown; throws?: boolean }>): { impl: FetchLike; urls: string[] } {
    const urls: string[] = []
    const impl: FetchLike = async (input) => {
      urls.push(input)
      const entry = bodies[input] ?? {}
      if (entry.throws === true) throw new Error('offline')
      return { ok: entry.ok ?? true, json: async () => entry.body }
    }
    return { impl, urls }
  }

  it('reads each route once, at its own URL', async () => {
    const { impl, urls } = stubFetch({ [META_URL]: { body: FULL_META }, [DOCTOR_URL]: { body: [] } })

    expect((await fetchMeta(impl))?.sessionId).toBe('sess-1')
    expect(await fetchDoctor(impl)).toEqual([])
    expect(urls).toEqual(['/api/meta', '/api/doctor'])
  })

  /**
   * A rejected request, a non-2xx, a body that is not JSON and a body that
   * does not parse are one fact to a reader: this page could not read that
   * route just now. The distinction it does make is null-vs-fact, never a
   * fabricated middle.
   */
  it('lands every failure mode on the same null', async () => {
    const { impl } = stubFetch({
      [META_URL]: { throws: true },
      [DOCTOR_URL]: { ok: false, body: [] },
    })

    expect(await fetchMeta(impl)).toBeNull()
    expect(await fetchDoctor(impl)).toBeNull()

    const badJson: FetchLike = async () => ({
      ok: true,
      json: async () => {
        throw new Error('not json')
      },
    })
    expect(await fetchMeta(badJson)).toBeNull()
  })

  it('has one word for a fact it could not read', () => {
    expect(UNAVAILABLE).toBe('unavailable')
  })
})
