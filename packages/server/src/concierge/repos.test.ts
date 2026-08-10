import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type DiscoveryFs,
  discoverRepos,
  listKnownProjects,
  realDiscoveryFs,
  reverseProjectSlug,
  scanCommonRoots,
} from './repos.js'

/**
 * An in-memory `DiscoveryFs`: `tree[dir]` is the list of real (non-symlink)
 * subdirectory names directly inside `dir`. Absent from the map means "not
 * a directory here" — the same honest `[]` a real, unreadable directory
 * would produce, so tests never need to distinguish "doesn't exist" from
 * "exists but empty" unless a test is specifically about that.
 */
function fixtureFs(tree: Record<string, string[]>): DiscoveryFs {
  return {
    exists: (target) => target in tree,
    listSubdirectories: (dir) => tree[dir] ?? [],
  }
}

describe('reverseProjectSlug', () => {
  it('resolves a simple absolute-path slug by walking real directory entries', () => {
    const fs = fixtureFs({
      '/': ['Users'],
      '/Users': ['hannah'],
      '/Users/operator': ['repo'],
      '/Users/operator/repo': [],
    })

    expect(reverseProjectSlug('-Users-operator-repo', fs)).toEqual({ path: path.join('/', 'Users', 'hannah', 'repo') })
  })

  it('resolves the root itself', () => {
    const fs = fixtureFs({ '/': [] })
    expect(reverseProjectSlug('-', fs)).toEqual({ path: path.sep })
  })

  it('resolves a slug through a DOTTED directory name — the #243 gap the forward transform misses', () => {
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

    expect(reverseProjectSlug('-Users-operator-v2-0-wt', fs)).toEqual({
      path: path.join('/', 'Users', 'hannah', 'v2.0', 'wt'),
    })
  })

  it('resolves the exact example from worktree-slug.ts\'s own doc comment — double underscore and a literal dash together', () => {
    const fs = fixtureFs({
      '/': ['home'],
      '/home': ['lachlan'],
      '/home/operator': ['worktrees-challenge__worktrees'],
      '/home/operator/worktrees-challenge__worktrees': ['2-core'],
      '/home/operator/worktrees-challenge__worktrees/2-core': [],
    })

    expect(reverseProjectSlug('-home-operator-worktrees-challenge--worktrees-2-core', fs)).toEqual({
      path: path.join('/', 'home', 'lachlan', 'worktrees-challenge__worktrees', '2-core'),
    })
  })

  it('prefers the LONGEST matching entry at a fork, which is what lets an otherwise-dead-end slug resolve', () => {
    // At /x, both "a" and "a-b" match the next stretch of the slug. Only
    // "a-b" leads anywhere real ("/x/a" has no subdirectories at all) — so
    // greedy-shortest-first would dead-end here, and greedy-longest is what
    // makes the walk succeed.
    const fs = fixtureFs({
      '/': ['x'],
      '/x': ['a', 'a-b'],
      '/x/a-b': ['c'],
    })

    expect(reverseProjectSlug('-x-a-b-c', fs)).toEqual({ path: path.join('/', 'x', 'a-b', 'c') })
  })

  it('reports unresolved, honestly, with a reason naming where the walk stopped — never silently dropped', () => {
    const fs = fixtureFs({
      '/': ['Users'],
      '/Users': ['hannah'],
      // '/Users/operator' has no 'ghost' subdirectory.
      '/Users/operator': ['repo'],
    })

    const result = reverseProjectSlug('-Users-operator-ghost', fs)
    expect(result.path).toBeNull()
    expect((result as { reason: string }).reason).toContain(path.join('/', 'Users', 'hannah'))
  })

  it('reports unresolved for a slug that does not start with "-" rather than guessing a relative path', () => {
    const result = reverseProjectSlug('not-an-absolute-slug', fixtureFs({}))
    expect(result.path).toBeNull()
    expect((result as { reason: string }).reason).toContain('does not start with "-"')
  })
})

