import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractImportSpecifiers } from '../test/import-specifiers.js'

/**
 * THE INSTRUMENT PATH IS REACHABLE ONLY FROM AN EXPLICIT REQUEST (prd-20
 * ruling 6's "invoked only by the same explicit human act that requests the
 * resume — never a collector, never a poll, never a timer"; ADR-0020 grant 4;
 * prd-14 ruling 4's one-confirmation bar, since this spawns a process).
 *
 * Same tactic `lab/launch/explicit-invocation-law.test.ts` uses, and the same
 * reason: a `useEffect` or a timer added tomorrow would pass every behavioural
 * test in `InstrumentButton.test.tsx` and still be exactly the thing the
 * ruling forbids — a relaunch that fires, and a transcript that gets copied,
 * without a human clicking "instrument". `replay/mutating-calls-law.test.ts`
 * enumerates this module as the app's fourth mutating call and cites THIS file
 * for the structural half of that argument, so what is asserted below is what
 * that enumeration is standing on.
 *
 * **The walk is the sibling law's recursive shape, defined here rather than
 * imported** — vitest re-executes a test module's top-level code, `describe`
 * blocks included, every time another test file imports it, so importing the
 * sibling's walker would report its whole suite a second time nested under
 * this one. One walk *shape*, defined twice, is the established trade in this
 * repo (see the sibling law's own file doc); the import *extraction* is
 * genuinely shared (`test/import-specifiers.ts`), because a plain module with
 * no `describe` blocks carries no such cost.
 */

const CONCIERGE_DIR = path.dirname(fileURLToPath(import.meta.url))

interface ConciergeSourceFile {
  readonly name: string
  readonly text: string
}

function sourceFiles(): ConciergeSourceFile[] {
  const out: ConciergeSourceFile[] = []
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
      out.push({ name: path.relative(CONCIERGE_DIR, full), text: readFileSync(full, 'utf8') })
    }
  }
  visit(CONCIERGE_DIR)
  return out
}

