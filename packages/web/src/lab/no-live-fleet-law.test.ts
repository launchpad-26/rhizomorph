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
 *
 * **What this law actually guarantees, stated plainly (#411).** Direct-text
 * coverage over this one directory: forbidden IDENTIFIERS matched by their
 * literal name (`FORBIDDEN_IDENTIFIERS`, below) and forbidden IMPORT PATHS
 * matched by prefix (`FORBIDDEN_IMPORT_PREFIXES`). It does NOT resolve what a
 * name is bound to across the module graph — a symbol re-exported under
 * another name from anywhere not itself path-prefixed `fleet/` or `panels/`,
 * then imported here by that new name, carries neither a forbidden
 * identifier nor a forbidden import path, and is invisible to both checks.
 *
 * Worked example, verified on this branch (#411, two independent review
 * seats, re-executed here) with a scratch pair, neither committed: a
 * module outside `lab/`, `fleet/` and `panels/` alike — a `relabel.ts`
 * under `lib/` — `export { useFleet as readLive } from '../fleet/FleetContext.js'`;
 * a lab file then does `import { readLive } from '../lib/relabel.js'`.
 * That lab file's text contains no literal `useFleet` (it says `readLive`)
 * and its import specifier (`../lib/relabel.js`) matches neither forbidden
 * prefix. With the count pin bumped first, the law passes fully green.
 *
 * NOT extended to chase this, for the same reason #350 stopped extending
 * `requireSpecifiersIn`: resolving what a renamed binding actually points to
 * means following the import graph, which a text sweep over one directory
 * cannot do and a regex added here cannot fix. The honest guarantee this law
 * gives is narrower than "the lab tab cannot reach live-fleet machinery": it
 * is that nothing in the lab tab NAMES fleet/panels machinery, directly, by
 * the identifier or the import path. A rename anywhere upstream of the
 * import is a channel this law does not see, and is not claimed to.
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

/**
 * THE IMPORT GRAMMAR THIS LAW CAN SEE, and what it does about each form —
 * #350 round 4's own enumeration, the way round 2 enumerated the filename
 * grammar; round 5 narrows the claim after two more forms turned up
 * uncovered. `extractImportSpecifiers` (`test/import-specifiers.ts`) is ESM
 * only, by its own doc — it has never claimed CommonJS.
 *
 * NO SENTENCE HERE MAY READ AS "the lab tab cannot reach live-fleet
 * machinery". The honest guarantee this table gives is narrower: nothing in
 * the lab tab NAMES fleet/panels machinery by the forms listed below as
 * CAUGHT. `require(...)` row's CAUGHT verdict is real but NOT a guarantee —
 * it is a best-effort catch of one literal spelling, not a closed grammar,
 * and the two UNCOVERED rows immediately below it are two ways a text sweep
 * over an unbounded CommonJS grammar was found to fail after that spelling
 * was added. There will be others; this table names the ones found, not an
 * exhaustive set.
 *
 * | form                                  | example                                            | verdict |
 * |----------------------------------------|-----------------------------------------------------|---------|
 * | static import                          | `import { x } from '../fleet/x.js'`                  | CAUGHT — `extractImportSpecifiers` |
 * | `import type`                          | `import type { T } from '../fleet/x.js'`             | CAUGHT — same; `from` drives the match, `type` is incidental |
 * | side-effect only                       | `import '../fleet/x.js'`                             | CAUGHT — same |
 * | re-export                              | `export { x } from '../fleet/x.js'`, `export * from '../fleet/x.js'` | CAUGHT — same |
 * | dynamic `import()`                     | `import('../fleet/x.js')`, `await import(…)`         | CAUGHT — same |
 * | computed / template specifier          | `` import(`${base}/fleet/x.js`) ``                   | CAUGHT — forbidden outright by `computedImportsIn`, not prefix-matched |
 * | CommonJS `require(...)`, ONE literal string/template argument | `require('../fleet/manifest.js')` | CAUGHT, best-effort (#350 round 4) — `requireSpecifiersIn`, below. NOT a guarantee: see the rows below |
 * | `require(...)` with a second argument   | `require('../fleet/manifest.js', 'ignored')`   | CAUGHT (#350 round 6) — the capture takes the FIRST quoted argument only, which here IS the real, whole specifier; a trailing second argument doesn't change what got captured. Verified red on the forbidden-import assertion, pin bumped first |
 * | `require(...)` with a CONCATENATED argument THAT SPLITS THE FORBIDDEN PREFIX | `require('../' + 'fleet/manifest.js')` | UNCOVERED (#350 round 5) — `requireSpecifiersIn` still matches `require(`, but its string-literal capture stops at the first closing quote, so it extracts only `"../"` — a harmless-looking fragment that matches no forbidden prefix. Verified: passes fully green, pin already correct. NARROWER than it may read: `require('../fleet/' + name)` extracts `"../fleet/"` and IS caught (#350 round 6, verified red, pin bumped) — only a split that truncates BEFORE the prefix is complete evades it |
 * | `require` obtained via `createRequire(...)` and called anonymously | `createRequire(x)('../fleet/manifest.js')` | UNCOVERED (#350 round 5) — the literal token `require` never appears next to the call at all, so `requireSpecifiersIn` has nothing to match. Verified: passes fully green, pin already correct |
 * | `require` behind a renamed binding     | `const req = createRequire(…); req('../fleet/x.js')` | UNCOVERED — the call-site token isn't literally `require`; a text sweep cannot know `req` is one without evaluating the module |
 * | `require.resolve(...)`                 | `require.resolve('../fleet/x.js')`                   | UNCOVERED — resolves without loading, but the same reach; not policed here |
 * | escaped ECMAScript spelling, ANY of the forms above | `import { x } from '../\x66leet/x.js'`, `require('..\x2ffleet\x2fx.js')`, `useFleet()` | UNCOVERED (#350 round 6) — a hex/unicode escape inside a string literal or identifier decodes at PARSE time; the raw source text a regex sees never contains the literal `fleet`/`panels` path segment or the literal `useFleet`-family identifier, only the escape sequence, so neither this table's checks nor `FORBIDDEN_IDENTIFIERS` see it. Verified end to end, pin bumped first: an escaped `require()` path and an escaped identifier reference in one file pass fully green, and the escaped paths resolve to the real target at runtime (confirmed outside this repo). NOT a new finding to build a decoder for — `test/import-specifiers.ts`'s own doc already names "escape-sequence obfuscation" as knowingly uncovered; this row is that same, cited fact, extended to the identifier sweep and to `require()` |
 * | `import.meta.glob(...)`                | Vite build-time macro                                | N/A — not ECMAScript import syntax; the shared extractor's own doc already excludes it |
 *
 * `require(...)` is extended HERE, in this law's own file, not in the
 * shared `test/import-specifiers.ts` — that module is out of THIS issue's
 * fence (`no-live-fleet-law.test.ts` is the only file it may touch) and is
 * shared by THREE other laws (`drawer/readonly.test.ts`,
 * `launch/explicit-invocation-law.test.ts`,
 * `concierge/explicit-invocation-law.test.ts` — round 4's own count of two
 * was itself short by one) this issue does not cover. Patching it here
 * would silently harden only this law while leaving those three exactly as
 * exposed to the same `require()` gap — reported as a sibling in this
 * commit, not fixed, same as the filename-filter siblings named in rounds
 * 1-4.
 *
 * Found #350 round 4, reproduced on this branch: `zz-req.cjs`
 * (`const fleet = require('../fleet/manifest.js')`) carries no forbidden
 * IDENTIFIER — `require` spells none of `FORBIDDEN_IDENTIFIERS` — and,
 * before that round, no forbidden IMPORT either, because the prefix check
 * only ever saw what `extractImportSpecifiers` (ESM-only) handed it. With
 * the count pin bumped first, the law passed fully green.
 *
 * Round 5 ruling: DO NOT extend `REQUIRE_SPECIFIER_RE` again to chase the
 * two rows above — a regex in this file cannot parse CommonJS reliably,
 * and every spelling closed has revealed the next one (round 4 closed one,
 * these two opened; chasing them would only open a fourth). The law is
 * allowed to check less than it wished; it is not allowed to CLAIM more
 * than it checks, which is why those two rows say UNCOVERED here rather
 * than being silently absent from the table.
 */
const REQUIRE_TRIVIA = String.raw`(?:\s|/\*[^*]*(?:\*+[^*/][^*]*)*\*+/|//[^\n]*)*`
const REQUIRE_SPECIFIER_RE = new RegExp(
  '\\brequire' + REQUIRE_TRIVIA + '\\(' + REQUIRE_TRIVIA +
    "(?:'([^'\\n]*)'|\"([^\"\\n]*)\"|`([^`\\n]*)`)",
  'g',
)

function requireSpecifiersIn(text: string): string[] {
  return [...text.matchAll(REQUIRE_SPECIFIER_RE)].map((match) => (match[1] ?? match[2] ?? match[3])!)
}

/** Every specifier this law can see, ESM and the local CommonJS extension both. */
function allSpecifiersIn(text: string): string[] {
  return [...extractImportSpecifiers(text), ...requireSpecifiersIn(text)]
}

function forbiddenImportsIn(text: string): string[] {
  return allSpecifiersIn(text).filter((specifier) =>
    FORBIDDEN_IMPORT_PREFIXES.some((prefix) => prefix.test(specifier)),
  )
}

/**
 * Specifiers no prefix check can vouch for: `${…}` anywhere in a dynamic
 * import's template means the path is computed at runtime —
 * `` import(`${base}/fleet/manifest.js`) `` starts with no `../` and
 * matches no forbidden prefix, yet reaches wherever `base` points (c77c2ee
 * verify pass). The law below forbids the form outright rather than
 * pretending a prefix check saw it. Covers `require(\`${base}/…\`)` too,
 * via `allSpecifiersIn`.
 */
function computedImportsIn(text: string): string[] {
  return allSpecifiersIn(text).filter((specifier) => specifier.includes('${'))
}

/**
 * Any import reaching into `scene/`, at any depth — governed separately
 * below, by name, not by blanket forbid. Built on the same shared
 * extraction, so every form a scene import could take is visible: static
 * `… from '…'`/`export … from '…'`, a bare side-effect import
 * (`import '../../scene/x.js'`, no `from` at all), a dynamic one
 * (`import('../../scene/x.js')`), a template-literal specifier
 * (``import(`../../scene/x.js`)``, which the old quoted-only regex missed —
 * PR #301 review), and now `require('../../scene/x.js')`, via
 * `allSpecifiersIn`. This is load-bearing: the blanket `scene/` forbid has
 * been replaced by a named, positive exception, and a form the detector
 * can't see is a form the exception can't be checked against.
 */
function sceneImportsIn(text: string): string[] {
  return allSpecifiersIn(text).filter((specifier) => /^(?:\.\.\/)+scene\//.test(specifier))
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
 * The axes this walk can vary along, and this file's verdict on each — so the
 * next reader checks the boundary here rather than inferring it from a regex.
 *
 * | axis                            | forms                                        | verdict |
 * |----------------------------------|-----------------------------------------------|---------|
 * | TypeScript source                 | `.ts` `.tsx` `.mts` `.cts`                     | swept, counted |
 * | TypeScript declaration             | `.d.ts` `.d.mts` `.d.cts`                      | swept, counted (no runtime code — kept anyway, see below) |
 * | JavaScript source                  | `.js` `.jsx` `.mjs` `.cjs`                     | swept, counted |
 * | test file, any extension above     | `*.test.ts`, `*.test.mts`, `*.test.jsx`, `*.test.d.ts`, … | excluded — not production code, via TWO patterns (`TEST_FILE` for a bare extension, `TEST_DECLARATION_FILE` for the three real TS declaration extensions after `.test.`). Round 4 tried one pattern with an optional `d.` infix and let it precede ANY extension — `*.test.d.cjs`/`.d.mjs`/`.d.js`, ordinary executable JavaScript, matched too and were excluded from BOTH the count pin and the sweep with the pin never moving; a total, silent miss, fixed round 5 by naming the declaration extensions instead of leaving the infix unrestricted |
 * | data / doc / style / image asset   | `.json` `.css` `.md` `.svg` `.png` `.jpg` `.jpeg` `.gif` `.ico` | excluded — `DENY_EXTENSIONS`, provably not a module |
 * | test artifact / build byproduct    | `.snap` `.map`                                 | excluded — `DENY_EXTENSIONS`, provably not a module |
 * | backup / editor artifact           | trailing `~`, `.bak`, `.orig`, `.rej`, `.swp`, `.swo`, `.swn` | excluded — `DENY_EXTENSIONS`, provably not a module (round 4: `.rej` — a rejected patch, written beside `.orig` — and vim's second/third swap files `.swo`/`.swn` were missing; the row named "the class" but the regex covered four of six of its own members) |
 * | directory                          | `node_modules`, `dist`                         | skipped entirely, unchanged |
 * | extension casing                   | `.JS`, `.MTS`, …                               | COVERED — a side effect of inverting to a deny-list, not something this file targets directly: `DENY_EXTENSIONS` is lowercase-only, so an uppercase-cased extension matches none of its patterns and falls through to being swept either way. A module spelled `.MTS` is therefore caught by the sweep (verified: `zz.MTS` reddens it); an asset misspelled `.JSON` is swept too, which lands on the same safe side as any other undenied form — a loud pin break, not a silent miss |
 * | identifier laundering              | `export { useFleet as somethingElse }`         | NARROWED, not extended (#411) — orthogonal to extension; the file's own top doc comment states the boundary and carries the worked example |
 *
 * #350 round 1 widened an ALLOW-list from `.ts`/`.tsx` to add `.js`/`.jsx`/
 * `.mjs`/`.cjs`. Round 2: two independent review passes found `.mts`/`.cts`
 * (and their `.d.mts`/`.d.cts` declaration siblings) still invisible — a
 * THIRD spelling of the same axis, and a CHEAPER route than the original
 * hole: a bare `zz-probe.mts` under `lab/` importing `useFleet` typechecks,
 * builds, and is a first-class module of this package by `tsc --listFiles`'s
 * own account — with no declaration companion and no pin movement needed to
 * hide it, unlike the two-file `.js` + `.d.ts` spelling #350 was filed to
 * close.
 *
 * Adding `mts|cts` as a fourth alternation would repeat the mistake: an
 * allow-list is a claim about every extension a module can be spelled with,
 * maintained by hand, and every round so far has found it short by exactly
 * one entry. INVERTED here instead — sweep every file by default, and name
 * only what is PROVABLY not a module (`DENY_EXTENSIONS` below). A new module
 * spelling is now covered without anyone updating this file, and the failure
 * direction flips: an asset wrongly denied breaks the count pin LOUDLY; an
 * unrecognised module extension no longer has anywhere to hide.
 *
 * This table governs WHICH FILES the walk visits. Round 4 found a second,
 * different instrument in this same file governing HOW AN IMPORT IS
 * EXTRACTED once a file is read — that axis is enumerated in its own table,
 * by `forbiddenImportsIn`, below.
 */
const DENY_EXTENSIONS = /\.(json|css|md|svg|png|jpe?g|gif|ico|snap|map|bak|orig|rej|swp|swo|swn)$|~$/
/**
 * TWO SEPARATE CASES, not one pattern with an optional infix. #350 round 5:
 * round 4's `/\.test\.(?:d\.)?[^./]+$/` let `d.` precede ANY final segment,
 * so `foo.test.d.cjs`/`.d.mjs`/`.d.js` — ordinary executable JavaScript, not
 * declaration files; `.d.js` is not a TypeScript declaration extension at
 * all — matched as "test files" and were excluded from BOTH the count pin
 * and the sweep, with the pin never needing to move. Total, silent miss;
 * verified: `zz.test.d.cjs` importing `useFleet` passed the law fully
 * green, pin untouched. `TEST_DECLARATION_FILE` restricts the `d.` infix to
 * the three extensions TypeScript actually recognises as declarations.
 */
const TEST_FILE = /\.test\.[^./]+$/
const TEST_DECLARATION_FILE = /\.test\.d\.[cm]?ts$/

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
    if (DENY_EXTENSIONS.test(entry)) continue
    if (TEST_FILE.test(entry) || TEST_DECLARATION_FILE.test(entry)) continue
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

describe('the lab tab NAMES no live-fleet machinery, by the identifiers and import paths this law checks (prd14)', () => {
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

  it('TEST_DECLARATION_FILE stays scoped to real TS declaration extensions, not any extension after a `d.` infix (#350 round 5, the only code change on this branch, and it had no witness until now)', () => {
    // Round 4 shipped `/\.test\.(?:d\.)?[^./]+$/` — one pattern, `d.` optional
    // ahead of ANY extension — which silently excluded `foo.test.d.cjs`,
    // `.d.mjs` and `.d.js` from BOTH the count pin and the sweep. Round 5 split
    // it into TEST_FILE (a bare extension) and TEST_DECLARATION_FILE (only the
    // three extensions TypeScript actually recognises as declarations). This
    // is the direct witness two review seats found missing: revert either
    // pattern back toward the round-4 shape and this test reddens on its own,
    // without needing a fixture file on disk or the count pin touched at all.
    for (const ext of ['ts', 'mts', 'cts']) {
      expect(TEST_DECLARATION_FILE.test(`foo.test.d.${ext}`), `foo.test.d.${ext} excluded as a declaration test file`).toBe(
        true,
      )
    }
    for (const ext of ['js', 'mjs', 'cjs']) {
      expect(TEST_FILE.test(`foo.test.d.${ext}`), `foo.test.d.${ext} not matched by TEST_FILE`).toBe(false)
      expect(
        TEST_DECLARATION_FILE.test(`foo.test.d.${ext}`),
        `foo.test.d.${ext} not matched by TEST_DECLARATION_FILE — ordinary JavaScript, swept and counted like any other`,
      ).toBe(false)
    }
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

  it('exactly six scene modules are NAMED as scene/ imports from lab/ — a seventh, or any fold-bound one, fails by name (prd-55 ruling 11)', () => {
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

  it('and exactly the files that need them make those imports, named and positive — no other file in lab/ NAMES scene/ at all', () => {
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

  it('the detector bites on every ESM form this file names CAUGHT, at any depth, by the path alone — not a claim about the forms named UNCOVERED in the import-grammar table', () => {
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

  it('the detector bites via CommonJS require() too — #350 round 4, no forbidden identifier needed', () => {
    // None of these probes spells useFleet/FleetProvider/buildFleet/reduceAll(
    // — if they pass, it is requireSpecifiersIn feeding the same prefix
    // check, not the identifier sweep riding along for free. This is exactly
    // the reproduction that passed the whole law fully green before this
    // round: `const fleet = require('../fleet/manifest.js')` carries no
    // forbidden identifier, and until now no forbidden import either.
    const probes: ReadonlyArray<[string, string[]]> = [
      ["const fleet = require('../../fleet/manifest.js')", ['../../fleet/manifest.js']],
      ['const fleet = require("../../fleet/manifest.js")', ['../../fleet/manifest.js']],
      ["const fmt = require('../../panels/fleet/format.js')", ['../../panels/fleet/format.js']],
      ["require('../../fleet/manifest.js')", ['../../fleet/manifest.js']],
      ["require /* preload */ ('../../fleet/manifest.js')", ['../../fleet/manifest.js']],
    ]
    for (const [probe, expected] of probes) {
      expect(forbiddenImportsIn(probe), probe).toEqual(expected)
    }
  })

  it('the computed detector bites on a require() template specifier too', () => {
    expect(computedImportsIn('const fleet = require(`${base}/fleet/manifest.js`)')).toEqual([
      '${base}/fleet/manifest.js',
    ])
  })

  it('the scene detector bites — a second scene/ import, anywhere, would be caught', () => {
    expect(sceneImportsIn("import { cssColour } from '../scene/paint.js'")).toEqual(['../scene/paint.js'])
  })

  it('the scene detector bites on the forms that carry no `from` — bare, dynamic, and template-literal specifiers', () => {
    expect(sceneImportsIn("import '../../scene/reset.css.js'")).toEqual(['../../scene/reset.css.js'])
    expect(sceneImportsIn("const mod = await import('../../scene/lazy.js')")).toEqual(['../../scene/lazy.js'])
    expect(sceneImportsIn('const mod = await import(`../../scene/paint.js`)')).toEqual(['../../scene/paint.js'])
  })

  it('the scene detector bites on require() too — #350 round 4', () => {
    expect(sceneImportsIn("const paint = require('../../scene/paint.js')")).toEqual(['../../scene/paint.js'])
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
