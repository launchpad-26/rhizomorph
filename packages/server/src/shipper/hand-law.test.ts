import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isInside } from '../paths/containment.js'

/**
 * THE FIFTH HAND'S LAW (ADR-0034) — written BEFORE `shipper/` has a single
 * source file, so the fence is never retrofitted around whatever got built.
 * `concierge/namespace-law.test.ts` (ADR-0019) is the model this file copies
 * near-verbatim, down to its habits: build the whole import graph rather than
 * grep per file, decode string escapes before resolving a specifier, and
 * canonicalize every path through `realpath(3)` so a symlinked checkout or a
 * case-different spelling lands on the same graph node.
 *
 * ADR-0001's grant list gains a fifth hand, the shipper: it reads the session
 * ledger and posts it, re-serialized, to one team server; it runs on a batch
 * timer once enabled; it holds one project-scoped ingest key. `docs/adr/0034-the-fifth-hand.md`
 * binds it with five clauses:
 *
 *   1. Outbound only — asserted here.
 *   2. One credential, one shape, one place — asserted here (three greps).
 *   3. The clock is bounded to one act — asserted here (raw import graph).
 *   4. It sends only what a record carries (ADR-0033) — ASSERTED, no longer
 *      deferred. The deferral's own condition was "the re-serializer this
 *      would test does not exist yet"; it exists
 *      (`packages/core/src/wire/reserialize.ts`, merged with the keystone), so
 *      the clause became testable and `veil.test.ts` beside this file plants
 *      the real removed field — `pane.activity.payload.preview` — in a ledger
 *      and watches a full pass fail to carry it across.
 *   5. Enabled is visible on `/connect` — DEFERRED to prd-51 WAVE 5+, with the
 *      team-server doctor (ruling 12's second half, whose row lives in
 *      `packages/web/src/connect/links.ts`). Re-dated from "wave 3" by the
 *      wave-3 lane itself: the row's VERIFIED state depends on a batch
 *      acknowledged by a team server that does not exist yet, and #372's own
 *      body rules that row out of its scope in terms.
 *
 * A clause silently absent is the failure this file exists to prevent; a
 * clause declared deferred, by name and by wave, is honest instead.
 *
 * ## The vacuity problem
 *
 * Every source-text clause below sweeps `packages/server/src/shipper/` for
 * non-test files. That set was EMPTY when this file was written, so every one
 * of those sweeps passed over nothing — the exact defect
 * `concierge/namespace-law.test.ts` was written against. It is no longer
 * empty: wave 3 landed seven sources under it, and the three mechanisms that
 * held the seam open are what forced that lane through this file first.
 *
 *   1. {@link SHIPPER_SOURCES_TODAY} — a declared inventory, asserted equal
 *      to what the sweep actually finds AND asserted NON-EMPTY. It was
 *      asserted empty until wave 3, which edited it in the same commit that
 *      added its files, exactly as the seam demanded. Never widen it into a
 *      `length >= 0` or a glob: the equality is the whole mechanism.
 *   2. An exact directory listing (`readdirSync(SHIPPER_DIR).sort()`) — blunt
 *      on purpose, so anything landing under `shipper/` goes red and names
 *      what appeared.
 *   3. Synthetic fixtures for every detector — a paired positive (it fires on
 *      a violation) and a paired negative (it does not fire on the shape the
 *      hand legitimately needs). These carry clauses 1, 2, 2b, 3 and 3b; the
 *      doc comment beside each says so.
 *
 * The other half of vacuity, easy to forget: the SOURCE side of clause 3's
 * sweep must be non-empty too. Asserted below — `walkSourceFiles(COLLECTORS_DIR)`
 * returns more than five non-test files and contains `packages/server/src/collectors/git/git-collector.ts`.
 * A sweep gone vacuous by looking in the wrong place reports the same green
 * as a sweep that found nothing wrong.
 *
 * ## This law's graph depends on the concierge law's "no blind spots" clause
 *
 * `concierge/namespace-law.test.ts` already enforces, server-wide, that no
 * non-test server source file contains a dynamic `import()` with a
 * non-literal specifier. This file does not duplicate that sweep — this
 * law's graph is only as sighted as that clause, and depends on it, the way
 * `packages/server/src/paths/containment.ts`'s own doc comment warns a
 * duplicated security primitive is the exact failure to avoid.
 *
 * ## The falsifier, and its verdict (required by the issue's DoD)
 *
 * The issue asks: if the import-graph walk cannot distinguish a collector
 * reaching the shipper from a test file reaching it, the law is either too
 * wide (reddens the shipper's own tests) or too narrow (misses the enable
 * path), and the shape must be fixed here before wave 2 lands code under it.
 *
 * **Verdict: the shape holds, on two separate mechanisms, both executed
 * below.**
 *
 *   1. Too wide is impossible by construction — the sweep skips every file
 *      already inside `shipper/` as a SOURCE. The hand's own tests are
 *      inside it, so they are never candidates for violation, however deeply
 *      they import the hand's code. Proven by the fourth synthetic case in
 *      "clause 3, proven against synthetic violations".
 *   2. Too narrow is answered by the declared-importer seam, and only for
 *      the BOUNDED sweep. The enable path (`connect team`, wave 2) is
 *      admitted by being named in {@link DECLARED_IMPORTERS}, which bounds
 *      the walk rather than exempting a node — the route in is legitimate
 *      and so is everything above it, while a second way round the gate
 *      still surfaces. The raw-graph half gets no such credit: a poll loop
 *      reaching the hand THROUGH the declared route is still a violation.
 *      Proven by the second synthetic case, which asserts both answers on
 *      one tree.
 *
 * ## Six mutations, each run against a scratch copy of this file and each
 * observed red (recorded honestly in the commit that adds this file):
 *
 * | clause    | mutation                                                                                          | what goes red |
 * |-----------|----------------------------------------------------------------------------------------------------|---------------|
 * | vacuity   | add packages/server/src/shipper/scratch-mutation.ts with `export const x = 1`                    | the exact-listing test and the inventory test |
 * | 1         | that scratch file becomes `import { createServer } from 'node:http'` + `createServer().listen(0)`  | + "nothing under shipper/ opens a listener" |
 * | 1 (bind)  | `host: '127.0.0.1'` → `host: '0.0.0.0'` in `packages/server/src/cli/run.ts`                          | "the instrument's bind is 127.0.0.1" |
 * | 1 (loopback) | a fifth entry `'0.0.0.0'` in `LOOPBACK_HOSTNAMES` in `packages/server/src/server/mutation-guard.ts` | "mutation-guard's loopback set is the four-entry set" |
 * | 2         | scratch file carries `'sk_'`, `process.argv[3]` and `console.log('ingest key', ingestKey)`          | both clause-2 sweep tests |
 * | 3         | scratch file exports `enable`; append import { enable } from '../../shipper/scratch-mutation.js' to `packages/server/src/collectors/git/git-collector.ts` | the RAW-graph test AND the bounded sweep |
 *
 * ## Four more, added by wave 3 with its own sources under the sweep, each
 * observed red (recorded in the commit that adds them):
 *
 * | clause | mutation | what goes red |
 * |--------|----------|---------------|
 * | 3b     | add `import { runShipperLoop } from '../shipper/index.js'` to `packages/server/src/cli/run.ts` and call it from `runServerCommand` | ONLY the call-site sweep. Both graph clauses stay green, and that asymmetry is the finding this clause exists for |
 * | 2b     | call `key.headerValue()` from `shipper/ship.ts` | the one-reader sweep |
 * | key    | make `post.ts`'s non-2xx arm `throw new Error(\`ingest refused: ${key.headerValue()}\`)` | `no-key-in-output-law.test.ts`, on the thrown-error capture |
 * | ts     | replace the shipped entry's `line` with one whose `ts` is the local clock | `ts-invariant.test.ts`'s first case |
 *
 * ## Three declared skips, on purpose, not by omission
 *
 *   - `packages/server/src/cli/replay.ts` carries a second, identical bind to
 *     the one this file pins in `cli/run.ts`. Not pinned here: ADR-0034
 *     clause 1 names the instrument's bind, `cli/run.ts` is it, and a second
 *     anchor only doubles the rot surface for no extra guarantee.
 *   - Clause 5, named above as deferred and not asserted.
 *
 * The `0600` storage mode used to be the second skip here, on the grounds that
 * "a mode pinned against no writer pins nothing". The writer exists now
 * (`shipper/key.ts`'s `writeIngestKey`) and the pin went where the skip said
 * it should: beside it, in `key.test.ts`, asserted on the file immediately
 * after the write and again after a third write, because `writeFile`'s `mode`
 * applies only on creation and a re-used temp file would otherwise inherit a
 * laxer one.
 *
 * ## What the wave-3 lane actually did with that seam
 *
 * It enumerated its seven sources in {@link SHIPPER_SOURCES_TODAY} and added
 * exactly one file to {@link DECLARED_IMPORTERS} — `cli/connect-team.ts`, the
 * `connect team` command prd-51 ruling 14 names — in the same commit that
 * added them. The instruction stands unchanged for whoever comes next: enumerate,
 * never widen into `length >= 0` or a pattern, and if a later wave needs a
 * route in, argue for it rather than adding a second entry. `doctor` wanted one
 * and did not get one: it reads the hand's facts THROUGH `connect-team.ts`
 * instead, because the seam being ONE file wide is the property, not a detail
 * of who happened to need it first.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
// packages/server/src/shipper -> repo root
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..')
const SERVER_SRC = path.join(REPO_ROOT, 'packages', 'server', 'src')
const WEB_SRC = path.join(REPO_ROOT, 'packages', 'web', 'src')
const SHIPPER_DIR = path.join(SERVER_SRC, 'shipper')
const COLLECTORS_DIR = path.join(SERVER_SRC, 'collectors')

/**
 * The shipper's own non-test source files, declared rather than merely
 * discovered — asserted both by equality against the real sweep and by being
 * NON-EMPTY below. This is the seam that forced the lane adding the shipper's
 * first source file to read this law; it stays exactly as strict for the next
 * one. Enumerate the files here, in the same commit that adds them, and never
 * widen the assertion into a `>= 0` or a glob that would pass silently over
 * whatever landed.
 *
 * `path.join`, never a slash-joined literal: {@link relative} is
 * `path.relative()`, so the real sweep is backslash-separated on win32 and a
 * hard-coded `'packages/server/…'` would redden only on the `Windows suite`
 * leg — this repo's recorded doc-law-literal failure mode, one directory over.
 */
