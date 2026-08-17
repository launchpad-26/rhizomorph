import { createEvent, createIdFactory, reduceAll } from '@rhizomorph/core'
import type { CollectorContext, Exec } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { withDirtyStatusReconciliation } from '../resume-reconcile.js'
import { gitCollector } from './git-collector.js'
import type { GitSnapshot } from './types.js'

/**
 * The live shape (#536): a resumed session whose fold still holds an open
 * `worktree.dirtyStatusFailed` incident for `/repo`, but whose git
 * collector snapshot has no memory of it — a fresh `initialSnapshot()`, or
 * a persisted snapshot that lags the log. `diffDirty`'s own close condition
 * (`git-collector.ts`) reads `dirtyFailures['/repo'] ?? 0 > MAX_DIRTY_STATUS_FAILURES`,
 * which is `0 > 3`, false, forever — a clean `git status` never crosses it
 * on its own.
 */

function scriptedExec(script: Record<string, string>): Exec {
  return async (command, args, options) => {
    const key = `${command} ${args.join(' ')}::${options?.cwd ?? ''}`
    const stdout = script[key]
    if (stdout === undefined) {
      throw new Error(`dirty-status-reconciliation test: no scripted output for "${key}"`)
    }
    return { stdout, stderr: '', code: 0, failed: false }
  }
}

function failingExec(script: Record<string, string>): Exec {
  return async (command, args, options) => {
    const key = `${command} ${args.join(' ')}::${options?.cwd ?? ''}`
    if (command === 'git' && args[0] === 'status') {
      return { stdout: '', stderr: 'fatal: unable to read index', code: 128, failed: true }
    }
    const stdout = script[key]
    if (stdout === undefined) {
      throw new Error(`dirty-status-reconciliation test: no scripted output for "${key}"`)
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

/** A resumed-with-no-memory snapshot: no dirtyFailures entry for '/repo' at all. */
function resumedSnapshot(): GitSnapshot {
  return {
    disabled: false,
    mainBranch: 'main',
    mainBranchGapVoiced: false,
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
    dirty: {},
    dirtyFailures: {},
    refsFailures: 0,
  }
}

/** The old log: an open worktree.dirtyStatusFailed incident nothing has closed. */
function openIncidentLog() {
  return [
    createEvent(
      'worktree.discovered',
      { path: '/repo', branch: 'main', head: MAIN_HEAD, isMain: true, detached: false, locked: false, prunable: false },
      { id: 'evt-0', ts: 100 },
    ),
    createEvent(
      'worktree.dirtyStatusFailed',
      { worktreePath: '/repo', consecutiveFailures: 4, message: 'git status --porcelain failed' },
      { id: 'evt-1', ts: 200 },
    ),
  ]
}

describe('withDirtyStatusReconciliation(gitCollector) — a folded open incident, git status now healthy', () => {
  it('closes the incident when this poll observes a clean git status', async () => {
    const priorEvents = openIncidentLog()
    const folded = reduceAll(priorEvents)
    expect(folded.worktrees['/repo']?.dirtyStatusFailedSince).toBe(200)

    const exec = scriptedExec({
      'git worktree list --porcelain::/repo': REALITY_WORKTREES,
      'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo': REALITY_REFS,
      'git status --porcelain::/repo': '',
    })

    const reconciled = withDirtyStatusReconciliation(gitCollector, new Set(['/repo']))
    const result = await reconciled.poll(resumedSnapshot(), makeContext(exec, 1000))

    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'worktree.dirtyStatusRecovered', payload: { worktreePath: '/repo' } }),
      ]),
    )

    const foldedAfter = reduceAll([...priorEvents, ...result.events])
    expect(foldedAfter.worktrees['/repo']?.dirtyStatusFailedSince).toBeNull()
  })

  // #536 Finding A: the incident is open in the log *because* status was
  // failing at shutdown, so the likely case on resume is a poll or two more
  // of the same failure before it clears — a per-path failure with no
  // collector.disabled. The old boolean latch spent itself on poll 1
  // regardless, and never reconciled again once the retry-in-progress path
  // was (correctly) skipped that one poll — so this test is RED against it.
  // The pending set must keep '/repo' pending through the failing poll and
  // close it on the first poll that actually comes back clean.
  it('stays open through a transient per-path failure and closes on the poll that recovers', async () => {
    const priorEvents = openIncidentLog()
    const folded = reduceAll(priorEvents)
    expect(folded.worktrees['/repo']?.dirtyStatusFailedSince).toBe(200)

    const failing = failingExec({
      'git worktree list --porcelain::/repo': REALITY_WORKTREES,
      'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo': REALITY_REFS,
    })
    const healthy = scriptedExec({
      'git worktree list --porcelain::/repo': REALITY_WORKTREES,
      'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo': REALITY_REFS,
      'git status --porcelain::/repo': '',
    })

    const reconciled = withDirtyStatusReconciliation(gitCollector, new Set(['/repo']))

    const first = await reconciled.poll(resumedSnapshot(), makeContext(failing, 1000))
    expect(first.events.some((event) => event.type === 'worktree.dirtyStatusRecovered')).toBe(false)
    expect(first.events.some((event) => event.type === 'collector.disabled')).toBe(false)

    const foldedAfterFirst = reduceAll([...priorEvents, ...first.events])
    expect(foldedAfterFirst.worktrees['/repo']?.dirtyStatusFailedSince).not.toBeNull()

    const second = await reconciled.poll(first.nextSnapshot, makeContext(healthy, 2000))
    expect(second.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'worktree.dirtyStatusRecovered', payload: { worktreePath: '/repo' } }),
      ]),
    )

    const foldedAfterSecond = reduceAll([...priorEvents, ...first.events, ...second.events])
    expect(foldedAfterSecond.worktrees['/repo']?.dirtyStatusFailedSince).toBeNull()
  })

  it('leaves the incident open when git status keeps failing — the negative case against the real collector', async () => {
    const priorEvents = openIncidentLog()
    const folded = reduceAll(priorEvents)
    expect(folded.worktrees['/repo']?.dirtyStatusFailedSince).toBe(200)

    const exec = failingExec({
      'git worktree list --porcelain::/repo': REALITY_WORKTREES,
      'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo': REALITY_REFS,
    })

    const reconciled = withDirtyStatusReconciliation(gitCollector, new Set(['/repo']))
    const result = await reconciled.poll(resumedSnapshot(), makeContext(exec, 1000))

    expect(result.events.some((event) => event.type === 'worktree.dirtyStatusRecovered')).toBe(false)

    const foldedAfter = reduceAll([...priorEvents, ...result.events])
    expect(foldedAfter.worktrees['/repo']?.dirtyStatusFailedSince).not.toBeNull()
  })
})
