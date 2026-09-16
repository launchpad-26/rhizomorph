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
 * The constitution (ADR-0001) grants three hands. ADR-0019 adds a fourth, the
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
 * 3. **A third spelling, found in review of #351: escape sequences.** The source
 *    text `import { x } from '../concier\u0067e/paths.js'` is a plain string
 *    literal, so clause 2 has nothing to complain about, and its RAW text
 *    resolves to no file, so clause 1 saw a clean tree while Node loaded
 *    `../concierge/paths.js` (executed against real Node, not reasoned about).
 *    So every specifier is decoded before it is resolved — see
 *    {@link decodeStringEscapes}.
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
 *    or re-export — reaches it. The declared-importer set started EMPTY (this
 *    law landed before the hand's first route, so nothing could reach it yet)
 *    and now names exactly `api/concierge.ts` — #263's read-only discovery
 *    route, #262's clone-by-URL route, and #264's launch route all go through
 *    that one file, per prd-20 ruling 2's gate on #234. Whatever is added to
 *    that set later may never be a collector or a poll loop.
 * 2. **No blind spots.** No non-test server source file contains a dynamic
 *    `import()` with a non-literal specifier, because clause 1's graph cannot
 *    see through one. A law that cannot see is worse than no law (#245, #319).
 * 3. **No clock.** Nothing under `concierge/` schedules work, so "never launches
 *    and never clones without a human's explicit command" holds structurally.
 * 4. **No shell.** Nothing under `concierge/` reaches a shell — no `exec`/
 *    `execSync` string-command form, no `shell: true`. When the launch power
 *    lands it spawns an argv array or it does not spawn. This is the clause that
 *    matters most: the hand's whole purpose is to run a process.
 *
 *    **Known limit (#373), not regex-fixable.** An argv launch can still reach
 *    a shell — `execFile('/bin/sh', ['-c', cmd])` or `spawn('bash', ['-lc',
 *    cmd])` obey this clause's letter, because the clause forbids the
 *    shell-COMMAND form, not the executable named, and the launch power
 *    deliberately needs argv spawns. `spawn('claude', […])` and
 *    `spawn('bash', […])` differ only in which executable — an allowlist
 *    question, not a spelling one — so this law does not attempt it. #358's
 *    harness registry is the mechanism that closes it: once the executable a
 *    real launch spawns comes from the adapter rather than from a request,
 *    "nothing under `concierge/` reaches a shell" is true by construction, not
 *    by this law's text-reading.
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
 * The files allowed to reach the concierge module. **Exactly one**, named here
 * in the law rather than discovered in a diff.
 *
 * #263 is the first lane to add one: `api/concierge.ts`, carrying
 * `GET /api/concierge/repos` — prd-20 ruling 5's read-only repo discovery. It
 * needs no capability token (ruling 2 gates MUTATING routes; this one writes
 * nothing), and it is neither a collector nor a poll: a human opening the setup
 * wizard's picker triggers it, like any other `GET`.
 *
 * Exactly this one file — not the `api/` directory, not a pattern. The next
 * wave that wants in reads this comment and adds its own single file the same
 * way, and #262 in particular is warned not to widen it to a glob.
 *
 * **It BOUNDS the walk; it does not exempt a node.** Found in review of #351:
 * exempting the file itself admits the route and then convicts everything above
 * it, because the sweep asks every other file for a chain into the hand — so
 * `api/index.ts -> api/concierge.ts -> concierge/…`, `server/build-app.ts`, the
 * CLI above it and every `buildApp` test would all become violations the moment
 * the one legitimate route was declared. A declared importer is therefore a
 * TERMINUS: chains stop there, and what lies above it inherits its grant.
 *
 * What that deliberately does NOT relax: {@link NEVER_AN_IMPORTER} is checked
 * against the RAW graph, unbounded. A collector or a poll loop reaching the hand
 * THROUGH the gate is still a violation, because ADR-0019's condition is "never
 * from a collector, never from a poll" and a gate does not make a poll a human.
 */
const ALLOWED_IMPORTERS: ReadonlySet<string> = new Set<string>([path.join(SERVER_SRC, 'api', 'concierge.ts')])

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

/**
 * The four files judged against the RAW graph — no gate bound, no exemption.
 *
 * For a collector or a poll loop ANY route into the hand is a violation, gate or
 * no gate (ADR-0019 grant 3, "never from a collector, never from a poll"). They
 * are named rather than left to the bounded sweep because the bound is exactly
 * what would hide them: once a route is declared, the sweep stops before it and
 * a poll loop importing that route reads as clean.
 *
 * `cli/index.ts` is deliberately NOT here. It boots the server that carries the
 * route, so reaching the hand through the gate is what it is for; it is asserted
 * under the bounded walk instead.
 */
const RAW_GRAPH_FILES = [
  path.join(SERVER_SRC, 'server', 'poll-loop.ts'),
  path.join(SERVER_SRC, 'server', 'collector-loader.ts'),
  path.join(SERVER_SRC, 'collectors', 'git', 'git-collector.ts'),
  path.join(SERVER_SRC, 'collectors', 'sessionlog', 'collector.ts'),
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

/**
 * A string literal's escape sequences, resolved to the characters they name —
 * because Node resolves `'../concier\u0067e/paths.js'` to
 * `../concierge/paths.js` and the law must see the same module Node does.
 *
 * Found in review of #351: this was a third spelling of #245's hole, cheaper
 * than `eval` and invisible to both clause 1 (raw text resolves to no file, so
 * no edge) and clause 2 (it is a plain literal, so not a blind edge). Decoding
 * closes it in the one place both clauses read from.
 *
 * Deliberately generous: `\uXXXX`, `\u{X…}`, `\xXX`, the named control escapes,
 * and for anything else the escaped character itself (`\/` is `/`). Over-eager
 * decoding can only ever make MORE specifiers resolve to a real file, which is
 * the safe direction for a fence.
 */
const ESCAPE_RE = /\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\s\S]))/g
const NAMED_ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
}

