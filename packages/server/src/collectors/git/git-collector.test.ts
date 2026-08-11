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
      'branch.removed',
      'worktree.dirty',
      'worktree.dirty',
    ])

    const discovered = poll2.events.find((event) => event.type === 'worktree.discovered')
    expect(discovered?.payload).toEqual(
      expect.objectContaining({ path: '/repo-worktrees/feature-z', branch: 'feature-z' }),
    )

    const removed = poll2.events.find((event) => event.type === 'worktree.removed')
    expect(removed?.payload).toEqual({ path: '/repo-worktrees/feature-y' })

    // feature-y's ref is gone from POLL_2_REFS too — the branch itself was
    // deleted, not just its worktree. #137: without this, the collision
    // matrix would keep comparing feature-y's commits forever.
    const branchRemoved = poll2.events.find((event) => event.type === 'branch.removed')
    expect(branchRemoved?.payload).toEqual({ branch: 'feature-y' })

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
    expect(poll2.nextSnapshot.branches['feature-y']).toBeUndefined()
  })

  it('emits branch.removed for a ref that vanishes with no worktree change at all — a plain `git branch -d`', async () => {
    const worktrees = `worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main
`
    const exec1 = scriptedExec({
      'git worktree list --porcelain::/repo': worktrees,
      'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo':
        'main 1111111111111111111111111111111111111111\nstale 6666666666666666666666666666666666666666\n',
      'git rev-list --left-right --count main...stale::/repo': '0\t1',
      'git status --porcelain::/repo': '',
    })
    const { nextSnapshot } = await gitCollector.poll(gitCollector.initialSnapshot(), makeContext(exec1, 1000))
    expect(nextSnapshot.branches['stale']).toBeDefined()

    const exec2 = scriptedExec({
      'git worktree list --porcelain::/repo': worktrees,
      'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo':
        'main 1111111111111111111111111111111111111111\n',
      'git status --porcelain::/repo': '',
    })
    const poll2 = await gitCollector.poll(nextSnapshot, makeContext(exec2, 2000))

    expect(poll2.events.map((event) => event.type)).toEqual(['branch.removed'])
    expect(poll2.events[0]?.payload).toEqual({ branch: 'stale' })
    expect(poll2.nextSnapshot.branches['stale']).toBeUndefined()
    expect(poll2.nextSnapshot.branches['main']).toBeDefined()
  })

  it('reports a collector.error (not silence) when git status fails or times out, while still carrying forward the last known dirty state', async () => {
    const worktrees = `worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main
`
    const exec1 = scriptedExec({
      'git worktree list --porcelain::/repo': worktrees,
      'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo':
        'main 1111111111111111111111111111111111111111\n',
      'git status --porcelain::/repo': '?? scratch.txt\n',
    })
    const { nextSnapshot } = await gitCollector.poll(gitCollector.initialSnapshot(), makeContext(exec1, 1000))
    expect(nextSnapshot.dirty['/repo']).toEqual([{ path: 'scratch.txt', status: 'untracked', staged: false }])

    // Second poll: `git status` times out — the same shape `execFile`'s
    // `timeout` option produces once ticks are bounded (#236): killed by a
    // signal, so `code` is null and `errorMessage` is set, just like a
    // missing binary.
    const exec2: Exec = async (command, args, options) => {
      if (args[0] === 'status') {
        return { stdout: '', stderr: '', code: null, failed: true, errorMessage: 'Command failed: git status --porcelain' }
      }
      const key = `${command} ${args.join(' ')}::${options?.cwd ?? ''}`
      const script: Record<string, string> = {
        'git worktree list --porcelain::/repo': worktrees,
        'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo':
          'main 1111111111111111111111111111111111111111\n',
      }
      const stdout = script[key]
      if (stdout === undefined) throw new Error(`no scripted output for "${key}"`)
      return { stdout, stderr: '', code: 0, failed: false }
    }

    const poll2 = await gitCollector.poll(nextSnapshot, makeContext(exec2, 2000))

    expect(poll2.events).toEqual([
      expect.objectContaining({
        type: 'collector.error',
        payload: expect.objectContaining({
          collector: 'git',
          message: 'git status --porcelain failed for /repo',
          detail: 'Command failed: git status --porcelain',
        }),
      }),
    ])
    // Last known dirty state survives the failed poll rather than vanishing.
    expect(poll2.nextSnapshot.dirty['/repo']).toEqual([{ path: 'scratch.txt', status: 'untracked', staged: false }])
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

  it('skips an unparseable git raw diff line, keeping the rest of the poll (ruling 4)', async () => {
    const worktrees1 = `worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo-worktrees/feature-x
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feature-x
`
    const refs1 = `feature-x 2222222222222222222222222222222222222222
main 1111111111111111111111111111111111111111
`
    const exec1 = scriptedExec({
      'git worktree list --porcelain::/repo': worktrees1,
      'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo': refs1,
      'git rev-list --left-right --count main...feature-x::/repo': '0\t1',
      'git status --porcelain::/repo': '',
      'git status --porcelain::/repo-worktrees/feature-x': '',
    })
    const { nextSnapshot } = await gitCollector.poll(gitCollector.initialSnapshot(), makeContext(exec1, 1000))

    const FEATURE_X_HEAD_1 = '2222222222222222222222222222222222222222'
    const FEATURE_X_HEAD_2 = '4444444444444444444444444444444444444444'
    const worktrees2 = `worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo-worktrees/feature-x
HEAD ${FEATURE_X_HEAD_2}
branch refs/heads/feature-x
`
    const refs2 = `feature-x ${FEATURE_X_HEAD_2}
main 1111111111111111111111111111111111111111
`
    const logWithBadLine = `\x01${FEATURE_X_HEAD_2}\x1f4444444\x1fAda Dev\x1fdev@example.com\x1f1785360900\x1f${FEATURE_X_HEAD_1}\x1ffix: two good files around one bad raw line
:100644 100644 aaaaaaa bbbbbbb M\tsrc/good-before.js
:this-is-not-a-raw-diff-line
:100644 100644 ccccccc ddddddd M\tsrc/good-after.js
1\t0\tsrc/good-before.js
9\t9\tsrc/whatever-this-numstat-is-discarded.js
2\t1\tsrc/good-after.js
`
    const exec2 = scriptedExec({
      'git worktree list --porcelain::/repo': worktrees2,
      'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo': refs2,
      'git rev-list --left-right --count main...feature-x::/repo': '0\t2',
      [`git log --raw --numstat -M --reverse --pretty=format:${LOG_PRETTY} ${FEATURE_X_HEAD_1}..${FEATURE_X_HEAD_2}::/repo`]:
        logWithBadLine,
      'git status --porcelain::/repo': '',
      'git status --porcelain::/repo-worktrees/feature-x': '?? untracked.txt\n',
    })

    const poll2 = await gitCollector.poll(nextSnapshot, makeContext(exec2, 2000))

    expect(poll2.events.map((event) => event.type)).toEqual([
      'collector.error',
      'branch.updated',
      'commit.landed',
      'worktree.dirty',
    ])

    const errorEvent = poll2.events.find((event) => event.type === 'collector.error')
    expect(errorEvent?.payload).toEqual({
      collector: 'git',
      message: 'skipped 1 unparseable git raw diff line on feature-x',
      detail: expect.stringContaining(':this-is-not-a-raw-diff-line'),
    })

    const commitLanded = poll2.events.find((event) => event.type === 'commit.landed')
    expect(commitLanded?.payload).toMatchObject({
      files: [
        { path: 'src/good-before.js', status: 'modified', previousPath: undefined, insertions: 1, deletions: 0 },
        { path: 'src/good-after.js', status: 'modified', previousPath: undefined, insertions: 2, deletions: 1 },
      ],
    })

    expect(poll2.nextSnapshot.disabled).toBe(false)
    expect(poll2.nextSnapshot.branches['feature-x']?.head).toBe(FEATURE_X_HEAD_2)

    // Repetition: same head, same log script — headMoved is false so
    // loadNewCommits isn't even called, and the skip from poll 2 isn't
    // re-voiced against an unrelated tick.
    const poll3 = await gitCollector.poll(poll2.nextSnapshot, makeContext(exec2, 3000))
    expect(poll3.events).toEqual([])
  })

  it('capabilities: declares identity provided (worktree.discovered names path+branch) and never claims a signal it has no event to back', async () => {
    expect(gitCollector.capabilities?.identity).toEqual({ level: 'provided' })

    const exec: Exec = async (command, args) => {
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        return { stdout: 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n', stderr: '', code: 0, failed: false }
      }
      if (command === 'git' && args[0] === 'for-each-ref') {
        return { stdout: 'main abc123\n', stderr: '', code: 0, failed: false }
      }
      return { stdout: '', stderr: '', code: 0, failed: false }
    }
    const context = makeContext(exec, 1000)
    const { events } = await gitCollector.poll(gitCollector.initialSnapshot(), context)

    const discovered = events.find((event) => event.type === 'worktree.discovered')
    expect(discovered?.payload).toMatchObject({ path: '/repo', branch: 'main' })

    // git never emits llm.usage, tool.activity or agent.status — its own
    // capabilities honestly declare exactly that.
    expect(events.some((event) => event.type === 'llm.usage')).toBe(false)
    expect(events.some((event) => event.type === 'agent.status')).toBe(false)
    expect(gitCollector.capabilities?.attention.level).toBe('absent')
    expect(gitCollector.capabilities?.telemetry.level).toBe('absent')
    expect(gitCollector.capabilities?.cost.level).toBe('absent')
  })
})
