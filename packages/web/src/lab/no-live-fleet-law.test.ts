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
 * **prd-55 ruling 11 (#385) widens that exception from one module to six, and
 * not by one module more.** The lane canvas paints with the scene's PURE
 * brushes instead of being a second, lesser renderer, so `geometry`,
 * `palette`, `ribbon`, `contour`, `motes` and `heart` are named below and
 * everything else under `scene/` — the fold-bound `retire`, `salience`,
 * `variation`, `pulses`, `SceneView` above all — still fails. Two pins, not
 * one: the MODULE list (a seventh brush fails by its own name) and the
 * per-file PAIR list (a file not entitled to a brush fails even when the brush
 * is allowed).
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
 * THE SIX BRUSHES — prd-55 ruling 11's widening of this exception, and its
 * exact bound. Until #385 the exception was one MODULE (the palette) reached
 * by two files; ruling 11 makes the lane canvas a Canvas 2D drawing built from
 * the scene's PURE paint modules rather than a second, lesser renderer, so the
 * exception becomes **exactly six modules, named**:
 *
 * `geometry.ts` · `palette.ts` · `ribbon.ts` · `contour.ts` · `motes.ts` ·
 * `heart.ts`
 *
 * Each is a pure function of what it is handed and imports nothing from the
 * fold — which is the whole reason they may cross this line while
 * `scene/retire.ts`, `salience.ts`, `variation.ts`, `pulses.ts` and
 * `SceneView.tsx` may not: those read the fold, and anything under `fleet/` is
 * forbidden outright above. A SEVENTH module — or any other path under
 * `scene/`, at any depth — fails by name against this list, so the failure
 * names the module rather than handing back a diff of pairs.
 */
const ALLOWED_SCENE_MODULES: readonly string[] = [
  '../../scene/contour.js',
  '../../scene/geometry.js',
  '../../scene/heart.js',
  '../../scene/motes.js',
  '../../scene/palette.js',
  '../../scene/ribbon.js',
]

/** How many modules the exception may ever name. Pinned as a number, so widening it is a deliberate edit and not a list that quietly grew. */
const ALLOWED_SCENE_MODULE_COUNT = 6

/**
 * …and exactly the files that need them, by path. `branching/geometry.ts` (its
 * own doc: reused as-is, never forked); and, from prd53 wave 4 (#329) and
 * prd-55 wave 2 (#385), the lane canvas's three files — `canvas/organism.ts`
 * builds the picture with all six brushes, `canvas/paint.ts` executes it (the
 * palette's `cssColour`, geometry's `Point`), and `canvas/LaneCanvas.tsx`
 * reads the document's theme through `paletteFor`. A file not on this list
 * reaching for a brush fails here even though the module is allowed: the PAIR
 * is the pin, so "which of the lab's files may see the scene at all" stays a
 * question this law answers.
 */
const ALLOWED_SCENE_IMPORTS = [
  { file: path.join('branching', 'geometry.ts'), importPath: '../../scene/palette.js' },
  { file: path.join('canvas', 'LaneCanvas.tsx'), importPath: '../../scene/palette.js' },
  { file: path.join('canvas', 'organism.ts'), importPath: '../../scene/contour.js' },
  { file: path.join('canvas', 'organism.ts'), importPath: '../../scene/geometry.js' },
  { file: path.join('canvas', 'organism.ts'), importPath: '../../scene/heart.js' },
  { file: path.join('canvas', 'organism.ts'), importPath: '../../scene/motes.js' },
  { file: path.join('canvas', 'organism.ts'), importPath: '../../scene/palette.js' },
  { file: path.join('canvas', 'organism.ts'), importPath: '../../scene/ribbon.js' },
  { file: path.join('canvas', 'paint.ts'), importPath: '../../scene/geometry.js' },
  { file: path.join('canvas', 'paint.ts'), importPath: '../../scene/palette.js' },
]

/**
 * The fold-bound scene modules, by name — the half of ruling 11 a positive
 * list cannot state on its own. `ALLOWED_SCENE_MODULES` already fails a
 * seventh module, but it fails it as "not on the list"; these five are the
 * ones the ruling forbids for a REASON (they read the fold), and naming them
 * makes the failure say so.
 */
const FOLD_BOUND_SCENE_MODULES: readonly string[] = ['retire', 'salience', 'variation', 'pulses', 'SceneView']

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

/**
 * `sourceFiles()` grouped by immediate subdirectory, root-level files under the
 * EMPTY key. That key is not a readability choice, it is the only one that
 * cannot collide: `path.dirname()` returns `.` for a bare filename and a real
 * segment otherwise, so it never yields `''` for any input this walker
 * produces — while a printable sentinel is merely an unlikely directory name,
 * not an impossible one. A first version used `(root)` and claimed parentheses
 * were unusable in a path; they are legal on POSIX and Windows both, and a
 * directory named `(root)` merged into the same bucket as the real root, so a
 * file lost from the root while one appeared under the collision kept the law
 * GREEN — reintroducing, through the sentinel, the exact compensated shrink
 * this grouping exists to catch. A file nested deeper than one level lands
 * under its own compound key (`compare/deep`) rather than folding into its
 * parent, so a new depth reddens the count law instead of hiding inside it.
 */
function sourceFileCountsByDirectory(): Record<string, number> {
  // Object.create(null), not `{}`. A plain object literal INHERITS `__proto__`
  // as an accessor, so `counts['__proto__'] = 1` assigns through the setter and
  // creates no own enumerable key — a real source file under `lab/__proto__/`
  // then leaves this law green, which is the same hole the `(root)` sentinel
  // had one level down: the key was fixed, the container that receives it was
  // not. A null-prototype object has no such accessor, so every directory name
  // the walker can produce becomes an own key.
  const counts: Record<string, number> = Object.create(null)
  for (const file of sourceFiles()) {
    const dir = path.dirname(file.name)
    const key = dir === '.' ? '' : dir
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

describe('the lab tab renders no live-fleet surface (prd14)', () => {
  it('has source files to check at all, from every governed subdirectory — a shallow walk proves nothing', () => {
    // Per-subdirectory counts, re-derived from this file's own
    // sourceFiles() on 2026-09-08 — the root moved 5 -> 6 when prd53 wave 2
    // (#324, `8f7a60ec`) added `measure.ts`. The pin did not move with it and
    // `main` went red on the merge, staying red across three tips. It was a
    // clean merge, not a conflict: the per-directory ASSERTION below was
    // added to `main` by #235 (`b5de19ac`, 2026-09-07), after the prd53
    // branch forked, so no prd53 branch carries it and git had nothing to
    // warn anyone about. Check the assertion, not the file: this law FILE is
    // older (`2fe9a2ce`, 2026-08-06) and all six prd53 branches do carry it,
    // so `git log -- <this file>` reads as though the pin were present there
    // when only the walker is. The later waves each add a
    // directory of their own (`axis`, `canvas`, `frame`, `metrics`, `trace`)
    // and each owes this pin a row as it lands — wave 3 pays here (axis,
    // frame, metrics, trace; compare grows by two: fromExperiment and
    // ExperimentComparison), wave 4 pays canvas 3 (#341 merged into this branch) —
    // pinned exactly, not a loose lower bound, and grouped rather than
    // totalled. prd-55 wave 2 (#385) pays canvas 3 -> 5: the SVG's single
    // `LaneCanvas.tsx` became a model (`organism.ts`), a painter (`paint.ts`)
    // and a host, and the states ruling 9 asks to be drawn first moved out of
    // the assertions into `fixtures.ts` — a source file the walker counts,
    // deliberately, because a fixture that drifts is a picture that drifts.
    // `branching` stays 2: the diagram shrank INSIDE `geometry.ts` rather than
    // growing a component file. prd-55 wave 1 owes its own rows for
    // `launch`/`measure-control` and reconciles with this one at the merge.
    // Both halves are load-bearing. A lower bound at any floor lets
    // a file silently ADDED pass unnoticed, not just a file dropped. And a
    // single total, however exact, stays green through a compensated shrink:
    // 17 is still 17 when compare/ loses two files and the root gains two, so
    // a directory can shed a quarter of its coverage with nothing going red.
    // Grouping is what makes that failure name the directory that moved. The
    // next test names one file per subdirectory, so a directory vanishing
    // outright is caught twice over — but a partial shrink is invisible to it,
    // and this assertion is the only thing that sees it.
    //
    // prd-55 wave 1 pays two rows: `launch` grows to 4 (`models.ts` — the
    // model list `lab.models` offers, prd-55 ruling 5) and a new
    // `measure-control` directory arrives with 1 (`MeasureControl.tsx`; its
    // own `.test.tsx` is excluded from every count here, same as every other
    // directory's tests).
    // compare/ grows by two again, wave 3 (#214): save.ts (the app's seventh
    // mutating call) and SaveComparisonControl.tsx (the control that reaches
    // it from the comparison surface).
    expect(sourceFileCountsByDirectory()).toEqual({
      '': 6,
      axis: 3,
      branching: 2,
      canvas: 5,
      compare: 11,
      frame: 2,
      launch: 4,
      'measure-control': 1,
      metrics: 3,
      trace: 4,
    })
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

  it('exactly six scene modules are reachable from lab/ — a seventh, or any fold-bound one, fails by name (prd-55 ruling 11)', () => {
    const modules = [...new Set(sourceFiles().flatMap((file) => sceneImportsIn(file.text)))].sort()
    // Named, not counted: a seventh module reddens with its own path in the message.
    expect(modules).toEqual([...ALLOWED_SCENE_MODULES].sort())
    expect(modules).toHaveLength(ALLOWED_SCENE_MODULE_COUNT)
    for (const forbidden of FOLD_BOUND_SCENE_MODULES) {
      expect(
        modules.filter((specifier) => specifier.endsWith(`/${forbidden}.js`) || specifier.endsWith(`/${forbidden}.jsx`)),
        `${forbidden} reads the fold — ruling 11 forbids it to the lab by name, whatever else the exception allows`,
      ).toEqual([])
    }
  })

  it('and exactly the files that need them make those imports, named and positive — no other file in lab/ sees scene/ at all', () => {
    const sceneImports = sourceFiles().flatMap((file) =>
      sceneImportsIn(file.text).map((importPath) => ({ file: file.name, importPath })),
    )
    const byPair = (a: { file: string; importPath: string }, b: { file: string; importPath: string }) =>
      a.file.localeCompare(b.file) || a.importPath.localeCompare(b.importPath)
    expect([...sceneImports].sort(byPair)).toEqual([...ALLOWED_SCENE_IMPORTS].sort(byPair))
  })

  it('the six-module law bites — a seventh module, and each fold-bound one, is caught by the specifier alone', () => {
    // The probes are the exact spellings a drift would produce: a lab file
    // reaching one directory further up for a module that reads the fold.
    for (const forbidden of [...FOLD_BOUND_SCENE_MODULES, 'camera', 'motion']) {
      const probe = `import { x } from '../../scene/${forbidden}.js'`
      expect(sceneImportsIn(probe), probe).toEqual([`../../scene/${forbidden}.js`])
      expect(ALLOWED_SCENE_MODULES).not.toContain(`../../scene/${forbidden}.js`)
    }
    // …and a brush reached from a depth the pair list does not name is still seen.
    expect(sceneImportsIn("import { ribbonOutline } from '../../../scene/ribbon.js'")).toEqual(['../../../scene/ribbon.js'])
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
