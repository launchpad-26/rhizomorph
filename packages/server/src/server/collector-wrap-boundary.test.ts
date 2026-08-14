import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * THE COLLECTOR-WRAP-BOUNDARY LAW (#240, #353, #363).
 *
 * #240: sessionlog was constructed and spliced into the poll loop directly
 * from `cli/run.ts`, outside `loadCollectors` — so it never went through
 * `withResilience`/`withResumeReconciliation`, and one failed
 * `stat(~/.claude/projects)` latched it disabled forever with no self-heal.
 * Fixed in #360 by registering sessionlog inside `loadCollectors`, the one
 * function that calls `wrap()`.
 *
 * #353 (closed, superseded by #360) additionally carried a structural test
 * asserting the fix as a LAW rather than an instance: every raw collector
 * factory is referenced, outside its own definition/barrel/tests, only
 * inside `collector-loader.ts`. KelliherL's review of #360 is why this
 * matters as a law and not just a fixed bug: "'no collector is constructed
 * outside the resilience wrapper' is exactly the kind of rule that a single
 * behavioural test cannot prove — a fifth collector spliced in tomorrow,
 * unwrapped, would pass every one of them." That review predates #360's own
 * sessionlog fix by exactly zero collectors: sessionlog *was* the fifth.
 *
 * #353's own test did not survive review — not because the law was wrong,
 * but because its walked set, `RAW_COLLECTORS`, hand-listed the five names
 * that existed then. A sixth collector added without also updating that
 * array would still grep clean. Per prd-24 ruling 3 ("a law's walked scope
 * is derived from what it claims, never hardcoded"), this version derives
 * the set instead: every value (never a type) exported from a
 * `collectors/*\/index.ts` barrel whose name ends in `Collector` — the
 * factory-naming convention every collector in this tree already follows
 * (`gitCollector`, `createJudgeCollector`, ...). A sixth collector's barrel
 * export is picked up the same way, with nothing here to edit.
 *
 * The wrap chain `loadCollectors` builds has grown since #360
 * (`withAgentReconciliation`, #418; `withBranchReconciliation`, #449) but
 * the law does not care what the chain does — only that each raw factory's
 * one legitimate call site is `collector-loader.ts`, the file `wrap()` lives
 * in. Grep-law style, per `model-grammar-law.test.ts` and
 * `recorder/namespace-law.test.ts`: real source text, a regex, no AST,
 * legible by eye.
 */

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COLLECTORS_DIR = path.join(SERVER_SRC, 'collectors')
const LOADER_FILE = path.join(SERVER_SRC, 'server', 'collector-loader.ts')

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])

function isTestFile(file: string): boolean {
  return file.endsWith('.test.ts') || file.endsWith('.test.tsx')
}

/** Every source file under `dir`, tests included — callers filter those out. */
function walkSourceFiles(dir: string): string[] {
  const out: string[] = []
  const visit = (current: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'fixtures') continue
      const full = path.join(current, entry)
      const info = statSync(full)
      if (info.isDirectory()) visit(full)
      else if (SOURCE_EXTENSIONS.has(path.extname(full))) out.push(full)
    }
  }
  visit(dir)
  return out
}

interface RawCollectorFactory {
  /** The identifier this file's own code uses, e.g. `createJudgeCollector`. */
  name: string
  /** The directory the factory is defined and barrelled in — its home. */
  homeDir: string
}

/**
 * A value export block: `export { A, B } from './x.js'` or a local
 * `export { A, B }`. Deliberately does NOT match `export type { ... }` — the
 * `type` keyword sits between `export` and `{`, so `export\s*\{` never
 * matches it. That is what keeps a type export like `WorkmuxSnapshot` from
 * ever being mistaken for a collector factory.
 */
const EXPORT_VALUES_RE = /export\s*\{([\s\S]*?)\}/g

