import { createEvent, createIdFactory, reduceAll, type RhizomorphEvent } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import {
  buildFleet,
  evidenceLine,
  findCycle,
  INFERRED_MARK,
  PATHOLOGY_KINDS,
  type AttentionItem,
  type Fleet,
  type Lane,
  type Ladder,
  type PathologyKind,
} from './buildFleet.js'
import type { LaneManifest } from './fences.js'
import {
  finishedSpec,
  fixtureHistory,
  fleet20Spec,
  manifestFor,
  pathologySpec,
  type FixtureSpec,
} from './fixtures.js'

/**
 * The instrument's central claim is that a pathology is *derived from recorded
 * facts*, not asserted by a fixture. These tests hold it to account: they build
 * each fixture's event log, fold it through core's real reducer, and check that
 * the detectors find what the events describe — and, just as importantly, that
 * they stay quiet on the fleet where nothing is wrong.
 */

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

function fleetFor(spec: FixtureSpec): Fleet {
  const state = reduceAll(fixtureHistory(spec, NOW))
  return buildFleet(state, { now: NOW, manifest: manifestFor(spec) })
}

function laneIn(fleet: Fleet, id: string): Lane {
  const lane = fleet.lanes.find((candidate) => candidate.id === id)
  expect(lane, `lane ${id} is missing from the fleet`).toBeDefined()
  return lane as Lane
}

function kindsFor(fleet: Fleet, id: string): PathologyKind[] {
  return laneIn(fleet, id).pathologies.map((pathology) => pathology.kind)
}

function evidenceFor(fleet: Fleet, id: string, kind: PathologyKind): string {
  const pathology = laneIn(fleet, id).pathologies.find((candidate) => candidate.kind === kind)
  expect(pathology, `${id} has no ${kind} pathology`).toBeDefined()
  return pathology === undefined ? '' : pathology.evidence
}

describe('the staged-pathology fixture', () => {
  const fleet = fleetFor(pathologySpec())

  it('renders every lane — ruling 22, at any count', () => {
    expect(fleet.lanes).toHaveLength(pathologySpec().lanes.length)
  })

  it('finds exactly one lane per pathology, and no sixth kind', () => {
    const counts = new Map<PathologyKind, number>()
    for (const lane of fleet.lanes) {
      for (const pathology of lane.pathologies) {
        counts.set(pathology.kind, (counts.get(pathology.kind) ?? 0) + 1)
      }
    }
    expect(Object.fromEntries(counts)).toEqual({
      looping: 1,
      frozen: 1,
      waiting: 1,
      expensive: 1,
      'off-fence': 1,
    })
    expect([...counts.keys()].sort()).toEqual([...PATHOLOGY_KINDS].sort())
  })

  it('flags the right lane for each', () => {
    expect(kindsFor(fleet, '41-retry-parser')).toContain('looping')
    expect(kindsFor(fleet, '42-otel-receiver')).toContain('frozen')
    expect(kindsFor(fleet, '43-drawer-attach')).toContain('waiting')
    expect(kindsFor(fleet, '44-scene-pulses')).toContain('expensive')
    expect(kindsFor(fleet, '45-ledger-subrows')).toContain('off-fence')
  })

  it('never calls the same silence both frozen and waiting', () => {
    for (const lane of fleet.lanes) {
      const kinds = lane.pathologies.map((pathology) => pathology.kind)
      expect(kinds.includes('frozen') && kinds.includes('waiting')).toBe(false)
    }
  })

  it('ranks frozen BROKEN, the stuck ones NEEDS-YOU, and a burn outlier only NOTICE', () => {
    expect(laneIn(fleet, '42-otel-receiver').rank).toBe('broken')
    expect(laneIn(fleet, '41-retry-parser').rank).toBe('needs-you')
    expect(laneIn(fleet, '43-drawer-attach').rank).toBe('needs-you')
    expect(laneIn(fleet, '45-ledger-subrows').rank).toBe('needs-you')
    // Spending a lot is worth knowing; it is not worth interrupting for.
    expect(laneIn(fleet, '44-scene-pulses').rank).toBe('notice')
    expect(fleet.ladder.rank).toBe('broken')
  })

  it('carries an evidence string for every fault — never a bare label (graft g4)', () => {
    for (const lane of fleet.lanes) {
      for (const pathology of lane.pathologies) {
        expect(pathology.evidence.length).toBeGreaterThan(0)
        expect(pathology.evidence).not.toBe(pathology.kind)
      }
    }

    expect(evidenceFor(fleet, '41-retry-parser', 'looping')).toBe('Read→Edit→Bash ×6, no commit')
    expect(evidenceFor(fleet, '42-otel-receiver', 'frozen')).toMatch(/^no events for \d+m\d\ds$/)
    expect(evidenceFor(fleet, '43-drawer-attach', 'waiting')).toMatch(/^workmux reports waiting /)
    expect(evidenceFor(fleet, '44-scene-pulses', 'expensive')).toMatch(
      /^\d+ out-tok\/min, \d+\.\d× fleet median$/,
    )
    // `touching <lane> — N files`: the trespass names its victim, not just itself.
    expect(evidenceFor(fleet, '45-ledger-subrows', 'off-fence')).toBe(
      'touching 46-spend-selectors — 1 file',
    )
  })

  it('names the trespassed lane, not merely the trespass', () => {
    const offender = laneIn(fleet, '45-ledger-subrows')
    expect(offender.trespasses.map((trespass) => trespass.victim)).toEqual(['46-spend-selectors'])
    expect(offender.trespasses.map((trespass) => trespass.path)).toEqual([
      'packages/core/src/selectors/spend-subrows.ts',
    ])
  })

  it('reports waiting as declared rather than inferred, because workmux said so', () => {
    const waiting = laneIn(fleet, '43-drawer-attach').pathologies.find(
      (pathology) => pathology.kind === 'waiting',
    )
    expect(waiting?.inferred).toBe(false)
    expect(evidenceLine(waiting!)).not.toContain(INFERRED_MARK)
  })

  it('puts one ladder item per fault, and the fleet on the worst of them', () => {
    const ladder = fleet.ladder
    expect(ladder.rank).toBe('broken')
    if (ladder.rank === 'calm') throw new Error('unreachable: the staged fleet is not calm')
    expect(ladder.items.map((item) => item.kind).sort()).toEqual([...PATHOLOGY_KINDS].sort())
    // Every item can be jumped to: a lane fault names the lane it belongs to.
    for (const item of ladder.items) expect(item.laneId).not.toBeNull()
  })

  it('keeps subagent work visible as its own filaments (ruling 20)', () => {
    const withSubagents = fleet.lanes.filter((lane) =>
      lane.filaments.some((filament) => filament.thread === 'subagent'),
    )
    expect(withSubagents.length).toBeGreaterThan(0)
    for (const lane of withSubagents) {
      const subagent = lane.filaments.find((filament) => filament.thread === 'subagent')
      expect(subagent?.outputTokens).toBeGreaterThan(0)
    }
  })
})

