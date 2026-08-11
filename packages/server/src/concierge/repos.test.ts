import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type DiscoveryFs,
  type SubdirectoryListing,
  discoverRepos,
  listKnownProjects,
  realDiscoveryFs,
  reverseProjectSlug,
  scanCommonRoots,
} from './repos.js'

/**
 * An in-memory `DiscoveryFs`. `tree[dir]` is the list of real (non-symlink)
 * subdirectory names directly inside `dir` — absent from the map means "this
 * directory does not exist," which `listSubdirectories` reports as
 * `readable: true, entries: []` (matching real `ENOENT` behaviour: every
 * call site in the module only ever lists a path it already confirmed
 * exists, or a *candidate* name that may honestly not be there).
 *
 * `gitPaths` marks a `.git` path as PRESENT without saying whether it is a
 * file or a directory — exactly the ambiguity `fs.exists` itself is
 * indifferent to, and exactly why `scanCommonRoots` checks existence rather
 * than looking for `.git` inside a directory listing. `unreadableDirs` marks
 * a directory that EXISTS but cannot be read (permission denied) — a
 * genuinely different outcome from "does not exist," and the one this
 * fixture must be able to express on its own, not conflate with absence.
 *
 * Both operations return already-resolved Promises — a real `DiscoveryFs`
 * always genuinely awaits (`node:fs/promises`), but a fixture has nothing to
 * wait ON, and a test `await`ing a fixture call is still exercising the same
 * async call sites the real filesystem seam goes through.
 */
function fixtureFs(
  tree: Record<string, string[]>,
  options: { gitPaths?: ReadonlySet<string>; unreadableDirs?: ReadonlySet<string> } = {},
): DiscoveryFs {
  const gitPaths = options.gitPaths ?? new Set<string>()
  const unreadableDirs = options.unreadableDirs ?? new Set<string>()
  return {
    exists: async (target) => target in tree || gitPaths.has(target),
    listSubdirectories: async (dir): Promise<SubdirectoryListing> => {
      if (unreadableDirs.has(dir)) return { readable: false, reason: `permission denied reading ${dir}` }
      return { readable: true, entries: tree[dir] ?? [] }
    },
  }
}