const SHIPPER_SOURCES_TODAY: readonly string[] = [
  path.join('packages', 'server', 'src', 'shipper', 'config.ts'),
  path.join('packages', 'server', 'src', 'shipper', 'cursor.ts'),
  path.join('packages', 'server', 'src', 'shipper', 'index.ts'),
  path.join('packages', 'server', 'src', 'shipper', 'key.ts'),
  path.join('packages', 'server', 'src', 'shipper', 'loop.ts'),
  path.join('packages', 'server', 'src', 'shipper', 'post.ts'),
  path.join('packages', 'server', 'src', 'shipper', 'ship.ts'),
]

/** Every file under `shipper/`, tests included — the blunt listing of mechanism 2. */
const SHIPPER_DIRECTORY_TODAY: readonly string[] = [
  'config.test.ts',
  'config.ts',
  'cursor.test.ts',
  'cursor.ts',
  'hand-law.test.ts',
  'index.ts',
  'key.test.ts',
  'key.ts',
  'loop.test.ts',
  'loop.ts',
  'no-key-in-output-law.test.ts',
  'post.test.ts',
  'post.ts',
  'ship.test.ts',
  'ship.ts',
  'ts-invariant.test.ts',
  'veil.test.ts',
]

/**
 * The files allowed to reach the shipper — EXACTLY ONE, the `connect team`
 * command prd-51 ruling 14 names: `packages/server/src/cli/connect-team.ts`.
 * Never a directory and never a glob, and never a second entry without an
 * argument on the record: the seam being one file wide is the property
 * ADR-0034 clause 3 buys, and `cli/doctor.ts` was refused a second entry for
 * that reason — it reaches the hand's facts through this file instead.
 *
 * Repeating `concierge/namespace-law.test.ts`'s own finding: a declared
 * importer BOUNDS the walk — chains stop there and everything above it
 * inherits its grant — it does not EXEMPT the node, because exempting the
 * node admits the route and then convicts `api/index.ts`, `build-app.ts` and
 * every `buildApp` test above it.
 */
