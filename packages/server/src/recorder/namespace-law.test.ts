import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionDirFor } from '../log/paths.js'
import { readSessionEvents, sessionFilePath } from '../log/session-log.js'
import { writeSessionLock } from '../log/session-lock.js'
import { retargetSession, rotateSession } from './rotate.js'
import { SessionRecorder } from './session-recorder.js'

/**
 * THE RECORDER NAMESPACE LAW — prd16 ruling 2's own condition, in the shape of
 * `lab/namespace-law.test.ts`: "the existing readonly greps stay green
 * untouched; a new rotation-namespace test asserts every write path of this
 * hand lands under the data directory and nowhere else."
 *
 * The constitution now has three hands. The observer is absolutely read-only
 * over the watched repo; the laboratory is an explicitly-invoked second actor
 * inside `refs/rhizomorph/`; this, the third and narrowest, may end one
 * recording and begin another — inside
 * `~/.local/share/rhizomorph/<repo>/` and nowhere else. It never touches the
 * watched repo, never a ref, never a worktree, never `~/.claude`.
 *
 * Four halves:
 *
 * 1. The module's filesystem surface is ONE file. Every direct write in
 *    `recorder/` lives in `session-log-writer.ts`; rotation's only other write
 *    is the lock sidecar, through `log/session-lock.ts`, which builds its path
 *    from the session dir it is handed. Nothing here names a home directory, a
 *    ref, `~/.claude`, or a way to run a command.
 * 2. Rotation is reachable ONLY from an explicit operator entry point. No
 *    collector, no poll loop, no web file. The one allowed importer is named
 *    below rather than silently excluded.
 * 3. The recorder has no clock of its own — no `setInterval`/`setTimeout`
 *    anywhere under `recorder/` — so "never rotates without a human's explicit
 *    command" holds structurally, not just by convention.
 * 4. A live pass of the whole write surface: a real rotation against a real
 *    git repo, a real data dir and a stand-in `~/.claude/projects`, asserted
 *    by hashing the entire tree before and after. Halves 1–3 can be fooled by
 *    a clever spelling; this one runs the thing.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
// packages/server/src/recorder -> repo root
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..')
const SERVER_SRC = path.join(REPO_ROOT, 'packages', 'server', 'src')
const WEB_SRC = path.join(REPO_ROOT, 'packages', 'web', 'src')
const RECORDER_DIR = path.join(SERVER_SRC, 'recorder')

/**
 * The files allowed to reach the session boundary: the two mutating API routes
 * the CLI verb, the dashboard button and prd20 ruling 5's repo switch go
 * through. `cli/index.ts` is deliberately NOT here — `rhizomorph rotate` asks
 * the running server over HTTP rather than closing a log another process is
 * writing (see `cli/rotate.ts`), so the CLI never holds a reference to this
 * hand at all.
 *
 * `api/retarget.ts` joined in #389, which is what widened this from one file
 * to two. Whatever is added here later may never be a collector or a poll loop
 * — stated by name below, and judged again against the raw import graph in
 * `api/retarget-law.test.ts`.
 */
const ALLOWED_ROTATION_CALLERS = new Set([
  path.join(SERVER_SRC, 'api', 'rotate.ts'),
  path.join(SERVER_SRC, 'api', 'retarget.ts'),
])

/** The only file inside the module that may touch the filesystem directly. */
const THE_WRITER = path.join(RECORDER_DIR, 'session-log-writer.ts')

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])

function walkSourceFiles(dir: string, exclude: readonly string[] = []): string[] {
  const excluded = new Set(exclude.map((p) => path.resolve(p)))
  const out: string[] = []

  const visit = (current: string) => {
    if (excluded.has(path.resolve(current))) return
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const full = path.join(current, entry)
      if (excluded.has(path.resolve(full))) continue
      const info = statSync(full)
      if (info.isDirectory()) {
        visit(full)
      } else if (SOURCE_EXTENSIONS.has(path.extname(full))) {
        out.push(full)
      }
    }
  }

  visit(dir)
  return out
}

function isTest(file: string): boolean {
  return file.endsWith('.test.ts') || file.endsWith('.test.tsx')
}

function recorderSourceFiles(): string[] {
  return walkSourceFiles(RECORDER_DIR).filter((file) => !isTest(file))
}

/**
 * A file's CODE, with comments removed. The law is about what the module
 * does, and the module's own doc comments legitimately *name* the things it
 * must never touch (`never a ref, never a worktree, never ~/.claude`) — the
 * same false positive the lab law solved for git verbs by matching argv
 * position. Crude on purpose (a `//` inside a string literal would truncate
 * its line; the module has none) and legible by eye, like every check here.
 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
}

/**
 * The first argument of a call, by paren depth — so
 * `mkdir(path.dirname(this.filePath), …)` reads as one expression rather than
 * being cut at its inner comma.
 */
function firstArguments(code: string, callee: RegExp): string[] {
  const out: string[] = []
  for (const match of code.matchAll(callee)) {
    let depth = 0
    let start = (match.index ?? 0) + match[0].length
    let end = start
    for (; end < code.length; end += 1) {
      const char = code[end]
      if (char === '(' || char === '[') depth += 1
      else if (char === ']') depth -= 1
      else if (char === ')') {
        if (depth === 0) break
        depth -= 1
      } else if (char === ',' && depth === 0) break
    }
    out.push(code.slice(start, end).trim())
  }
  return out
}

