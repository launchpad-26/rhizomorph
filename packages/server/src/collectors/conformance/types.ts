import type { AdapterCapabilities, SignalObservations } from '@rhizomorph/core'

/**
 * One fixture's exemption from prd-26 ruling 3's version-pinning law, named
 * and reasoned rather than silently skipped — issue #319's own instruction:
 * "if the suite would fail its own reference on that rule, state the
 * exemption explicitly in code rather than quietly not checking it."
 */
export interface VersionPinningExemption {
  name: string
  reason: string
}

/**
 * What the shared conformance suite (prd-15 ruling 4) needs from any organ —
 * a `Collector` proper (`sessionlog`) or routes-plus-parsers (`otel`, per its
 * `capabilities.ts` header comment: no `poll()` to hang capabilities off)
 * both implement this the same way: run your own real code over your own
 * real fixtures and hand back what you actually saw. Never a self-report —
 * `observe()`'s whole job is closing ADR-0010's hole ("declaration is not
 * verification").
 */
export interface ConformanceOrgan {
  name: string
  capabilities: AdapterCapabilities
  observe(): Promise<SignalObservations> | SignalObservations
  /** Every fixture filename on disk, for the version-pinning law. */
  fixtureNames(): Promise<readonly string[]> | readonly string[]
  /** Named, reasoned exemptions from that law — omit or `[]` for an organ with none. */
  versionPinningExemptions?: readonly VersionPinningExemption[]
}
