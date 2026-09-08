import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { compareArms } from './compare/compare.js'
import { experimentToComparisonInput, MEASURES } from './compare/fromExperiment.js'
import { armFloor, experimentSpend } from './metrics/spend.js'
import type { LabArm, LabExperiment, LabRun, LabRunOutcome } from './types.js'

/**
 * ONE DENOMINATOR FOR THE ARM FLOOR (prd53 ruling 2, amendment 2026-09-08 —
 * the wave-3 review's finding). Core's `canSummariseArm` unified the NUMBER
 * (three) but three callers fed it three different counts: the CLI and
 * Metrics counted runs a gate had judged, Compare counted only a pass with a
 * value under the selected measure — so the same arm, at the same moment, on
 * the same page, read "a summary may be stated" in Metrics and "too few runs
 * to summarise" in Compare. Every existing test was single-surface, and none
 * of them could see it.
 *
 * Two halves. EXECUTED: one fixture set, every measure, Metrics' `armFloor`
 * against Compare's summary — same completed count, same floor answer, and
 * the answer does not move when the measure does. GREP: the predicate is
 * spelled once, in core (`isCompletedVerdict`); no lab source file and not
 * the CLI's compare module compares a verdict to `'not-run'` on its own.
 */

const provenance = { source: 'measure-route' as const, verifyCommand: 'npm test', measuredAt: 2000 }
function outcome(overrides: Partial<LabRunOutcome> & { verified: LabRunOutcome['verified'] }): LabRunOutcome {
  return { verifiedDetail: null, costUsd: 1, durationMs: 1, commits: 1, provenance, ...overrides }
}
function run(id: string, n: number, measured?: LabRunOutcome): LabRun {
  return { eventId: id, dispatchedAt: 1000, run: n, laneHandle: `lane-${id}`, worktreePath: '/tmp/x', ...(measured === undefined ? {} : { outcome: measured }) }
}
function arm(n: number, runs: LabRun[]): LabArm {
  return { arm: n, treatment: { model: null, promptDigest: null }, runs }
}

/** Every shape the reviewer's two cases and the ordinary ones take. */
const ARMS: readonly LabArm[] = [
  arm(1, [run('a1', 1, outcome({ verified: 'pass', costUsd: 2 })), run('a2', 2, outcome({ verified: 'pass', costUsd: 3 })), run('a3', 3, outcome({ verified: 'pass', costUsd: 1 }))]),
  // case A — three runs, every gate FAILED
  arm(2, [run('b1', 1, outcome({ verified: 'fail', costUsd: 2 })), run('b2', 2, outcome({ verified: 'fail', costUsd: 5 })), run('b3', 3, outcome({ verified: 'fail', costUsd: 4 }))]),
  // case B — three passes, no cost booked to any
  arm(3, [run('c1', 1, outcome({ verified: 'pass', costUsd: null })), run('c2', 2, outcome({ verified: 'pass', costUsd: null })), run('c3', 3, outcome({ verified: 'pass', costUsd: null }))]),
  arm(4, [run('d1', 1, outcome({ verified: 'pass' })), run('d2', 2, outcome({ verified: 'not-run', costUsd: null })), run('d3', 3, outcome({ verified: 'not-run', costUsd: null }))]),
  arm(5, [run('e1', 1, outcome({ verified: 'pass' })), run('e2', 2, outcome({ verified: 'fail' })), run('e3', 3)]),
  arm(6, [run('f1', 1, outcome({ verified: 'pass' })), run('f2', 2, outcome({ verified: 'fail' }))]),
  arm(7, [run('g1', 1, outcome({ verified: 'pass', costUsd: 2 })), run('g2', 2, outcome({ verified: 'pass', costUsd: 3 })), run('g3', 3, outcome({ verified: 'fail', costUsd: 1 })), run('g4', 4)]),
  arm(8, []),
]
const EXPERIMENT: LabExperiment = { forkId: 'fork-1', parentLane: 'feature', checkpointId: 'ckpt-1', arms: [...ARMS] }

