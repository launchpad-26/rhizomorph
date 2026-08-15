import { findUnbackedProvidedSignals } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import type { ConformanceOrgan } from './types.js'
import { findUnpinnedFixtures } from './version-pinning.js'

/**
 * How the suite registers its cases: `it` for a real organ, `it.fails` for
 * `suite.test.ts`'s deliberately-lying organ — the witness that keeps these
 * assertions themselves load-bearing (review of #319, finding 1: with the
 * `expect` below deleted, conformance ran 21/21 green and the full repo
 * 4069/4069, executed three times).
 */
export type SuiteRegistrar = (name: string, fn: () => Promise<void>) => void

/**
 * The shared conformance suite prd-15 ruling 4 names. Every organ that
 * implements {@link ConformanceOrgan} answers to the same two laws —
 * ADR-0010's declared-vs-emitted check and prd-26 ruling 3's version-pinning
 * discipline — through the same function, not a bespoke copy per collector.
 * `sessionlog` and `otel` run against this first, as the reference (#319): if
 * it cannot describe the two organs the repo already has, it cannot describe
 * a third.
 */
export function runConformanceSuite(organ: ConformanceOrgan, register: SuiteRegistrar = it): void {
  describe(`conformance suite: ${organ.name}`, () => {
    register('declares no signal "provided" beyond what its own fixtures demonstrably emit (ADR-0010)', async () => {
      const observed = await organ.observe()
      expect(findUnbackedProvidedSignals(organ.capabilities, observed)).toEqual([])
    })

    register("every fixture filename is version-pinned, as claude's fixtures are (prd-26 ruling 3), except a named exemption", async () => {
      const names = await organ.fixtureNames()
      expect(findUnpinnedFixtures(names, organ.versionPinningExemptions)).toEqual([])
    })

    register('names no version-pinning exemption for a fixture that no longer exists (#459)', async () => {
      // The exemption lists are a one-way ratchet; this is the pawl. A
      // renamed or deleted exempt fixture must take its entry with it, or the
      // dormant entry silently pre-authorises the next unpinned file to take
      // that name.
      const names = new Set(await organ.fixtureNames())
      const stale = (organ.versionPinningExemptions ?? []).filter((exemption) => !names.has(exemption.name)).map((exemption) => exemption.name)
      expect(stale).toEqual([])
    })
  })
}
