import { describe, expect, it } from 'vitest'
import { createEvent, createIdFactory, type RhizomorphEvent } from '../events/index.js'
import { createEventFactory, FIXTURE_REPO_PATH } from '../fixtures.js'
import { reduceAll } from '../reduce.js'
import {
  type AttentionItem,
  buildFleet,
  DIAGNOSED_KINDS,
  evidenceLine,
  type Fleet,
  findCycle,
  INFERRED_MARK,
  isTerminalDone,
  type Ladder,
  type Lane,
  type PathologyKind,
} from './buildFleet.js'
import type { LaneManifest } from './fences.js'
import {
  type FixtureSpec,
  finishedSpec,
  fixtureHistory,
  fleet20Spec,
  manifestFor,
  offFenceHonestySpec,
  pathologySpec,
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

  it('finds exactly one lane per DIAGNOSABLE pathology, and no sixth kind', () => {
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
    // `DIAGNOSED_KINDS`, not `PATHOLOGY_KINDS`. The two differ by `crashed`
    // (prd-57 ruling 5), which `diagnose` cannot produce at all: it turns on a
    // recorded process death in the fold, raised by `server/crashed.ts` from
    // the tick, and no staged fixture can stage one. Comparing against the full
    // vocabulary would assert something this fixture cannot be made to satisfy.
    expect([...counts.keys()].sort()).toEqual([...DIAGNOSED_KINDS].sort())
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
    // prd-27 (#283): the staged waiting lane is now beacon-declared, with the
    // roster's stale `working` voiced beside it — the race ruling 4 was
    // written for (the hook fires before workmux's next poll turns over).
    expect(evidenceFor(fleet, '43-drawer-attach', 'waiting')).toMatch(
      /^beacon \(claude-hook\) declares waiting \S+ ago \(joined by lane\) · workmux reports working$/,
    )
    expect(evidenceFor(fleet, '44-scene-pulses', 'expensive')).toMatch(
      /^\d+ out-tok\/min, \d+\.\d× fleet median$/,
    )
    // The path itself is named, not just a count and a victim (issue #226) —
    // "touching 46-spend-selectors — 1 file" tells the operator nothing they
    // can act on; the exact file does.
    expect(evidenceFor(fleet, '45-ledger-subrows', 'off-fence')).toBe(
      'outside fence — packages/core/src/selectors/spend-subrows.ts → 46-spend-selectors',
    )
  })

  it('names the trespassed lane, not merely the trespass', () => {
    const offender = laneIn(fleet, '45-ledger-subrows')
    expect(offender.trespasses.map((trespass) => trespass.victim)).toEqual(['46-spend-selectors'])
    expect(offender.trespasses.map((trespass) => trespass.path)).toEqual([
      'packages/core/src/selectors/spend-subrows.ts',
    ])
  })

  it('reports waiting as declared rather than inferred, because the harness said so (#283)', () => {
    const lane = laneIn(fleet, '43-drawer-attach')
    const waiting = lane.pathologies.find((pathology) => pathology.kind === 'waiting')
    expect(lane.declared?.kind).toBe('waiting')
    expect(waiting?.inferred).toBe(false)
    expect(evidenceLine(waiting!)).not.toContain(INFERRED_MARK)
  })

  it('puts one ladder item per fault, and the fleet on the worst of them', () => {
    const ladder = fleet.ladder
    expect(ladder.rank).toBe('broken')
    if (ladder.rank === 'calm') throw new Error('unreachable: the staged fleet is not calm')
    // Same reason as the count pin above: the ladder can only carry what the
    // fixture's lanes actually carry, and `crashed` is not diagnosable.
    expect(ladder.items.map((item) => item.kind).sort()).toEqual([...DIAGNOSED_KINDS].sort())
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

/**
 * Issue #226 — kept out of the staged-pathology fixture above on purpose:
 * this package's `StreamContext`, `FleetContext`, scene, geometry and marks
 * tests all pin that fixture's exact lane count, so growing it to cover these
 * three regressions would make every one of those a casualty of a fix that
 * has nothing to do with them.
 */
describe('off-fence honesty (issue #226)', () => {
  const fleet = fleetFor(offFenceHonestySpec())

  // Defect 1 — the false-positive that made OFF-FENCE fire on every lane,
  // always: npm rewrites package-lock.json in every worktree on install. It
  // is never committed, so `scripts/gate.sh`'s own check (the committed diff
  // against merge-base) never sees it — the glass must not see it either.
  it('exempts uncommitted lockfile churn from off-fence — the gate only sees the committed diff', () => {
    const lane = laneIn(fleet, '60-lockfile-churn')
    expect(lane.trespasses).toEqual([])
    expect(kindsFor(fleet, '60-lockfile-churn')).not.toContain('off-fence')
  })

  // Defect 3 — the known workmux worker-death shape: a pane dies right after
  // its lane commits everything, so the worktree is clean and ahead of main
  // but nothing ever declared `done`. FROZEN would otherwise call this dead
  // air; the git geography it left behind says it finished.
  it('reads a dead pane that committed clean work as done, not frozen', () => {
    const lane = laneIn(fleet, '61-pane-died-clean')
    expect(lane.dirtyCount).toBe(0)
    expect(lane.aheadOfMain).toBeGreaterThan(0)
    expect(kindsFor(fleet, '61-pane-died-clean')).not.toContain('frozen')
    expect(lane.activity).toBe('done')
  })

  // The gap verify caught in the first pass: a lane can carry a live
  // pathology AND be terminal-done at once — its pane died clean-and-ahead
  // right after the very commit that trespassed a fence landed. The MODEL
  // must keep both facts true together; neither surface (sigil, title, mark)
  // can be honest if `isTerminalDone` goes false just because a pathology is
  // also present, or if the pathology's own evidence goes missing.
  it('keeps a live pathology and terminal-done true at once — neither fact swallows the other', () => {
    const lane = laneIn(fleet, '62-pane-died-offence')
    expect(kindsFor(fleet, '62-pane-died-offence')).toEqual(['off-fence'])
    expect(isTerminalDone(lane)).toBe(true)
    expect(evidenceFor(fleet, '62-pane-died-offence', 'off-fence')).toContain(
      'packages/web/src/panels/attention/churn-neighbour.ts',
    )
  })

  // A second verify pass caught this fixture staging a needs-you collision
  // of its own: 62's trespass originally landed on 60's own committed file,
  // so both lanes touched the same path and `selectCollisions` (correctly)
  // flagged it — pollution unrelated to #226. The trespass now sits on a
  // neighbour inside 60's fence instead (60 never touches it), which is all
  // a named victim requires; this pins it against regressing silently.
  it('stages no collisions of its own — only #226 facts, nothing incidental', () => {
    expect(fleet.collisions).toEqual([])
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
  // ADR-0037: a type with two legitimate witnesses needs the non-primary one
  // to be able to sign its own name here, the way a collector does.
  source?: Parameters<typeof createEvent<T>>[2]['source'],
): RhizomorphEvent {
  return createEvent(type, payload, {
    id: nextId(),
    ts,
    ...(source === undefined ? {} : { source }),
  })
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

// ── the honest middle — degraded-retrying gap voice (#304, ruling 2) ───────

describe('the honest middle — degraded-retrying gap voice (#304, ruling 2)', () => {
  it('speaks the gap voice for a degraded-but-retrying collector', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.collectorDegraded({ collector: 'tmux', reason: 'capture-pane timed out', consecutiveFailures: 1 }),
    ])
    const fleet = buildFleet(state, { now: NOW })

    const degraded = fleet.gaps.filter((gap) => gap.id === 'collector-degraded:tmux')
    expect(degraded).toHaveLength(1)
    expect(degraded[0]?.what).toBe('TMUX COLLECTOR DEGRADED')
    expect(degraded[0]?.why).toContain('capture-pane timed out')
    expect(degraded[0]?.command).toBe('rhizomorph doctor')
  })

  it('a healed collector is silent, not a stale gap', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.collectorDegraded({ collector: 'tmux', reason: 'capture-pane timed out', consecutiveFailures: 1 }),
      f.collectorRecovered({ collector: 'tmux' }),
    ])
    const fleet = buildFleet(state, { now: NOW })

    expect(fleet.gaps.some((gap) => gap.id.startsWith('collector-degraded:') || gap.id.startsWith('collector-disabled:'))).toBe(false)
  })

  it('a second degraded poll updates the same gap, never adds a second', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.collectorDegraded({ collector: 'tmux', reason: 'capture-pane timed out', consecutiveFailures: 1 }),
      f.collectorDegraded({ collector: 'tmux', reason: 'tmux exited with code 1', consecutiveFailures: 2 }),
    ])
    const fleet = buildFleet(state, { now: NOW })

    const degraded = fleet.gaps.filter((gap) => gap.id === 'collector-degraded:tmux')
    expect(degraded).toHaveLength(1)
    expect(degraded[0]?.why).toContain('tmux exited with code 1')
  })

  it('the stronger, terminal fact replaces the weaker one once the threshold is crossed', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.collectorDegraded({ collector: 'tmux', reason: 'capture-pane timed out', consecutiveFailures: 1 }),
      f.collectorDisabled({ collector: 'tmux', reason: 'tmux exited with code 1', consecutiveFailures: 3 }),
    ])
    const fleet = buildFleet(state, { now: NOW })

    expect(fleet.gaps.some((gap) => gap.id === 'collector-disabled:tmux')).toBe(true)
    expect(fleet.gaps.some((gap) => gap.id === 'collector-degraded:tmux')).toBe(false)
  })

  it('stays ambient-only: a degraded collector never climbs the attention strip', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.collectorDegraded({ collector: 'tmux', reason: 'capture-pane timed out', consecutiveFailures: 1 }),
    ])
    const fleet = buildFleet(state, { now: NOW })

    expect(fleet.ladder.rank).toBe('calm')
    expect(fleet.ladder.items).toEqual([])
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
      event('pane.activity', { paneId: '%9', contentHash: 'h1' }, NOW - 5_000),
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

  it('lets a declared WAITING lapse once its own agent is removed, even though the worktree stands', () => {
    // The direct sibling of the worktree-removal test above: this time the
    // git worktree never goes anywhere (workmux's handle and a git worktree
    // are different identities per ADR-0015 — one can depart without the
    // other), only the workmux agent departs. Without findAgent() filtering
    // on presence, WorktreeView.agent keeps returning the stale 'waiting'
    // record forever, since lane.present here (the worktree's own presence)
    // never flips false.
    const log = [
      event('session.started', {
        sessionId: 'agent-removed',
        repoPath: '/repo',
        repoName: 'rhizomorph',
        mainBranch: 'main',
      }, NOW - 600_000),
      event('worktree.discovered', { path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, NOW - 600_000),
      event('worktree.discovered', { path: '/repo-wt/s', branch: 's', head: 'sha-s', isMain: false }, NOW - 600_000),
      event('agent.status', { handle: 's', status: 'waiting', worktreePath: '/repo-wt/s', branch: 's' }, NOW - 500_000),
      event('agent.removed', { handle: 's' }, NOW - 300_000),
    ]

    const fleet = buildFleet(reduceAll(log), { now: NOW })
    const lane = laneIn(fleet, 's')

    expect(lane.present).toBe(true)
    expect(lane.agentStatus).toBeNull()
    expect(lane.pathologies.map((pathology) => pathology.kind)).not.toContain('waiting')
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
      'NO LANE MANIFEST (.swarm/lanes.json) — off-fence detection unavailable — run: your dispatch tooling — writes .swarm/lanes.json, not part of this repo (see docs/user-guide/troubleshooting.md)',
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
      event('pane.activity', { paneId: '%40', contentHash: 'h0' }, NOW - 12 * 60_000),
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
      event('pane.activity', { paneId: '%41', contentHash: 'h0' }, NOW - 15 * 60_000),
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
      event('pane.activity', { paneId: '%42', contentHash: 'h0' }, NOW - 15 * 60_000),
    ]

    const fleet = buildFleet(reduceAll(log), { now: NOW })

    expect(kindsFor(fleet, HANDLE)).toContain('frozen')
  })
})

