import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * "A LIBRARY, NOT A SECOND OVERVIEW" (prd16 ruling 4, item 5) — the
 * dashboard-IA spike's warning was against a second surface competing to
 * answer "what is happening now"; `/recordings` answers "what did we
 * record", which nothing else does, and must stay that. Not a property a
 * rendered-output test can hold onto (a component added tomorrow that pulls
 * in the fleet would pass every behavioural test and still be the second
 * overview the ruling forbids) — same tactic `drawer/readonly.test.ts` and
 * `panels/ledger/no-panel-refolds.test.ts` use: grep the source directly.
 */

const RECORDINGS_DIR = path.dirname(fileURLToPath(import.meta.url))

const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /\buseFleet\b/,
  /\bFleetProvider\b/,
  /\bbuildFleet\b/,
  /from ['"]\.\.\/panels\//,
  /from ['"]\.\.\/scene\//,
  // No re-fold of the whole log either — this page reads `/api/sessions`'s
  // already-computed listing (`log/listing.ts`), never the raw log itself.
  /\breduceAll\(/,
]

function sourceFiles(): { name: string; text: string }[] {
  return readdirSync(RECORDINGS_DIR)
    .filter((name) => /\.(ts|tsx)$/.test(name))
    .filter((name) => !/\.test\.tsx?$/.test(name))
    .map((name) => ({ name, text: readFileSync(path.join(RECORDINGS_DIR, name), 'utf8') }))
}

describe('the recordings library renders no live-fleet surface (prd16 ruling 4, item 5)', () => {
  it('has source files to check at all — an empty walk proves nothing', () => {
    expect(sourceFiles().length).toBeGreaterThan(3)
  })

  it('imports no fleet/panel/scene machinery, and folds nothing itself', () => {
    for (const file of sourceFiles()) {
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(file.text, `${file.name} matches forbidden pattern ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  it('the detector bites — a fleet import added tomorrow would be caught', () => {
    expect(FORBIDDEN_PATTERNS.some((pattern) => pattern.test("import { useFleet } from '../fleet/index.js'"))).toBe(
      true,
    )
    expect(
      FORBIDDEN_PATTERNS.some((pattern) => pattern.test("import { costCellText } from '../panels/fleet/format.js'")),
    ).toBe(true)
  })
})