const DECLARED_IMPORTERS: ReadonlySet<string> = new Set<string>([
  path.join(SERVER_SRC, 'cli', 'connect-team.ts'),
])

/**
 * Files that may never be in {@link DECLARED_IMPORTERS}, whatever a later
 * wave decides — ADR-0034 clause 3's own condition ("never from a collector,
 * never from a poll"), asserted against the set itself rather than left to
 * whoever edits it.
 */
const NEVER_AN_IMPORTER = [
  path.join(SERVER_SRC, 'server', 'poll-loop.ts'),
  path.join(SERVER_SRC, 'server', 'collector-loader.ts'),
  COLLECTORS_DIR,
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

/** A file's CODE, with comments removed — this law's own doc comment names every construct it forbids. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function relative(file: string): string {
  return path.relative(REPO_ROOT, file)
}

/** `realpath(3)`, falling back to a plain resolve for a path that does not exist. */
const realCanonical = (candidate: string): string => {
  try {
    return (realpathSync.native ?? realpathSync)(candidate)
  } catch {
    return path.resolve(candidate)
  }
}

function shipperSourceFiles(): string[] {
  return walkSourceFiles(SHIPPER_DIR).filter((file) => !isTest(file))
}

/**
 * Every module specifier in a file's code: `from '…'`, a bare `import '…'`,
 * a dynamic `import('…')`, and `require('…')` — single quotes, double
 * quotes, or backticks.
 */
const SPECIFIER_RE = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)(['"`])([^'"`]*)\1/g

/**
 * A string literal's escape sequences, resolved to the characters they
 * name — so `'../shipper/x.js'` is read the way Node loads it, not the
 * way its raw text reads. Copied verbatim from `concierge/namespace-law.test.ts`,
 * which found this the third spelling of #245's hole in review of #351.
 */
const ESCAPE_RE = /\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\s\S]))/g
const NAMED_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' }

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
 * A tree of source files the graph is built over. Two implementations: the
 * real one reads the repo and canonicalizes through `realpath(3)`; the
 * synthetic one is a literal Map with an identity canonicalizer, so the
 * graph machinery can be proven against violations that do not exist in
 * this repo without writing files to disk.
 */
interface SourceTree {
  files: ReadonlyMap<string, string>
  canonical: (candidate: string) => string
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
 * The file a relative specifier names, or `null` for a bare/package
 * specifier or one that resolves to nothing in the tree. `specifier.startsWith('.')`
 * is a LITERAL-argument check (a module specifier against the fixed string
 * `'.'`), not a containment comparison against a root variable, so it is not
 * one of the sites `paths/prefix-comparison-law.test.ts` counts.
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
 * `null` if none exists. `stopAt` BOUNDS the walk — a file it names is still
 * visited (so a chain that ENDS there is reported) but the walk does not
 * continue through it. Omit `stopAt` for the RAW graph.
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
    if (stopAt.has(tip)) continue
    for (const next of graph.get(tip) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push([...chain, next])
    }
  }
  return null
}

/**
 * The hand's files, canonicalized — the graph's own keys. A SET, not a
 * prefix comparison: `paths/prefix-comparison-law.test.ts` pins the number
 * of containment-shaped sites in test files (14), and the obvious spelling
 * copied from `concierge/namespace-law.test.ts`'s `isInConcierge`
 * (`file.startsWith(dir + path.sep)`) would add five and turn that law red
 * from a file outside this issue's fence. A Set is exact rather than
 * prefix-shaped anyway, and it grows by itself the moment wave 2 lands a
 * file under `shipper/`.
 */
