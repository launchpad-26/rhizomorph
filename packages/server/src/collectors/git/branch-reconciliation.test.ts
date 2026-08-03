import { createEvent, createIdFactory, reduceAll } from '@rhizomorph/core'
import type { CollectorContext, Exec } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { withBranchReconciliation } from '../resume-reconcile.js'
import { gitCollector } from './git-collector.js'
import type { GitSnapshot } from './types.js'

/**
 * The live session's actual ghost shape (#139): two branches — '132-old' and
 * '134-old' — whose deletion happened under the pre-#137 collector, which
 * dropped them from its own snapshot without ever emitting `branch.removed`
 * (the event type didn't exist yet). The persisted `GitSnapshot` today
 * already agrees with reality (it never held them past that poll), but the
 * fold rebuilt from the event log still has their old `branch.updated`
 * facts and no removal to retire them with — the "NEED ATTENTION 132⇄134"
 * banner that survives #137.
 */

function scriptedExec(script: Record<string, string>): Exec {
  return async (command, args, options) => {
    const key = `${command} ${args.join(' ')}::${options?.cwd ?? ''}`
    const stdout = script[key]
    if (stdout === undefined) {
      throw new Error(`branch-reconciliation test: no scripted output for "${key}"`)
    }
    return { stdout, stderr: '', code: 0, failed: false }
  }
}

function makeContext(exec: Exec, now: number): CollectorContext {
  const nextId = createIdFactory('evt')
  return {
    repoPath: '/repo',
    now,
    exec,
    nextId,
    emit: (type, payload) => createEvent(type, payload, { id: nextId(), ts: now }),
  }
}

const MAIN_HEAD = '1111111111111111111111111111111111111111'

const REALITY_WORKTREES = `worktree /repo
HEAD ${MAIN_HEAD}
branch refs/heads/main
`

const REALITY_REFS = `main ${MAIN_HEAD}\n`

/** What #137's own diffing already persisted — the ghosts are already gone from here. */
function ghostFreeSnapshot(): GitSnapshot {
  return {
    disabled: false,
    mainBranch: 'main',
    worktrees: {
      '/repo': {
        path: '/repo',
        branch: 'main',
        head: MAIN_HEAD,
        isMain: true,
        detached: false,
        locked: false,
        prunable: false,
      },
    },
    branches: { main: { head: MAIN_HEAD, aheadOfMain: 0, behindMain: 0 } },
    dirty: { '/repo': [] },
  }
}

function realityExec(): Exec {
  return scriptedExec({
    'git worktree list --porcelain::/repo': REALITY_WORKTREES,
    'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo': REALITY_REFS,
    'git status --porcelain::/repo': '',
  })
}

/** The old log: branch.updated facts for the ghosts, never a branch.removed. */
function ghostLog() {
  return [
    createEvent('branch.updated', { branch: 'main', head: MAIN_HEAD }, { id: 'evt-0', ts: 100 }),
    createEvent('branch.updated', { branch: '132-old', head: 'aaaaaaaaaa' }, { id: 'evt-1', ts: 200 }),
    createEvent('branch.updated', { branch: '134-old', head: 'bbbbbbbbbb' }, { id: 'evt-2', ts: 300 }),
  ]
}

describe('withBranchReconciliation(gitCollector) — the 132⇄134 ghost, reconstructed', () => {
  it('a fresh boot reconciles the ghosts to quiet: one branch.removed each, banner reaches ALL CLEAR', async () => {
    const priorEvents = ghostLog()
    const folded = reduceAll(priorEvents)

    // Sanity: the fold really does still believe in both ghosts before reconciliation.
    expect(Object.keys(folded.branches).sort()).toEqual(['132-old', '134-old', 'main'])

    const reconciled = withBranchReconciliation(gitCollector, new Set(Object.keys(folded.branches)))
    const result = await reconciled.poll(ghostFreeSnapshot(), makeContext(realityExec(), 1000))

    expect(result.events.map((event) => event.type)).toEqual(['branch.removed', 'branch.removed'])
    expect(result.events.map((event) => event.payload)).toEqual([
      { branch: '132-old' },
      { branch: '134-old' },
    ])

    const quiet = reduceAll(result.events, folded)
    expect(quiet.branches['132-old']).toBeUndefined()
    expect(quiet.branches['134-old']).toBeUndefined()
    expect(quiet.branches['main']).toBeDefined()
  })

  it('is idempotent: the next boot, whose fold no longer holds the ghosts, emits nothing new', async () => {
    const priorEvents = ghostLog()
    const firstFolded = reduceAll(priorEvents)
    const firstBoot = withBranchReconciliation(gitCollector, new Set(Object.keys(firstFolded.branches)))
    const firstResult = await firstBoot.poll(ghostFreeSnapshot(), makeContext(realityExec(), 1000))

    // The log a second boot would resume from now carries the reconciling events.
    const secondFolded = reduceAll([...priorEvents, ...firstResult.events])
    expect(Object.keys(secondFolded.branches).sort()).toEqual(['main'])

    const secondBoot = withBranchReconciliation(gitCollector, new Set(Object.keys(secondFolded.branches)))
    const secondResult = await secondBoot.poll(firstResult.nextSnapshot, makeContext(realityExec(), 2000))

    expect(secondResult.events).toHaveLength(0)
  })

  it('a plain replay of the ghost log, without reconciliation, still shows history as it was', () => {
    // No withBranchReconciliation involved at all — reconciliation is a
    // live-boot act, never a replay rewrite.
    const replayed = reduceAll(ghostLog())

    expect(replayed.branches['132-old']).toBeDefined()
    expect(replayed.branches['134-old']).toBeDefined()
  })
})
