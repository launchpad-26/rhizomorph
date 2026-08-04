import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/index.js'
import { exec as realExec } from '../server/exec.js'
import { captureCheckpoint } from './checkpoint.js'
import { dispatchFork } from './fork.js'
import { isInside, labRoot } from './paths.js'

/**
 * prd12 ruling 1's law test — the amendment's own condition: "the observer's
 * readonly greps stay green untouched [...] a new lab-namespace test asserts
 * every lab-side write path is confined to the namespaces above." Two halves:
 *
 * 1. No observer source file imports from `server/src/lab/` — the second
 *    hand is explicitly-invoked only, never reachable from a collector or a
 *    background poll. The one allowed exception is the CLI's own wiring
 *    point (`cli/index.ts` dispatching `rhizomorph lab checkpoint`), named
 *    below rather than silently excluded.
 * 2. Every git ref this package's lab module writes to is confined to
 *    `refs/rhizomorph/`, and no lab source file ever shells out to a
 *    disallowed git verb (`push`, `merge`, `checkout`, `branch -D`).
 * 3. (#153) The lab has no clock of its own — no `setInterval`/`setTimeout`
 *    anywhere under `lab/` — so "never runs without a human's explicit
 *    command" holds structurally and not just by convention.
 * 4. (#153) A live pass of the whole phase-2 write surface: `lab fork`
 *    against a real fixture repo writes NOTHING outside `refs/rhizomorph/`,
 *    the lab's own worktrees, the lab data dir, and the synthesized-session
 *    artifacts ruling 1 names — asserted by walking the filesystem before and
 *    after, not by reading the source.
 *
 * Halves 1–3 are grep-style, per the issue: real source text, regexes, no
 * AST. That is deliberately as legible as the readonly law tests it sits
 * beside — a reader should be able to verify the check by eye. Half 4 is the
 * one that cannot be fooled by a clever spelling: it runs the thing.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
// packages/server/src/lab -> repo root
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..')
const SERVER_SRC = path.join(REPO_ROOT, 'packages', 'server', 'src')
const WEB_SRC = path.join(REPO_ROOT, 'packages', 'web', 'src')
const LAB_DIR = path.join(SERVER_SRC, 'lab')

/** The one file allowed to import the lab module — the explicit CLI wiring point. */
const ALLOWED_IMPORTERS = new Set([path.join(SERVER_SRC, 'cli', 'index.ts')])

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

