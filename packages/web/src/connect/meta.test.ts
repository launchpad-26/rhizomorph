import { describe, expect, it } from 'vitest'
import {
  DOCTOR_URL,
  META_URL,
  UNAVAILABLE,
  doctorCheck,
  fetchDoctor,
  fetchMeta,
  fetchSessionPreview,
  isRenderableTs,
  parseDoctor,
  parseMeta,
  isWorktreeLaneSlug,
  parseRepos,
  parseSessionPreview,
  fetchRepos,
  REPO_SELECT_CAP,
  REPOS_URL,
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
    uninstrumentedSessions: [
      {
        sessionId: 'sess-gabe',
        lanes: ['conductor'],
        roles: ['conductor'],
        firstEventTs: 5_000,
        lastEventTs: 6_000,
        worktreePath: '/home/x/repo-gabe',
        branch: 'conductor',
      },
    ],
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
        uninstrumentedSessions: [
          { sessionId: 'sess-x', lanes: ['a'], roles: ['worker'], firstEventTs: 1e300, lastEventTs: -1, worktreePath: '/repo', branch: 'main' },
        ],
      },
    })
    expect(facts?.connection?.uninstrumentedSessions[0]).toEqual({
      sessionId: 'sess-x',
      lanes: ['a'],
      roles: ['worker'],
      firstEventTs: null,
      lastEventTs: null,
      worktreePath: '/repo',
      branch: 'main',
    })
  })

  /**
   * #515: `worktreePath`/`branch` follow the same `str` idiom every other
   * optional string on this page does — a garbage shape nulls the two new
   * fields without dropping the witness the rest of the row still needs.
   */
  it('nulls worktreePath/branch on a garbage shape, without dropping the session', () => {
    const facts = parseMeta({
      ...FULL_META,
      connection: {
        ...FULL_META.connection,
        uninstrumentedSessions: [
          { sessionId: 'sess-x', lanes: ['a'], roles: ['worker'], firstEventTs: 1_000, lastEventTs: 2_000, worktreePath: 42, branch: '' },
        ],
      },
    })
    expect(facts?.connection?.uninstrumentedSessions[0]).toEqual({
      sessionId: 'sess-x',
      lanes: ['a'],
      roles: ['worker'],
      firstEventTs: 1_000,
      lastEventTs: 2_000,
      worktreePath: null,
      branch: null,
    })
  })

  it('reads an older server\'s uninstrumented sessions with no place at all as null, not absent', () => {
    const facts = parseMeta({
      ...FULL_META,
      connection: {
        ...FULL_META.connection,
        uninstrumentedSessions: [{ sessionId: 'sess-x', lanes: ['a'], roles: ['worker'], firstEventTs: 1_000, lastEventTs: 2_000 }],
      },
    })
    expect(facts?.connection?.uninstrumentedSessions[0]?.worktreePath).toBeNull()
    expect(facts?.connection?.uninstrumentedSessions[0]?.branch).toBeNull()
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

    expect(checks).toEqual({
      kind: 'checks',
      checks: [
        { id: 'node', status: 'ok', message: 'Node v22.22.2 satisfies the required >=22.22.2', assumed: false },
        { id: 'ladder', status: 'ok', message: 'L1', assumed: true },
      ],
    })
  })

  it('drops a half-read check rather than rendering a finding with nothing in it, and still answers with its survivors', () => {
    expect(
      parseDoctor([
        { id: 'node', status: 'ok' },
        { id: 'tmux', status: 'warn', message: 'tmux not found on PATH' },
        { status: 'ok', message: 'no id' },
        { id: 'x', status: 'maybe', message: 'm' },
      ]),
    ).toEqual({ kind: 'checks', checks: [{ id: 'tmux', status: 'warn', message: 'tmux not found on PATH', assumed: false }] })
  })

  /**
   * **THE THREE SHAPES, EACH ITS OWN FACT (#346, then #381).** #346 stopped an
   * all-malformed body collapsing onto `[]` ("all clear"); #381 stops it
   * collapsing onto the transport failures too. An empty report, a report
   * nothing survived of, and no usable answer at all are three different facts
   * a reader debugs in three different places, and the parse now says which.
   */
  it('separates "answered with nothing" from "answered with nothing readable"', () => {
    // Ran, reported no checks: an answer, and an empty one.
    expect(parseDoctor([])).toEqual({ kind: 'checks', checks: [] })
    // Answered, and not one entry of it could be read: the route did its job;
    // this build cannot read what it said — its own shape, no longer folded
    // onto the transport failures (#381's whole point).
    expect(parseDoctor([{ id: 'node', status: 'ok' }, { status: 'ok', message: 'no id' }])).toEqual({ kind: 'unreadable' })
    expect(parseDoctor(['nope', 42, null])).toEqual({ kind: 'unreadable' })
  })

  it('reads a body that is not an array as no usable answer — never an empty report, which would read as "all clear"', () => {
    expect(parseDoctor({ checks: [] })).toEqual({ kind: 'absent' })
    expect(parseDoctor(null)).toEqual({ kind: 'absent' })
  })

  it('finds a named check, and answers null for one the reading cannot hold', () => {
    const reading = parseDoctor([{ id: 'tmux', status: 'warn', message: 'tmux not found on PATH' }])

    expect(doctorCheck(reading, 'tmux')?.message).toContain('not found')
    expect(doctorCheck(reading, 'workmux')).toBeNull()
    expect(doctorCheck({ kind: 'absent' }, 'tmux')).toBeNull()
    expect(doctorCheck({ kind: 'unreadable' }, 'tmux')).toBeNull()
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
    expect(await fetchDoctor(impl)).toEqual({ kind: 'checks', checks: [] })
    expect(urls).toEqual(['/api/meta', '/api/doctor'])
  })

  /**
   * A rejected request, a non-2xx, a body that is not JSON and a body that is
   * not the array shape are one fact to a reader: nothing usable arrived from
   * that route just now. For meta that is still `null`; for doctor it is the
   * `absent` reading — never a fabricated middle, and (#381) never the same
   * value as a report that arrived and could not be read.
   */
  it('lands every transport failure on the same absent reading', async () => {
    const { impl } = stubFetch({
      [META_URL]: { throws: true },
      [DOCTOR_URL]: { ok: false, body: [] },
    })

    expect(await fetchMeta(impl)).toBeNull()
    expect(await fetchDoctor(impl)).toEqual({ kind: 'absent' })

    const badJson: FetchLike = async () => ({
      ok: true,
      json: async () => {
        throw new Error('not json')
      },
    })
    expect(await fetchMeta(badJson)).toBeNull()
    expect(await fetchDoctor(badJson)).toEqual({ kind: 'absent' })
  })

  /**
   * #381's own acceptance: each of the three shapes, driven through the real
   * fetch-and-parse path rather than `parseDoctor` alone — including the
   * non-empty body whose every entry fails validation, which is the exact
   * case that produced the old ambiguity.
   */
  it('carries all three doctor readings through the real fetch path', async () => {
    const readable = stubFetch({ [DOCTOR_URL]: { body: [{ id: 'node', status: 'ok', message: 'Node v22.22.2' }] } })
    expect(await fetchDoctor(readable.impl)).toEqual({
      kind: 'checks',
      checks: [{ id: 'node', status: 'ok', message: 'Node v22.22.2', assumed: false }],
    })

    const unreadable = stubFetch({ [DOCTOR_URL]: { body: [{ id: 'node', status: 'ok' }, 42] } })
    expect(await fetchDoctor(unreadable.impl)).toEqual({ kind: 'unreadable' })

    const rejected = stubFetch({ [DOCTOR_URL]: { throws: true } })
    expect(await fetchDoctor(rejected.impl)).toEqual({ kind: 'absent' })

    const nonArray = stubFetch({ [DOCTOR_URL]: { body: { error: 'boom' } } })
    expect(await fetchDoctor(nonArray.impl)).toEqual({ kind: 'absent' })
  })

  it('has one word for a fact it could not read', () => {
    expect(UNAVAILABLE).toBe('unavailable')
  })
})

