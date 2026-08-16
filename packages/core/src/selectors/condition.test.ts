import { describe, expect, it } from 'vitest'
import type { Lane, LaneActivity, Pathology } from '../fleet/index.js'
import { INFERRED_MARK, PATHOLOGY_RANK } from '../fleet/index.js'
import { selectLaneCondition, selectWorstPathology, type LaneCondition } from './condition.js'

/**
 * The condition selector's own table (prd-30 ruling 2 · #560): every
 * pathology, every calm activity, PARKED and the two shapes of `done`, each
 * asserted to carry a real fact and a measured elapsed time — never a bare
 * label — plus the boundaries between them (parked over pathology, worst
 * pathology over the rest, terminal-done riding beside either).
 */

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0)

function baseLane(overrides: Partial<Lane> = {}): Lane {
  return {
    id: 'lane-1',
    label: 'lane-1',
    handles: ['lane-1'],
    branch: 'lane-1',
    worktreePath: '/repo/lane-1',
    issue: null,
    role: 'worker',
    telemetryOnly: false,
    present: true,
    slot: 0,
    agentStatus: null,
    activity: 'working',

    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
    outputTokens: 0,
    costUsd: 0,
    costIsAuthoritative: null,
    costEventCount: 0,
    requestCount: 0,
    toolCallCount: 0,
    outputPerMin: 0,
    costUsdPerHour: 0,
    costRateIsAuthoritative: null,
    recentOutputTokens: [],
    filaments: [],
    model: null,

    aheadOfMain: 0,
    commitCount: 0,
    dirtyCount: 0,
    filesTouched: 0,

    lastEventTs: NOW - 10_000,
    ageMs: 10_000,
    lastWorkTs: NOW - 10_000,
    workAgeMs: 10_000,
    firstSeenAt: NOW - 60_000,
    activeSeconds: null,
    waitedOnHuman: {
      totalWaitMs: 0,
      waitCount: 0,
      decisions: { accept: 0, reject: 0, unknown: 0 },
      longestWait: null,
      longestWaitDecision: null,
    },
    subagents: null,

    recentTools: [],
    pathologies: [],
    trespasses: [],
    fenced: false,
    rank: 'calm',
    parked: false,

    ...overrides,
  }
}

function pathology(overrides: Partial<Pathology> & { kind: Pathology['kind'] }): Pathology {
  return {
    since: null,
    evidence: 'evidence',
    inferred: false,
    rank: PATHOLOGY_RANK[overrides.kind],
    ...overrides,
  }
}

/** Every arm must carry non-empty prose and a finite, non-negative elapsed. */
function expectHonest(condition: LaneCondition): void {
  expect(condition.label.trim()).not.toBe('')
  expect(condition.why.reason.trim()).not.toBe('')
  expect(condition.why.evidence.fact.trim()).not.toBe('')
  expect(Number.isFinite(condition.why.evidence.elapsedMs)).toBe(true)
  expect(condition.why.evidence.elapsedMs).toBeGreaterThanOrEqual(0)
  if (condition.remedy.kind === 'action') expect(condition.remedy.action.trim()).not.toBe('')
  else expect(condition.remedy.because.trim()).not.toBe('')
}