/** Every way a Node program writes to, moves or removes a path. */
const WRITE_CALL_RE =
  /\b(?:writeFile|appendFile|mkdir|mkdtemp|rmdir|unlink|rename|truncate|createWriteStream|copyFile|open|chmod|utimes)\s*\(/g

/**
 * Every module specifier a file's code references — `from '…'`, a bare
 * `import '…'`, a dynamic `import('…')`, a `require('…')` — in single quotes,
 * double quotes or backticks. Same regex as `api/retarget-law.test.ts:110`;
 * reused for the same reason that file gives, not re-derived here.
 */
const SPECIFIER_RE = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)(['"`])([^'"`]*)\1/g

/**
 * The byte ranges of `import type …from '…'` and `export type …from '…'`
 * statements. TypeScript ERASES these: no runtime edge exists, so a file whose
 * only reference to rotation is a type cannot invoke it.
 *
 * Position ranges rather than a specifier blacklist, deliberately: a file may
 * import the same module BOTH ways —
 * `import type { Rotation } from './x.js'` beside `import { doThing } from './x.js'`
 * — and subtracting by specifier string would drop the real value edge along
 * with the erased one.
 *
 * `[^'"`]*?` spans newlines so a multi-line `import type { A,\n B,\n }` is one
 * range, and stops at the first quote so it cannot run past its own `from`.
 */
function typeOnlyImportRanges(code: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = []
  for (const match of code.matchAll(/\b(?:import|export)\s+type\b[^'"`]*?\bfrom\s*(['"`])[^'"`]*\1/g)) {
    if (match.index !== undefined) ranges.push([match.index, match.index + match[0].length] as const)
  }
  return ranges
}

/**
 * Every specifier a file references for a VALUE — every `SPECIFIER_RE` match
 * except those falling inside the type-only statements above.
 *
 * This replaced an unfiltered `importSpecifiers` helper, which became dead once
 * the edge arm stopped counting erased imports; it is deleted rather than kept
 * beside this one, so there is no unfiltered variant for a later edit to reach
 * for by mistake. `SPECIFIER_RE` itself is untouched — it is asserted
 * byte-identical to `api/retarget-law.test.ts`'s copy, and that premise is
 * about the regex, not about who reads it.
 *
 * This is what an import EDGE must be built on. The arm that reads it exists to
 * catch a caller that reaches rotation under a local name the sweep cannot
 * guess; a type-only import reaches nothing at runtime, so counting it makes
 * the law refuse a file that provably cannot call anything. Measured before
 * this filter existed: a file whose entire content was
 * `import type { Rotation } from '../recorder/rotate.js'` was named a rotation
 * caller.
 *
 * The NAME arm remains text-level and still trips on a bare comment mentioning
 * a door. That asymmetry is real and is not resolved here — but it errs in the
 * direction of the arm that has always been a grep, whereas this arm claims to
 * model reachability and so has to mean it.
 */
function valueImportSpecifiers(code: string): string[] {
  const erased = typeOnlyImportRanges(code)
  const out: string[] = []
  for (const match of code.matchAll(SPECIFIER_RE)) {
    const specifier = match[2]
    if (specifier === undefined || specifier.length === 0) continue
    const at = match.index
    if (at !== undefined && erased.some(([start, end]) => at >= start && at < end)) continue
    out.push(specifier)
  }
  return out
}

/**
 * Resolves a relative specifier the way the build does: `.js` in source means
 * the `.ts` beside it, a directory means its `index.ts`, an extensionless
 * path is tried both ways. A non-relative specifier (a package import)
 * resolves to nothing — never a match.
 */
function resolveRelativeSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]
  for (const candidate of candidates) {
    try {
      statSync(candidate)
      return path.resolve(candidate)
    } catch {
      // not this candidate — try the next
    }
  }
  return null
}

/** Every `export { … } from '…'` re-export clause in a barrel. */
const BARREL_REEXPORT_RE = /export\s*\{([^}]*)\}\s*from\s*(['"`])([^'"`]*)\2/g

/**
 * Whether a module specifier points at rotation's module. Factored so the name
 * derivation and the barrel-default edge below cannot drift apart: a
 * re-derived copy of a resolver one screen from its original is exactly the
 * divergence a review pass found in `resolveRelativeSpecifier`.
 */
function specifierTargetsRotate(specifier: string): boolean {
  return path.basename(specifier).replace(/\.(?:js|ts)$/, '') === 'rotate'
}

/**
 * Whether a barrel republishes rotation's own default export AS ITS OWN
 * default — `export { default } from './rotate.js'`.
 *
 * Only the BARE form counts. `export { default as rotationDoor }` creates a
 * NAMED export, which the name derivation already covers by deriving the
 * alias; it is the bare form that leaves a reachable door with no name for any
 * sweep to find.
 */
function barrelRepublishesRotationDefault(barrelSource: string): boolean {
  for (const match of barrelSource.matchAll(BARREL_REEXPORT_RE)) {
    if (!specifierTargetsRotate(match[3] ?? '')) continue
    if ((match[1] ?? '').split(',').some((specifier) => specifier.trim() === 'default')) return true
  }
  return false
}

/**
 * Specifiers a file imports a DEFAULT binding from — `import X from '…'` and
 * `import X, { y } from '…'`.
 *
 * Deliberately NOT matched, each for a stated reason:
 *  - `import type X from '…'` — erased, so no runtime edge. The negative
 *    lookahead is what keeps this arm consistent with the value-only import
 *    arm above; a type-aware edge beside a type-blind one would be a second
 *    meaning of "reaches rotation", not a fix.
 *  - `import { y } from '…'` — a named import binds no default, and the name
 *    arm already sweeps for the names.
 *  - `import * as ns from '…'` — `ns.default` IS reachable, and catching it
 *    honestly needs member-access analysis rather than an import-shape regex.
 *    DECLARED RESIDUAL, not an oversight: a namespace import of a barrel that
 *    republishes rotation's default escapes both arms. Narrower than the gap
 *    this edge closes, and it is written down rather than left for the next
 *    reader to discover.
 */
const DEFAULT_IMPORT_RE =
  /\bimport\s+(?!type\b)([\w$]+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?\s*\bfrom\s*(['"`])([^'"`]*)\2/g

function defaultImportSpecifiers(code: string): string[] {
  const out: string[] = []
  for (const match of code.matchAll(DEFAULT_IMPORT_RE)) {
    const specifier = match[3]
    if (specifier !== undefined && specifier.length > 0) out.push(specifier)
  }
  return out
}

/**
 * The public-facing names an `export { a, b as c, type D }` clause creates —
 * the post-`as` name when there is one, skipping any specifier tagged `type`.
 */
function namesFromExportClause(clause: string): string[] {
  const names: string[] = []
  for (const raw of clause.split(',')) {
    const specifier = raw.trim()
    if (!specifier || /^type\b/.test(specifier)) continue
    // `export { default } from './rotate.js'` names no binding a caller can
    // write. Deriving the literal `default` from it puts `\bdefault\b` into
    // the door alternation, which matches the KEYWORD in ordinary source: a
    // measured 49 unrelated files reported as rotation callers, while the file
    // actually holding the default export goes unnamed. `default as x` is a
    // different clause and still derives `x`, which is a real door name.
    //
    // Residual, deliberately not closed here: a door republished as a bare
    // default REMAINS underived — it never was derived. Before this guard the
    // clause produced the string `default`, but the offending importer writes
    // `import X from '../recorder/index.js'` and contains no `default` token,
    // so the name arm did not see it either; the 49 files were noise, not
    // detection. This guard removes the noise and removes no coverage. Closing
    // the residual needs a default-import-only barrel edge, which must also
    // rule on what a namespace import and a chained re-export mean, and would
    // land type-aware beside an import arm that is measurably type-blind.
    // That is a ruling, not a bug fix, so it is filed rather than smuggled in.
    if (specifier === 'default') continue
    const asMatch = specifier.match(/^([\w$]+)\s+as\s+([\w$]+)$/)
    if (asMatch) {
      const alias = asMatch[2]
      // The same rule as the bare check above, on the OTHER side of `as`.
      // `export { rotateSession as default }` is legal — a reserved word is a
      // valid module export name and an invalid local binding — so the alias
      // can be `default`, and deriving it puts the KEYWORD back into the door
      // alternation with exactly the effect the bare guard exists to prevent.
      // Guarding one side only was a half-fix: a review pass on the first fix
      // reproduced the identical 49-file failure through this side.
      if (alias === 'default') continue
      if (alias) {
        names.push(alias)
        continue
      }
    }
    const bare = specifier.match(/^([\w$]+)$/)
    if (bare) {
      const name = bare[1]
      if (name) names.push(name)
    }
  }
  return names
}

/**
 * Every value door `rotate.ts` publishes, derived from two texts rather than
 * typed by hand:
 *
 *  - `rotate.ts`'s own value-export declarations — `function`, `class`,
 *    `const`, `let`, `var` — and any LOCAL `export { a, b as c }` clause.
 *  - the barrel's `export { … } from './rotate.js'` block, because
 *    `recorder/index.ts:21-32` is where rotation is actually PUBLISHED: an
 *    alias minted there (`export { performRetarget as retargetNow }`) is a
 *    real door under a name that never appears in `rotate.ts` at all.
 *
 * #87 is the second time a hand-typed enumeration lagged its own subject —
 * `retargetSession` (prd20 ruling 5) was a hand-added third door, and
 * `beginRetargetBoundary` / `performRetarget` (prd42 w2, #14) arrived as a
 * fourth and fifth that nobody added to the list. Reading the names back off
 * the module and its barrel removes the step that kept getting skipped,
 * rather than asking someone to remember it harder.
 *
 * `type`-only specifiers are skipped in both — `export type { … }` never
 * matches the brace pattern below (the word `type` sits between `export` and
 * `{`), and a `type X` entry inside a mixed clause is filtered by
 * `namesFromExportClause`.
 *
 * Still blind to one form: an unnamed `export default`. The caller mints
 * that door's local name itself, so no name-derivation can ever enumerate
 * it — `rotationViolationsFor` below closes that gap by import edge instead
 * of by name.
 *
 * Takes TEXT rather than reading the files itself, so the derivation can be
 * proven directly against synthetic source covering every form, not just
 * asserted against whatever `rotate.ts` happens to contain today.
 */
function rotationEntryPoints(rotateSource: string, barrelSource: string): string[] {
  const names = new Set<string>()

  for (const match of rotateSource.matchAll(
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([\w$]+)/g,
  )) {
    const name = match[1]
    if (name) names.add(name)
  }
  for (const match of rotateSource.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/g)) {
    for (const name of namesFromExportClause(match[1] ?? '')) names.add(name)
  }

  for (const match of barrelSource.matchAll(BARREL_REEXPORT_RE)) {
    if (!specifierTargetsRotate(match[3] ?? '')) continue
    for (const name of namesFromExportClause(match[1] ?? '')) names.add(name)
  }

  return [...names]
}

/**
 * A derived name embedded in a regex alternation, escaped so it can only ever
 * match itself literally. Without this, a `$` inside a name — legal in a JS
 * identifier, not part of `\w` — is read by the regex engine as an
 * end-of-string anchor: `rotate$Door` would never match the very name it came
 * from. `[\w$]+` above is what stops the CAPTURE from truncating at the `$`;
 * this is what stops the resulting ALTERNATION from breaking on it.
 */
function escapeForAlternation(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const ROTATE_SOURCE = codeOf(path.join(RECORDER_DIR, 'rotate.ts'))
const BARREL_SOURCE = codeOf(path.join(RECORDER_DIR, 'index.ts'))

const ROTATION_ENTRY_RE = new RegExp(
  `\\b(?:${rotationEntryPoints(ROTATE_SOURCE, BARREL_SOURCE).map(escapeForAlternation).join('|')})\\b`,
)

interface RotationViolationsConfig {
  searchRoot: string
  recorderDir: string
  rotateFile: string
  entryRe: RegExp
  allowedCallers: ReadonlySet<string>
  /**
   * The barrel that republishes rotation's exports, if there is one. Optional
   * so the three synthetic fixtures that predate the barrel-default edge keep
   * exercising the two original arms in isolation — a fixture that silently
   * gained a third arm would stop testing what its name says.
   */
  barrelFile?: string
}

/**
 * Every file outside `recorderDir` (barring `allowedCallers` and tests) that
 * reaches rotation — either by NAME (`entryRe`) or by IMPORT EDGE: a
 * specifier that resolves straight to `rotateFile`, regardless of which local
 * name the importer gives it. The edge check is what a name-only law cannot
 * be: an unnamed `export default` is invisible to `entryRe` by construction,
 * but every caller of it still has to write the specifier to reach it.
 *
 * Parameterized on the module's location rather than closed over
 * `RECORDER_DIR` so a synthetic fixture tree — its own fake `recorder/`, its
 * own fake `rotate.ts` — can drive the exact same check the production law
 * runs, not a look-alike of it.
 */
function rotationViolationsFor(config: RotationViolationsConfig): string[] {
  const violations: string[] = []
  const rotateTarget = path.resolve(config.rotateFile)

  // The barrel-default arm is armed only when a barrel is given AND that barrel
  // actually republishes rotation's default. Both conditions matter: with no
  // bare-default clause there is no unnamed door to reach, so arming the arm
  // would refuse every default import of an ordinary barrel for nothing.
  const barrelTarget = config.barrelFile === undefined ? undefined : path.resolve(config.barrelFile)
  const barrelCarriesRotationDefault =
    barrelTarget === undefined ? false : barrelRepublishesRotationDefault(codeOf(barrelTarget))

  for (const file of walkSourceFiles(config.searchRoot, [config.recorderDir])) {
    if (isTest(file)) continue
    if (config.allowedCallers.has(path.resolve(file))) continue

    const code = readFileSync(file, 'utf8')
    const reachesByName = config.entryRe.test(code)
    const reachesByImport = valueImportSpecifiers(codeOf(file)).some(
      (specifier) => resolveRelativeSpecifier(file, specifier) === rotateTarget,
    )
    // A door republished as a bare default has NO name, so `entryRe` cannot see
    // it, and the specifier the caller writes points at the barrel rather than
    // at `rotate.ts`, so the direct edge above cannot either. This arm is the
    // only thing that closes that: a default import of a barrel that carries
    // rotation's default reaches rotation, whatever the importer calls it.
    const reachesByBarrelDefault =
      barrelCarriesRotationDefault &&
      barrelTarget !== undefined &&
      defaultImportSpecifiers(codeOf(file)).some(
        (specifier) => resolveRelativeSpecifier(file, specifier) === barrelTarget,
      )
    if (reachesByName || reachesByImport || reachesByBarrelDefault) {
      violations.push(path.relative(REPO_ROOT, file))
    }
  }
  return violations
}

/** The production check: the real tree, the real module, the real law. */
function rotationViolations(searchRoot: string, allowedCallers: ReadonlySet<string>): string[] {
  return rotationViolationsFor({
    searchRoot,
    recorderDir: RECORDER_DIR,
    rotateFile: path.join(RECORDER_DIR, 'rotate.ts'),
    entryRe: ROTATION_ENTRY_RE,
    allowedCallers,
    barrelFile: path.join(RECORDER_DIR, 'index.ts'),
  })
}

describe('the recorder namespace law (prd16 ruling 2)', () => {
  describe('the module writes through exactly one file, and names nothing outside the data dir', () => {
    it('has source files to check at all — an empty grep proves nothing', () => {
      expect(recorderSourceFiles().length).toBeGreaterThan(3)
    })

    it('every direct filesystem write in the module lives in the log writer', () => {
      const offenders: string[] = []
      for (const file of recorderSourceFiles()) {
        if (path.resolve(file) === path.resolve(THE_WRITER)) continue
        for (const match of codeOf(file).matchAll(WRITE_CALL_RE)) {
          offenders.push(`${path.relative(REPO_ROOT, file)}: ${match[0]}`)
        }
      }
      expect(offenders).toEqual([])
    })

    it('the writer itself writes only to the file path it was handed', () => {
      // Every write call's first argument is the path the recorder gave this
      // writer (or its dirname) — and rotation only ever builds those from the
      // session dir. A write to any other expression is what this catches.
      // Excludes a call on the HELD handle (`handle.appendFile(...)`, prd44
      // ruling 2): its first argument is the event data, not a path, and the
      // path it targets was already checked at the `open(` call that opened
      // it — the negative lookbehind below names that one call rather than
      // excluding every dot-prefixed call, so a namespaced write to an
      // arbitrary path (e.g. `someOtherHandle.open(userPath)`) is still caught.
      const ALLOWED_TARGETS = new Set(['this.filePath', 'path.dirname(this.filePath)', 'filePath'])
      const targets = firstArguments(
        codeOf(THE_WRITER),
        /(?<!handle\.)\b(?:writeFile|appendFile|truncate|mkdir|open|rename|unlink)\s*\(/g,
      )
      expect(targets.length).toBeGreaterThan(0)
      expect(targets.filter((target) => !ALLOWED_TARGETS.has(target))).toEqual([])
    })

    it('names no home directory, no ref, no ~/.claude, and no way to run a command', () => {
      const forbidden: Array<{ what: string; pattern: RegExp }> = [
        { what: 'a home directory', pattern: /\bhomedir\s*\(|process\.env\.HOME/ },
        { what: 'a git ref', pattern: /refs\// },
        { what: "Claude Code's own directory", pattern: /\.claude\b/ },
        { what: 'a git worktree', pattern: /\bworktree/i },
        { what: 'an execution channel', pattern: /child_process|\bexec\w*\s*\(|\bspawn\w*\s*\(/ },
        { what: 'the default data root', pattern: /defaultDataRoot/ },
      ]
      const offenders: string[] = []
      for (const file of recorderSourceFiles()) {
        const code = codeOf(file)
        for (const { what, pattern } of forbidden) {
          if (pattern.test(code)) offenders.push(`${path.relative(REPO_ROOT, file)}: ${what}`)
        }
      }
      expect(offenders).toEqual([])
    })

    it('those detectors bite — and do not fire on a doc comment forbidding the same thing', () => {
      expect(/\bhomedir\s*\(/.test('const root = homedir()')).toBe(true)
      expect(/refs\//.test("await exec('git', ['update-ref', 'refs/rhizomorph/x', sha])")).toBe(true)
      expect(/\.claude\b/.test("path.join(homedir(), '.claude', 'projects')")).toBe(true)
      expect(/\bwriteFile\s*\(/.test('await writeFile(somewhereElse, data)')).toBe(true)

      // The false positive this module's own prose would otherwise be.
      expect(/\.claude\b/.test(codeOf(path.join(RECORDER_DIR, 'rotate.ts')))).toBe(false)
      expect(readFileSync(path.join(RECORDER_DIR, 'rotate.ts'), 'utf8')).toContain('~/.claude')
    })
  })

  describe('rotation is reachable only from an explicit operator command', () => {
    it('no source file outside the module reaches rotation, except the one declared route', () => {
      expect(rotationViolations(SERVER_SRC, ALLOWED_ROTATION_CALLERS)).toEqual([])
    })

    it('the one allowed caller really does call it — the exception is not dead code', () => {
      for (const file of ALLOWED_ROTATION_CALLERS) {
        expect(ROTATION_ENTRY_RE.test(readFileSync(file, 'utf8'))).toBe(true)
      }
    })

    it('the derived door list sees every current door, not a hand-listed four', () => {
      const doors = rotationEntryPoints(ROTATE_SOURCE, BARREL_SOURCE)
      for (const door of [
        'rotateSession',
        'closeCurrentSession',
        'openNextSession',
        'retargetSession',
        'beginRetargetBoundary',
        'performRetarget',
        // The door #92 was absorbed into #87 to cover. Without this line the
        // derivation could stop reaching it and nothing would go red: the
        // guarded set is derived from `rotate.ts` alone, so a hook that moves
        // to another `recorder/` file leaves this law silent. Pinning the name
        // here does not un-derive the set — it asserts the derivation arrives.
        'reserveInFlightForTest',
        // The remaining three. A review pass measured that each could vanish
        // from `rotate.ts` with the law staying green, so the exposure was
        // identical on all four and the title said "every".
        //
        // Pinning ARRIVAL is not endorsing the door. `nextSessionStart` is pure
        // arithmetic and the two error classes are catch-side, so the derivation
        // being wider than "doors into rotation's two halves" is real and is
        // parked in this commit's body. That is an argument about what the
        // derivation SHOULD produce; this floor asserts only that it still
        // produces what it produces today, which is what catches a silent drop.
        'RotationRefusedError',
        'RetargetInFlightError',
        'nextSessionStart',
      ]) {
        expect(doors, `${door} missing from the derived door list`).toContain(door)
      }
    })

    it('EXECUTED: a fixture importing performRetarget from outside the module turns the law red and names the file', async () => {
      const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-rotation-door-fixture-'))
      try {
        const offender = path.join(fixtureRoot, 'sneaky-collector.ts')
        await writeFile(
          offender,
          [
            "import { performRetarget } from '../recorder/rotate.js'",
            '',
            'export async function sneak(options: unknown) {',
            '  return performRetarget(options as never)',
            '}',
            '',
          ].join('\n'),
        )
        const innocent = path.join(fixtureRoot, 'innocent.ts')
        await writeFile(innocent, "export const nothing = 1\n")

        // The four-name enumeration this law shipped with (#87) would have
        // missed this entirely — `performRetarget` was never in it. The
        // derived list catches it, and names only the offending file.
        expect(rotationViolations(fixtureRoot, new Set())).toEqual([path.relative(REPO_ROOT, offender)])
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true })
      }
    })

    it('the door-list derivation actually reads the forms it claims to — not a hand-typed floor', () => {
      // If this function's body were replaced with a retyped array of the six
      // real door names, every name below would be missing and this test
      // would fail — unlike a `toContain` check against the real module,
      // which a hand-typed floor can satisfy by accident.
      const syntheticRotate = [
        'export function fnDoor() {}',
        'export async function asyncDoor() {}',
        'export class ClassDoor {}',
        'export const constDoor = () => {}',
        'export var varDoor = 1',
        'export default function defaultDoorImpl() {}',
        'let letDoorImpl',
        'export { letDoorImpl as letDoor }',
        'export { fnDoor as aliasedLocalDoor, type NotADoor }',
        'export interface NotADoorType {}',
        'export type NotAnotherDoor = string',
      ].join('\n')

      const syntheticBarrel = [
        "export { performRetarget as retargetNow, type RetargetSessionOptions } from './rotate.js'",
        "export { SessionRecorder } from './session-recorder.js'",
      ].join('\n')

      expect(new Set(rotationEntryPoints(syntheticRotate, syntheticBarrel))).toEqual(
        new Set([
          'fnDoor',
          'asyncDoor',
          'ClassDoor',
          'constDoor',
          'varDoor',
          'defaultDoorImpl',
          'letDoor',
          'aliasedLocalDoor',
          'retargetNow',
        ]),
      )
    })

    it('a bare `default` republish derives no door, while `default as x` still derives x', () => {
      // A bare default republish names no binding, so there is nothing for a
      // caller to write and nothing to sweep for. Deriving the literal
      // `default` put the KEYWORD into the alternation: measured 49 unrelated
      // files reported as rotation callers, with the file actually holding the
      // default export not among them. Both halves are pinned here because the
      // fix is one `continue` and the failure it prevents is silent-by-volume.
      const bare = rotationEntryPoints('export function realDoor() {}\n', "export { default } from './rotate.js'")
      expect(bare).toContain('realDoor')
      expect(bare).not.toContain('default')

      const entryRe = new RegExp(`\\b(?:${bare.map(escapeForAlternation).join('|')})\\b`)
      expect(entryRe.test('switch (x) { default: break }')).toBe(false)
      expect(entryRe.test('someone calls realDoor() from outside')).toBe(true)

      // The sibling clause is NOT skipped: an alias is a real, writable name.
      const aliased = rotationEntryPoints(
        'export function realDoor() {}\n',
        "export { default as rotationDefaultDoor } from './rotate.js'",
      )
      expect(aliased).toContain('rotationDefaultDoor')

      // And the same rule on the OTHER side of `as`. This clause is valid
      // TypeScript and its alias is the keyword. Guarding only the bare form
      // left it open. Both sides are pinned so neither can regress alone.
      const aliasedToDefault = rotationEntryPoints(
        'export function realDoor() {}\n',
        "export { rotateSession as default } from './rotate.js'",
      )
      expect(aliasedToDefault).toContain('realDoor')
      expect(aliasedToDefault).not.toContain('default')
    })

    it('a `$` inside a derived name is escaped, not read as a truncated end-of-string anchor', () => {
      const doors = rotationEntryPoints('export function rotate$Door() {}\nexport function otherDoor() {}\n', '')
      expect(doors).toContain('rotate$Door')

      const entryRe = new RegExp(`\\b(?:${doors.map(escapeForAlternation).join('|')})\\b`)
      expect(entryRe.test('someone calls rotate$Door() from outside')).toBe(true)
      // The bug this guards against: an unescaped `$` turns "rotate$Door"
      // into an alternative that can never match anything (an end-of-string
      // assertion stranded mid-pattern), and a truncated capture of just
      // "rotate" would instead over-match this ordinary sentence.
      expect(entryRe.test('the wheel began to rotate slowly')).toBe(false)
    })

    it('EXECUTED: a door declared `export let` (not `const`) still turns the law red, and an ordinary import stays green', async () => {
      const syntheticRotate = 'export let sideDoor = async () => {}\n'
      const entryRe = new RegExp(
        `\\b(?:${rotationEntryPoints(syntheticRotate, '').map(escapeForAlternation).join('|')})\\b`,
      )

      const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-let-door-fixture-'))
      try {
        const recorderDir = path.join(fixtureRoot, 'recorder')
        const rotateFile = path.join(recorderDir, 'rotate.ts')
        await mkdir(recorderDir, { recursive: true })
        await writeFile(rotateFile, syntheticRotate)

        const offender = path.join(fixtureRoot, 'sneaky-collector.ts')
        await writeFile(offender, "import { sideDoor } from './recorder/rotate.js'\n\nvoid sideDoor()\n")
        // CONTROL: an ordinary file with nothing to do with rotation.
        const control = path.join(fixtureRoot, 'innocent.ts')
        await writeFile(control, 'export const nothing = 1\n')

        const violations = rotationViolationsFor({
          searchRoot: fixtureRoot,
          recorderDir,
          rotateFile,
          entryRe,
          allowedCallers: new Set(),
        })

        expect(violations).toEqual([path.relative(REPO_ROOT, offender)])
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true })
      }
    })

    it('EXECUTED: a door republished as a BARE default is caught through the barrel, and names the importer', async () => {
      // The gap this closes: an anonymous default has no name for the sweep to
      // find, and the importer writes the BARREL's specifier, not `rotate.ts`'s,
      // so neither original arm can see it. Before this arm existed the whole
      // scenario passed silently — proven by the disarmed control below, which
      // is the same offender against a barrel that does not carry the default.
      const syntheticRotate = 'export default function anonymousDoor() {}\n'
      const syntheticBarrel = "export { default } from './rotate.js'\n"
      const entryRe = new RegExp(
        `\\b(?:${rotationEntryPoints(syntheticRotate, syntheticBarrel).map(escapeForAlternation).join('|')})\\b`,
      )

      const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-barrel-default-fixture-'))
      try {
        const recorderDir = path.join(fixtureRoot, 'recorder')
        const rotateFile = path.join(recorderDir, 'rotate.ts')
        const barrelFile = path.join(recorderDir, 'index.ts')
        await mkdir(recorderDir, { recursive: true })
        await writeFile(rotateFile, syntheticRotate)
        await writeFile(barrelFile, syntheticBarrel)

        const offender = path.join(fixtureRoot, 'sneaky-collector.ts')
        await writeFile(offender, "import Whatever from './recorder/index.js'\n\nvoid Whatever()\n")
        // CONTROL: a NAMED import of the same barrel binds no default.
        await writeFile(
          path.join(fixtureRoot, 'named-import.ts'),
          "import { somethingElse } from './recorder/index.js'\n\nvoid somethingElse\n",
        )
        // CONTROL: an ordinary file with nothing to do with rotation.
        await writeFile(path.join(fixtureRoot, 'innocent.ts'), 'export const nothing = 1\n')

        const violations = rotationViolationsFor({
          searchRoot: fixtureRoot,
          recorderDir,
          rotateFile,
          entryRe,
          allowedCallers: new Set(),
          barrelFile,
        })

        // Exactly the guilty file. The failure this replaces named 49 innocent
        // files and left this one out.
        expect(violations).toEqual([path.relative(REPO_ROOT, offender)])
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true })
      }
    })

    it('EXECUTED: the barrel-default arm stays disarmed when the barrel does not carry rotation\'s default', async () => {
      // Same offender SHAPE as above — a default import of the barrel — against
      // a barrel that republishes a NAMED export instead. Nothing unnamed is
      // reachable, so refusing here would be refusing an ordinary default
      // import of an ordinary barrel.
      const syntheticRotate = 'export function realDoor() {}\n'
      const syntheticBarrel = "export { realDoor } from './rotate.js'\n"
      const entryRe = new RegExp(
        `\\b(?:${rotationEntryPoints(syntheticRotate, syntheticBarrel).map(escapeForAlternation).join('|')})\\b`,
      )

      const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-barrel-disarmed-fixture-'))
      try {
        const recorderDir = path.join(fixtureRoot, 'recorder')
        const rotateFile = path.join(recorderDir, 'rotate.ts')
        const barrelFile = path.join(recorderDir, 'index.ts')
        await mkdir(recorderDir, { recursive: true })
        await writeFile(rotateFile, syntheticRotate)
        await writeFile(barrelFile, syntheticBarrel)

        await writeFile(
          path.join(fixtureRoot, 'default-importer.ts'),
          "import Whatever from './recorder/index.js'\n\nvoid Whatever\n",
        )

        const violations = rotationViolationsFor({
          searchRoot: fixtureRoot,
          recorderDir,
          rotateFile,
          entryRe,
          allowedCallers: new Set(),
          barrelFile,
        })

        expect(violations).toEqual([])
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true })
      }
    })

    it('EXECUTED: a type-only import reaches nothing at runtime and is not a caller, while a value import of the same module still is', async () => {
      // TypeScript erases `import type`. Counting it made the law name a file
      // that provably cannot invoke anything. The third fixture is the one that
      // matters: a file importing the SAME module both ways must stay caught,
      // which a specifier blacklist would get wrong and a position range gets
      // right.
      const syntheticRotate = 'export function realDoor() {}\nexport interface Boundary { at: number }\n'
      const entryRe = new RegExp(
        `\\b(?:${rotationEntryPoints(syntheticRotate, '').map(escapeForAlternation).join('|')})\\b`,
      )

      const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-type-only-fixture-'))
      try {
        const recorderDir = path.join(fixtureRoot, 'recorder')
        const rotateFile = path.join(recorderDir, 'rotate.ts')
        await mkdir(recorderDir, { recursive: true })
        await writeFile(rotateFile, syntheticRotate)

        // Erased: names no door, imports only a type.
        await writeFile(
          path.join(fixtureRoot, 'type-only.ts'),
          "import type { Boundary } from './recorder/rotate.js'\n\nexport const b: Boundary | undefined = undefined\n",
        )
        // Erased, multi-line spelling.
        await writeFile(
          path.join(fixtureRoot, 'type-only-multiline.ts'),
          "import type {\n  Boundary,\n} from './recorder/rotate.js'\n\nexport const c: Boundary | undefined = undefined\n",
        )
        // CAUGHT: same module, both ways. The value edge must survive.
        const mixed = path.join(fixtureRoot, 'mixed.ts')
        await writeFile(
          mixed,
          "import type { Boundary } from './recorder/rotate.js'\n" +
            "import { realDoor } from './recorder/rotate.js'\n\n" +
            'export const d: Boundary | undefined = undefined\nvoid realDoor\n',
        )

        const violations = rotationViolationsFor({
          searchRoot: fixtureRoot,
          recorderDir,
          rotateFile,
          entryRe,
          allowedCallers: new Set(),
        })

        expect(violations).toEqual([path.relative(REPO_ROOT, mixed)])
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true })
      }
    })

    it('EXECUTED: a barrel alias of an existing door still turns the law red, under the alias name, and an ordinary import stays green', async () => {
      const syntheticRotate = 'export async function realDoor() {}\n'
      const syntheticBarrel = "export { realDoor as reserveTheBoundary } from './rotate.js'\n"
      const entryRe = new RegExp(
        `\\b(?:${rotationEntryPoints(syntheticRotate, syntheticBarrel).map(escapeForAlternation).join('|')})\\b`,
      )

      const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-barrel-alias-fixture-'))
      try {
        const recorderDir = path.join(fixtureRoot, 'recorder')
        const rotateFile = path.join(recorderDir, 'rotate.ts')
        await mkdir(recorderDir, { recursive: true })
        await writeFile(rotateFile, syntheticRotate)
        await writeFile(path.join(recorderDir, 'index.ts'), syntheticBarrel)

        const offender = path.join(fixtureRoot, 'sneaky-collector.ts')
        await writeFile(
          offender,
          "import { reserveTheBoundary } from './recorder/index.js'\n\nvoid reserveTheBoundary()\n",
        )
        // CONTROL: an ordinary file with nothing to do with rotation.
        const control = path.join(fixtureRoot, 'innocent.ts')
        await writeFile(control, 'export const nothing = 1\n')

        const violations = rotationViolationsFor({
          searchRoot: fixtureRoot,
          recorderDir,
          rotateFile,
          entryRe,
          allowedCallers: new Set(),
        })

        expect(violations).toEqual([path.relative(REPO_ROOT, offender)])
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true })
      }
    })

    it('EXECUTED: an unnamed default export is caught by import edge, under any local name the caller chooses, and an ordinary import stays green', async () => {
      const syntheticRotate = ['export async function realDoor() {}', 'export default class {}'].join('\n')
      const entryRe = new RegExp(
        `\\b(?:${rotationEntryPoints(syntheticRotate, '').map(escapeForAlternation).join('|')})\\b`,
      )

      const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-default-export-fixture-'))
      try {
        const recorderDir = path.join(fixtureRoot, 'recorder')
        const rotateFile = path.join(recorderDir, 'rotate.ts')
        await mkdir(recorderDir, { recursive: true })
        await writeFile(rotateFile, syntheticRotate)

        const offender = path.join(fixtureRoot, 'sneaky-collector.ts')
        await writeFile(offender, "import WhateverNameIWant from './recorder/rotate.js'\n\nnew WhateverNameIWant()\n")
        // CONTROL: an ordinary file with nothing to do with rotation.
        const control = path.join(fixtureRoot, 'innocent.ts')
        await writeFile(control, 'export const nothing = 1\n')

        // By name alone the offender is invisible — there is no name to
        // derive from an anonymous default export. This is the gap the
        // import-edge check exists to close.
        expect(entryRe.test(readFileSync(offender, 'utf8'))).toBe(false)

        const violations = rotationViolationsFor({
          searchRoot: fixtureRoot,
          recorderDir,
          rotateFile,
          entryRe,
          allowedCallers: new Set(),
        })

        expect(violations).toEqual([path.relative(REPO_ROOT, offender)])
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true })
      }
    })

    it('no collector and no poll loop is among them — stated by name, not left to the sweep', () => {
      const shouldNeverRotate = [
        path.join(SERVER_SRC, 'server', 'poll-loop.ts'),
        path.join(SERVER_SRC, 'collectors', 'sessionlog', 'collector.ts'),
        path.join(SERVER_SRC, 'collectors', 'git', 'git-collector.ts'),
      ]
      for (const file of shouldNeverRotate) {
        expect(ROTATION_ENTRY_RE.test(readFileSync(file, 'utf8')), `${file} reaches rotation`).toBe(false)
      }
    })

    it('no web source file imports the recorder module — the button asks the server, it does not write', () => {
      const violations: string[] = []
      for (const file of walkSourceFiles(WEB_SRC)) {
        const source = readFileSync(file, 'utf8')
        if (/from\s+['"][^'"]*server\/src\/recorder|\brecorder\/(?:rotate|session-recorder|session-log-writer)/.test(source)) {
          violations.push(path.relative(REPO_ROOT, file))
        }
      }
      expect(violations).toEqual([])
    })
  })

  describe('the recorder has no clock of its own', () => {
    it('no source file in the module schedules work — rotation never runs without a human', () => {
      const offenders: string[] = []
      for (const file of recorderSourceFiles()) {
        if (/\b(?:setInterval|setTimeout|setImmediate)\s*\(/.test(readFileSync(file, 'utf8'))) {
          offenders.push(path.relative(REPO_ROOT, file))
        }
      }
      expect(offenders).toEqual([])
    })

    it('that detector bites', () => {
      expect(/\b(?:setInterval|setTimeout|setImmediate)\s*\(/.test('setInterval(() => rotate(), 3_600_000)')).toBe(
        true,
      )
    })
  })
})

/** Shared by every "live" describe below (a plain rotation's one dir, a retarget's two). */
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** Every path under `dir`: directories by name, files by content hash. */
function fingerprint(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const visit = (current: string) => {
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry)
      const relative = path.relative(dir, full)
      const info = statSync(full)
      if (info.isDirectory()) {
        out.set(relative, 'dir')
        visit(full)
      } else {
        out.set(relative, createHash('sha1').update(readFileSync(full)).digest('hex'))
      }
    }
  }
  visit(dir)
  return out
}

interface TreeDiff {
  added: string[]
  changed: string[]
  removed: string[]
}

function diff(before: Map<string, string>, after: Map<string, string>): TreeDiff {
  const added: string[] = []
  const changed: string[] = []
  const removed: string[] = []
  for (const [key, value] of after) {
    const previous = before.get(key)
    if (previous === undefined) added.push(key)
    else if (previous !== value) changed.push(key)
  }
  for (const key of before.keys()) {
    if (!after.has(key)) removed.push(key)
  }
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() }
}

/**
 * The live half. Everything above reads source text; this rotates for real and
 * asserts, by hashing every file in a temp root before and after, that ruling
 * 2's fence held: the session directory changed, and nothing else did.
 *
 * Hermetic under 4x concurrency: one `mkdtemp` root per test, ids derived from
 * the test's own pinned clock, no reliance on the ambient `~`.
 */
describe('the recorder namespace law, live (prd16 ruling 2)', () => {
  let root: string
  let repoDir: string
  let dataRoot: string
  let sessionDir: string
  let claudeProjectsRoot: string
  let recorder: SessionRecorder

  const FIRST_SESSION = '1000'
  const ROTATE_AT = 2000

  /**
   * prd16 ruling 2's namespace, as a path predicate over the whole temp root:
   * this repo's own session directory under the data root, and nothing else.
   * Not "anywhere under the data root" — a rotation that wrote into another
   * repo's session dir would be just as much a trespass as one that wrote into
   * the repo.
   */
  function isAllowedWrite(relative: string): boolean {
    const allowed = path.relative(root, sessionDir)
    return relative === allowed || relative.startsWith(`${allowed}${path.sep}`)
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-recorder-law-test-'))
    repoDir = path.join(root, 'repo')
    dataRoot = path.join(root, 'data')
    claudeProjectsRoot = path.join(root, 'claude-projects')
    sessionDir = sessionDirFor(repoDir, dataRoot)

    await mkdir(repoDir, { recursive: true })
    git(['init', '-b', 'main'], repoDir)
    git(['config', 'user.email', 'test@example.com'], repoDir)
    git(['config', 'user.name', 'Test'], repoDir)
    await writeFile(path.join(repoDir, 'tracked.txt'), 'v1\n')
    git(['add', '.'], repoDir)
    git(['commit', '-m', 'initial commit'], repoDir)
    // A dirty tree and an untracked file: what the observer is watching when an
    // operator hits "end session · start fresh" mid-run.
    await writeFile(path.join(repoDir, 'tracked.txt'), 'v2 dirty\n')
    await writeFile(path.join(repoDir, 'untracked.txt'), 'new\n')

    // A stand-in `~/.claude/projects`: transcripts rotation must not touch
    // (capturing them is prd16 ruling 3, a later wave, and a copy INTO the
    // data dir even then — never a write here).
    await mkdir(path.join(claudeProjectsRoot, 'a-project'), { recursive: true })
    await writeFile(path.join(claudeProjectsRoot, 'a-project', `${randomUUID()}.jsonl`), '{"type":"user"}\n')

    // A session already being recorded, with a live lock beside it.
    recorder = new SessionRecorder(FIRST_SESSION, sessionFilePath(sessionDir, FIRST_SESSION))
    await recorder.record(
      createEvent(
        'session.started',
        { sessionId: FIRST_SESSION, repoPath: repoDir, repoName: 'repo' },
        { id: 'evt-000001', ts: Number(FIRST_SESSION) },
      ),
    )
    await writeSessionLock(sessionDir, FIRST_SESSION, process.pid, Number(FIRST_SESSION))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function rotate() {
    return rotateSession({
      sessionDir,
      repoPath: repoDir,
      repoName: 'repo',
      recorder,
      now: () => ROTATE_AT,
      pid: process.pid,
    })
  }

  it("writes ONLY inside this repo's own session directory — nothing else in the tree moves", async () => {
    const before = fingerprint(root)

    await rotate()

    const { added, changed, removed } = diff(before, fingerprint(root))
    // Otherwise every assertion below would pass vacuously.
    expect(added.length).toBeGreaterThan(0)
    expect(changed.length).toBeGreaterThan(0)
    expect(removed.length).toBeGreaterThan(0)

    expect([...added, ...changed, ...removed].filter((entry) => !isAllowedWrite(entry))).toEqual([])
  })

  it('that fence bites — a write anywhere else in the tree would be caught', () => {
    expect(isAllowedWrite(path.join('repo', 'notes.md'))).toBe(false)
    expect(isAllowedWrite(path.join('repo', '.git', 'refs', 'heads', 'main'))).toBe(false)
    expect(isAllowedWrite(path.join('claude-projects', 'a-project', 'x.jsonl'))).toBe(false)
    // Another repo's recordings, under the same data root, are still not ours.
    expect(isAllowedWrite(path.join('data', 'other-repo-deadbeef', 'session-1.jsonl'))).toBe(false)
    // …and the three writes the ruling grants are all inside one directory.
    const mine = path.relative(root, sessionDir)
    expect(isAllowedWrite(path.join(mine, 'session-1000.jsonl'))).toBe(true)
    expect(isAllowedWrite(path.join(mine, 'session-2000.jsonl'))).toBe(true)
    expect(isAllowedWrite(path.join(mine, 'session-2000.lock.json'))).toBe(true)
  })

  it("leaves the watched repo's working tree and every ref byte-for-byte as it found them", async () => {
    const statusBefore = git(['status', '--porcelain'], repoDir)
    const refsBefore = git(['for-each-ref', '--format=%(refname) %(objectname)'], repoDir)
    const treeBefore = fingerprint(repoDir)

    await rotate()

    expect(git(['status', '--porcelain'], repoDir)).toBe(statusBefore)
    expect(git(['for-each-ref', '--format=%(refname) %(objectname)'], repoDir)).toBe(refsBefore)
    expect(diff(treeBefore, fingerprint(repoDir))).toEqual({ added: [], changed: [], removed: [] })
  })

  it('leaves ~/.claude untouched — a recording is written, never a transcript', async () => {
    const before = fingerprint(claudeProjectsRoot)
    await rotate()
    expect(diff(before, fingerprint(claudeProjectsRoot))).toEqual({ added: [], changed: [], removed: [] })
  })

  it('and what it DID write is a closed log, a fresh log, and one lock — nothing more', async () => {
    const rotation = await rotate()

    const entries = readdirSync(sessionDir).sort()
    expect(entries).toEqual([
      `session-${FIRST_SESSION}.jsonl`,
      `session-${ROTATE_AT}.jsonl`,
      `session-${ROTATE_AT}.lock.json`,
    ])
    expect(rotation.closed.sessionId).toBe(FIRST_SESSION)
    expect(rotation.opened.sessionId).toBe(String(ROTATE_AT))

    // The closed log ends where the operator said it did, and the new one begins.
    const closed = await readSessionEvents(rotation.closed.filePath)
    expect(closed.map((event) => event.type)).toEqual(['session.started', 'session.closed'])
    const opened = await readSessionEvents(rotation.opened.filePath)
    expect(opened.map((event) => event.type)).toEqual(['session.started'])

    // The lock names the new session and this process — not the closed one.
    const lock = JSON.parse(await readFile(path.join(sessionDir, `session-${ROTATE_AT}.lock.json`), 'utf8')) as {
      pid: number
    }
    expect(lock.pid).toBe(process.pid)
  })
})

/**
 * THE RETARGET EXTENSION (prd20 ruling 5). Everything above reasons about ONE
 * session directory, because a plain rotation never touches a second one. A
 * retarget does — `retargetSession` closes against the OLD repo's directory
 * and opens against the NEW repo's — so the fence this file asserts has to
 * widen to "the union of exactly two session directories, and nothing else,"
 * not "one directory, wherever it happens to be."
 */
describe('the recorder namespace law, live — retargeting crosses two session dirs (prd20 ruling 5)', () => {
  let root: string
  let oldRepoDir: string
  let newRepoDir: string
  let dataRoot: string
  let oldSessionDir: string
  let newSessionDir: string
  let recorder: SessionRecorder

  const FIRST_SESSION = '1000'
  const RETARGET_AT = 2000

  /** The union of BOTH session directories — a retarget's namespace, never a third. */
  function isAllowedWrite(relative: string): boolean {
    const allowedDirs = [path.relative(root, oldSessionDir), path.relative(root, newSessionDir)]
    return allowedDirs.some((allowed) => relative === allowed || relative.startsWith(`${allowed}${path.sep}`))
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-retarget-law-test-'))
    oldRepoDir = path.join(root, 'old-repo')
    newRepoDir = path.join(root, 'new-repo')
    dataRoot = path.join(root, 'data')
    oldSessionDir = sessionDirFor(oldRepoDir, dataRoot)
    newSessionDir = sessionDirFor(newRepoDir, dataRoot)

    for (const [dir, name] of [
      [oldRepoDir, 'old'],
      [newRepoDir, 'new'],
    ] as const) {
      await mkdir(dir, { recursive: true })
      git(['init', '-b', 'main'], dir)
      git(['config', 'user.email', 'test@example.com'], dir)
      git(['config', 'user.name', 'Test'], dir)
      await writeFile(path.join(dir, 'tracked.txt'), `${name} v1\n`)
      git(['add', '.'], dir)
      git(['commit', '-m', 'initial commit'], dir)
    }

    recorder = new SessionRecorder(FIRST_SESSION, sessionFilePath(oldSessionDir, FIRST_SESSION))
    await recorder.record(
      createEvent(
        'session.started',
        { sessionId: FIRST_SESSION, repoPath: oldRepoDir, repoName: 'old-repo' },
        { id: 'evt-000001', ts: Number(FIRST_SESSION) },
      ),
    )
    await writeSessionLock(oldSessionDir, FIRST_SESSION, process.pid, Number(FIRST_SESSION))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function retarget() {
    return retargetSession({
      oldSessionDir,
      oldRepoPath: oldRepoDir,
      newSessionDir,
      newRepoPath: newRepoDir,
      newRepoName: 'new-repo',
      recorder,
      now: () => RETARGET_AT,
      pid: process.pid,
    })
  }

  it('writes ONLY inside the old and new session directories — nothing else in the tree moves, and no third directory appears', async () => {
    const before = fingerprint(root)

    await retarget()

    const { added, changed, removed } = diff(before, fingerprint(root))
    expect(added.length).toBeGreaterThan(0)
    // Otherwise the assertion below would pass vacuously.
    expect([...added, ...changed, ...removed].filter((entry) => !isAllowedWrite(entry))).toEqual([])
  })

  it("leaves BOTH watched repos' working trees and refs byte-for-byte as it found them", async () => {
    const oldTreeBefore = fingerprint(oldRepoDir)
    const newTreeBefore = fingerprint(newRepoDir)
    const oldRefsBefore = git(['for-each-ref', '--format=%(refname) %(objectname)'], oldRepoDir)
    const newRefsBefore = git(['for-each-ref', '--format=%(refname) %(objectname)'], newRepoDir)

    await retarget()

    expect(diff(oldTreeBefore, fingerprint(oldRepoDir))).toEqual({ added: [], changed: [], removed: [] })
    expect(diff(newTreeBefore, fingerprint(newRepoDir))).toEqual({ added: [], changed: [], removed: [] })
    expect(git(['for-each-ref', '--format=%(refname) %(objectname)'], oldRepoDir)).toBe(oldRefsBefore)
    expect(git(['for-each-ref', '--format=%(refname) %(objectname)'], newRepoDir)).toBe(newRefsBefore)
  })

  it('closes the old session in its own directory and opens the new one in a directory of its own — never the same directory for both', async () => {
    const rotation = await retarget()

    expect(oldSessionDir).not.toBe(newSessionDir)
    expect(readdirSync(oldSessionDir).sort()).toEqual([`session-${FIRST_SESSION}.jsonl`])
    expect(readdirSync(newSessionDir).sort()).toEqual([
      `session-${RETARGET_AT}.jsonl`,
      `session-${RETARGET_AT}.lock.json`,
    ])

    const closed = await readSessionEvents(rotation.closed.filePath)
    expect(closed.map((event) => event.type)).toEqual(['session.started', 'session.closed'])
    expect(closed.at(-1)).toMatchObject({
      payload: { reason: 'retargeted', successor: { repoSlug: path.basename(newSessionDir) } },
    })

    const opened = await readSessionEvents(rotation.opened.filePath)
    expect(opened.map((event) => event.type)).toEqual(['session.started'])
    expect(opened[0]).toMatchObject({
      payload: {
        repoPath: newRepoDir,
        predecessor: { repoSlug: path.basename(oldSessionDir), sessionId: FIRST_SESSION },
      },
    })

    // No lock left behind in the old repo's directory — the close half releases
    // it before the open half ever claims one, in the new directory only.
    expect(readdirSync(oldSessionDir).some((name) => name.endsWith('.lock.json'))).toBe(false)
  })
})