describe('reverseProjectSlug', () => {
  it('resolves a simple absolute-path slug by walking real directory entries', async () => {
    const fs = fixtureFs({
      '/': ['Users'],
      '/Users': ['hannah'],
      '/Users/operator': ['repo'],
      '/Users/operator/repo': [],
    })

    expect(await reverseProjectSlug('-Users-operator-repo', fs)).toEqual({
      path: path.join('/', 'Users', 'hannah', 'repo'),
    })
  })

  it('resolves the root itself', async () => {
    const fs = fixtureFs({ '/': [] })
    expect(await reverseProjectSlug('-', fs)).toEqual({ path: path.sep })
  })

  it('resolves a slug through a DOTTED directory name — the #243 gap the forward transform misses', async () => {
    // worktree-slug.ts's forward transform only maps `/` and `_` to `-`; Claude
    // Code's real transform also maps `.`. This reverses by matching the real
    // entry `v2.0` (encoded `v2-0`) against the slug, so the dot never needs to
    // be guessed at — it is read off the filesystem instead.
    const fs = fixtureFs({
      '/': ['Users'],
      '/Users': ['hannah'],
      '/Users/operator': ['v2.0'],
      '/Users/operator/v2.0': ['wt'],
      '/Users/operator/v2.0/wt': [],
    })

    expect(await reverseProjectSlug('-Users-operator-v2-0-wt', fs)).toEqual({
      path: path.join('/', 'Users', 'hannah', 'v2.0', 'wt'),
    })
  })

  it('resolves a slug through a directory name with a literal SPACE — found by running this against a real machine, not in #243\'s own list', async () => {
    // Claude Code's slug transform maps a literal space to `-` too, alongside
    // `/`, `_`, and `.` — confirmed against this machine's own
    // `~/.claude/projects` during development (`ASK JO/askjo`, `TailR
    // Nutrition/tailr-codebase`), where every slug through one of these
    // directories was, before this test existed, honestly-but-wrongly
    // reported unresolved.
    const fs = fixtureFs({
      '/': ['Users'],
      '/Users': ['hannah'],
      '/Users/operator': ['TailR Nutrition'],
      '/Users/operator/TailR Nutrition': ['tailr-codebase'],
      '/Users/operator/TailR Nutrition/tailr-codebase': [],
    })

    expect(await reverseProjectSlug('-Users-operator-TailR-Nutrition-tailr-codebase', fs)).toEqual({
      path: path.join('/', 'Users', 'hannah', 'TailR Nutrition', 'tailr-codebase'),
    })
  })

  it('resolves the exact example from worktree-slug.ts\'s own doc comment — double underscore and a literal dash together', async () => {
    const fs = fixtureFs({
      '/': ['home'],
      '/home': ['lachlan'],
      '/home/operator': ['worktrees-challenge__worktrees'],
      '/home/operator/worktrees-challenge__worktrees': ['2-core'],
      '/home/operator/worktrees-challenge__worktrees/2-core': [],
    })

    expect(await reverseProjectSlug('-home-operator-worktrees-challenge--worktrees-2-core', fs)).toEqual({
      path: path.join('/', 'home', 'lachlan', 'worktrees-challenge__worktrees', '2-core'),
    })
  })

  it('prefers the LONGEST matching entry at a fork, which is what lets an otherwise-dead-end slug resolve', async () => {
    // At /x, both "a" and "a-b" match the next stretch of the slug. Only
    // "a-b" leads anywhere real ("/x/a" has no subdirectories at all) — so
    // greedy-shortest-first would dead-end here, and greedy-longest is what
    // makes the walk succeed.
    const fs = fixtureFs({
      '/': ['x'],
      '/x': ['a', 'a-b'],
      '/x/a-b': ['c'],
    })

    expect(await reverseProjectSlug('-x-a-b-c', fs)).toEqual({ path: path.join('/', 'x', 'a-b', 'c') })
  })

  it('reports an AMBIGUOUS slug as ambiguous, naming both candidates, rather than silently picking whichever readdir enumerated first', async () => {
    // "foo-bar" and "foo.bar" both encode to "foo-bar" — nothing about the
    // slug says which real directory Claude Code meant. Guessing (by
    // whatever order the entries happen to come back in) would be a silent
    // wrong answer exactly half the time; this module's whole contract is
    // "unknown is not absent," so the tie itself must be reported.
    const fs = fixtureFs({
      '/': ['Users'],
      '/Users': ['hannah'],
      '/Users/operator': ['foo-bar', 'foo.bar'],
    })

    const result = await reverseProjectSlug('-Users-operator-foo-bar', fs)
    expect(result.path).toBeNull()
    const reason = (result as { reason: string }).reason
    expect(reason).toContain('ambiguous')
    expect(reason).toContain('foo-bar')
    expect(reason).toContain('foo.bar')
  })

  it('does NOT report ambiguity when a longer match strictly dominates a shorter tie', async () => {
    // "a" and "b" both encode to themselves and both match the first
    // segment, and taken alone at THAT length they'd tie — but "a-c" is a
    // longer match that wins outright, so the shorter tie never mattered and
    // must not surface as a false ambiguity.
    const fs = fixtureFs({
      '/': ['x'],
      '/x': ['a', 'b', 'a-c'],
      '/x/a-c': [],
    })

    expect(await reverseProjectSlug('-x-a-c', fs)).toEqual({ path: path.join('/', 'x', 'a-c') })
  })

  it('reports unresolved, honestly, with a reason naming where the walk stopped — never silently dropped', async () => {
    const fs = fixtureFs({
      '/': ['Users'],
      '/Users': ['hannah'],
      // '/Users/operator' has no 'ghost' subdirectory.
      '/Users/operator': ['repo'],
    })

    const result = await reverseProjectSlug('-Users-operator-ghost', fs)
    expect(result.path).toBeNull()
    expect((result as { reason: string }).reason).toContain(path.join('/', 'Users', 'hannah'))
  })

  it('reports unresolved for a slug that does not start with "-" rather than guessing a relative path', async () => {
    const result = await reverseProjectSlug('not-an-absolute-slug', fixtureFs({}))
    expect(result.path).toBeNull()
    expect((result as { reason: string }).reason).toContain('does not start with "-"')
  })

  it('names the Windows drive-rooted shape truthfully instead of just saying "not a slug for an absolute path"', async () => {
    // Claude Code's own project directory for a native-Windows session is
    // e.g. "C--Users-operator-agenticlaunchpad" — the generic "does not start
    // with -" reason would be false for this shape specifically, since it IS
    // a Claude Code slug, just a drive-rooted one this walk does not resolve.
    const result = await reverseProjectSlug('C--Users-operator-agenticlaunchpad', fixtureFs({}))
    expect(result.path).toBeNull()
    const reason = (result as { reason: string }).reason
    expect(reason).toContain('Windows')
    expect(reason).not.toContain('is not a slug for an absolute path')
  })

  it('reports an unreadable directory mid-walk honestly, not as "no directory matches"', async () => {
    const fs = fixtureFs(
      {
        '/': ['Users'],
        '/Users': ['hannah'],
        '/Users/operator': ['blocked'],
      },
      { unreadableDirs: new Set([path.join('/', 'Users', 'hannah', 'blocked')]) },
    )

    const result = await reverseProjectSlug('-Users-operator-blocked-repo', fs)
    expect(result.path).toBeNull()
    const reason = (result as { reason: string }).reason
    expect(reason).toContain('permission denied')
    expect(reason).not.toContain('no directory under')
  })
})

