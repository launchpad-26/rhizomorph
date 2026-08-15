import { SIGNALS, type AdapterCapabilities } from '@rhizomorph/core'
import { it } from 'vitest'
import { observeEventSignals } from './signal-evidence.js'
import { runConformanceSuite } from './suite.js'
import type { ConformanceOrgan } from './types.js'

/**
 * The suite's own assertions are what every organ's conformance rests on, so
 * they need a witness of their own: an organ that breaks every law at once,
 * run through the real `runConformanceSuite`, registered with `it.fails`.
 * Delete any `expect` in `suite.ts` and the matching case here goes
 * green-where-red-was-promised, which `it.fails` reports as a failure —
 * previously that deletion survived the entire repo suite (review of #319,
 * finding 1, executed three times).
 *
 * If `runConformanceSuite` ever gains another law, this organ must break that
 * one too, or its `it.fails` case will fail for passing.
 */
const lyingOrgan: ConformanceOrgan = {
  name: 'synthetic organ that declares what it never emits',
  capabilities: Object.fromEntries(
    SIGNALS.map((signal) => [
      signal,
      signal === 'cost' ? { level: 'provided' } : { level: 'absent', reason: 'synthetic: this organ exists to be caught' },
    ]),
  ) as AdapterCapabilities,
  // No events at all, so the `provided` cost above is a lie by construction.
  observe: () => observeEventSignals([]),
  // Unpinned and unexempted, so the version-pinning law red-flags it too.
  fixtureNames: () => ['unpinned-fixture.json'],
  // Names a fixture that does not exist, so the stale-exemption law (#459)
  // red-flags it as well. (Deliberately NOT 'unpinned-fixture.json' — that
  // would satisfy law 3 and quietly exempt its way past law 2.)
  versionPinningExemptions: [{ name: 'ghost-fixture.json', reason: 'synthetic: stale by construction' }],
}

runConformanceSuite(lyingOrgan, it.fails)
