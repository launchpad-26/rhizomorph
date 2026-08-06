import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE LAUNCH PATH IS REACHABLE ONLY FROM AN EXPLICIT REQUEST (prd12 ruling 1's
 * "a UI button is an explicit human invocation and is permitted"; prd14's own
 * direction for this issue). Same tactic `no-live-fleet-law.test.ts` and
 * `namespace-law.test.ts` use throughout this codebase: grep the source,
 * because a `useEffect` or a timer added tomorrow would pass every
 * behavioural test in `LaunchPanel.test.tsx` and still be the thing this law
 * forbids — a launch that fires without a human clicking "launch".
 */

const LAUNCH_DIR = path.dirname(fileURLToPath(import.meta.url))

function sourceFiles(): { name: string; text: string }[] {
  return readdirSync(LAUNCH_DIR)
    .filter((name) => /\.(ts|tsx)$/.test(name))
    .filter((name) => !/\.test\.tsx?$/.test(name))
    .map((name) => ({ name, text: readFileSync(path.join(LAUNCH_DIR, name), 'utf8') }))
}

const SCHEDULING_RE = /\b(setInterval|setTimeout|setImmediate)\s*\(/
const CALLS_REQUEST_LAUNCH_RE = /\brequestLaunch\s*\(/

describe("the lab launch path is reachable only from an explicit request (prd12 ruling 1's UI-button exception)", () => {
  it('has source files to check at all — an empty walk proves nothing', () => {
    expect(sourceFiles().length).toBeGreaterThan(2)
  })

  it('nothing under lab/launch/ has a clock of its own — a launch never fires without an incoming click', () => {
    for (const file of sourceFiles()) {
      expect(file.text, `${file.name} matches a scheduling call`).not.toMatch(SCHEDULING_RE)
    }
  })

  it('that detector bites — a scheduled launch would be caught', () => {
    expect(SCHEDULING_RE.test('setInterval(() => requestLaunch(x), 1000)')).toBe(true)
  })

  it('requestLaunch is invoked from exactly one file — LaunchPanel.tsx — never a second, unreviewed call site', () => {
    const callers = sourceFiles()
      .filter((file) => file.name !== 'launch.ts')
      .filter((file) => CALLS_REQUEST_LAUNCH_RE.test(file.text))
      .map((file) => file.name)
    expect(callers).toEqual(['LaunchPanel.tsx'])
  })

  it('the one call site is wired to the confirm button\'s onClick, not left implicit', () => {
    const panel = readFileSync(path.join(LAUNCH_DIR, 'LaunchPanel.tsx'), 'utf8')
    expect(panel).toMatch(/onClick=\{\(\)\s*=>\s*void confirmLaunch\(\)\}/)
  })

  it('no useEffect in LaunchPanel.tsx ever calls the launch (or its confirm step) — reads happen there, writes never do', () => {
    const panel = readFileSync(path.join(LAUNCH_DIR, 'LaunchPanel.tsx'), 'utf8')
    const effectBodies = [...panel.matchAll(/useEffect\(([\s\S]*?), \[/g)].map((match) => match[1] ?? '')
    expect(effectBodies.length).toBeGreaterThan(0) // the check below would pass vacuously on an empty sweep
    for (const body of effectBodies) {
      expect(body).not.toMatch(/requestLaunch|confirmLaunch/)
    }
  })

  it('imports no fleet/panel/scene machinery — this is the lab console, never a second read of live fleet state', () => {
    const FORBIDDEN_PATTERNS: readonly RegExp[] = [
      /\buseFleet\b/,
      /\bFleetProvider\b/,
      /\bbuildFleet\b/,
      /from ['"]\.\.\/\.\.\/fleet\//,
      /from ['"]\.\.\/\.\.\/panels\//,
      /from ['"]\.\.\/\.\.\/scene\//,
      /\breduceAll\(/,
    ]
    for (const file of sourceFiles()) {
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(file.text, `${file.name} matches forbidden pattern ${pattern}`).not.toMatch(pattern)
      }
    }
  })
})