/** The LOCAL binding names in a value export block — `export { X as Y }` yields `X`, what this file's own code calls it. */
function namesExportedAsValues(source: string): string[] {
  const names: string[] = []
  for (const match of source.matchAll(EXPORT_VALUES_RE)) {
    const body = match[1] ?? ''
    for (const raw of body.split(',')) {
      const token = raw.trim()
      if (token.length === 0) continue
      const localName = token.split(/\s+as\s+/)[0]?.trim()
      if (localName) names.push(localName)
    }
  }
  return names
}

/**
 * Every raw collector factory this tree currently declares, derived by
 * reading each `collectors/<x>/index.ts` barrel rather than naming them.
 * A directory with no barrel, or a barrel exporting nothing ending in
 * `Collector` (`otel/`, today), contributes nothing — silently, which is
 * correct: it has no raw factory for this law to bound.
 */
function rawCollectorFactories(collectorsDir: string): RawCollectorFactory[] {
  const factories: RawCollectorFactory[] = []
  let entries: string[]
  try {
    entries = readdirSync(collectorsDir)
  } catch {
    return factories
  }
  for (const entry of entries) {
    const homeDir = path.join(collectorsDir, entry)
    if (!statSync(homeDir).isDirectory()) continue
    const barrel = path.join(homeDir, 'index.ts')
    let source: string
    try {
      source = readFileSync(barrel, 'utf8')
    } catch {
      continue
    }
    for (const name of namesExportedAsValues(source)) {
      if (name.endsWith('Collector')) factories.push({ name, homeDir })
    }
  }
  return factories
}

/**
 * Strip line comments (`// ...`) and block comments (`/* ... *\/`, JSDoc
 * included) before a file's text is matched against a factory name (#363
 * review: assembly against #454's `resume-reconcile.ts` false-positived on
 * four doc-comment lines describing `gitCollector`'s allocation contract —
 * a comment ABOUT a collector is not a reference TO it). Deliberately naive:
 * it does not track string-literal or template-literal boundaries, so a
 * `//` or `/*` sequence *inside* a string is stripped as if it were a real
 * comment too. The rule this law picks is the conservative one — a
 * factory name inside a string literal (e.g. an error message) still reads
 * as a reference, because the stripping only ever removes text that looks
 * like a comment from outside any string, never the reverse; the false-open
 * this naivety could cause (a string containing `//` swallowing real code
 * after it on the same line) is not a shape any file in this tree has.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/**
 * Every file under `root`, outside `factory.homeDir` (its own
 * definition/barrel/tests all live there), outside all other test files, and
 * outside `loaderFile`, that still mentions `factory.name` in its
 * comment-stripped text — a raw collector factory reachable somewhere
 * `wrap()` never runs. Returned as human-legible strings so a failing
 * `toEqual([])` names the culprit.
 */
function findOutsideReferences(factory: RawCollectorFactory, root: string, loaderFile: string): string[] {
  const nameRe = new RegExp(`\\b${factory.name}\\b`)
  const resolvedHome = path.resolve(factory.homeDir) + path.sep
  const resolvedLoader = path.resolve(loaderFile)
  const violations: string[] = []
  for (const file of walkSourceFiles(root)) {
    const resolved = path.resolve(file)
    if (isTestFile(file)) continue
    if (resolved === resolvedLoader) continue
    if (resolved.startsWith(resolvedHome)) continue
    if (nameRe.test(stripComments(readFileSync(file, 'utf8')))) {
      violations.push(`${factory.name} referenced in ${path.relative(root, file)}`)
    }
  }
  return violations
}

