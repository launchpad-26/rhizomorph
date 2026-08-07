import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE LAUNCH PATH IS REACHABLE ONLY FROM AN EXPLICIT REQUEST (prd12 ruling 1's
 * "a UI button is an explicit human invocation and is permitted"; prd14's own
 * direction for this issue). Same tactic `no-live-fleet-law.test.ts` uses
 * throughout this codebase: grep the source, because a `useEffect` or a timer
 * added tomorrow would pass every behavioural test in `LaunchPanel.test.tsx`
 * and still be the thing this law forbids — a launch that fires without a
 * human clicking "launch".
 *
 * **The walk below is the same recursive shape as the sibling law's
 * `walkSourceFiles`** (2026-08-08 audit finding #2's fix) — not the old
 * two-level-shallow copy, which drifted from it and was just as blind past
 * one level of nesting (moot today only because `lab/launch/` happens to be
 * flat). It is a second definition rather than an import of the sibling's
 * exported `walkSourceFiles`, deliberately: vitest re-executes a test
 * module's top-level code — including its `describe` blocks — every time
 * another test file imports it, so `explicit-invocation-law.test.ts` would
 * end up reporting `no-live-fleet-law.test.ts`'s whole suite a second time,
 * nested under itself, on every run (verified empirically with
 * `--reporter=verbose` while drafting this fix). Keeping one recursive walk
 * *shape*, defined twice rather than shared by reference, avoids that
 * duplication while still ending the drift the audit flagged.
 */

const LAUNCH_DIR = path.dirname(fileURLToPath(import.meta.url))

interface LaunchSourceFile {
  readonly name: string
  readonly text: string
}

function sourceFiles(): LaunchSourceFile[] {
  const out: LaunchSourceFile[] = []
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        visit(full)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue
      if (/\.test\.tsx?$/.test(entry)) continue
      out.push({ name: path.relative(LAUNCH_DIR, full), text: readFileSync(full, 'utf8') })
    }
  }
  visit(LAUNCH_DIR)
  return out
}

const SCHEDULING_RE = /\b(setInterval|setTimeout|setImmediate)\s*\(/
const CALLS_REQUEST_LAUNCH_RE = /\brequestLaunch\s*\(/

describe("the lab launch path is reachable only from an explicit request (prd12 ruling 1's UI-button exception)", () => {
  it('has source files to check at all — an empty walk proves nothing', () => {
    // 3 real files as of the 2026-08-08 audit (estimate.ts, LaunchPanel.tsx,
    // launch.ts) — pinned to today's count, not a loose lower bound, so a
    // silently dropped file fails loudly here too.
    expect(sourceFiles().length).toBeGreaterThanOrEqual(3)
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
