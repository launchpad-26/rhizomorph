import type { VersionPinningExemption } from './types.js'

/**
 * `<harness>[-<word>...]-<major>.<minor>.<patch>-...` — prd-26 ruling 3's
 * pin, "as claude's fixtures are". Matches `claude-code-2.1.222-tail-*.jsonl`
 * and `claude-code-2.1.220-traces-*.json`; does not match a bare
 * `metrics-*.json` or `logs-*.json` with no version segment at all.
 */
const VERSION_PIN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d+\.\d+\.\d+-/i

export function isVersionPinned(fixtureName: string): boolean {
  return VERSION_PIN_PATTERN.test(fixtureName)
}

/** Every fixture name that is neither pinned nor named in `exemptions`. */
export function findUnpinnedFixtures(
  fixtureNames: readonly string[],
  exemptions: readonly VersionPinningExemption[] = [],
): string[] {
  const exempt = new Set(exemptions.map((exemption) => exemption.name))
  return fixtureNames.filter((name) => !exempt.has(name) && !isVersionPinned(name))
}
