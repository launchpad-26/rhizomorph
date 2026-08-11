import { createEventFactory, reduceAll, selectConnection, type SessionState } from '@rhizomorph/core'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildLinks,
  envCommand,
  FIRST_EXPORT_GRACE_MS,
  portFrom,
  SAME_PROCESS_WARNING,
  tally,
  type ChainLink,
  type ConnectInputs,
} from './links.js'
import type { ConnectionFacts, DoctorFact, MetaFacts } from './meta.js'

/**
 * THE CHECKLIST'S DERIVATION, over real folds.
 *
 * Every fixture below is a genuine event log run through core's own reducer,
 * never a hand-built `Connection` — the claim these rows make is "this is
 * what the fold proves", and asserting it against a fabricated selector
 * output would prove only that the fabrication matched.
 */

let f = createEventFactory()
beforeEach(() => {
  f = createEventFactory()
})

const NOW = Date.UTC(2026, 7, 10, 12, 0, 0)

/** A fixture driving the fold: `StreamContext` hands every fixture `status: 'open'` outright, so the fabricated part is exactly the part that reads healthiest. */
const FIXTURE: ConnectInputs['stream'] = { status: 'open', eventCount: 900, provenance: 'fixture · 20-lane synthetic fleet', live: false }

/** The live log's own stream, after it died. `live` stays true — this IS this instrument; nothing is carrying its news any more. */
const DEAD: ConnectInputs['stream'] = { status: 'closed', eventCount: 5, provenance: 'live · /api/stream', live: true }

function inputs(state: SessionState, overrides: Partial<ConnectInputs> = {}): ConnectInputs {
  return {
    flow: selectConnection(state),
    refusals: state.refusals,
    stream: { status: 'open', eventCount: state.eventCount, provenance: 'live · /api/stream', live: true },
    meta: null,
    doctor: null,
    port: '4317',
    now: NOW,
    ...overrides,
  }
}

/** A served `/api/meta` body, already parsed — the second witness half of every input below. */
function metaWith(connection: Partial<ConnectionFacts> = {}, overrides: Partial<MetaFacts> = {}): MetaFacts {
  return {
    sessionId: 'sess-ours',
    repoPath: '/home/x/repo',
    repoName: 'repo',
    rung: 'L1',
    collectors: [],
    connection: { sources: {}, uninstrumentedSessions: [], refusals: null, ...connection },
    boot: null,
    ...overrides,
  }
}

function row(links: ChainLink[], id: string): ChainLink {
  const found = links.find((link) => link.id === id)
  if (found === undefined) throw new Error(`no row ${id} — rows are ${links.map((link) => link.id).join(', ')}`)
  return found
}

function build(state: SessionState, overrides: Partial<ConnectInputs> = {}): ChainLink[] {
  return buildLinks(inputs(state, overrides))
}

