import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertCloneTarget, conciergeRoot } from './paths.js'

/**
 * THE CONCIERGE NAMESPACE LAW — prd-20 ruling 1's own condition, in the shape of
 * `lab/namespace-law.test.ts` and `recorder/namespace-law.test.ts`, and written
 * BEFORE the hand's code exists so the fence is never retrofitted around
 * whatever got built.
 *
 * The constitution (ADR-0001) grants three hands. ADR-0014 adds a fourth, the
 * concierge, with two powers no earlier hand has: it may **launch or relaunch a
 * conductor process**, and it may **clone a repo to disk**. Each is token-gated,
 * each is invoked only by an explicit human act in the UI, never from a
 * collector or a poll.
 *
 * This is the first hand that can execute a process, so this law is deliberately
 * stricter than its two predecessors in the one place they are known to be weak.
 *
 * ## What ADR-0001's Consequences told us to fix
 *
 * > a grep cannot see a dynamic import — `api/lab.ts` reaches the lab through
 * > `await import('../cli/index.js')`, and `walkSourceFiles(SERVER_SRC,
 * > [LAB_DIR])` excludes the lab directory from the walk, so the "sole importer"
 * > law passes while the boundary is crossed. Tracked as issue #245.
 *
 * Two separate holes live in that sentence, and this law closes both rather than
 * inheriting them:
 *
 * 1. **The check was one hop deep.** `api/lab.ts` does not import the lab; it
 *    imports `cli/index.ts`, which does. A per-file "does this text name the
 *    module" grep can never see that, no matter how good its regex. So this law
 *    does not grep per file — it builds the **whole import graph** of both
 *    packages and asks for *reachability*, at any depth, from anywhere.
 * 2. **The specifier could be spelled around the regex.** The lab's pattern
 *    requires a `'` or `"` immediately after `import(`, so a backtick template
 *    (`` import(`../concierge/${name}.js`) ``) walks straight through it, and a
 *    fully computed specifier (`import(modulePath)`) is invisible to any regex
 *    at all. So this law reads backticks too, AND refuses to be silently blind:
 *    a dynamic `import()` whose specifier is not a literal string is itself a
 *    violation (`no blind spots`, below), because an unanalysable edge would let
 *    the reachability check pass while knowing nothing.
 *
 * Path spellings are canonicalized on both sides through `realpath(3)`, so
 * `./concierge/../concierge/paths.js`, a symlinked directory, and a
 * case-different path on a case-insensitive filesystem all resolve to the same
 * node in the graph. The lab law needed four commits to get this right
 * (`1612a14`, `664a286`, `7a9219d`, `f01a41b`); it is cheaper to start here.
 *
 * ## The five clauses
 *
 * 1. **Reachability.** No source file outside the concierge module — in either
 *    package, at any depth, through static import, dynamic `import()`, `require`
 *    or re-export — reaches it. The declared-importer set is EMPTY: prd-20
 *    ruling 2 gates every concierge route on #234, and this lane ships no route.
 *    Whatever is added to that set later may never be a collector or a poll loop.
 * 2. **No blind spots.** No non-test server source file contains a dynamic
 *    `import()` with a non-literal specifier, because clause 1's graph cannot
 *    see through one. A law that cannot see is worse than no law (#245, #319).
 * 3. **No clock.** Nothing under `concierge/` schedules work, so "never launches
 *    and never clones without a human's explicit command" holds structurally.
 * 4. **No shell.** Nothing under `concierge/` reaches a shell — no `exec`/
 *    `execSync` string-command form, no `shell: true`. When the launch power
 *    lands it spawns an argv array or it does not spawn. This is the clause that
 *    matters most: the hand's whole purpose is to run a process.
 * 5. **The clone fence, live.** `assertCloneTarget` is run against real
 *    directories on a real filesystem — symlink escape, `..` escape, the watched
 *    repo, the other hands' namespaces — so the containment claim is executed,
 *    not read.
 *
 * Clauses 1–4 read source text, like the two laws before them. Every detector
 * has a paired test proving it fires on a synthetic violation, and clause 1's
 * detector is additionally proven against real code: it is asserted to see the
 * exact `api/lab.ts -> cli/index.ts -> lab/` chain that #245 is about.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
// packages/server/src/concierge -> repo root
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..')
const SERVER_SRC = path.join(REPO_ROOT, 'packages', 'server', 'src')
const WEB_SRC = path.join(REPO_ROOT, 'packages', 'web', 'src')
const CONCIERGE_DIR = path.join(SERVER_SRC, 'concierge')

/**
 * The files allowed to reach the concierge module. **Empty, deliberately.**
 *
 * prd-20 ruling 2: no concierge route ships before #234's capability-token
 * guard covers every mutating route, and this lane ships no route at all. The
 * set is the seam a later wave adds its ONE token-gated entry point to — named
 * here, in the law, rather than discovered in a diff.
 */