describe('selectLaneCondition — the five pathologies', () => {
  it('LOOPING: names the cycle and its age, and gives an action', () => {
    const p = pathology({ kind: 'looping', since: NOW - 240_000, evidence: 'Read→Edit→Bash ×6, no commit' })
    const lane = baseLane({ pathologies: [p], rank: 'needs-you' })
    const condition = selectLaneCondition(lane, NOW)

    expect(condition.label).toBe('LOOPING')
    expect(condition.why.evidence.fact).toContain('Read→Edit→Bash ×6, no commit')
    expect(condition.why.evidence.elapsedMs).toBe(240_000)
    expect(condition.remedy.kind).toBe('action')
    expectHonest(condition)
  })

  it('FROZEN: elapsed matches the silence, not a fixed window', () => {
    const p = pathology({ kind: 'frozen', since: NOW - 480_000, evidence: 'no events for 8m00s' })
    const lane = baseLane({ pathologies: [p], rank: 'broken', ageMs: 480_000 })
    const condition = selectLaneCondition(lane, NOW)

    expect(condition.label).toBe('FROZEN')
    expect(condition.why.evidence.fact).toContain('no events for 8m00s')
    expect(condition.why.evidence.elapsedMs).toBe(480_000)
    expectHonest(condition)
  })

  it('WAITING: certain evidence names the human it is waiting on to answer', () => {
    const p = pathology({
      kind: 'waiting',
      since: NOW - 90_000,
      evidence: 'workmux reports waiting 1m30s',
      inferred: false,
    })
    const lane = baseLane({ pathologies: [p], rank: 'needs-you', agentStatus: 'waiting' })
    const condition = selectLaneCondition(lane, NOW)

    expect(condition.label).toBe('WAITING')
    expect(condition.why.reason).not.toBe('stopped')
    expect(condition.why.evidence.fact).toContain('workmux reports waiting')
    expect(condition.remedy.kind).toBe('action')
    expectHonest(condition)
  })

  it('WAITING, inferred: the evidence carries the inferred mark', () => {
    const p = pathology({
      kind: 'waiting',
      since: NOW - 75_000,
      evidence: 'quiet 1m15s, pane still alive',
      inferred: true,
    })
    const lane = baseLane({ pathologies: [p], rank: 'needs-you' })
    const condition = selectLaneCondition(lane, NOW)

    expect(condition.why.evidence.fact.startsWith(INFERRED_MARK)).toBe(true)
  })

  it('EXPENSIVE: notice-rank, and the remedy says why there is nothing to act on', () => {
    const p = pathology({ kind: 'expensive', evidence: '900 out-tok/min, 3.0× fleet median' })
    const lane = baseLane({ pathologies: [p], rank: 'notice' })
    const condition = selectLaneCondition(lane, NOW)

    expect(condition.label).toBe('EXPENSIVE')
    expect(condition.why.evidence.fact).toContain('fleet median')
    expect(condition.why.evidence.elapsedMs).toBe(0)
    expect(condition.remedy).toEqual({
      kind: 'none',
      because: expect.stringContaining('worth watching'),
    })
    expectHonest(condition)
  })

  it('OFF-FENCE: names the trespassed path, not merely a count', () => {
    const p = pathology({
      kind: 'off-fence',
      evidence: 'outside fence — packages/core/src/selectors/spend-subrows.ts',
    })
    const lane = baseLane({ pathologies: [p], rank: 'needs-you', fenced: true })
    const condition = selectLaneCondition(lane, NOW)

    expect(condition.label).toBe('OFF-FENCE')
    expect(condition.why.evidence.fact).toContain('packages/core/src/selectors/spend-subrows.ts')
    expectHonest(condition)
  })
})

describe('selectLaneCondition — boundaries', () => {
  it('takes the worst-ranked pathology, not the first one in the array', () => {
    const expensive = pathology({ kind: 'expensive', evidence: 'expensive evidence' })
    const frozen = pathology({ kind: 'frozen', since: NOW - 500_000, evidence: 'frozen evidence' })
    const lane = baseLane({ pathologies: [expensive, frozen], rank: 'broken' })

    expect(selectWorstPathology(lane)?.kind).toBe('frozen')
    const condition = selectLaneCondition(lane, NOW)
    expect(condition.label).toBe('FROZEN')
    expect(condition.why.evidence.fact).toContain('+1 more: expensive evidence')
  })

  it('names every extra pathology, not only the count', () => {
    const looping = pathology({ kind: 'looping', since: NOW - 100_000, evidence: 'looping evidence' })
    const waiting = pathology({ kind: 'waiting', since: NOW - 100_000, evidence: 'waiting evidence' })
    const offFence = pathology({ kind: 'off-fence', evidence: 'off-fence evidence' })
    const lane = baseLane({ pathologies: [looping, waiting, offFence], rank: 'needs-you' })

    const condition = selectLaneCondition(lane, NOW)
    expect(condition.why.evidence.fact).toContain('+2 more')
    expect(condition.why.evidence.fact).toContain('waiting evidence')
    expect(condition.why.evidence.fact).toContain('off-fence evidence')
  })

  it('PARKED wins over a live pathology — the operator stand-down is the loudest fact', () => {
    const p = pathology({ kind: 'expensive', evidence: 'expensive evidence' })
    const lane = baseLane({ pathologies: [p], parked: true })

    const condition = selectLaneCondition(lane, NOW)
    expect(condition.label).toBe('PARKED')
    expect(condition.remedy).toEqual({ kind: 'none', because: expect.stringContaining('.swarm/lanes.json') })
    expectHonest(condition)
  })

  it('a pathology rides beside terminal-done: the finish is said without swallowing the alarm', () => {
    const p = pathology({ kind: 'off-fence', evidence: 'off-fence evidence' })
    const lane = baseLane({
      pathologies: [p],
      rank: 'needs-you',
      dirtyCount: 0,
      aheadOfMain: 1,
      ageMs: 600_000,
      agentStatus: null,
    })

    const condition = selectLaneCondition(lane, NOW)
    expect(condition.label).toBe('OFF-FENCE')
    expect(condition.why.evidence.fact).toContain('off-fence evidence')
    expect(condition.why.evidence.fact).toMatch(/pane likely died/)
  })
})

