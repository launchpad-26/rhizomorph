import { createEvent, createIdFactory } from '@rhizomorph/core'
import type { CollectorContext, Exec } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { gitCollector, MAX_DIRTY_STATUS_FAILURES } from './git-collector.js'
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

  describe('gone vs unchanged (prd-22 ruling 3, ADR-0016)', () => {
    /**
     * A `git status --porcelain` failure that keeps recurring for the SAME
     * worktree across polls — `args[0] === 'status'` fails unconditionally,
     * everything else is scripted normally. Models a genuine transient (lock
     * contention, a permission blip), never a proven removal: proving gone
     * happens through `prunable` in `worktree list --porcelain`, never
     * through a `git status` failure shape (ADR-0016 rejects ENOENT for
     * exactly this reason — it can't be told apart from git itself missing).
     */
    function execWithFailingStatus(script: Record<string, string>): Exec {
      return async (command, args, options) => {
        if (args[0] === 'status') {
          return { stdout: '', stderr: 'error: could not read index', code: 1, failed: true }
        }
        const key = `${command} ${args.join(' ')}::${options?.cwd ?? ''}`
        const stdout = script[key]
        if (stdout === undefined) throw new Error(`no scripted output for "${key}"`)
        return { stdout, stderr: '', code: 0, failed: false }
      }
    }

    const ONE_WORKTREE = `worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main
`
    const ONE_REF = 'main 1111111111111111111111111111111111111111\n'

    it('drops a worktree the moment git worktree list marks it prunable, and emits worktree.removed — no git status call for it at all', async () => {
      const worktrees1 = `${ONE_WORKTREE}
worktree /repo-worktrees/feature-x
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feature-x
`
      const exec1 = scriptedExec({
        'git worktree list --porcelain::/repo': worktrees1,
        'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo':
          `${ONE_REF}feature-x 2222222222222222222222222222222222222222\n`,
        'git rev-list --left-right --count main...feature-x::/repo': '0\t1',
        'git status --porcelain::/repo': '',
        'git status --porcelain::/repo-worktrees/feature-x': '?? scratch.txt\n',
      })
      const { nextSnapshot } = await gitCollector.poll(gitCollector.initialSnapshot(), makeContext(exec1, 1000))
      expect(nextSnapshot.worktrees['/repo-worktrees/feature-x']).toBeDefined()
      expect(nextSnapshot.dirty['/repo-worktrees/feature-x']).toEqual([
        { path: 'scratch.txt', status: 'untracked', staged: false },
      ])

      // The directory was `rm -rf`'d out-of-band. git's own list --porcelain
      // detects it on the very next call and marks it prunable — same
      // branch/head still reported, as real git does.
      const worktrees2 = `${ONE_WORKTREE}
worktree /repo-worktrees/feature-x
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feature-x
prunable gitdir file points to non-existent location
`
      // No `git status --porcelain::/repo-worktrees/feature-x` entry here on
      // purpose — scriptedExec throws on any unscripted call, which is the
      // proof that diffDirty never attempted it for a prunable worktree.
      const exec2 = scriptedExec({
        'git worktree list --porcelain::/repo': worktrees2,
        'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo':
          `${ONE_REF}feature-x 2222222222222222222222222222222222222222\n`,
        'git rev-list --left-right --count main...feature-x::/repo': '0\t1',
        'git status --porcelain::/repo': '',
      })

      const poll2 = await gitCollector.poll(nextSnapshot, makeContext(exec2, 2000))

      expect(poll2.events).toEqual([
        expect.objectContaining({ type: 'worktree.removed', payload: { path: '/repo-worktrees/feature-x' } }),
      ])
      expect(poll2.nextSnapshot.worktrees['/repo-worktrees/feature-x']).toBeUndefined()
      expect(poll2.nextSnapshot.dirty['/repo-worktrees/feature-x']).toBeUndefined()

      // Repetition: the porcelain output still carries the same prunable
      // record on a third poll. No re-emission — prevSnapshot no longer
      // knows the path, so the removal loop can't see it again.
      const poll3 = await gitCollector.poll(poll2.nextSnapshot, makeContext(exec2, 3000))
      expect(poll3.events).toEqual([])
    })

    it('carries the last dirty set forward silently for up to MAX_DIRTY_STATUS_FAILURES consecutive git status failures, then voices collector.error exactly once, stays silent through further failures, voices nothing on recovery, and re-arms for a second incident', async () => {
      const exec1 = scriptedExec({
        'git worktree list --porcelain::/repo': ONE_WORKTREE,
        'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo': ONE_REF,
        'git status --porcelain::/repo': '?? scratch.txt\n',
      })
      let snapshot = (await gitCollector.poll(gitCollector.initialSnapshot(), makeContext(exec1, 1000))).nextSnapshot
      expect(snapshot.dirty['/repo']).toEqual([{ path: 'scratch.txt', status: 'untracked', staged: false }])

      const exec2 = execWithFailingStatus({
        'git worktree list --porcelain::/repo': ONE_WORKTREE,
        'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo': ONE_REF,
      })

      // Failures 1, 2, 3: within the bound — silent carry-forward, no
      // collector.error, dirtyFailures climbs by one each poll.
      for (let failure = 1; failure <= 3; failure += 1) {
        const poll = await gitCollector.poll(snapshot, makeContext(exec2, 1000 + failure * 1000))
        expect(poll.events).toEqual([])
        expect(poll.nextSnapshot.dirty['/repo']).toEqual([{ path: 'scratch.txt', status: 'untracked', staged: false }])
        expect(poll.nextSnapshot.dirtyFailures['/repo']).toBe(failure)
        expect(poll.nextSnapshot.worktrees['/repo']).toBeDefined()
        snapshot = poll.nextSnapshot
      }

      // Failure 4: past the bound. Stale data stops being asserted as
      // current; the gap becomes visible instead.
      const poll4 = await gitCollector.poll(snapshot, makeContext(exec2, 5000))
      expect(poll4.events).toEqual([
        expect.objectContaining({
          type: 'collector.error',
          payload: expect.objectContaining({
            collector: 'git',
            message: 'git status --porcelain failed 4 times in a row for /repo',
            detail: 'error: could not read index',
          }),
        }),
      ])
      expect(poll4.nextSnapshot.dirty['/repo']).toBeUndefined()
      expect(poll4.nextSnapshot.dirtyFailures['/repo']).toBe(4)
      // Still not proven gone — git's own prunable flag never fired, so the
      // worktree itself stays tracked; only its stale dirty data was dropped.
      expect(poll4.nextSnapshot.worktrees['/repo']).toBeDefined()
      expect(poll4.events.some((event) => event.type === 'worktree.removed')).toBe(false)

      // Failures 5 and 6: still past the bound. No re-emission — this is the
      // heartbeat #415 removes. The message would have said "failed 5 times"
      // and "failed 6 times" if the bug were still present; asserting an
      // empty events array is what kills that mutation.
      let heartbeatSnapshot = poll4.nextSnapshot
      for (const failure of [5, 6]) {
        const poll = await gitCollector.poll(heartbeatSnapshot, makeContext(exec2, 5000 + failure * 1000))
        expect(poll.events).toEqual([])
        expect(poll.nextSnapshot.dirtyFailures['/repo']).toBe(failure)
        expect(poll.nextSnapshot.dirty['/repo']).toBeUndefined()
        heartbeatSnapshot = poll.nextSnapshot
      }

      // Recovery: the very next successful `git status` resets the failure
      // count silently and records the fresh set — not the stale one that
      // was already dropped. No close event (#415 ruling: a per-worktree
      // recovery voiced through the per-collector `lastErrorMessage` slot
      // can mask a sibling worktree's still-open incident — see #429). This
      // asserts the events array is exactly the dirty-set change with
      // nothing ahead of it — if a close were reintroduced it would prepend
      // a `collector.error` here, same as the reverted commit did, and this
      // assertion would go red.
      const exec5 = scriptedExec({
        'git worktree list --porcelain::/repo': ONE_WORKTREE,
        'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo': ONE_REF,
        'git status --porcelain::/repo': '?? fresh.txt\n',
      })
      const poll5 = await gitCollector.poll(heartbeatSnapshot, makeContext(exec5, 9000))
      expect(poll5.nextSnapshot.dirtyFailures['/repo']).toBeUndefined()
      expect(poll5.nextSnapshot.dirty['/repo']).toEqual([{ path: 'fresh.txt', status: 'untracked', staged: false }])
      expect(poll5.events).toEqual([
        expect.objectContaining({
          type: 'worktree.dirty',
          payload: { path: '/repo', branch: 'main', files: [{ path: 'fresh.txt', status: 'untracked', staged: false }] },
        }),
      ])

      // Re-arm: the silent counter reset must not latch "already voiced"
      // forever — a second, independent incident on the same worktree must
      // voice its own open event once it crosses the bound again.
      let secondIncidentSnapshot = poll5.nextSnapshot
      for (let failure = 1; failure <= 3; failure += 1) {
        const poll = await gitCollector.poll(secondIncidentSnapshot, makeContext(exec2, 9000 + failure * 1000))
        expect(poll.events).toEqual([])
        expect(poll.nextSnapshot.dirtyFailures['/repo']).toBe(failure)
        secondIncidentSnapshot = poll.nextSnapshot
      }
      const poll6 = await gitCollector.poll(secondIncidentSnapshot, makeContext(exec2, 13000))
      expect(poll6.events).toEqual([
        expect.objectContaining({
          type: 'collector.error',
          payload: expect.objectContaining({
            collector: 'git',
            message: 'git status --porcelain failed 4 times in a row for /repo',
          }),
        }),
      ])
      expect(poll6.nextSnapshot.dirtyFailures['/repo']).toBe(4)
    })

    it('a git status recovery that never crossed the failure bound voices nothing, same as one that did', async () => {
      const exec1 = scriptedExec({
        'git worktree list --porcelain::/repo': ONE_WORKTREE,
        'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo': ONE_REF,
        'git status --porcelain::/repo': '?? scratch.txt\n',
      })
      let snapshot = (await gitCollector.poll(gitCollector.initialSnapshot(), makeContext(exec1, 1000))).nextSnapshot

      const exec2 = execWithFailingStatus({
        'git worktree list --porcelain::/repo': ONE_WORKTREE,
        'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo': ONE_REF,
      })

      // Two failures — below MAX_DIRTY_STATUS_FAILURES, so no incident is
      // ever opened.
      for (let failure = 1; failure <= 2; failure += 1) {
        const poll = await gitCollector.poll(snapshot, makeContext(exec2, 1000 + failure * 1000))
        expect(poll.events).toEqual([])
        snapshot = poll.nextSnapshot
      }

      const exec3 = scriptedExec({
        'git worktree list --porcelain::/repo': ONE_WORKTREE,
        'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo': ONE_REF,
        'git status --porcelain::/repo': '?? scratch.txt\n',
      })
      const recovered = await gitCollector.poll(snapshot, makeContext(exec3, 5000))
      expect(recovered.nextSnapshot.dirtyFailures['/repo']).toBeUndefined()
      expect(recovered.events).toEqual([])
    })

    it('names the exec timeout in the voiced detail rather than going blank — a killed status has neither an errorMessage nor stderr to quote', async () => {
      // The other bounded-failure test fails status with `code: 1` AND stderr,
      // so it only ever exercises the stderr arm. A timeout is the shape with
      // nothing to quote: killed by a signal, so `code` is null, stderr empty,
      // and no `errorMessage` (#306 narrowed that to spawn errors). Without a
      // literal fallback the operator gets `detail: ''` for the one failure
      // mode the carry-forward bound exists to make visible.
      const execTimeout: Exec = async (command, args, options) => {
        if (args[0] === 'status') {
          return { stdout: '', stderr: '', code: null, failed: true }
        }
        const key = `${command} ${args.join(' ')}::${options?.cwd ?? ''}`
        const script: Record<string, string> = {
          'git worktree list --porcelain::/repo': ONE_WORKTREE,
          'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo': ONE_REF,
        }
        const stdout = script[key]
        if (stdout === undefined) throw new Error(`no scripted output for "${key}"`)
        return { stdout, stderr: '', code: 0, failed: false }
      }

      let snapshot = gitCollector.initialSnapshot()
      for (let failure = 1; failure <= MAX_DIRTY_STATUS_FAILURES; failure += 1) {
        snapshot = (await gitCollector.poll(snapshot, makeContext(execTimeout, 1000 + failure * 1000))).nextSnapshot
      }
      const voiced = await gitCollector.poll(snapshot, makeContext(execTimeout, 9000))

      expect(voiced.events).toEqual([
        expect.objectContaining({
          type: 'collector.error',
          payload: expect.objectContaining({
            collector: 'git',
            detail: 'killed with no exit code — the exec timeout',
          }),
        }),
      ])
    })

    it('a killed for-each-ref names the exec timeout too — the branches read is the status read’s structural sibling, and was the unpinned arm', async () => {
      // The status-timeout test above pins one of the two call sites that
      // voice describeGitFailure's third arm; this pins the other. Unlike
      // status, a failed for-each-ref voices immediately (no carry-forward
      // bound), so one poll suffices.
      const execTimeout: Exec = async (command, args, options) => {
        if (args[0] === 'for-each-ref') {
          return { stdout: '', stderr: '', code: null, failed: true }
        }
        const key = `${command} ${args.join(' ')}::${options?.cwd ?? ''}`
        const script: Record<string, string> = {
          'git worktree list --porcelain::/repo': ONE_WORKTREE,
          'git status --porcelain::/repo': '',
        }
        const stdout = script[key]
        if (stdout === undefined) throw new Error(`no scripted output for "${key}"`)
        return { stdout, stderr: '', code: 0, failed: false }
      }

      const poll = await gitCollector.poll(gitCollector.initialSnapshot(), makeContext(execTimeout, 1000))
      expect(poll.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'collector.error',
            payload: expect.objectContaining({
              collector: 'git',
              message: 'git for-each-ref failed',
              detail: 'killed with no exit code — the exec timeout',
            }),
          }),
        ]),
      )
    })

    it('a locked worktree whose directory is gone stays on the bounded-transient path, never worktree.removed — git itself refuses to mark a locked worktree prunable', async () => {
      const lockedWorktrees = `${ONE_WORKTREE}
worktree /repo-worktrees/removable
HEAD 2222222222222222222222222222222222222222
branch refs/heads/removable
locked removable media
`
      const exec1 = scriptedExec({
        'git worktree list --porcelain::/repo': lockedWorktrees,
        'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo':
          `${ONE_REF}removable 2222222222222222222222222222222222222222\n`,
        'git rev-list --left-right --count main...removable::/repo': '0\t1',
        'git status --porcelain::/repo': '',
        'git status --porcelain::/repo-worktrees/removable': '?? draft.md\n',
      })
      const { nextSnapshot } = await gitCollector.poll(gitCollector.initialSnapshot(), makeContext(exec1, 1000))

      // The removable media is unplugged: `git status` fails for it, but the
      // porcelain record carries `locked`, never `prunable` — git's own
      // computation already excludes locked worktrees from prunable.
      const exec2 = execWithFailingStatus({
        'git worktree list --porcelain::/repo': lockedWorktrees,
        'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo':
          `${ONE_REF}removable 2222222222222222222222222222222222222222\n`,
        'git rev-list --left-right --count main...removable::/repo': '0\t1',
      })
      const poll2 = await gitCollector.poll(nextSnapshot, makeContext(exec2, 2000))

      expect(poll2.events).toEqual([])
      expect(poll2.nextSnapshot.worktrees['/repo-worktrees/removable']).toBeDefined()
      expect(poll2.nextSnapshot.dirty['/repo-worktrees/removable']).toEqual([
        { path: 'draft.md', status: 'untracked', staged: false },
      ])
      expect(poll2.nextSnapshot.dirtyFailures['/repo-worktrees/removable']).toBe(1)
    })

    it('resumes from a persisted snapshot with no dirtyFailures key at all, treating it as starting from zero', async () => {
      const exec1 = scriptedExec({
        'git worktree list --porcelain::/repo': ONE_WORKTREE,
        'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo': ONE_REF,
        'git status --porcelain::/repo': '?? scratch.txt\n',
      })
      const { nextSnapshot } = await gitCollector.poll(gitCollector.initialSnapshot(), makeContext(exec1, 1000))

      // Simulate a snapshot written by the pre-fix build: no `dirtyFailures`
      // field survives the round trip through the opaque JSON snapshot store.
      const preFixSnapshot = { ...nextSnapshot } as Record<string, unknown>
      delete preFixSnapshot.dirtyFailures
      const resumed = preFixSnapshot as unknown as typeof nextSnapshot

      const exec2 = execWithFailingStatus({
        'git worktree list --porcelain::/repo': ONE_WORKTREE,
        'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo': ONE_REF,
      })
      const poll2 = await gitCollector.poll(resumed, makeContext(exec2, 2000))

      expect(() => poll2).not.toThrow()
      expect(poll2.nextSnapshot.dirtyFailures['/repo']).toBe(1)
      expect(poll2.nextSnapshot.dirty['/repo']).toEqual([{ path: 'scratch.txt', status: 'untracked', staged: false }])
      expect(poll2.events).toEqual([])
    })
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

  describe('detached main HEAD', () => {
    const DETACHED_MAIN_WORKTREES = `worktree /repo
HEAD 1111111111111111111111111111111111111111
detached

worktree /repo-worktrees/feature-x
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feature-x
`

    const REATTACHED_MAIN_WORKTREES = `worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo-worktrees/feature-x
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feature-x
`

    it('voices a collector.error once, degrades aheadOfMain/behindMain to null, and never calls rev-list', async () => {
      const detachedExec = scriptedExec({
        'git worktree list --porcelain::/repo': DETACHED_MAIN_WORKTREES,
        'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo':
          'feature-x 2222222222222222222222222222222222222222\n',
        'git status --porcelain::/repo': '',
        'git status --porcelain::/repo-worktrees/feature-x': '',
      })

      const first = await gitCollector.poll(gitCollector.initialSnapshot(), makeContext(detachedExec, 1000))

      expect(first.nextSnapshot.mainBranch).toBeNull()
      expect(first.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'collector.error',
            payload: expect.objectContaining({ collector: 'git' }),
          }),
        ]),
      )
      const branchEvent = first.events.find((event) => event.type === 'branch.updated')
      expect(branchEvent?.payload).toEqual(
        expect.objectContaining({ branch: 'feature-x', aheadOfMain: null, behindMain: null }),
      )
      // scriptedExec throws on any un-scripted command — no rev-list entry above
      // means this already proves aheadOfMain/behindMain skip the git call entirely.

      // Same detached state, second poll: no re-voicing, no repeated branch.updated
      // (nothing about feature-x changed).
      const second = await gitCollector.poll(first.nextSnapshot, makeContext(detachedExec, 2000))
      expect(second.events.filter((event) => event.type === 'collector.error')).toHaveLength(0)
      expect(second.events.filter((event) => event.type === 'branch.updated')).toHaveLength(0)

      // Main gets checked out to a branch again: the flag resets...
      const reattachedExec = scriptedExec({
        'git worktree list --porcelain::/repo': REATTACHED_MAIN_WORKTREES,
        'git for-each-ref --format=%(refname:short) %(objectname) refs/heads/::/repo':
          'feature-x 2222222222222222222222222222222222222222\nmain 1111111111111111111111111111111111111111\n',
        'git rev-list --left-right --count main...feature-x::/repo': '0\t0',
        'git status --porcelain::/repo': '',
        'git status --porcelain::/repo-worktrees/feature-x': '',
      })
      const third = await gitCollector.poll(second.nextSnapshot, makeContext(reattachedExec, 3000))
      expect(third.nextSnapshot.mainBranchGapVoiced).toBe(false)

      // ...and detaching again re-voices rather than staying silent forever.
      const fourth = await gitCollector.poll(third.nextSnapshot, makeContext(detachedExec, 4000))
      expect(fourth.events.some((event) => event.type === 'collector.error')).toBe(true)
    })
  })
})