describe('listKnownProjects', () => {
  it('reports available: false, honestly, when ~/.claude/projects does not exist yet', async () => {
    const result = await listKnownProjects('/home/x/.claude/projects', fixtureFs({}))
    expect(result).toEqual({
      available: false,
      reason: expect.stringContaining(path.join('/home/x/.claude/projects')),
    })
  })

  it('lists every slug, resolved and unresolved side by side — an unresolvable slug still appears', async () => {
    const fs = fixtureFs({
      '/home/x/.claude/projects': ['-home-x-repo', '-home-x-ghost'],
      '/': ['home'],
      '/home': ['x'],
      '/home/x': ['repo'],
      '/home/x/repo': [],
    })

    const result = await listKnownProjects('/home/x/.claude/projects', fs)
    expect(result.available).toBe(true)
    const projects = (result as { available: true; projects: unknown[] }).projects
    expect(projects).toEqual([
      { slug: '-home-x-repo', path: path.join('/', 'home', 'x', 'repo'), resolved: true },
      {
        slug: '-home-x-ghost',
        path: null,
        resolved: false,
        reason: expect.stringContaining('ghost') as unknown as string,
      },
    ])
  })

  it('returns an empty list, not an error, when the root exists but has no project slugs yet', async () => {
    const fs = fixtureFs({ '/home/x/.claude/projects': [] })
    expect(await listKnownProjects('/home/x/.claude/projects', fs)).toEqual({ available: true, projects: [] })
  })

  it('reads a shared ancestor directory only ONCE across sibling slugs, not once per slug', async () => {
    // Two slugs under /Users/operator/… each independently walk /, /Users, and
    // /Users/operator from scratch — without a shared cache, a projects root
    // with N slugs re-reads those same shallow ancestors N times over.
    const base = fixtureFs({
      '/home/x/.claude/projects': ['-Users-operator-repo1', '-Users-operator-repo2'],
      '/': ['Users'],
      '/Users': ['hannah'],
      '/Users/operator': ['repo1', 'repo2'],
      '/Users/operator/repo1': [],
      '/Users/operator/repo2': [],
    })
    let listCalls = 0
    const countingFs: DiscoveryFs = {
      exists: base.exists,
      listSubdirectories: async (dir) => {
        listCalls += 1
        return base.listSubdirectories(dir)
      },
    }

    const result = await listKnownProjects('/home/x/.claude/projects', countingFs)

    expect(result.available).toBe(true)
    // 1 for the projects root itself, plus /, /Users, /Users/operator — each
    // exactly once, however many slugs share them. Uncached, the two
    // sibling walks alone would cost 6 (3 ancestors × 2 slugs) on top of that.
    expect(listCalls).toBe(4)
  })

  it('reports available: false with an honest "could not read" reason for an existing-but-unreadable root — never a silent empty list', async () => {
    const root = path.join('/home', 'x', '.claude', 'projects')
    const fs = fixtureFs({ [root]: [] }, { unreadableDirs: new Set([root]) })

    const result = await listKnownProjects(root, fs)
    expect(result).toEqual({ available: false, reason: expect.stringContaining('permission denied') })
    // Must not read as "Claude has no history here" — the false reading this finding is about.
    expect((result as { reason: string }).reason).not.toContain('nothing to enumerate yet')
  })
})