describe('the 20-lane fixture', () => {
  const fleet = fleetFor(fleet20Spec())

  it('threads all twenty lanes — ruling 22, render everything', () => {
    expect(fleet.lanes).toHaveLength(20)
  })

  it('is ALL CLEAR, and says what it checked to have earned it (ruling 14)', () => {
    const ladder = fleet.ladder
    expect(ladder.rank).toBe('calm')
    if (ladder.rank !== 'calm') throw new Error('unreachable: the 20-lane fleet is calm')

    expect(ladder.items).toHaveLength(0)
    expect(ladder.evidence.collisions).toBe(0)
    expect(ladder.evidence.lanes).toBe(20)
    expect(ladder.evidence.working).toBe(20)
    expect(ladder.evidence.line).toBe('collisions: 0 — checked 20 branches / 20 files')
  })

  it('diagnoses nothing, because nothing was staged in it', () => {
    for (const lane of fleet.lanes) {
      expect(lane.pathologies).toEqual([])
      expect(lane.activity).toBe('working')
    }
  })

  it('keeps the burn spread inside the outlier test, so ALL CLEAR is a finding', () => {
    const rates = fleet.lanes.map((lane) => lane.outputPerMin).sort((a, b) => a - b)
    const median = rates[Math.floor(rates.length / 2)] as number
    const highest = rates[rates.length - 1] as number
    expect(highest).toBeLessThan(median * 3)
  })
})

describe('a fleet that has finished', () => {
  const fleet = fleetFor(finishedSpec())

  it('reads as done, not as seventeen flatlines', () => {
    expect(fleet.lanes).toHaveLength(17)
    for (const lane of fleet.lanes) {
      expect(lane.activity).toBe('done')
      expect(lane.pathologies).toEqual([])
    }
    expect(fleet.ladder.rank).toBe('calm')
  })

  it('stays quiet even though every lane is far past the frozen threshold', () => {
    for (const lane of fleet.lanes) {
      expect(lane.ageMs ?? 0).toBeGreaterThan(8 * 60_000)
      expect(lane.pathologies.map((pathology) => pathology.kind)).not.toContain('frozen')
    }
  })
})

// ── the ladder floor (graft g5) ─────────────────────────────────────────────

const nextId = createIdFactory('lf')

function event<T extends Parameters<typeof createEvent>[0]>(
  type: T,
  payload: Parameters<typeof createEvent<T>>[1],
  ts: number,
): RhizomorphEvent {
  return createEvent(type, payload, { id: nextId(), ts })
}

