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
 * Whether every specifier in a named clause is an INLINE `type` specifier, so
 * the whole statement erases. `{ type A, type B as C }` does; `{ type A, run }`
 * does not — one value specifier keeps the statement's runtime edge.
 */
function clauseIsEntirelyTypeSpecifiers(clause: string): boolean {
  const specifiers = clause
    .split(',')
    .map((specifier) => specifier.trim())
    .filter((specifier) => specifier.length > 0)
  return specifiers.length > 0 && specifiers.every((specifier) => /^type\b/.test(specifier))
}

/**
 * The byte ranges of every ERASED module statement — `import type …from '…'`
 * and `export type …from '…'`, and their inline twins `import { type A } …` /
 * `export { type A } …` whose every specifier is tagged `type`. TypeScript
 * erases all four: no runtime edge exists, so a file whose only reference to
 * rotation is a type cannot invoke it.
 *
 * The inline form is covered because it is this repo's dominant spelling — 234
 * files use it, and `biome.json`'s `preset: none` enables no `useImportType`
 * rule to force the separated one. Guarding only the separated form was a
 * half-fix of exactly the shape the `as` guard above already had to close
 * twice: one spelling of an erased import handled, its sibling left to trip
 * the law against a file that provably cannot call anything.
 *
 * Position ranges rather than a specifier blacklist, deliberately: a file may
 * import the same module BOTH ways —
 * `import type { Rotation } from './x.js'` beside `import { doThing } from './x.js'`
 * — and subtracting by specifier string would drop the real value edge along
 * with the erased one.
 *
 * `[^'"`]*?` spans newlines so a multi-line `import type { A,\n B,\n }` is one
 * range, and stops at the first quote so it cannot run past its own `from`.
 *
 * DECLARED RESIDUAL, shared with `codeOf` above (#174): neither this file nor
 * `codeOf` is string-literal-aware, so a STRING containing the text
 * `export function ghost() {}` is read as real source once `codeOf` strips
 * what it thinks are comments around it. In THAT direction it fails CLOSED —
 * it derives a phantom name that then still has to be found some other way to
 * matter — and the CONTROL below pins exactly that case.
 *
 * The family does NOT fail closed in general, and this comment claimed it did
 * until the wave-11 verify falsified it. Two members drop a REAL export:
 *
 *   `const url = "//x"; export function real() {}`  -> []   (control: ["real"])
 *   a `/*` inside a string swallows to the next `*\/` ANYWHERE in the file,
 *   because codeOf's block strip is non-greedy but crosses newlines
 *
 * Both need the comment token INSIDE a string literal, and the `//` form needs
 * the export on the SAME LINE. EXECUTED at wave-11: zero occurrences of either
 * in any non-test recorder source, so this is unreachable today rather than
 * live. It is written down because "fails CLOSED" is what a future author
 * reads when deciding the residual is safe to keep, and for these two forms
 * that is false. A fix needs a string-literal-aware scanner, a materially
 * bigger tool than the crude, legible regexes here.
 */
