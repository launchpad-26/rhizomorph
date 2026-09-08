import { describe, expect, it } from 'vitest'
import type { LabExperiment, LabRun } from '../types.js'
import { layoutCanvas } from './organism.js'

/**
 * THE FRAME-BUDGET MEASUREMENT, in the form the PRD left to the implementer
 * (prd53 #329's open item): the canvas inherits the scene's 16.67 ms budget
 * and its ratios-not-absolutes discipline. Timings are REPORTED here and never
 * asserted — a wall clock is not a law (AGENTS.md); the assertion is the count,
 * which is the shape ruling 5 pins. The cell is the harness's own 60 × 3 = 180
 * threads (prd-49), so the number lands beside the ones already in the record.
 */
function run(id: string, n: number): LabRun {
  return { eventId: id, dispatchedAt: 1000, run: n, laneHandle: `lane-${id}`, worktreePath: '/tmp/x' }
}

function cell(arms: number, runs: number): LabExperiment {
  return {
    forkId: 'fork-perf',
    parentLane: 'feature',
    checkpointId: 'ckpt-1',
    arms: Array.from({ length: arms }, (_unused, a) => ({
      arm: a + 1,
      treatment: { model: null, promptDigest: null },
      runs: Array.from({ length: runs }, (_u, r) => run(`${a + 1}-${r + 1}`, r + 1)),
    })),
  }
}

describe('lane canvas — the 180-thread cell (reported, never asserted)', () => {
  it('lays out 60 arms × 3 runs into exactly 180 organisms, and reports what that cost', () => {
    const experiment = cell(60, 3)
    const before = performance.now()
    let layout = layoutCanvas({ experiment, width: 1000, height: 400 })
    for (let i = 0; i < 29; i += 1) layout = layoutCanvas({ experiment, width: 1000, height: 400 })
    const perLayoutMs = (performance.now() - before) / 30
    expect(layout.organisms).toHaveLength(180)
    // Reported beside the harness's own cells; the 16.67 ms budget is the yardstick, not the assertion.
    console.info(`lane canvas · 60×3 = 180 organisms · ${perLayoutMs.toFixed(3)} ms per layout over 30 (budget 16.67 ms; ratio ${(perLayoutMs / 16.67).toFixed(3)})`)
  })
})