const SCHEDULING_RE = /\b(setInterval|setTimeout|setImmediate)\s*\(/
const CALLS_REQUEST_INSTRUMENT_RE = /\brequestInstrument\s*\(/
const USE_EFFECT_RE = /\buseEffect\s*\(/

const FORBIDDEN_IDENTIFIERS: readonly RegExp[] = [
  /\buseFleet\b/,
  /\bFleetProvider\b/,
  /\bbuildFleet\b/,
  /\breduceAll\(/,
]

/**
 * Import prefixes forbidden anywhere under `concierge/`, tested against every
 * specifier `extractImportSpecifiers` finds — so a bare side-effect import, a
 * dynamic `import('…')` and a template-literal specifier are exactly as
 * visible as a static `… from '…'` (the sibling law's own PR #301 lesson).
 *
 * `lab/` joins the sibling's three: the concierge is the front door, not the
 * laboratory, and a hand that spawns the operator's own conductor has no
 * business reaching into the experiment machinery that dispatches forks.
 * `(?:\.\.\/)+` — one or more hops, not a pinned depth — because pinning to
 * the depth today's flat directory happens to have is the drift the sibling
 * law's 2026-08-08 audit flagged.
 */
const FORBIDDEN_IMPORT_PREFIXES: readonly RegExp[] = [
  /^(?:\.\.\/)+fleet\//,
  /^(?:\.\.\/)+panels\//,
  /^(?:\.\.\/)+scene\//,
  /^(?:\.\.\/)+lab\//,
]

function forbiddenImportsIn(text: string): string[] {
  return extractImportSpecifiers(text).filter((specifier) =>
    FORBIDDEN_IMPORT_PREFIXES.some((prefix) => prefix.test(specifier)),
  )
}

/**
 * Specifiers no prefix check can vouch for — `${…}` anywhere means the path is
 * computed at runtime and could land in any of the directories above without
 * matching a single prefix.
 */
function computedImportsIn(text: string): string[] {
  return extractImportSpecifiers(text).filter((specifier) => specifier.includes('${'))
}

describe('the concierge instrument path is reachable only from an explicit request (prd-20 ruling 6; ADR-0020 grant 4)', () => {
  it('has source files to check at all — an empty walk proves nothing', () => {
    const names = sourceFiles().map((file) => file.name)
    // Today's two, named rather than counted loosely: a silently dropped file
    // fails here as loudly as an empty directory would.
    expect(names).toContain('instrument.ts')
    expect(names).toContain('InstrumentButton.tsx')
    expect(names.length).toBeGreaterThanOrEqual(2)
  })

  it('nothing under concierge/ has a clock of its own — a relaunch never fires without an incoming click', () => {
    for (const file of sourceFiles()) {
      expect(file.text, `${file.name} matches a scheduling call`).not.toMatch(SCHEDULING_RE)
    }
  })

  it('that detector bites — a scheduled relaunch would be caught', () => {
    expect(SCHEDULING_RE.test('setInterval(() => requestInstrument(x), 1000)')).toBe(true)
  })

  it('requestInstrument is invoked from exactly one file — InstrumentButton.tsx — never a second, unreviewed call site', () => {
    const callers = sourceFiles()
      .filter((file) => file.name !== 'instrument.ts')
      .filter((file) => CALLS_REQUEST_INSTRUMENT_RE.test(file.text))
      .map((file) => file.name)
    expect(callers).toEqual(['InstrumentButton.tsx'])
  })

  it("the one call site is wired to the confirm button's onClick, not left implicit", () => {
    const button = readFileSync(path.join(CONCIERGE_DIR, 'InstrumentButton.tsx'), 'utf8')
    expect(button).toMatch(/onClick=\{\(\)\s*=>\s*void confirmInstrument\(\)\}/)
  })

  /**
   * Stricter than the sibling law's, deliberately. `LaunchPanel.tsx` has reads
   * of its own to make on mount (checkpoints), so its law can only forbid an
   * effect that *calls the launch*. Nothing under `concierge/` reads anything
   * — the whole directory is one act and its confirmation — so the ban is
   * total: an effect here could only ever be reaching for the act, and there
   * is no legitimate shape of it to carve an exception for.
   */
  it('no useEffect anywhere under concierge/ — this directory acts, it never watches', () => {
    for (const file of sourceFiles()) {
      expect(file.text, `${file.name} declares an effect`).not.toMatch(USE_EFFECT_RE)
    }
    expect(USE_EFFECT_RE.test('useEffect(() => { void confirmInstrument() }, [])')).toBe(true)
  })

  it('imports no fleet/panel/scene/lab machinery — this is the front door, never a second read of live fleet state', () => {
    for (const file of sourceFiles()) {
      for (const pattern of FORBIDDEN_IDENTIFIERS) {
        expect(file.text, `${file.name} matches forbidden pattern ${pattern}`).not.toMatch(pattern)
      }
      expect(
        forbiddenImportsIn(file.text),
        `${file.name} imports fleet/panel/scene/lab machinery`,
      ).toEqual([])
    }
  })

  it('no computed import specifier under concierge/ — an interpolation ahead of the path would defeat every prefix check in this law', () => {
    for (const file of sourceFiles()) {
      expect(
        computedImportsIn(file.text),
        `${file.name} builds a computed import specifier — no prefix check in this law can vouch for where it lands; name the target statically, or amend this law with a ruling`,
      ).toEqual([])
    }
  })

  it('the detector bites — a forbidden import added tomorrow, at any depth and in any form, would be caught by the path alone', () => {
    // No forbidden identifier in these probes — only deep import paths — so a
    // pass here is the specifier check catching them, not an identifier riding
    // along for free. Rows 2-4 carry no `from` clause at all (bare, dynamic
    // and template-literal), and the last rows are the legal spellings a
    // `\s+`-based matcher was found blind to: no separator, comment trivia.
    const probes: ReadonlyArray<[string, string[]]> = [
      ["import type { FetchLike } from '../fleet/manifest.js'", ['../fleet/manifest.js']],
      ["import '../fleet/manifest.js'", ['../fleet/manifest.js']],
      ["const manifest = await import('../../fleet/manifest.js')", ['../../fleet/manifest.js']],
      ['const paint = await import(`../scene/paint.js`)', ['../scene/paint.js']],
      ["import '../panels/fleet/format.js'", ['../panels/fleet/format.js']],
      ["import { requestLaunch } from '../lab/launch/launch.js'", ['../lab/launch/launch.js']],
      ["import'../fleet/manifest.js'", ['../fleet/manifest.js']],
      ["const manifest = await import(/* @vite-ignore */ '../fleet/manifest.js')", ['../fleet/manifest.js']],
    ]
    for (const [probe, expected] of probes) {
      expect(forbiddenImportsIn(probe), probe).toEqual(expected)
    }
    // …and the imports this directory legitimately makes are not caught, so
    // the law is refusing a named set rather than everything with a `../`.
    expect(forbiddenImportsIn("import { readCapabilityToken } from '../recordings/capability.js'")).toEqual([])
    expect(forbiddenImportsIn("import { copyToClipboard } from '../drawer/AttachButton.js'")).toEqual([])
  })

  it('the computed detector bites — an interpolation ahead of the policed segment cannot hide behind the prefix checks', () => {
    expect(forbiddenImportsIn('await import(`${base}/fleet/manifest.js`)')).toEqual([])
    expect(computedImportsIn('await import(`${base}/fleet/manifest.js`)')).toEqual(['${base}/fleet/manifest.js'])
  })
})