describe('buildLinks — the chain ruling 3 names', () => {
  it('renders one row per link, in the order the chain runs', () => {
    const links = build(reduceAll([]))
    expect(links.map((link) => link.id)).toEqual([
      'browser-server',
      'repo-git',
      'agents-tmux',
      'transcripts-slug',
      'transcripts-flow',
      'otel',
      'uninstrumented-conductor',
    ])
  })

  /**
   * **RULING 3'S TRIPLE, AS AN INVARIANT OVER EVERY BRANCH THIS MODULE HAS.**
   *
   * "VERIFIED (a fact and its timestamp), BROKEN (a reason and the exact
   * command), UNPROVEN (honestly nothing yet)" — asserted across a set of
   * scenarios chosen to reach every row's every state, rather than row by
   * row, so a new default path cannot ship VERIFIED with nothing to date it
   * or BROKEN with no remedy. Ruled on PR #334's review: the rows move, the
   * ruling stands, no waiver.
   *
   * **UNPROVEN's half of the triple is now "nothing PROVEN yet", not "nothing
   * at all"** (#345). A fold row demoted by a dead stream keeps the fact it
   * last proved and the date on it — that is a true statement and the reason
   * a fourth LAST KNOWN state was not needed. What UNPROVEN still may never
   * carry is a reason or a command: those are BROKEN's, and a row that is not
   * claiming a fault must not hand out a remedy for one.
   */
  it('gives every row exactly one state, and every state carries the whole of what its name promises', () => {
    const scenarios = everyBranch()
    // The scenarios are only worth what they cover: this fails loudly if a
    // future edit stops one of the three states being reached at all.
    const reached = new Set(scenarios.flatMap((links) => links.map((link) => link.state)))
    expect([...reached].sort()).toEqual(['broken', 'unproven', 'verified'])

    for (const links of scenarios) {
      for (const link of links) {
        expect(['verified', 'broken', 'unproven']).toContain(link.state)
        // Ruling 3's "a fact AND its timestamp" as one clause rather than two
        // fields that happen to agree: wherever a fact is shown at all, in
        // any state, it is dated and says what kind of date that is.
        expect(link.ts === null, `${link.id} shows a fact with nothing to date it`).toBe(link.fact === null)
        expect(link.tsKind === null, link.id).toBe(link.ts === null)
        if (link.state === 'verified') {
          expect(link.fact, link.id).not.toBeNull()
          expect(link.ts, `${link.id} is VERIFIED with nothing to date it`).not.toBeNull()
          expect(link.tsKind, link.id).not.toBeNull()
          expect(link.reason, link.id).toBeNull()
          expect(link.command, link.id).toBeNull()
        }
        if (link.state === 'broken') {
          expect(link.reason, link.id).not.toBeNull()
          expect(link.command, `${link.id} is BROKEN with no command to fix it`).not.toBeNull()
          expect(link.fact, link.id).toBeNull()
          expect(link.ts, link.id).toBeNull()
        }
        if (link.state === 'unproven') {
          expect(link.reason, link.id).toBeNull()
          expect(link.command, `${link.id} is UNPROVEN and still hands out a remedy`).toBeNull()
          expect(link.warning, link.id).toBeNull()
        }
      }
    }
  })

  /** Every row's VERIFIED and BROKEN branch, across seven builds — the corpus the invariant above is only as good as. */
  function everyBranch(): ChainLink[][] {
    const busy = reduceAll([
      f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, { ts: 1_000 }),
      f.paneDiscovered({ paneId: '%1', windowName: 'main', currentPath: '/repo' }, { ts: 2_000 }),
      f.agentStatus({ handle: 'lane-a', status: 'working' }, { ts: 3_000 }),
      f.toolActivity({ lane: 'lane-a', role: 'worker', sessionId: 'sess-a', tool: 'Bash' }, { ts: 4_000, source: 'sessionlog' }),
      f.llmUsage({ lane: 'lane-a', role: 'worker', sessionId: 'sess-a' }, { ts: 5_000, source: 'otel' }),
    ])
    const refused = reduceAll([f.make('telemetry.refused', { instance: 'stale', expectedInstance: 'ours', count: 2 }, { ts: 2_000 })])
    const uninstrumented = reduceAll([
      f.toolActivity({ lane: 'conductor', role: 'conductor', sessionId: 'sess-gabe', tool: 'Bash' }, { ts: NOW - 10 * 60_000, source: 'sessionlog' }),
    ])
    const allDisabled = metaWith(
      {},
      {
        collectors: ['git', 'tmux', 'workmux', 'sessionlog'].map((name) => ({
          name,
          signals: [{ signal: 'identity' as const, level: 'absent' as const, reason: `${name} collector disabled`, remedy: null }],
        })),
      },
    )
    const slugOk: DoctorFact = { id: 'session-logs', status: 'ok', message: 'session logs found at /home/x/.claude/projects', assumed: false }
    const slugMissing: DoctorFact = { id: 'session-logs', status: 'warn', message: 'no session logs — point elsewhere with --extra-sessions', assumed: false }

    return [
      build(reduceAll([])),
      build(busy, { doctor: [slugOk] }),
      build(refused),
      build(uninstrumented, { doctor: [slugMissing] }),
      build(reduceAll([]), { meta: allDisabled }),
      build(reduceAll([]), { meta: metaWith(), stream: { status: 'error', eventCount: 0, provenance: 'live · /api/stream', live: true } }),
      build(reduceAll([]), { stream: { status: 'connecting', eventCount: 0, provenance: 'live · /api/stream', live: true } }),
      // The two demotions (#343, #345), over the two logs that reach the most
      // states — so the triple is asserted on the rows `attest` rewrote, not
      // only on the rows it left alone.
      build(busy, { doctor: [slugOk], meta: metaWith(), stream: FIXTURE }),
      build(uninstrumented, { doctor: [slugMissing], meta: metaWith(), stream: FIXTURE }),
      build(busy, { doctor: [slugOk], meta: metaWith(), stream: DEAD }),
    ]
  }

  /**
   * Where the proof IS the present moment — an open socket, a doctor probe —
   * the row is dated by this render and SAYS so, rather than borrowing some
   * unrelated event's timestamp and reading as a stored fact.
   */
  it('dates a live proof as of render time, and a stored proof by its own event', () => {
    const state = reduceAll([f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, { ts: 1_000 })])
    const links = build(state, { doctor: [{ id: 'session-logs', status: 'ok', message: 'found', assumed: false }] })

    expect(row(links, 'browser-server').tsKind).toBe('render')
    expect(row(links, 'browser-server').ts).toBe(NOW)
    expect(row(links, 'transcripts-slug').tsKind).toBe('render')
    expect(row(links, 'repo-git').tsKind).toBe('event')
    expect(row(links, 'repo-git').ts).toBe(1_000)
  })

  it('names the restart command, repo and port interpolated, for a fault that was decided at boot', () => {
    const meta = metaWith({}, { collectors: [{ name: 'git', signals: [{ signal: 'identity', level: 'absent', reason: 'not a repository', remedy: null }] }] })
    expect(row(build(reduceAll([]), { meta }), 'repo-git').command).toBe('npm start -- /home/x/repo --port 4317')
  })

  it('names --extra-sessions for a slug directory that does not resolve', () => {
    const doctor: DoctorFact[] = [{ id: 'session-logs', status: 'warn', message: 'no session logs at /home/x/.claude/projects', assumed: false }]
    expect(row(build(reduceAll([]), { doctor, meta: metaWith() }), 'transcripts-slug').command).toBe(
      'npm start -- /home/x/repo --port 4317 --extra-sessions <session-log-dir>',
    )
  })

  it('counts the three states without ranking them', () => {
    expect(tally(build(reduceAll([])))).toEqual({ verified: 1, broken: 0, unproven: 6 })
  })
})