/**
 * THE THIRD GET (#516's route, read by #520's enumeration). Same defensive
 * rule as the other two, with one distinction kept deliberately: the route's
 * two honest answers — a preview it read, and a named absence it can explain —
 * are different values, because the panel says something different for each.
 */
describe('the session preview', () => {
  const AVAILABLE = {
    available: true,
    sessionId: 'sess-1',
    place: { worktreePath: '/home/x/repo', branch: 'main' },
    firstUserMessage: { text: 'dispatch wave 4', dropped: 12, ts: '2026-08-14T00:00:00.000Z' },
  }

  it('reads the first user message and how much of it the route cut', () => {
    expect(parseSessionPreview(AVAILABLE)).toEqual({ sessionId: 'sess-1', text: 'dispatch wave 4', dropped: 12, reason: null })
  })

  /** An honest 200 with nothing to show: the route's own law-12 sentence survives, and no text is invented. */
  it('keeps the route\'s own reason when there is no preview to give', () => {
    expect(parseSessionPreview({ available: false, sessionId: 'sess-1', reason: 'NO TRANSCRIPT for session "sess-1" — …' })).toEqual({
      sessionId: 'sess-1',
      text: null,
      dropped: 0,
      reason: 'NO TRANSCRIPT for session "sess-1" — …',
    })
  })

  /**
   * `available: true` with no readable first message is the head-chunk case —
   * the transcript is there, the first user turn is not in the part that was
   * read. It is a no-preview answer, never an empty-string preview.
   */
  it('reads an available session with no first user message as no preview, not as empty text', () => {
    expect(parseSessionPreview({ ...AVAILABLE, firstUserMessage: null })).toEqual({ sessionId: 'sess-1', text: null, dropped: 0, reason: null })
    expect(parseSessionPreview({ ...AVAILABLE, firstUserMessage: { text: '', dropped: 0 } })?.text).toBeNull()
  })

  /** A count that is not a count is dropped rather than rendered — the `num` rule, one route further on. */
  it('refuses a fractional or negative dropped count instead of showing it', () => {
    expect(parseSessionPreview({ ...AVAILABLE, firstUserMessage: { text: 'hi', dropped: -4 } })?.dropped).toBe(0)
    expect(parseSessionPreview({ ...AVAILABLE, firstUserMessage: { text: 'hi', dropped: 0.5 } })?.dropped).toBe(0)
  })

  it('reads a body with no session id in it as nothing at all', () => {
    expect(parseSessionPreview({ available: true, firstUserMessage: { text: 'hi', dropped: 0 } })).toBeNull()
    expect(parseSessionPreview('a preview')).toBeNull()
    expect(parseSessionPreview(null)).toBeNull()
  })

  it('asks the route for exactly this session, with the id encoded rather than pasted into the path', async () => {
    const urls: string[] = []
    const impl: FetchLike = async (input) => {
      urls.push(input)
      return { ok: true, json: async () => AVAILABLE }
    }

    expect((await fetchSessionPreview('sess-1', impl))?.text).toBe('dispatch wave 4')
    expect(await fetchSessionPreview('../../etc/passwd', impl)).not.toBeNull()
    expect(urls).toEqual(['/api/session-preview/sess-1', '/api/session-preview/..%2F..%2Fetc%2Fpasswd'])
  })

  /**
   * **A FAILED PREVIEW MUST NEVER BLOCK THE ENUMERATION.** Every transport
   * failure and every unreadable body lands on the same `null` — the panel
   * renders a no-preview label and the commands beside it are unaffected,
   * which is the whole reason this read is not part of the page's poll.
   */
  it('lands every failure on null, the reading the panel degrades to', async () => {
    const rejected: FetchLike = async () => {
      throw new Error('offline')
    }
    const refused: FetchLike = async () => ({ ok: false, json: async () => ({ error: 'not a valid identifier' }) })
    const notJson: FetchLike = async () => ({
      ok: true,
      json: async () => {
        throw new Error('not json')
      },
    })

    expect(await fetchSessionPreview('sess-1', rejected)).toBeNull()
    expect(await fetchSessionPreview('.', refused)).toBeNull()
    expect(await fetchSessionPreview('sess-1', notJson)).toBeNull()
  })
})

