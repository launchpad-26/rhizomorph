import type { AnyCollector } from '@observatory/core'
import { gitCollector } from '../collectors/git/index.js'
import { tmuxCollector } from '../collectors/tmux/index.js'
import { createWorkmuxCollector } from '../collectors/workmux/index.js'

/**
 * Registers the three collectors via static imports, so Vite/Rollup can
 * bundle them (a variable dynamic import like `import(\`./${slug}\`)` cannot be
 * statically analysed and fails at runtime). A collector whose binary is
 * missing (no tmux, no workmux) still loads fine here — it degrades to
 * `collector.disabled` at poll time, which is the collector's job, not this
 * one's.
 */
export async function loadCollectors(
  _log: { warn: (msg: string) => void } = console,
): Promise<AnyCollector[]> {
  return [gitCollector, tmuxCollector, createWorkmuxCollector()]
}
