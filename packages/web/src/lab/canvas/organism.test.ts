import { describe, expect, it } from 'vitest'
import { markerX } from '../axis/position.js'
import type { LabCheckpoint, LabExperiment, LabRun, LabRunOutcome } from '../types.js'
import { costWidth, layoutCanvas, organismState, WIDTH_CAP, WIDTH_FLOOR } from './organism.js'

const provenance = { source: 'measure-route' as const, verifyCommand: 'npm test', measuredAt: 2000 }
function outcome(overrides: Partial<LabRunOutcome> & { verified: LabRunOutcome['verified'] }): LabRunOutcome {
  return { verifiedDetail: null, costUsd: 1, durationMs: 1, commits: 1, provenance, ...overrides }
}
function run(id: string, n: number, measured?: LabRunOutcome): LabRun {
  return { eventId: id, dispatchedAt: 1000, run: n, laneHandle: `lane-${id}`, worktreePath: '/tmp/x', ...(measured === undefined ? {} : { outcome: measured }) }
}
function experiment(arms: LabExperiment['arms']): LabExperiment {
  return { forkId: 'fork-1', parentLane: 'feature', checkpointId: 'ckpt-1', arms }
}
const CHECKPOINT: LabCheckpoint = {
  eventId: 'e', lane: 'feature', checkpointId: 'ckpt-1', capturedAt: 1, capturedBy: 'operator', snapshotRef: 'refs/rhizomorph/checkpoints/ckpt-1', snapshotSha: 's', headSha: 'h',
  eventIndex: 3, sessionCutByte: 460, sessionByteLength: 1000,
}

const THREE_BY_TWO = experiment([
  { arm: 1, treatment: { model: 'opus', promptDigest: null }, runs: [run('a1', 1, outcome({ verified: 'pass', costUsd: 2 })), run('a2', 2)] },
  { arm: 2, treatment: { model: 'sonnet', promptDigest: null }, runs: [run('b1', 1, outcome({ verified: 'fail' })), run('b2', 2, outcome({ verified: 'not-run', costUsd: null }))] },
  { arm: 3, treatment: { model: null, promptDigest: null }, runs: [run('c1', 1), run('c2', 2)] },
])