function decodeStringEscapes(raw: string): string {
  return raw.replace(ESCAPE_RE, (_match, braced, u4, x2, other) => {
    if (braced !== undefined) return String.fromCodePoint(Number.parseInt(braced, 16))
    if (u4 !== undefined) return String.fromCharCode(Number.parseInt(u4, 16))
    if (x2 !== undefined) return String.fromCharCode(Number.parseInt(x2, 16))
    return NAMED_ESCAPES[other as string] ?? (other as string)
  })
}

function importSpecifiers(code: string): string[] {
  const out: string[] = []
  for (const match of code.matchAll(SPECIFIER_RE)) {
    const specifier = match[2]
    if (specifier !== undefined && specifier.length > 0) out.push(decodeStringEscapes(specifier))
  }
  return out
}

/**
 * The arguments of every dynamic `import(…)` / `require(…)` that is NOT a plain
 * string literal — the edges no regex can follow. Clause 2 forbids them
 * outright; see the module comment.
 */
const DYNAMIC_CALL_RE = /\b(?:import|require)\s*\(\s*([^)]*)/g

/**
 * Scans `code` from just past a literal's opening quote for the first
 * UNESCAPED instance of that same quote character. Returns its index, or -1
 * if the literal never closes.
 */
function matchingQuoteIndex(code: string, openQuoteIndex: number, quote: string): number {
  let i = openQuoteIndex + 1
  while (i < code.length) {
    if (code[i] === '\\') {
      i += 2
      continue
    }
    if (code[i] === quote) return i
    i++
  }
  return -1
}

