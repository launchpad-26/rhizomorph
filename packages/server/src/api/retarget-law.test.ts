import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ROUTE_CLASSES } from './index.js'

/**
 * THE RETARGET IS A HUMAN'S ACT (prd-20 ruling 1 / ADR-0014 grant 3, #389).
 *
 * `POST /api/retarget` ends one recording and begins another in a different
 * repo. Ruling 1's condition on every power of this kind is that only an
 * explicit human invocation may reach it: **no collector, no poll, no timer**.
 *
 * **The gate is not the law, and this file exists because that distinction has
 * already been lost once here.** #359's review found the concierge's first
 * draft of its own version of this clause quietly switched off for its
 * declared route — the graph was walked with the gated file excluded, so the
 * clause held over everything except the one thing it was written about. A
 * token gate does not make a poll a human; it only means the poll would need a
 * token. So the reachability check below runs over the RAW import graph with
 * nothing excluded for being behind a gate, and the collectors and the poll
 * loop are named individually rather than left to a sweep that might not
 * happen to include them.
 *
 * Three clauses:
 *
 * 1. **Reachability.** No collector and no poll loop reaches the route — at
 *    any depth, through static import, dynamic `import()`, `require` or
 *    re-export. Nor does anything else that is not `api/index.ts`, the app's
 *    single route registrar.
 * 2. **No clock.** The route's own module schedules nothing, so "never
 *    retargets without a human's explicit command" holds structurally rather
 *    than by convention.
 * 3. **Gated.** It is classified `gated-mutation` and really does carry the
 *    capability-token `preHandler` — prd-20 ruling 2's condition, which is a
 *    separate promise from clause 1 and is checked separately.
 *
 * Clause 1's graph builder is a compact cousin of the concierge law's (which
 * closed #245's two holes: a one-hop grep cannot see `api/lab.ts ->
 * cli/index.ts -> lab/`, and a backtick or computed specifier walks through a
 * quote-anchored regex). Both are asserted here rather than assumed: the
 * detector is proven against a synthetic multi-hop chain and a backtick edge
 * before it is trusted over the real tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
// packages/server/src/api -> repo root
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..')
const SERVER_SRC = path.join(REPO_ROOT, 'packages', 'server', 'src')
const THE_ROUTE = path.join(SERVER_SRC, 'api', 'retarget.ts')

/**
 * The one file allowed to reach the route: the app's single route registrar.
 * Named here rather than discovered in a diff — and it is not a collector or a
 * poll loop, which is the whole claim.
 */
const ALLOWED_IMPORTERS = [path.join(SERVER_SRC, 'api', 'index.ts')]

/**
 * Named individually, not left to the sweep. A sweep that silently stopped
 * covering these would still pass; these will not.
 */
const NOTHING_ON_A_CLOCK = [
  path.join(SERVER_SRC, 'server', 'poll-loop.ts'),
  path.join(SERVER_SRC, 'server', 'collector-loader.ts'),
  path.join(SERVER_SRC, 'collectors', 'git', 'git-collector.ts'),
  path.join(SERVER_SRC, 'collectors', 'sessionlog', 'collector.ts'),
  path.join(SERVER_SRC, 'collectors', 'tmux', 'collector.ts'),
  path.join(SERVER_SRC, 'collectors', 'workmux', 'collector.ts'),
  path.join(SERVER_SRC, 'collectors', 'judge', 'collector.ts'),
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

/** Code with comments stripped — this file's own doc names the route it forbids reaching. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/**
 * Every module specifier in a file's code — `from '…'`, a bare `import '…'`, a
 * dynamic `import('…')`, a `require('…')` — in single quotes, double quotes or
 * **backticks**. The backtick arm is what #245's second hole was: a template
 * still yields its literal text, which is enough to see the path segment.
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

const canonical = (candidate: string): string => {
  try {
    return (realpathSync.native ?? realpathSync)(candidate)
  } catch {
    return path.resolve(candidate)
  }
}

interface SourceTree {
  files: ReadonlyMap<string, string>
  canonical: (candidate: string) => string
}

function realSourceTree(): SourceTree {
  const files = new Map<string, string>()
  for (const file of walkSourceFiles(SERVER_SRC)) {
    files.set(canonical(file), readFileSync(file, 'utf8'))
  }
  return { files, canonical }
}

/**
 * Resolves a specifier the way the build does: `.js` in source means the `.ts`
 * beside it, a directory means its `index.ts`, and an extensionless path is
 * tried both ways. A specifier that resolves to nothing in the tree (a package
 * import) is simply not an edge.
 */
function resolveSpecifier(tree: SourceTree, fromFile: string, specifier: string): string | null {
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
    const key = tree.canonical(candidate)
    if (tree.files.has(key)) return key
  }
  return null
}

/**
 * The chain from `start` to `goal`, or null when there is none — a path rather
 * than a boolean, so a violation names the hops instead of only asserting one
 * exists.
 */