describe('Metrics and Compare answer the arm floor identically, for every arm, under every measure (prd53 ruling 2, amended)', () => {
  for (const measure of MEASURES) {
    it(`under "${measure}": same completed count, same floor answer, arm by arm`, () => {
      const summaries = compareArms(experimentToComparisonInput(EXPERIMENT, measure)).arms
      ARMS.forEach((labArm, index) => {
        const floor = armFloor(labArm)
        const summary = summaries[index]
        expect(summary, `arm ${labArm.arm} has a summary`).toBeDefined()
        expect(summary?.completedCount, `arm ${labArm.arm}: completed count`).toBe(floor.completedRuns)
        expect(summary?.insufficientReason === null, `arm ${labArm.arm}: floor answer`).toBe(floor.canSummarise)
      })
    })
  }

  it('the floor answer does not move when the measure does — completeness is measure-independent', () => {
    ARMS.forEach((labArm, index) => {
      const answers = new Set(MEASURES.map((measure) => compareArms(experimentToComparisonInput(EXPERIMENT, measure)).arms[index]?.insufficientReason === null))
      expect(answers.size, `arm ${labArm.arm}`).toBe(1)
    })
  })

  it('case A — three failed gates: both surfaces summarise, and Compare spreads what they cost while saying none passed', () => {
    const floor = armFloor(ARMS[1] as LabArm)
    expect(floor.canSummarise).toBe(true)
    const byCost = compareArms(experimentToComparisonInput(EXPERIMENT, 'cost')).arms[1]
    expect(byCost?.spread).toEqual({ min: 2, max: 5 })
    const byVerified = compareArms(experimentToComparisonInput(EXPERIMENT, 'verified')).arms[1]
    expect([byVerified?.passCount, byVerified?.failCount, byVerified?.completedCount]).toEqual([0, 3, 3])
  })

  it('case B — three passes with nothing booked: both surfaces summarise, nobody invents a $0', () => {
    const floor = armFloor(ARMS[2] as LabArm)
    expect(floor.canSummarise).toBe(true)
    const byCost = compareArms(experimentToComparisonInput(EXPERIMENT, 'cost')).arms[2]
    expect(byCost?.insufficientReason).toBeNull()
    expect(byCost?.spread).toBeNull()
    expect(byCost?.unbookedNote).toBe('3 completed — no value is booked under this measure for any of them yet')
    const spend = experimentSpend({ ...EXPERIMENT, arms: [ARMS[2] as LabArm] })
    expect(spend.bookedUsd).toBeNull()
    expect(spend.unbookedRuns).toBe(3)
  })
})

// --- the grep half: completeness is spelled once, in core ----------------------

const HERE = path.dirname(fileURLToPath(import.meta.url))

function walk(dir: string, root: string = dir): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, root))
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue
    out.push({ name: path.relative(root, full), text: readFileSync(full, 'utf8') })
  }
  return out
}

/**
 * Two spellings, two scopes. `!== 'not-run'` — "everything a gate judged" — IS
 * the completeness idiom and is banned everywhere under lab/ and in the CLI's
 * compare module. `=== 'not-run'` has honest uses that are not counts (the
 * measure route's payload guard lists all three verdicts; the CLI's table cell
 * prints the label), so it is banned only in the files that COUNT.
 */
const COMPLETENESS_IDIOM = /!==\s*'not-run'|'not-run'\s*!==/
const ANY_VERDICT_COMPARISON = /[=!]==\s*'not-run'|'not-run'\s*[=!]==/
const COUNTING_FILES = ['metrics/spend.ts', 'metrics/Metrics.tsx', 'compare/fromExperiment.ts', 'compare/summarise.ts', 'compare/ComparisonSurface.tsx', 'adapters.ts']

describe('the completeness predicate has exactly one spelling — core’s isCompletedVerdict', () => {
  it('no lab source file spells "everything but not-run" on its own', () => {
    const offenders = walk(HERE)
      .filter((file) => COMPLETENESS_IDIOM.test(file.text))
      .map((file) => file.name)
    expect(offenders).toEqual([])
  })

  it('the files that count compare no verdict to not-run at all, either way round', () => {
    for (const rel of COUNTING_FILES) {
      expect(readFileSync(path.join(HERE, rel), 'utf8'), rel).not.toMatch(ANY_VERDICT_COMPARISON)
    }
  })

  it("nor does the CLI's compare module — the third surface", () => {
    const cli = readFileSync(path.resolve(HERE, '..', '..', '..', 'server', 'src', 'lab', 'compare.ts'), 'utf8')
    expect(cli).not.toMatch(COMPLETENESS_IDIOM)
    expect(cli).toContain('isCompletedVerdict')
  })

  it('the three counting sites all import it', () => {
    for (const rel of ['metrics/spend.ts', 'compare/fromExperiment.ts', 'adapters.ts']) {
      expect(readFileSync(path.join(HERE, rel), 'utf8'), rel).toMatch(/isCompletedVerdict/)
    }
  })
})