function nonLiteralDynamicSpecifiers(code: string): string[] {
  const out: string[] = []
  for (const match of code.matchAll(DYNAMIC_CALL_RE)) {
    const argument = (match[1] ?? '').trim()
    if (argument.length === 0) continue
    // A literal is a quote, then no further quote of that kind until the close.
    const quote = argument[0]
    if (quote === "'" || quote === '"' || quote === '`') {
      // DYNAMIC_CALL_RE stops at the first `)`, so a literal containing one —
      // `import('./(group)/foo.js')` — truncates `argument` mid-string, before
      // its own closing quote. Re-scanning the full `code` from the literal's
      // true start (rather than trusting where the capture happened to stop)
      // finds the real closing quote regardless of what the literal contains
      // (#374 — review of #351 found this reads a correct route-group path as
      // an unanalysable specifier, a false CI failure on legitimate code).
      const argStart = (match.index ?? 0) + match[0].length - match[1]!.length
      const closeQuote = matchingQuoteIndex(code, argStart, quote)
      if (closeQuote >= 0) {
        let after = closeQuote + 1
        while (after < code.length && /\s/.test(code[after]!)) after++
        // Two things that LOOK like a literal but are not, and both matter here:
        // `'./x.js' + suffix` is a literal that has been concatenated, and
        // `` `./${slug}.js` `` is a template whose real specifier is decided at
        // runtime. Clause 1's regex happily reads the literal TEXT of the second
        // one — which is why it catches `` import(`../concierge/${x}.js`) `` —
        // but reading the text is not the same as knowing where it resolves, so
        // a template with a substitution in it is still a blind edge.
        const interpolated = quote === '`' && code.slice(argStart + 1, closeQuote).includes('${')
        // A plain literal call has nothing between the closing quote and the
        // call's own closing paren.
        if (!interpolated && code[after] === ')') continue
      }
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
 *
 * `stopAt` BOUNDS the walk: a file it names is still visited (so a chain that
 * ENDS there is reported) but the walk does not continue through it. That is the
 * declared-importer seam, and it is a route property rather than a node one —
 * see {@link ALLOWED_IMPORTERS}. Omit `stopAt` for the RAW graph, which is what
 * {@link NEVER_AN_IMPORTER} needs: for a collector or a poll loop, reaching the
 * hand through the gate is as forbidden as reaching it around the gate.
 */
function shortestChain(
  graph: ReadonlyMap<string, string[]>,
  start: string,
  isTarget: (file: string) => boolean,
  stopAt: ReadonlySet<string> = new Set(),
): string[] | null {
  const queue: string[][] = [[start]]
  const seen = new Set([start])
  while (queue.length > 0) {
    const chain = queue.shift() as string[]
    const tip = chain[chain.length - 1] as string
    if (chain.length > 1 && isTarget(tip)) return chain
    // The bound. Checked after isTarget so a declared importer that IS the
    // target is still reported, and applied to `start` too so a declared
    // importer's own legitimate edge into the hand is not a violation.
    if (stopAt.has(tip)) continue
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

describe('the concierge namespace law (prd-20 ruling 1 / ADR-0019)', () => {
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

    // The declared importers, canonicalized — the graph's keys are: on a machine
    // whose checkout sits behind a symlink, comparing a raw declared path against
    // a canonical graph key would silently never match.
    const declared = new Set([...ALLOWED_IMPORTERS].map(realCanonical))

    it('no file in either package reaches the concierge module', () => {
      const violations: string[] = []
      for (const file of tree.files.keys()) {
        if (isInConcierge(file)) continue
        const chain = shortestChain(graph, file, isInConcierge, declared)
        if (chain !== null) violations.push(chain.map(relative).join(' -> '))
      }
      expect(violations).toEqual([])
    })

    it('no collector and no poll loop reaches it, on the RAW graph — a gate does not make a poll a human', () => {
      // NOT bounded by the declared-importer set, unlike the sweep above. For
      // these four, reaching the hand THROUGH the gate is as forbidden as
      // reaching it around the gate (ADR-0019 grant 3). Naming them is also what
      // survives a future refactor of the sweep.
      for (const file of RAW_GRAPH_FILES) {
        const canonical = realCanonical(file)
        expect(tree.files.has(canonical), `${relative(file)} is not in the graph — has it moved?`).toBe(true)
        expect(shortestChain(graph, canonical, isInConcierge)?.map(relative).join(' -> ')).toBeUndefined()
      }
    })

    it('and the CLI does not reach it either — except through the gate, which is the one it may use', () => {
      // `cli/index.ts` boots the server that carries the route, so it is judged
      // under the BOUND: a chain that stops at a declared importer is legitimate
      // for it. #351 wrote this separately from the raw-graph four "before the
      // answer diverges"; with #263's route declared, it HAS diverged — on the
      // raw graph the CLI now reaches the hand through `api/index.ts`, and that
      // is exactly the route it is allowed. The four above still get no such
      // credit.
      const canonical = realCanonical(path.join(SERVER_SRC, 'cli', 'index.ts'))
      expect(tree.files.has(canonical), 'cli/index.ts is not in the graph — has it moved?').toBe(true)
      expect(shortestChain(graph, canonical, isInConcierge, declared)?.map(relative).join(' -> ')).toBeUndefined()
    })

    it("the declared-importer set is EXACTLY #263's one route — not a directory, not a pattern", () => {
      // prd-20 ruling 2. #351 landed this asserting the set was empty, which is
      // what made the first lane to want in stop and read the ruling. #263 is
      // that lane, so the assertion becomes the narrower one: a later wave
      // widening this to `api/` wholesale or to a glob fails here.
      expect([...ALLOWED_IMPORTERS]).toEqual([path.join(SERVER_SRC, 'api', 'concierge.ts')])
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
    /**
     * Every file in a synthetic tree that reaches `/repo/src/concierge/`, as the
     * real sweep asks it: bounded by `declaredImporters`, which default to none.
     */
    function reachers(files: Record<string, string>, declaredImporters: string[] = []): string[] {
      const tree = syntheticTree(files)
      const graph = buildImportGraph(tree)
      const target = path.resolve('/repo/src/concierge')
      const inTarget = (file: string) => file.startsWith(target + path.sep)
      const declared = new Set(declaredImporters.map((file) => path.resolve(file)))
      const out: string[] = []
      for (const file of tree.files.keys()) {
        if (inTarget(file)) continue
        if (shortestChain(graph, file, inTarget, declared) !== null) out.push(path.basename(file))
      }
      return out.sort()
    }

    /** The same tree, asked on the RAW graph — what the four collector/poll files get. */
    function rawReachers(files: Record<string, string>, from: string): string | undefined {
      const tree = syntheticTree(files)
      const graph = buildImportGraph(tree)
      const target = path.resolve('/repo/src/concierge')
      const chain = shortestChain(graph, path.resolve(from), (file) => file.startsWith(target + path.sep))
      return chain?.map((file) => path.basename(file)).join(' -> ')
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

    it('an ESCAPED specifier is caught — the third spelling of #245, found in review of #351', () => {
      // `'../concier\u0067e/paths.js'` is what Node loads as
      // `'../concierge/paths.js'` (verified against real Node, not reasoned
      // about). Before decoding, the raw text resolved to no file at all, so this
      // returned [] — a clean tree while the boundary was crossed.
      expect(
        reachers({
          ...THE_HAND,
          '/repo/src/collectors/git.ts': `import { fence } from '../concier\\u0067e/paths.js'\n`,
        }),
      ).toEqual(['git.ts'])
    })

    it('and every other escape spelling of the same segment', () => {
      for (const spelling of [
        '../concier\\u{67}e/paths.js', // \u{X…} code point form
        '../concier\\x67e/paths.js', // \xXX byte form
        '..\\/concierge\\/paths.js', // a pointlessly escaped separator
        '../\\u0063oncierge/paths.js', // the first letter, so no `concierge` substring survives
      ]) {
        expect(
          reachers({ ...THE_HAND, '/repo/src/collectors/git.ts': `import { fence } from '${spelling}'\n` }),
          `missed the escaped spelling ${spelling}`,
        ).toEqual(['git.ts'])
      }
    })

    it('and decoding does not invent an edge that is not there', () => {
      // The safe direction for a fence is over-eager decoding, but not so eager
      // that an ordinary import of a different module lands on the hand.
      expect(
        reachers({
          ...THE_HAND,
          '/repo/src/collectors/git.ts': `import { readSessionEvents } from '../log/session-\\u006cog.js'\n`,
          '/repo/src/log/session-log.ts': 'export const readSessionEvents = 1\n',
        }),
      ).toEqual([])
    })

    it('a declared importer BOUNDS the walk — its own route in is legitimate, and so is everything above it', () => {
      // The seam as review of #351 required it. Exempting the NODE would admit
      // `api/concierge.ts` and then convict `api/index.ts`, `build-app.ts` and
      // every buildApp test above it. Bounding the WALK admits the route.
      const tree = {
        ...THE_HAND,
        '/repo/src/api/concierge.ts': `import { fence } from '../concierge/paths.js'\n`,
        '/repo/src/api/index.ts': `import './concierge.js'\n`,
        '/repo/src/server/build-app.ts': `import '../api/index.js'\n`,
        '/repo/src/cli/index.ts': `import '../server/build-app.js'\n`,
      }
      expect(reachers(tree), 'undeclared, the whole ancestor cone is a violation — as it should be').toEqual([
        'build-app.ts',
        'concierge.ts',
        'index.ts',
        'index.ts',
      ])
      expect(reachers(tree, ['/repo/src/api/concierge.ts'])).toEqual([])
    })

    it('but a declared importer only bounds ITS route — a second way round the gate is still caught', () => {
      expect(
        reachers(
          {
            ...THE_HAND,
            '/repo/src/api/concierge.ts': `import { fence } from '../concierge/paths.js'\n`,
            '/repo/src/api/index.ts': `import './concierge.js'\n`,
            // The sneak: reaches the hand without going through the gate at all.
            '/repo/src/api/sneaky.ts': `import { fence } from '../concierge/paths.js'\n`,
          },
          ['/repo/src/api/concierge.ts'],
        ),
      ).toEqual(['sneaky.ts'])
    })

    it('and a leak through a helper the GATE ITSELF imports is still caught', () => {
      // The bound zeroes the walk at the declared file, not at everything the
      // declared file touches. If the route imported a helper that separately
      // reached the hand, that helper's own edge is undeclared and must surface
      // — the gate's grant covers the gate, not its dependencies.
      expect(
        reachers(
          {
            ...THE_HAND,
            '/repo/src/api/concierge.ts': `import { fence } from '../concierge/paths.js'\nimport './helper.js'\n`,
            '/repo/src/api/helper.ts': `import { fence } from '../concierge/paths.js'\n`,
            '/repo/src/api/index.ts': `import './concierge.js'\n`,
          },
          ['/repo/src/api/concierge.ts'],
        ),
      ).toEqual(['helper.ts'])
    })

    it('and a POLL LOOP importing the declared route is still a violation — the raw graph, no gate credit', () => {
      // The half the bound must not swallow: ADR-0019 grant 3 is "never from a
      // collector, never from a poll", and a token gate does not make a poll a
      // human. Same tree, same declared route, opposite answer.
      const tree = {
        ...THE_HAND,
        '/repo/src/api/concierge.ts': `import { fence } from '../concierge/paths.js'\n`,
        '/repo/src/server/poll-loop.ts': `import '../api/concierge.js'\n`,
      }
      expect(reachers(tree, ['/repo/src/api/concierge.ts']), 'the bounded sweep credits the gate').toEqual([])
      expect(rawReachers(tree, '/repo/src/server/poll-loop.ts')).toBe('poll-loop.ts -> concierge.ts -> paths.ts')
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

    it('and does not fire on a literal specifier that itself contains a `)` — #374', () => {
      // `DYNAMIC_CALL_RE` stops capturing at the first `)`, which used to
      // truncate this literal mid-string and read it as unterminated — a
      // false CI failure on a route-group path several frameworks spell this
      // way. Mutation check: this line fails against the pre-#374 capture
      // (`rest.indexOf(quote)` on the truncated argument returns -1), and the
      // genuinely-computed sibling directly below must keep failing.
      expect(nonLiteralDynamicSpecifiers(`const m = await import('./(group)/foo.js')`)).toEqual([])
      expect(nonLiteralDynamicSpecifiers('const m = await import(`./(group)/foo.js`)')).toEqual([])
      expect(nonLiteralDynamicSpecifiers(`const m = require('./(group)/foo.js')`)).toEqual([])
      // The genuinely computed sibling — a parenthesis in the literal text
      // before the substitution must never become a way to smuggle a computed
      // specifier past this detector. (The reported text is still truncated
      // at the first `)`, same as any other multi-`)` argument; only whether
      // it fires is this issue's concern.)
      expect(nonLiteralDynamicSpecifiers('const m = await import(`./(${slug})/foo.js`)')).not.toEqual([])
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
     * `child_process` as a module specifier, with the `node:` prefix OPTIONAL.
     * `import { exec } from 'child_process'` reaches the same shell as the
     * prefixed spelling and is the more common way to write it; requiring the
     * prefix was review of #351's first finding.
     */
    const CHILD_PROCESS_MODULE = String.raw`['"\x60](?:node:)?child_process['"\x60]`

    /**
     * The names of every namespace bound to `child_process` in a file — from
     * `import * as cp from 'child_process'`, `import cp from …`,
     * `const cp = require(…)`, and `const cp = await import(…)` alike. The
     * last is review-of-#351's own point turned into a #373 finding: the
     * specifier is a plain literal, so clause 2 has nothing to say about it,
     * and a static-import-only binder would never see `cp.exec(…)` below it.
     *
     * Why an identifier and not a line: pattern 3 used to be
     * `/\bchild_process\b[^\n]*\.\s*exec\b(?!File)/`, and `[^\n]*` forced the
     * import and the call onto ONE line, which is not how anyone writes it
     * (review of #351). Binding the name lets the call be found wherever it is.
     */
    function childProcessNamespaces(code: string): string[] {
      const out: string[] = []
      const patterns = [
        new RegExp(String.raw`\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*${CHILD_PROCESS_MODULE}`, 'g'),
        new RegExp(String.raw`\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,|\bfrom\b)\s*.*?${CHILD_PROCESS_MODULE}`, 'g'),
        new RegExp(
          String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*${CHILD_PROCESS_MODULE}`,
          'g',
        ),
        new RegExp(
          String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?import\s*\(\s*${CHILD_PROCESS_MODULE}`,
          'g',
        ),
      ]
      for (const pattern of patterns) {
        for (const match of code.matchAll(pattern)) if (match[1] !== undefined) out.push(match[1])
      }
      return out
    }

    /** True when `code` destructures a shell-command form out of `child_process`. */
    function destructuresAShellForm(code: string): boolean {
      // `import { exec } from …`, `import { exec as run } from …`, and the
      // `const { exec } = require(…)` form, which the old pattern set missed
      // entirely. `\bexec\b(?!File)` so `execFile`/`execFileSync` stay legal.
      const braced = String.raw`\{[^}]*\b(?:exec|execSync)\b(?!File)[^}]*\}`
      return (
        new RegExp(String.raw`\bimport\s*${braced}\s*from\s*${CHILD_PROCESS_MODULE}`).test(code) ||
        new RegExp(String.raw`\b(?:const|let|var)\s*${braced}\s*=\s*require\s*\(\s*${CHILD_PROCESS_MODULE}`).test(code)
      )
    }

    /**
     * The string-command forms of `child_process`, and the option that turns any
     * spawn into one. `spawn`/`execFile`/`spawnSync`/`execFileSync` take an argv
     * array and are deliberately NOT forbidden — the launch power needs one of
     * them. `exec`/`execSync` take a command line a shell parses, which is how a
     * repo URL or a branch name becomes arbitrary code.
     *
     * `\bexec\s*\(` would also match this repo's own injected `Exec` seam
     * (ADR-0004, `server/exec.ts`), which is an argv-array function and not a
     * shell — so a bare `exec(…)` is only a violation when the name was bound to
     * `child_process` somewhere in the same file, and the negative test below
     * pins that.
     *
     * All four detectors read the whole file, not a line: review of #351 found
     * seven ordinary spellings that got through the line-scoped version, and each
     * one now has its own positive fixture below so the set cannot regress to
     * only the strings it was written against.
     */
    const SHELL_PATTERNS: Array<{ what: string; pattern: (code: string) => boolean }> = [
      {
        what: 'execSync — a shell command line',
        pattern: (code) => /\bexecSync\s*\(/.test(code),
      },
      {
        what: 'a shell-command form destructured out of child_process',
        pattern: destructuresAShellForm,
      },
      {
        what: 'an inline `require(child_process).exec(…)`, never bound to a name',
        // #373: `childProcessNamespaces` binds an identifier, so
        // `require('child_process').exec(url)` — called straight off the
        // `require(...)` expression, nothing to bind — was invisible to every
        // other detector here. Its own pattern, same module test.
        pattern: (code) =>
          new RegExp(
            String.raw`\brequire\s*\(\s*${CHILD_PROCESS_MODULE}\s*\)\s*\.\s*(?:exec|execSync)\b(?!File)`,
          ).test(code),
      },
      {
        what: 'exec off a child_process namespace, anywhere in the file',
        pattern: (code) =>
          childProcessNamespaces(code).some((ns) =>
            // `cp.exec(…)` and `promisify(cp.exec)` alike: the reference is the
            // violation, not the call, because a reference is all it takes to
            // hand the shell form to something that will call it.
            new RegExp(String.raw`\b${ns}\s*\.\s*(?:exec|execSync)\b(?!File)`).test(code),
          ),
      },
      {
        what: 'a shell-enabled spawn — any `shell:` that is not literally false',
        pattern: (code) => {
          // Inverted from an allowlist of dangerous values to a denylist of the
          // one safe one: `shell: enabled` and `shell: opts.useShell` both reach
          // a shell whenever the variable is truthy, and neither was caught by
          // `shell\s*:\s*(?:true|['"])` (review of #351).
          for (const match of code.matchAll(/\bshell\s*:\s*([^,}\n]+)/g)) {
            if ((match[1] ?? '').trim() !== 'false') return true
          }
          return false
        },
      },
    ]

    it('nothing in the module reaches a shell', () => {
      const offenders: string[] = []
      for (const file of conciergeSourceFiles()) {
        const code = codeOf(readFileSync(file, 'utf8'))
        for (const { what, pattern } of SHELL_PATTERNS) {
          if (pattern(code)) offenders.push(`${relative(file)}: ${what}`)
        }
      }
      expect(offenders).toEqual([])
    })

    /** True if ANY clause-4 pattern fires — the check as the law applies it. */
    function reachesAShell(code: string): boolean {
      return SHELL_PATTERNS.some(({ pattern }) => pattern(code))
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

    /**
     * The seven forms review of #351 ran against the previous pattern set. All
     * seven passed the law; each is now its own fixture, so "those detectors
     * bite" cannot quietly narrow back to the six strings above.
     */
    it('and on the SEVEN ordinary spellings that got through the line-scoped version (review of #351)', () => {
      const forms: Array<[label: string, code: string]> = [
        ['no `node:` prefix', `import { exec } from 'child_process'`],
        [
          'namespace import, call on a LATER line',
          `import * as cp from 'node:child_process'\nconst r = cp.exec(cmd)\n`,
        ],
        ['destructured require', `const { exec } = require('node:child_process')`],
        ['require namespace, call on a LATER line', `const cp = require('node:child_process')\ncp.exec(cmd)\n`],
        ['`shell:` set from an identifier', 'spawn(cmd, { shell: enabled })'],
        ['`shell:` set from a member expression', 'spawn(cmd, { shell: opts.useShell })'],
        ['promisify(cp.exec) — a reference, never a call', `import * as cp from 'child_process'\nconst run = promisify(cp.exec)\n`],
      ]
      for (const [label, code] of forms) {
        expect(reachesAShell(code), `missed the ordinary spelling: ${label}`).toBe(true)
      }
    })

    it('and on the unprefixed spelling of each earlier form too — `node:` was never the load-bearing part', () => {
      for (const violation of [
        `import { execSync } from 'child_process'`,
        `const { execSync } = require('child_process')`,
        `import cp from 'child_process'\ncp.exec(cmd)\n`,
        `spawn(cmd, { shell: process.env.SHELL })`,
      ]) {
        expect(reachesAShell(violation), `missed: ${violation}`).toBe(true)
      }
    })

    /**
     * The two spellings review of #351's re-review found still passing
     * (#373): an inline `require(...).exec(...)` that binds no name at all,
     * and a dynamic-import binding — `const cp = await
     * import('node:child_process')` — which clause 2 permits outright because
     * the specifier is a plain literal; "no blind spots" has nothing to say
     * about it.
     */
    it('and on the two routes review of #351 found still passing (#373)', () => {
      const forms: Array<[label: string, code: string]> = [
        ['inline require, never bound to a name', `require('child_process').exec('git clone ' + url)`],
        ['dynamic-import binding', `const cp = await import('node:child_process')\ncp.exec(url)\n`],
      ]
      for (const [label, code] of forms) {
        expect(reachesAShell(code), `missed the ordinary spelling: ${label}`).toBe(true)
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

    it('and the widened detectors stay narrow — the shapes a real launch path will be written in', () => {
      // The mirror-image danger of a broad law: flagging the code the hand needs.
      // Every entry here is a shape the launch power is expected to take.
      for (const legitimate of [
        // A namespace bound to child_process, used only for its argv forms.
        `import * as cp from 'node:child_process'\nconst child = cp.spawn('claude', argv, { env })\n`,
        `import * as cp from 'child_process'\nawait promisify(cp.execFile)('git', ['clone', url, target])\n`,
        // The dynamic-import binding, used only for its argv form — the
        // widening #373 added to `childProcessNamespaces` must not convict
        // this the way it does `cp.exec(url)`.
        `const cp = await import('node:child_process')\ncp.spawn('claude', argv, { env })\n`,
        // The one `shell:` value that is not a violation, spelled the ways it is.
        `spawn('claude', argv, { shell: false })`,
        `spawn('claude', argv, { shell: false, env, cwd })`,
        `const options = { shell:false }`,
        // `exec` off something that is NOT child_process — ADR-0004's own seam,
        // which is an argv function and which this module's callers inject.
        `import { exec } from '../server/exec.js'\nawait exec('git', ['clone', url, target])\n`,
        `const result = await ctx.exec('workmux', argv, { cwd })`,
        // A field literally called `execFile`, and the word in a variable name.
        `const { execFile } = deps\nawait execFile('git', argv)\n`,
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
describe('the concierge namespace law, live (prd-20 ruling 1 / ADR-0019)', () => {
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

/* ========================================================================== */
/* Clause 6 — the migration power (prd-20 ruling 6 / ADR-0020, #514).         */
/* Appended. Nothing above this line is touched by it.                        */
/* ========================================================================== */

import { writeFile } from 'node:fs/promises'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/worktree-slug.js'
import { assertMigrationPaths, MigrationFenceError } from './paths.js'

/**
 * CLAUSE 6 — the fourth hand's THIRD power, fenced before it exists.
 *
 * ADR-0020 amends ADR-0019 with one further write and only one: the concierge
 * may COPY a session transcript into `~/.claude/projects/<watched-repo-slug>/`,
 * create-only. `research/2026-08-14-cross-host-resume.md` is the evidence that
 * placing the file is the whole mechanism (Q1's control: resume lookup is
 * scoped to the slug directory of the cwd), that the resume appends in place
 * under the preserved sessionId (Q3), and that telemetry books under that same
 * id (Q4) — on Claude Code `2.1.232`, a pin the ADR carries.
 *
 * Two halves, matching the two halves of the ruling:
 *
 * - **The fence, live.** `assertMigrationPaths` is run against real
 *   directories, the way clause 5 runs the clone fence — because a containment
 *   predicate that has never met a symlink is a claim, not a fence. It derives
 *   both paths rather than validating a supplied one, so "copy me
 *   `/etc/shadow`" is a request the signature cannot express; the live tests
 *   below prove the derivation, not just the refusals.
 * - **The create-only pin.** The copy itself is wave 6's work and does not
 *   exist yet, so this half pins the OBLIGATION rather than the code, the way
 *   this suite has pinned future obligations before: *if* a `copyFile` ever
 *   appears under `concierge/`, the file it appears in names `COPYFILE_EXCL`.
 *   That flag is the actual guarantee — `assertMigrationPaths`' own
 *   create-only clause is a check-then-write, so it is a TOCTOU by
 *   construction and says so in its own doc.
 *
 * **The pin is vacuous today, deliberately and visibly.** There is no
 * `copyFile` under `concierge/` for it to judge; it fires the moment wave 6
 * writes one. A vacuous law is exactly the failure this file's own history is
 * about, so the detector is proven to bite on synthetic code below rather than
 * being trusted because the sweep came back empty.
 */
describe('the concierge namespace law, clause 6 — the migration power (prd-20 ruling 6 / ADR-0020)', () => {
  describe('the fence exists before the copy does', () => {
    it('exports a runtime refusal, not a comment', () => {
      expect(typeof assertMigrationPaths).toBe('function')
      expect(MigrationFenceError.prototype).toBeInstanceOf(Error)
    })

    it('and takes no source path — an arbitrary file is unrepresentable, not merely refused', () => {
      // The signature IS the first clause (ADR-0020's Decision Outcome). A
      // fence that validated a caller-supplied path could only ever refuse the
      // spellings its author thought of, which is #245's shape in a new place.
      // `(fence, attribution)` — two parameters, neither of them a file.
      expect(assertMigrationPaths.length).toBe(2)
    })
  })

  describe('the fence, live — real directories, hermetic under concurrency', () => {
    const SESSION_ID = '200fb100-b3e2-4828-a3a6-01333a255127'

    let root: string
    let claudeProjectsRoot: string
    let watchedRepoPath: string
    let originRepoPath: string

    function fence() {
      return { claudeProjectsRoot, watchedRepoPath }
    }

    function attribution(sessionId: string = SESSION_ID) {
      return { sessionId, worktreePath: originRepoPath }
    }

    function slugDir(repoPath: string): string {
      return path.join(claudeProjectsRoot, worktreePathToProjectSlug(repoPath))
    }

    beforeEach(async () => {
      // `realpathSync` because the fence canonicalizes the watched repo before
      // slugging it: on macOS `mkdtemp` hands back the `/var/…` spelling of a
      // `/private/var/…` directory, and the two slug differently.
      root = realpathSync(await mkdtemp(path.join(tmpdir(), 'rhizomorph-concierge-migration-law-')))
      claudeProjectsRoot = path.join(root, 'claude-projects')
      watchedRepoPath = path.join(root, 'watched-repo')
      originRepoPath = path.join(root, 'origin-repo')
      await mkdir(slugDir(originRepoPath), { recursive: true })
      await mkdir(path.join(watchedRepoPath, 'src'), { recursive: true })
      await mkdir(originRepoPath, { recursive: true })
      await writeFile(path.join(slugDir(originRepoPath), `${SESSION_ID}.jsonl`), '{"type":"user"}\n')
    })

    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
    })

    it('permits the one thing the power is for — the attributed transcript, into the watched repo\'s slug dir', () => {
      const { source, destination } = assertMigrationPaths(fence(), attribution())
      expect(source).toBe(path.join(slugDir(originRepoPath), `${SESSION_ID}.jsonl`))
      expect(destination).toBe(path.join(slugDir(watchedRepoPath), `${SESSION_ID}.jsonl`))
    })

    it('and writes nothing while permitting it — the fence is a judgement, not the copy', () => {
      assertMigrationPaths(fence(), attribution())
      expect(() => statSync(slugDir(watchedRepoPath))).toThrow()
    })

    it('refuses every destination inside the watched repo — the clause that can never be relaxed', async () => {
      for (const projectsRoot of [
        watchedRepoPath,
        path.join(watchedRepoPath, 'src'),
        path.join(watchedRepoPath, '.claude', 'projects'),
      ]) {
        await mkdir(projectsRoot, { recursive: true })
        expect(
          () => assertMigrationPaths({ ...fence(), claudeProjectsRoot: projectsRoot }, attribution()),
          `permitted a write under ${projectsRoot}`,
        ).toThrow(MigrationFenceError)
      }
    })

    it('refuses a slug directory that is a symlink out of the projects root', async () => {
      const outside = path.join(root, 'outside')
      await mkdir(outside, { recursive: true })
      await mkdir(claudeProjectsRoot, { recursive: true })
      await symlink(outside, slugDir(watchedRepoPath))
      expect(() => assertMigrationPaths(fence(), attribution())).toThrow(MigrationFenceError)
    })

    it('refuses to overwrite — the copy is create-only, and the law runs that refusal', async () => {
      await mkdir(slugDir(watchedRepoPath), { recursive: true })
      await writeFile(path.join(slugDir(watchedRepoPath), `${SESSION_ID}.jsonl`), 'someone else\'s history\n')
      expect(() => assertMigrationPaths(fence(), attribution())).toThrow(/already exists/)
    })

    it('refuses a traversal-shaped session id before any path is built', () => {
      for (const sessionId of ['..', '/etc/passwd', 'a/b', `${SESSION_ID}\0`]) {
        expect(
          () => assertMigrationPaths(fence(), attribution(sessionId)),
          `permitted the session id ${JSON.stringify(sessionId)}`,
        ).toThrow(/not a bare session id/)
      }
    })

    it('never reaches a transcript the attribution did not derive, however well-named', async () => {
      const elsewhere = path.join(root, 'elsewhere')
      await mkdir(elsewhere, { recursive: true })
      await writeFile(path.join(elsewhere, `${SESSION_ID}.jsonl`), '{"type":"user"}\n')
      await rm(path.join(slugDir(originRepoPath), `${SESSION_ID}.jsonl`))
      expect(() => assertMigrationPaths(fence(), attribution())).toThrow(/no transcript for session/)
    })

    it('and leaves the origin alone — the source is read, never moved, never deleted', () => {
      const before = statSync(path.join(slugDir(originRepoPath), `${SESSION_ID}.jsonl`))
      assertMigrationPaths(fence(), attribution())
      const after = statSync(path.join(slugDir(originRepoPath), `${SESSION_ID}.jsonl`))
      expect(after.size).toBe(before.size)
      expect(after.mtimeMs).toBe(before.mtimeMs)
    })
  })

  describe('the create-only pin — the obligation on the wave that makes the copy real', () => {
    /**
     * A file that copies without naming the exclusive flag. Deliberately crude
     * and file-scoped, like clause 4's detectors: `copyFile`/`copyFileSync`
     * however they are imported or spelled off a namespace, and
     * `COPYFILE_EXCL` anywhere in the same file. It cannot prove the flag is
     * passed to THAT call — only that whoever wrote the copy knew the word.
     * That is the honest limit of a source-text law, and it is the same limit
     * clauses 1–4 carry.
     */
    function copiesWithoutExcl(code: string): boolean {
      return /\bcopyFile(?:Sync)?\s*\(/.test(code) && !/\bCOPYFILE_EXCL\b/.test(code)
    }

    it('any copyFile under concierge/ names COPYFILE_EXCL', () => {
      const offenders = conciergeSourceFiles()
        .filter((file) => copiesWithoutExcl(codeOf(readFileSync(file, 'utf8'))))
        .map(relative)
      expect(offenders).toEqual([])
    })

    /**
     * Which files may copy, and which granted power each one serves.
     *
     * **A named set rather than a count** (prd-57 ruling 4). This read
     * `toBeLessThanOrEqual(1)` — *"one power, one write"* — under a comment
     * saying today is zero and wave 6 makes it one. Wave 6 landed, ADR-0053
     * granted a third power, and a bare count could then only say "2 is too
     * many" without saying which two were argued for or what a third would have
     * to argue.
     *
     * A count also cannot tell a copy that was LICENSED from one that merely
     * arrived first. This can: adding a row here is a diff a reviewer reads
     * beside the record that licenses it, which is the friction the amendment
     * exists to price. It is also the lesson this PRD has now hit three times —
     * the boundary belongs around the class, never around the arithmetic.
     */
    const LICENSED_COPIERS: ReadonlyMap<string, string> = new Map([
      ['concierge/migrate.ts', 'ADR-0020 clause 6 — the migration power: one transcript copied, origin untouched'],
      [
        'concierge/enlist.ts',
        'ADR-0053, amending ADR-0019 clause 1 to a third power — the backup taken before an enlistment writes, ' +
          'which is the only thing that makes a non-atomic write recoverable',
      ],
    ])

    it('every file that copies is one this repo granted a copy to, BY NAME', () => {
      const copiers = conciergeSourceFiles()
        .filter((file) => /\bcopyFile(?:Sync)?\s*\(/.test(codeOf(readFileSync(file, 'utf8'))))
        .map((file) => relative(file).replace(/\\/g, '/').replace(/^packages\/server\/src\//, ''))

      for (const copier of copiers) {
        expect(
          LICENSED_COPIERS.has(copier),
          `${copier} copies a file and no granted power names it. A copy in this namespace is a WRITE and ` +
            'ADR-0019 clause 1 enumerates the writes — land the record that licenses it, then add it here',
        ).toBe(true)
      }
      // And the set cannot rot: a row naming a file that no longer copies is a
      // licence nobody is using, which is how an allowlist quietly widens.
      for (const [licensed] of LICENSED_COPIERS) {
        expect(copiers, `${licensed} is licensed to copy and does not — drop the row`).toContain(licensed)
      }
    })

    it('that detector bites on the unguarded forms', () => {
      for (const violation of [
        `await copyFile(source, destination)`,
        `copyFileSync(source, destination)`,
        `import { copyFile } from 'node:fs/promises'\nawait copyFile(a, b)\n`,
        `await fs.copyFile(source, destination, 0)`,
      ]) {
        expect(copiesWithoutExcl(violation), `missed: ${violation}`).toBe(true)
      }
    })

    it('and does not fire on the guarded form, or on prose describing the danger', () => {
      for (const legitimate of [
        `await copyFile(source, destination, constants.COPYFILE_EXCL)`,
        `import { constants } from 'node:fs'\nawait copyFile(a, b, constants.COPYFILE_EXCL)\n`,
        `copyFileSync(source, destination, COPYFILE_EXCL)`,
        codeOf('// a bare copyFile(a, b) would clobber the operator\'s transcript\n'),
        'export const migrate = 1\n',
      ]) {
        expect(copiesWithoutExcl(legitimate), `false positive on: ${legitimate}`).toBe(false)
      }
    })

    it('and the module it will land in is the one this law walks', () => {
      // Guards the pin against the sweep going vacuous by looking in the wrong
      // place: `conciergeSourceFiles()` is what clauses 3, 4 and this one all
      // read, so an empty result here would silently empty three clauses.
      expect(conciergeSourceFiles().map(relative)).toContain(
        path.join('packages', 'server', 'src', 'concierge', 'paths.ts'),
      )
    })
  })
})
