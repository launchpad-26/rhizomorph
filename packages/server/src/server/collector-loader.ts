import type { AnyCollector, Collector, ObservatoryEvent } from '@observatory/core'
import { reduceAll } from '@observatory/core'
import { gitCollector } from '../collectors/git/index.js'
import type { DisableableSnapshot } from '../collectors/resilience.js'
import { withResilience } from '../collectors/resilience.js'
import { withResumeReconciliation } from '../collectors/resume-reconcile.js'
import { tmuxCollector } from '../collectors/tmux/index.js'
import { createWorkmuxCollector } from '../collectors/workmux/index.js'

/**
 * Registers the three collectors via static imports, so Vite/Rollup can
 * bundle them (a variable dynamic import like `import(\`./${slug}\`)` cannot be
 * statically analysed and fails at runtime). A collector whose binary is
 * missing (no tmux, no workmux) still loads fine here — it degrades to
 * `collector.disabled` at poll time, which is the collector's job, not this
 * one's.
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
  priorEvents: readonly ObservatoryEvent[] = [],
): Promise<AnyCollector[]> {
  const folded = reduceAll(priorEvents)
  function wrap<S extends DisableableSnapshot>(collector: Collector<S>): AnyCollector {
    return withResumeReconciliation(withResilience(collector), folded.collectors[collector.name])
  }

  return [wrap(gitCollector), wrap(tmuxCollector), wrap(createWorkmuxCollector())]
}