describe('selectLaneCondition — the calm activities', () => {
  it('working: says what landed and when', () => {
    const lane = baseLane({ activity: 'working', lastWorkTs: NOW - 5_000 })
    const condition = selectLaneCondition(lane, NOW)
    expect(condition.label).toBe('working')
    expect(condition.why.evidence.elapsedMs).toBe(5_000)
    expectHonest(condition)
  })

  it('idle: never says "stopped" bare — names the threshold', () => {
    const lane = baseLane({ activity: 'idle', lastWorkTs: NOW - 120_000, workAgeMs: 120_000 })
    const condition = selectLaneCondition(lane, NOW)
    expect(condition.label).toBe('idle')
    expect(condition.why.reason).not.toBe('stopped')
    expectHonest(condition)
  })

  it('unknown: names what is missing rather than a bare word', () => {
    const lane = baseLane({ activity: 'unknown', lastWorkTs: null, workAgeMs: null, firstSeenAt: NOW - 30_000 })
    const condition = selectLaneCondition(lane, NOW)
    expect(condition.label).toBe('unknown')
    expect(condition.why.evidence.fact).toMatch(/no request|no.*update/)
    expectHonest(condition)
  })

  it('done (declared): distinct from the terminal-done shape', () => {
    const lane = baseLane({ activity: 'done', agentStatus: 'done', present: true })
    const condition = selectLaneCondition(lane, NOW)
    expect(condition.label).toBe('done')
    expect(condition.why.evidence.fact).toBe('the agent declared done')
  })

  it('done (worktree removed): says the worktree landed, not that the agent declared it', () => {
    const lane = baseLane({ activity: 'done', present: false, agentStatus: null })
    const condition = selectLaneCondition(lane, NOW)
    expect(condition.why.evidence.fact).toBe('the worktree landed and was removed')
  })

  it('done (terminal-done): says the pane likely died, never a bare "done"', () => {
    const lane = baseLane({
      activity: 'done',
      present: true,
      agentStatus: null,
      dirtyCount: 0,
      aheadOfMain: 2,
      ageMs: 600_000,
      lastEventTs: NOW - 600_000,
    })
    const condition = selectLaneCondition(lane, NOW)
    expect(condition.label).toBe('done')
    expect(condition.why.reason).not.toBe('finished')
    expect(condition.why.evidence.fact).toMatch(/pane likely died/)
    expectHonest(condition)
  })

  // Unreachable via `buildFleet` today (see `condition.ts`'s comment on this
  // arm: `activityOf` only reaches 'waiting' through a path that always also
  // produces a WAITING pathology), constructed directly here so the arm's
  // own honesty is still asserted rather than left untested because it is
  // hard to reach through the fold.
  it("waiting activity with no pathology recorded: still honest, never 'stopped'", () => {
    const lane = baseLane({ activity: 'waiting' as LaneActivity, pathologies: [] })
    const condition = selectLaneCondition(lane, NOW)
    expect(condition.label).toBe('waiting')
    expect(condition.why.reason).not.toBe('stopped')
    expectHonest(condition)
  })
})