describe('scanCommonRoots', () => {
  it('finds a repo sitting directly under a common root', async () => {
    const fs = fixtureFs(
      { '/home/x': ['code'], '/home/x/code': ['repo1'] },
      { gitPaths: new Set([path.join('/home/x/code/repo1', '.git')]) },
    )

    const result = await scanCommonRoots('/home/x', fs)
    expect(result).toEqual({ repos: [{ path: path.join('/home/x/code/repo1') }], truncated: false, unreadable: [] })
  })

  it('finds a repo nested one level deeper — the org/repo shape — within the default depth', async () => {
    const fs = fixtureFs(
      { '/home/x': ['code'], '/home/x/code': ['org'], '/home/x/code/org': ['repo2'] },
      { gitPaths: new Set([path.join('/home/x/code/org/repo2', '.git')]) },
    )

    const result = await scanCommonRoots('/home/x', fs)
    expect(result.repos).toEqual([{ path: path.join('/home/x/code/org/repo2') }])
  })

  it('does not descend past the default depth — a repo three levels below a common root is missed, not found', async () => {
    const fs = fixtureFs(
      {
        '/home/x': ['code'],
        '/home/x/code': ['a'],
        '/home/x/code/a': ['b'],
        '/home/x/code/a/b': ['repo'],
      },
      { gitPaths: new Set([path.join('/home/x/code/a/b/repo', '.git')]) },
    )

    expect((await scanCommonRoots('/home/x', fs)).repos).toEqual([])
  })

  it('never descends into a skipped directory name, even one that looks like it might hide a repo', async () => {
    const fs = fixtureFs(
      { '/home/x': ['code'], '/home/x/code': ['node_modules'], '/home/x/code/node_modules': ['pkg'] },
      { gitPaths: new Set([path.join('/home/x/code/node_modules/pkg', '.git')]) },
    )

    expect((await scanCommonRoots('/home/x', fs)).repos).toEqual([])
  })

  it('never descends into a hidden (dot-prefixed) directory', async () => {
    const fs = fixtureFs(
      { '/home/x': ['code'], '/home/x/code': ['.hidden'] },
      { gitPaths: new Set([path.join('/home/x/code/.hidden', '.git')]) },
    )

    expect((await scanCommonRoots('/home/x', fs)).repos).toEqual([])
  })

  it('does not scan a repo\'s own internals once it is found — a nested .git inside a found repo is invisible', async () => {
    const fs = fixtureFs(
      { '/home/x': ['code'], '/home/x/code': ['repo3'], '/home/x/code/repo3': ['nested'] },
      {
        gitPaths: new Set([
          path.join('/home/x/code/repo3', '.git'),
          path.join('/home/x/code/repo3/nested', '.git'),
        ]),
      },
    )

    expect((await scanCommonRoots('/home/x', fs)).repos).toEqual([{ path: path.join('/home/x/code/repo3') }])
  })

  it('recognises a LINKED git worktree as a repo — its .git is a FILE, which a directory-listing check can never see', async () => {
    // The exact bug: a worktree's `.git` never appears as a subdirectory NAME
    // (it isn't one), so a check that looks for '.git' inside a directory
    // listing walks straight past it. Modeled here with `.git` present via
    // `gitPaths` alone — never listed as an entry of the parent — so a
    // regression back to "check entries.includes('.git')" fails this test.
    const fs = fixtureFs(
      { '/home/x': ['code'], '/home/x/code': ['linked-worktree'] },
      { gitPaths: new Set([path.join('/home/x/code/linked-worktree', '.git')]) },
    )

    expect((await scanCommonRoots('/home/x', fs)).repos).toEqual([{ path: path.join('/home/x/code/linked-worktree') }])
  })

  it('is bounded by maxDirsVisited and reports truncated: true rather than a silently partial list', async () => {
    // None of a/b/c/homeDir/code are repos, so each one visited costs a
    // metered `readSubdirs` call — a found repo would return before ever
    // calling it, so this needs genuine non-repo directories to spend the
    // budget, not repos that would short-circuit for free.
    const fs = fixtureFs({
      '/home/x': ['code'],
      '/home/x/code': ['a', 'b', 'c'],
      '/home/x/code/a': [],
      '/home/x/code/b': [],
      '/home/x/code/c': [],
    })

    const result = await scanCommonRoots('/home/x', fs, { maxDirsVisited: 2 })
    expect(result.truncated).toBe(true)
  })

  it('a common root that does not exist on this machine is simply skipped, not an error', async () => {
    expect(await scanCommonRoots('/home/nobody-has-any-of-these-dirs', fixtureFs({}))).toEqual({
      repos: [],
      truncated: false,
      unreadable: [],
    })
  })

  it('records an unreadable directory in `unreadable`, distinct from truncation — a genuinely empty root is not the same as a refused one', async () => {
    const blockedDir = path.join('/home/x/code', 'blocked')
    const fs = fixtureFs(
      { '/home/x': ['code'], '/home/x/code': ['blocked'] },
      { unreadableDirs: new Set([blockedDir]) },
    )

    const result = await scanCommonRoots('/home/x', fs)
    expect(result).toEqual({ repos: [], truncated: false, unreadable: [blockedDir] })
  })

  it('records an unreadable homeDir itself, rather than reporting "nothing found" indistinguishably from a genuinely empty home', async () => {
    const fs = fixtureFs({}, { unreadableDirs: new Set(['/home/x']) })
    expect(await scanCommonRoots('/home/x', fs)).toEqual({ repos: [], truncated: false, unreadable: ['/home/x'] })
  })
})