const CANONICAL_SHIPPER_FILES: ReadonlySet<string> = new Set(walkSourceFiles(SHIPPER_DIR).map(realCanonical))

function isInShipper(file: string): boolean {
  return CANONICAL_SHIPPER_FILES.has(file)
}

/**
 * Every non-test source in both packages — the population clauses 2b and 3b
 * sweep. Recomputed per call rather than frozen at module load, so a file
 * added under either root is seen by the very next run.
 */
function allNonTestSources(): string[] {
  return [...walkSourceFiles(SERVER_SRC), ...walkSourceFiles(WEB_SRC)].filter((file) => !isTest(file))
}

/** The same population with the hand's own sources removed — clause 3b's, since the hand legitimately declares its own timer. */
function nonTestSourcesOutsideTheHand(): string[] {
  return allNonTestSources().filter((file) => !isInShipper(realCanonical(file)))
}

/**
 * Whether `code` names `identifier` as a whole word. A NAME check, not a call
 * check, for the same reason clause 1 bans `createServer` by name: a bare
 * reference is enough to hand the thing to something that will call it.
 */
function namesIdentifier(code: string, identifier: string): boolean {
  return new RegExp(`\\b${identifier}\\b`).test(code)
}

describe("the fifth hand's law (ADR-0034 / docs/adr/0034-the-fifth-hand.md) — written before shipper/ has a single source file", () => {
  describe('the module the law is about is enumerated, not merely discovered — a sweep over nothing reports the same green as a sweep over something', () => {
    it('the declared inventory is NON-EMPTY and matches what the real sweep finds, as a set', () => {
      const found = shipperSourceFiles().map(relative)
      // Non-empty first: the assertion below is an equality, and two empty
      // lists are equal. This is the half that stops the sweep going vacuous
      // again if `shipper/` is ever emptied.
      expect(found.length).toBeGreaterThan(0)
      expect(SHIPPER_SOURCES_TODAY.length).toBeGreaterThan(0)
      // Sorted because `walkSourceFiles` returns `readdirSync` order, which is
      // a filesystem property; the assertion is still an EXACT set equality,
      // never a subset or a pattern.
      expect([...found].sort()).toEqual([...SHIPPER_SOURCES_TODAY].sort())
    })

    it('shipper/ contains exactly the files this law declares — nothing has landed under it unnoticed', () => {
      expect(readdirSync(SHIPPER_DIR).sort()).toEqual([...SHIPPER_DIRECTORY_TODAY].sort())
    })

    it('every declared source really is a file on disk — a declared inventory naming a ghost bounds nothing', () => {
      for (const declared of SHIPPER_SOURCES_TODAY) {
        expect(existsSync(path.join(REPO_ROOT, declared)), `${declared} is declared but absent`).toBe(true)
      }
    })

    it("the collectors sweep clause 3's raw graph depends on is real, not vacuous", () => {
      const nonTestCollectors = walkSourceFiles(COLLECTORS_DIR).filter((file) => !isTest(file))
      expect(nonTestCollectors.length).toBeGreaterThan(5)
      expect(nonTestCollectors.map(relative)).toContain(
        path.join('packages', 'server', 'src', 'collectors', 'git', 'git-collector.ts'),
      )
    })
  })

  describe('clause 1 — outbound only', () => {
    /**
     * `createServer` is banned by NAME, not by call — `/\bcreateServer\s*\(/`
     * misses `import { createServer } from 'node:http'`, which is the whole
     * shape ADR-0034 clause 1 is about: a bare reference is enough to hand a
     * listener to something that will call it (same reasoning
     * `concierge/namespace-law.test.ts` gives for `promisify(cp.exec)`).
     *
     * `node:http` and `node:https` are NOT banned as MODULES, only their
     * server constructors — ADR-0034's own wording: the shipper is an HTTPS
     * client, and banning the module would forbid the hand's legitimate
     * shape. `net`, `dgram` and `http2` ARE banned outright — an outbound
     * HTTPS client has no use for any of them.
     *
     * `.listen(` is deliberately wide, firing on any `.listen(`, not only a
     * socket's — the safe direction for a fence.
     */
    const LISTENER_PATTERNS: Array<{ what: string; pattern: (code: string) => boolean }> = [
      { what: 'createServer — a listener constructor', pattern: (code) => /\bcreateServer\b/.test(code) },
      {
        what: 'new Server(…) — a listener constructor',
        pattern: (code) => /\bnew\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)?Server\s*\(/.test(code),
      },
      { what: '.listen( — a bound socket', pattern: (code) => /\.\s*listen\s*\(/.test(code) },
      { what: 'fastify as a module specifier', pattern: (code) => /(['"`])fastify(?:\/[^'"`]*)?\1/.test(code) },
      {
        what: 'a raw-socket module — net, dgram or http2',
        pattern: (code) => /(['"`])(?:node:)?(?:net|dgram|http2)\1/.test(code),
      },
    ]

    it('those detectors bite', () => {
      const violations = [
        `import { createServer } from 'node:http'`,
        `import { createServer } from 'node:https'`,
        `const s = new https.Server(opts)`,
        `await app.listen({ port: 0 })`,
        `import Fastify from 'fastify'`,
        `import { createServer } from 'net'`,
        `import { Socket } from 'node:net'`,
      ]
      for (const violation of violations) {
        expect(
          LISTENER_PATTERNS.some(({ pattern }) => pattern(violation)),
          `missed: ${violation}`,
        ).toBe(true)
      }
    })

    it('and do not fire on the outbound client the hand legitimately is', () => {
      const legitimate = [
        `const response = await fetch(url, { method: 'POST', headers, body })`,
        `import { request } from 'undici'`,
        `import { setTimeout as delay } from 'node:timers/promises'`,
        `const listeners = subscribers.length`,
      ]
      for (const shape of legitimate) {
        expect(
          LISTENER_PATTERNS.some(({ pattern }) => pattern(shape)),
          `false positive on: ${shape}`,
        ).toBe(false)
      }
    })

    it('nothing under shipper/ opens a listener', () => {
      const offenders: string[] = []
      for (const file of shipperSourceFiles()) {
        const code = codeOf(readFileSync(file, 'utf8'))
        for (const { what, pattern } of LISTENER_PATTERNS) {
          if (pattern(code)) offenders.push(`${relative(file)}: ${what}`)
        }
      }
      expect(offenders).toEqual([])
    })

    const RUN_TS = path.join(SERVER_SRC, 'cli', 'run.ts')
    const MUTATION_GUARD_TS = path.join(SERVER_SRC, 'server', 'mutation-guard.ts')
    const BIND_ANCHOR = "url = await app.listen({ port: args.port, host: '127.0.0.1' })"
    const LOOPBACK_ANCHOR = "const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])"

    function occurrences(haystack: string, needle: string): number {
      return haystack.split(needle).length - 1
    }

    it("the instrument's bind is 127.0.0.1, pinned by text anchor", () => {
      const source = readFileSync(RUN_TS, 'utf8')
      expect(
        occurrences(source, BIND_ANCHOR),
        `the bind anchor moved in ${relative(RUN_TS)} — re-derive it, do not delete this`,
      ).toBe(1)
      expect(source).not.toContain("host: '0.0.0.0'")
      expect(source).not.toContain("host: '::'")
    })

    it("mutation-guard's loopback set is the four-entry set, pinned by text anchor", () => {
      const source = readFileSync(MUTATION_GUARD_TS, 'utf8')
      expect(occurrences(source, LOOPBACK_ANCHOR), `the loopback anchor moved in ${relative(MUTATION_GUARD_TS)}`).toBe(
        1,
      )
      // Greedy `(.*)`, anchored on the whole `const …` prefix, so it backtracks
      // to the LAST `])` — a non-greedy or `[^\]]*` capture stops at the `]`
      // inside the fourth entry `'[::1]'` and silently produces `['']`.
      const inner = /const LOOPBACK_HOSTNAMES = new Set\(\[(.*)\]\)/.exec(source)?.[1]
      expect(inner, 'LOOPBACK_HOSTNAMES is no longer a `new Set([…])` literal').toBeDefined()
      // Parsed out of the SOURCE, not out of LOOPBACK_ANCHOR — parsing a
      // constant this file typed itself would prove nothing.
      const entries = [...(inner as string).matchAll(/'([^']*)'/g)].map((match) => match[1])
      expect(entries).toEqual(['127.0.0.1', 'localhost', '::1', '[::1]'])
    })
  })

  describe('clause 2 — one credential, one shape, one place', () => {
    const STRING_LITERAL_RE = /(['"`])([^'"`\n]{0,80})\1/g
    /** A string literal that IS a key prefix — `'rzk_'`, `'sk_'`, `'ghp_'`. */
    const BARE_PREFIX_RE = /^([a-z][a-z0-9]{1,7})_$/
    /** A whole key written inline — a prefix plus an opaque body, no further underscore. */
    const OPAQUE_KEY_RE = /^([a-z][a-z0-9]{1,7})_[A-Za-z0-9]{16,}$/

    /**
     * Measured against every `.ts`/`.tsx` in `packages/`, comments stripped:
     * `BARE_PREFIX_RE` — 0 hits repo-wide. `OPAQUE_KEY_RE` — 28 hits, all
     * collector fixtures (Anthropic `req_…`/`toolu_…` ids in
     * `collectors/otel/` and `collectors/sessionlog/` tests). Two arms tried
     * and rejected: a bare `\b([a-z][a-z0-9]{1,7})_(?=[A-Za-z0-9]{6,})` sweep
     * returns 11 distinct prefixes across the server (`tool_`, `span_`,
     * `input_`, `cache_`, `query_`…) — it reads OTLP snake_case attribute
     * names as credentials. Admitting `-` as well as `_` returns 1,799 hits,
     * because kebab-case is everywhere.
     */
    function keyPrefixes(code: string): string[] {
      const out = new Set<string>()
      for (const match of code.matchAll(STRING_LITERAL_RE)) {
        const literal = match[2] ?? ''
        const bare = BARE_PREFIX_RE.exec(literal)
        if (bare?.[1] !== undefined) {
          out.add(bare[1])
          continue
        }
        const opaque = OPAQUE_KEY_RE.exec(literal)
        if (opaque?.[1] !== undefined) out.add(opaque[1])
      }
      return [...out].sort()
    }

    const LOG_SINK_RE =
      /\b(?:console\s*\.\s*(?:log|info|warn|error|debug|trace)|process\s*\.\s*std(?:out|err)\s*\.\s*write|(?:[A-Za-z_$][\w$]*\s*\.\s*)?log\s*\.\s*(?:info|warn|error|debug|trace|fatal))\s*\(/g
    /**
     * No word boundaries and deliberately wide — fires on `ingestKey`,
     * `apiKey`, `keyPresent` alike, the safe direction for a credential
     * fence. `token` is deliberately NOT here: in this repo `token`
     * overwhelmingly means a usage count (`input_tokens`, spend accounting),
     * and the shipper posts records carrying exactly those. ADR-0034 calls
     * the credential a KEY; `key`, `secret`, `credential`, `password`,
     * `bearer` and the literal `rzk_` cover it without convicting
     * `log.info({ events, tokens })`.
     */
    const KEYISH_RE = /key|secret|credential|password|bearer|rzk_/i

    /**
     * The text between a call's `(` and its matching `)`, string-literal
     * aware. Not line-scoped: a pino-style `log.info({ … }, 'msg')` written
     * across lines is how everyone writes it.
     */
    function callArgumentSpan(code: string, openParenIndex: number): string {
      let depth = 0
      let i = openParenIndex
      let quote: string | null = null
      while (i < code.length) {
        const ch = code[i] as string
        if (quote !== null) {
          if (ch === '\\') i += 2
          else {
            if (ch === quote) quote = null
            i++
          }
          continue
        }
        if (ch === "'" || ch === '"' || ch === '`') {
          quote = ch
          i++
          continue
        }
        if (ch === '(') depth++
        else if (ch === ')') {
          depth--
          if (depth === 0) return code.slice(openParenIndex + 1, i)
        }
        i++
      }
      return code.slice(openParenIndex + 1)
    }

    function logsAKey(code: string): boolean {
      for (const match of code.matchAll(LOG_SINK_RE)) {
        const openParen = (match.index ?? 0) + match[0].length - 1
        if (KEYISH_RE.test(callArgumentSpan(code, openParen))) return true
      }
      return false
    }

    /** ADR-0034 clause 2 says "never argv" of the credential, so this bans `process.argv`, not `argv` bare — the hand legitimately receives argv-derived config as a PARAMETER from the CLI. */
    function readsArgvForAKey(code: string): boolean {
      return /\bprocess\s*\.\s*argv\b/.test(code)
    }

    it('keyPrefixes finds a bare prefix or an inline key, and only the one grant', () => {
      expect(keyPrefixes(`const PREFIX = 'sk_'`)).toEqual(['sk'])
      expect(keyPrefixes(`const KEY = 'ghp_A1b2C3d4E5f6G7h8i9J0'`)).toEqual(['ghp'])
      expect(keyPrefixes(`const P = 'rzk_'\nconst Q = 'sk_'`)).toEqual(['rzk', 'sk'])

      expect(keyPrefixes(`const PREFIX = 'rzk_'`)).toEqual(['rzk'])
      expect(keyPrefixes(`const route = '/v1/rhizomorph/ingest'`)).toEqual([])
      expect(keyPrefixes(`const header = 'x-rz-ingest-key'`)).toEqual([])
    })

    it('readsArgvForAKey fires on process.argv, not on the identifier argv alone', () => {
      expect(readsArgvForAKey(`const key = process.argv[3]`)).toBe(true)
      expect(readsArgvForAKey(`export function enable(argv: string[]) { return argv[0] }`)).toBe(false)
    })

    it('logsAKey fires on every sink, multi-line calls included, and not on an ordinary log line', () => {
      expect(logsAKey(`console.log('ingest key', ingestKey)`)).toBe(true)
      expect(logsAKey(`request.log.info(\n  { ingestKey },\n  'shipping',\n)`)).toBe(true)
      expect(logsAKey('process.stdout.write(`key=${ingestKey}\\n`)')).toBe(true)

      expect(logsAKey(`console.log('shipped', batch.length, 'events')`)).toBe(false)
      expect(logsAKey(`headers['x-rz-ingest-key'] = key`)).toBe(false)
    })

    it('no shipper source file holds a second key prefix, reads process.argv for one, or logs one', () => {
      const offenders: string[] = []
      for (const file of shipperSourceFiles()) {
        const code = codeOf(readFileSync(file, 'utf8'))
        for (const prefix of keyPrefixes(code)) {
          if (prefix !== 'rzk') offenders.push(`${relative(file)}: ${prefix}_`)
        }
        if (readsArgvForAKey(code)) offenders.push(`${relative(file)}: reads process.argv`)
        if (logsAKey(code)) offenders.push(`${relative(file)}: logs a key`)
      }
      expect(offenders).toEqual([])
    })
  })

  describe('clause 3 — the clock is bounded to one act', () => {
    const tree = realSourceTree()
    const graph = buildImportGraph(tree)

    it('the graph is real and alive — it sees a chain a per-file grep cannot', () => {
      expect(tree.files.size).toBeGreaterThan(300)
      const apiLab = realCanonical(path.join(SERVER_SRC, 'api', 'lab.ts'))
      const cliIndex = realCanonical(path.join(SERVER_SRC, 'cli', 'index.ts'))
      expect(graph.get(apiLab)).toContain(cliIndex)
      const labFiles = new Set(walkSourceFiles(path.join(SERVER_SRC, 'lab')).map(realCanonical))
      const chain = shortestChain(graph, apiLab, (file) => labFiles.has(file))
      expect(chain).not.toBeNull()
      expect((chain as string[]).length).toBeGreaterThan(2)
    })

    it('no collector and no poll loop reaches the shipper, on the RAW graph — a gate does not make a poll a human', () => {
      const rawFiles = [
        ...walkSourceFiles(COLLECTORS_DIR).filter((file) => !isTest(file)),
        path.join(SERVER_SRC, 'server', 'poll-loop.ts'),
        path.join(SERVER_SRC, 'server', 'collector-loader.ts'),
      ]
      const offenders: string[] = []
      for (const file of rawFiles) {
        const canonical = realCanonical(file)
        expect(tree.files.has(canonical), `${relative(file)} is not in the graph — has it moved?`).toBe(true)
        const chain = shortestChain(graph, canonical, isInShipper)
        if (chain !== null) offenders.push(chain.map(relative).join(' -> '))
      }
      expect(offenders).toEqual([])
    })

    it('no file outside the hand reaches it, bounded by the declared importers', () => {
      const declared = new Set([...DECLARED_IMPORTERS].map(realCanonical))
      const violations: string[] = []
      for (const file of tree.files.keys()) {
        if (isInShipper(file)) continue
        const chain = shortestChain(graph, file, isInShipper, declared)
        if (chain !== null) violations.push(chain.map(relative).join(' -> '))
      }
      expect(violations).toEqual([])
    })

    it('the declared-importer set is exactly the one file ruling 14 names, and that file exists', () => {
      const theOne = path.join(SERVER_SRC, 'cli', 'connect-team.ts')
      expect([...DECLARED_IMPORTERS]).toEqual([theOne])
      // The existence half is the point: a declared importer naming a file
      // that is not there bounds nothing, and the bounded sweep above would
      // pass over an unguarded route reporting exactly this green.
      expect(existsSync(theOne)).toBe(true)
    })

    it('no collector, no poll loop and no web file may ever be a declared importer', () => {
      const forbidden = [...DECLARED_IMPORTERS].filter((importer) =>
        NEVER_AN_IMPORTER.some((banned) => isInside(banned, importer)),
      )
      expect(forbidden).toEqual([])
    })
  })


  /**
   * CLAUSE 3B — THE TIMER'S CONSTRUCTION SITE, AS A CALL-SITE LAW.
   *
   * **Read this before "fixing" it back into a graph clause.** ADR-0034 clause
   * 3 says the timer runs "never from a collector, a poll or a boot". The
   * import graph above enforces the first two and provably CANNOT enforce the
   * third, because this chain already exists on `main`:
   *
   * ```
   * packages/server/src/server/build-app.ts
   *   -> packages/server/src/api/index.ts
   *   -> packages/server/src/api/lab.ts
   *   -> packages/server/src/cli/index.ts
   * ```
   *
   * `api/lab.ts` invokes `runCli` for prd53 ruling 3's measure route. So the
   * moment `connect` joins `cli/index.ts`'s dispatch table — which
   * `cli-surface-law.test.ts` REQUIRES of any new top-level subcommand — the
   * hand is statically reachable from the Fastify app, and no graph-shaped
   * clause can separate "boot could reach it" from "boot does reach it".
   * Adding `run.ts` or `build-app.ts` as raw-sweep origins reddens
   * immediately and says nothing about whether a timer was started.
   *
   * The answer is to guard the CONSTRUCTION SITE rather than the reach: only
   * `cli/connect-team.ts` may name the timer's entry points, and only in the
   * foreground of a process a human started. That is a strengthening of the
   * bound's enforcement, not a weakening of the bound — and it is why the
   * shipper's own loop never runs in the server process.
   */
  describe("clause 3b — only the enable command may name the hand's timer", () => {
    const TIMER_ENTRY_POINTS = ['runShipperLoop', 'shipOnce'] as const
    const THE_ONLY_CALLER = realCanonical(path.join(SERVER_SRC, 'cli', 'connect-team.ts'))

    it('those detectors bite, and do not fire on an ordinary identifier that merely looks like one', () => {
      const violation = `import { runShipperLoop } from '../shipper/index.js'\nvoid runShipperLoop({ sessionDir })\n`
      expect(TIMER_ENTRY_POINTS.some((name) => namesIdentifier(violation, name))).toBe(true)
      expect(namesIdentifier(`await shipOnce({ sessionDir })`, 'shipOnce')).toBe(true)

      for (const innocent of [
        `const loops = lanes.length`,
        `const status = await shipperStatus(sessionDir)`,
        `const shipOnceMore = 1`,
        `runShipperLoopback()`,
      ]) {
        expect(
          TIMER_ENTRY_POINTS.some((name) => namesIdentifier(innocent, name)),
          `false positive on: ${innocent}`,
        ).toBe(false)
      }
    })

    it('the sweep it runs is over a real, non-empty set of files outside the hand', () => {
      expect(nonTestSourcesOutsideTheHand().length).toBeGreaterThan(100)
      expect(nonTestSourcesOutsideTheHand().map(realCanonical)).toContain(
        realCanonical(path.join(SERVER_SRC, 'server', 'build-app.ts')),
      )
      expect(nonTestSourcesOutsideTheHand().map(realCanonical)).toContain(
        realCanonical(path.join(SERVER_SRC, 'cli', 'run.ts')),
      )
    })

    it('no file outside the hand names the timer except the enable command', () => {
      const offenders: string[] = []
      for (const file of nonTestSourcesOutsideTheHand()) {
        if (realCanonical(file) === THE_ONLY_CALLER) continue
        const code = codeOf(readFileSync(file, 'utf8'))
        for (const name of TIMER_ENTRY_POINTS) {
          if (namesIdentifier(code, name)) offenders.push(`${relative(file)}: ${name}`)
        }
      }
      expect(offenders).toEqual([])
    })

    it('and the enable command really does name it — an allowance nobody uses guards nothing', () => {
      const code = codeOf(readFileSync(THE_ONLY_CALLER, 'utf8'))
      expect(namesIdentifier(code, 'runShipperLoop')).toBe(true)
    })
  })

  /**
   * CLAUSE 2B — ONE READER OF THE KEY'S VALUE.
   *
   * The sibling of clause 3b, one layer down and for the same reason: the
   * reviewed pattern is *a guard placed on the import graph while the real
   * reach is a call site*. `IngestKey` renders as `rzk_[redacted]` through
   * `toString`, `toJSON` and Node's inspect hook, so the value only escapes if
   * something asks for it by name. Exactly two files may: `shipper/key.ts`,
   * which declares the method, and `shipper/post.ts`, which puts it on the one
   * header that carries it.
   */
  describe("clause 2b — exactly one reader of the credential's value", () => {
    const READER = 'headerValue'
    const ALLOWED = new Set(
      [path.join(SHIPPER_DIR, 'key.ts'), path.join(SHIPPER_DIR, 'post.ts')].map(realCanonical),
    )

    it('the detector bites, and does not fire on the header NAME it sits beside', () => {
      expect(namesIdentifier(`headers[INGEST_KEY_HEADER] = options.key.headerValue()`, READER)).toBe(true)
      expect(namesIdentifier(`response.headers.get('x-rz-ingest-key')`, READER)).toBe(false)
      expect(namesIdentifier(`const headerValues = [...headers]`, READER)).toBe(false)
    })

    it('no non-test source in either package names it but the two that must', () => {
      const namers: string[] = []
      for (const file of allNonTestSources()) {
        if (namesIdentifier(codeOf(readFileSync(file, 'utf8')), READER)) namers.push(relative(file))
      }
      expect(namers.sort()).toEqual(
        [...ALLOWED].map((file) => relative(file)).sort(),
      )
    })
  })

  describe('clause 3, proven against synthetic violations — the detector bites', () => {
    const THE_HAND = { '/repo/src/shipper/ship.ts': 'export const ship = 1\n' }
    const HAND_FILES = ['/repo/src/shipper/ship.ts', '/repo/src/shipper/ship.test.ts'].map((file) => path.resolve(file))

    /** The basename chain from `from` to the hand, on the RAW graph. */
    function rawReach(files: Record<string, string>, from: string): string | undefined {
      const tree = syntheticTree(files)
      const graph = buildImportGraph(tree)
      const chain = shortestChain(graph, path.resolve(from), (file) => HAND_FILES.includes(file))
      return chain?.map((file) => path.basename(file)).join(' -> ')
    }

    /** Every file reaching the hand, bounded by `declaredImporters` — the sorted basenames. */
    function reachers(files: Record<string, string>, declaredImporters: string[] = []): string[] {
      const tree = syntheticTree(files)
      const graph = buildImportGraph(tree)
      const declared = new Set(declaredImporters.map((file) => path.resolve(file)))
      const out: string[] = []
      for (const file of tree.files.keys()) {
        if (HAND_FILES.includes(file)) continue
        if (shortestChain(graph, file, (target) => HAND_FILES.includes(target), declared) !== null) {
          out.push(path.basename(file))
        }
      }
      return out.sort()
    }

    it('a collector reaching the hand directly is caught', () => {
      expect(
        rawReach({ ...THE_HAND, '/repo/src/collectors/git.ts': `import { ship } from '../shipper/ship.js'\n` }, '/repo/src/collectors/git.ts'),
      ).toBe('git.ts -> ship.ts')
    })

    it('a poll loop reaching it THROUGH the declared enable path is still a violation on the raw graph, even though the bounded sweep credits the gate', () => {
      const files = {
        ...THE_HAND,
        '/repo/src/cli/connect-team.ts': `import { ship } from '../shipper/ship.js'\n`,
        '/repo/src/server/poll-loop.ts': `import '../cli/connect-team.js'\n`,
      }
      expect(reachers(files, ['/repo/src/cli/connect-team.ts']), 'the bounded sweep credits the gate').toEqual([])
      expect(rawReach(files, '/repo/src/server/poll-loop.ts')).toBe('poll-loop.ts -> connect-team.ts -> ship.ts')
    })

    it('a two-hop reach through an innocent helper is caught — nothing in the collector names the hand', () => {
      expect(
        reachers({
          ...THE_HAND,
          '/repo/src/collectors/helper.ts': `export { ship } from '../shipper/ship.js'\n`,
          '/repo/src/collectors/git.ts': `import { ship } from './helper.js'\n`,
        }),
      ).toEqual(['git.ts', 'helper.ts'])
    })

    it("the falsifier the issue names — the hand's own test reaching its own code is never a violation", () => {
      expect(
        reachers({
          ...THE_HAND,
          '/repo/src/shipper/ship.test.ts': `import { ship } from './ship.js'\n`,
        }),
      ).toEqual([])
    })

    it('an ordinary import of an unrelated module does not fire', () => {
      expect(
        reachers({
          ...THE_HAND,
          '/repo/src/collectors/git.ts': `import { readSessionEvents } from '../log/session-log.js'\n`,
          '/repo/src/log/session-log.ts': 'export const readSessionEvents = 1\n',
        }),
      ).toEqual([])
    })
  })
})
