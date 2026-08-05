import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE LAB RENDERS NO LIVE FLEET STATE (prd14 direction; prd12 ruling 1) —
 * the constitutional reason this tab may exist at all: the lab shows forked
 * realities only. Without this law the lab tab could quietly grow into a
 * second read of live fleet state, which is exactly the "second overview"
 * the dashboard-IA spike warned against (prd14's own framing) — a warning
 * this tab is otherwise exempt from because it is a different MODE, not a
 * second view of the same data.
 *
 * Same tactic `recordings/no-live-fleet-law.test.ts` (#206) uses and this
 * module is modeled on directly: grep the source, because a component added
 * tomorrow that pulls in the fleet would pass every behavioural test and
 * still be the thing this law forbids.
 */

const LAB_DIR = path.dirname(fileURLToPath(import.meta.url))

const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /\buseFleet\b/,
  /\bFleetProvider\b/,
  /\bbuildFleet\b/,
  /from ['"]\.\.\/fleet\//,
  /from ['"]\.\.\/panels\//,
  /from ['"]\.\.\/scene\//,
  // No re-fold of the whole log either — the lab tab reads its own two
  // read-only routes (`/api/lab/checkpoints`, `/api/lab/experiments`), never
  // the raw event log itself.
  /\breduceAll\(/,
]

function sourceFiles(): { name: string; text: string }[] {
  return readdirSync(LAB_DIR)
    .filter((name) => /\.(ts|tsx)$/.test(name))
    .filter((name) => !/\.test\.tsx?$/.test(name))
    .map((name) => ({ name, text: readFileSync(path.join(LAB_DIR, name), 'utf8') }))
}

describe('the lab tab renders no live-fleet surface (prd14)', () => {
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