/** Two healthy lanes, both with their hands on one file. Nothing else is wrong. */
function collidingLog(now: number): RhizomorphEvent[] {
  const shared = 'packages/core/src/selectors/spend.ts'
  return [
    event('session.started', {
      sessionId: 'floor',
      repoPath: '/repo',
      repoName: 'rhizomorph',
      mainBranch: 'main',
    }, now - 60_000),
    event('worktree.discovered', { path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, now - 60_000),
    event('worktree.discovered', { path: '/repo-wt/a', branch: 'a', head: 'sha-a', isMain: false }, now - 60_000),
    event('worktree.discovered', { path: '/repo-wt/b', branch: 'b', head: 'sha-b', isMain: false }, now - 60_000),
    event('worktree.dirty', { path: '/repo-wt/a', branch: 'a', files: [{ path: shared, status: 'modified' }] }, now - 5_000),
    event('worktree.dirty', { path: '/repo-wt/b', branch: 'b', files: [{ path: shared, status: 'modified' }] }, now - 5_000),
    event('agent.status', { handle: 'a', status: 'working', worktreePath: '/repo-wt/a', branch: 'a' }, now - 4_000),
    event('agent.status', { handle: 'b', status: 'working', worktreePath: '/repo-wt/b', branch: 'b' }, now - 4_000),
  ]
}

describe('the ladder floor', () => {
  const fleet = buildFleet(reduceAll(collidingLog(NOW)), { now: NOW })

  it('raises the rung in the model when a file is contended (ruling 14)', () => {
    expect(fleet.collisions).toHaveLength(1)
    expect(fleet.ladder.rank).not.toBe('calm')
    expect(fleet.rank).toBe(fleet.ladder.rank)
  })

  it('reports the whole collision as ONE item, not one per contended file', () => {
    const ladder = fleet.ladder
    if (ladder.rank === 'calm') throw new Error('unreachable: a collision is not calm')
    expect(ladder.items.filter((item) => item.kind === 'collision')).toHaveLength(1)
    // A collision belongs to a pair of branches, so it must not be able to put
    // the scene's spotlight on an arbitrary half of it.
    const collision = ladder.items.find((item) => item.kind === 'collision') as AttentionItem
    expect(collision.laneId).toBeNull()
    expect(collision.evidence).toContain('packages/core/src/selectors/spend.ts')
  })

  it('makes ALL CLEAR-beside-a-collision unrepresentable, not merely discouraged', () => {
    const ladder: Ladder = fleet.ladder

    // @ts-expect-error — `evidence` exists only on the calm case. This line
    // failing to compile IS the guarantee: a view cannot print the ALL CLEAR
    // line without first narrowing to a ladder that has no items in it, and
    // `buildLadder` never returns that case once a collision is in the list.
    expect(ladder.evidence).toBeUndefined()

    if (ladder.rank !== 'calm') {
      // Non-empty tuple: indexing at 0 type-checks under noUncheckedIndexedAccess
      // only because a non-calm rung is guaranteed to carry at least one item.
      const first: AttentionItem = ladder.items[0]
      expect(first.kind).toBeDefined()
    }
  })

  it("a removed worktree's dirty files stop counting as contended, end to end", () => {
    // Same shared file as the base fixture, but branch `b`'s worktree is
    // removed afterward: it landed and folded, so its ghost must not keep
    // arguing with `a` over a file it no longer holds.
    const log = [...collidingLog(NOW), event('worktree.removed', { path: '/repo-wt/b' }, NOW - 1_000)]
    const fleet = buildFleet(reduceAll(log), { now: NOW })

    expect(fleet.collisions).toEqual([])
    expect(fleet.ladder.items.some((item) => item.kind === 'collision')).toBe(false)
    expect(laneIn(fleet, 'a').dirtyCount).toBe(1)
    expect(laneIn(fleet, 'b').dirtyCount).toBe(0)
  })
})

// ── detection honesty (ruling 18) ───────────────────────────────────────────

describe('detection honesty', () => {
  it('marks an inferred WAITING and leaves a declared one unmarked', () => {
    // Telemetry has gone quiet for two minutes, but the pane moved a moment
    // ago and nobody declared anything: a raised hand is the best reading
    // available, and it is a deduction rather than a fact.
    const log = [
      event('session.started', {
        sessionId: 'infer',
        repoPath: '/repo',
        repoName: 'rhizomorph',
        mainBranch: 'main',
      }, NOW - 600_000),
      event('worktree.discovered', { path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, NOW - 600_000),
      event('worktree.discovered', { path: '/repo-wt/q', branch: 'q', head: 'sha-q', isMain: false }, NOW - 600_000),
      event('pane.discovered', { paneId: '%9', windowName: 'q', currentPath: '/repo-wt/q', worktreePath: '/repo-wt/q' }, NOW - 600_000),
      event('worktree.dirty', { path: '/repo-wt/q', branch: 'q', files: [{ path: 'a.ts', status: 'modified' }] }, NOW - 130_000),
      event('pane.activity', { paneId: '%9', contentHash: 'h1', preview: 'Do you want to proceed?' }, NOW - 5_000),
    ]

    const fleet = buildFleet(reduceAll(log), { now: NOW })
    const waiting = laneIn(fleet, 'q').pathologies.find(
      (pathology) => pathology.kind === 'waiting',
    )

    expect(waiting?.inferred).toBe(true)
    expect(waiting?.evidence).toMatch(/^quiet .*, pane still alive$/)
    expect(evidenceLine(waiting!).startsWith(`${INFERRED_MARK} `)).toBe(true)
  })

  it('lets a declared WAITING lapse once its worktree is removed, rather than standing forever', () => {
    // workmux's last report never un-says itself once the handle goes quiet —
    // the agent record simply stands. But a removed worktree has landed, the
    // same honesty exemption FROZEN gets, and a stale "waiting" must not
    // stand in for a live raised hand once that has happened.
    const log = [
      event('session.started', {
        sessionId: 'waiting-removed',
        repoPath: '/repo',
        repoName: 'rhizomorph',
        mainBranch: 'main',
      }, NOW - 600_000),
      event('worktree.discovered', { path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, NOW - 600_000),
      event('worktree.discovered', { path: '/repo-wt/r', branch: 'r', head: 'sha-r', isMain: false }, NOW - 600_000),
      event('agent.status', { handle: 'r', status: 'waiting', worktreePath: '/repo-wt/r', branch: 'r' }, NOW - 500_000),
      event('worktree.removed', { path: '/repo-wt/r' }, NOW - 300_000),
    ]

    const fleet = buildFleet(reduceAll(log), { now: NOW })
    const lane = laneIn(fleet, 'r')

    expect(lane.present).toBe(false)
    expect(lane.pathologies.map((pathology) => pathology.kind)).not.toContain('waiting')
    expect(lane.rank).toBe('calm')
    expect(lane.activity).toBe('done')
    expect(fleet.ladder.rank).toBe('calm')
  })

  it('never infers off-fence without a manifest, and names the gap instead', () => {
    // The same staged fleet, with the manifest withheld: the lane really is
    // outside its fence, and the instrument still refuses to say so, because
    // a fence it invented would let it accuse an innocent lane.
    const state = reduceAll(fixtureHistory(pathologySpec(), NOW))
    const blind = buildFleet(state, { now: NOW, manifest: null })

    expect(blind.hasLaneManifest).toBe(false)
    for (const lane of blind.lanes) {
      expect(lane.fenced).toBe(false)
      expect(lane.trespasses).toEqual([])
      expect(lane.pathologies.map((pathology) => pathology.kind)).not.toContain('off-fence')
    }

    const gap = blind.gaps.find((candidate) => candidate.id === 'no-lane-manifest')
    expect(gap?.line).toBe(
      'NO LANE MANIFEST (.swarm/lanes.json) — off-fence detection unavailable — run: dispatch.sh (writes the fence manifest)',
    )
  })
})

// ── the second witness (#133) ───────────────────────────────────────────────

/** One trace span, attributed to `lane`, received at `ts`. */
function span(lane: string, worktreePath: string, ts: number): RhizomorphEvent {
  return createEvent(
    'trace.span',
    {
      lane,
      role: 'worker',
      sessionId: null,
      worktreePath,
      branch: lane,
      thread: 'subagent',
      traceId: `trace-${lane}`,
      spanId: `span-${lane}-${ts}`,
      parentSpanId: null,
      name: 'claude_code.tool',
      kind: 'tool',
      startTs: ts - 500,
      endTs: ts,
      status: 'ok',
    },
    { id: nextId(), ts },
  )
}

describe('the second witness: telemetry recency alongside pane stillness', () => {
  it('reads a delegating lane as working when its pane is still but its trace keeps talking (the recorded false positive)', () => {
    // The dogfooding incident (#133): a lane's pane goes silent — no
    // content-hash change — for as long as it delegates to a subagent, which
    // is exactly when it is busiest. Before the second witness, that silence
    // alone read FROZEN even though the lane's own trace was live throughout.
    const HANDLE = 'f'
    const log = [
      event('session.started', {
        sessionId: 'span-witness-ok',
        repoPath: '/repo',
        repoName: 'rhizomorph',
        mainBranch: 'main',
      }, NOW - 20 * 60_000),
      event('worktree.discovered', { path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, NOW - 20 * 60_000),
      event('worktree.discovered', { path: '/repo-wt/f', branch: HANDLE, head: 'sha-f', isMain: false }, NOW - 20 * 60_000),
      event('pane.discovered', { paneId: '%40', windowName: HANDLE, currentPath: '/repo-wt/f', worktreePath: '/repo-wt/f' }, NOW - 20 * 60_000),
      event('pane.activity', { paneId: '%40', contentHash: 'h0', preview: 'delegating to Explore…' }, NOW - 12 * 60_000),
      event('agent.status', { handle: HANDLE, status: 'working', worktreePath: '/repo-wt/f', branch: HANDLE }, NOW - 12 * 60_000),
      span(HANDLE, '/repo-wt/f', NOW - 4_000),
    ]

    const fleet = buildFleet(reduceAll(log), { now: NOW })
    const lane = laneIn(fleet, HANDLE)

    expect(lane.pathologies.map((pathology) => pathology.kind)).not.toContain('frozen')
    expect(lane.pathologies.map((pathology) => pathology.kind)).not.toContain('waiting')
    expect(lane.activity).toBe('working')
  })

  it('still calls FROZEN when the trace is as silent as the pane — the real flatline is not weakened', () => {
    const HANDLE = 'g'
    const log = [
      event('session.started', {
        sessionId: 'span-witness-still-frozen',
        repoPath: '/repo',
        repoName: 'rhizomorph',
        mainBranch: 'main',
      }, NOW - 20 * 60_000),
      event('worktree.discovered', { path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, NOW - 20 * 60_000),
      event('worktree.discovered', { path: '/repo-wt/g', branch: HANDLE, head: 'sha-g', isMain: false }, NOW - 20 * 60_000),
      event('pane.discovered', { paneId: '%41', windowName: HANDLE, currentPath: '/repo-wt/g', worktreePath: '/repo-wt/g' }, NOW - 20 * 60_000),
      event('pane.activity', { paneId: '%41', contentHash: 'h0', preview: 'delegating to Explore…' }, NOW - 15 * 60_000),
      event('agent.status', { handle: HANDLE, status: 'working', worktreePath: '/repo-wt/g', branch: HANDLE }, NOW - 15 * 60_000),
      // Older than `SPAN_WITNESS_WINDOW_MS`: too old to speak for the lane
      // now, so it must not rescue it either.
      span(HANDLE, '/repo-wt/g', NOW - 15 * 60_000),
    ]

    const fleet = buildFleet(reduceAll(log), { now: NOW })

    expect(kindsFor(fleet, HANDLE)).toContain('frozen')
  })

  it('lets pane silence alone govern FROZEN when a lane carries no telemetry at all — the uninstrumented case', () => {
    // The common junior setup: no OTel, no sessionlog collector, just
    // workmux's own pane feed. The second witness must never turn an absent
    // signal into a reprieve — degraded setups keep their flatline detection.
    const HANDLE = 'j'
    const log = [
      event('session.started', {
        sessionId: 'span-witness-no-telemetry',
        repoPath: '/repo',
        repoName: 'rhizomorph',
        mainBranch: 'main',
      }, NOW - 20 * 60_000),
      event('worktree.discovered', { path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, NOW - 20 * 60_000),
      event('worktree.discovered', { path: '/repo-wt/j', branch: HANDLE, head: 'sha-j', isMain: false }, NOW - 20 * 60_000),
      event('pane.discovered', { paneId: '%42', windowName: HANDLE, currentPath: '/repo-wt/j', worktreePath: '/repo-wt/j' }, NOW - 20 * 60_000),
      event('pane.activity', { paneId: '%42', contentHash: 'h0', preview: '$ ' }, NOW - 15 * 60_000),
    ]

    const fleet = buildFleet(reduceAll(log), { now: NOW })

    expect(kindsFor(fleet, HANDLE)).toContain('frozen')
  })
})

// ── parked (prd4 ruling 5) ───────────────────────────────────────────────────

describe('parked lanes', () => {
  const HANDLE = 'p'

  function manifestFor(parked: boolean): LaneManifest {
    return {
      [HANDLE]: {
        handle: HANDLE,
        fence: ['packages/parked/**'],
        issue: null,
        model: null,
        ...(parked ? { parked: true } : {}),
      },
    }
  }

  it('carries the manifest\'s declaration onto the lane, absence and an unset manifest both reading false', () => {
    const log = [
      event('session.started', {
        sessionId: 'parked-flag',
        repoPath: '/repo',
        repoName: 'rhizomorph',
        mainBranch: 'main',
      }, NOW - 60_000),
      event('worktree.discovered', { path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, NOW - 60_000),
      event('worktree.discovered', { path: '/repo-wt/p', branch: HANDLE, head: 'sha-p', isMain: false }, NOW - 60_000),
    ]
    const state = reduceAll(log)

    expect(laneIn(buildFleet(state, { now: NOW, manifest: manifestFor(true) }), HANDLE).parked).toBe(true)
    expect(laneIn(buildFleet(state, { now: NOW, manifest: manifestFor(false) }), HANDLE).parked).toBe(false)
    expect(laneIn(buildFleet(state, { now: NOW, manifest: null }), HANDLE).parked).toBe(false)
  })

  it('a lane that WOULD be FROZEN reads parked instead, and never reaches the ladder', () => {
    const log = [
      event('session.started', {
        sessionId: 'parked-frozen',
        repoPath: '/repo',
        repoName: 'rhizomorph',
        mainBranch: 'main',
      }, NOW - 20 * 60_000),
      event('worktree.discovered', { path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, NOW - 20 * 60_000),
      event('worktree.discovered', { path: '/repo-wt/p', branch: HANDLE, head: 'sha-p', isMain: false }, NOW - 20 * 60_000),
      event('agent.status', { handle: HANDLE, status: 'working', worktreePath: '/repo-wt/p', branch: HANDLE }, NOW - 15 * 60_000),
    ]
    const state = reduceAll(log)

    // Same silence, no manifest: this really would be FROZEN — the control.
    const unparked = buildFleet(state, { now: NOW, manifest: null })
    expect(kindsFor(unparked, HANDLE)).toContain('frozen')

    const parked = buildFleet(state, { now: NOW, manifest: manifestFor(true) })
    expect(laneIn(parked, HANDLE).parked).toBe(true)
    expect(kindsFor(parked, HANDLE)).not.toContain('frozen')
    expect(kindsFor(parked, HANDLE)).not.toContain('waiting')

    if (parked.ladder.rank !== 'calm') {
      expect(parked.ladder.items.some((item) => item.laneId === HANDLE)).toBe(false)
    }
  })

  it("suppresses only the alarm inference — a parked lane's real new activity still shows in OUTPUT/AGE", () => {
    const log = [
      event('session.started', {
        sessionId: 'parked-active',
        repoPath: '/repo',
        repoName: 'rhizomorph',
        mainBranch: 'main',
      }, NOW - 60_000),
      event('worktree.discovered', { path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, NOW - 60_000),
      event('worktree.discovered', { path: '/repo-wt/p', branch: HANDLE, head: 'sha-p', isMain: false }, NOW - 60_000),
      event('llm.usage', {
        lane: HANDLE,
        role: 'worker',
        model: 'claude-opus-5',
        tokens: { input: 10, output: 500, cacheRead: 0, cacheCreation: 0 },
        branch: HANDLE,
        worktreePath: '/repo-wt/p',
      }, NOW - 5_000),
    ]

    const fleet = buildFleet(reduceAll(log), { now: NOW, manifest: manifestFor(true) })
    const lane = laneIn(fleet, HANDLE)

    expect(lane.parked).toBe(true)
    expect(lane.outputTokens).toBe(500)
    expect(lane.ageMs).not.toBeNull()
    expect(lane.ageMs ?? Infinity).toBeLessThan(10_000)
    expect(lane.pathologies.map((pathology) => pathology.kind)).not.toContain('frozen')
    expect(lane.pathologies.map((pathology) => pathology.kind)).not.toContain('waiting')
  })
})

// ── conductor cost visibility (#88) ─────────────────────────────────────────

describe('conductor cost visibility', () => {
  it('folds a conductor llm.cost event into the fleet, even though tokens are filtered to one origin', () => {
    // `llm.cost` is otel-only (sessionlog never emits dollars), so the
    // token-origin allowlist that dedups usage/rate aggregation must not be
    // the thing `conductorInstrumented` is read off of, or a real cost feed
    // reads as "not instrumented" on every setup that has one.
    const log = [
      event('session.started', {
        sessionId: 'cost-vis',
        repoPath: '/repo',
        repoName: 'rhizomorph',
        mainBranch: 'main',
      }, NOW - 10_000),
      event('worktree.discovered', { path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, NOW - 10_000),
      createEvent(
        'llm.cost',
        { lane: 'conductor', role: 'conductor', model: 'claude-opus-5', costUsd: 0.42, authoritative: true },
        { id: nextId(), ts: NOW - 5_000, source: 'otel' },
      ),
    ]

    const fleet = buildFleet(reduceAll(log), { now: NOW })

    expect(fleet.burn.conductorInstrumented).toBe(true)
  })
})

// ── active time (#141) ───────────────────────────────────────────────────────

describe('Lane.activeSeconds', () => {
  function baseLog(now: number) {
    return [
      event('session.started', {
        sessionId: 'active-time',
        repoPath: '/repo',
        repoName: 'rhizomorph',
        mainBranch: 'main',
      }, now - 60_000),
      event('worktree.discovered', { path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, now - 60_000),
      event('worktree.discovered', { path: '/repo-wt/act', branch: 'act', head: 'sha-act', isMain: false }, now - 60_000),
    ]
  }

  it('is null for a lane no OTel active-time reading has ever reached — never an invented zero', () => {
    const fleet = buildFleet(reduceAll(baseLog(NOW)), { now: NOW })
    expect(laneIn(fleet, 'act').activeSeconds).toBeNull()
  })

  it('reports the one reading a lane sent', () => {
    const log = [
      ...baseLog(NOW),
      createEvent(
        'agent.activeTime',
        { lane: 'act', role: 'worker', activeSeconds: 300, sessionId: 'sess-act' },
        { id: nextId(), ts: NOW - 5_000, source: 'otel' },
      ),
    ]
    const fleet = buildFleet(reduceAll(log), { now: NOW })
    expect(laneIn(fleet, 'act').activeSeconds).toBe(300)
  })

  it('takes the high-water mark within a session that reset, not its latest reading', () => {
    // Same shape as `selectors/activity.ts`'s own tests: a session climbs to
    // 250s, restarts (a fresh CLI process reports a lower number), and the
    // fleet must keep crediting the lane with the peak it actually reached.
    const log = [
      ...baseLog(NOW),
      createEvent(
        'agent.activeTime',
        { lane: 'act', role: 'worker', activeSeconds: 250, sessionId: 'sess-act' },
        { id: nextId(), ts: NOW - 10_000, source: 'otel' },
      ),
      createEvent(
        'agent.activeTime',
        { lane: 'act', role: 'worker', activeSeconds: 40, sessionId: 'sess-act' },
        { id: nextId(), ts: NOW - 5_000, source: 'otel' },
      ),
    ]
    const fleet = buildFleet(reduceAll(log), { now: NOW })
    expect(laneIn(fleet, 'act').activeSeconds).toBe(250)
  })

  it('sums two sessions the same lane has run', () => {
    const log = [
      ...baseLog(NOW),
      createEvent(
        'agent.activeTime',
        { lane: 'act', role: 'worker', activeSeconds: 200, sessionId: 'sess-1' },
        { id: nextId(), ts: NOW - 10_000, source: 'otel' },
      ),
      createEvent(
        'agent.activeTime',
        { lane: 'act', role: 'worker', activeSeconds: 150, sessionId: 'sess-2' },
        { id: nextId(), ts: NOW - 5_000, source: 'otel' },
      ),
    ]
    const fleet = buildFleet(reduceAll(log), { now: NOW })
    expect(laneIn(fleet, 'act').activeSeconds).toBe(350)
  })
})

// ── #143: waited-on-human vitals ────────────────────────────────────────────

describe('Lane.waitedOnHuman', () => {
  function baseLog(now: number, extraLane?: string) {
    return [
      event('session.started', {
        sessionId: 'wait',
        repoPath: '/repo',
        repoName: 'rhizomorph',
        mainBranch: 'main',
      }, now - 60_000),
      event('worktree.discovered', { path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, now - 60_000),
      event('worktree.discovered', { path: '/repo-wt/w', branch: 'w', head: 'sha-w', isMain: false }, now - 60_000),
      ...(extraLane === undefined
        ? []
        : [event('worktree.discovered', { path: `/repo-wt/${extraLane}`, branch: extraLane, head: 'sha-x', isMain: false }, now - 60_000)]),
    ]
  }

  function blockedSpan(
    lane: string,
    spanId: string,
    waitMs: number,
    decision: 'accept' | 'reject' | 'unknown',
    ts: number,
  ): RhizomorphEvent {
    return event(
      'trace.span',
      {
        lane,
        role: 'worker',
        traceId: `trace-${lane}`,
        spanId,
        parentSpanId: null,
        name: 'claude_code.tool.blocked_on_user',
        kind: 'tool_blocked',
        startTs: ts - waitMs,
        endTs: ts,
        status: 'ok',
        decision,
        toolName: 'Bash',
      },
      ts,
    )
  }

  it("is the selector's own honest zero for a lane that never sat blocked on a human", () => {
    const fleet = buildFleet(reduceAll(baseLog(NOW)), { now: NOW })
    expect(laneIn(fleet, 'w').waitedOnHuman).toEqual({
      totalWaitMs: 0,
      waitCount: 0,
      decisions: { accept: 0, reject: 0, unknown: 0 },
      longestWait: null,
      longestWaitDecision: null,
    })
  })

  it('reports the total waited, the decision census, and the longest wait with its OWN decision', () => {
    const log = [
      ...baseLog(NOW),
      blockedSpan('w', 'blocked-1', 5_000, 'accept', NOW - 40_000),
      blockedSpan('w', 'blocked-2', 12_000, 'reject', NOW - 20_000),
    ]
    const fleet = buildFleet(reduceAll(log), { now: NOW })
    const waited = laneIn(fleet, 'w').waitedOnHuman

    expect(waited.totalWaitMs).toBe(17_000)
    expect(waited.waitCount).toBe(2)
    expect(waited.decisions).toEqual({ accept: 1, reject: 1, unknown: 0 })
    // The census counts both; the chip needs the ONE that belongs to the
    // longest wait specifically — the 12s reject, not the 5s accept.
    expect(waited.longestWait?.waitMs).toBe(12_000)
    expect(waited.longestWaitDecision).toBe('reject')
  })

  it("never lets another lane's longer wait leak into this one", () => {
    const log = [
      ...baseLog(NOW, 'other'),
      blockedSpan('w', 'blocked-w', 3_000, 'accept', NOW - 30_000),
      blockedSpan('other', 'blocked-o', 90_000, 'reject', NOW - 10_000),
    ]
    const fleet = buildFleet(reduceAll(log), { now: NOW })
    expect(laneIn(fleet, 'w').waitedOnHuman.longestWait?.waitMs).toBe(3_000)
    expect(laneIn(fleet, 'w').waitedOnHuman.longestWaitDecision).toBe('accept')
    expect(laneIn(fleet, 'other').waitedOnHuman.longestWait?.waitMs).toBe(90_000)
    expect(laneIn(fleet, 'other').waitedOnHuman.longestWaitDecision).toBe('reject')
  })

  it('never turns a wait into a pathology or moves the ladder off calm — memory, not a summons', () => {
    const log = [...baseLog(NOW), blockedSpan('w', 'blocked-big', 20 * 60_000, 'reject', NOW - 5_000)]
    const fleet = buildFleet(reduceAll(log), { now: NOW })
    expect(fleet.ladder.rank).toBe('calm')
    expect(laneIn(fleet, 'w').pathologies).toEqual([])
  })
})

describe('Lane.subagents', () => {
  function baseLog(now: number) {
    return [
      event('session.started', {
        sessionId: 'buds',
        repoPath: '/repo',
        repoName: 'rhizomorph',
        mainBranch: 'main',
      }, now - 60_000),
      event('worktree.discovered', { path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, now - 60_000),
      event('worktree.discovered', { path: '/repo-wt/s', branch: 's', head: 'sha-s', isMain: false }, now - 60_000),
    ]
  }

  it('is null — never a zeroed bud — for a lane with no thread-marked subagent telemetry', () => {
    const fleet = buildFleet(reduceAll(baseLog(NOW)), { now: NOW })
    expect(laneIn(fleet, 's').subagents).toBeNull()
  })

  it('reports a live, trace-enriched bud for a lane with recent thread: subagent telemetry', () => {
    const log = [
      ...baseLog(NOW),
      event(
        'llm.usage',
        {
          lane: 's',
          role: 'worker',
          model: 'claude-opus-5',
          tokens: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 },
          thread: 'subagent',
        },
        NOW - 30_000,
      ),
      event(
        'trace.span',
        {
          lane: 's',
          role: 'worker',
          traceId: 'trace-s',
          spanId: 'span-s-1',
          parentSpanId: null,
          name: 'claude_code.tool',
          kind: 'tool',
          startTs: NOW - 31_000,
          endTs: NOW - 30_500,
          status: 'ok',
          toolName: 'Task',
          agentId: 'agent-9',
          subagentType: 'Explore',
        },
        NOW - 30_000,
      ),
    ]
    const fleet = buildFleet(reduceAll(log), { now: NOW })
    expect(laneIn(fleet, 's').subagents).toEqual({
      lane: 's',
      lastActivityTs: NOW - 30_000,
      agentId: 'agent-9',
      subagentType: 'Explore',
    })
  })

  it('leaves the bud unenriched — never null — when the lane is live but uninstrumented by traces', () => {
    const log = [
      ...baseLog(NOW),
      event(
        'tool.activity',
        { lane: 's', tool: 'Read', thread: 'subagent' },
        NOW - 20_000,
      ),
    ]
    const fleet = buildFleet(reduceAll(log), { now: NOW })
    expect(laneIn(fleet, 's').subagents).toEqual({
      lane: 's',
      lastActivityTs: NOW - 20_000,
      agentId: null,
      subagentType: null,
    })
  })
})

// ── #154: MAIN's own subagent vital ─────────────────────────────────────────

describe('RootMass.subagents', () => {
  function baseLog(now: number) {
    return [
      event('session.started', {
        sessionId: 'main-buds',
        repoPath: '/repo',
        repoName: 'rhizomorph',
        mainBranch: 'main',
      }, now - 60_000),
      event('worktree.discovered', { path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, now - 60_000),
    ]
  }

  it('is null — never a zeroed bud — when the conductor has no thread-marked telemetry', () => {
    const fleet = buildFleet(reduceAll(baseLog(NOW)), { now: NOW })
    expect(fleet.root.subagents).toBeNull()
  })

  it("reports a live, trace-enriched bud for the conductor's own subagent thread", () => {
    const log = [
      ...baseLog(NOW),
      event(
        'llm.usage',
        {
          lane: 'conductor',
          role: 'conductor',
          model: 'claude-opus-5',
          tokens: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 },
          thread: 'subagent',
        },
        NOW - 30_000,
      ),
      event(
        'trace.span',
        {
          lane: 'conductor',
          role: 'conductor',
          traceId: 'trace-conductor',
          spanId: 'span-conductor-1',
          parentSpanId: null,
          name: 'claude_code.tool',
          kind: 'tool',
          startTs: NOW - 31_000,
          endTs: NOW - 30_500,
          status: 'ok',
          toolName: 'Task',
          agentId: 'agent-conductor-1',
          subagentType: 'Explore',
        },
        NOW - 30_000,
      ),
    ]
    const fleet = buildFleet(reduceAll(log), { now: NOW })
    expect(fleet.root.subagents).toEqual({
      lane: 'conductor',
      lastActivityTs: NOW - 30_000,
      agentId: 'agent-conductor-1',
      subagentType: 'Explore',
    })
  })

  it('leaves the bud unenriched — never null — when the conductor is live but uninstrumented by traces', () => {
    const log = [
      ...baseLog(NOW),
      event(
        'tool.activity',
        { lane: 'conductor', role: 'conductor', tool: 'Read', thread: 'subagent' },
        NOW - 20_000,
      ),
    ]
    const fleet = buildFleet(reduceAll(log), { now: NOW })
    expect(fleet.root.subagents).toEqual({
      lane: 'conductor',
      lastActivityTs: NOW - 20_000,
      agentId: null,
      subagentType: null,
    })
  })

  it("never leaks a worker lane's subagent activity onto the root", () => {
    const log = [
      ...baseLog(NOW),
      event('worktree.discovered', { path: '/repo-wt/s', branch: 's', head: 'sha-s', isMain: false }, NOW - 60_000),
      event(
        'llm.usage',
        {
          lane: 's',
          role: 'worker',
          model: 'claude-opus-5',
          tokens: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 },
          thread: 'subagent',
        },
        NOW - 10_000,
      ),
    ]
    const fleet = buildFleet(reduceAll(log), { now: NOW })
    expect(fleet.root.subagents).toBeNull()
    expect(laneIn(fleet, 's').subagents).not.toBeNull()
  })
})

// ── pointability (graft g7) ─────────────────────────────────────────────────

describe('lane slots', () => {
  it('assigns a stable slot by first sighting, independent of the attention order', () => {
    const state = reduceAll(fixtureHistory(pathologySpec(), NOW))
    const fleet = buildFleet(state, { now: NOW, manifest: manifestFor(pathologySpec()) })

    const slots = [...fleet.lanes].sort((a, b) => a.slot - b.slot).map((lane) => lane.id)
    expect(slots).toEqual(pathologySpec().lanes.map((lane) => lane.name))

    // The display order is by rung — which is exactly why the scene must not
    // use it for geometry, or a lane would move house when it got sick.
    expect(fleet.lanes.map((lane) => lane.id)).not.toEqual(slots)
    expect(new Set(fleet.lanes.map((lane) => lane.slot)).size).toBe(fleet.lanes.length)
  })
})

// ── the loop detector, directly ─────────────────────────────────────────────

describe('findCycle', () => {
  it('finds the smallest cycle the tail repeats', () => {
    expect(findCycle(['Read', 'Edit', 'Bash', 'Read', 'Edit', 'Bash', 'Read', 'Edit', 'Bash']))
      .toEqual({ pattern: ['Read', 'Edit', 'Bash'], repeats: 3 })
  })

  it('ignores a prefix of ordinary work before the wheel starts turning', () => {
    expect(
      findCycle(['Grep', 'Glob', 'Write', 'Read', 'Edit', 'Read', 'Edit', 'Read', 'Edit']),
    ).toEqual({ pattern: ['Read', 'Edit'], repeats: 3 })
  })

  it('does not call one repeated tool a cycle — exploring reads twice', () => {
    expect(findCycle(['Read', 'Read', 'Read', 'Read', 'Read', 'Read'])).toBeNull()
  })

  it('needs three repeats: twice is a coincidence', () => {
    expect(findCycle(['Read', 'Edit', 'Read', 'Edit'])).toBeNull()
  })
})

// ── fixture cost (#87) ──────────────────────────────────────────────────────

/**
 * A real 20-lane fleet is ~6,500 schema-validated events, folded by the real
 * reducer — every one of those is real cost, paid once. Every test in this
 * file that asks for the same fixture at the same instant must get the same,
 * frozen answer back rather than paying for a fresh build.
 */
describe('fixture memoisation and immutability (#87)', () => {
  it('gives every caller the same spec identity, not a fresh rebuild', () => {
    expect(fleet20Spec()).toBe(fleet20Spec())
    expect(pathologySpec()).toBe(pathologySpec())
    expect(finishedSpec()).toBe(finishedSpec())
  })

  it('freezes a spec and its lanes, so no caller can mutate the shared fixture', () => {
    const spec = fleet20Spec()
    expect(Object.isFrozen(spec)).toBe(true)
    expect(Object.isFrozen(spec.lanes)).toBe(true)
    expect(Object.isFrozen(spec.lanes[0])).toBe(true)
    expect(Object.isFrozen(spec.lanes[0]?.fence)).toBe(true)
    expect(Object.isFrozen(spec.lanes[0]?.touches)).toBe(true)
    expect(() => {
      // @ts-expect-error — proving the runtime freeze, not the type system.
      spec.lanes.push(spec.lanes[0])
    }).toThrow()
  })

  it('memoises the folded history for the same spec, now, and seed', () => {
    const a = fixtureHistory(fleet20Spec(), NOW)
    const b = fixtureHistory(fleet20Spec(), NOW)
    expect(a).toBe(b)
    expect(Object.isFrozen(a)).toBe(true)
    expect(() => {
      // @ts-expect-error — proving the runtime freeze, not the type system.
      a.push(a[0])
    }).toThrow()
  })

  it('does not share history across a different `now`, since the fold depends on it', () => {
    const a = fixtureHistory(fleet20Spec(), NOW)
    const b = fixtureHistory(fleet20Spec(), NOW + 60_000)
    expect(a).not.toBe(b)
  })
})