describe('the OTel row — prd19 ruling 3, this issue\'s first stated law', () => {
  /**
   * **THE LAW.** A folded `telemetry.refused` with zero otel-origin events
   * is BROKEN, never UNPROVEN — and the remedy comes out of the refusal's
   * own payload. Without this, the exact fleet prd19 exists for (a
   * misconfigured one, exporting hard into a receiver that throws every post
   * away) reads as "nothing has happened yet", which is
   * `sourceStatus(undefined) → 'live'` in the costume ruling 4 removed.
   */
  it('reads BROKEN with the expected-instance remedy when a refusal folded and no otel event ever arrived', () => {
    const state = reduceAll([
      f.make('telemetry.refused', { instance: 'sess-other', expectedInstance: 'sess-ours', count: 4 }, { ts: 1_000 }),
    ])
    const otel = row(build(state), 'otel')

    expect(otel.state).toBe('broken')
    expect(otel.reason).toContain('sess-ours')
    expect(otel.reason).toContain('sess-other')
    expect(otel.reason).toContain('refused')
    expect(otel.command).toBe('rhizomorph env <lane> --port 4317')
    expect(otel.warning).toBe(SAME_PROCESS_WARNING)
    expect(selectConnection(state).otel.count).toBe(0)
  })

  /**
   * "From its own payload" (ruling 3) is the point of this one, which is why
   * meta ALSO holds a refusal here naming a different offender: a folded
   * refusal that declared no instance must read as such, never borrow the
   * other witness's id. The `??` chain this pins used to fall through
   * precisely because a legitimate `null` and an absent field are the same
   * value to it (reviewer's finding, PR #334).
   */
  it('names the "declared no instance at all" offender as such, never borrowing meta\'s offender', () => {
    const state = reduceAll([f.make('telemetry.refused', { instance: null, expectedInstance: 'sess-ours', count: 1 }, { ts: 1_000 })])
    const meta = metaWith({ refusals: { count: 1, instance: 'sess-someone-else', expectedInstance: 'sess-ours' } })
    const otel = row(build(state, { meta }), 'otel')

    expect(otel.reason).toContain('declared no instance at all')
    expect(otel.reason).not.toContain('sess-someone-else')
  })

  /**
   * The refusal summary `/api/meta` serves (#255) says the same thing the
   * fold does; a page that only read the fold would still be right, and a
   * page that only read meta would go stale. Either witness alone is enough
   * to reach BROKEN.
   */
  it('reaches BROKEN from /api/meta\'s refusal summary alone, when the fold has not seen one', () => {
    const meta = metaWith({ refusals: { count: 7, instance: 'sess-other', expectedInstance: 'sess-ours' } })
    const otel = row(build(reduceAll([]), { meta }), 'otel')

    expect(otel.state).toBe('broken')
    expect(otel.reason).toContain('7 telemetry exports refused')
  })

  it('flips to VERIFIED once an otel-origin event folds, dated by that event', () => {
    const state = reduceAll([f.llmUsage({ sessionId: 'sess-live' }, { ts: 2_000, source: 'otel' })])
    const otel = row(build(state), 'otel')

    expect(otel.state).toBe('verified')
    expect(otel.fact).toContain('OTel')
    expect(otel.ts).toBe(2_000)
    expect(otel.tsKind).toBe('event')
  })

  /**
   * **The two-agents-one-stale fleet — ruled BROKEN on PR #334's review.**
   * One lane wired to this instance, one to a stale one. This used to read
   * VERIFIED with the refusal demoted to a note carrying no instance names,
   * no command and no SCAR — so the tally said "0 broken" for the exact
   * fleet prd19 was written about, and the operator read the money layer as
   * healthy while one lane's dollars did not exist.
   */
  it('stays BROKEN when a refusal stands beside real flow, and says the flow is real too', () => {
    const state = reduceAll([
      f.make('telemetry.refused', { instance: 'sess-other', expectedInstance: 'sess-ours', count: 1 }, { ts: 1_000 }),
      f.llmUsage({ sessionId: 'sess-live' }, { ts: 2_000, source: 'otel' }),
    ])
    const links = build(state)
    const otel = row(links, 'otel')

    expect(otel.state).toBe('broken')
    expect(otel.reason).toContain('sess-other')
    expect(otel.command).toBe('rhizomorph env <lane> --port 4317')
    expect(otel.warning).toBe(SAME_PROCESS_WARNING)
    // Neither fact erases the other: the flow that IS arriving is named.
    expect(otel.notes.join(' ')).toContain('DID arrive')
    expect(tally(links).broken).toBeGreaterThan(0)
  })

  it('stays UNPROVEN — not broken — when nothing has arrived and nothing was refused', () => {
    const otel = row(build(reduceAll([])), 'otel')
    expect(otel.state).toBe('unproven')
    expect(otel.command).toBeNull()
  })
})

