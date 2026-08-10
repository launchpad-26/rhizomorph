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
import type { DoctorFact, MetaFacts } from './meta.js'

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
   * Ruling 3's whole shape, asserted as an invariant rather than row by row:
   * exactly one state, and each state carries exactly the evidence its own
   * name promises. A VERIFIED row with a remedy attached, or a BROKEN row
   * with no reason, would be a fourth state wearing one of the three names.
   */
  it('gives every row exactly one state, and only that state carries its evidence', () => {
    const state = reduceAll([
      f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, { ts: 1_000 }),
      f.make('telemetry.refused', { instance: 'stale', expectedInstance: 'ours', count: 2 }, { ts: 2_000 }),
    ])

    for (const link of build(state)) {
      expect(['verified', 'broken', 'unproven']).toContain(link.state)
      if (link.state === 'verified') {
        expect(link.fact, link.id).not.toBeNull()
        expect(link.reason, link.id).toBeNull()
        expect(link.command, link.id).toBeNull()
      }
      if (link.state === 'broken') {
        expect(link.reason, link.id).not.toBeNull()
        expect(link.fact, link.id).toBeNull()
      }
      if (link.state === 'unproven') {
        expect(link.fact, link.id).toBeNull()
        expect(link.reason, link.id).toBeNull()
        expect(link.command, link.id).toBeNull()
      }
    }
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

  it('names the "declared no instance at all" offender as such, never as an empty string', () => {
    const state = reduceAll([f.make('telemetry.refused', { instance: null, expectedInstance: 'sess-ours', count: 1 }, { ts: 1_000 })])
    expect(row(build(state), 'otel').reason).toContain('declared no instance at all')
  })

  /**
   * The refusal summary `/api/meta` serves (#255) says the same thing the
   * fold does; a page that only read the fold would still be right, and a
   * page that only read meta would go stale. Either witness alone is enough
   * to reach BROKEN.
   */
  it('reaches BROKEN from /api/meta\'s refusal summary alone, when the fold has not seen one', () => {
    const meta: MetaFacts = {
      sessionId: 'sess-ours',
      repoPath: '/repo',
      repoName: 'repo',
      rung: 'L1',
      collectors: [],
      connection: {
        sources: {},
        uninstrumentedSessions: [],
        refusals: { count: 7, instance: 'sess-other', expectedInstance: 'sess-ours' },
      },
      boot: null,
    }
    const otel = row(build(reduceAll([]), { meta }), 'otel')

    expect(otel.state).toBe('broken')
    expect(otel.reason).toContain('7 telemetry exports refused')
  })

  it('flips to VERIFIED once an otel-origin event folds, and keeps the standing refusal as a note rather than erasing it', () => {
    const state = reduceAll([
      f.make('telemetry.refused', { instance: 'sess-other', expectedInstance: 'sess-ours', count: 1 }, { ts: 1_000 }),
      f.llmUsage({ sessionId: 'sess-live' }, { ts: 2_000, source: 'otel' }),
    ])
    const otel = row(build(state), 'otel')

    expect(otel.state).toBe('verified')
    expect(otel.fact).toContain('OTel')
    expect(otel.ts).toBe(2_000)
    expect(otel.notes.join(' ')).toContain('refused')
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
    const meta: MetaFacts = {
      sessionId: 'sess-ours',
      repoPath: '/repo',
      repoName: 'repo',
      rung: 'L0',
      collectors: [
        {
          name: 'git',
          signals: [{ signal: 'identity', level: 'absent', reason: 'git collector disabled: not a repository', remedy: 'point the server at a git worktree' }],
        },
      ],
      connection: null,
      boot: null,
    }
    const git = row(build(reduceAll([]), { meta }), 'repo-git')

    expect(git.state).toBe('broken')
    expect(git.reason).toBe('git collector disabled: not a repository')
    expect(git.notes.join(' ')).toContain('point the server at a git worktree')
  })

  it('keeps agents ↔ tmux/workmux unproven while only one of the two is disabled — a live mechanism has not reported, it has not died', () => {
    const meta: MetaFacts = {
      sessionId: null,
      repoPath: null,
      repoName: null,
      rung: null,
      collectors: [{ name: 'tmux', signals: [{ signal: 'identity', level: 'absent', reason: 'tmux not on PATH', remedy: null }] }],
      connection: null,
      boot: null,
    }
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

  it('reads the slug directory from doctor, and says so when doctor never answered', () => {
    expect(row(build(reduceAll([]), { doctor: [slugOk] }), 'transcripts-slug').state).toBe('verified')
    expect(row(build(reduceAll([]), { doctor: [slugMissing] }), 'transcripts-slug').state).toBe('broken')

    const unread = row(build(reduceAll([])), 'transcripts-slug')
    expect(unread.state).toBe('unproven')
    expect(unread.notes.join(' ')).toContain('unavailable')
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
    const meta: MetaFacts = { sessionId: null, repoPath: '/home/x/repo', repoName: 'repo', rung: null, collectors: [], connection: null, boot: null }
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