function chainTo(tree: SourceTree, start: string, goal: string): string[] | null {
  const target = tree.canonical(goal)
  const origin = tree.canonical(start)
  if (!tree.files.has(origin)) return null

  const seen = new Set<string>([origin])
  const queue: Array<{ file: string; chain: string[] }> = [{ file: origin, chain: [origin] }]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break
    for (const specifier of importSpecifiers(codeOf(tree.files.get(current.file) ?? ''))) {
      const next = resolveSpecifier(tree, current.file, specifier)
      if (next === null || seen.has(next)) continue
      const chain = [...current.chain, next]
      if (next === target) return chain
      seen.add(next)
      queue.push({ file: next, chain })
    }
  }
  return null
}

describe('the retarget is a human act (prd-20 ruling 1 / ADR-0014 grant 3)', () => {
  const tree = realSourceTree()

  describe('clause 1 — nothing on a clock reaches the route, at any depth', () => {
    it('has a tree to walk, and the route is in it — an empty graph proves nothing', () => {
      expect(tree.files.size).toBeGreaterThan(50)
      expect(tree.files.has(canonical(THE_ROUTE))).toBe(true)
    })

    it('no collector and no poll loop reaches it — named individually, not swept', () => {
      for (const file of NOTHING_ON_A_CLOCK) {
        const chain = chainTo(tree, file, THE_ROUTE)
        expect(
          chain?.map((hop) => path.relative(REPO_ROOT, hop)).join(' -> ') ?? null,
          `${path.relative(REPO_ROOT, file)} reaches the retarget route`,
        ).toBeNull()
      }
    })

    it('each of those files really is in the graph — a path typo is also a null chain', () => {
      for (const file of NOTHING_ON_A_CLOCK) {
        expect(tree.files.has(canonical(file)), `${file} is not in the graph at all`).toBe(true)
      }
    })

    it('exactly one file imports it directly, and it is the route registrar', () => {
      // A ONE-HOP check on purpose, and it is the right shape here rather than a
      // weaker version of the sweep above. Reachability-from-anywhere is not a
      // meaningful law for a ROUTE: every file that builds the app reaches every
      // route through `api/index.ts`, which is the human's own path and the
      // point of having one. What the law can say precisely is who may hold the
      // door open — one file, named — and, transitively, that nothing on a clock
      // ever gets to it, which is the test above.
      const allowed = new Set(ALLOWED_IMPORTERS.map(canonical))
      const importers: string[] = []
      for (const file of walkSourceFiles(SERVER_SRC)) {
        if (isTest(file) || canonical(file) === canonical(THE_ROUTE)) continue
        const key = canonical(file)
        for (const specifier of importSpecifiers(codeOf(tree.files.get(key) ?? ''))) {
          if (resolveSpecifier(tree, key, specifier) === canonical(THE_ROUTE)) {
            importers.push(path.relative(REPO_ROOT, file))
          }
        }
      }
      expect(importers.filter((file) => !allowed.has(canonical(path.join(REPO_ROOT, file))))).toEqual([])
      // …and the declared importer is not dead: it really does import it.
      expect(importers).toEqual(ALLOWED_IMPORTERS.map((file) => path.relative(REPO_ROOT, file)))
    })

    it('the detector bites — a synthetic multi-hop chain and a backtick edge are both seen', () => {
      const fake: SourceTree = {
        canonical: (candidate) => path.resolve(candidate),
        files: new Map([
          [path.resolve('/x/poll.ts'), "import { go } from './middle.js'"],
          [path.resolve('/x/middle.ts'), 'const m = await import(`./target.js`)'],
          [path.resolve('/x/target.ts'), 'export const go = 1'],
          [path.resolve('/x/unrelated.ts'), "import { z } from './middle-other.js'"],
          [path.resolve('/x/middle-other.ts'), 'export const z = 1'],
        ]),
      }
      // Two hops, and the second one is a backtick — the two spellings #245
      // was actually about.
      expect(chainTo(fake, '/x/poll.ts', '/x/target.ts')).toEqual([
        path.resolve('/x/poll.ts'),
        path.resolve('/x/middle.ts'),
        path.resolve('/x/target.ts'),
      ])
      expect(chainTo(fake, '/x/unrelated.ts', '/x/target.ts')).toBeNull()
    })
  })

  describe('clause 2 — the route has no clock of its own', () => {
    it('schedules nothing', () => {
      const code = codeOf(readFileSync(THE_ROUTE, 'utf8'))
      expect(/\b(?:setInterval|setTimeout|setImmediate)\s*\(/.test(code)).toBe(false)
    })

    it('that detector bites', () => {
      expect(/\b(?:setInterval|setTimeout|setImmediate)\s*\(/.test('setInterval(() => retarget(), 60_000)')).toBe(true)
    })
  })

  describe('clause 3 — it is gated, and the gate is real (prd-20 ruling 2)', () => {
    it('is classified as a gated mutation', () => {
      expect(ROUTE_CLASSES).toContainEqual({
        method: 'POST',
        url: '/api/retarget',
        routeClass: 'gated-mutation',
      })
    })

    it('really does carry the capability-token preHandler — the row is not the gate', () => {
      const code = codeOf(readFileSync(THE_ROUTE, 'utf8'))
      expect(code).toContain('requireCapabilityToken')
      expect(code).toMatch(/preHandler:\s*requireCapabilityToken/)
    })
  })
})