describe('the uninstrumented conductor — the PRD\'s evidence case', () => {
  /** A conductor with transcript activity and no telemetry at all: Gabe's fleet, in three events. */
  function uninstrumentedConductorLog() {
    return reduceAll([
      f.toolActivity({ lane: 'conductor', role: 'conductor', sessionId: 'sess-gabe', tool: 'Bash' }, { ts: NOW - 10 * 60_000, source: 'sessionlog' }),
      f.llmUsage({ lane: 'conductor', role: 'conductor', sessionId: 'sess-gabe' }, { ts: NOW - 9 * 60_000, source: 'sessionlog' }),
    ])
  }

  it('is a named BROKEN row with the relaunch command and the SCAR warning beside it', () => {
    const link = row(build(uninstrumentedConductorLog()), 'uninstrumented-conductor')

    expect(link.state).toBe('broken')
    expect(link.reason).toContain('sess-gabe')
    expect(link.reason).toContain('conductor')
    expect(link.command).toBe('rhizomorph env conductor --role conductor --port 4317')
    expect(link.warning).toBe(SAME_PROCESS_WARNING)
    expect(link.notes.join(' ')).toContain('relaunched')
  })

  /**
   * `selectConnection`'s own doc hands this judgment to the UI by name: the
   * fold cannot tell "never instrumented" from "instrumented, first batch
   * still in flight". Inside the grace window the row waits in the ice
   * register — waiting is not an alarm.
   */
  it('waits, unproven, while the first export could still be in flight', () => {
    const state = reduceAll([
      f.toolActivity({ lane: 'conductor', role: 'conductor', sessionId: 'sess-fresh', tool: 'Bash' }, { ts: NOW - 1_000, source: 'sessionlog' }),
    ])
    const link = row(build(state), 'uninstrumented-conductor')

    expect(link.state).toBe('unproven')
    expect(link.command).toBeNull()
    expect(link.notes.join(' ')).toContain('no telemetry yet')
  })

  it('turns broken the moment that grace window has passed, on the same log', () => {
    const startedAt = NOW - FIRST_EXPORT_GRACE_MS - 1
    const state = reduceAll([
      f.toolActivity({ lane: 'lane-a', role: 'worker', sessionId: 'sess-late', tool: 'Bash' }, { ts: startedAt, source: 'sessionlog' }),
    ])

    expect(row(build(state, { now: startedAt + FIRST_EXPORT_GRACE_MS - 1 }), 'uninstrumented-conductor').state).toBe('unproven')
    expect(row(build(state, { now: startedAt + FIRST_EXPORT_GRACE_MS }), 'uninstrumented-conductor').state).toBe('broken')
  })

  it('reads VERIFIED when every session with transcript activity also exported telemetry', () => {
    const state = reduceAll([
      f.toolActivity({ lane: 'lane-a', role: 'worker', sessionId: 'sess-a', tool: 'Bash' }, { ts: 1_000, source: 'sessionlog' }),
      f.llmUsage({ lane: 'lane-a', role: 'worker', sessionId: 'sess-a' }, { ts: 2_000, source: 'otel' }),
    ])
    expect(row(build(state), 'uninstrumented-conductor').state).toBe('verified')
  })

  it('says there is nothing to check, rather than passing, on an empty log', () => {
    const link = row(build(reduceAll([])), 'uninstrumented-conductor')
    expect(link.state).toBe('unproven')
    expect(link.notes.join(' ')).toContain('no transcript activity')
  })

  /**
   * The reviewer's finding on PR #334, and the shape it takes in the wild: the
   * SSE errors on connect so the fold stays empty, both GETs succeed, and
   * `/api/meta` serves 40 transcript records AND an uninstrumented session in
   * the same body. Reading the merged count for VERIFIED while reading only
   * the fold for the sessions made this row claim the exact opposite of what
   * its own source had just said — and it flashed that on every ordinary load
   * where meta resolved before the SSE backlog folded.
   */
  it('reads /api/meta\'s own uninstrumented session as a second witness, never contradicting the body it came from', () => {
    const meta = metaWith({
      sources: { sessionlog: { firstEventTs: 1_000, lastEventTs: NOW - 20 * 60_000, count: 40 } },
      uninstrumentedSessions: [
        { sessionId: 'sess-gabe', lanes: ['conductor'], roles: ['conductor'], firstEventTs: NOW - 20 * 60_000, lastEventTs: NOW - 19 * 60_000 },
      ],
    })
    const link = row(build(reduceAll([]), { meta }), 'uninstrumented-conductor')

    expect(link.state).toBe('broken')
    expect(link.reason).toContain('sess-gabe')
    expect(link.command).toBe('rhizomorph env conductor --role conductor --port 4317')
  })

  it('counts a session either witness names exactly once', () => {
    const state = uninstrumentedConductorLog()
    const meta = metaWith({
      uninstrumentedSessions: [
        { sessionId: 'sess-gabe', lanes: ['conductor'], roles: ['conductor'], firstEventTs: NOW - 10 * 60_000, lastEventTs: NOW - 9 * 60_000 },
        { sessionId: 'sess-other', lanes: ['lane-b'], roles: ['worker'], firstEventTs: NOW - 10 * 60_000, lastEventTs: NOW - 9 * 60_000 },
      ],
    })
    const link = row(build(state, { meta }), 'uninstrumented-conductor')

    expect(link.state).toBe('broken')
    expect(link.reason).toContain('1 more session')
  })

  /** A witness that carried no usable date cannot claim the window's exemption — a malformed timestamp must not buy a permanently silent row. */
  it('refuses the grace window to a session it cannot date', () => {
    const meta = metaWith({
      uninstrumentedSessions: [{ sessionId: 'sess-undated', lanes: ['lane-a'], roles: ['worker'], firstEventTs: null, lastEventTs: null }],
    })
    expect(row(build(reduceAll([]), { meta }), 'uninstrumented-conductor').state).toBe('broken')
  })

  it('drops a served role the schema has never heard of, rather than passing it to --role', () => {
    const meta = metaWith({
      uninstrumentedSessions: [
        { sessionId: 'sess-x', lanes: ['lane-a'], roles: ['overlord'], firstEventTs: NOW - 10 * 60_000, lastEventTs: NOW - 9 * 60_000 },
      ],
    })
    expect(row(build(reduceAll([]), { meta }), 'uninstrumented-conductor').command).toBe('rhizomorph env lane-a --port 4317')
  })
})

