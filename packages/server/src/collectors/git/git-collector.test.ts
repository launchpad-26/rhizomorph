import { createEvent, createIdFactory } from '@rhizomorph/core'
import type { CollectorContext, Exec } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { gitCollector } from './git-collector.js'
import { LOG_PRETTY } from './parse-log.js'

/**
 * These tests drive the collector purely through a scripted {@link Exec} —
 * no real git process ever runs, per the "no git needed to run tests" DoD.
 * Each scenario's command outputs below are hand-written but shaped exactly
 * like real git output (verified against the parser fixtures elsewhere in
 * this directory); the parsers themselves are unit-tested against fixtures
 * captured from real git.
 */

function scriptedExec(script: Record<string, string>): Exec {
  return async (command, args, options) => {
    const key = `${command} ${args.join(' ')}::${options?.cwd ?? ''}`
    const stdout = script[key]
    if (stdout === undefined) {
      throw new Error(`git-collector test: no scripted output for "${key}"`)
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

const POLL_1_WORKTREES = `worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo-worktrees/feature-x
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feature-x

worktree /repo-worktrees/feature-y
HEAD 3333333333333333333333333333333333333333
branch refs/heads/feature-y
`

const POLL_1_REFS = `feature-x 2222222222222222222222222222222222222222
feature-y 3333333333333333333333333333333333333333
main 1111111111111111111111111111111111111111
`

const POLL_2_WORKTREES = `worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo-worktrees/feature-x
HEAD 4444444444444444444444444444444444444444
branch refs/heads/feature-x

worktree /repo-worktrees/feature-z
HEAD 5555555555555555555555555555555555555555
branch refs/heads/feature-z
`

const POLL_2_REFS = `feature-x 4444444444444444444444444444444444444444
feature-z 5555555555555555555555555555555555555555
main 1111111111111111111111111111111111111111
`

const FEATURE_X_HEAD_1 = '2222222222222222222222222222222222222222'
const FEATURE_X_HEAD_2 = '4444444444444444444444444444444444444444'

const POLL_2_LOG = `\x01${FEATURE_X_HEAD_2}\x1f4444444\x1fAda Dev\x1fdev@example.com\x1f1785360000\x1f${FEATURE_X_HEAD_1}\x1ffeat: add feature flag
:100644 100644 aaaaaaa bbbbbbb M\tsrc/flag.js
1\t0\tsrc/flag.js
`

describe('gitCollector', () => {
  it('discovers worktrees, branches and dirty files on the first poll without walking history', async () => {
    const exec = scriptedExec({
      'git worktree list --porcelain::/repo': POLL_1_WORKTREES,
      'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo': POLL_1_REFS,
      'git rev-list --left-right --count main...feature-x::/repo': '0\t1',
      'git rev-list --left-right --count main...feature-y::/repo': '0\t1',
      'git status --porcelain::/repo': '',
      'git status --porcelain::/repo-worktrees/feature-x': '?? scratch.txt\n',
      'git status --porcelain::/repo-worktrees/feature-y': '',
    })
    const context = makeContext(exec, 1000)

    const { nextSnapshot, events } = await gitCollector.poll(gitCollector.initialSnapshot(), context)

    expect(events.map((event) => event.type)).toEqual([
      'worktree.discovered',
      'worktree.discovered',
      'worktree.discovered',
      'branch.updated',
      'branch.updated',
      'branch.updated',
      'worktree.dirty',
    ])

    // No prior branch heads were known, so nothing gets diffed into commit history.
    expect(events.some((event) => event.type === 'commit.landed')).toBe(false)

    const branchEvents = events.filter((event) => event.type === 'branch.updated')
    expect(branchEvents.map((event) => event.payload)).toEqual([
      expect.objectContaining({ branch: 'feature-x', head: '2222222222222222222222222222222222222222', previousHead: null, aheadOfMain: 1, behindMain: 0 }),
      expect.objectContaining({ branch: 'feature-y', head: '3333333333333333333333333333333333333333', previousHead: null, aheadOfMain: 1, behindMain: 0 }),
      expect.objectContaining({ branch: 'main', head: '1111111111111111111111111111111111111111', previousHead: null, aheadOfMain: 0, behindMain: 0 }),
    ])

    const dirtyEvent = events.find((event) => event.type === 'worktree.dirty')
    expect(dirtyEvent?.payload).toEqual({
      path: '/repo-worktrees/feature-x',
      branch: 'feature-x',
      files: [{ path: 'scratch.txt', status: 'untracked', staged: false }],
    })

    expect(nextSnapshot.mainBranch).toBe('main')
    expect(nextSnapshot.worktrees['/repo-worktrees/feature-x']?.isMain).toBe(false)
    expect(nextSnapshot.worktrees['/repo']?.isMain).toBe(true)
    expect(nextSnapshot.branches['feature-x']).toEqual({
      head: '2222222222222222222222222222222222222222',
      aheadOfMain: 1,
      behindMain: 0,
    })

    // --- second poll: feature-x lands a commit, feature-y is removed, feature-z appears ---
    const exec2 = scriptedExec({
      'git worktree list --porcelain::/repo': POLL_2_WORKTREES,
      'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo': POLL_2_REFS,
      'git rev-list --left-right --count main...feature-x::/repo': '0\t2',
      'git rev-list --left-right --count main...feature-z::/repo': '0\t1',
      [`git log --raw --numstat -M --reverse --pretty=format:${LOG_PRETTY} ${FEATURE_X_HEAD_1}..${FEATURE_X_HEAD_2}::/repo`]:
        POLL_2_LOG,
      'git status --porcelain::/repo': '',
      'git status --porcelain::/repo-worktrees/feature-x': '',
      'git status --porcelain::/repo-worktrees/feature-z': '?? draft.md\n',
    })
    const context2 = makeContext(exec2, 2000)

    const poll2 = await gitCollector.poll(nextSnapshot, context2)

    expect(poll2.events.map((event) => event.type)).toEqual([
      'worktree.discovered',
      'worktree.removed',
      'branch.updated',
      'commit.landed',
      'branch.updated',
      'worktree.dirty',
      'worktree.dirty',
    ])

    const discovered = poll2.events.find((event) => event.type === 'worktree.discovered')
    expect(discovered?.payload).toEqual(
      expect.objectContaining({ path: '/repo-worktrees/feature-z', branch: 'feature-z' }),
    )

    const removed = poll2.events.find((event) => event.type === 'worktree.removed')
    expect(removed?.payload).toEqual({ path: '/repo-worktrees/feature-y' })

    const featureXUpdate = poll2.events.find(
      (event) => event.type === 'branch.updated' && event.payload.branch === 'feature-x',
    )
    expect(featureXUpdate?.payload).toEqual({
      branch: 'feature-x',
      head: '4444444444444444444444444444444444444444',
      previousHead: '2222222222222222222222222222222222222222',
      worktreePath: '/repo-worktrees/feature-x',
      aheadOfMain: 2,
      behindMain: 0,
    })

    const commitLanded = poll2.events.find((event) => event.type === 'commit.landed')
    expect(commitLanded?.payload).toEqual({
      sha: '4444444444444444444444444444444444444444',
      branch: 'feature-x',
      message: 'feat: add feature flag',
      author: { name: 'Ada Dev', email: 'dev@example.com' },
      authoredAt: 1785360000000,
      parents: ['2222222222222222222222222222222222222222'],
      files: [{ path: 'src/flag.js', status: 'modified', previousPath: undefined, insertions: 1, deletions: 0 }],
      insertions: 1,
      deletions: 0,
      worktreePath: '/repo-worktrees/feature-x',
    })

    const dirtyEvents = poll2.events.filter((event) => event.type === 'worktree.dirty')
    expect(dirtyEvents.map((event) => event.payload)).toEqual([
      { path: '/repo-worktrees/feature-x', branch: 'feature-x', files: [] },
      { path: '/repo-worktrees/feature-z', branch: 'feature-z', files: [{ path: 'draft.md', status: 'untracked', staged: false }] },
    ])

    expect(poll2.nextSnapshot.worktrees['/repo-worktrees/feature-y']).toBeUndefined()
    expect(poll2.nextSnapshot.dirty['/repo-worktrees/feature-y']).toBeUndefined()
  })

  it('latches disabled (not a repeating collector.error) when worktree list fails, e.g. a non-git directory', async () => {
    let execCalls = 0
    const exec: Exec = async () => {
      execCalls += 1
      return {
        stdout: '',
        stderr: 'fatal: not a git repository (or any of the parent directories): .git',
        code: 128,
        failed: true,
        errorMessage: 'fatal: not a git repository (or any of the parent directories): .git',
      }
    }
    const context = makeContext(exec, 5000)
    const prevSnapshot = gitCollector.initialSnapshot()

    const { nextSnapshot, events } = await gitCollector.poll(prevSnapshot, context)

    expect(execCalls).toBe(1)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(
      expect.objectContaining({
        type: 'collector.disabled',
        payload: expect.objectContaining({
          collector: 'git',
          reason: 'fatal: not a git repository (or any of the parent directories): .git',
        }),
      }),
    )
    expect(nextSnapshot).toEqual({ ...prevSnapshot, disabled: true })

    // Latched: every later poll no-ops without shelling out again, so a
    // non-git directory does not grow the session log forever.
    const context2 = makeContext(exec, 7000)
    const poll2 = await gitCollector.poll(nextSnapshot, context2)

    expect(execCalls).toBe(1)
    expect(poll2.events).toEqual([])
    expect(poll2.nextSnapshot).toBe(nextSnapshot)
  })
})