describe('the lane canvas draws n organisms from n dispatch records — never a synthesised count (prd53 ruling 5)', () => {
  it('organisms === runs, keyed by the run handles as a set, arm-major then run', () => {
    const layout = layoutCanvas({ experiment: THREE_BY_TWO })
    const handles = THREE_BY_TWO.arms.flatMap((arm) => arm.runs.map((r) => r.laneHandle))
    expect(layout.organisms).toHaveLength(handles.length)
    expect(new Set(layout.organisms.map((o) => o.id))).toEqual(new Set(handles))
    expect(layout.organisms.map((o) => [o.arm, o.run])).toEqual([[1, 1], [1, 2], [2, 1], [2, 2], [3, 1], [3, 2]])
  })

  it('a failed arm is a stub — drawn, named, and not an organism (ruling 7)', () => {
    const layout = layoutCanvas({ experiment: THREE_BY_TWO, failedArms: [{ arm: 4, error: 'restore failed' }] })
    expect(layout.organisms).toHaveLength(6)
    expect(layout.stubs).toEqual([expect.objectContaining({ arm: 4, error: 'restore failed' })])
  })

  it('an experiment with no runs yet has no organisms — nothing is drawn from nothing', () => {
    expect(layoutCanvas({ experiment: experiment([{ arm: 1, treatment: { model: null, promptDigest: null }, runs: [] }]) }).organisms).toHaveLength(0)
  })

  it('the root sits at the fork\'s x on the session axis — through the one position function', () => {
    const layout = layoutCanvas({ experiment: THREE_BY_TWO, checkpoint: CHECKPOINT, width: 1000 })
    expect(layout.root.at.x).toStrictEqual(markerX(CHECKPOINT, 1000))
    expect(layoutCanvas({ experiment: THREE_BY_TWO, checkpoint: { ...CHECKPOINT, sessionByteLength: null } }).root.at.x).toBe(40)
  })

  it("the node's ink is the verdict, and an unmeasured run is still reaching — shorter than a measured one", () => {
    const layout = layoutCanvas({ experiment: THREE_BY_TWO })
    const byId = new Map(layout.organisms.map((o) => [o.id, o]))
    expect(byId.get('lane-a1')?.state).toBe('passed')
    expect(byId.get('lane-b1')?.state).toBe('failed')
    expect(byId.get('lane-b2')?.state).toBe('not-run')
    expect(byId.get('lane-a2')?.state).toBe('unmeasured')
    const reach = (id: string) => {
      const o = byId.get(id)
      if (o === undefined) throw new Error(id)
      return Math.hypot(o.node.x - layout.root.at.x, o.node.y - layout.root.at.y)
    }
    expect(reach('lane-a2')).toBeLessThan(reach('lane-a1'))
    expect([...new Set(layout.organisms.map((o) => o.nodeInk.rgb.join(',')))]).toHaveLength(4)
  })

  it('width is booked cost on an ABSOLUTE scale — floor for nothing booked, cap past ten dollars, monotone between', () => {
    expect(costWidth(null)).toBe(WIDTH_FLOOR)
    expect(costWidth(0)).toBe(WIDTH_FLOOR)
    expect(costWidth(100)).toBe(WIDTH_CAP)
    const a = costWidth(0.1)
    const b = costWidth(1)
    const c = costWidth(5)
    expect(a).toBeLessThan(b)
    expect(b).toBeLessThan(c)
    // Absolute, never relative: the same dollar is the same width whatever its siblings cost.
    const alone = layoutCanvas({ experiment: experiment([{ arm: 1, treatment: { model: null, promptDigest: null }, runs: [run('x', 1, outcome({ verified: 'pass', costUsd: 1 }))] }]) })
    expect(alone.organisms[0]?.width).toBe(costWidth(1))

    /**
     * And with the SIBLINGS varied, which is what "whatever its siblings cost"
     * claims and what the line above cannot show — it compares `layoutCanvas`
     * to the very function `layoutCanvas` calls, so a fleet-relative rescale
     * applied inside `costWidth` itself would satisfy it (review of #341).
     * Here the same one-dollar run is laid out beside a ten-dollar and a
     * one-cent sibling: a relative scale would move it, an absolute one cannot.
     */
    const crowded = layoutCanvas({
      experiment: experiment([
        {
          arm: 1,
          treatment: { model: null, promptDigest: null },
          runs: [
            run('x', 1, outcome({ verified: 'pass', costUsd: 1 })),
            run('rich', 2, outcome({ verified: 'pass', costUsd: 10 })),
            run('poor', 3, outcome({ verified: 'pass', costUsd: 0.01 })),
          ],
        },
      ]),
    })
    expect(crowded.organisms.find((o) => o.id === 'lane-x')?.width).toBe(alone.organisms[0]?.width)
  })

  /**
   * THE INTERIOR OF THE SCALE, which nothing pinned (review of #341). The test
   * above holds the two endpoints and monotonicity, and both survive any
   * monotone curve: EXECUTED — halving the interpolated span in `costWidth`
   * (`* 100` → `* 50`) left all 31 lab test files at 249 passed, while making
   * `costWidth(1)` return 0.9, BELOW the floor the same module declares.
   *
   * What "log-spaced from a cent to ten dollars" actually means is that equal
   * cost RATIOS are equal width steps. Walking ×√10 six times from $0.01 to $10
   * says exactly that, and a linear scale — or a rescaled one — fails it.
   */
  it('the scale is LOG-spaced between its ends, and never leaves them: equal cost ratios are equal width steps', () => {
    const ROOT_TEN = Math.sqrt(10)
    const costs = [0.01, 0.01 * ROOT_TEN, 0.1, 0.1 * ROOT_TEN, 1, ROOT_TEN, 10]
    const widths = costs.map(costWidth)

    for (const width of widths) {
      expect(width).toBeGreaterThanOrEqual(WIDTH_FLOOR)
      expect(width).toBeLessThanOrEqual(WIDTH_CAP)
    }

    const step = (WIDTH_CAP - WIDTH_FLOOR) / (costs.length - 1)
    for (const [index, width] of widths.entries()) {
      if (index === 0) continue
      expect(width - (widths[index - 1] as number), `step ${index} is one sixth of the range`).toBeCloseTo(step, 1)
    }
  })

  it('organismState maps every verdict, and no verdict, to one state', () => {
    expect([undefined, 'pass', 'fail', 'not-run'].map((v) => organismState(v as never))).toEqual(['unmeasured', 'passed', 'failed', 'not-run'])
  })
})