describe('the machine links — flow, never preconditions', () => {
  it('verifies repo ↔ git off folded git records, with the timestamp they carry', () => {
    const state = reduceAll([
      f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, { ts: 1_000 }),
      f.commitLanded({ sha: 'sha-1', branch: 'main' }, { ts: 4_000 }),
    ])
    const git = row(build(state), 'repo-git')

    expect(git.state).toBe('verified')
    expect(git.fact).toContain('folded records')
    expect(git.ts).toBe(4_000)
  })

  it('reads a disabled collector\'s own reason and remedy as BROKEN, from /api/meta', () => {
    const meta = metaWith(
      {},
      {
        rung: 'L0',
        collectors: [
          {
            name: 'git',
            signals: [{ signal: 'identity', level: 'absent', reason: 'git collector disabled: not a repository', remedy: 'point the server at a git worktree' }],
          },
        ],
      },
    )
    const git = row(build(reduceAll([]), { meta }), 'repo-git')

    expect(git.state).toBe('broken')
    expect(git.reason).toBe('git collector disabled: not a repository')
    expect(git.notes.join(' ')).toContain('point the server at a git worktree')
  })

  it('keeps agents ↔ tmux/workmux unproven while only one of the two is disabled — a live mechanism has not reported, it has not died', () => {
    const meta = metaWith({}, { collectors: [{ name: 'tmux', signals: [{ signal: 'identity', level: 'absent', reason: 'tmux not on PATH', remedy: null }] }] })
    expect(row(build(reduceAll([]), { meta }), 'agents-tmux').state).toBe('unproven')
  })

  it('names which of the two proved the agents link', () => {
    const state = reduceAll([f.agentStatus({ handle: 'lane-a', status: 'working' }, { ts: 3_000 })])
    const link = row(build(state), 'agents-tmux')

    expect(link.state).toBe('verified')
    expect(link.fact).toContain('workmux')
    expect(link.fact).not.toContain('tmux ')
  })
})