function typeOnlyImportRanges(code: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = []
  for (const match of code.matchAll(/\b(?:import|export)\s+type\b[^'"`]*?\bfrom\s*(['"`])[^'"`]*\1/g)) {
    if (match.index !== undefined) ranges.push([match.index, match.index + match[0].length] as const)
  }
  // The inline twin: `import { type A } from '…'`. `\s*\{` cannot match
  // `import X, {` or `import type {`, so a default binding still keeps its
  // value edge and the separated form is not double-counted.
  for (const match of code.matchAll(/\b(?:import|export)\s*\{([^}]*)\}\s*from\s*(['"`])[^'"`]*\2/g)) {
    if (match.index === undefined) continue
    if (!clauseIsEntirelyTypeSpecifiers(match[1] ?? '')) continue
    ranges.push([match.index, match.index + match[0].length] as const)
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
 * Every `export type { … } from '…'` re-export clause in a barrel.
 *
 * Deliberately a SECOND constant rather than a widening of the one above:
 * `BARREL_REEXPORT_RE` also feeds #87's door law, and perturbing a pattern two
 * laws share to fix one of them is how a repair opens the next defect. The two
 * are disjoint by construction — `export\s*\{` cannot match `export type {`,
 * so nothing is counted twice.
 *
 * Without this, a barrel written `export type { Rotation } from './rotate.js'`
 * — the spelling 12 of this repo's own `index.ts` barrels use, including
 * `packages/server/src/index.ts` — reported every republished type as MISSING.
 * A false positive whose fastest apparent fix is weakening the guard.
 */
const BARREL_TYPE_REEXPORT_RE = /export\s+type\s*\{([^}]*)\}\s*from\s*(['"`])([^'"`]*)\2/g

/**
 * Whether a module specifier points at rotation's module — a SIBLING match,
 * not a basename one: `path.basename('../elsewhere/rotate.js')` is also
 * `'rotate'`, so a basename-only check credited `export { X } from
 * '../elsewhere/rotate.js'` as a republish of rotation's `X` (EXECUTED, #174:
 * `barrelReexportedRotateNames` derived `["RealError"]` from exactly that
 * clause, crediting a file two directories over as if it were `rotate.ts`
 * itself). Every real caller — the recorder barrel, and every synthetic
 * fixture in this file — writes rotation's module as `./rotate` from the file
 * that imports it, so an exact match on the three spellings of that sibling
 * reference is precise where a basename match was not, and loses no real
 * coverage. Factored so the name derivation and the barrel-default edge below
 * cannot drift apart: a re-derived copy of a resolver one screen from its
 * original is exactly the divergence a review pass found in
 * `resolveRelativeSpecifier`.
 */
function specifierTargetsRotate(specifier: string): boolean {
  return specifier === './rotate' || specifier === './rotate.js' || specifier === './rotate.ts'
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
 *  - `rotate.ts`'s own value-export declarations — `function`, `function*`,
 *    `class`, `const`, `let`, `var` — and any LOCAL `export { a, b as c }`
 *    clause.
 *
 *    The `function` branch is split from the rest rather than sharing one
 *    trailing `\s+`: a generator writes its `*` between the keyword and the
 *    name, so `function\s+` alone derives no door at all from
 *    `export function* gen()`. The lazier repair — one `function\s*\*?\s*`
 *    branch — would also derive `foo` from the non-declaration text
 *    `export functionfoo`, so the starred form gets its own alternative and
 *    the bare form keeps its mandatory space.
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
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*\s*|function\s+|(?:class|const|let|var)\s+)([\w$]+)/g,
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

/**
 * THE BARREL COMPLETENESS GUARD (#154). `rotationEntryPoints` above is
 * deliberately type-blind — an erased `type` export reaches nothing at
 * runtime, so it is not a rotation door — but a TYPE drifting out of the
 * barrel is still a completeness gap, just never a reachability one. This
 * pair of helpers is the type-AWARE sibling: every name `rotate.ts` exports,
 * value or type, by declaration or by local `export { … }` clause.
 *
 * Kept separate from `namesFromExportClause` / `rotationEntryPoints` rather
 * than adding an `includeTypes` flag to them: those two are load-bearing for
 * #87's law and this guard must not risk perturbing what they derive.
 */
function allNamesFromExportClause(clause: string): string[] {
  const names: string[] = []
  for (const raw of clause.split(',')) {
    const specifier = raw.trim().replace(/^type\s+/, '')
    if (!specifier || specifier === 'default') continue
    const asMatch = specifier.match(/^([\w$]+)\s+as\s+([\w$]+)$/)
    if (asMatch) {
      const alias = asMatch[2]
      if (alias && alias !== 'default') names.push(alias)
      continue
    }
    const bare = specifier.match(/^([\w$]+)$/)
    if (bare?.[1]) names.push(bare[1])
  }
  return names
}

/**
 * Every LOCAL binding name in a `const|let|var` declarator LIST — walking at
 * bracket/brace/paren depth 0 so `export const a = { x: 1 }, b = 2` splits
 * after the object literal rather than inside it, the same technique
 * `firstArguments` already uses for call arguments. Two declarator SHAPES: a
 * plain `name = value` (or bare `name`), and destructuring — `{ a, b }` or
 * `[a, b]` — read one level deep.
 *
 * A NESTED pattern (`{ a: { b } }`) contributes nothing rather than the wrong
 * thing: `[^{}]*` cannot cross the inner `{`, so the outer match fails
 * outright and the declarator falls through to the bare-identifier check,
 * which also fails since it starts with `{`. Reading only the outer key would
 * derive a name nobody can import; parsing it fully needs a real parser
 * rather than a comma split — the same call this file already makes for a
 * namespace default-import, in `defaultImportSpecifiers`'s own doc.
 *
 * Takes the RAW source and a start offset, not a pre-cut single-line string
 * (#185). The caller used to hand this function `([^\n;]*)`'s capture — text
 * already truncated at the first newline — so a declarator list wrapped
 * across lines never reached the depth walk below at all: `export const a =
 * {\n  x: 1,\n}, b = 2` derived only `["a"]`, silently dropping the real
 * binding `b`. The depth walk already treated `\n` as a terminator ONLY at
 * depth 0 — it was always able to span a multi-line object literal correctly,
 * it just never got the bytes past the first line to look at. Reading from
 * `source` directly is "change the instrument," not "widen the pattern": the
 * outer regex now matches only the keyword, and this function finds its own
 * terminator by walking, exactly as it already did one line at a time.
 *
 * CORRECTION to the issue's own framing, so it is not repeated: the issue
 * called this "ordinary `lineWidth: 100` formatting." That premise is FALSE —
 * `biome.json` sets `"formatter": { "enabled": false }` repo-wide, so nothing
 * here auto-wraps at any width, and no formatter emitted this shape. The
 * defect is real regardless: the form is legal TypeScript a person can type
 * by hand, and the bug is in what the guard does with it, not in how it got
 * written.
 *
 * A rest element (`{ a, ...rest }` / `[a, ...rest]`) is a REAL binding and is
 * derived, not skipped (#185). It used to be the one undocumented exclusion
 * in this function — `trimmed.startsWith('...')` skipped straight to the next
 * entry with no comment saying why, unlike the nested-pattern case above,
 * which explains itself. `...rest` cannot itself be a nested pattern (JS
 * requires a rest element's target to be a plain identifier), so stripping
 * the three dots and running the same bare-identifier check the plain
 * declarator branch uses is exact, not a heuristic.
 *
 * A SECOND wrapped-list shape survived the first fix, found by #185's own
 * review: `export const a = 1,\n  b = 2` — no bracket at all, the wrap sits
 * right after the comma. The bracket-depth walk was never the problem for
 * this one; `\n` at depth 0 is an unconditional terminator, and a comma
 * immediately followed by a newline hits that terminator before consuming
 * any of the next declarator, so `b` vanished the same way `b` vanished
 * before the first fix — the same production, defeated twice, which is
 * exactly the signal to change the instrument again rather than add a third
 * bracket-shaped patch. The instrument change: a `\n` at depth 0 is a
 * terminator UNLESS nothing but whitespace has been consumed since the last
 * split point (the statement start, or the last top-level comma) — which is
 * exactly the gap a trailing comma leaves before its newline, and nothing
 * else. This is narrower than "does the line end in a continuation
 * operator": it only ever fires in the empty space a comma just created, so
 * it cannot mistake an ordinary statement boundary for a continuation.
 *
 * Declared residual, still not closed by either fix: a declarator that
 * continues on the next line with NO preceding comma — `export const a =\n
 * 1` — still terminates early, at the `\n` right after `=`, because the text
 * since the last split (`a =`) is not all-whitespace. Closing it needs real
 * ASI-awareness (a line ending in a binary/assignment operator continues),
 * which is a materially different check from "is anything here yet" and was
 * not the shape #185's review measured. Unreachable in `rotate.ts` today;
 * written down because a reader who sees "wrapped lists are now handled"
 * should not assume this sibling shape is included.
 */
/**
 * An identifier is a BINDING only where a declarator can actually end or
 * continue: at the end of the declarator, or before `:` (a type annotation),
 * `=` (an initialiser), or `?`/`!` (optional / definite-assignment). An
 * unanchored `^([\w$]+)` accepted anything, and the depth walk above tracks
 * `{[(` but not `<`, quotes or a regex literal — so every comma those hide
 * split a declarator that is not one, and its first word was minted as an
 * export name:
 *
 *   `export const x: Map<string, number> = new Map()`  ->  ["x", "number"]
 *   `export const rec: Record<string, string> = {}`    ->  ["rec", "string"]
 *   `export const s = 'a,b'`                           ->  ["s", "b"]
 *
 * EXECUTED at review of #183, against 9b94ba6 and its parent: the parent
 * derived `["x"]` for all three (the alternation captured one identifier
 * after the keyword and stopped), so this arrived WITH the declarator-list
 * repair. It is the same failure the `const enum` arm two screens up was
 * written for — a phantom name the completeness guard then demands a barrel
 * republish, which is a red nobody can repair, since `number` is not a symbol
 * `rotate.ts` can export. Latent rather than live: `rotate.ts`'s single
 * `export const` today puts its `=` at end of line, and the capture feeding
 * this function stops at the newline.
 *
 * This is #185's "generic-type noise" row, already closed rather than a
 * residual to leave: it was filed as fails-CLOSED before this anchor existed,
 * and re-running the `Map<string, number>` case above (EXECUTED, wave-11)
 * confirms this guard already derives the exact set, not the noisy one — see
 * the exact-equality test below carrying the same source.
 *
 * Anchoring is the narrow half of the trade, and deliberately so: a
 * declarator this rejects contributes NOTHING rather than a wrong name,
 * which is the same call `declaratorListNames` already makes for a nested
 * destructuring pattern. Tracking `<` as depth is the wider half and is
 * wrong — `export const ok = a < b, also = 2` is a comparison, not a type
 * argument, and no lexer-free rule tells them apart.
 */
const DECLARATOR_BINDING_RE = /^([\w$]+)\s*(?:[:=?!]|$)/

function declaratorListNames(source: string, start: number): string[] {
  const declarators: string[] = []
  let depth = 0
  let declStart = start
  let i = start
  for (; i < source.length; i += 1) {
    const char = source[i]
    if (char === '{' || char === '[' || char === '(') depth += 1
    else if (char === '}' || char === ']' || char === ')') depth -= 1
    else if (char === ';' && depth === 0) break
    else if (char === '\n' && depth === 0) {
      // Nothing but whitespace since the statement start or the last
      // top-level comma is the gap a trailing comma leaves before its own
      // newline — not a statement end. Anything else here (a real
      // character already consumed) is a real terminator.
      if (!/^\s*$/.test(source.slice(declStart, i))) break
    } else if (char === ',' && depth === 0) {
      declarators.push(source.slice(declStart, i))
      declStart = i + 1
    }
  }
  declarators.push(source.slice(declStart, i))

  const names: string[] = []
  for (const raw of declarators) {
    const declarator = raw.trim()
    if (!declarator) continue
    const pattern = declarator.match(/^\{([^{}]*)\}/) ?? declarator.match(/^\[([^[\]]*)\]/)
    if (pattern) {
      for (const entry of (pattern[1] ?? '').split(',')) {
        const trimmed = entry.trim()
        if (!trimmed) continue
        if (trimmed.startsWith('...')) {
          // A rest element's target is always a plain identifier — JS syntax
          // forbids a nested pattern here — so the bare check alone is exact.
          const rest = trimmed.slice(3).trim().match(DECLARATOR_BINDING_RE)
          if (rest?.[1]) names.push(rest[1])
          continue
        }
        const renamed = trimmed.match(/^[\w$]+\s*:\s*([\w$]+)/)
        const bare = trimmed.match(DECLARATOR_BINDING_RE)
        const name = renamed?.[1] ?? bare?.[1]
        if (name) names.push(name)
      }
      continue
    }
    const bare = declarator.match(DECLARATOR_BINDING_RE)
    if (bare?.[1]) names.push(bare[1])
  }
  return names
}

/**
 * The LOCAL name rotate.ts gives whatever it exports as its default — via
 * `export default class D {}` / `export default function f() {}`, or the
 * named-clause spelling `export { x as default }`. Anonymous defaults
 * (`export default class {}`, `export default function () {}`) mint no name
 * and are excluded on purpose: there is nothing for a barrel's bare
 * `export { default } from './rotate.js'` to be credited AS.
 *
 * Feeds only the completeness guard's default-credit arm below. A `class`/
 * `function` default is already in `rotateModuleExportNames`'s general set —
 * the declaration regex derives its name regardless of `default` — so this
 * exists to reach the named-clause spelling too, and so BOTH spellings are
 * satisfied by the same barrel form rather than only one of them (#174: the
 * clause spelling derived `[]`, and the decl spelling's real name read as
 * missing from a barrel that in fact republished it under `default`).
 *
 * FIXED (#185, review round 2), not left as the narrower residual this doc
 * first described: the decl-spelling branch used to require `\s+` between an
 * optional generator `*` and the name (`function\s*\*?\s+`), while
 * `rotateModuleExportNames`'s general arm accepts a zero-width gap on both
 * sides of the star (`function\s*\*\s*`). `export default function*gen() {}`
 * (no space anywhere) derived nothing here, and that one under-matching
 * regex produced two OPPOSITE symptoms depending on which barrel credit path
 * used it:
 *
 *  - a bare `export { default } from './rotate.js'` got no credit for `gen`
 *    specifically, so the guard reported a gap that did not exist — fails
 *    CLOSED, a spurious gap, which is what this doc first, narrowly,
 *    described and the issue allowed leaving open.
 *  - a barrel's `export * from './rotate.js'` DOES forward `gen` under the
 *    star (real JS semantics: only a DEFAULT is excluded from `export *`),
 *    and the star-credit arm below subtracts real defaults from what it
 *    credits so a default isn't wrongly counted as forwarded — but with
 *    `gen` missing from THIS function's returned set, that subtraction never
 *    happens, and the star credits `gen` as satisfied by a barrel that (per
 *    real semantics) does not actually forward it. Fails OPEN: the guard
 *    reports no gap for a name that is not really reachable through that
 *    barrel. EXECUTED, review round 2.
 *
 * One regex made as permissive as its own sibling already is closes both:
 * `function\s*\*\s*` (matching the general arm exactly) rather than
 * `function\s*\*?\s+`.
 */
function defaultExportLocalNames(rotateSource: string): string[] {
  const names = new Set<string>()
  for (const match of rotateSource.matchAll(
    /\bexport\s+default\s+(?:async\s+)?(?:function\s*\*\s*|function\s+|class\s+)([\w$]+)/g,
  )) {
    if (match[1]) names.add(match[1])
  }
  for (const match of rotateSource.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/g)) {
    for (const raw of (match[1] ?? '').split(',')) {
      const asMatch = raw.trim().match(/^([\w$]+)\s+as\s+default$/)
      if (asMatch?.[1]) names.add(asMatch[1])
    }
  }
  return [...names]
}

/**
 * Every symbol — value or type — `rotate.ts` itself declares as an export.
 *
 * `abstract` sits BETWEEN `export` and `class`, and `enum`/`namespace` were
 * once absent from this alternation — so `export enum X`, `export namespace
 * X` and `export abstract class X` derived NO name, and a barrel omitting any
 * of them passed the completeness guard whose whole job is to notice. It
 * failed OPEN for three legal TypeScript forms. The enumerated grammar test
 * below is what forces this list; add the row there first.
 *
 * `declare` sits in the same position and gets the same optional treatment:
 * `export declare class D {}` / `export declare function f()` are ambient
 * declarations — no runtime code, like `type` — but the NAME they declare is
 * still public surface a barrel must carry, which is a different question
 * from whether a caller can reach it at runtime (`rotationEntryPoints`, #87's
 * law, is deliberately type/declare-blind for exactly that reason and is not
 * touched here).
 *
 * `const enum K { A }` is NOT handled by the alternation above: `const` is
 * followed by `enum`, and the generic `const\s+` branch would capture the
 * KEYWORD `enum` as the name, losing `K` entirely — the guard then also
 * demanded the barrel republish a symbol literally called `enum`, making a
 * genuine gap unreachable to repair (#174). It gets its own arm, matched
 * BEFORE the declarator-list arm below excludes it.
 *
 * `const|let|var` declarator LISTS — `export const a = 1, b = 2`, and
 * destructuring, `export const { a, b } = obj` / `export const [a, b] = arr`
 * — are NOT single identifiers, so they are carved out of the alternation
 * above (which only ever captured the first token after the keyword) and
 * read by `declaratorListNames` instead, which walks every declarator rather
 * than assuming there is exactly one (#174: `export const a = 1, b = 2`
 * derived only `a`, and either destructuring form derived nothing at all).
 */
function rotateModuleExportNames(rotateSource: string): string[] {
  const names = new Set<string>()
  for (const match of rotateSource.matchAll(
    /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\s*\*\s*|function\s+|(?:class|enum|namespace)\s+)([\w$]+)/g,
  )) {
    if (match[1]) names.add(match[1])
  }
  for (const match of rotateSource.matchAll(/\bexport\s+(?:declare\s+)?const\s+enum\s+([\w$]+)/g)) {
    if (match[1]) names.add(match[1])
  }
  // `(?:declare\s+)?` for the same reason the declaration arm above carries it:
  // `export declare const c: number` is public surface a barrel must republish,
  // and `declare` sitting between `export` and the keyword killed the match —
  // so it derived nothing while `declare class`/`declare function` derived.
  // Fail-OPEN, and the doc above claimed the general case (#174 verify).
  for (const match of rotateSource.matchAll(
    // `const(?!\s+enum\b)\s+`, NOT `const\s+(?!enum\b)`: with the lookahead
    // AFTER `\s+`, the quantifier backtracks — it gives one space back, the
    // lookahead then sees whitespace rather than `enum`, and the arm matches,
    // capturing the KEYWORD as a name. `export const  enum K {}` derived
    // ["K","enum"] and the guard demanded a barrel republish `enum`: the exact
    // unrepairable red state #174 was filed for, reachable from ordinary source
    // because `codeOf` replaces an inline block comment with the empty string
    // (`export const /* note */ enum D {}` -> two spaces). Anchoring the
    // lookahead directly after `const` cannot backtrack past it.
    //
    // No trailing capture group (#185): the list itself is no longer bounded
    // by this regex at all — `declaratorListNames` walks `rotateSource`
    // directly from where the keyword ends, so it can see past the first
    // newline. See that function's own doc for why.
    /\bexport\s+(?:declare\s+)?(?:const(?!\s+enum\b)\s+|let\s+|var\s+)/g,
  )) {
    const start = (match.index ?? 0) + match[0].length
    for (const name of declaratorListNames(rotateSource, start)) names.add(name)
  }
  // `export * as ns from '…'` mints a NAMESPACE export — a real name a barrel
  // must still republish for completeness, distinct from the barrel-side
  // ruling on `BARREL_STAR_REEXPORT_RE` below (#185). This arm is about
  // rotate.ts's OWN surface: if rotate.ts forwards another module as a
  // namespace, `ns` is a name that exists whether or not anyone credits a
  // namespace re-export on the barrel side. Before this arm, the form derived
  // nothing at all — not noise, an outright silent drop, since no alternation
  // anywhere in this function reached the `* as` shape.
  //
  // `export type * as ns from '…'` is the same arm's own TYPE sibling and is
  // matched by the same alternation (review of #185). It was the one form in
  // this family left silently undeclared: the value spelling derived `['ns']`
  // while the type spelling one keyword away derived `[]` — fails OPEN, since
  // `ns` is a real local export name either way and this function already
  // derives type-only names (`export type X`, `export interface X`) into the
  // same set. One optional keyword is the whole difference; it is the arm's
  // sibling case, not a new production. NOTE the asymmetry with bare `export type *
  // from` in the residual table below is the SAME asymmetry the value forms
  // already carry, and for the same reason: `as ns` names something locally,
  // a bare star names nothing.
  // `(?:\s*|\s+type\s+)` rather than `\s*(?:type\s+)?`: the first branch keeps
  // the value form's original zero-whitespace tolerance byte for byte, and the
  // second requires real whitespace BEFORE `type`, so widening cannot newly
  // match an identifier that merely starts with the keyword (`exporttype *`).
  for (const match of rotateSource.matchAll(
    /\bexport(?:\s*|\s+type\s+)\*\s*as\s+([\w$]+)\s*from\s*(['"`])[^'"`]*\2/g,
  )) {
    if (match[1]) names.add(match[1])
  }
  for (const match of rotateSource.matchAll(/\bexport\s+(?:declare\s+)?(?:interface|type)\s+([\w$]+)/g)) {
    if (match[1]) names.add(match[1])
  }
  for (const match of rotateSource.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/g)) {
    for (const name of allNamesFromExportClause(match[1] ?? '')) names.add(name)
  }
  // A SEPARATE arm, because the clause arm above cannot reach this shape: it
  // requires `export` then optional whitespace then `{`, and `export type {`
  // has a keyword in between. `export type { X }` therefore derived nothing —
  // the guard failed OPEN for a form 19 files in this repo already use, and
  // one `isolatedModules: true` actively nudges authors toward. Found by both
  // review seats in the wave-10 reconcile; the table above carries its rows.
  for (const match of rotateSource.matchAll(/\bexport\s+type\s*\{([^}]*)\}(?!\s*from)/g)) {
    for (const name of allNamesFromExportClause(match[1] ?? '')) names.add(name)
  }
  // rotate.ts forwarding a symbol FROM ANOTHER MODULE — `export { x } from
  // './helpers.js'` — is still part of ITS public surface: a caller reaches
  // it as `import { x } from './rotate.js'`, so a barrel wanting full
  // coverage still needs it. The local-clause arm above deliberately EXCLUDES
  // `from`-clauses (`(?!\s*from)`) — that exclusion is #87's own, for
  // reachability's `namesFromExportClause`, and completeness has no such
  // reason, so this arm exists precisely where that lookahead stops (#174).
  for (const match of rotateSource.matchAll(/export\s*\{([^}]*)\}\s*from\s*(['"`])([^'"`]*)\2/g)) {
    for (const name of allNamesFromExportClause(match[1] ?? '')) names.add(name)
  }
  // And its type-clause sibling, for the same reason the local arm needed one:
  // `export type { T } from './x.js'` has a keyword between `export` and `{`,
  // so the arm above cannot reach it and the type vanished from the derived
  // set. 15 non-test files in this repo use this spelling, 14 of them barrels
  // (#174 verify). The barrel side already carries a dedicated constant for it.
  for (const match of rotateSource.matchAll(
    /\bexport\s+type\s*\{([^}]*)\}\s*from\s*(['"`])([^'"`]*)\2/g,
  )) {
    for (const name of allNamesFromExportClause(match[1] ?? '')) names.add(name)
  }
  for (const name of defaultExportLocalNames(rotateSource)) names.add(name)
  return [...names]
}

/**
 * The SOURCE name a barrel's `export { a, b as c } from '…'` clause
 * republishes — the name BEFORE any `as`, which is what rotate.ts itself
 * calls the symbol. Completeness asks "is rotate.ts's OWN name still reached
 * through the barrel, under any spelling", the opposite question from a
 * module's own `export { a as c }`, where `c` IS the public name and
 * `allNamesFromExportClause` is right to derive the alias — sharing that
 * function for both was the bug row #174 found: `export { real as alias }
 * from './rotate.js'` derived `"alias"` and reported `"real"` MISSING from a
 * barrel that had actually republished it (EXECUTED: `barrelReexportedRotateNames`
 * returned `Set{"alias"}`, not `Set{"real"}`, against exactly that clause).
 * `type` is stripped exactly as `allNamesFromExportClause` strips it — the
 * inline mixed spelling this repo already uses is `export { realDoor, type
 * SecretOptions } from './rotate.js'`. A bare `default` (renamed or not)
 * passes through as the literal string `"default"`; the caller below treats
 * that as a SIGNAL rather than a name, since "default" is a reserved word no
 * real export can be called.
 */
function barrelReexportSourceNames(clause: string): string[] {
  const names: string[] = []
  for (const raw of clause.split(',')) {
    const specifier = raw.trim().replace(/^type\s+/, '')
    if (!specifier) continue
    const asMatch = specifier.match(/^([\w$]+)\s+as\s+[\w$]+$/)
    if (asMatch) {
      if (asMatch[1]) names.push(asMatch[1])
      continue
    }
    const bare = specifier.match(/^([\w$]+)$/)
    if (bare?.[1]) names.push(bare[1])
  }
  return names
}

/**
 * A barrel's `export * from '…'` — deliberately NOT `export * as ns from
 * …`: that spelling mints a NAMESPACE object rather than forwarding names
 * directly. `\s*from` sitting right after the `*` is what excludes the
 * namespace form without a lookahead: `export * as ns from` has `as ns`
 * between them, so this pattern simply never reaches that text.
 *
 * RULING (#185): a barrel's `export * as ns from './rotate.js'` does NOT
 * satisfy completeness for the names bundled inside `ns`, and this is a
 * decision, not an open question. Completeness means a name is reachable
 * from the barrel under ITS OWN identifier — `import { X } from
 * './index.js'` — which is the access path every real barrel in this repo
 * offers and the one #87's reachability law itself sweeps for by name. A
 * namespace object offers only `ns.X`, a structurally different access path
 * this guard has never verified and was never asked to. Crediting it would
 * let a barrel satisfy "complete" by wrapping rotation in a namespace nobody
 * calls by the names this guard is checking for, which defeats the guard's
 * own purpose more thoroughly than the gap it would be closing. The ruling
 * is enforced, not merely assumed: `barrelReexportedRotateNames` below never
 * reads `ns`'s contents, so `barrelCompletenessGaps` reports every rotate.ts
 * name as still missing even when a barrel carries this clause — pinned by
 * the CONTROL test below.
 */
const BARREL_STAR_REEXPORT_RE = /export\s*\*\s*from\s*(['"`])([^'"`]*)\1/g

/**
 * Every symbol — value or type — a barrel republishes from rotation's module,
 * by any of three spellings: a named `export { … } from` / `export type { …
 * } from` clause (credited by SOURCE name, see `barrelReexportSourceNames`
 * above), a bare `export { default } from` (credited against whatever
 * rotate.ts itself exports as default, see `defaultExportLocalNames` —
 * armed only when `rotateSource` is given), and a blanket `export * from`
 * (credited against every NON-DEFAULT name rotate.ts exports — real `export
 * *` semantics forward every named export but not the default, so the
 * default-credit set is subtracted rather than unioned in). `rotateSource` is
 * optional so the direct call sites that only ever ask "is THIS ONE named
 * export a real re-export clause" (never a bare-default or star one, #154's
 * own two checks) do not have to thread it through for nothing.
 */
function barrelReexportedRotateNames(barrelSource: string, rotateSource?: string): Set<string> {
  const names = new Set<string>()
  let sawBareDefault = false
  let sawStarExport = false

  for (const match of barrelSource.matchAll(BARREL_REEXPORT_RE)) {
    if (!specifierTargetsRotate(match[3] ?? '')) continue
    for (const name of barrelReexportSourceNames(match[1] ?? '')) {
      if (name === 'default') sawBareDefault = true
      else names.add(name)
    }
  }
  for (const match of barrelSource.matchAll(BARREL_TYPE_REEXPORT_RE)) {
    if (!specifierTargetsRotate(match[3] ?? '')) continue
    for (const name of barrelReexportSourceNames(match[1] ?? '')) {
      if (name === 'default') sawBareDefault = true
      else names.add(name)
    }
  }
  for (const match of barrelSource.matchAll(BARREL_STAR_REEXPORT_RE)) {
    if (specifierTargetsRotate(match[2] ?? '')) sawStarExport = true
  }

  if (rotateSource !== undefined) {
    if (sawBareDefault) {
      for (const name of defaultExportLocalNames(rotateSource)) names.add(name)
    }
    if (sawStarExport) {
      const defaults = new Set(defaultExportLocalNames(rotateSource))
      for (const name of rotateModuleExportNames(rotateSource)) {
        if (!defaults.has(name)) names.add(name)
      }
    }
  }
  return names
}

/**
 * Doors #87's own law protects by keeping them OUT of the barrel:
 * `performRetarget` and `beginRetargetBoundary` are the rotation-entry points
 * prd-42 ruling 5 guards, and `reserveInFlightForTest` is the test-only escape
 * hatch beside them (no production code may import it — see its own doc in
 * `rotate.ts`). Completeness cannot mean "everything rotate.ts exports": these
 * three are exactly what that law just closed, and widening the barrel to
 * cover them would reopen it.
 */
const BARREL_GUARDED_DOORS = new Set(['performRetarget', 'beginRetargetBoundary', 'reserveInFlightForTest'])

/** Every rotate.ts export the barrel fails to republish, minus the guarded doors. Empty means the barrel is complete. */
function barrelCompletenessGaps(
  rotateSource: string,
  barrelSource: string,
  guardedDoors: ReadonlySet<string>,
): string[] {
  const republished = barrelReexportedRotateNames(barrelSource, rotateSource)
  return rotateModuleExportNames(rotateSource).filter((name) => !guardedDoors.has(name) && !republished.has(name))
}

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
        // A generator writes its `*` where the space would be, so a lone
        // `function\s+` derived nothing from any of these three.
        'export function* genDoor() {}',
        'export function *spacedGenDoor() {}',
        'export async function* asyncGenDoor() {}',
        // CONTROL: declared, not exported — not a door. The exact-set
        // assertion below is what asserts its absence.
        'function* notExportedGen() {}',
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
          'genDoor',
          'spacedGenDoor',
          'asyncGenDoor',
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

    it('EXECUTED: a door declared `export function*` turns the law red, and an ordinary import stays green', async () => {
      // The sibling of the `export let` law above, on the other side of the
      // same regex. `function\s+` cannot reach a generator's name — the `*`
      // sits where the space would be — so `export function* streamDoor()`
      // derived NO door and the law went quiet about a real one. `rotate.ts`
      // publishes no generator today; this pins the FORM, so the first one to
      // be added is covered on the day it lands rather than the day someone
      // notices. Same reason the `export let` case above is pinned.
      const syntheticRotate = 'export function* streamDoor() {}\n'
      const entryRe = new RegExp(
        `\\b(?:${rotationEntryPoints(syntheticRotate, '').map(escapeForAlternation).join('|')})\\b`,
      )

      const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-generator-door-fixture-'))
      try {
        const recorderDir = path.join(fixtureRoot, 'recorder')
        const rotateFile = path.join(recorderDir, 'rotate.ts')
        await mkdir(recorderDir, { recursive: true })
        await writeFile(rotateFile, syntheticRotate)

        const offender = path.join(fixtureRoot, 'sneaky-streamer.ts')
        await writeFile(offender, "import { streamDoor } from './recorder/rotate.js'\n\nvoid streamDoor()\n")
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

    it('EXECUTED: an erased import reaches nothing at runtime and is not a caller, in either spelling, while a value import of the same module still is', async () => {
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
        // Erased, INLINE spelling — this repo's dominant one, and the sibling
        // of the separated form above. Guarded only on the separated side, the
        // law named this file a rotation caller.
        await writeFile(
          path.join(fixtureRoot, 'type-only-inline.ts'),
          "import { type Boundary } from './recorder/rotate.js'\n\nexport const e: Boundary | undefined = undefined\n",
        )
        // Erased, inline, multi-specifier and aliased.
        await writeFile(
          path.join(fixtureRoot, 'type-only-inline-multi.ts'),
          "import {\n  type Boundary,\n  type Boundary as B2,\n} from './recorder/rotate.js'\n\nexport const f: B2 | undefined = undefined\n",
        )
        // CAUGHT: one inline VALUE specifier beside an inline type one keeps
        // the edge — the control that stops the guard above from erasing a
        // mixed clause wholesale.
        const inlineMixed = path.join(fixtureRoot, 'inline-mixed.ts')
        await writeFile(
          inlineMixed,
          "import { type Boundary, realDoor } from './recorder/rotate.js'\n\n" +
            'export const g: Boundary | undefined = undefined\nvoid realDoor\n',
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

        expect(violations.slice().sort()).toEqual(
          [path.relative(REPO_ROOT, inlineMixed), path.relative(REPO_ROOT, mixed)].sort(),
        )
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

  describe('the barrel is complete (#154)', () => {
    it('republishes every public symbol rotate.ts exports, except the law-guarded doors', () => {
      expect(barrelCompletenessGaps(ROTATE_SOURCE, BARREL_SOURCE, BARREL_GUARDED_DOORS)).toEqual([])
    })

    it('RotationRefusedError specifically is reachable through the barrel, and api/rotate.ts uses that door', () => {
      expect(barrelReexportedRotateNames(BARREL_SOURCE, ROTATE_SOURCE).has('RotationRefusedError')).toBe(true)
      const apiRotateSource = readFileSync(path.join(SERVER_SRC, 'api', 'rotate.ts'), 'utf8')
      expect(apiRotateSource).toContain("from '../recorder/index.js'")
      expect(apiRotateSource).not.toContain("from '../recorder/rotate.js'")
    })

    it('EXECUTED with a CONTROL: a public export removed from the barrel reddens the guard; the guarded doors staying absent does not', () => {
      const syntheticRotate = [
        'export function realDoor() {}',
        'export class RealError extends Error {}',
        'export function performRetarget() {}',
        'export function beginRetargetBoundary() {}',
        'export function reserveInFlightForTest() {}',
      ].join('\n')

      // CONTROL: the three guarded doors are absent from a barrel that
      // otherwise republishes everything else rotate.ts exports — this must
      // NOT redden. If it did, the guard would be demanding exactly the
      // widening #87's law exists to refuse.
      const completeBarrel = "export { realDoor, RealError } from './rotate.js'\n"
      expect(barrelCompletenessGaps(syntheticRotate, completeBarrel, BARREL_GUARDED_DOORS)).toEqual([])

      // EXECUTED: drop a real public export from the barrel — this MUST
      // redden, and name exactly the dropped symbol. This is the shape #154
      // found: `RetargetInFlightError` added, its sibling `RotationRefusedError`
      // left out, and nothing caught it.
      const incompleteBarrel = "export { realDoor } from './rotate.js'\n"
      expect(barrelCompletenessGaps(syntheticRotate, incompleteBarrel, BARREL_GUARDED_DOORS)).toEqual(['RealError'])
    })

    it('EXECUTED — the clause axis: a local `export type { X }` is derived, and a barrel `export type { X } from` is credited', () => {
      // Both halves failed before the wave-10 reconcile, in opposite
      // directions, and each has its already-passing sibling here as CONTROL —
      // the sibling is the point: the harness was always sound and the
      // spelling was the whole difference.
      const syntheticRotate = [
        'export function realDoor() {}',
        'type SecretOptions = { a: number }',
        'export type { SecretOptions }',
      ].join('\n')

      // FAILED OPEN: a barrel omitting SecretOptions used to read as complete.
      const barrelMissingTheType = "export { realDoor } from './rotate.js'\n"
      expect(barrelCompletenessGaps(syntheticRotate, barrelMissingTheType, BARREL_GUARDED_DOORS)).toEqual([
        'SecretOptions',
      ])

      // CONTROL, the sibling spelling that always worked.
      const inlineRotate = [
        'export function realDoor() {}',
        'type SecretOptions = { a: number }',
        'export { type SecretOptions }',
      ].join('\n')
      expect(barrelCompletenessGaps(inlineRotate, barrelMissingTheType, BARREL_GUARDED_DOORS)).toEqual([
        'SecretOptions',
      ])

      // FALSE POSITIVE: the barrel DOES republish it, in the spelling 12 of
      // this repo's index.ts barrels use — this must be clean, not a gap.
      const typeOnlyBarrel =
        "export { realDoor } from './rotate.js'\nexport type { SecretOptions } from './rotate.js'\n"
      expect(barrelCompletenessGaps(syntheticRotate, typeOnlyBarrel, BARREL_GUARDED_DOORS)).toEqual([])

      // CONTROL: the mixed inline spelling, which always was credited.
      const inlineBarrel = "export { realDoor, type SecretOptions } from './rotate.js'\n"
      expect(barrelCompletenessGaps(syntheticRotate, inlineBarrel, BARREL_GUARDED_DOORS)).toEqual([])
    })

    it('adding a guarded door to the barrel does not satisfy the guard while a real export stays missing', () => {
      // The trap #154 names explicitly: a "completeness" guard satisfied by
      // adding `performRetarget` (or either sibling) would be a wrong guard.
      // Widening the barrel to a guarded door must not paper over a real gap.
      const syntheticRotate = [
        'export function realDoor() {}',
        'export class RealError extends Error {}',
        'export function performRetarget() {}',
      ].join('\n')
      const barrelWithGuardedDoorButMissingRealExport = "export { realDoor, performRetarget } from './rotate.js'\n"
      expect(
        barrelCompletenessGaps(syntheticRotate, barrelWithGuardedDoorButMissingRealExport, BARREL_GUARDED_DOORS),
      ).toEqual(['RealError'])
    })

    it('a type export drifting out of the barrel is caught too, even though it is never a rotation door', () => {
      const syntheticRotate = ['export function realDoor() {}', 'export interface RealOptions { at: number }'].join(
        '\n',
      )
      // `RealOptions` is a type — `rotationEntryPoints` never derives a door
      // from it — but it is still part of the module's public surface.
      expect(rotationEntryPoints(syntheticRotate, '')).not.toContain('RealOptions')
      const barrel = "export { realDoor } from './rotate.js'\n"
      expect(barrelCompletenessGaps(syntheticRotate, barrel, BARREL_GUARDED_DOORS)).toEqual(['RealOptions'])
    })

    /**
     * The grammar, enumerated — because for a derivation this IS the reviewable
     * unit, and the first revision of it failed OPEN on three legal forms.
     *
     * `export enum`, `export namespace` and `export abstract class` all derived
     * NO name: `enum` and `namespace` were absent from the alternation, and
     * `abstract` sits between `export` and `class`. A barrel omitting any of the
     * three passed a guard whose entire job is to notice — silently, because a
     * derivation that yields nothing looks identical to a module with nothing to
     * declare. Found by a review pass on this commit before it reached a PR.
     *
     * A form absent from this table is a form nobody reviewed. Add the row
     * BEFORE the alternation, so the test is what forces the code.
     */
    it('derives a name from every legal export form — a missing form fails the law OPEN, so the set is pinned', () => {
      const forms: ReadonlyArray<readonly [string, string]> = [
        ['export function f() {}', 'f'],
        ['export async function g() {}', 'g'],
        ['export function* gen() {}', 'gen'],
        ['export class C {}', 'C'],
        ['export abstract class Base {}', 'Base'],
        ['export const k = 1', 'k'],
        ['export let l = 1', 'l'],
        ['export var v = 1', 'v'],
        ['export interface I { a: number }', 'I'],
        ['export type T = string', 'T'],
        ['export enum E { A }', 'E'],
        ['export namespace N {}', 'N'],
        // The CLAUSE axis. The rows above are all one axis — the declaration
        // keyword — and the wave-10 review found the guard failing OPEN one
        // axis over: `export type { X }` is a local type-only clause, legal,
        // idiomatic under `isolatedModules`, and derived NOTHING. Its sibling
        // `export { type X }` was already handled, so the spelling was the
        // whole difference.
        ['const c = 1\nexport { c }', 'c'],
        ['const d = 1\nexport { d as renamed }', 'renamed'],
        ['type Inline = string\nexport { type Inline }', 'Inline'],
        ['type Local = string\nexport type { Local }', 'Local'],
        ['type Multi = string\nexport type {\n  Multi,\n}', 'Multi'],
        // #174's CLAUSE axis, the rest of it — every row EXECUTED at wave-10
        // against a tree that has since moved; re-run here rather than trusted.
        ['export const enum K { A }', 'K'],
        ['export const a = 1, b = 2', 'a'],
        ['export const a = 1, b = 2', 'b'],
        ['export declare class D {}', 'D'],
        ['export declare function f(): void', 'f'],
        ['export const { a, b } = obj', 'a'],
        ['export const { a, b } = obj', 'b'],
        ['export const [a, b] = arr', 'a'],
        ['export const [a, b] = arr', 'b'],
        // rotate.ts forwarding a symbol from ANOTHER module — still part of
        // its own public surface, and invisible only to the local-clause arm
        // (deliberately, for #87's own reason — see that arm's doc).
        ["export { helper } from './helpers.js'", 'helper'],
        // The two forms the wave-11 verify found still uncovered, added BEFORE
        // the arms that derive them, per this table's own contract above.
        //
        // Both are the SAME sibling-miss this file has now recorded three
        // times: a keyword sitting between `export` and the thing the pattern
        // anchors on. `export type { T } from` has `type` between `export` and
        // `{`, exactly as the local `export type { X }` row above did — one
        // axis over, and 15 non-test files in this repo use it, 14 of them
        // barrels. `export declare const|let|var` has `declare` between
        // `export` and the keyword, while `declare class`/`declare function`
        // two rows up were already covered — so the doc claimed the general
        // case and the code honoured two spellings of five.
        ["export type { Forwarded } from './helpers.js'", 'Forwarded'],
        ['export declare const ambient: string', 'ambient'],
        ['export declare let mutableAmbient: number', 'mutableAmbient'],
        ['export declare var legacyAmbient: number', 'legacyAmbient'],
        // The THREE spellings the first pass at this repair missed, found by
        // the fix re-review. `declare const|let|var` was widened and the two
        // arms either side of it were not — the same widen-one-arm-leave-the-
        // siblings shape this file now records four times.
        ['export declare const enum AmbientK { A }', 'AmbientK'],
        ['export declare interface AmbientI { a: number }', 'AmbientI'],
        ['export declare type AmbientT = string', 'AmbientT'],

        // #185's own family: fail-OPEN forms, EXECUTED against the real
        // helper, added as this table's own contract requires — before the
        // arms above that now derive them. NOT "ordinary lineWidth: 100
        // formatting" — `biome.json` sets `"formatter": { "enabled": false }`
        // repo-wide, so nothing here auto-wraps anything. Both are legal
        // hand-written TypeScript regardless, which is why they are worth
        // guarding.
        //
        // A declarator list wrapped inside an object-literal VALUE. `b` used
        // to vanish silently; the exact-equality test below is what actually
        // catches that (a `toContain('a')` row here cannot).
        ['export const a = {\n  x: 1,\n}, b = 2', 'a'],
        ['export const a = {\n  x: 1,\n}, b = 2', 'b'],
        // The SAME production, wrapped at the comma instead of inside a
        // bracket — found by #185's own review round 2 after the row above
        // shipped: the bracket-depth fix never touched this one, since the
        // wrap here has no bracket to track at all.
        ['export const a = 1,\n  b = 2', 'a'],
        ['export const a = 1,\n  b = 2', 'b'],
        // A rest element is a real binding, object and array both — it was
        // the one undocumented exclusion in `declaratorListNames`.
        ['export const { a, ...rest } = obj', 'a'],
        ['export const { a, ...rest } = obj', 'rest'],
        ['export const [a, ...rest] = arr', 'a'],
        ['export const [a, ...rest] = arr', 'rest'],
        // `export * as ns from` mints a namespace export on rotate.ts's OWN
        // surface — a name a barrel must still republish. Distinct from the
        // RULING on the barrel's own `export * as ns from './rotate.js'`,
        // recorded beside `BARREL_STAR_REEXPORT_RE` below: that ruling is
        // about whether a barrel's namespace wrapper satisfies completeness
        // for rotate.ts's names; this row is about rotate.ts forwarding
        // ANOTHER module's export as a namespace of its own.
        ["export * as ns from './helpers.js'", 'ns'],
        // The same arm's TYPE sibling. The value spelling above derived `ns`
        // while this one derived nothing at all — a fail-OPEN form in #185's
        // own family, one keyword from the arm #185 added, and the only one
        // left with no row and no verdict anywhere in this file (review of
        // #185). `tns` is a real local export name either way.
        ["export type * as tns from './helpers.js'", 'tns'],
        // A TIGHT generator default — no space anywhere around the `*` — found
        // fail-OPEN (not merely the narrower fail-closed gap first suspected)
        // by #185's review round 2: `defaultExportLocalNames` missed it, which
        // let a barrel's `export * from` credit it as forwarded when real `export
        // *` semantics never forward a default at all. See that function's own
        // doc for the two-symptom shape one regex produced.
        ['export default function*tight() {}', 'tight'],
      ]
      for (const [source, expected] of forms) {
        expect(rotateModuleExportNames(source), `no name derived from: ${source}`).toContain(expected)
      }
    })

    /**
     * Forms deliberately NOT rows above, with a verdict and a reason each —
     * the table's own contract cuts both ways: a form nobody lists is a form
     * nobody reviewed, so an exclusion has to be as visible as an inclusion.
     * All three EXECUTED at #185 review round 2.
     *
     * - A NESTED destructuring pattern (`export const { outer: { nested } } =
     *   value`) derives `[]` — fails OPEN, deliberately left. Reading only the
     *   outer key would mint a name nobody can import; reading it correctly
     *   needs a real parser, not a comma split. See `declaratorListNames`'s own
     *   doc and the CONTROL test below, which pins the same verdict under a
     *   different pair of names.
     * - `export * from './helpers.js'` on rotate.ts's OWN surface (forwarding
     *   ANOTHER module's exports in bulk, not the barrel's `export * from
     *   './rotate.js'` tested elsewhere) derives `[]` — fails OPEN,
     *   deliberately left, and asymmetric with its `as ns` sibling two rows
     *   above on purpose: `export * as ns from` names something (`ns`) that
     *   exists whether or not this file resolves the target module, but a
     *   bare `export * from` has NO local name at all — the names it forwards
     *   live in `./helpers.js`, and deriving them means resolving and reading
     *   an arbitrary file, the same "materially bigger tool" already declared
     *   out of scope for `codeOf`'s string-literal blindness. See the CONTROL
     *   test below.
     * - A barrel containing the TEXT of a re-export clause inside a string or
     *   template literal (`const note = "export { realDoor } from
     *   './rotate.js'"`) is credited as if it were a real re-export — fails
     *   OPEN, on the BARREL side this time, the opposite direction from the
     *   already-declared module-side residual beside `codeOf` (which fails
     *   CLOSED, minting a phantom name). Same root cause — neither `codeOf`
     *   nor the barrel regexes are string-literal-aware — different
     *   consequence depending on which side of the guard reads the fake text.
     *   Deliberately left: closing it needs the same string-literal-aware
     *   scanner already declared out of scope, and widening it to only this
     *   one shape would be another single-spelling patch on a defect this file
     *   has already recorded as needing a different kind of tool entirely. See
     *   the CONTROL test below.
     * - A declarator list wrapped so the comma lands at the BEGINNING of the
     *   continuation line (`export const a = 1\n  , b = 2`) derives `["a"]` —
     *   fails OPEN, `b` dropped (EXECUTED, review of #185; #185's own body
     *   names this form but the file did not, which is the silent exclusion
     *   this issue exists to end). Deliberately left, and the reason is #185's
     *   OWN stopping rule rather than difficulty: the wrapped-declarator-list
     *   production has already been defeated twice and rebuilt once, and a
     *   `\n`-at-depth-0 exception for "the next non-whitespace character is a
     *   comma" would be a third patch on the same production by the same
     *   method. What closes it is the same real-continuation awareness the
     *   `export const c =\n  1` residual already names — one tool, both
     *   shapes — not another leading-character special case. Unreachable in
     *   `rotate.ts` today, and no formatter here emits it: `biome.json` sets
     *   `"formatter": { "enabled": false }`. See the CONTROL test below.
     * - `export type * from './helpers.js'` on rotate.ts's own surface derives
     *   `[]` — the TYPE spelling of the bare-star residual two rows above, and
     *   left for exactly the same reason: a bare star has no local name, so
     *   deriving anything means resolving and reading another file. Recorded
     *   because its `as ns` sibling IS now derived in both spellings, and a
     *   reader who sees that should not have to guess which halves of the
     *   grid are covered. See the CONTROL test below.
     */
    it('CONTROL: nested destructuring, a module-side `export * from`, and a barrel string literal are all fail-OPEN residuals declared above, not silently accepted', () => {
      expect(rotateModuleExportNames('export const { outer: { nested } } = value\n')).toEqual([])
      expect(rotateModuleExportNames("export * from './helpers.js'\n")).toEqual([])
      // The two residuals #185's body named but its file left undeclared,
      // now pinned so an accidental change reddens rather than passing
      // quietly in either direction (review of #185).
      expect(rotateModuleExportNames('export const a = 1\n  , b = 2\n')).toEqual(['a'])
      expect(rotateModuleExportNames("export type * from './helpers.js'\n")).toEqual([])

      const rotateSrc = 'export function realDoor() {}\n'
      const barrelWithFakeReexportInAString =
        "const note = \"export { realDoor } from './rotate.js'\"\nexport const nothing = 1\n"
      // FAILS OPEN: the string's text is credited exactly as a real clause
      // would be, so this reports NO gap even though the barrel does not
      // actually republish `realDoor`.
      expect(
        barrelCompletenessGaps(rotateSrc, barrelWithFakeReexportInAString, BARREL_GUARDED_DOORS),
      ).toEqual([])
      // CONTROL: the same barrel with the fake string removed correctly
      // reports the real gap — the string, not the guard's general logic, is
      // what manufactures the false credit above.
      expect(
        barrelCompletenessGaps(rotateSrc, "export const nothing = 1\n", BARREL_GUARDED_DOORS),
      ).toEqual(['realDoor'])
    })

    /**
     * The table above asserts with `toContain`, which is right for it — a row
     * says "this name must be derived" and says nothing about what else is.
     * That makes it USELESS for the backtracking defect, where the bug IS the
     * extra name: `export const  enum K {}` derived ["K","enum"] and a
     * `toContain('K')` row passes on both the broken and the fixed derivation.
     * EXECUTED — reverting the anchored lookahead left all 52 tests green with
     * two such rows present, which is why they were replaced by this.
     *
     * Exact equality is the assertion the defect actually needs.
     */
    it('the const/enum lookahead cannot capture the KEYWORD — exact, not toContain (#174)', () => {
      for (const source of [
        'export const  enum SpacedK { A }',
        'export const\n  enum SpacedK { A }',
        'export const\tenum SpacedK { A }',
      ]) {
        expect(rotateModuleExportNames(source), `keyword captured from: ${JSON.stringify(source)}`).toEqual(['SpacedK'])
      }
      expect(rotateModuleExportNames('export declare const  enum SpacedD { A }')).toEqual(['SpacedD'])
      // The REACHABLE path, end to end: `codeOf` replaces a block comment with
      // the empty string, so an inline comment leaves TWO spaces behind. This
      // models that strip rather than passing raw source, which the deriver
      // never sees — the first draft of this row did, and correctly failed.
      const stripped = 'export const /* note */ enum Direction { Up }'
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
      expect(stripped).toBe('export const  enum Direction { Up }')
      expect(rotateModuleExportNames(stripped)).toEqual(['Direction'])
      // CONTROLS: the `\b` must still let these through, or the repair has
      // traded a phantom for a dropped name.
      expect(rotateModuleExportNames('export const enumerable = 1')).toEqual(['enumerable'])
      expect(rotateModuleExportNames('export const enum2 = 1')).toEqual(['enum2'])
      expect(rotateModuleExportNames('export const enum K2 { A }')).toEqual(['K2'])
    })

    it('CONTROL — a non-export declaration derives nothing, so the table above is not vacuous', () => {
      for (const source of ['function notExported() {}', 'class NotExported {}', 'enum NotExported { A }']) {
        expect(rotateModuleExportNames(source)).toEqual([])
      }
    })

    it('EXECUTED: `const enum` derives the real name, not the keyword — the old behaviour lost K entirely and demanded the barrel republish a symbol literally called `enum`', () => {
      const syntheticRotate = 'export const enum Direction { Up, Down }\n'
      expect(rotateModuleExportNames(syntheticRotate)).toEqual(['Direction'])
      expect(barrelCompletenessGaps(syntheticRotate, '', BARREL_GUARDED_DOORS)).toEqual(['Direction'])
    })

    it('EXECUTED: every declarator in `export const a = 1, b = 2` is derived, not just the first', () => {
      expect(new Set(rotateModuleExportNames('export const a = 1, b = 2\n'))).toEqual(new Set(['a', 'b']))
    })

    it('EXECUTED: destructured export bindings are derived — object and array patterns both', () => {
      expect(new Set(rotateModuleExportNames('export const { a, b } = obj\n'))).toEqual(new Set(['a', 'b']))
      expect(new Set(rotateModuleExportNames('export const [c, d] = arr\n'))).toEqual(new Set(['c', 'd']))
    })

    it('CONTROL: a nested destructuring pattern derives nothing rather than a name nobody can import', () => {
      expect(rotateModuleExportNames('export const { a: { b } } = obj\n')).toEqual([])
    })

    it('EXECUTED: a multi-line declarator list is split at the closing brace, not the first newline — every declarator derived, not just the first (#185)', () => {
      // A hand-written wrap, not something a formatter emitted — this repo's
      // `biome.json` disables the formatter entirely. Before the fix, the
      // outer regex fed `declaratorListNames` text already truncated at the
      // first `\n`, so this derived only `["a"]` — `b` is a real binding and
      // vanished silently.
      const multiline = 'export const a = {\n  x: 1,\n}, b = 2\n'
      expect(new Set(rotateModuleExportNames(multiline))).toEqual(new Set(['a', 'b']))
      // CONTROL: object VALUE spanning several lines with no sibling
      // declarator must still yield exactly the one binding.
      expect(rotateModuleExportNames('export const solo = {\n  x: 1,\n  y: 2,\n}\n')).toEqual(['solo'])
    })

    it('EXECUTED, end to end: a barrel omitting the second declarator of a wrapped multi-line list reddens the completeness guard by that name (#185)', () => {
      const rotateSrc = 'export const a = {\n  x: 1,\n}, b = 2\n'
      const barrelMissingB = "export { a } from './rotate.js'\n"
      expect(barrelCompletenessGaps(rotateSrc, barrelMissingB, BARREL_GUARDED_DOORS)).toEqual(['b'])
      const completeBarrel = "export { a, b } from './rotate.js'\n"
      expect(barrelCompletenessGaps(rotateSrc, completeBarrel, BARREL_GUARDED_DOORS)).toEqual([])
    })

    it('EXECUTED: a declarator list wrapped at the COMMA, with no bracket at all, is the same production as the brace-wrapped one above and survived the first fix — round 2 (#185)', () => {
      // The bracket-depth walk was never what bounded this one: there is no
      // bracket to track. A comma immediately followed by `\n` hit the
      // unconditional `\n`-at-depth-0 terminator before consuming any of the
      // next declarator, so `b` vanished exactly as it did before the first
      // fix — the SAME production, defeated twice.
      const wrapped = 'export const a = 1,\n  b = 2\n'
      expect(new Set(rotateModuleExportNames(wrapped))).toEqual(new Set(['a', 'b']))
      // CONTROL: a blank line after the comma must not change the answer —
      // the fix is "nothing but whitespace since the split," not "exactly
      // one newline."
      expect(new Set(rotateModuleExportNames('export const a = 1,\n\n  b = 2\n'))).toEqual(new Set(['a', 'b']))
      // CONTROL, the declared residual this fix does NOT close: wrapping
      // after `=` with no comma still terminates early, because real content
      // (`c =`) was already consumed before the newline.
      expect(rotateModuleExportNames('export const c =\n  1\n')).toEqual(['c'])
    })

    it('EXECUTED, end to end: a barrel omitting the second declarator of a comma-wrapped list (no bracket) reddens the completeness guard by that name (#185)', () => {
      const rotateSrc = 'export const a = 1,\n  b = 2\n'
      expect(
        barrelCompletenessGaps(rotateSrc, "export { a } from './rotate.js'\n", BARREL_GUARDED_DOORS),
      ).toEqual(['b'])
      expect(
        barrelCompletenessGaps(rotateSrc, "export { a, b } from './rotate.js'\n", BARREL_GUARDED_DOORS),
      ).toEqual([])
    })

    it('EXECUTED: a rest element in a destructured export is a real binding and is derived — object and array both, not skipped silently (#185)', () => {
      expect(new Set(rotateModuleExportNames('export const { a, ...rest } = obj\n'))).toEqual(
        new Set(['a', 'rest']),
      )
      expect(new Set(rotateModuleExportNames('export const [a, ...rest] = arr\n'))).toEqual(new Set(['a', 'rest']))
      // CONTROL: a rest-only pattern with no leading bindings still derives.
      expect(rotateModuleExportNames('export const { ...everything } = obj\n')).toEqual(['everything'])
    })

    it('EXECUTED, end to end: a barrel omitting a rest binding reddens the completeness guard by that name (#185)', () => {
      const rotateSrc = 'export const { a, ...rest } = obj\n'
      expect(
        barrelCompletenessGaps(rotateSrc, "export { a } from './rotate.js'\n", BARREL_GUARDED_DOORS),
      ).toEqual(['rest'])
      expect(
        barrelCompletenessGaps(rotateSrc, "export { a, rest } from './rotate.js'\n", BARREL_GUARDED_DOORS),
      ).toEqual([])
    })

    it("EXECUTED: `export * as ns from` mints a namespace export rotate.ts's own barrel must still republish (#185)", () => {
      expect(rotateModuleExportNames("export * as ns from './helpers.js'\n")).toEqual(['ns'])
      // CONTROL: a real export alongside it must not be lost or duplicated.
      expect(new Set(rotateModuleExportNames("export function realDoor() {}\nexport * as ns from './helpers.js'\n"))).toEqual(
        new Set(['realDoor', 'ns']),
      )
    })

    it('EXECUTED, end to end: a barrel omitting a module-side namespace re-export reddens the completeness guard by that name (#185)', () => {
      const rotateSrc = "export function realDoor() {}\nexport * as ns from './helpers.js'\n"
      expect(
        barrelCompletenessGaps(rotateSrc, "export { realDoor } from './rotate.js'\n", BARREL_GUARDED_DOORS),
      ).toEqual(['ns'])
      expect(
        barrelCompletenessGaps(rotateSrc, "export { realDoor, ns } from './rotate.js'\n", BARREL_GUARDED_DOORS),
      ).toEqual([])
    })

    it("EXECUTED: `export type * as ns from` is the value arm's own TYPE sibling and derives the same real name (review of #185)", () => {
      // Measured on #185's head before this fix: the value spelling derived
      // ['ns'] and the type spelling derived [] — fails OPEN, and it was the
      // one member of #185's family carrying neither an arm nor a verdict.
      expect(rotateModuleExportNames("export type * as tns from './helpers.js'\n")).toEqual(['tns'])
      // CONTROL: the value spelling is unchanged by the widening.
      expect(rotateModuleExportNames("export * as ns from './helpers.js'\n")).toEqual(['ns'])
      // CONTROL: widening for `type` must not credit a bare `export type *`,
      // which has no local name at all — the same asymmetry the value forms
      // already carry, pinned so the two do not drift apart.
      expect(rotateModuleExportNames("export type * from './helpers.js'\n")).toEqual([])
      // CONTROL: an identifier merely STARTING with the keyword mints nothing
      // — this is why the widening requires whitespace before `type` rather
      // than hanging `(?:type\s+)?` off the existing `\s*`.
      expect(rotateModuleExportNames("exporttype * as sneaky from './helpers.js'\n")).toEqual([])
    })

    it('EXECUTED, end to end: a barrel omitting a module-side TYPE namespace re-export reddens the completeness guard by that name (review of #185)', () => {
      const rotateSrc = "export function realDoor() {}\nexport type * as tns from './helpers.js'\n"
      expect(
        barrelCompletenessGaps(rotateSrc, "export { realDoor } from './rotate.js'\n", BARREL_GUARDED_DOORS),
      ).toEqual(['tns'])
      expect(
        barrelCompletenessGaps(rotateSrc, "export { realDoor, tns } from './rotate.js'\n", BARREL_GUARDED_DOORS),
      ).toEqual([])
    })

    it('a declarator-list split cannot mint a name out of a type argument, a string or a regex — exact, not toContain (#183 review)', () => {
      // The depth walk splits on `,` at `{[(` depth 0, and `<`, quotes and a
      // regex literal are none of those — so each of these used to yield the
      // first word AFTER the hidden comma as a second export name. `toContain`
      // is useless here for the same reason it was useless for the `const
      // enum` backtrack: the bug IS the extra name. EXECUTED against 9b94ba6
      // and its parent — parent `["x"]`, 9b94ba6 `["x","number"]`.
      expect(rotateModuleExportNames('export const x: Map<string, number> = new Map()')).toEqual(['x'])
      expect(rotateModuleExportNames('export const rec: Record<string, string> = {}')).toEqual(['rec'])
      expect(rotateModuleExportNames("export const s = 'a,b'")).toEqual(['s'])
      expect(rotateModuleExportNames('export const t = `a,b`')).toEqual(['t'])
      expect(rotateModuleExportNames('export const r = /a,b/')).toEqual(['r'])
      // The same hole one level in: a destructured entry's default value can
      // hide a comma exactly as an initialiser can.
      expect(rotateModuleExportNames("export const { a = 'x,y' } = obj")).toEqual(['a'])
      // CONTROLS — the anchor must not cost a real binding. Every declarator
      // ending, or continuing into `:`/`=`/`?`/`!`, still derives.
      expect(new Set(rotateModuleExportNames('export const a = 1, b = 2'))).toEqual(new Set(['a', 'b']))
      expect(new Set(rotateModuleExportNames('export declare let p: string, q: number'))).toEqual(
        new Set(['p', 'q']),
      )
      expect(rotateModuleExportNames('export declare const ambient: string')).toEqual(['ambient'])
      expect(rotateModuleExportNames('export let bare')).toEqual(['bare'])
      expect(rotateModuleExportNames('export const definite!: number = 1')).toEqual(['definite'])
      // A `<` that is a COMPARISON, not a type argument — the reason `<` is
      // not tracked as depth. Both bindings are real and both must survive.
      expect(new Set(rotateModuleExportNames('export const lt = a < b, also = 2'))).toEqual(new Set(['lt', 'also']))
    })

    it('EXECUTED: `declare class`/`declare function` still derive a name — an ambient export is still public surface, even though it is erased at runtime', () => {
      expect(rotateModuleExportNames('export declare class D {}\n')).toContain('D')
      expect(rotateModuleExportNames('export declare function f(): void\n')).toContain('f')
    })

    it('EXECUTED: rotate.ts forwarding a symbol from another module is still counted as part of its public surface', () => {
      expect(rotateModuleExportNames("export { helper } from './helpers.js'\n")).toEqual(['helper'])
    })

    it('EXECUTED, CONTROL: `codeOf`/`rotateModuleExportNames` are not string-literal-aware, so a "comment" inside a string is still read — fails CLOSED, so it is noise rather than a hole (#174)', async () => {
      const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-codeof-string-fixture-'))
      try {
        const file = path.join(fixtureRoot, 'noisy.ts')
        await writeFile(file, 'const s = "export function ghost() {}"\n')
        expect(rotateModuleExportNames(codeOf(file))).toEqual(['ghost'])
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true })
      }
    })

    it('EXECUTED: a same-named file in another directory is not credited as a republish of rotation\'s own module — the basename-only bug row #174 found', () => {
      const syntheticRotate = 'export class RealError extends Error {}\n'
      const barrelPointingElsewhere = "export { RealError } from '../elsewhere/rotate.js'\n"
      expect([...barrelReexportedRotateNames(barrelPointingElsewhere)]).toEqual([])
      expect(barrelCompletenessGaps(syntheticRotate, barrelPointingElsewhere, BARREL_GUARDED_DOORS)).toEqual([
        'RealError',
      ])
    })

    it('EXECUTED: a barrel republishing under a renamed alias is credited under rotate.ts\'s SOURCE name, not the barrel\'s new one', () => {
      const syntheticRotate = 'export class RealError extends Error {}\n'
      const renamedBarrel = "export { RealError as alias } from './rotate.js'\n"
      expect([...barrelReexportedRotateNames(renamedBarrel)]).toEqual(['RealError'])
      expect(barrelCompletenessGaps(syntheticRotate, renamedBarrel, BARREL_GUARDED_DOORS)).toEqual([])
    })

    it('EXECUTED — the default-credit sub-axis: a bare `export { default } from` satisfies BOTH an `export { x as default }` clause and an `export default class D`, and a barrel that omits it still reddens', () => {
      // Direction A: the module names its default via a CLAUSE. Previously
      // derived nothing at all — `x`'s default-ness was invisible to
      // completeness, so a barrel omitting it stayed green.
      const clauseDefault = ['export function realDoor() {}', 'function x() {}', 'export { x as default }'].join(
        '\n',
      )
      const barrelBareDefault = "export { realDoor, default } from './rotate.js'\n"
      expect(barrelCompletenessGaps(clauseDefault, barrelBareDefault, BARREL_GUARDED_DOORS)).toEqual([])

      // Direction B: the module names its default via `export default class
      // D`. `D` was already derived — the false positive was on the BARREL
      // side: a bare `export { default }` was never credited to any name, so
      // `D` read as missing from a barrel that in fact republishes it.
      const declDefault = ['export function realDoor() {}', 'export default class D {}'].join('\n')
      expect(barrelCompletenessGaps(declDefault, barrelBareDefault, BARREL_GUARDED_DOORS)).toEqual([])

      // CONTROL: a barrel that does NOT carry the default at all still
      // reports the real gap — the fix must not turn into "any barrel passes".
      const barrelWithoutDefault = "export { realDoor } from './rotate.js'\n"
      expect(barrelCompletenessGaps(declDefault, barrelWithoutDefault, BARREL_GUARDED_DOORS)).toEqual(['D'])
    })

    it('EXECUTED: `export * from` credits every non-default rotate.ts export; its own default still needs its own barrel spelling', () => {
      const syntheticRotate = ['export function realDoor() {}', 'export interface RealOptions { at: number }'].join(
        '\n',
      )
      const starBarrel = "export * from './rotate.js'\n"
      expect(barrelCompletenessGaps(syntheticRotate, starBarrel, BARREL_GUARDED_DOORS)).toEqual([])

      // A default export is NOT forwarded by `export *` — real JS/TS
      // semantics, not a rule this guard invents — so the star form alone
      // does not satisfy it.
      const withDefault = `${syntheticRotate}\nexport default class Hidden {}\n`
      expect(barrelCompletenessGaps(withDefault, starBarrel, BARREL_GUARDED_DOORS)).toEqual(['Hidden'])

      // CONTROL: without the star clause, an ordinary named barrel that omits
      // RealOptions still reports the real gap.
      const namedBarrel = "export { realDoor } from './rotate.js'\n"
      expect(barrelCompletenessGaps(syntheticRotate, namedBarrel, BARREL_GUARDED_DOORS)).toEqual(['RealOptions'])
    })

    it('EXECUTED: a TIGHT generator default (no space around the `*`) is excluded from `export *` credit exactly like any other default — round 2 (#185)', () => {
      // Before the fix, `defaultExportLocalNames` missed `tight` (its regex
      // required `\s+` around an optional `*`), so the star-credit arm's
      // subtraction of real defaults never removed it — a barrel offering
      // only `export * from './rotate.js'` was credited for `tight` even
      // though real `export *` semantics never forward a default at all.
      const syntheticRotate = 'export default function*tight() {}\n'
      const starBarrel = "export * from './rotate.js'\n"
      expect(barrelCompletenessGaps(syntheticRotate, starBarrel, BARREL_GUARDED_DOORS)).toEqual(['tight'])
      // CONTROL: a barrel that DOES carry the bare default correctly clears it.
      const bareDefaultBarrel = "export { default } from './rotate.js'\n"
      expect(barrelCompletenessGaps(syntheticRotate, bareDefaultBarrel, BARREL_GUARDED_DOORS)).toEqual([])
    })

    it('RULING, enforced: `export * as ns from` on the barrel does NOT satisfy completeness — a namespace access path is not the same guarantee as a named one (#174, ruling recorded at #185)', () => {
      const syntheticRotate = 'export function realDoor() {}\n'
      const namespaceBarrel = "export * as rotationNamespace from './rotate.js'\n"
      expect(barrelCompletenessGaps(syntheticRotate, namespaceBarrel, BARREL_GUARDED_DOORS)).toEqual(['realDoor'])
    })

    it('the guarded-door set is asserted ABSENT from the real barrel, not merely tolerated — adding one silently satisfies nothing (#174)', () => {
      expect([...BARREL_GUARDED_DOORS].filter((door) => barrelReexportedRotateNames(BARREL_SOURCE, ROTATE_SOURCE).has(door))).toEqual(
        [],
      )
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