/** Every `from '...'` / `import '...'` / `import('...')` / `require('...')` specifier in a file's text. */
const IMPORT_SPECIFIER_RE = /(?:\bfrom\s+|\brequire\(\s*|\bimport\(\s*|\bimport\s+)['"]([^'"]+)['"]/g

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  for (const match of source.matchAll(IMPORT_SPECIFIER_RE)) {
    const specifier = match[1]
    if (specifier !== undefined) specifiers.push(specifier)
  }
  return specifiers
}

/** True if a specifier resolves into (or names) the lab module — relative or bare. */
function targetsLab(specifier: string): boolean {
  return /(^|\/)lab\/[^/]/.test(specifier) || /(^|\/)lab$/.test(specifier)
}

/** The importable specifiers a source file's text targets the lab module through. */
function findLabImports(source: string): string[] {
  return importSpecifiers(source).filter(targetsLab)
}

describe('the lab namespace law (prd12 ruling 1)', () => {
  describe('no observer import reaches the lab', () => {
    it('the detector fires on a deliberately-violating fixture — proving it bites', () => {
      const badFixture = readFileSync(path.join(LAB_DIR, '__fixtures__', 'bad-import.ts.txt'), 'utf8')
      expect(findLabImports(badFixture)).toEqual(["../lab/checkpoint.js"])
    })

    it('the detector does not fire on an ordinary observer import — not vacuously true', () => {
      const cleanFixture = readFileSync(path.join(LAB_DIR, '__fixtures__', 'clean-import.ts.txt'), 'utf8')
      expect(findLabImports(cleanFixture)).toEqual([])
    })

    it('no server source file outside the lab module imports from it, except the one declared CLI wiring point', () => {
      const files = walkSourceFiles(SERVER_SRC, [LAB_DIR])
      const violations: Array<{ file: string; specifiers: string[] }> = []

      for (const file of files) {
        if (ALLOWED_IMPORTERS.has(path.resolve(file))) continue
        const hits = findLabImports(readFileSync(file, 'utf8'))
        if (hits.length > 0) violations.push({ file: path.relative(REPO_ROOT, file), specifiers: hits })
      }

      expect(violations).toEqual([])
    })

    it('the one allowed importer (cli/index.ts) does import the lab module — the exception is real, not dead code', () => {
      const cliIndexPath = path.join(SERVER_SRC, 'cli', 'index.ts')
      const hits = findLabImports(readFileSync(cliIndexPath, 'utf8'))
      expect(hits.length).toBeGreaterThan(0)
    })

    it('no web source file imports from the lab module', () => {
      const files = walkSourceFiles(WEB_SRC)
      const violations = files
        .map((file) => ({ file: path.relative(REPO_ROOT, file), specifiers: findLabImports(readFileSync(file, 'utf8')) }))
        .filter((entry) => entry.specifiers.length > 0)

      expect(violations).toEqual([])
    })
  })

  describe('every write inside lab/ targets only the amended namespaces', () => {
    const REF_LITERAL_RE = /refs\/[^\s'"`]*/g
    const FORBIDDEN_GIT_VERBS = ['push', 'merge', 'checkout']

    function labSourceFiles(): string[] {
      return walkSourceFiles(LAB_DIR, [path.join(LAB_DIR, '__fixtures__')]).filter(
        (file) => !file.endsWith('.test.ts'),
      )
    }

    it('every refs/ literal in lab/ source is under refs/rhizomorph/', () => {
      const files = labSourceFiles()
      expect(files.length).toBeGreaterThan(0) // the check below would vacuously pass on an empty dir

      const offenders: string[] = []
      for (const file of files) {
        const source = readFileSync(file, 'utf8')
        for (const match of source.matchAll(REF_LITERAL_RE)) {
          const ref = match[0]
          if (!ref.startsWith('refs/rhizomorph/')) {
            offenders.push(`${path.relative(REPO_ROOT, file)}: ${ref}`)
          }
        }
      }
      expect(offenders).toEqual([])
    })

    // Matches a quoted verb only in argv position — inside `[...]`, preceded
    // by `[` or `,` and followed by `,` or `]` (whitespace-tolerant) — so an
    // English sentence merely naming the verb (as this law's own doc comment
    // does) is not a false positive; only an actual argv literal is.
    function forbiddenVerbPattern(verb: string): RegExp {
      return new RegExp(`[[,]\\s*(['"\`])${verb}\\1\\s*[,\\]]`)
    }

    it('never shells out to push, merge or checkout', () => {
      const files = labSourceFiles()
      const offenders: string[] = []

      for (const file of files) {
        const source = readFileSync(file, 'utf8')
        for (const verb of FORBIDDEN_GIT_VERBS) {
          if (forbiddenVerbPattern(verb).test(source)) {
            offenders.push(`${path.relative(REPO_ROOT, file)}: "${verb}"`)
          }
        }
      }
      expect(offenders).toEqual([])
    })

    it('the detector on this exact law would catch a rogue push if one were added — proving it bites', () => {
      const rogueSource = `await exec('git', ['push', 'origin', 'main'])\n`
      expect(forbiddenVerbPattern('push').test(rogueSource)).toBe(true)

      // And it does not fire on the verb merely being named in prose, the
      // false-positive this law test's own doc comment would otherwise be.
      const proseOnly = 'Nothing here ever runs `push`, `merge`, or `checkout`.'
      expect(forbiddenVerbPattern('push').test(proseOnly)).toBe(false)
    })

    // #153 extends the forbidden set to the verbs that rewrite a working tree
    // or an operator ref. `commit-tree`, `rev-list` and `worktree add` — the
    // three the lab genuinely needs — are unaffected: the pattern matches a
    // whole quoted argv token, so `'commit-tree'` is not `'commit'`.
    const PHASE_2_FORBIDDEN = ['reset', 'clean', 'commit', 'rebase', 'cherry-pick', 'stash', 'branch', 'tag']

    it('never shells out to a verb that rewrites a working tree or an operator ref', () => {
      const offenders: string[] = []
      for (const file of labSourceFiles()) {
        const source = readFileSync(file, 'utf8')
        for (const verb of PHASE_2_FORBIDDEN) {
          if (forbiddenVerbPattern(verb).test(source)) {
            offenders.push(`${path.relative(REPO_ROOT, file)}: "${verb}"`)
          }
        }
      }
      expect(offenders).toEqual([])
    })

    it('the extended detector bites, and does not fire on the verbs the lab legitimately uses', () => {
      expect(forbiddenVerbPattern('reset').test(`exec('git', ['reset', '--hard'])`)).toBe(true)
      expect(forbiddenVerbPattern('branch').test(`exec('git', ['branch', '-D', 'x'])`)).toBe(true)
      // The real argv literals in lab/ source, which must NOT trip it.
      expect(forbiddenVerbPattern('commit').test(`exec('git', ['commit-tree', tree, '-p', head])`)).toBe(false)
      expect(forbiddenVerbPattern('branch').test(`exec('git', ['rev-list', '--count', range])`)).toBe(false)
    })
  })

  describe('the lab has no clock of its own', () => {
    it('no lab source file schedules work — "never runs without a human\'s explicit command", structurally', () => {
      const offenders: string[] = []
      for (const file of walkSourceFiles(LAB_DIR, [path.join(LAB_DIR, '__fixtures__')])) {
        if (file.endsWith('.test.ts')) continue
        const source = readFileSync(file, 'utf8')
        if (/\b(setInterval|setTimeout|setImmediate)\s*\(/.test(source)) {
          offenders.push(path.relative(REPO_ROOT, file))
        }
      }
      expect(offenders).toEqual([])
    })

    it('that detector bites — a scheduled lab would be caught', () => {
      expect(/\b(setInterval|setTimeout|setImmediate)\s*\(/.test('setInterval(() => capture(), 60_000)')).toBe(true)
    })
  })
})

/**
 * The live half. Everything above reads source text; this runs `lab fork`
 * against a real fixture repo and asserts, by walking the filesystem and the
 * ref namespace before and after, that ruling 1's fence held.
 *
 * Hermetic under 4x concurrency: one `mkdtemp` root per test, pid+uuid ids.
 */
describe('the lab namespace law, live (prd12 ruling 1, #153)', () => {
  let root: string
  let repoDir: string
  let dataRoot: string
  let claudeProjectsRoot: string

  function git(args: string[], cwd = repoDir): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' })
  }

  /** Every path under `dir`, relative and sorted — a fingerprint of a tree. */
  function treeListing(dir: string): string[] {
    const out: string[] = []
    const visit = (current: string) => {
      let entries: string[]
      try {
        entries = readdirSync(current)
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(current, entry)
        out.push(path.relative(dir, full))
        if (statSync(full).isDirectory()) visit(full)
      }
    }
    visit(dir)
    return out.sort()
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-lab-law-test-'))
    repoDir = path.join(root, 'repo')
    dataRoot = path.join(root, 'data')
    claudeProjectsRoot = path.join(root, 'claude-projects')

    await mkdir(repoDir, { recursive: true })
    git(['init', '-b', 'main'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    await writeFile(path.join(repoDir, 'tracked.txt'), 'v1\n')
    git(['add', '.'])
    git(['commit', '-m', 'initial commit'])
    await writeFile(path.join(repoDir, 'tracked.txt'), 'v2 dirty\n')
    await writeFile(path.join(repoDir, 'untracked.txt'), 'new\n')

    const projectDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(repoDir))
    await mkdir(projectDir, { recursive: true })
    const sessionId = randomUUID()
    await writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      `${JSON.stringify({ type: 'user', sessionId, cwd: repoDir })}\n`,
    )
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function forkThreeArms(): Promise<void> {
    await captureCheckpoint({
      lane: 'law-lane',
      worktreePath: repoDir,
      capturedBy: 'operator',
      exec: realExec,
      dataRoot,
      claudeProjectsRoot,
      now: () => 1_000_000,
      checkpointId: `ckpt-${process.pid}-${randomUUID()}`,
    })
    await dispatchFork({
      parentLane: 'law-lane',
      parentWorktreePath: repoDir,
      arms: 3,
      forkId: `fork-${process.pid}-${randomUUID()}`,
      dataRoot,
      claudeProjectsRoot,
      exec: realExec,
      install: false,
      now: () => 1_000_100,
    })
  }

  it('leaves the watched repo\'s working tree byte-for-byte as it found it', async () => {
    const before = git(['status', '--porcelain'])
    const listingBefore = treeListing(repoDir).filter((entry) => !entry.startsWith('.git'))

    await forkThreeArms()

    expect(git(['status', '--porcelain'])).toBe(before)
    expect(treeListing(repoDir).filter((entry) => !entry.startsWith('.git'))).toEqual(listingBefore)
  })

  it('creates refs ONLY under refs/rhizomorph/ — no branch, no tag, no remote ref', async () => {
    const branchesBefore = git(['for-each-ref', '--format=%(refname)', 'refs/heads/'])

    await forkThreeArms()

    expect(git(['for-each-ref', '--format=%(refname)', 'refs/heads/'])).toBe(branchesBefore)
    const all = git(['for-each-ref', '--format=%(refname)'])
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    const foreign = all.filter((ref) => !ref.startsWith('refs/rhizomorph/') && ref !== 'refs/heads/main')
    expect(foreign).toEqual([])
  })

  it('creates worktrees ONLY under the lab data dir', async () => {
    await forkThreeArms()

    const registered = git(['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim())

    const outside = registered.filter(
      (worktree) => path.resolve(worktree) !== path.resolve(repoDir) && !isInside(labRoot(dataRoot), worktree),
    )
    expect(outside).toEqual([])
  })

  /**
   * Ruling 1's four namespaces, as path predicates over the whole temp root.
   *
   * The third clause is the one that needs saying out loud: a ref under
   * `refs/rhizomorph/` and a worktree the lab created are BOTH things git
   * records inside the watched repo's `.git` directory — the ref file itself,
   * the objects it reaches, and a `worktrees/<id>/` bookkeeping dir. Ruling 1
   * grants those explicitly ("refs under `refs/rhizomorph/`, git objects those
   * refs require, worktrees the lab itself creates"), so the law allows the
   * `.git` administrivia they consist of and NOTHING else in the repo. The
   * working tree is covered separately, and absolutely, by the test above.
   */
  function isAllowedWrite(relative: string): boolean {
    const parts = relative.split(path.sep)
    if (parts[0] === 'data' || parts[0] === 'claude-projects') return true
    if (parts[0] !== 'repo') return false
    if (parts[1] !== '.git') return false // never the working tree

    const inGit = parts.slice(2).join('/')
    return (
      inGit === '' ||
      inGit === 'refs' ||
      inGit.startsWith('refs/rhizomorph') ||
      inGit === 'objects' ||
      inGit.startsWith('objects/') ||
      inGit === 'worktrees' ||
      inGit.startsWith('worktrees/')
    )
  }

  it('writes ONLY into ruling 1\'s namespaces — lab data dir, session artifacts, refs/rhizomorph, its own worktrees', async () => {
    const rootListingBefore = new Set(treeListing(root))

    await forkThreeArms()

    const added = treeListing(root).filter((entry) => !rootListingBefore.has(entry))
    expect(added.length).toBeGreaterThan(0) // the check below would pass vacuously otherwise

    expect(added.filter((entry) => !isAllowedWrite(entry))).toEqual([])
  })

  it('that fence bites — a write to any other path in the repo would be caught', () => {
    expect(isAllowedWrite(path.join('repo', 'notes.md'))).toBe(false)
    expect(isAllowedWrite(path.join('repo', '.git', 'refs', 'heads', 'sneaky'))).toBe(false)
    expect(isAllowedWrite(path.join('repo', '.git', 'config'))).toBe(false)
    expect(isAllowedWrite(path.join('somewhere-else', 'x'))).toBe(false)
    // …and does not fire on the three the ruling grants.
    expect(isAllowedWrite(path.join('repo', '.git', 'refs', 'rhizomorph', 'checkpoints', 'c1'))).toBe(true)
    expect(isAllowedWrite(path.join('repo', '.git', 'worktrees', 'fork-1-arm-1', 'HEAD'))).toBe(true)
    expect(isAllowedWrite(path.join('data', 'lab', 'worktrees', 'fork-1-arm-1'))).toBe(true)
  })

  it('writes the synthesized sessions ONLY under the arms\' own project slugs, never the parent\'s', async () => {
    const parentSlug = worktreePathToProjectSlug(repoDir)
    const parentDir = path.join(claudeProjectsRoot, parentSlug)
    const parentBefore = treeListing(parentDir)

    await forkThreeArms()

    expect(treeListing(parentDir)).toEqual(parentBefore)
    // And three new project dirs appeared, one per arm, all under the lab root.
    const slugs = readdirSync(claudeProjectsRoot).filter((slug) => slug !== parentSlug)
    expect(slugs).toHaveLength(3)
    for (const slug of slugs) {
      expect(slug.startsWith(worktreePathToProjectSlug(labRoot(dataRoot)))).toBe(true)
    }
  })
})
