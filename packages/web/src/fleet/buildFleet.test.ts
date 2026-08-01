import { createEvent, createIdFactory, reduceAll, type ObservatoryEvent } from '@observatory/core'
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
): ObservatoryEvent {
  return createEvent(type, payload, { id: nextId(), ts })
}

/** Two healthy lanes, both with their hands on one file. Nothing else is wrong. */
function collidingLog(now: number): ObservatoryEvent[] {
  const shared = 'packages/core/src/selectors/spend.ts'
  return [
    event('session.started', {
      sessionId: 'floor',
      repoPath: '/repo',
      repoName: 'observatory',
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
        repoName: 'observatory',
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
