import { readFileSync, readdirSync, statSync } from 'node:fs'
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

const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /\buseFleet\b/,
  /\bFleetProvider\b/,
  /\bbuildFleet\b/,
  // Depth-independent: a recursive walk sees this import written as
  // `../fleet/…` from lab/'s root and `../../fleet/…` from lab/branching/,
  // lab/compare/ or lab/launch/ — one or more `../` segments, either way.
  /from ['"](?:\.\.\/)+fleet\//,
  /from ['"](?:\.\.\/)+panels\//,
  // No re-fold of the whole log either — the lab tab reads its own two
  // read-only routes (`/api/lab/checkpoints`, `/api/lab/experiments`), never
  // the raw event log itself.
  /\breduceAll\(/,
]

/**
 * Any import reaching into `scene/`, at any depth — governed separately
 * below, by name, not by blanket forbid. Covers every form a scene import
 * could take, not just `import … from '…'`/`export … from '…'` (the `from`
 * branch): a bare side-effect import (`import '../../scene/x.js'`, no
 * `from` at all) and a dynamic one (`import('../../scene/x.js')`) reach the
 * same module and must be just as visible — this is newly load-bearing now
 * that the blanket `scene/` forbid below has been replaced by this named,
 * positive exception; a form the regex can't see is a form the exception
 * can't be checked against.
 */
const SCENE_IMPORT_RE = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]((?:\.\.\/)+scene\/[^'"]+)['"]/g

/** The one named exception (`branching/geometry.ts`'s own doc: reused as-is, never forked). */
const ALLOWED_SCENE_IMPORT = { file: path.join('branching', 'geometry.ts'), importPath: '../../scene/palette.js' }

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
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(file.text, `${file.name} matches forbidden pattern ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  it('scene/palette.js is the only scene/ import anywhere in lab/, named and positive', () => {
    const sceneImports = sourceFiles().flatMap((file) =>
      [...file.text.matchAll(SCENE_IMPORT_RE)].map((match) => ({ file: file.name, importPath: match[1] })),
    )
    expect(sceneImports).toEqual([ALLOWED_SCENE_IMPORT])
  })

  it('the detector bites — a fleet/panel import added tomorrow, at any depth, would be caught by the path alone, not just a named identifier', () => {
    // No `useFleet`/`FleetProvider`/`buildFleet`/`reduceAll(` anywhere in
    // these probes — if they pass, it is the depth-independent path pattern
    // catching them, not a forbidden identifier riding along for free.
    expect(
      FORBIDDEN_PATTERNS.some((pattern) => pattern.test("import type { FetchLike } from '../fleet/manifest.js'")),
    ).toBe(true)
    expect(
      FORBIDDEN_PATTERNS.some((pattern) => pattern.test("import type { FetchLike } from '../../fleet/manifest.js'")),
    ).toBe(true)
    expect(
      FORBIDDEN_PATTERNS.some((pattern) =>
        pattern.test("import { costCellText } from '../../panels/fleet/format.js'"),
      ),
    ).toBe(true)
  })

  it('the scene detector bites — a second scene/ import, anywhere, would be caught', () => {
    const text = "import { cssColour } from '../scene/paint.js'"
    expect([...text.matchAll(SCENE_IMPORT_RE)].map((match) => match[1])).toEqual(['../scene/paint.js'])
  })

  it('the scene detector bites on a bare side-effect import and a dynamic one too, not just `… from …`', () => {
    const bare = "import '../../scene/reset.css.js'"
    const dynamic = "const mod = await import('../../scene/lazy.js')"
    expect([...bare.matchAll(SCENE_IMPORT_RE)].map((match) => match[1])).toEqual(['../../scene/reset.css.js'])
    expect([...dynamic.matchAll(SCENE_IMPORT_RE)].map((match) => match[1])).toEqual(['../../scene/lazy.js'])
  })
})