/**
 * THE REPO DISCOVERY READ (prd-20 ruling 5, wave 4, #266).
 *
 * The route answers with two INDEPENDENT lists and its own doc leaves the
 * merge to the caller. This parse is where that call is made, so these cases
 * are about the merge and about the LIMITS the route reports — a picker that
 * dropped either would be saying "these are your repos" while meaning
 * "these are some of them".
 */
describe('parseRepos', () => {
  const FULL = {
    available: true,
    known: {
      available: true,
      projects: [
        { slug: '-home-x-repo', path: '/home/x/repo', resolved: true },
        { slug: '-home-x-lost', path: null, resolved: false, reason: 'ambiguous slug' },
      ],
    },
    scanned: { repos: [{ path: '/home/x/repo' }, { path: '/home/x/code/other' }], truncated: true, unreadable: ['/home/x/Desktop'] },
  }

  it('merges the two lists by path — history first, then whatever the scan added', () => {
    const reading = parseRepos(FULL)

    expect(reading).toMatchObject({
      kind: 'repos',
      repos: [
        { path: '/home/x/repo', origin: 'claude-history' },
        { path: '/home/x/code/other', origin: 'scan' },
      ],
    })
  })

  it('keeps the honest reading of a repo known twice: one entry, and the STRONGER origin wins', () => {
    // `/home/x/repo` is in both lists. "A conversation happened here" is a
    // better fact about a repo than "a directory walk found a .git", so the
    // scan's weaker claim must not overwrite it.
    const reading = parseRepos(FULL)
    const merged = reading?.kind === 'repos' ? reading.repos.filter((repo) => repo.path === '/home/x/repo') : []

    expect(merged).toEqual([{ path: '/home/x/repo', origin: 'claude-history' }])
  })

  it('carries every limit the route reported, rather than a short list with no note', () => {
    expect(parseRepos(FULL)).toMatchObject({
      truncated: true,
      unreadable: ['/home/x/Desktop'],
      unresolved: [{ slug: '-home-x-lost', reason: 'ambiguous slug' }],
      historyUnavailable: null,
    })
  })

  it("keeps the scan's answer when the ~/.claude half could not be enumerated at all", () => {
    const reading = parseRepos({
      available: true,
      known: { available: false, reason: 'no Claude Code project history at /home/x/.claude/projects' },
      scanned: { repos: [{ path: '/home/x/code/other' }], truncated: false, unreadable: [] },
    })

    expect(reading).toMatchObject({
      kind: 'repos',
      repos: [{ path: '/home/x/code/other', origin: 'scan' }],
      historyUnavailable: 'no Claude Code project history at /home/x/.claude/projects',
    })
  })

  it("reads a replay server's own refusal as a sentence, never as an empty list", () => {
    expect(parseRepos({ available: false, reason: 'not applicable — this server is replaying' })).toEqual({
      kind: 'unavailable',
      reason: 'not applicable — this server is replaying',
    })
  })

  it.each([
    ['a body that is not an object', 'repos, surely'],
    ['an unavailable answer with no reason to show', { available: false }],
  ])('refuses to read %s', (_label, body) => {
    expect(parseRepos(body)).toBeNull()
  })

  it('drops an entry with no path and no slug — there is no fact in it to show', () => {
    const reading = parseRepos({
      available: true,
      known: { available: true, projects: [{ resolved: false }, 'not an object'] },
      scanned: { repos: ['not an object', { path: 5 }], truncated: false, unreadable: [] },
    })

    expect(reading).toMatchObject({ kind: 'repos', repos: [], unresolved: [] })
  })

  it('names a reason for an unresolved slug even when the server gave none', () => {
    const reading = parseRepos({
      available: true,
      known: { available: true, projects: [{ slug: '-home-x-lost', resolved: false }] },
      scanned: { repos: [], truncated: false, unreadable: [] },
    })

    expect(reading).toMatchObject({ unresolved: [{ slug: '-home-x-lost', reason: 'the server gave no reason' }] })
  })

  it('reads a body with no lists at all as an empty, honest answer rather than a failure', () => {
    expect(parseRepos({ available: true })).toEqual({
      kind: 'repos',
      repos: [],
      unresolved: [],
      truncated: false,
      unreadable: [],
      historyUnavailable: null,
      nonRepos: [],
      overflow: 0,
    })
  })

  it("reads an OLD server's entries — no repoRoot field — exactly as before the classification existed", () => {
    // Wire compatibility is a real case, not a nicety: the SPA also runs in a
    // browser against whatever server is already up.
    const reading = parseRepos({
      available: true,
      known: { available: true, projects: [{ slug: '-home-x-repo', path: '/home/x/repo', resolved: true }] },
      scanned: { repos: [], truncated: false, unreadable: [] },
    })
    expect(reading).toMatchObject({
      repos: [{ path: '/home/x/repo', origin: 'claude-history' }],
      nonRepos: [],
    })
  })

  it('moves a resolved path inside NO repo into the counted nonRepos bucket, never the picker', () => {
    const reading = parseRepos({
      available: true,
      known: {
        available: true,
        projects: [
          { slug: '-home-x', path: '/home/x', resolved: true, repoRoot: null },
          { slug: '-home-x-repo', path: '/home/x/repo', resolved: true, repoRoot: '/home/x/repo' },
        ],
      },
      scanned: { repos: [], truncated: false, unreadable: [] },
    })
    expect(reading).toMatchObject({
      repos: [{ path: '/home/x/repo', origin: 'claude-history' }],
      nonRepos: ['/home/x'],
    })
  })

  it('folds a repo and its subdir onto one picker entry — the root the server classified', () => {
    const reading = parseRepos({
      available: true,
      known: {
        available: true,
        projects: [
          { slug: '-home-x-repo', path: '/home/x/repo', resolved: true, repoRoot: '/home/x/repo' },
          { slug: '-home-x-repo-packages-web', path: '/home/x/repo/packages/web', resolved: true, repoRoot: '/home/x/repo' },
        ],
      },
      scanned: { repos: [], truncated: false, unreadable: [] },
    })
    const repos = reading?.kind === 'repos' ? reading.repos : []
    expect(repos).toEqual([{ path: '/home/x/repo', origin: 'claude-history' }])
  })

  it('caps the picker and COUNTS the cut — a short list must say it is short', () => {
    const projects = Array.from({ length: REPO_SELECT_CAP + 5 }, (_, i) => ({
      slug: `-home-x-repo${i}`,
      path: `/home/x/repo${i}`,
      resolved: true,
      repoRoot: `/home/x/repo${i}`,
    }))
    const reading = parseRepos({
      available: true,
      known: { available: true, projects },
      scanned: { repos: [], truncated: false, unreadable: [] },
    })
    expect(reading?.kind === 'repos' ? reading.repos.length : -1).toBe(REPO_SELECT_CAP)
    expect(reading?.kind === 'repos' ? reading.overflow : -1).toBe(5)
  })
})

