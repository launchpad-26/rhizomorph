import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractImportSpecifiers } from '../../test/import-specifiers.js'

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

const FORBIDDEN_IDENTIFIERS: readonly RegExp[] = [
  /\buseFleet\b/,
  /\bFleetProvider\b/,
  /\bbuildFleet\b/,
  /\breduceAll\(/,
]

/**
 * Import prefixes forbidden anywhere under lab/launch/, tested against
 * every specifier `extractImportSpecifiers` (the shared extraction in
 * `test/import-specifiers.ts`) finds — so a bare side-effect import, a
 * dynamic `import('…')` and a template-literal specifier are exactly as
 * visible as a static `… from '…'` (PR #301 review: the previous
 * `from ['"]…` patterns saw the static form only). `(?:\.\.\/)+`, one or
 * more hops, matches the sibling law's own prefixes — `lab/launch/` is flat
 * today, so `../../…` is the only depth an import here could actually be
 * written at, but pinning to that exact depth was itself part of the drift
 * the audit flagged (finding #2): a copy that only happens to work because
 * of a fact about today's tree.
 */
const FORBIDDEN_IMPORT_PREFIXES: readonly RegExp[] = [
  /^(?:\.\.\/)+fleet\//,
  /^(?:\.\.\/)+panels\//,
  /^(?:\.\.\/)+scene\//,
]

function forbiddenImportsIn(text: string): string[] {
  return extractImportSpecifiers(text).filter((specifier) =>
    FORBIDDEN_IMPORT_PREFIXES.some((prefix) => prefix.test(specifier)),
  )
}

/**
 * Specifiers no prefix check can vouch for — `${…}` anywhere means the
 * path is computed at runtime and could land in fleet/, panels/ or scene/
 * without matching any prefix above (c77c2ee verify pass). Same check as
 * the sibling law's; kept per-file for the same no-test-imports reason as
 * the walker.
 */
function computedImportsIn(text: string): string[] {
  return extractImportSpecifiers(text).filter((specifier) => specifier.includes('${'))
}

describe("the lab launch path is reachable only from an explicit request (prd12 ruling 1's UI-button exception)", () => {
  it('has source files to check at all — an empty walk proves nothing', () => {
    // 3 real files, re-derived from this file's own sourceFiles() on
    // 2026-09-07 (still estimate.ts, LaunchPanel.tsx, launch.ts — unchanged
    // since the 2026-08-08 audit) — pinned to today's count, not a loose
    // lower bound, so a file silently dropped OR silently added both fail
    // loudly here (a >= assertion only catches the former).
    expect(sourceFiles().length).toBe(3)
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

  /**
   * **The `scene/` prefix is a blanket ban, not the sibling law's named
   * exception, and that's deliberate, not a leftover.** `no-live-fleet-
   * law.test.ts` is the ruling for `scene/` across all of `lab/`, launch/
   * included — its own recursive walk already asserts `scene/palette.js` in
   * `branching/geometry.ts` is the *only* `scene/` import anywhere in the
   * tree, which already forbids one existing in `launch/` too. This file's
   * blanket ban is a second, redundant, and stricter check specific to this
   * one directory: `launch/` has no `branching/`-shaped reason to reach into
   * `scene/` at all, so unlike the sibling law it carves out no exception —
   * for `launch/` specifically, either law catches a scene import, but only
   * this one refuses to ever carve out a name for one.
   */
  it('imports no fleet/panel/scene machinery — this is the lab console, never a second read of live fleet state', () => {
    for (const file of sourceFiles()) {
      for (const pattern of FORBIDDEN_IDENTIFIERS) {
        expect(file.text, `${file.name} matches forbidden pattern ${pattern}`).not.toMatch(pattern)
      }
      expect(
        forbiddenImportsIn(file.text),
        `${file.name} imports fleet/panel/scene machinery`,
      ).toEqual([])
    }
  })

  it('no computed import specifier under lab/launch/ — an interpolation ahead of the path would defeat every prefix check in this law', () => {
    for (const file of sourceFiles()) {
      expect(
        computedImportsIn(file.text),
        `${file.name} builds a computed import specifier — no prefix check in this law can vouch for where it lands; name the target statically, or amend this law with a ruling`,
      ).toEqual([])
    }
  })

  it('the detector bites — a fleet import added tomorrow, at any depth and in any form, would be caught by the path alone, not just a named identifier', () => {
    // No forbidden identifier in these probes — only deep import paths — so
    // a pass here is the specifier check catching them, not an identifier
    // riding along for free. Rows 2-4 carry no `from` clause at all (bare,
    // dynamic and template-literal — PR #301 review); the panels/ row makes
    // that prefix independently load-bearing (dropping it stayed green in
    // the c77c2ee verify pass), and the last rows are the legal spellings
    // that pass found still blind: no separator, comment trivia. Expected
    // arrays are pinned exactly, not merely non-empty.
    const probes: ReadonlyArray<[string, string[]]> = [
      ["import type { FetchLike } from '../../fleet/manifest.js'", ['../../fleet/manifest.js']],
      ["import '../../fleet/manifest.js'", ['../../fleet/manifest.js']],
      ["const manifest = await import('../../fleet/manifest.js')", ['../../fleet/manifest.js']],
      ['const paint = await import(`../../scene/paint.js`)', ['../../scene/paint.js']],
      ["import '../../panels/fleet/format.js'", ['../../panels/fleet/format.js']],
      ["import'../../fleet/manifest.js'", ['../../fleet/manifest.js']],
      ["const manifest = await import(/* @vite-ignore */ '../../fleet/manifest.js')", ['../../fleet/manifest.js']],
    ]
    for (const [probe, expected] of probes) {
      expect(forbiddenImportsIn(probe), probe).toEqual(expected)
    }
  })

  it('the computed detector bites — an interpolation ahead of the policed segment cannot hide behind the prefix checks', () => {
    expect(forbiddenImportsIn('await import(`${base}/fleet/manifest.js`)')).toEqual([])
    expect(computedImportsIn('await import(`${base}/fleet/manifest.js`)')).toEqual(['${base}/fleet/manifest.js'])
  })
})
