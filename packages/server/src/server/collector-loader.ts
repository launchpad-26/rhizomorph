import type { AnyCollector } from '@observatory/core'
import { gitCollector } from '../collectors/git/index.js'
import { withResilience } from '../collectors/resilience.js'
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
 */
export async function loadCollectors(
  _log: { warn: (msg: string) => void } = console,
): Promise<AnyCollector[]> {
  return [
    withResilience(gitCollector),
    withResilience(tmuxCollector),
    withResilience(createWorkmuxCollector()),
  ]
}
