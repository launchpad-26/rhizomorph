import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractImportSpecifiers } from '../test/import-specifiers.js'

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
 *
 * **The walk is recursive** (2026-08-08 audit finding #2) — a flat
 * `readdirSync(LAB_DIR)` saw 5 of `lab/`'s 17 source files, missing
 * `branching/`, `compare/` and `launch/` entirely, and the floor
 * (`toBeGreaterThan(3)`) passed vacuously on the 5 it could see. `visit()`
 * here reuses the shape `replay/mutating-calls-law.test.ts:71-88` proves out
 * for exactly this reason. `explicit-invocation-law.test.ts` — the sibling
 * law for `lab/launch/` — carries the identical recursive shape rather than
 * its old drifted two-level copy; it does not import this file's walker,
 * because a test file importing another test file makes vitest re-run the
 * imported file's `describe` blocks nested under the importer too (verified
 * empirically), which would double-report this law's suite. Its own file
 * comment explains that in full.
 *
 * **`scene/palette.js` is a named, positive exception, not a hole in the
 * forbidden-pattern list.** `branching/geometry.ts` imports it deliberately
 * (its own doc: "reused as-is… and nothing in `packages/web/src/scene/` is
 * edited to make room for it") while `LabPage.tsx:125` says the tab "may
 * never" import from `scene/` — two readings that only a ruling resolves.
 * The ruling, landed here: the palette import stays, named by path, and the
 * law asserts it is the *only* `scene/` import anywhere in `lab/` — a second
 * one, anywhere, at any depth, fails. This trades one named exception for
 * net coverage across all 17 files, up from a blanket pattern that covered
 * none of the tree it claimed to.
 *
 * **`compare/` was checked against these patterns before this amendment was
 * committed** (audit finding #1's own condition) — clean: no `useFleet`,
 * `FleetProvider`, `buildFleet`, `../fleet/`, `../panels/`, `../scene/` or
 * `reduceAll(` anywhere under it.
 */

const LAB_DIR = path.dirname(fileURLToPath(import.meta.url))

const FORBIDDEN_IDENTIFIERS: readonly RegExp[] = [
  /\buseFleet\b/,
  /\bFleetProvider\b/,
  /\bbuildFleet\b/,
  // No re-fold of the whole log either — the lab tab reads its own two
  // read-only routes (`/api/lab/checkpoints`, `/api/lab/experiments`), never
  // the raw event log itself.
  /\breduceAll\(/,
]

/**
 * Import prefixes forbidden anywhere in lab/, tested against every
 * specifier `extractImportSpecifiers` finds — so a bare side-effect import,
 * a dynamic `import('…')` and a template-literal specifier are exactly as
 * visible as a static `… from '…'` (PR #301 review: the previous
 * `from ['"]…` patterns saw the static form only, so
 * `await import('../../fleet/manifest.js')` evaded the law). The shared
 * extraction lives in `test/import-specifiers.ts` — a plain module, so
 * importing it here has none of the suite-re-running cost that keeps the
 * walkers duplicated (see the file doc above).
 *
 * Depth-independent: the walk sees this import written as `../fleet/…` from
 * lab/'s root and `../../fleet/…` from lab/branching/, lab/compare/ or
 * lab/launch/ — one or more `../` segments, either way.
 */
const FORBIDDEN_IMPORT_PREFIXES: readonly RegExp[] = [
  /^(?:\.\.\/)+fleet\//,
  /^(?:\.\.\/)+panels\//,
]

function forbiddenImportsIn(text: string): string[] {
  return extractImportSpecifiers(text).filter((specifier) =>
    FORBIDDEN_IMPORT_PREFIXES.some((prefix) => prefix.test(specifier)),
  )
}

/**
 * Specifiers no prefix check can vouch for: `${…}` anywhere in a dynamic
 * import's template means the path is computed at runtime —
 * `` import(`${base}/fleet/manifest.js`) `` starts with no `../` and
 * matches no forbidden prefix, yet reaches wherever `base` points (c77c2ee
 * verify pass). The law below forbids the form outright rather than
 * pretending a prefix check saw it.
 */
function computedImportsIn(text: string): string[] {
  return extractImportSpecifiers(text).filter((specifier) => specifier.includes('${'))
}

/**
 * Any import reaching into `scene/`, at any depth — governed separately
 * below, by name, not by blanket forbid. Built on the same shared
 * extraction, so every form a scene import could take is visible: static
 * `… from '…'`/`export … from '…'`, a bare side-effect import
 * (`import '../../scene/x.js'`, no `from` at all), a dynamic one
 * (`import('../../scene/x.js')`), and a template-literal specifier
 * (``import(`../../scene/x.js`)``, which the old quoted-only regex missed —
 * PR #301 review). This is load-bearing: the blanket `scene/` forbid has
 * been replaced by a named, positive exception, and a form the detector
 * can't see is a form the exception can't be checked against.
 */
function sceneImportsIn(text: string): string[] {
  return extractImportSpecifiers(text).filter((specifier) => /^(?:\.\.\/)+scene\//.test(specifier))
}

/**
 * The named exceptions — every one of them the PALETTE, by path. `branching/geometry.ts`
 * (its own doc: reused as-is, never forked); and, from prd53 wave 4 (#329), `canvas/organism.ts`,
 * the lane canvas: n small organisms drawn in the lab's own SVG that read the scene's inks
 * through its public exports and never its fold (charter §8, coexist-by-surface). A third
 * importer, or any import of anything under `scene/` but the palette, fails here by name.
 */
const ALLOWED_SCENE_IMPORTS = [
  { file: path.join('branching', 'geometry.ts'), importPath: '../../scene/palette.js' },
  { file: path.join('canvas', 'organism.ts'), importPath: '../../scene/palette.js' },
]

interface LabSourceFile {
  readonly name: string
  readonly text: string
}

/**
 * Recursive walk, reusing the `visit()` shape `replay/mutating-calls-law.test.ts:71-88`
 * proves out. `name` is relative to `root`, so it stays readable (e.g.
 * `branching/geometry.ts`) no matter how deep the file sits.
 */
function walkSourceFiles(dir: string, root: string = dir): LabSourceFile[] {
  const out: LabSourceFile[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...walkSourceFiles(full, root))
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue
    if (/\.test\.tsx?$/.test(entry)) continue
    out.push({ name: path.relative(root, full), text: readFileSync(full, 'utf8') })
  }
  return out
}

function sourceFiles(): LabSourceFile[] {
  return walkSourceFiles(LAB_DIR)
}

describe('the lab tab renders no live-fleet surface (prd14)', () => {
  it('has source files to check at all, from every governed subdirectory — a shallow walk proves nothing', () => {
    // 17 real files as of the 2026-08-08 audit (5 at the root, 2 in
    // branching/, 7 in compare/, 3 in launch/) — pinned exactly, not a loose
    // lower bound: headroom here would defeat the point. A shallow walk
    // dropping just branching/ (2 files) would still clear a >=15 floor, so
    // any slack would silently forgive exactly the defect this law amends.
    // The next test also names each subdirectory explicitly, so a loss is
    // caught twice over — by count here, and by name there.
    expect(sourceFiles().length).toBeGreaterThanOrEqual(17)
  })

  it('the walk reaches every subdirectory, not just the ones a shallow readdirSync used to see', () => {
    const names = sourceFiles().map((file) => file.name)
    expect(names).toContain(path.join('branching', 'geometry.ts'))
    expect(names).toContain(path.join('compare', 'compare.ts'))
    expect(names).toContain(path.join('launch', 'launch.ts'))
  })

  it('imports no fleet/panel machinery, and folds nothing itself', () => {
    for (const file of sourceFiles()) {
      for (const pattern of FORBIDDEN_IDENTIFIERS) {
        expect(file.text, `${file.name} matches forbidden pattern ${pattern}`).not.toMatch(pattern)
      }
      expect(
        forbiddenImportsIn(file.text),
        `${file.name} imports fleet/ or panels/ machinery`,
      ).toEqual([])
    }
  })

  it('scene/palette.js is the only scene/ import anywhere in lab/, and exactly two files make it, named and positive', () => {
    const sceneImports = sourceFiles().flatMap((file) =>
      sceneImportsIn(file.text).map((importPath) => ({ file: file.name, importPath })),
    )
    const byFile = (a: { file: string }, b: { file: string }) => a.file.localeCompare(b.file)
    expect([...sceneImports].sort(byFile)).toEqual([...ALLOWED_SCENE_IMPORTS].sort(byFile))
  })

  it('no computed import specifier anywhere in lab/ — an interpolation ahead of the path would defeat every prefix check in this law', () => {
    for (const file of sourceFiles()) {
      expect(
        computedImportsIn(file.text),
        `${file.name} builds a computed import specifier — no prefix check in this law can vouch for where it lands; name the target statically, or amend this law with a ruling`,
      ).toEqual([])
    }
  })

  it('the detector bites — a fleet/panel import added tomorrow, at any depth and in any form, would be caught by the path alone, not just a named identifier', () => {
    // No `useFleet`/`FleetProvider`/`buildFleet`/`reduceAll(` anywhere in
    // these probes — if they pass, it is the depth-independent specifier
    // check catching them, not a forbidden identifier riding along for
    // free. Rows 4-6 carry no `from` clause at all (bare, dynamic and
    // template-literal forms, the ones a from-only pattern could not see —
    // PR #301 review); the rest are the legal spellings the c77c2ee verify
    // pass found still blind: no separator, comment trivia, double quotes.
    // Expected arrays are pinned exactly — `.not.toEqual([])` would let a
    // truncated-but-matching extraction pass.
    const probes: ReadonlyArray<[string, string[]]> = [
      ["import type { FetchLike } from '../fleet/manifest.js'", ['../fleet/manifest.js']],
      ["import type { FetchLike } from '../../fleet/manifest.js'", ['../../fleet/manifest.js']],
      ["import { costCellText } from '../../panels/fleet/format.js'", ['../../panels/fleet/format.js']],
      ["import '../../fleet/manifest.js'", ['../../fleet/manifest.js']],
      ["const manifest = await import('../../fleet/manifest.js')", ['../../fleet/manifest.js']],
      ['const manifest = await import(`../../panels/fleet/format.js`)', ['../../panels/fleet/format.js']],
      ["import'../../fleet/manifest.js'", ['../../fleet/manifest.js']],
      ["import /* preload */ '../../fleet/manifest.js'", ['../../fleet/manifest.js']],
      ["const manifest = await import(/* @vite-ignore */ '../../fleet/manifest.js')", ['../../fleet/manifest.js']],
      ['import "../../fleet/manifest.js"', ['../../fleet/manifest.js']],
      ['const manifest = await import("../../fleet/manifest.js")', ['../../fleet/manifest.js']],
    ]
    for (const [probe, expected] of probes) {
      expect(forbiddenImportsIn(probe), probe).toEqual(expected)
    }
  })

  it('the computed detector bites — an interpolation ahead of the policed segment cannot hide behind the prefix checks', () => {
    // The first line is the escape itself: no forbidden prefix matches, so
    // without the computed law this import would sail through green.
    expect(forbiddenImportsIn('await import(`${base}/fleet/manifest.js`)')).toEqual([])
    expect(computedImportsIn('await import(`${base}/fleet/manifest.js`)')).toEqual(['${base}/fleet/manifest.js'])
    expect(computedImportsIn('await import(`../../${dir}/manifest.js`)')).toEqual(['../../${dir}/manifest.js'])
  })

  it('the scene detector bites — a second scene/ import, anywhere, would be caught', () => {
    expect(sceneImportsIn("import { cssColour } from '../scene/paint.js'")).toEqual(['../scene/paint.js'])
  })

  it('the scene detector bites on the forms that carry no `from` — bare, dynamic, and template-literal specifiers', () => {
    expect(sceneImportsIn("import '../../scene/reset.css.js'")).toEqual(['../../scene/reset.css.js'])
    expect(sceneImportsIn("const mod = await import('../../scene/lazy.js')")).toEqual(['../../scene/lazy.js'])
    expect(sceneImportsIn('const mod = await import(`../../scene/paint.js`)')).toEqual(['../../scene/paint.js'])
  })

  it('the scene detector does not read prose as code — a backticked path after `from` in a doc comment is not an import', () => {
    // `from `…`` is a syntax error in JS, so a backtick there can only be
    // markdown — and LabPage.tsx:125's own doc comment is exactly this
    // sentence. Template literals are specifiers only inside `import(…)`.
    expect(sceneImportsIn('rather than importing `cssColour` from `../scene/`, which this tab may never do')).toEqual(
      [],
    )
  })
})
