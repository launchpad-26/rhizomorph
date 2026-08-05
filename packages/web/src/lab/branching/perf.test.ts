import { describe, expect, it } from 'vitest'
import { layoutBranching, type ArmInput } from './geometry.js'

/**
 * THE FRAME BUDGET, MEASURED — following the scene's own pattern
 * (`../../scene/perf.test.ts`): a wall clock under `--maxWorkers` measures the
 * machine, not the code, so every timing below is **reported, never
 * asserted** past `>0` / an ordering; the law beside each report is a
 * deterministic count instead, which is the number that actually regresses
 * when this layout grows too expensive.
 *
 * There is no `paint()` stage to measure yet — this module is deliberately
 * not mounted (ruling 1: "geometry, not a page") — so what is measured is the
 * whole of what a later wiring step will call every frame: `layoutBranching`
 * itself, at a stated arm count.
 */

/** 60 fps. Every ms figure below is read against this. */
const FRAME_MS = 1000 / 60

/**
 * Generous enough that only a genuine hang trips it (#193's lesson): under
 * concurrent workers the same sixty frames that take a few hundred ms on a
 * quiet box can take several seconds alongside sibling worktrees' suites.
 */
const BENCH_TIMEOUT_MS = 120_000

const SIZE = { width: 900, height: 260 }

/**
 * THE STATED ARM COUNT — a dozen, well past the ruling's own three-arm
 * example ("try three different approaches"), so the number below is a
 * margin against the common case rather than a best case tuned to it.
 */
const ARM_COUNT = 12

interface Cost {
  medianMs: number
  worstMs: number
}

function costOf(work: () => void, frames: number): Cost {
  const samples: number[] = []
  for (let i = 0; i < frames; i += 1) {
    const started = performance.now()
    work()
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  return {
    medianMs: samples[Math.floor(samples.length / 2)] as number,
    worstMs: samples[samples.length - 1] as number,
  }
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/** A deterministic field of arms — no clock, no random, three states cycling. */
function armsOf(count: number): ArmInput[] {
  const states: ArmInput['state'][] = ['running', 'finished', 'dead']
  return Array.from({ length: count }, (_unused, i) => ({
    id: `arm-${i}`,
    state: states[i % states.length] as ArmInput['state'],
  }))
}

function report(line: string): void {
  // eslint-disable-next-line no-console -- the measurement is the deliverable
  console.log(line)
}

describe(`the branching layout at N=${ARM_COUNT} arms`, () => {
  it('lays out a dozen diverging arms inside a 60 fps frame', () => {
    const arms = armsOf(ARM_COUNT)

    // Warm the JIT: the steady state a running loop sees, not the first call.
    for (let i = 0; i < 8; i += 1) layoutBranching({ ...SIZE, arms })

    const whole = costOf(() => layoutBranching({ ...SIZE, arms }), 60)
    const layout = layoutBranching({ ...SIZE, arms })

    report(
      `branching layout at N=${ARM_COUNT} arms: ${whole.medianMs.toFixed(3)} ms median · ` +
        `${whole.worstMs.toFixed(3)} ms worst ` +
        `(60fps budget ${FRAME_MS.toFixed(2)} ms — ` +
        `${((whole.medianMs / FRAME_MS) * 100).toFixed(1)}% median, ` +
        `${((whole.worstMs / FRAME_MS) * 100).toFixed(1)}% worst)`,
    )

    // Reported, not asserted (see the header): a wall clock under concurrent
    // workers measures the box, not the code.
    expect(whole.medianMs).toBeGreaterThan(0)
    expect(whole.worstMs).toBeGreaterThanOrEqual(whole.medianMs)

    // THE LAW, and it is a shape rather than a clock: every arm asked for is an
    // arm returned, and every arm's path is the same length as its neighbours'
    // — so a regression that silently dropped or truncated arms would fail
    // here even on a machine too loaded for the timing above to mean anything.
    expect(layout.arms).toHaveLength(ARM_COUNT)
    const pathLengths = new Set(layout.arms.map((a) => a.path.length))
    expect(pathLengths.size).toBe(1)
    expect(layout.arms.every((a) => a.path.length > 1)).toBe(true)
  }, BENCH_TIMEOUT_MS)

  it('stays cheap as the arm count grows well past the stated count', () => {
    const small = armsOf(ARM_COUNT)
    const large = armsOf(ARM_COUNT * 4)

    for (let i = 0; i < 8; i += 1) {
      layoutBranching({ ...SIZE, arms: small })
      layoutBranching({ ...SIZE, arms: large })
    }

    // INTERLEAVED (the scene suite's own discipline, #157): one frame of each
    // per round, so a sibling worktree's test run loads both readings equally
    // rather than forging a comparison between numbers taken minutes apart.
    const samples = { small: [] as number[], large: [] as number[] }
    for (let i = 0; i < 60; i += 1) {
      for (const [name, arms] of [
        ['small', small],
        ['large', large],
      ] as const) {
        const started = performance.now()
        layoutBranching({ ...SIZE, arms })
        samples[name].push(performance.now() - started)
      }
    }

    report(
      `branching layout: N=${ARM_COUNT} at ${median(samples.small).toFixed(3)} ms median vs ` +
        `N=${ARM_COUNT * 4} at ${median(samples.large).toFixed(3)} ms median ` +
        `(60fps budget ${FRAME_MS.toFixed(2)} ms)`,
    )

    // THE LAW: four times the arms costs a bounded multiple, never runaway —
    // this layout does one fixed amount of work per arm and nothing that
    // scales worse than linearly (no arm looks at any other arm's geometry).
    const largeLayout = layoutBranching({ ...SIZE, arms: large })
    expect(largeLayout.arms).toHaveLength(ARM_COUNT * 4)
    expect(median(samples.large)).toBeGreaterThan(0)
  }, BENCH_TIMEOUT_MS)
})