describe('the two GETs the fold cannot replace', () => {
  const slugOk: DoctorFact = { id: 'session-logs', status: 'ok', message: 'Claude Code session logs found at /home/x/.claude/projects', assumed: false }
  const slugMissing: DoctorFact = { id: 'session-logs', status: 'warn', message: 'no Claude Code session logs at /home/x/.claude/projects — per-agent history stays empty', assumed: false }

  it('reads the slug directory from doctor, and says so when no readable answer arrived', () => {
    expect(row(build(reduceAll([]), { doctor: [slugOk] }), 'transcripts-slug').state).toBe('verified')
    expect(row(build(reduceAll([]), { doctor: [slugMissing] }), 'transcripts-slug').state).toBe('broken')

    const unread = row(build(reduceAll([])), 'transcripts-slug')
    expect(unread.state).toBe('unproven')
    expect(unread.notes.join(' ')).toContain('unavailable')
  })

  /**
   * **"DID NOT ANSWER" AND "ANSWERED WITHOUT THE CHECK I WANTED" ARE NOT THE
   * SAME NOTE (#346).** `doctorCheck` returns `null` for both, and this row
   * used to report both as the first — sending a reader off to debug a route
   * that was working perfectly well, which is the one failure mode worse than
   * an unhelpful note. The row is UNPROVEN either way; where to look is not
   * the same either way.
   */
  it('distinguishes a doctor route that gave no readable answer from one that answered without the session-logs check', () => {
    const unread = row(build(reduceAll([])), 'transcripts-slug')
    const answered = row(build(reduceAll([]), { doctor: [{ id: 'node', status: 'ok', message: 'Node v22.22.2', assumed: false }] }), 'transcripts-slug')

    expect(unread.state).toBe('unproven')
    expect(answered.state).toBe('unproven')
    expect(unread.notes).not.toEqual(answered.notes)

    expect(unread.notes.join(' ')).toContain('no readable answer')
    expect(answered.notes.join(' ')).toContain('answered, but carried no `session-logs` check')
    // The route is not the thing to go and fix.
    expect(answered.notes.join(' ')).not.toContain('never answered')
    expect(answered.notes.join(' ')).toContain('the route is fine')
  })

  /**
   * **AND `doctor === null` IS ITSELF TWO FACTS.** `parseDoctor` answers `null`
   * both for a body that never arrived and for one it could not read — and
   * `readJson` folds every other unreadable answer onto that same value — so a
   * server whose doctor is answering perfectly, in a shape this build is too
   * old to parse, reaches this row as `null`. Reporting that as "has not
   * answered" is the same lie #346 removed one branch over, aimed at the same
   * reader: go and debug a route that is working.
   *
   * This row cannot yet tell the two apart — the fix is a three-state result
   * (absent / unreadable / checks) travelling through `fetchDoctor` and
   * `index.tsx`, which is a wider change than this. What it CAN do, and what
   * this pins, is refuse to assert the half it does not know: the note states
   * what is true of both causes and names both.
   */
  it('never claims the route was silent when it may have answered unreadably', () => {
    const note = row(build(reduceAll([])), 'transcripts-slug').notes.join(' ')

    // The claim that is not this page's to make.
    expect(note).not.toContain('has not answered')
    expect(note).not.toMatch(/did not answer|never responded|is not answering/)
    // Both causes, named, and the one consequence that holds either way.
    expect(note).toContain('never answered')
    expect(note).toContain('could not read')
    expect(note).toContain('unavailable')
  })

  /**
   * The plumbing and the flow are separate rows on purpose (this issue's own
   * direction): a directory that resolves proves nothing about a transcript
   * arriving from it, and one standing in for the other is exactly how
   * "connected" starts meaning "preconditions passed".
   */
  it('keeps the transcript flow row unproven even when the slug directory is verified', () => {
    const links = build(reduceAll([]), { doctor: [slugOk] })
    expect(row(links, 'transcripts-slug').state).toBe('verified')
    expect(row(links, 'transcripts-flow').state).toBe('unproven')
  })

  it('carries version drift and the lane manifest through as notes, in doctor\'s own words', () => {
    const doctor: DoctorFact[] = [
      { id: 'cli-version-drift', status: 'warn', message: 'claude 2.1.300 does not match the pinned trace fixture version 2.1.220', assumed: false },
      { id: 'lane-manifest', status: 'ok', message: 'lane manifest present and valid at /repo/.swarm/lanes.json — 3 lanes', assumed: true },
    ]
    const links = build(reduceAll([]), { doctor })

    expect(row(links, 'otel').notes.join(' ')).toContain('2.1.220')
    expect(row(links, 'repo-git').notes.join(' ')).toContain('3 lanes')
    expect(row(links, 'repo-git').notes.join(' ')).toContain('assumed, not measured')
  })
})