const ALLOWED_IMPORTERS: ReadonlySet<string> = new Set<string>()

/**
 * Files that may never be in {@link ALLOWED_IMPORTERS}, whatever a later wave
 * decides. "Never from a collector or a poll" is the amendment's own condition,
 * so it is asserted against the set itself rather than left to whoever edits it.
 */
const NEVER_AN_IMPORTER = [
  path.join(SERVER_SRC, 'server', 'poll-loop.ts'),
  path.join(SERVER_SRC, 'server', 'collector-loader.ts'),
  path.join(SERVER_SRC, 'collectors'),
  WEB_SRC,
]

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])

function walkSourceFiles(dir: string): string[] {
  const out: string[] = []
  const visit = (current: string) => {
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const full = path.join(current, entry)
      if (statSync(full).isDirectory()) visit(full)
      else if (SOURCE_EXTENSIONS.has(path.extname(full))) out.push(full)
    }
  }
  visit(dir)
  return out
}

function isTest(file: string): boolean {
  return file.endsWith('.test.ts') || file.endsWith('.test.tsx')
}

/**
 * A file's CODE, with comments removed — the same move the recorder law makes,
 * and for the same reason: this law's own doc comment names every construct it
 * forbids, and a check that fired on prose would be unwritable. Crude on
 * purpose (a `//` inside a string literal truncates its line) and legible by eye.
 */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/**
 * Every module specifier in a file's code: `from '…'`, a bare `import '…'`, a
 * dynamic `import('…')`, and `require('…')` — in single quotes, double quotes,
 * **or backticks**. The backtick arm is the one the lab law is missing; a
 * template with `${…}` in it still yields its literal text, which is enough for
 * the directory segment this law cares about to be seen.
 */
