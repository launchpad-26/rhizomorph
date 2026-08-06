import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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

/**
 * A stricter cousin of {@link targetsLab}, for the web-side check only:
 * rather than a path-text guess, this resolves a specifier against the file
 * that wrote it and asks whether the result actually lands inside the
 * SERVER's laboratory module (`LAB_DIR`). prd14 gave web its own, unrelated
 * directory of the same name (`packages/web/src/lab/`, the experiment
 * console) — `targetsLab`'s text-only heuristic cannot tell that apart from
 * the server's engine, and a check that can't tell them apart would forbid
 * the very console prd14 blesses. Resolving the path is strictly MORE
 * rigorous than the text guess it replaces here, not less: it still catches
 * every real reach into `LAB_DIR` (a long relative escape out of `web/`, for
 * instance), and it stops flagging a same-named sibling that was never the
 * server's engine to begin with. Bare/package specifiers never resolve this
 * way and are treated as a miss — the lab module publishes no package name
 * for web to import in the first place, so the only real way in is a
 * relative path, which this still catches in full.
 */
function resolvesIntoServerLab(specifier: string, fromFile: string): boolean {
  if (!specifier.startsWith('.')) return false
  const resolved = path.resolve(path.dirname(fromFile), specifier)
  return resolved === LAB_DIR || resolved.startsWith(LAB_DIR + path.sep)
}

/** The specifiers in one file's text that actually resolve into the SERVER's lab module — see {@link resolvesIntoServerLab}. */
function findServerLabImports(source: string, fromFile: string): string[] {
  return importSpecifiers(source).filter((specifier) => resolvesIntoServerLab(specifier, fromFile))
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

    it('no web source file imports from the SERVER\'s lab module', () => {
      const files = walkSourceFiles(WEB_SRC)
      const violations = files
        .map((file) => ({
          file: path.relative(REPO_ROOT, file),
          specifiers: findServerLabImports(readFileSync(file, 'utf8'), file),
        }))
        .filter((entry) => entry.specifiers.length > 0)

      expect(violations).toEqual([])
    })

    it('the resolved detector bites on a real cross-package reach, and does not confuse web\'s own lab/ console for the server\'s engine', () => {
      const fakeWebFile = path.join(WEB_SRC, 'App.tsx')

      // A real violation: escaping out of `web/src` into the server's engine.
      expect(
        findServerLabImports(`import { compareFork } from '../../server/src/lab/compare.js'\n`, fakeWebFile),
      ).toEqual(['../../server/src/lab/compare.js'])

      // Not a violation: prd14's own web console, a same-named sibling directory
      // that has nothing to do with `packages/server/src/lab/`.
      expect(findServerLabImports(`import { LabPage } from './lab/index.js'\n`, fakeWebFile)).toEqual([])
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

/**
 * #217/#227: the macOS CI leg failed the "creates worktrees ONLY under the
 * lab data dir" test above on its first `main` run, macOS only. macOS's
 * `TMPDIR` lives under `/var/folders/…`, itself a symlink to
 * `/private/var/folders/…`; `git worktree add` canonicalizes the path it is
 * given and reports the REAL spelling back on `git worktree list`
 * (confirmed on Linux — no macOS needed — by pointing `git worktree add` at
 * a path through a symlinked directory and reading `git worktree list
 * --porcelain` back). A containment check comparing raw path prefixes sees
 * the worktree at one spelling and the lab root at the other and reports an
 * escape that never happened.
 *
 * This block is that exact reproduction, wired through the real `dataRoot`
 * every fork dispatch is given — not a unit test of `isInside` in isolation
 * (that lives in `paths.test.ts`), but the same live end-to-end path the CI
 * failure actually exercised, with `dataRoot` now reached through a symlink.
 * It must pass with `paths.ts`'s `canonicalize` fix and would fail without
 * it — see `paths.test.ts` for the direct proof of that on `isInside` alone.
 */
describe('the lab namespace law, live, with the lab data dir behind a symlink (macOS shape, #217/#227)', () => {
  let root: string
  let repoDir: string
  let realDataRoot: string
  let dataRoot: string
  let claudeProjectsRoot: string

  function git(args: string[], cwd = repoDir): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' })
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-lab-law-symlink-test-'))
    repoDir = path.join(root, 'repo')
    realDataRoot = path.join(root, 'real-data')
    dataRoot = path.join(root, 'data-link') // the spelling the lab is handed — TMPDIR's role on macOS
    claudeProjectsRoot = path.join(root, 'claude-projects')

    await mkdir(repoDir, { recursive: true })
    git(['init', '-b', 'main'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    await writeFile(path.join(repoDir, 'tracked.txt'), 'v1\n')
    git(['add', '.'])
    git(['commit', '-m', 'initial commit'])
    await writeFile(path.join(repoDir, 'tracked.txt'), 'v2 dirty\n')

    await mkdir(realDataRoot, { recursive: true })
    await symlink(realDataRoot, dataRoot)

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

  it('creates worktrees ONLY under the lab data dir, even though dataRoot is reached through a symlink', async () => {
    await captureCheckpoint({
      lane: 'symlink-lane',
      worktreePath: repoDir,
      capturedBy: 'operator',
      exec: realExec,
      dataRoot,
      claudeProjectsRoot,
      now: () => 1_000_000,
      checkpointId: `ckpt-${process.pid}-${randomUUID()}`,
    })
    await dispatchFork({
      parentLane: 'symlink-lane',
      parentWorktreePath: repoDir,
      arms: 3,
      forkId: `fork-${process.pid}-${randomUUID()}`,
      dataRoot,
      claudeProjectsRoot,
      exec: realExec,
      install: false,
      now: () => 1_000_100,
    })

    const registered = git(['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim())

    // At least one arm's worktree must actually have round-tripped through
    // git at the OTHER spelling from what `dataRoot` names — otherwise this
    // test would pass vacuously on any machine where `git worktree add`
    // happens not to canonicalize.
    expect(registered.some((worktree) => worktree.startsWith(realDataRoot))).toBe(true)

    const outside = registered.filter(
      (worktree) => path.resolve(worktree) !== path.resolve(repoDir) && !isInside(labRoot(dataRoot), worktree),
    )
    expect(outside).toEqual([])
  })
})