describe('the collector-wrap-boundary law (#240, #353, #363)', () => {
  it('derives raw collector factories from the barrels — a walk matching nothing would pass every check below vacuously', () => {
    const factories = rawCollectorFactories(COLLECTORS_DIR)
    expect(factories.length).toBeGreaterThanOrEqual(5)

    // Known by name as a floor, not a ceiling: `toContain`, not `toEqual` —
    // a sixth collector added tomorrow must not require touching this list.
    const names = factories.map((f) => f.name)
    for (const known of [
      'gitCollector',
      'tmuxCollector',
      'createWorkmuxCollector',
      'createJudgeCollector',
      'createSessionlogCollector',
    ]) {
      expect(names).toContain(known)
    }
  })

  it('every derived factory is actually referenced by collector-loader.ts — otherwise the boundary check below passes on factories nobody wraps at all', () => {
    const loaderSource = readFileSync(LOADER_FILE, 'utf8')
    for (const factory of rawCollectorFactories(COLLECTORS_DIR)) {
      expect(
        new RegExp(`\\b${factory.name}\\b`).test(loaderSource),
        `${factory.name} is derived from its barrel but collector-loader.ts never mentions it`,
      ).toBe(true)
    }
  })

  it('every raw collector factory is referenced, outside its own definition/barrel/tests, only inside collector-loader.ts', () => {
    const offenders = rawCollectorFactories(COLLECTORS_DIR).flatMap((factory) =>
      findOutsideReferences(factory, SERVER_SRC, LOADER_FILE),
    )
    expect(offenders).toEqual([])
  })
})

/**
 * The law's own mutation proof, against a synthetic tree rather than this
 * repo's real one — the real tree is clean today, so proving the law can
 * fail means building a tree where it should not be. Runs the exact same
 * `rawCollectorFactories`/`findOutsideReferences` the live checks above use,
 * parameterised by root instead of hardcoded to `SERVER_SRC` — the failure
 * mode this exists to catch (a law that only ever reads its own passing
 * fixture) is why the live describe block above points those same functions
 * at the real tree, not a copy of it.
 *
 * Four decoys sit beside the one real violation, each aimed at a specific
 * clause of `walkSourceFiles`/`findOutsideReferences` so that clause — not
 * just the boundary check as a whole — has something to fail against if it
 * is ever weakened: a `fixtures/` file (the skip-list), a `.md` file (the
 * source-extension filter), a `*.test.ts` file outside the factory's home
 * (`isTestFile` — previously pinned only by this law's own floor list, see
 * #363 review), and a comment-only file mentioning the factory name from
 * both a `//` line comment and a `/** *\/` block comment (`stripComments` —
 * pinned after assembly false-positived on #454's doc comments, see #363
 * review). The real violation is nested three directories deep so that a
 * shallow-recursion regression has a violation it would actually miss.
 */