const SPECIFIER_RE = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)(['"`])([^'"`]*)\1/g

function importSpecifiers(code: string): string[] {
  const out: string[] = []
  for (const match of code.matchAll(SPECIFIER_RE)) {
    const specifier = match[2]
    if (specifier !== undefined && specifier.length > 0) out.push(specifier)
  }
  return out
}

/**
 * The arguments of every dynamic `import(…)` / `require(…)` that is NOT a plain
 * string literal — the edges no regex can follow. Clause 2 forbids them
 * outright; see the module comment.
 */
const DYNAMIC_CALL_RE = /\b(?:import|require)\s*\(\s*([^)]*)/g

function nonLiteralDynamicSpecifiers(code: string): string[] {
  const out: string[] = []
  for (const match of code.matchAll(DYNAMIC_CALL_RE)) {
    const argument = (match[1] ?? '').trim()
    if (argument.length === 0) continue
    // A literal is a quote, then no further quote of that kind until the close.
    const quote = argument[0]
    if (quote === "'" || quote === '"' || quote === '`') {
      const rest = argument.slice(1)
      const end = rest.indexOf(quote)
      // Two things that LOOK like a literal but are not, and both matter here:
      // `'./x.js' + suffix` is a literal that has been concatenated, and
      // `` `./${slug}.js` `` is a template whose real specifier is decided at
      // runtime. Clause 1's regex happily reads the literal TEXT of the second
      // one — which is why it catches `` import(`../concierge/${x}.js`) `` — but
      // reading the text is not the same as knowing where it resolves, so a
      // template with a substitution in it is still a blind edge.
      const interpolated = quote === '`' && rest.slice(0, end < 0 ? rest.length : end).includes('${')
      if (end >= 0 && !interpolated && rest.slice(end + 1).trim().length === 0) continue
    }
    out.push(argument)
  }
  return out
}

/**
 * A tree of source files the graph is built over: canonical absolute path to
 * code text, plus the canonicalizer that produced those keys.
 *
 * Two implementations. The real one reads the repo and canonicalizes through
 * `realpath(3)`, so a symlinked directory or a case-different spelling lands on
 * the same key. The synthetic one is a literal Map with an identity
 * canonicalizer, so the graph machinery can be proven to bite on violations
 * that do not exist in this repo (multi-hop, backtick, re-export) without
 * writing files to disk.
 */
interface SourceTree {
  files: ReadonlyMap<string, string>
  canonical: (candidate: string) => string
}

/** `realpath(3)`, falling back to a plain resolve for a path that does not exist. */
const realCanonical = (candidate: string): string => {
  try {
    return (realpathSync.native ?? realpathSync)(candidate)
  } catch {
    return path.resolve(candidate)
  }
}

function realSourceTree(): SourceTree {
  const files = new Map<string, string>()
  for (const file of [...walkSourceFiles(SERVER_SRC), ...walkSourceFiles(WEB_SRC)]) {
    files.set(realCanonical(file), codeOf(readFileSync(file, 'utf8')))
  }
  return { files, canonical: realCanonical }
}

function syntheticTree(files: Record<string, string>): SourceTree {
  const map = new Map<string, string>()
  for (const [file, source] of Object.entries(files)) map.set(path.resolve(file), codeOf(source))
  return { files: map, canonical: (candidate) => path.resolve(candidate) }
}

/**
 * The file a relative specifier names, or `null` for a bare/package specifier or
 * one that resolves to nothing in the tree.
 *
 * Specifiers in this repo are NodeNext-style — a `.ts` file is imported as
 * `.js`. `path.resolve` collapses `..` segments, so
 * `./concierge/../concierge/paths.js` and `./concierge/paths.js` are the same
 * node, and `tree.canonical` collapses symlinks and (on a case-insensitive
 * filesystem) case.
 */
function resolveSpecifier(fromFile: string, specifier: string, tree: SourceTree): string | null {
  if (!specifier.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = base.endsWith('.js')
    ? [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx')]
    : base.endsWith('.jsx')
      ? [base.replace(/\.jsx$/, '.tsx')]
      : base.endsWith('.ts') || base.endsWith('.tsx')
        ? [base]
        : [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]

  for (const candidate of candidates) {
    const canonical = tree.canonical(candidate)
    if (tree.files.has(canonical)) return canonical
  }
  return null
}

/** file -> the files it imports, at any kind of import. */
function buildImportGraph(tree: SourceTree): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  for (const [file, code] of tree.files) {
    const edges: string[] = []
    for (const specifier of importSpecifiers(code)) {
      const target = resolveSpecifier(file, specifier, tree)
      if (target !== null && target !== file) edges.push(target)
    }
    graph.set(file, edges)
  }
  return graph
}

/**
 * The shortest import chain from `start` to a file satisfying `isTarget`, or
 * `null` if none exists. Returned as a path, not a boolean, so a failure names
 * the route rather than just its existence — the thing #245 needed and a
 * per-file grep can never produce.
 */
function shortestChain(
  graph: ReadonlyMap<string, string[]>,
  start: string,
  isTarget: (file: string) => boolean,
): string[] | null {
  const queue: string[][] = [[start]]
  const seen = new Set([start])
  while (queue.length > 0) {
    const chain = queue.shift() as string[]
    const tip = chain[chain.length - 1] as string
    if (chain.length > 1 && isTarget(tip)) return chain
    for (const next of graph.get(tip) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push([...chain, next])
    }
  }
  return null
}

const CANONICAL_CONCIERGE_DIR = realCanonical(CONCIERGE_DIR)

function isInConcierge(file: string): boolean {
  return file === CANONICAL_CONCIERGE_DIR || file.startsWith(CANONICAL_CONCIERGE_DIR + path.sep)
}

function relative(file: string): string {
  return path.relative(REPO_ROOT, file)
}

function conciergeSourceFiles(): string[] {
  return walkSourceFiles(CONCIERGE_DIR).filter((file) => !isTest(file))
}

describe('the concierge namespace law (prd-20 ruling 1 / ADR-0014)', () => {
  describe('the module the law is about actually exists — an empty directory proves nothing', () => {
    it('has non-test source files to check', () => {
      const files = conciergeSourceFiles().map(relative)
      expect(files.length).toBeGreaterThan(0)
      expect(files).toContain(path.join('packages', 'server', 'src', 'concierge', 'paths.ts'))
    })

    it('and the fence it defines is a real runtime refusal, not a comment', () => {
      // Executed rather than described: the export the whole clone clause rests
      // on both exists and throws. The live clause below runs it for real.
      expect(typeof assertCloneTarget).toBe('function')
      expect(conciergeRoot('/data')).toBe(path.join('/data', 'concierge'))
    })
  })

  describe('clause 1 — nothing outside the module reaches it, at any depth', () => {
    const tree = realSourceTree()
    const graph = buildImportGraph(tree)

    it('walked a real tree of both packages — the graph is not empty', () => {
      expect(tree.files.size).toBeGreaterThan(300)
      expect([...tree.files.keys()].some(isInConcierge)).toBe(true)
    })

    it('sees the DYNAMIC import #245 is about — the edge the lab law is blind to', () => {
      // `api/lab.ts` line ~361: `const { runCli } = await import('../cli/index.js')`.
      // If this assertion ever fails because that line moved, do not delete it —
      // replace it with whatever dynamic import the repo then has, or this law
      // loses its only proof that it reads dynamic edges out of real code.
      const apiLab = realCanonical(path.join(SERVER_SRC, 'api', 'lab.ts'))
      const cliIndex = realCanonical(path.join(SERVER_SRC, 'cli', 'index.ts'))
      expect(graph.get(apiLab)).toContain(cliIndex)
    })

    it('sees the TRANSITIVE reach #245 is about — api/lab.ts to lab/, two hops through the CLI', () => {
      // The lab's own law passes on this chain. Ours must see it, or clause 1 is
      // the same law with a better comment.
      const apiLab = realCanonical(path.join(SERVER_SRC, 'api', 'lab.ts'))
      const labDir = realCanonical(path.join(SERVER_SRC, 'lab'))
      const chain = shortestChain(graph, apiLab, (file) => file.startsWith(labDir + path.sep))
      expect(chain, 'the graph cannot see api/lab.ts reaching lab/ — clause 1 is blind').not.toBeNull()
      expect((chain as string[]).length).toBeGreaterThan(2) // not a direct import; a chain
    })

    it('no file in either package reaches the concierge module', () => {
      // Canonicalized, because the graph's keys are: on a machine whose checkout
      // sits behind a symlink, comparing a raw declared path against a canonical
      // graph key would silently never match.
      const declared = new Set([...ALLOWED_IMPORTERS].map(realCanonical))
      const violations: string[] = []
      for (const file of tree.files.keys()) {
        if (isInConcierge(file)) continue
        if (declared.has(file)) continue
        const chain = shortestChain(graph, file, isInConcierge)
        if (chain !== null) violations.push(chain.map(relative).join(' -> '))
      }
      expect(violations).toEqual([])
    })

    it('no collector and no poll loop reaches it — named files, not left to the sweep', () => {
      // The sweep above covers these already. Naming them is what survives a
      // future refactor of the sweep, and what makes the amendment's own
      // condition ("never from a collector or a poll") legible as a test.
      const named = [
        path.join(SERVER_SRC, 'server', 'poll-loop.ts'),
        path.join(SERVER_SRC, 'server', 'collector-loader.ts'),
        path.join(SERVER_SRC, 'collectors', 'git', 'git-collector.ts'),
        path.join(SERVER_SRC, 'collectors', 'sessionlog', 'collector.ts'),
        path.join(SERVER_SRC, 'cli', 'index.ts'),
      ]
      for (const file of named) {
        const canonical = realCanonical(file)
        expect(tree.files.has(canonical), `${relative(file)} is not in the graph — has it moved?`).toBe(true)
        expect(shortestChain(graph, canonical, isInConcierge)?.map(relative).join(' -> ')).toBeUndefined()
      }
    })

    it('the declared-importer set is empty, and that is the ruling, not an omission', () => {
      // prd-20 ruling 2. When a later wave adds its token-gated route here, this
      // assertion is what makes it stop and read the ruling first.
      expect([...ALLOWED_IMPORTERS]).toEqual([])
    })

    it('no collector, no poll loop and no web file may ever be a declared importer', () => {
      const forbidden = [...ALLOWED_IMPORTERS].filter((importer) =>
        NEVER_AN_IMPORTER.some((banned) => importer === banned || importer.startsWith(banned + path.sep)),
      )
      expect(forbidden).toEqual([])
    })

    it('the module reaches into no other hand either — it borrows no grant it was not given', () => {
      const otherHands = ['lab', 'recorder', 'api'].map((hand) => realCanonical(path.join(SERVER_SRC, hand)))
      const offenders: string[] = []
      for (const file of conciergeSourceFiles()) {
        const canonical = realCanonical(file)
        const chain = shortestChain(graph, canonical, (target) =>
          otherHands.some((hand) => target === hand || target.startsWith(hand + path.sep)),
        )
        if (chain !== null) offenders.push(chain.map(relative).join(' -> '))
      }
      expect(offenders).toEqual([])
    })
  })

  describe('clause 1, proven against synthetic violations — the detector bites', () => {
    /** Every file in a synthetic tree that reaches `/repo/src/concierge/`. */
    function reachers(files: Record<string, string>): string[] {
      const tree = syntheticTree(files)
      const graph = buildImportGraph(tree)
      const target = path.resolve('/repo/src/concierge')
      const inTarget = (file: string) => file.startsWith(target + path.sep)
      const out: string[] = []
      for (const file of tree.files.keys()) {
        if (inTarget(file)) continue
        if (shortestChain(graph, file, inTarget) !== null) out.push(path.basename(file))
      }
      return out.sort()
    }

    const THE_HAND = { '/repo/src/concierge/paths.ts': 'export const fence = 1\n' }

    it('a plain static import is caught', () => {
      expect(
        reachers({ ...THE_HAND, '/repo/src/collectors/git.ts': `import { fence } from '../concierge/paths.js'\n` }),
      ).toEqual(['git.ts'])
    })

    it('a quoted DYNAMIC import is caught', () => {
      expect(
        reachers({
          ...THE_HAND,
          '/repo/src/collectors/git.ts': `const m = await import('../concierge/paths.js')\n`,
        }),
      ).toEqual(['git.ts'])
    })

    it('a BACKTICK dynamic import is caught — the spelling that walks through the lab law', () => {
      expect(
        reachers({
          ...THE_HAND,
          '/repo/src/collectors/git.ts': 'const m = await import(`../concierge/paths.js`)\n',
        }),
      ).toEqual(['git.ts'])
    })

    it('a TWO-HOP reach through an innocent helper is caught — #245 in miniature', () => {
      // Nothing in `git.ts` names the concierge. This is the exact shape that
      // makes the lab's "sole importer" law pass while the boundary is crossed.
      expect(
        reachers({
          ...THE_HAND,
          '/repo/src/collectors/helper.ts': `export { fence } from '../concierge/paths.js'\n`,
          '/repo/src/collectors/git.ts': `import { fence } from './helper.js'\n`,
        }),
      ).toEqual(['git.ts', 'helper.ts'])
    })

    it('a three-hop reach whose middle hop is a dynamic import is caught', () => {
      expect(
        reachers({
          ...THE_HAND,
          '/repo/src/cli/index.ts': `import { fence } from '../concierge/paths.js'\n`,
          '/repo/src/api/lab.ts': `const { fence } = await import('../cli/index.js')\n`,
          '/repo/src/server/poll-loop.ts': `import '../api/lab.js'\n`,
        }).sort(),
      ).toEqual(['index.ts', 'lab.ts', 'poll-loop.ts'])
    })

    it('a re-export is caught — `export * from` is an import wearing a hat', () => {
      expect(
        reachers({ ...THE_HAND, '/repo/src/index.ts': `export * from './concierge/paths.js'\n` }),
      ).toEqual(['index.ts'])
    })

    it('a path spelled through itself is caught — ./concierge/../concierge/paths.js', () => {
      expect(
        reachers({
          ...THE_HAND,
          '/repo/src/index.ts': `import { fence } from './concierge/../concierge/paths.js'\n`,
        }),
      ).toEqual(['index.ts'])
    })

    it('a bare `import` of the module for its side effects is caught', () => {
      expect(reachers({ ...THE_HAND, '/repo/src/index.ts': `import './concierge/paths.js'\n` })).toEqual(['index.ts'])
    })

    it('a `require` is caught', () => {
      expect(
        reachers({ ...THE_HAND, '/repo/src/index.ts': `const m = require('./concierge/paths.js')\n` }),
      ).toEqual(['index.ts'])
    })

    it('and it does NOT fire on an ordinary import, or on prose naming the module', () => {
      expect(
        reachers({
          ...THE_HAND,
          '/repo/src/collectors/git.ts': `import { readSessionEvents } from '../log/session-log.js'\n`,
          '/repo/src/log/session-log.ts': 'export const readSessionEvents = 1\n',
          '/repo/src/api/index.ts': `// TODO: wire ../concierge/paths.js once #234 lands\nexport const routes = []\n`,
        }),
      ).toEqual([])
    })

    it('and it does not confuse a same-named directory in the other package for this one', () => {
      // prd14 gave web its own `lab/`; the same trap is one commit away for the
      // concierge. Resolution is by path, so a sibling of the same name is not it.
      expect(
        reachers({
          ...THE_HAND,
          '/repo/web/concierge/Panel.tsx': 'export const Panel = 1\n',
          '/repo/web/App.tsx': `import { Panel } from './concierge/Panel.js'\n`,
        }),
      ).toEqual([])
    })
  })

  describe('clause 2 — no blind spots: every dynamic import has a literal specifier', () => {
    it('no non-test server source file hides a module behind a computed specifier', () => {
      const offenders: string[] = []
      for (const file of walkSourceFiles(SERVER_SRC)) {
        if (isTest(file)) continue
        for (const argument of nonLiteralDynamicSpecifiers(codeOf(readFileSync(file, 'utf8')))) {
          offenders.push(`${relative(file)}: import(${argument})`)
        }
      }
      expect(offenders).toEqual([])
    })

    it('that detector bites on every shape of unanalysable edge', () => {
      expect(nonLiteralDynamicSpecifiers('const m = await import(modulePath)')).toEqual(['modulePath'])
      expect(nonLiteralDynamicSpecifiers('const m = await import(`./${slug}/index.js`)')).toEqual([
        '`./${slug}/index.js`',
      ])
      expect(nonLiteralDynamicSpecifiers(`const m = await import('../concierge/' + name)`)).toEqual([
        `'../concierge/' + name`,
      ])
      expect(nonLiteralDynamicSpecifiers('const m = await import(SOME_CONST)')).toEqual(['SOME_CONST'])
    })

    it('and does not fire on a literal, on `import.meta`, or on a doc comment describing the danger', () => {
      expect(nonLiteralDynamicSpecifiers(`const m = await import('../cli/index.js')`)).toEqual([])
      expect(nonLiteralDynamicSpecifiers('const m = await import(`../cli/index.js`)')).toEqual([])
      expect(nonLiteralDynamicSpecifiers('const here = fileURLToPath(import.meta.url)')).toEqual([])
      expect(nonLiteralDynamicSpecifiers(codeOf('// a variable import like import(`./${slug}`) is banned\n'))).toEqual(
        [],
      )
    })
  })

  describe('clause 3 — the concierge has no clock of its own', () => {
    it('no source file in the module schedules work — it never launches or clones without a human', () => {
      const offenders: string[] = []
      for (const file of conciergeSourceFiles()) {
        if (/\b(?:setInterval|setTimeout|setImmediate)\s*\(/.test(codeOf(readFileSync(file, 'utf8')))) {
          offenders.push(relative(file))
        }
      }
      expect(offenders).toEqual([])
    })

    it('that detector bites', () => {
      expect(/\b(?:setInterval|setTimeout|setImmediate)\s*\(/.test('setInterval(() => relaunch(), 60_000)')).toBe(true)
    })
  })

  describe('clause 4 — the hand that runs a process never reaches a shell', () => {
    /**
     * The string-command forms of `child_process`, and the option that turns any
     * spawn into one. `spawn`/`execFile`/`spawnSync`/`execFileSync` take an argv
     * array and are deliberately NOT forbidden — the launch power needs one of
     * them. `exec`/`execSync` take a command line a shell parses, which is how a
     * repo URL or a branch name becomes arbitrary code.
     *
     * `\bexec\s*\(` would also match this repo's own injected `Exec` seam
     * (ADR-0004, `server/exec.ts`), which is an argv-array function and not a
     * shell — so the pattern requires the `child_process` spelling or the
     * `Sync` suffix, and the negative test below pins that.
     */
    const SHELL_PATTERNS: Array<{ what: string; pattern: RegExp }> = [
      { what: 'execSync — a shell command line', pattern: /\bexecSync\s*\(/ },
      {
        what: 'exec imported from child_process',
        pattern: /import\s*\{[^}]*\bexec\b(?!File)[^}]*\}\s*from\s*['"]node:child_process['"]/,
      },
      { what: 'exec off a child_process namespace', pattern: /\bchild_process\b[^\n]*\.\s*exec\b(?!File)/ },
      { what: 'a shell-enabled spawn', pattern: /\bshell\s*:\s*(?:true|['"])/ },
    ]

    it('nothing in the module reaches a shell', () => {
      const offenders: string[] = []
      for (const file of conciergeSourceFiles()) {
        const code = codeOf(readFileSync(file, 'utf8'))
        for (const { what, pattern } of SHELL_PATTERNS) {
          if (pattern.test(code)) offenders.push(`${relative(file)}: ${what}`)
        }
      }
      expect(offenders).toEqual([])
    })

    /** True if ANY clause-4 pattern fires — the check as the law applies it. */
    function reachesAShell(code: string): boolean {
      return SHELL_PATTERNS.some(({ pattern }) => pattern.test(code))
    }

    it('those detectors bite on the forms that let a repo URL become code', () => {
      for (const violation of [
        `import { exec } from 'node:child_process'`,
        `import { exec, spawn } from 'node:child_process'`,
        'execSync(`git clone ${url}`)',
        `const cp = require('node:child_process'); cp.exec(cmd)`,
        `spawn(cmd, { shell: true })`,
        `spawn(cmd, { shell: '/bin/sh' })`,
      ]) {
        expect(reachesAShell(violation), `missed: ${violation}`).toBe(true)
      }
    })

    it('and do not fire on the argv-array spawns the launch power will legitimately need', () => {
      for (const legitimate of [
        `import { spawn } from 'node:child_process'`,
        `import { execFile } from 'node:child_process'`,
        `import { execFileSync } from 'node:child_process'`,
        `spawn('claude', ['--continue'], { env, cwd })`,
        `await execFile('git', ['clone', url, target])`,
        `import { exec as realExec } from '../server/exec.js'`, // ADR-0004's argv seam, not a shell
      ]) {
        expect(reachesAShell(legitimate), `false positive on: ${legitimate}`).toBe(false)
      }
    })
  })
})

/**
 * Clause 5 — the live half. Everything above reads source text; this runs the
 * clone fence against real directories, because a containment predicate that
 * has never met a symlink is a claim, not a fence.
 *
 * Hermetic under 4x concurrency: one `mkdtemp` root per test, no ambient `~`.
 */
describe('the concierge namespace law, live (prd-20 ruling 1 / ADR-0014)', () => {
  let root: string
  let clonesRoot: string
  let watchedRepoPath: string
  let dataRoot: string

  function fence() {
    return { clonesRoot, watchedRepoPath, dataRoot }
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-concierge-law-test-'))
    clonesRoot = path.join(root, 'clones')
    watchedRepoPath = path.join(root, 'watched-repo')
    dataRoot = path.join(root, 'data')
    await mkdir(clonesRoot, { recursive: true })
    await mkdir(path.join(watchedRepoPath, 'src'), { recursive: true })
    await mkdir(path.join(dataRoot, 'lab', 'worktrees'), { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('permits the one thing the power is for — a clone inside the root it was handed', () => {
    expect(() => assertCloneTarget(fence(), path.join(clonesRoot, 'someone-elses-repo'))).not.toThrow()
  })

  it('refuses every write into the watched repo — the clause that can never be relaxed', () => {
    for (const target of [
      watchedRepoPath,
      path.join(watchedRepoPath, 'src'),
      path.join(watchedRepoPath, 'clone'),
      path.join(watchedRepoPath, '.git', 'refs', 'heads', 'sneaky'),
    ]) {
      expect(() => assertCloneTarget(fence(), target), `permitted a write to ${target}`).toThrow()
    }
  })

  it('refuses a symlink inside the clone root that points out of it — the hostile spelling', async () => {
    const outside = path.join(root, 'outside')
    await mkdir(outside, { recursive: true })
    await symlink(outside, path.join(clonesRoot, 'bolthole'))
    expect(() => assertCloneTarget(fence(), path.join(clonesRoot, 'bolthole', 'repo'))).toThrow()
  })

  it('refuses a symlink inside the clone root that points AT the watched repo', async () => {
    await symlink(watchedRepoPath, path.join(clonesRoot, 'watched-link'))
    expect(() => assertCloneTarget(fence(), path.join(clonesRoot, 'watched-link', 'nested'))).toThrow()
  })

  it('refuses the other hands\' namespaces under the data root', () => {
    for (const stolen of [path.join(dataRoot, 'lab', 'worktrees'), path.join(dataRoot, 'repo-deadbeef')]) {
      expect(() =>
        assertCloneTarget({ ...fence(), clonesRoot: stolen }, path.join(stolen, 'repo')),
        `permitted a clone root at ${stolen}`,
      ).toThrow()
    }
  })

  it('and a clone root the concierge does own inside the data root is fine', () => {
    const mine = path.join(conciergeRoot(dataRoot), 'clones')
    expect(() => assertCloneTarget({ ...fence(), clonesRoot: mine }, path.join(mine, 'repo'))).not.toThrow()
  })

  it('survives a case-different spelling of the clone root on a case-insensitive filesystem', () => {
    // On macOS the two spellings are one directory and the escape must still be
    // caught; on Linux they are two directories and the target is outside the
    // root, so it is caught for a different and equally correct reason. Either
    // way this must never be a false ALLOW.
    const shouted = path.join(root, 'CLONES')
    expect(() => assertCloneTarget({ ...fence(), clonesRoot: shouted }, path.join(root, 'elsewhere'))).toThrow()
  })
})