describe('browser ↔ server', () => {
  it('is verified by an open stream alone — a repo where nothing has happened is a working link with nothing to carry', () => {
    const link = row(build(reduceAll([])), 'browser-server')
    expect(link.state).toBe('verified')
    expect(link.fact).toContain('0 events folded')
  })

  it('is BROKEN with a restart command, port interpolated, when the stream is dead', () => {
    const meta = metaWith()
    const link = row(build(reduceAll([]), { meta, stream: { status: 'error', eventCount: 0, provenance: 'live · /api/stream', live: true } }), 'browser-server')

    expect(link.state).toBe('broken')
    expect(link.command).toBe('npm start -- /home/x/repo --port 4317')
  })

  /** Ruling 6, on the one surface whose subject is whether data is real: a fixture fabricates `status: 'open'`. */
  it('refuses to read a fabricated open status as proof when a fixture or a recording is driving', () => {
    const link = row(build(reduceAll([]), { stream: { status: 'open', eventCount: 900, provenance: 'fixture · 20-lane synthetic fleet', live: false } }), 'browser-server')

    expect(link.state).toBe('unproven')
    expect(link.notes.join(' ')).toContain('synthetic fleet')
  })
})

/**
 * VERIFIED MEANS "I CHECKED, AND IT HOLDS" — the one ruling behind #343 and
 * #345, asserted from both ends. The corpus below is a log that proves five of
 * the seven rows outright when the stream carrying it is live and real, so
 * every assertion here is about the demotion and not about a log that had
 * nothing to say in the first place.
 */
function provingLog() {
  return reduceAll([
    f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, { ts: 1_000 }),
    f.agentStatus({ handle: 'lane-a', status: 'working' }, { ts: 3_000 }),
    f.toolActivity({ lane: 'lane-a', role: 'worker', sessionId: 'sess-a', tool: 'Bash' }, { ts: 4_000, source: 'sessionlog' }),
    f.llmUsage({ lane: 'lane-a', role: 'worker', sessionId: 'sess-a' }, { ts: 5_000, source: 'otel' }),
  ])
}

const SLUG_OK: DoctorFact = { id: 'session-logs', status: 'ok', message: 'session logs found at /home/x/.claude/projects', assumed: false }

describe('a fixture fold is not evidence — #343', () => {
  /**
   * **THE LAW.** Ruling 6 was already satisfied to the letter by the
   * page-level `connect-not-live` banner, and that was not enough: a banner is
   * a label on a page, not a property of a row, and a reader who scrolls past
   * it sees six green ticks. This is the same claim as the banner, moved to
   * where the reader is actually looking.
   */
  it('renders no VERIFIED row off a fixture fold, over a log that verifies all seven when live', () => {
    const live = build(provingLog(), { doctor: [SLUG_OK], meta: metaWith() })
    expect(live.filter((link) => link.state === 'verified').map((link) => link.id)).toEqual([
      'browser-server',
      'repo-git',
      'agents-tmux',
      'transcripts-slug',
      'transcripts-flow',
      'otel',
      'uninstrumented-conductor',
    ])

    const fixture = build(provingLog(), { doctor: [SLUG_OK], meta: metaWith(), stream: FIXTURE })
    const green = fixture.filter((link) => link.state === 'verified').map((link) => link.id)
    // Only the row the fold does not feed at all survives — see the poll test below.
    expect(green).toEqual(['transcripts-slug'])
  })

  it('names the fixture on the row itself, as the reason, rather than leaving it to a banner', () => {
    const fixture = build(provingLog(), { doctor: [SLUG_OK], meta: metaWith(), stream: FIXTURE })

    for (const link of fixture) {
      if (link.id === 'transcripts-slug') continue
      expect(link.state, link.id).toBe('unproven')
      expect(link.notes.join(' '), `${link.id} does not say why it is silent`).toContain('20-lane synthetic fleet')
      // A fabricated fact is not a fact worth keeping beside an honest word.
      expect(link.fact, link.id).toBeNull()
    }
  })

  /**
   * **THE SYNTHETIC LANE'S COMMAND MUST NOT BE COPYABLE.** `lane-17` exists
   * only inside the fixture; handing an operator `rhizomorph env lane-17 …` is
   * worse than an unhelpful row, because it is an instruction to do something
   * pointless and then wonder why nothing changed. `index.tsx` renders a copy
   * button only where there is a command, so clearing it is what removes the
   * button — the row stops offering the action rather than offering it with a
   * caveat attached.
   */
  it('hands out no copyable command for a lane that only exists in the fixture', () => {
    const state = reduceAll([
      f.toolActivity({ lane: 'lane-17', role: 'conductor', sessionId: 'sess-synthetic', tool: 'Bash' }, { ts: NOW - 10 * 60_000, source: 'sessionlog' }),
    ])
    expect(row(build(state), 'uninstrumented-conductor').command).toBe('rhizomorph env lane-17 --role conductor --port 4317')

    const fixture = build(state, { stream: FIXTURE })
    const link = row(fixture, 'uninstrumented-conductor')

    expect(link.state).toBe('unproven')
    expect(link.command).toBeNull()
    expect(link.warning).toBeNull()
    expect(link.reason).toBeNull()
    for (const other of fixture) expect(other.command, other.id).toBeNull()
    expect(JSON.stringify(fixture)).not.toContain('rhizomorph env')
  })

  /** A fixture in the fold says nothing about whether the directory doctor just probed exists. */
  it('leaves the poll-derived slug row alone — doctor probed this filesystem, whatever drives the fold', () => {
    const link = row(build(reduceAll([]), { doctor: [SLUG_OK], stream: FIXTURE }), 'transcripts-slug')

    expect(link.state).toBe('verified')
    expect(link.notes.join(' ')).not.toContain('synthetic fleet')
  })
})