describe('the law bites, and the derived set is not a hardcoded list', () => {
  let root: string
  let collectorsDir: string
  let loaderFile: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'wrap-boundary-law-'))
    collectorsDir = path.join(root, 'collectors')
    loaderFile = path.join(root, 'server', 'collector-loader.ts')

    await mkdir(path.join(collectorsDir, 'git'), { recursive: true })
    await mkdir(path.dirname(loaderFile), { recursive: true })
    await writeFile(path.join(collectorsDir, 'git', 'index.ts'), "export { gitCollector } from './git-collector.js'\n")
    await writeFile(path.join(collectorsDir, 'git', 'git-collector.ts'), 'export const gitCollector = {}\n')
    await writeFile(
      path.join(collectorsDir, 'git', 'git-collector.test.ts'),
      "import { gitCollector } from './git-collector.js'\nconst _t = gitCollector\n",
    )
    await writeFile(
      loaderFile,
      "import { gitCollector } from '../collectors/git/index.js'\nexport const loaded = wrap(gitCollector)\n",
    )

    // Decoy: a fixtures/ reference — must stay invisible only because the
    // skip-list excludes the directory by name, not because nothing walks it.
    await mkdir(path.join(root, 'fixtures'), { recursive: true })
    await writeFile(path.join(root, 'fixtures', 'legacy-git-collector.ts'), 'export const legacyRef = gitCollector\n')

    // Decoy: a non-source file — must stay invisible only because the
    // extension filter excludes it, not because nothing walks it.
    await mkdir(path.join(root, 'docs'), { recursive: true })
    await writeFile(path.join(root, 'docs', 'notes.md'), 'gitCollector was spliced in once, see #240.\n')

    // Decoy: a test file outside the factory's home — must stay invisible
    // only because isTestFile excludes it, not because nothing walks it.
    await mkdir(path.join(root, 'other'), { recursive: true })
    await writeFile(path.join(root, 'other', 'helper.test.ts'), 'export const helperRef = gitCollector\n')

    // Decoy: a file whose ONLY mentions of gitCollector are inside comments —
    // one a `//` line comment, one inside a `/** ... */` JSDoc block — with
    // no import and no construction. Must stay invisible only because
    // stripComments removes both before matching, not because nothing walks
    // it (#363 review: this is the exact shape #454's resume-reconcile.ts
    // false-positived on).
    await mkdir(path.join(root, 'notes'), { recursive: true })
    await writeFile(
      path.join(root, 'notes', 'comment-only.ts'),
      [
        '// gitCollector is allocated once at boot, see collector-loader.ts.',
        '/**',
        ' * gitCollector never leaves collector-loader.ts directly; this doc',
        ' * comment exists only to describe its allocation contract.',
        ' */',
        'export const unrelated = 1',
        '',
      ].join('\n'),
    )
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('a clean tree passes: the one raw factory is referenced only in the loader and its own test, and the fixtures/non-source/test-file/comment-only decoys are correctly ignored', () => {
    const factories = rawCollectorFactories(collectorsDir)
    expect(factories.map((f) => f.name)).toEqual(['gitCollector'])

    const offenders = factories.flatMap((f) => findOutsideReferences(f, root, loaderFile))
    expect(offenders).toEqual([])
  })

  it('bites: a raw factory constructed outside the loader, several directories deep, turns the law red — the exact #240 shape', async () => {
    await mkdir(path.join(root, 'cli', 'nested', 'deep'), { recursive: true })
    await writeFile(
      path.join(root, 'cli', 'nested', 'deep', 'run.ts'),
      "import { gitCollector } from '../../../collectors/git/index.js'\nconst spliced = gitCollector\n",
    )

    const factories = rawCollectorFactories(collectorsDir)
    const offenders = factories.flatMap((f) => findOutsideReferences(f, root, loaderFile))

    expect(offenders).toEqual(['gitCollector referenced in cli/nested/deep/run.ts'])
  })

  it('the derived-set property: a sixth collector this law has never been told about is walked automatically, and still bites when spliced in raw', async () => {
    await mkdir(path.join(collectorsDir, 'sixth'), { recursive: true })
    await writeFile(
      path.join(collectorsDir, 'sixth', 'index.ts'),
      "export { createSixthCollector } from './collector.js'\n",
    )
    await writeFile(
      path.join(collectorsDir, 'sixth', 'collector.ts'),
      'export function createSixthCollector() { return {} }\n',
    )
    await mkdir(path.join(root, 'cli'), { recursive: true })
    await writeFile(
      path.join(root, 'cli', 'run.ts'),
      "import { createSixthCollector } from '../collectors/sixth/index.js'\nconst spliced = createSixthCollector()\n",
    )

    const factories = rawCollectorFactories(collectorsDir)
    // Nothing above named "createSixthCollector" — this is the barrel walk
    // finding it on its own, the property #353's hardcoded RAW_COLLECTORS
    // array could not have.
    expect(factories.map((f) => f.name)).toContain('createSixthCollector')

    const offenders = factories.flatMap((f) => findOutsideReferences(f, root, loaderFile))
    expect(offenders).toContain('createSixthCollector referenced in cli/run.ts')
  })

  it('the extractor really extracts, and really excludes type exports — the false-open a glob-only law would miss', () => {
    const source = [
      "export { gitCollector, GIT_CAPABILITIES } from './git-collector.js'",
      "export type { GitSnapshot } from './types.js'",
      "export { createFooCollector as makeFoo } from './foo.js'",
    ].join('\n')

    expect(namesExportedAsValues(source)).toEqual(['gitCollector', 'GIT_CAPABILITIES', 'createFooCollector'])
  })
})
