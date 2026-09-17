import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AgentProcess } from '@rhizomorph/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { repoSlug } from '../log/paths.js'
import { canonicalize } from './containment.js'
import { canonicalizeRepoPath, createRepoRootResolver } from './repo-root.js'
import { createColonyDiscovery } from '../server/colonies.js'
import { exec as realExec } from '../server/exec.js'

/**
 * THE PIN IS CANONICAL — prd-58 ruling 1's identity, and the review finding
 * that a raw one splits a repo in two.
 *
 * `path.resolve` does not follow symlinks; `createRepoRootResolver` does. The
 * boot used to pin the resolved spelling and discovery keys on the resolver's,
 * so a repo reached through a symlink produced TWO colonies for one repository
 * — two recorders, two poll loops, two recordings, two rows in the selector.
 *
 * **This is the shape that is silent on Linux and unconditional on macOS**,
 * where `os.tmpdir()` is `/var/...` → `/private/var/...`. It is reproduced here
 * on any platform by building the symlink the macOS filesystem already has,
 * rather than trusting a leg nobody runs.
 *
 * The real resolver is used deliberately: a fake one would agree with whatever
 * spelling the test handed it, which is exactly how every existing fixture in
 * `colonies.test.ts` passes over this defect.
 */
let realRoot: string
let linkedRoot: string
let realRepo: string

function actorAt(worktreePath: string): AgentProcess {
  return {
    pid: 4242,
    dialect: 'claude',
    startedAt: 1,
    worktreePath,
    placement: 'rooted',
    parentPid: null,
    cpuMsDelta: null,
    rssBytes: null,
    seenAt: 1,
    goneAt: null,
    goneReason: null,
  }
}

beforeAll(async () => {
  realRoot = canonicalize(await mkdtemp(path.join(tmpdir(), 'rhizo-pin-real-')))
  realRepo = path.join(realRoot, 'repo')
  await mkdir(realRepo, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: realRepo })
  // The macOS shape: a symlink standing in front of the real directory.
  linkedRoot = path.join(canonicalize(tmpdir()), `rhizo-pin-link-${process.pid}`)
  await symlink(realRoot, linkedRoot)
}, 60_000)

afterAll(async () => {
  await rm(linkedRoot, { force: true })
  await rm(realRoot, { recursive: true, force: true })
})

describe('the boot pins a canonical repo path (prd-58 ruling 1)', () => {
  it('resolves a symlinked spelling to the one the root resolver will answer with', () => {
    expect(canonicalizeRepoPath(path.join(linkedRoot, 'repo'))).toBe(realRepo)
  })

  it('returns the path unchanged when there is no symlink to follow', () => {
    expect(canonicalizeRepoPath(realRepo)).toBe(realRepo)
  })

  it('a path that cannot be canonicalised is a boot that still starts', () => {
    // `canonicalize` walks up to a real ancestor for a path that does not
    // exist, so the fallback is about the throwing cases (ELOOP, EACCES). The
    // property under test is that the value is always a usable absolute path.
    const ghost = path.join(realRoot, 'not-here', 'either')
    expect(canonicalizeRepoPath(ghost)).toBe(ghost)
  })

  it('ONE repository is ONE colony, whichever spelling the operator typed', async () => {
    const discovery = createColonyDiscovery({
      // What `cli/run.ts` now pins: the canonical form of what was typed.
      pinnedRepoPath: canonicalizeRepoPath(path.join(linkedRoot, 'repo')),
      resolver: createRepoRootResolver(realExec),
    })

    // What the process witness reports: procfs and lsof both resolve symlinks,
    // so an agent in the very same repo is seen at its real path.
    const colonies = await discovery.discover([actorAt(realRepo)])

    expect(colonies).toHaveLength(1)
    expect(colonies[0]?.path).toBe(realRepo)
    expect(colonies[0]?.pinned).toBe(true)
    // The identity the recorder writes under and the selector shows agree.
    expect(colonies[0]?.id).toBe(repoSlug(realRepo))
  }, 60_000)

  it('the OLD behaviour — a raw pin — is what split the repo in two', async () => {
    // The mutation, kept as a test rather than described: pin the unresolved
    // spelling and the same machine reports two colonies for one repository.
    const discovery = createColonyDiscovery({
      pinnedRepoPath: path.resolve(path.join(linkedRoot, 'repo')),
      resolver: createRepoRootResolver(realExec),
    })
    const colonies = await discovery.discover([actorAt(realRepo)])
    expect(colonies).toHaveLength(2)
    expect(new Set(colonies.map((c) => c.id)).size).toBe(2)
  }, 60_000)
})