describe('a dead stream is not evidence either — #345', () => {
  /**
   * **THE LAW.** A fold row's checker is the SSE stream; when the stream dies,
   * nothing is checking, and VERIFIED — which means "I checked, and it holds",
   * not "this was true once" — has to be withdrawn. Leaving it green with a
   * timestamp makes staleness legible rather than loud, and glancing is what
   * people do on a page they opened because something was already wrong.
   */
  it('drops a fold-derived VERIFIED row to UNPROVEN when the stream is down, keeping the fact and its date', () => {
    const alive = row(build(provingLog()), 'repo-git')
    expect(alive.state).toBe('verified')

    const dead = row(build(provingLog(), { stream: DEAD }), 'repo-git')

    expect(dead.state).toBe('unproven')
    // Not a fourth LAST KNOWN state: UNPROVEN plus a dated fact says the same
    // thing with a word the reader has already had to learn.
    expect(dead.fact).toBe(alive.fact)
    expect(dead.ts).toBe(1_000)
    expect(dead.tsKind).toBe('event')
    expect(dead.notes.join(' ')).toContain('the last one that WAS proven')
    expect(dead.notes.join(' ')).toContain('the event stream is closed')
  })

  /**
   * **THE SUBSTANCE OF THE RULING: not all seven rows come from the fold.**
   * `/api/doctor` has its own freshness and its own failure mode, and a dead
   * SSE says nothing about whether the last poll succeeded. Treating all seven
   * identically is what makes this look like a hard problem.
   */
  it('leaves the poll-derived slug row VERIFIED while every fold row goes unproven', () => {
    const links = build(provingLog(), { doctor: [SLUG_OK], stream: DEAD })

    expect(row(links, 'transcripts-slug').state).toBe('verified')
    expect(row(links, 'transcripts-slug').notes.join(' ')).not.toContain('nothing has checked')
    for (const id of ['repo-git', 'agents-tmux', 'transcripts-flow', 'otel', 'uninstrumented-conductor']) {
      expect(row(links, id).state, id).toBe('unproven')
    }
  })

  it('does it for an errored stream as well as a closed one, and not for one still opening', () => {
    const errored = { status: 'error' as const, eventCount: 5, provenance: 'live · /api/stream', live: true }
    expect(row(build(provingLog(), { stream: errored }), 'otel').state).toBe('unproven')

    // `connecting` is the ordinary first moment of every page load. Demoting
    // there would make the first paint contradict the /api/meta body it just
    // read — the failure `mergeUninstrumented` was ruled in to remove.
    const opening = { status: 'connecting' as const, eventCount: 5, provenance: 'live · /api/stream', live: true }
    expect(row(build(provingLog(), { stream: opening }), 'otel').state).toBe('verified')
  })

  /**
   * Only VERIFIED is withdrawn. A refusal that folded is something that
   * happened, and the stream dying afterwards does not un-happen it — so the
   * fault, and the remedy for it, stay exactly where they were.
   */
  it('keeps a fold-derived BROKEN row broken, with its command, when the stream dies', () => {
    const state = reduceAll([f.make('telemetry.refused', { instance: 'sess-other', expectedInstance: 'sess-ours', count: 4 }, { ts: 1_000 })])
    const link = row(build(state, { stream: DEAD }), 'otel')

    expect(link.state).toBe('broken')
    expect(link.reason).toContain('sess-other')
    expect(link.command).toBe('rhizomorph env <lane> --port 4317')
    expect(link.warning).toBe(SAME_PROCESS_WARNING)
  })
})

describe('the command builders', () => {
  it('interpolates the port from location, falling back to the scheme\'s own default when it is implied', () => {
    expect(portFrom({ port: '4317', protocol: 'http:' })).toBe('4317')
    expect(portFrom({ port: '', protocol: 'http:' })).toBe('80')
    expect(portFrom({ port: '', protocol: 'https:' })).toBe('443')
  })

  it('keeps `<lane>` a literal placeholder rather than guessing a handle', () => {
    expect(envCommand(null, null, '4317')).toBe('rhizomorph env <lane> --port 4317')
    expect(envCommand('lane-a', 'worker', '4317')).toBe('rhizomorph env lane-a --role worker --port 4317')
    expect(envCommand('lane-a', 'unattributed', '4317')).toBe('rhizomorph env lane-a --port 4317')
  })

  it('states the same-process SCAR verbatim', () => {
    expect(SAME_PROCESS_WARNING).toBe('the env block must be exported in the process that execs the agent')
  })
})