describe('listKnownProjects', () => {
  it('reports available: false, honestly, when ~/.claude/projects does not exist yet', () => {
    const result = listKnownProjects('/home/x/.claude/projects', fixtureFs({}))
    expect(result).toEqual({
      available: false,
      reason: expect.stringContaining(path.join('/home/x/.claude/projects')),
    })
  })

  it('lists every slug, resolved and unresolved side by side — an unresolvable slug still appears', () => {
    const fs = fixtureFs({
      '/home/x/.claude/projects': ['-home-x-repo', '-home-x-ghost'],
      '/': ['home'],
      '/home': ['x'],
      '/home/x': ['repo'],
      '/home/x/repo': [],
    })

    const result = listKnownProjects('/home/x/.claude/projects', fs)
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

  it('returns an empty list, not an error, when the root exists but has no project slugs yet', () => {
    const fs = fixtureFs({ '/home/x/.claude/projects': [] })
    expect(listKnownProjects('/home/x/.claude/projects', fs)).toEqual({ available: true, projects: [] })
  })
})

describe('scanCommonRoots', () => {
  it('finds a repo sitting directly under a common root', () => {
    const fs = fixtureFs({
      '/home/x': ['code'],
      '/home/x/code': ['repo1'],
      '/home/x/code/repo1': ['.git'],
    })

    const result = scanCommonRoots('/home/x', fs)
    expect(result).toEqual({ repos: [{ path: path.join('/home/x/code/repo1') }], truncated: false })
  })

  it('finds a repo nested one level deeper — the org/repo shape — within the default depth', () => {
    const fs = fixtureFs({
      '/home/x': ['code'],
      '/home/x/code': ['org'],
      '/home/x/code/org': ['repo2'],
      '/home/x/code/org/repo2': ['.git'],
    })

    const result = scanCommonRoots('/home/x', fs)
    expect(result.repos).toEqual([{ path: path.join('/home/x/code/org/repo2') }])
  })

  it('does not descend past the default depth — a repo three levels below a common root is missed, not found', () => {
    const fs = fixtureFs({
      '/home/x': ['code'],
      '/home/x/code': ['a'],
      '/home/x/code/a': ['b'],
      '/home/x/code/a/b': ['repo'],
      '/home/x/code/a/b/repo': ['.git'],
    })

    expect(scanCommonRoots('/home/x', fs).repos).toEqual([])
  })

  it('never descends into a skipped directory name, even one that looks like it might hide a repo', () => {
    const fs = fixtureFs({
      '/home/x': ['code'],
      '/home/x/code': ['node_modules'],
      '/home/x/code/node_modules': ['pkg'],
      '/home/x/code/node_modules/pkg': ['.git'],
    })

    expect(scanCommonRoots('/home/x', fs).repos).toEqual([])
  })

  it('never descends into a hidden (dot-prefixed) directory', () => {
    const fs = fixtureFs({
      '/home/x': ['code'],
      '/home/x/code': ['.hidden'],
      '/home/x/code/.hidden': ['.git'],
    })

    expect(scanCommonRoots('/home/x', fs).repos).toEqual([])
  })

  it('does not scan a repo\'s own internals once it is found — a nested .git inside a found repo is invisible', () => {
    const fs = fixtureFs({
      '/home/x': ['code'],
      '/home/x/code': ['repo3'],
      '/home/x/code/repo3': ['.git', 'nested'],
      '/home/x/code/repo3/nested': ['.git'],
    })

    expect(scanCommonRoots('/home/x', fs).repos).toEqual([{ path: path.join('/home/x/code/repo3') }])
  })

  it('is bounded by maxDirsVisited and reports truncated: true rather than a silently partial list', () => {
    const fs = fixtureFs({
      '/home/x': ['code'],
      '/home/x/code': ['a', 'b', 'c'],
      '/home/x/code/a': ['.git'],
      '/home/x/code/b': ['.git'],
      '/home/x/code/c': ['.git'],
    })

    const result = scanCommonRoots('/home/x', fs, { maxDirsVisited: 2 })
    expect(result.truncated).toBe(true)
  })

  it('a common root that does not exist on this machine is simply skipped, not an error', () => {
    expect(scanCommonRoots('/home/nobody-has-any-of-these-dirs', fixtureFs({}))).toEqual({
      repos: [],
      truncated: false,
    })
  })
})

describe('discoverRepos', () => {
  it('assembles the known-projects reversal and the common-roots scan into one result', () => {
    const fs = fixtureFs({
      '/': ['home'],
      '/home': ['x'],
      '/home/x/.claude/projects': ['-home-x-known'],
      '/home/x': ['known', 'code'],
      '/home/x/known': [],
      '/home/x/code': ['scanned'],
      '/home/x/code/scanned': ['.git'],
    })

    const result = discoverRepos({ homeDir: '/home/x', fs })

    expect(result.known).toEqual({
      available: true,
      projects: [{ slug: '-home-x-known', path: path.join('/home/x/known'), resolved: true }],
    })
    expect(result.scanned).toEqual({ repos: [{ path: path.join('/home/x/code/scanned') }], truncated: false })
  })

  it('derives claudeProjectsRoot from homeDir when not given explicitly', () => {
    const fs = fixtureFs({ '/home/x/.claude/projects': [] })
    const result = discoverRepos({ homeDir: '/home/x', fs })
    expect(result.known).toEqual({ available: true, projects: [] })
  })
})

/**
 * `realDiscoveryFs` against a REAL filesystem — the one thing a fixture map
 * can never prove: that a symlink is genuinely excluded by the OS-level
 * `Dirent` this module reads, not just by a fixture that never had one.
 * Mirrors `concierge/namespace-law.test.ts`'s own "live" section.
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

    expect(realDiscoveryFs.listSubdirectories(root).sort()).toEqual(['real-dir'])
  })

  it('a symlinked common root is therefore never scanned into, even if it points at a directory full of repos', async () => {
    const outsideRepo = path.join(root, 'outside', 'someones-repo')
    await mkdir(path.join(outsideRepo, '.git'), { recursive: true })
    await mkdir(path.join(root, 'home'))
    await symlink(path.join(root, 'outside'), path.join(root, 'home', 'code'))

    const result = scanCommonRoots(path.join(root, 'home'), realDiscoveryFs)
    expect(result.repos).toEqual([])
  })

  it('exists() follows symlinks for the claudeProjectsRoot existence check, matching checkClaudeProjects\' own existsSync', async () => {
    const realProjects = path.join(root, 'real-projects')
    await mkdir(realProjects)
    const linked = path.join(root, 'linked-projects')
    await symlink(realProjects, linked)

    expect(realDiscoveryFs.exists(linked)).toBe(true)
  })
})
