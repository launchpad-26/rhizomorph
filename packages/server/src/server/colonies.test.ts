import type { AgentProcess } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { repoSlug } from '../log/paths.js'
import type { RepoRootResolver } from '../paths/repo-root.js'
import { createColonyDiscovery } from './colonies.js'

/**
 * prd-58 ruling 1 — the instrument watches the operator, not a path.
 *
 * The property a one-worktree-per-repo fixture cannot see, and the one this
 * file is mostly about: **several worktrees of one repo are ONE colony.**
 */

const PINNED = '/repo/main'

/** A resolver over a fixed cwd -> repo-root table. Anything unlisted is rootless. */
function resolverOver(table: Record<string, string>): RepoRootResolver {
  return { resolve: async (cwd: string) => table[cwd] ?? null }
}

function actor(overrides: Partial<AgentProcess> & { pid: number }): AgentProcess {
  return {
    dialect: 'claude',
    startedAt: 1_000,
    worktreePath: null,
    placement: 'unknown',
    parentPid: null,
    cpuMsDelta: null,
    rssBytes: null,
    seenAt: 1_000,
    goneAt: null,
    goneReason: null,
    ...overrides,
  }
}

describe('createColonyDiscovery — the watched set, discovered from placement', () => {
  it('three worktrees of one repo and one of another yield TWO colonies', async () => {
    // The grouping claim. A resolver that answered with the worktree root would
    // give four colonies here and every other assertion in this file would
    // still pass, which is why this one drives four actors rather than two.
    const discovery = createColonyDiscovery({
      pinnedRepoPath: PINNED,
      resolver: resolverOver({
        '/repo/other': '/repo/other',
        '/repo/other-wt/a': '/repo/other',
        '/repo/other-wt/b': '/repo/other',
        '/elsewhere/proj': '/elsewhere/proj',
      }),
    })

    const colonies = await discovery.discover([
      actor({ pid: 1, worktreePath: '/repo/other', placement: 'rooted' }),
      actor({ pid: 2, worktreePath: '/repo/other-wt/a', placement: 'rooted' }),
      actor({ pid: 3, worktreePath: '/repo/other-wt/b', placement: 'rooted' }),
      actor({ pid: 4, worktreePath: '/elsewhere/proj', placement: 'rooted' }),
    ])

    // Two discovered, plus the pin. Ordered pin-first then by ID — the slug,
    // not the path — which is why `other-<hash>` precedes `proj-<hash>` here.
    expect(colonies.map((c) => c.path)).toEqual([PINNED, '/repo/other', '/elsewhere/proj'])
  })

  it('the pinned colony is present with no actors at all, and sorts first', async () => {
    // The zero-configuration case: start inside a repo, run nothing, still see
    // that repo. It is the one colony that does not need an actor.
    const discovery = createColonyDiscovery({ pinnedRepoPath: PINNED, resolver: resolverOver({}) })
    const colonies = await discovery.discover([])

    expect(colonies).toEqual([{ id: repoSlug(PINNED), path: PINNED, pinned: true }])
  })

  it('the pin sorts first even when another colony sorts lower by id', async () => {
    // Pinning is ORDERING and nothing else (wave 0's ruling), so it has to beat
    // the id comparison rather than merely join it.
    const discovery = createColonyDiscovery({
      pinnedRepoPath: '/repo/zzz',
      resolver: resolverOver({ '/repo/aaa': '/repo/aaa' }),
    })
    const colonies = await discovery.discover([actor({ pid: 1, worktreePath: '/repo/aaa', placement: 'rooted' })])

    expect(colonies.map((c) => c.path)).toEqual(['/repo/zzz', '/repo/aaa'])
    expect(colonies.map((c) => c.pinned)).toEqual([true, false])
  })

  it('an actor in no repository yields no colony, and does not invent one', async () => {
    // ADR-0010. It is not lost — it stays in `state.processes` — but nothing
    // here guesses a root for it. Ruling 6 gives it a home in wave 3.
    const discovery = createColonyDiscovery({ pinnedRepoPath: PINNED, resolver: resolverOver({}) })
    const colonies = await discovery.discover([
      actor({ pid: 1, worktreePath: '/home/operator', placement: 'unrooted' }),
    ])

    expect(colonies.map((c) => c.path)).toEqual([PINNED])
  })

  it('an actor the witness could not place yields no colony — the Windows shape', async () => {
    // `placementOf` returns `worktreePath: null` for every process on Windows,
    // because the platform yields a command line and not a working directory.
    // The set is the pin alone, and that is a stated gap rather than an empty
    // answer nobody can account for.
    const discovery = createColonyDiscovery({
      pinnedRepoPath: PINNED,
      resolver: resolverOver({ '/repo/other': '/repo/other' }),
    })
    const colonies = await discovery.discover([
      actor({ pid: 1, worktreePath: null, placement: 'unknown' }),
      actor({ pid: 2, worktreePath: null, placement: 'unknown' }),
    ])

    expect(colonies.map((c) => c.path)).toEqual([PINNED])
  })

  it('an actor in the pinned repo does not duplicate it, or unpin it', async () => {
    const discovery = createColonyDiscovery({
      pinnedRepoPath: PINNED,
      resolver: resolverOver({ '/repo/main-wt/x': PINNED }),
    })
    const colonies = await discovery.discover([
      actor({ pid: 1, worktreePath: '/repo/main-wt/x', placement: 'rooted' }),
    ])

    expect(colonies).toEqual([{ id: repoSlug(PINNED), path: PINNED, pinned: true }])
  })

  it('a GONE actor still names its colony — the repo did not stop existing', async () => {
    // The lane it was working in is still a lane, and its recording is still a
    // recording. Dropping the colony when the last agent exits would make the
    // watched set flicker and lose the history the operator came to read.
    const discovery = createColonyDiscovery({
      pinnedRepoPath: PINNED,
      resolver: resolverOver({ '/repo/other': '/repo/other' }),
    })
    const colonies = await discovery.discover([
      actor({ pid: 1, worktreePath: '/repo/other', placement: 'rooted', goneAt: 5_000, goneReason: 'absent' }),
    ])

    expect(colonies.map((c) => c.path)).toEqual([PINNED, '/repo/other'])
  })

  it('the id is the recorder slug, not a second identity', async () => {
    // Ruling 2 records each colony "under its own slug, exactly as prd-16
    // writes it". A second identity here would let the selector and the
    // recorder disagree about which colony is which.
    const discovery = createColonyDiscovery({
      pinnedRepoPath: PINNED,
      resolver: resolverOver({ '/repo/other': '/repo/other' }),
    })
    const colonies = await discovery.discover([
      actor({ pid: 1, worktreePath: '/repo/other', placement: 'rooted' }),
    ])

    expect(colonies.map((c) => c.id)).toEqual([repoSlug(PINNED), repoSlug('/repo/other')])
  })
})