describe('isWorktreeLaneSlug', () => {
  it('matches the encoder\'s own --worktrees- infix, and nothing that merely says worktrees', () => {
    expect(isWorktreeLaneSlug('-home-x-repo--worktrees-9-lane')).toBe(true)
    expect(isWorktreeLaneSlug('-home-x-repo--worktrees-34-sessionlog-collector')).toBe(true)
    // A repo literally NAMED worktrees-challenge encodes with a single hyphen
    // run, not the double the `__worktrees` container produces.
    expect(isWorktreeLaneSlug('-home-x-worktrees-challenge')).toBe(false)
    expect(isWorktreeLaneSlug('-home-x-repo')).toBe(false)
  })
})

describe('fetchRepos', () => {
  it('reads the one route, and lands every failure on the reading the wizard degrades to', async () => {
    const urls: string[] = []
    const answering: FetchLike = async (input) => {
      urls.push(input)
      return { ok: true, json: async () => ({ available: true }) }
    }
    const rejected: FetchLike = async () => {
      throw new Error('offline')
    }
    const refused: FetchLike = async () => ({ ok: false, json: async () => ({}) })

    expect(await fetchRepos(answering)).toMatchObject({ kind: 'repos' })
    expect(urls).toEqual([REPOS_URL])
    expect(await fetchRepos(rejected)).toEqual({ kind: 'absent' })
    expect(await fetchRepos(refused)).toEqual({ kind: 'absent' })
  })
})