// ── the second witness speaks (#281, ADR-0037) ──────────────────────────────

/**
 * prd-27 ruling 2 gives the transcript organ its own signature on
 * `agent.status`, and ruling 4 rules the disagreement: a declaration may raise
 * a summons; an inference alone may only withdraw an *inferred* one.
 *
 * The witness has to survive four hops to be worth anything — envelope →
 * `AgentState.witness` → `Lane.agentStatusWitness` → `detectWaiting`. These
 * are the tests at the far end of that chain: if any hop drops it, a
 * transcript-shape WAITING renders as workmux's certain summons, which is the
 * #133 false summons rebuilt one layer down.
 */
describe('the second witness speaks (#281, ADR-0037)', () => {
  const ORGAN_WAITING = 'WAITING — tail turn-complete, quiet 45s, threshold 30s'

  /** Session + main tree + one linked worktree, quiet since `discoveredAt`. */
  function scaffold(handle: string, discoveredAt: number): RhizomorphEvent[] {
    return [
      event('session.started', {
        sessionId: `witness-${handle}`,
        repoPath: '/repo',
        repoName: 'rhizomorph',
        mainBranch: 'main',
      }, discoveredAt),
      event('worktree.discovered', { path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, discoveredAt),
      event('worktree.discovered', { path: `/repo-wt/${handle}`, branch: handle, head: `sha-${handle}`, isMain: false }, discoveredAt),
    ]
  }

  it('renders a sessionlog-witnessed WAITING as inferred, with the transcript\'s own reading as evidence', () => {
    const log = [
      ...scaffold('q2', NOW - 600_000),
      event(
        'agent.status',
        { handle: 'q2', status: 'waiting', worktreePath: '/repo-wt/q2', branch: 'q2', detail: ORGAN_WAITING },
        NOW - 45_000,
        'sessionlog',
      ),
    ]

    const fleet = buildFleet(reduceAll(log), { now: NOW })
    const lane = laneIn(fleet, 'q2')
    const waiting = lane.pathologies.find((pathology) => pathology.kind === 'waiting')

    expect(kindsFor(fleet, 'q2')).toContain('waiting')
    expect(lane.agentStatusWitness).toBe('sessionlog')
    // A fold that stamped `witness: 'workmux'` regardless would make this
    // certain, and this assertion is what reddens.
    expect(waiting?.inferred).toBe(true)
    expect(waiting?.evidence).toBe(`transcript shape: ${ORGAN_WAITING}`)
    expect(evidenceLine(waiting!).startsWith(`${INFERRED_MARK} `)).toBe(true)
  })

  it('two witnesses disagree: the declaration stands, and the evidence says so', () => {
    // A permission prompt: workmux has the hand up, the transcript's tail
    // still reads `pending-tool`. Ruling 4 keeps the declaration — and says
    // out loud that the other witness disagreed, rather than resolving it in
    // silence (prd-15 ruling 2).
    const log = [
      ...scaffold('d1', NOW - 600_000),
      event(
        'agent.status',
        { handle: 'd1', status: 'waiting', worktreePath: '/repo-wt/d1', branch: 'd1' },
        NOW - 90_000,
      ),
      event(
        'agent.status',
        { handle: 'd1', status: 'working', worktreePath: '/repo-wt/d1', branch: 'd1', detail: 'WORKING — tail pending-tool, quiet 3s, threshold 30s' },
        NOW - 10_000,
        'sessionlog',
      ),
    ]

    const fleet = buildFleet(reduceAll(log), { now: NOW })
    const lane = laneIn(fleet, 'd1')
    const waiting = lane.pathologies.find((pathology) => pathology.kind === 'waiting')

    expect(lane.agentStatus).toBe('waiting')
    expect(lane.agentStatusWitness).toBe('workmux')
    expect(waiting?.inferred).toBe(false)
    expect(waiting?.evidence).toBe('workmux reports waiting 1m30s; transcript shape reads working')
  })

  it('a declared working after an inferred waiting withdraws the summons', () => {
    // The other direction of ruling 4's asymmetry: the declaration is not
    // refused by anything, so it simply wins and the raised hand comes down.
    // No pane events, so the pane-based inference cannot fire instead.
    const log = [
      ...scaffold('d2', NOW - 600_000),
      event(
        'agent.status',
        { handle: 'd2', status: 'waiting', worktreePath: '/repo-wt/d2', branch: 'd2', detail: ORGAN_WAITING },
        NOW - 60_000,
        'sessionlog',
      ),
      event(
        'agent.status',
        { handle: 'd2', status: 'working', worktreePath: '/repo-wt/d2', branch: 'd2' },
        NOW - 5_000,
      ),
    ]

    const fleet = buildFleet(reduceAll(log), { now: NOW })

    expect(kindsFor(fleet, 'd2')).not.toContain('waiting')
    expect(laneIn(fleet, 'd2').agentStatusWitness).toBe('workmux')
  })

  it('a finished lane the organ later reads as waiting stays DONE and calm', () => {
    // The sibling of the permission-prompt case, and the common one: every
    // lane that finishes in the full rig is declared `done` by workmux, and
    // 75s later the organ reads its quiet, alive session as `waiting`. Under
    // pure last-wins that turned every finished lane into a `~WAITING`
    // summons — the #133 false summons rebuilt one layer down. Caught in
    // verify of #281.
    const log = [
      ...scaffold('d3', NOW - 600_000),
      event(
        'agent.status',
        { handle: 'd3', status: 'done', worktreePath: '/repo-wt/d3', branch: 'd3' },
        NOW - 200_000,
      ),
      event(
        'agent.status',
        { handle: 'd3', status: 'waiting', worktreePath: '/repo-wt/d3', branch: 'd3', detail: ORGAN_WAITING },
        NOW - 120_000,
        'sessionlog',
      ),
    ]

    const fleet = buildFleet(reduceAll(log), { now: NOW })
    const lane = laneIn(fleet, 'd3')

    expect(lane.agentStatus).toBe('done')
    expect(lane.agentStatusWitness).toBe('workmux')
    expect(lane.activity).toBe('done')
    expect(lane.rank).toBe('calm')
    expect(kindsFor(fleet, 'd3')).not.toContain('waiting')
  })
})

// ── the harness says so (prd-27 rulings 3–4, #283) ──────────────────────────

/**
 * The third witness, end to end: a `beacon.received` line on the log →
 * `SessionState.declared` → `Lane.declared` → `detectWaiting`. Ruling 4's
 * asymmetry is four clauses and each is a test here, because each has a mirror
 * that a fix for one of them silently breaks: a suppression that forgets the
 * *sessionlog*-witnessed inference (#281's third witness) leaves an inferred
 * WAITING no declaration can quiet; a `stopped` read as a `waiting` summons a
 * lane that has simply finished.
 *
 * The last test is #133's shape in a new costume, and it is the one worth
 * reading: a beacon naming a lane the fleet has never heard of must conjure
 * **no lane** — a summons for a lane nobody can attach to is the false summons
 * this instrument's scar tissue is made of.
 */
describe('the harness says so (prd-27 rulings 3–4, #283)', () => {
  const WRITER = 'claude-hook'

  /**
   * Work old enough that the activity witness does not read `working`
   * (`WAITING_QUIET_MS` is 75s), and recent enough that the lane is not FROZEN
   * (`FROZEN_AFTER_MS` is 8m). Both bounds matter and each was found by a red
   * test: past the frozen threshold, `diagnose` suppresses WAITING behind
   * FROZEN and every assertion below goes vacuously undefined; inside the
   * quiet threshold, `recent work reads working` joins the evidence and the
   * byte-exact strings gain a clause they were not written for.
   */
  const QUIET_WORK_TS = NOW - 120_000

  function scaffold(handle: string, discoveredAt: number): RhizomorphEvent[] {
    return [
      event('session.started', {
        sessionId: `declared-${handle}`,
        repoPath: '/repo',
        repoName: 'rhizomorph',
        mainBranch: 'main',
      }, discoveredAt),
      event('worktree.discovered', { path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, discoveredAt),
      event('worktree.discovered', { path: `/repo-wt/${handle}`, branch: handle, head: `sha-${handle}`, isMain: false }, discoveredAt),
    ]
  }

  /** One beacon line, as ADR-0036 shapes it: the writer's clock is the envelope `ts`. */
  function beacon(handle: string | null, kind: string, ts: number, pid?: number): RhizomorphEvent {
    return event('beacon.received', {
      writer: WRITER,
      kind,
      lane: handle,
      // What `cli/hook.ts` writes when it cannot name a lane. Omitted entirely
      // for a lane-named beacon, which is how `env --hooks` writes them.
      ...(pid === undefined ? {} : { pid }),
      detail: 'hook: Notification',
      digest: 'f'.repeat(64),
      file: 'claude-hook.jsonl',
      offset: 0,
    }, ts)
  }

  /** Work old enough that no activity inference reads `working`. */
  function oldWork(handle: string, ts: number): RhizomorphEvent {
    return event('llm.usage', {
      lane: handle,
      role: 'worker',
      model: 'claude-sonnet-4',
      tokens: { input: 10, output: 20, cacheRead: 0, cacheCreation: 0 },
      sessionId: `sess-${handle}`,
      worktreePath: `/repo-wt/${handle}`,
      branch: handle,
      thread: 'main',
    }, ts)
  }

  /**
   * The pane-stillness inference's own shape, lifted from `detection honesty`
   * above: quiet past the threshold, pane moving a moment ago, nobody
   * declaring anything.
   */
  function paneInferred(handle: string, paneId: string): RhizomorphEvent[] {
    return [
      ...scaffold(handle, NOW - 600_000),
      event('pane.discovered', { paneId, windowName: handle, currentPath: `/repo-wt/${handle}`, worktreePath: `/repo-wt/${handle}` }, NOW - 600_000),
      event('worktree.dirty', { path: `/repo-wt/${handle}`, branch: handle, files: [{ path: 'a.ts', status: 'modified' }] }, NOW - 160_000),
      event('pane.activity', { paneId, contentHash: 'h1' }, NOW - 5_000),
    ]
  }

  function waitingIn(fleet: Fleet, id: string) {
    return laneIn(fleet, id).pathologies.find((pathology) => pathology.kind === 'waiting')
  }

  it('(a) a declared waiting is WAITING, certain, since the beacon\'s at', () => {
    const log = [
      ...scaffold('q1', NOW - 600_000),
      oldWork('q1', QUIET_WORK_TS),
      beacon('q1', 'waiting', NOW - 40_000),
    ]
    const fleet = buildFleet(reduceAll(log), { now: NOW })
    const waiting = waitingIn(fleet, 'q1')

    expect(waiting?.inferred).toBe(false)
    expect(waiting?.since).toBe(NOW - 40_000)
    expect(waiting?.evidence).toBe('beacon (claude-hook) declares waiting 40s ago (joined by lane)')
    expect(laneIn(fleet, 'q1').declared).toEqual({ kind: 'waiting', at: NOW - 40_000, writer: WRITER, joinedBy: 'lane' })
  })

  /** The process witness placing an actor — what a lane-less beacon joins to. */
  function actor(handle: string, pid: number, ts: number): RhizomorphEvent {
    return event(
      'process.seen',
      { pid, dialect: 'claude', startedAt: ts, worktreePath: `/repo-wt/${handle}`, placement: 'rooted', parentPid: null },
      ts,
    )
  }

  /**
   * THE JOIN'S SECOND HALF, and it was shipped untested.
   *
   * #589's own definition of done says a pid-joined beacon is folded under the
   * actor's worktree path *"and `buildFleet` resolves it to the lane"*. The
   * fold was covered; this resolution was not, and deleting it left the whole
   * suite green — which would have made the commit's subject line ("a hook
   * firing reaches its lane") false again with nothing to say so. Found in
   * adversarial review.
   */
  it('a declaration placed under a WORKTREE reaches the lane that occupies it', () => {
    const log = [
      ...scaffold('q1', NOW - 600_000),
      oldWork('q1', QUIET_WORK_TS),
      actor('q1', 4321, NOW - 300_000),
      // Exactly what `cli/hook.ts` writes: no lane, a pid. Nothing here knows
      // what this instrument calls the lane.
      beacon(null, 'waiting', NOW - 40_000, 4321),
    ]
    const state = reduceAll(log)
    // The fold's half: recorded under the path, not the lane id.
    expect(state.declared['/repo-wt/q1']).toBeDefined()
    expect(state.declared.q1).toBeUndefined()

    const fleet = buildFleet(state, { now: NOW })
    expect(laneIn(fleet, 'q1').declared).toEqual({
      kind: 'waiting',
      at: NOW - 40_000,
      writer: WRITER,
      joinedBy: 'pid',
    })
    expect(waitingIn(fleet, 'q1')?.evidence).toBe(
      'beacon (claude-hook) declares waiting 40s ago (joined by pid — the hook named no lane)',
    )
  })

  /**
   * `state.declared` is one flat namespace holding lane ids AND worktree paths,
   * so one lane can have a record under both — an `env --hooks` writer naming
   * it, and the hook runner placing it. The first version of this resolution
   * read the lane id first, calling it *"an explicit name beats a placement"*,
   * which silently inverted the law every other declaration is read by: newest
   * wins (the fold's own monotonicity guard, and "the latest by writer clock
   * wins" in `reduce.test.ts`). Found in adversarial review.
   */
  it("when a lane has a declaration under BOTH keys, the newer one is the lane's — whichever key it arrived on", () => {
    const base = [...scaffold('q1', NOW - 600_000), oldWork('q1', QUIET_WORK_TS), actor('q1', 4321, NOW - 300_000)]

    const placementIsNewer = buildFleet(
      reduceAll([...base, beacon('q1', 'working', NOW - 200_000), beacon(null, 'waiting', NOW - 40_000, 4321)]),
      { now: NOW },
    )
    expect(laneIn(placementIsNewer, 'q1').declared).toMatchObject({ kind: 'waiting', joinedBy: 'pid' })

    // And the same rule in the other direction, so this is recency and not a
    // new key precedence wearing recency's clothes.
    const nameIsNewer = buildFleet(
      reduceAll([...base, beacon(null, 'working', NOW - 200_000, 4321), beacon('q1', 'waiting', NOW - 40_000)]),
      { now: NOW },
    )
    expect(laneIn(nameIsNewer, 'q1').declared).toMatchObject({ kind: 'waiting', joinedBy: 'lane' })
  })

  it('(c1) an organ inferring working never suppresses a declared waiting — and the disagreement is voiced', () => {
    const log = [
      ...scaffold('q1', NOW - 600_000),
      oldWork('q1', QUIET_WORK_TS),
      beacon('q1', 'waiting', NOW - 40_000),
      // Dated at the same quiet mark as the work, so the ORGAN is the only
      // witness disagreeing here: an `agent.status` refreshes `lastWorkTs`, so
      // a fresher one would also make the activity witness read `working` and
      // append a second, equally true clause. That case is (c2)'s, one test
      // down — this one isolates the organ.
      event(
        'agent.status',
        { handle: 'q1', status: 'working', worktreePath: '/repo-wt/q1', branch: 'q1', detail: 'WORKING — tail pending-tool, quiet 3s, threshold 30s' },
        QUIET_WORK_TS,
        'sessionlog',
      ),
    ]
    const waiting = waitingIn(buildFleet(reduceAll(log), { now: NOW }), 'q1')

    expect(waiting?.inferred).toBe(false)
    expect(waiting?.evidence).toBe('beacon (claude-hook) declares waiting 40s ago (joined by lane) · transcript shape reads working')
  })

  it('(c2) recent activity never suppresses a declared waiting either', () => {
    const log = [
      ...scaffold('q1', NOW - 600_000),
      oldWork('q1', NOW - 5_000),
      beacon('q1', 'waiting', NOW - 40_000),
    ]
    const waiting = waitingIn(buildFleet(reduceAll(log), { now: NOW }), 'q1')

    expect(waiting?.evidence).toBe('beacon (claude-hook) declares waiting 40s ago (joined by lane) · recent work reads working')
  })

  it('(b1) a declared working newer than the last work quiets the pane-stillness inference', () => {
    const log = [...paneInferred('b1', '%51'), beacon('b1', 'working', NOW - 5_000)]
    expect(kindsFor(buildFleet(reduceAll(log), { now: NOW }), 'b1')).not.toContain('waiting')
  })

  it('(b2) …and quiets a transcript-shape inference too (#281)', () => {
    const log = [
      ...scaffold('b2', NOW - 600_000),
      event(
        'agent.status',
        { handle: 'b2', status: 'waiting', worktreePath: '/repo-wt/b2', branch: 'b2', detail: 'WAITING — tail turn-complete, quiet 45s, threshold 30s' },
        NOW - 60_000,
        'sessionlog',
      ),
      beacon('b2', 'working', NOW - 10_000),
    ]
    expect(kindsFor(buildFleet(reduceAll(log), { now: NOW }), 'b2')).not.toContain('waiting')
  })

  // 2m50s, not the 5m00s this used before #218: `staleDeclaredWorking` speaks
  // only for a declaration that still stands, and past `BEACON_LAPSE_MS` the
  // lapse clause replaces it (prd-27 ruling 6; the boundary is pinned in
  // `diagnose.test.ts` and `selectors/lapse.test.ts`). The clause under test
  // here lives in the window "older than the last work, younger than the
  // lapse" — this test's own claim is unchanged, only its clock.
  it('(b3) a declared working OLDER than the last work quiets nothing, and says so', () => {
    const log = [...paneInferred('b3', '%53'), beacon('b3', 'working', NOW - 170_000)]
    const waiting = waitingIn(buildFleet(reduceAll(log), { now: NOW }), 'b3')

    expect(waiting?.inferred).toBe(true)
    expect(waiting?.evidence.endsWith(' · beacon (claude-hook) declared working 2m50s ago, before the last work')).toBe(true)
  })

  it('(d) a declared stopped is not WAITING and suppresses nothing', () => {
    const alone = [
      ...scaffold('d4', NOW - 600_000),
      oldWork('d4', QUIET_WORK_TS),
      beacon('d4', 'stopped', NOW - 20_000),
    ]
    expect(kindsFor(buildFleet(reduceAll(alone), { now: NOW }), 'd4')).not.toContain('waiting')

    const beside = [...paneInferred('d5', '%54'), beacon('d5', 'stopped', NOW - 20_000)]
    const waiting = waitingIn(buildFleet(reduceAll(beside), { now: NOW }), 'd5')
    expect(waiting?.inferred).toBe(true)
    expect(waiting?.evidence).toBe('quiet 2m40s, pane still alive')
  })

  it('between two declarations the newer word stands — in both directions', () => {
    const rosterNewer = [
      ...scaffold('n1', NOW - 600_000),
      beacon('n1', 'waiting', NOW - 60_000),
      event('agent.status', { handle: 'n1', status: 'working', worktreePath: '/repo-wt/n1', branch: 'n1' }, NOW - 5_000),
    ]
    expect(kindsFor(buildFleet(reduceAll(rosterNewer), { now: NOW }), 'n1')).not.toContain('waiting')

    const beaconNewer = [
      ...scaffold('n2', NOW - 600_000),
      event('agent.status', { handle: 'n2', status: 'waiting', worktreePath: '/repo-wt/n2', branch: 'n2' }, NOW - 60_000),
      beacon('n2', 'working', NOW - 5_000),
    ]
    expect(kindsFor(buildFleet(reduceAll(beaconNewer), { now: NOW }), 'n2')).not.toContain('waiting')
  })

  it('a workmux waiting with an OLDER beacon stopped voices the beacon beside it', () => {
    const log = [
      ...scaffold('n3', NOW - 600_000),
      beacon('n3', 'stopped', NOW - 120_000),
      event('agent.status', { handle: 'n3', status: 'waiting', worktreePath: '/repo-wt/n3', branch: 'n3' }, NOW - 90_000),
    ]
    const waiting = waitingIn(buildFleet(reduceAll(log), { now: NOW }), 'n3')

    expect(waiting?.inferred).toBe(false)
    expect(waiting?.evidence).toBe('workmux reports waiting 1m30s · beacon (claude-hook) declared stopped 2m00s ago')
  })

  it('a beacon for a handle the fleet does not know conjures no lane and no alarm (#133)', () => {
    const base = [...scaffold('k1', NOW - 600_000), oldWork('k1', QUIET_WORK_TS)]
    const without = buildFleet(reduceAll(base), { now: NOW })
    const withGhost = buildFleet(reduceAll([...base, beacon('ghost-lane', 'waiting', NOW - 40_000)]), { now: NOW })

    expect(withGhost.lanes.length).toBe(without.lanes.length)
    expect(withGhost.lanes.map((lane) => lane.id)).toEqual(without.lanes.map((lane) => lane.id))
    expect(withGhost.ladder.rank).toBe(without.ladder.rank)
    for (const lane of withGhost.lanes) {
      for (const pathology of lane.pathologies) expect(pathology.evidence).not.toContain('ghost-lane')
    }
  })

  // Retitled and STRENGTHENED with the join (#589). An unlaned beacon does
  // reach a lane now, when its pid names a placed actor. What this case has
  // always exercised — and now says — is the decline: no process witness ran
  // here, so there is no actor to place it, and nothing is invented. ADR-0010.
  it('an unlaned beacon whose pid matches no placed actor reaches no lane at all', () => {
    const base = [...scaffold('k2', NOW - 600_000), oldWork('k2', QUIET_WORK_TS)]
    const fleet = buildFleet(reduceAll([...base, beacon(null, 'waiting', NOW - 40_000, 4321)]), { now: NOW })

    expect(laneIn(fleet, 'k2').declared).toBeNull()
    expect(kindsFor(fleet, 'k2')).not.toContain('waiting')
  })

  it('a declared waiting on a worktree that has since been removed raises no summons (verify of #283)', () => {
    // The beacon record outlives the lane: nothing in the fold retires it when
    // the worktree goes. The alarm must not outlive the lane too — a summons
    // for a lane nobody can attach to is #133's false summons in a new costume.
    const log = [
      ...scaffold('r1', NOW - 600_000),
      oldWork('r1', QUIET_WORK_TS),
      beacon('r1', 'waiting', NOW - 40_000),
      event('worktree.removed', { path: '/repo-wt/r1' }, NOW - 30_000),
    ]
    const lane = laneIn(buildFleet(reduceAll(log), { now: NOW }), 'r1')

    expect(lane.present).toBe(false)
    expect(lane.declared?.kind).toBe('waiting') // the record is still there …
    expect(kindsFor(buildFleet(reduceAll(log), { now: NOW }), 'r1')).not.toContain('waiting') // … the alarm is not
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

// ── the fleet table's sparkline (#159) ──────────────────────────────────────

describe('Lane.recentOutputTokens', () => {
  const HANDLE = 'sk'
  const WORKTREE = '/repo-wt/sk'

  function baseLog(startedAt: number): RhizomorphEvent[] {
    return [
      event('session.started', { sessionId: 'spark', repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' }, startedAt),
      event('worktree.discovered', { path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, startedAt),
      event('worktree.discovered', { path: WORKTREE, branch: HANDLE, head: 'sha-sk', isMain: false }, startedAt),
    ]
  }

  it('sums output tokens into the trailing window, honestly trimmed to the lane\'s own lifetime', () => {
    const startedAt = NOW - 12 * 60_000 // younger than the 30-minute window
    const log = [
      ...baseLog(startedAt),
      event('llm.usage', {
        lane: HANDLE, role: 'worker', model: 'claude-opus-5', branch: HANDLE, worktreePath: WORKTREE,
        tokens: { input: 1, output: 400, cacheRead: 0, cacheCreation: 0 },
      }, NOW - 1_000),
    ]
    const fleet = buildFleet(reduceAll(log), { now: NOW })
    const series = laneIn(fleet, HANDLE).recentOutputTokens

    // 12 minutes of a 30-minute, 10-bucket window (3-minute buckets) is 4
    // whole buckets — a lane this young must not claim the other 6.
    expect(series).toHaveLength(4)
    expect(series.reduce((sum, v) => sum + v, 0)).toBe(400)
    // The event landed in the newest bucket.
    expect(series.at(-1)).toBe(400)
  })

  it('counts only the sessionlog origin — the same collector every other output-token figure reads', () => {
    const startedAt = NOW - 30 * 60_000
    const log = [
      ...baseLog(startedAt),
      event('llm.usage', {
        lane: HANDLE, role: 'worker', model: 'claude-opus-5', branch: HANDLE, worktreePath: WORKTREE,
        tokens: { input: 1, output: 300, cacheRead: 0, cacheCreation: 0 },
      }, NOW - 1_000),
      createEvent('llm.usage', {
        lane: HANDLE, role: 'worker', model: 'claude-opus-5', branch: HANDLE, worktreePath: WORKTREE,
        tokens: { input: 1, output: 5_000, cacheRead: 0, cacheCreation: 0 },
      }, { id: nextId(), ts: NOW - 1_000, source: 'otel' }),
    ]
    const fleet = buildFleet(reduceAll(log), { now: NOW })
    const total = laneIn(fleet, HANDLE).recentOutputTokens.reduce((sum, v) => sum + v, 0)
    expect(total).toBe(300)
  })

  it('reads as real zeros for the lane\'s own lifetime, never padded with buckets before it existed', () => {
    // A lane a full 30-minute window old with no usage at all: every bucket is
    // a real "nothing happened", so all ten are honest zeros.
    const log = baseLog(NOW - 30 * 60_000)
    const fleet = buildFleet(reduceAll(log), { now: NOW })
    expect(laneIn(fleet, HANDLE).recentOutputTokens).toEqual(new Array(10).fill(0))
  })

  it('is a single real zero for a lane one bucket-width old, not ten fabricated ones', () => {
    const log = baseLog(NOW - 60_000)
    const fleet = buildFleet(reduceAll(log), { now: NOW })
    expect(laneIn(fleet, HANDLE).recentOutputTokens).toEqual([0])
  })
})

// ── the burn strip's error figure (#159) ────────────────────────────────────

describe('Burn.errorCount', () => {
  it('sums blocked (unparked WAITING), parked, and off-fence lanes off the staged-pathology fixture', () => {
    const fleet = fleetFor(pathologySpec())

    // Fixture facts this reuses rather than re-derives: '43-drawer-attach' is
    // the WAITING lane, '45-ledger-subrows' the OFF-FENCE one (see the
    // top-of-file describe block), and nothing in this fixture is parked.
    expect(fleet.burn.errorBlockedCount).toBe(1)
    expect(fleet.burn.errorOffFenceCount).toBe(1)
    expect(fleet.burn.errorParkedCount).toBe(0)
    expect(fleet.burn.errorCount).toBe(2)
  })

  it('is a calm, real zero for a fleet with nothing wrong', () => {
    const fleet = fleetFor(finishedSpec())
    expect(fleet.burn.errorCount).toBe(0)
    expect(fleet.burn.errorBlockedCount).toBe(0)
    expect(fleet.burn.errorParkedCount).toBe(0)
    expect(fleet.burn.errorOffFenceCount).toBe(0)
  })

  it('counts a parked lane once, never doubling into "blocked" even when workmux still declares it waiting', () => {
    const HANDLE = 'pk'
    const manifest: LaneManifest = {
      [HANDLE]: { handle: HANDLE, fence: ['packages/parked/**'], issue: null, model: null, parked: true },
    }
    const log = [
      event('session.started', { sessionId: 'parked-waiting', repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' }, NOW - 60_000),
      event('worktree.discovered', { path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, NOW - 60_000),
      event('worktree.discovered', { path: '/repo-wt/pk', branch: HANDLE, head: 'sha-pk', isMain: false }, NOW - 60_000),
      event('agent.status', { handle: HANDLE, status: 'waiting', worktreePath: '/repo-wt/pk', branch: HANDLE }, NOW - 30_000),
    ]
    const fleet = buildFleet(reduceAll(log), { now: NOW, manifest })

    expect(laneIn(fleet, HANDLE).parked).toBe(true)
    expect(kindsFor(fleet, HANDLE)).toContain('waiting')
    expect(fleet.burn.errorParkedCount).toBe(1)
    expect(fleet.burn.errorBlockedCount).toBe(0)
    expect(fleet.burn.errorCount).toBe(1)
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

/**
 * #246 surfaced `Lane.costUsdPerHour` / `Lane.costRateIsAuthoritative` so
 * `api/lab.ts` could stop re-folding the log for one lane's spend rate. The
 * estimate route's own test only ever exercises a lane with a *single* handle,
 * so it cannot see the part that is actually new: a lane resolves every handle
 * sharing its branch or worktree (`plumbing.ts`'s `resolveLaneId`), and the
 * rate is the sum across all of them. Replacing that sum with
 * `costRates[handles[0]]` left all 262 files green — these pin it.
 */
describe('Lane.costUsdPerHour and Lane.costRateIsAuthoritative (#246)', () => {
  const BRANCH = 'feature-foo'
  const WORKTREE = '/repo-wt/foo'
  const WINDOW = 60 * 60_000

  function baseLog(startedAt: number): RhizomorphEvent[] {
    return [
      event('session.started', { sessionId: 'cost', repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' }, startedAt),
      event('worktree.discovered', { path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, startedAt),
      event('worktree.discovered', { path: WORKTREE, branch: BRANCH, head: 'sha-foo', isMain: false }, startedAt),
    ]
  }

  function cost(lane: string, costUsd: number, authoritative: boolean, ts: number): RhizomorphEvent {
    return event(
      'llm.cost',
      { lane, role: 'worker', model: 'claude-opus-5', branch: BRANCH, worktreePath: WORKTREE, costUsd, authoritative },
      ts,
    )
  }

  it('sums the rate across every collector handle the lane resolved, not just the first', () => {
    const log = [
      ...baseLog(NOW - 30 * 60_000),
      cost('foo', 3.6, true, NOW - 10 * 60_000),
      cost('foo-otel', 2.4, true, NOW - 5 * 60_000),
    ]
    const lane = laneIn(buildFleet(reduceAll(log), { now: NOW, windowMs: WINDOW }), BRANCH)

    // Both handles resolved into one lane — the premise the sum exists for.
    expect(lane.handles).toEqual(['foo', 'foo-otel'])
    // $6.00 inside a one-hour window is $6.00/hr. Either handle alone would
    // give 3.6 or 2.4, so this fails for a first-handle-only derivation.
    expect(lane.costUsdPerHour).toBeCloseTo(6, 5)
    expect(lane.costRateIsAuthoritative).toBe(true)
  })

  it('reports `null` — never a $0.00 that reads as a real answer — when no dollars landed in the window', () => {
    const log = [
      ...baseLog(NOW - 3 * 60 * 60_000),
      cost('foo', 9.9, true, NOW - 2 * 60 * 60_000), // outside the trailing hour
    ]
    const lane = laneIn(buildFleet(reduceAll(log), { now: NOW, windowMs: WINDOW }), BRANCH)

    expect(lane.costRateIsAuthoritative).toBeNull()
    expect(lane.costUsdPerHour).toBe(0)
  })

  it('goes non-authoritative when any one handle in the lane only estimated its dollars', () => {
    const log = [
      ...baseLog(NOW - 30 * 60_000),
      cost('foo', 3.6, true, NOW - 10 * 60_000),
      cost('foo-otel', 2.4, false, NOW - 5 * 60_000),
    ]
    const lane = laneIn(buildFleet(reduceAll(log), { now: NOW, windowMs: WINDOW }), BRANCH)

    expect(lane.costRateIsAuthoritative).toBe(false)
    expect(lane.costUsdPerHour).toBeCloseTo(6, 5)
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

// ── dirty-status incident (#606) ────────────────────────────────────────────

describe('Lane.dirtyStatusFailedSince (#606)', () => {
  function twoLaneLog(f: ReturnType<typeof createEventFactory>) {
    return [
      f.sessionStarted({ mainBranch: 'main' }, { ts: NOW - 60_000 }),
      f.worktreeDiscovered({ path: '/repo', branch: 'main', isMain: true }, { ts: NOW - 60_000 }),
      f.worktreeDiscovered({ path: '/repo-wt/a', branch: 'a', isMain: false }, { ts: NOW - 60_000 }),
      f.worktreeDiscovered({ path: '/repo-wt/b', branch: 'b', isMain: false }, { ts: NOW - 60_000 }),
    ]
  }

  it('reaches the Lane as the raw timestamp plus the derived duration', () => {
    const f = createEventFactory()
    const failedTs = NOW - 30_000
    const state = reduceAll([
      ...twoLaneLog(f),
      f.worktreeDirtyStatusFailed(
        { worktreePath: '/repo-wt/a', consecutiveFailures: 4, message: 'boom' },
        { ts: failedTs },
      ),
    ])
    const fleet = buildFleet(state, { now: NOW })
    expect(laneIn(fleet, 'a').dirtyStatusFailedSince).toBe(failedTs)
    expect(laneIn(fleet, 'a').dirtyStatusFailedForMs).toBe(NOW - failedTs)
  })

  it('is null for a lane with no such event', () => {
    const f = createEventFactory()
    const state = reduceAll(twoLaneLog(f))
    const fleet = buildFleet(state, { now: NOW })
    expect(laneIn(fleet, 'a').dirtyStatusFailedSince).toBeNull()
    expect(laneIn(fleet, 'a').dirtyStatusFailedForMs).toBeNull()
  })

  it('isolates the incident to its own lane — a sibling stays clean', () => {
    const f = createEventFactory()
    const state = reduceAll([
      ...twoLaneLog(f),
      f.worktreeDirtyStatusFailed(
        { worktreePath: '/repo-wt/a', consecutiveFailures: 4, message: 'boom' },
        { ts: NOW - 30_000 },
      ),
    ])
    const fleet = buildFleet(state, { now: NOW })
    expect(laneIn(fleet, 'a').dirtyStatusFailedSince).not.toBeNull()
    expect(laneIn(fleet, 'b').dirtyStatusFailedSince).toBeNull()
  })

  it('is NOT a pathology and keeps a lane with only this incident off the ladder, rank calm', () => {
    const f = createEventFactory()
    const state = reduceAll([
      ...twoLaneLog(f),
      f.worktreeDirtyStatusFailed(
        { worktreePath: '/repo-wt/a', consecutiveFailures: 4, message: 'boom' },
        { ts: NOW - 30_000 },
      ),
    ])
    const fleet = buildFleet(state, { now: NOW })
    const lane = laneIn(fleet, 'a')
    expect(lane.dirtyStatusFailedSince).not.toBeNull()
    expect(lane.pathologies).toHaveLength(0)
    expect(lane.rank).toBe('calm')
    expect(fleet.ladder.items.some((item) => item.laneId === 'a')).toBe(false)
  })

  it('recovery brings both fields back to null', () => {
    const f = createEventFactory()
    const state = reduceAll([
      ...twoLaneLog(f),
      f.worktreeDirtyStatusFailed(
        { worktreePath: '/repo-wt/a', consecutiveFailures: 4, message: 'boom' },
        { ts: NOW - 30_000 },
      ),
      f.worktreeDirtyStatusRecovered({ worktreePath: '/repo-wt/a' }, { ts: NOW - 10_000 }),
    ])
    const fleet = buildFleet(state, { now: NOW })
    expect(laneIn(fleet, 'a').dirtyStatusFailedSince).toBeNull()
    expect(laneIn(fleet, 'a').dirtyStatusFailedForMs).toBeNull()
  })
})

// ── a lane carries its actors (prd-57 ruling 1, #516) ─────────────────────────

/**
 * Review of #553, B4. `actors:` on the lane had NO test: replacing the whole
 * expression with `[]` left `packages/core` 1375/1375 and `packages/web`
 * 3541/3541 green. Three decisions live in that one line, each with a reason
 * written beside it in `buildFleet.ts`, and none of the three was covered.
 *
 * Every case below is folded from real events through the real reducer, so the
 * index is exercised rather than the shape of the object it produces.
 */
describe('a lane carries its actors, folded from process events', () => {
  const WT = `${FIXTURE_REPO_PATH}-wt/feature`

  function fleetWith(events: RhizomorphEvent[]): Fleet {
    return buildFleet(reduceAll(events), { now: NOW })
  }

  function laneWithWorktree(f: ReturnType<typeof createEventFactory>) {
    return f.worktreeDiscovered({ path: WT, branch: 'feature', isMain: false })
  }

  it('an actor placed in a lane\'s worktree appears on that lane', () => {
    const f = createEventFactory()
    const fleet = fleetWith([
      laneWithWorktree(f),
      f.processSeen({ pid: 4321, worktreePath: WT, dialect: 'claude', placement: 'rooted' }),
    ])

    const lane = laneIn(fleet, 'feature')
    expect(lane.actors.map((actor) => actor.pid)).toEqual([4321])
    expect(lane.actors[0]?.dialect).toBe('claude')
  })

  it('two actors in one worktree both land on it — a conductor and its worker', () => {
    // The bucket branch: the second actor pushes rather than replacing. A map
    // written `set(path, [actor])` unconditionally keeps only the last one, and
    // a swarm lane is exactly where more than one actor is normal.
    const f = createEventFactory()
    const fleet = fleetWith([
      laneWithWorktree(f),
      f.processSeen({ pid: 100, worktreePath: WT, parentPid: null }),
      f.processSeen({ pid: 200, worktreePath: WT, parentPid: 100 }),
    ])

    expect(laneIn(fleet, 'feature').actors.map((actor) => actor.pid).sort()).toEqual([100, 200])
  })

  it('an actor in ANOTHER worktree does not appear on this lane', () => {
    const f = createEventFactory()
    const fleet = fleetWith([
      laneWithWorktree(f),
      f.worktreeDiscovered({ path: `${FIXTURE_REPO_PATH}-wt/other`, branch: 'other', isMain: false }),
      f.processSeen({ pid: 4321, worktreePath: `${FIXTURE_REPO_PATH}-wt/other` }),
    ])

    expect(laneIn(fleet, 'feature').actors).toEqual([])
    expect(laneIn(fleet, 'other').actors.map((actor) => actor.pid)).toEqual([4321])
  })

  it('an actor with a NULL worktreePath reaches no lane at all — and crashes nothing', () => {
    // Windows reaches this for every process: `Win32_Process` exposes no
    // working directory. The skip is a `continue` in the index loop, and the
    // failure it prevents is a `null` key bucketing every unplaceable actor
    // together and handing that bucket to whichever lane also has no path.
    const f = createEventFactory()
    const fleet = fleetWith([
      laneWithWorktree(f),
      f.processSeen({ pid: 4321, worktreePath: null, placement: 'unknown' }),
    ])

    expect(laneIn(fleet, 'feature').actors).toEqual([])
    for (const lane of fleet.lanes) expect(lane.actors).toEqual([])
  })

  it('a placeless actor does not land on a PLACELESS LANE — the null bucket the guard exists to prevent', () => {
    // The case above asserts the right behaviour and does not exercise the
    // guard: its only lane has a path, so a placeless actor misses it whether
    // the `continue` is there or not. Certified — replacing BOTH guards with a
    // `String(...)` key leaves `fleet` + `selectors` 553/553 green (review of
    // #553, round 2).
    //
    // This is the failure the comment beside the skip actually names, and it
    // needs the other half: a lane whose own `worktreePath` is null. That is
    // not hypothetical — `Lane.worktreePath` is `string | null`, and a lane
    // built from telemetry the git collector never found a home for keeps it
    // null (`buildFleet.ts`, the `claim` step). Pair that with Windows, where
    // EVERY actor is placeless, and a single orphan lane collects the entire
    // fleet's processes.
    const f = createEventFactory()
    const fleet = fleetWith([
      laneWithWorktree(f),
      f.llmUsage({ lane: 'orphan', branch: null, worktreePath: null, sessionId: 'sess-orphan' }),
      f.processSeen({ pid: 4321, worktreePath: null, placement: 'unknown' }),
    ])

    const placeless = fleet.lanes.filter((lane) => lane.worktreePath === null)
    // The control: without a placeless lane this test asserts nothing, which is
    // exactly how the case above passes while its guard is gone.
    expect(placeless.length, 'no placeless lane was built — this test would be vacuous').toBeGreaterThan(0)
    for (const lane of placeless) expect(lane.actors).toEqual([])
  })

  it('a GONE actor STAYS on its lane — dropping it would destroy half of ruling 5\'s pair', () => {
    // The deliberate retention, and the one most likely to be "tidied up" by a
    // later reader. `crashed` is reached from a `gone` that FOLLOWS a `seen`;
    // an index that dropped gone actors would remove the first half of that
    // pair before the raiser ever ran.
    const f = createEventFactory()
    const fleet = fleetWith([
      laneWithWorktree(f),
      f.processSeen({ pid: 4321, worktreePath: WT }),
      f.processGone({ pid: 4321, reason: 'absent' }),
    ])

    const actors = laneIn(fleet, 'feature').actors
    expect(actors.map((actor) => actor.pid)).toEqual([4321])
    // And it says so, rather than hiding it: a reader wanting only live actors
    // filters on `goneAt`, which is a fact this object states.
    expect(actors[0]?.goneAt).not.toBeNull()
  })

  it('a lane with no actors carries an empty list, never undefined', () => {
    const f = createEventFactory()
    const fleet = fleetWith([laneWithWorktree(f)])
    expect(laneIn(fleet, 'feature').actors).toEqual([])
  })
})