describe('discoverRepos', () => {
  it('assembles the known-projects reversal and the common-roots scan into one result', async () => {
    const fs = fixtureFs(
      {
        '/': ['home'],
        '/home': ['x'],
        '/home/x/.claude/projects': ['-home-x-known'],
        '/home/x': ['known', 'code'],
        '/home/x/known': [],
        '/home/x/code': ['scanned'],
      },
      { gitPaths: new Set([path.join('/home/x/code/scanned', '.git')]) },
    )

    const result = await discoverRepos({ homeDir: '/home/x', fs })

    expect(result.known).toEqual({
      available: true,
      projects: [{ slug: '-home-x-known', path: path.join('/home/x/known'), resolved: true }],
    })
    expect(result.scanned).toEqual({
      repos: [{ path: path.join('/home/x/code/scanned') }],
      truncated: false,
      unreadable: [],
    })
  })

  it('derives claudeProjectsRoot from the given homeDir when not given explicitly, rather than reaching for the real machine\'s', async () => {
    const fs = fixtureFs({ '/home/x/.claude/projects': [] })
    const result = await discoverRepos({ homeDir: '/home/x', fs })
    expect(result.known).toEqual({ available: true, projects: [] })
  })

  it('does not deduplicate a repo Claude already knows against the scan finding it too — that is the picker\'s call, not this module\'s', async () => {
    const fs = fixtureFs(
      {
        '/': ['home'],
        '/home': ['x'],
        '/home/x/.claude/projects': ['-home-x-code-same-repo'],
        '/home/x': ['code'],
        '/home/x/code': ['same-repo'],
      },
      { gitPaths: new Set([path.join('/home/x/code/same-repo', '.git')]) },
    )

    const result = await discoverRepos({ homeDir: '/home/x', fs })

    expect((result.known as { available: true; projects: Array<{ path: string | null }> }).projects[0]?.path).toBe(
      path.join('/home/x/code/same-repo'),
    )
    expect(result.scanned.repos).toEqual([{ path: path.join('/home/x/code/same-repo') }])
  })
})

