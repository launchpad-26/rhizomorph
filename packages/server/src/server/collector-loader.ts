import type { AnyCollector, Collector, RhizomorphEvent } from '@rhizomorph/core'
import { reduceAll } from '@rhizomorph/core'
import { gitCollector } from '../collectors/git/index.js'
import { createJudgeCollector, DEFAULT_JUDGE_CADENCE_MS } from '../collectors/judge/index.js'
import type { DisableableSnapshot } from '../collectors/resilience.js'
import { withResilience } from '../collectors/resilience.js'
import { withResumeReconciliation } from '../collectors/resume-reconcile.js'
import { tmuxCollector } from '../collectors/tmux/index.js'
import { createWorkmuxCollector } from '../collectors/workmux/index.js'

/**
 * prd11 ruling 6b, phase 1: the judge organ's cadence, flag-adjustable — but
 * this issue's fence doesn't reach `cli/args.ts`, so there is no `--` flag
 * yet. An env var is the fence-scoped stand-in a future lane can promote to a
 * real CLI flag without touching this file's wiring shape.
 */
const JUDGE_CADENCE_ENV = 'RHIZOMORPH_JUDGE_CADENCE_MS'

function judgeCadenceMs(): number {
  const raw = process.env[JUDGE_CADENCE_ENV]
  if (raw === undefined) return DEFAULT_JUDGE_CADENCE_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_JUDGE_CADENCE_MS
}

/**
 * Registers the four collectors via static imports, so Vite/Rollup can
 * bundle them (a variable dynamic import like `import(\`./${slug}\`)` cannot be
 * statically analysed and fails at runtime). A collector whose binary is
 * missing (no tmux, no workmux) still loads fine here — it degrades to
 * `collector.disabled` at poll time, which is the collector's job, not this
 * one's. The judge (prd11 ruling 6b) is the fourth and, so far, the only one
 * that self-throttles its own cadence below the poll loop's tick.
 *
 * Every collector here is wrapped in `withResilience` (#110) — the shared
 * retry/backoff/self-heal policy, applied once at the seam where collectors
 * are assembled for the poll loop rather than copied into each collector.
 * A collector's own poll() still decides *whether* a tick failed (it emits
 * `collector.disabled` exactly as before); the wrapper decides how many
 * consecutive failures to tolerate before that actually sticks, and keeps
 * probing afterwards so it can un-stick itself.
 *
 * Then wrapped again in `withResumeReconciliation` (#111), fed the folded
 * status of whatever session this boot is resuming (`priorEvents`, empty for
 * a fresh session). `withResilience`'s self-heal only fires on an in-process
 * failing→succeeding transition — a freshly booted collector starts healthy
 * in memory and never makes that transition, so a stale `collector.disabled`
 * already in the log would otherwise outlive every restart. This is the seam
 * that lets the live poll catch the fold up to reality on boot.
 */
export async function loadCollectors(
  _log: { warn: (msg: string) => void } = console,
  priorEvents: readonly RhizomorphEvent[] = [],
): Promise<AnyCollector[]> {
  const folded = reduceAll(priorEvents)
  function wrap<S extends DisableableSnapshot>(collector: Collector<S>): AnyCollector {
    return withResumeReconciliation(withResilience(collector), folded.collectors[collector.name])
  }

  return [
    wrap(gitCollector),
    wrap(tmuxCollector),
    wrap(createWorkmuxCollector()),
    wrap(createJudgeCollector({ cadenceMs: judgeCadenceMs() })),
  ]
}