const isPosix = platform() !== 'win32'
const isRoot = isPosix && typeof process.getuid === 'function' && process.getuid() === 0

/**
 * `realDiscoveryFs` against a REAL filesystem — the things a fixture map
 * can never prove: that a symlink is genuinely excluded by the OS-level
 * `Dirent` this module reads (not just by a fixture that never had one),
 * that a REAL linked git worktree's `.git` file is recognised, and that a
 * REAL permission-denied directory is reported as unreadable rather than
 * empty. Mirrors `concierge/namespace-law.test.ts`'s own "live" section.
 */
describe('realDiscoveryFs, live', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-repos-discovery-test-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('lists a real directory, not a symlink pointing at one', async () => {
    const realDir = path.join(root, 'real-dir')
    await mkdir(realDir)
    await symlink(realDir, path.join(root, 'link-to-real-dir'))

    const listing = await realDiscoveryFs.listSubdirectories(root)
    expect(listing.readable && listing.entries.sort()).toEqual(['real-dir'])
  })

  it('a symlinked common root is therefore never scanned into, even if it points at a directory full of repos', async () => {
    const outsideRepo = path.join(root, 'outside', 'someones-repo')
    await mkdir(path.join(outsideRepo, '.git'), { recursive: true })
    await mkdir(path.join(root, 'home'))
    await symlink(path.join(root, 'outside'), path.join(root, 'home', 'code'))

    const result = await scanCommonRoots(path.join(root, 'home'), realDiscoveryFs)
    expect(result.repos).toEqual([])
  })

  it('exists() follows symlinks for the claudeProjectsRoot existence check, matching checkClaudeProjects\' own existsSync', async () => {
    const realProjects = path.join(root, 'real-projects')
    await mkdir(realProjects)
    const linked = path.join(root, 'linked-projects')
    await symlink(realProjects, linked)

    expect(await realDiscoveryFs.exists(linked)).toBe(true)
  })

  it.runIf(isPosix)('detects a REAL linked git worktree as a repo — its .git is a git-worktree-add-shaped FILE', async () => {
    const mainRepo = path.join(root, 'main-repo')
    execFileSync('git', ['init', '-q', mainRepo])
    execFileSync('git', ['-C', mainRepo, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', mainRepo, 'config', 'user.name', 'Test'])
    execFileSync('git', ['-C', mainRepo, 'commit', '-q', '--allow-empty', '-m', 'init'])

    const codeDir = path.join(root, 'home', 'code')
    mkdirSync(codeDir, { recursive: true })
    const worktreePath = path.join(codeDir, 'linked-worktree')
    execFileSync('git', ['-C', mainRepo, 'worktree', 'add', '-q', worktreePath, '-b', 'wt-branch'])

    // The fixture proves what it claims: a FILE, not a directory, unlike an
    // ordinary clone's `.git`.
    expect(statSync(path.join(worktreePath, '.git')).isFile()).toBe(true)

    const result = await scanCommonRoots(path.join(root, 'home'), realDiscoveryFs)
    expect(result.repos).toEqual([{ path: worktreePath }])
  })

  it.runIf(isPosix && !isRoot)('reports a REAL permission-denied directory as unreadable, not as empty', async () => {
    const blocked = path.join(root, 'blocked')
    await mkdir(blocked)
    await chmod(blocked, 0o000)

    try {
      const listing = await realDiscoveryFs.listSubdirectories(blocked)
      expect(listing.readable).toBe(false)
      if (!listing.readable) expect(listing.reason).toContain(blocked)
    } finally {
      await chmod(blocked, 0o755)
    }
  })

  it.runIf(isPosix && !isRoot)('carries that same permission-denied directory through scanCommonRoots as `unreadable`, not silently as empty', async () => {
    await mkdir(path.join(root, 'home'))
    const blocked = path.join(root, 'home', 'code')
    await mkdir(blocked)
    await chmod(blocked, 0o000)

    try {
      const result = await scanCommonRoots(path.join(root, 'home'), realDiscoveryFs)
      expect(result.repos).toEqual([])
      expect(result.unreadable).toContain(blocked)
    } finally {
      await chmod(blocked, 0o755)
    }
  })
})
