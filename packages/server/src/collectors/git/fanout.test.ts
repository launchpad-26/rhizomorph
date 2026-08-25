import { createEvent, createIdFactory } from '@rhizomorph/core'
import type { CollectorContext, Exec, ExecResult } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { COLLECTOR_FANOUT_LIMIT } from '../../server/concurrency.js'
import { gitCollector } from './git-collector.js'

/**
 * THE BOUND, ASSERTED AS A COUNT — issue #35's DoD. Every git call this file
 * cares about is a deferred the test resolves by hand — nothing here is a
 * `setTimeout(n > 0)` or a measured duration, and nothing is named
 * `*.bench.test.ts` or marked `@gate-timing` (see `concurrency.test.ts`'s own
 * header for why even naming that marker in prose is enough to enrol a file —
 * this comment spells it with the two-slash prefix removed on purpose, same
 * as that file does).
 *
 * Both tests below deliberately resolve calls OUT of the order they were
 * issued, so a passing assertion on final event order is proof the collector
 * zips outcomes back by their own index (`refs`/`liveWorktrees`), never by
 * completion order — the byte-identical-replay property the issue asks for.
 */

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

/** Resolves once the microtask queue has drained. A flush, never a duration. */
const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * A gate of deferred `ExecResult`s, released by hand in whatever order the
 * test chooses — never by a timer. `release`/`releaseFailure` target the call
 * at a 0-based registration position (the Nth call this gate has ever
 * received), regardless of when it is released relative to the others, which
 * is what lets a test resolve calls out of order on purpose.
 */
function gate() {
  let live = 0
  let peakSeen = 0
  const pending: (((result: ExecResult) => void) | undefined)[] = []

  function resolveAt(registrationIndex: number, result: ExecResult): void {
    const resolve = pending[registrationIndex]
    if (!resolve) throw new Error(`gate: no pending call registered at index ${registrationIndex}`)
    pending[registrationIndex] = undefined
    live -= 1
    resolve(result)
  }

  return {
    inFlight: () => live,
    peak: () => peakSeen,
    registeredCount: () => pending.length,
    wait: (): Promise<ExecResult> =>
      new Promise<ExecResult>((resolve) => {
        live += 1
        if (live > peakSeen) peakSeen = live
        pending.push(resolve)
      }),
    release(registrationIndex: number, stdout: string): void {
      resolveAt(registrationIndex, { stdout, stderr: '', code: 0, failed: false })
    },
    releaseFailure(registrationIndex: number, stderr: string): void {
      resolveAt(registrationIndex, { stdout: '', stderr, code: 1, failed: true })
    },
  }
}

describe('gitCollector — bounded fan-out (prd-44 ruling 3 / issue #35)', () => {
  it('computeAheadBehind: never more than COLLECTOR_FANOUT_LIMIT rev-list calls in flight, and branch.updated lands in for-each-ref order even though rev-list settles out of order', async () => {
    const WORKTREES = `worktree /repo
HEAD 0000000000000000000000000000000000000000
branch refs/heads/main
`
    // Deliberately not alphabetical and not the release order used below —
    // the assertion at the end is that events follow THIS order regardless.
    const REFS =
      [
        'b3 3333333333333333333333333333333333333333',
        'b1 1111111111111111111111111111111111111111',
        'b5 5555555555555555555555555555555555555555',
        'b2 2222222222222222222222222222222222222222',
        'b4 4444444444444444444444444444444444444444',
        'main 0000000000000000000000000000000000000000',
      ].join('\n') + '\n'

    const revList = gate()
    const exec: Exec = (command, args, options) => {
      if (args[0] === 'worktree') return Promise.resolve({ stdout: WORKTREES, stderr: '', code: 0, failed: false })
      if (args[0] === 'for-each-ref') return Promise.resolve({ stdout: REFS, stderr: '', code: 0, failed: false })
      if (args[0] === 'rev-list') return revList.wait()
      if (args[0] === 'status') return Promise.resolve({ stdout: '', stderr: '', code: 0, failed: false })
      throw new Error(`fanout test: no route for "${command} ${args.join(' ')}" cwd=${options?.cwd ?? ''}`)
    }

    const pollPromise = gitCollector.poll(gitCollector.initialSnapshot(), makeContext(exec, 1000))

    // The main worktree's own branch never touches rev-list at all
    // (`computeAheadBehind` short-circuits to `{0, 0}` for it) — only the
    // five non-main branches (b3, b1, b5, b2, b4, in that for-each-ref order)
    // ever reach this gate, and main sits last in REFS so it can't shift
    // which four register first.
    await flush()
    expect(revList.peak()).toBe(COLLECTOR_FANOUT_LIMIT)
    expect(revList.registeredCount()).toBe(COLLECTOR_FANOUT_LIMIT) // b3, b1, b5, b2

    // Release registration #2 (b5) first — out of both registration order and
    // for-each-ref order. Its worker moves on to register b4 (the 5th task).
    revList.release(2, '0\t5')
    await flush()
    expect(revList.registeredCount()).toBe(COLLECTOR_FANOUT_LIMIT + 1) // + b4
    expect(revList.peak()).toBe(COLLECTOR_FANOUT_LIMIT) // never exceeded, even as b4 starts

    // Release registration #0 (b3) next. Its worker picks up `main`, which
    // resolves instantly without ever touching this gate.
    revList.release(0, '0\t3')
    await flush()
    expect(revList.registeredCount()).toBe(COLLECTOR_FANOUT_LIMIT + 1) // main never registers

    // Drain the rest, still out of order relative to for-each-ref.
    revList.release(4, '0\t4') // b4
    await flush()
    revList.release(1, '0\t1') // b1
    await flush()
    revList.release(3, '0\t2') // b2
    await flush()

    const { events } = await pollPromise

    const branchEvents = events.filter((event) => event.type === 'branch.updated')

    // Order alone doesn't prove the concurrently-resolved rev-list value
    // landed on the RIGHT branch — every one of the six release stdouts
    // above encodes a distinct `aheadOfMain` (b3→3, b1→1, b5→5, b2→2, b4→4),
    // so this also catches a fan-out that reorders events correctly but zips
    // the wrong outcome to the wrong index.
    expect(branchEvents.map((event) => event.payload)).toEqual([
      expect.objectContaining({ branch: 'b3', aheadOfMain: 3, behindMain: 0 }),
      expect.objectContaining({ branch: 'b1', aheadOfMain: 1, behindMain: 0 }),
      expect.objectContaining({ branch: 'b5', aheadOfMain: 5, behindMain: 0 }),
      expect.objectContaining({ branch: 'b2', aheadOfMain: 2, behindMain: 0 }),
      expect.objectContaining({ branch: 'b4', aheadOfMain: 4, behindMain: 0 }),
      expect.objectContaining({ branch: 'main', aheadOfMain: 0, behindMain: 0 }),
    ])
    expect(revList.peak()).toBe(COLLECTOR_FANOUT_LIMIT)
  })

  it('git status --porcelain: never more than COLLECTOR_FANOUT_LIMIT calls in flight, worktree.dirty/dirtyFailures land per-worktree exactly as if run serially, even though status settles out of order', async () => {
    const WORKTREES = `worktree /repo
HEAD 0000000000000000000000000000000000000000
branch refs/heads/main

worktree /repo-worktrees/w1
HEAD 1111111111111111111111111111111111111111
branch refs/heads/w1

worktree /repo-worktrees/w2
HEAD 2222222222222222222222222222222222222222
branch refs/heads/w2

worktree /repo-worktrees/w3
HEAD 3333333333333333333333333333333333333333
branch refs/heads/w3

worktree /repo-worktrees/w4
HEAD 4444444444444444444444444444444444444444
branch refs/heads/w4

worktree /repo-worktrees/w5
HEAD 5555555555555555555555555555555555555555
branch refs/heads/w5
`
    const REFS = 'main 0000000000000000000000000000000000000000\n'

    const status = gate()
    const exec: Exec = (command, args, options) => {
      if (args[0] === 'worktree') return Promise.resolve({ stdout: WORKTREES, stderr: '', code: 0, failed: false })
      if (args[0] === 'for-each-ref') return Promise.resolve({ stdout: REFS, stderr: '', code: 0, failed: false })
      if (args[0] === 'status') return status.wait()
      throw new Error(`fanout test: no route for "${command} ${args.join(' ')}" cwd=${options?.cwd ?? ''}`)
    }

    const pollPromise = gitCollector.poll(gitCollector.initialSnapshot(), makeContext(exec, 1000))

    // No shortcut here (unlike computeAheadBehind) — every one of the six
    // worktrees hits this gate, so registration order is exactly worktree-list
    // order: main(0), w1(1), w2(2), w3(3), w4(4), w5(5).
    await flush()
    expect(status.peak()).toBe(COLLECTOR_FANOUT_LIMIT)
    expect(status.registeredCount()).toBe(COLLECTOR_FANOUT_LIMIT) // main, w1, w2, w3

    // Resolve out of order, mixing one failure in: w2 fails first (its
    // worker then registers w4, the 5th task).
    status.releaseFailure(2, 'error: could not read index')
    await flush()
    expect(status.registeredCount()).toBe(COLLECTOR_FANOUT_LIMIT + 1) // + w4
    expect(status.peak()).toBe(COLLECTOR_FANOUT_LIMIT)

    status.release(0, '') // main: clean
    await flush()
    status.release(3, '') // w3: clean
    await flush()
    status.release(1, '?? w1.txt\n') // w1: dirty
    await flush()
    status.release(4, '?? w4.txt\n') // w4: dirty (registers w5, the 6th task)
    await flush()
    expect(status.registeredCount()).toBe(COLLECTOR_FANOUT_LIMIT + 2)
    status.release(5, '') // w5: clean
    await flush()

    const result = await pollPromise

    expect(status.peak()).toBe(COLLECTOR_FANOUT_LIMIT)

    const dirtyEvents = result.events.filter((event) => event.type === 'worktree.dirty')
    expect(dirtyEvents.map((event) => (event.payload as { path: string }).path)).toEqual([
      '/repo-worktrees/w1',
      '/repo-worktrees/w4',
    ])

    expect(result.nextSnapshot.dirty['/repo']).toEqual([])
    expect(result.nextSnapshot.dirty['/repo-worktrees/w1']).toEqual([
      { path: 'w1.txt', status: 'untracked', staged: false },
    ])
    expect(result.nextSnapshot.dirty['/repo-worktrees/w3']).toEqual([])
    expect(result.nextSnapshot.dirty['/repo-worktrees/w4']).toEqual([
      { path: 'w4.txt', status: 'untracked', staged: false },
    ])
    expect(result.nextSnapshot.dirty['/repo-worktrees/w5']).toEqual([])

    // w2 failed once, below MAX_DIRTY_STATUS_FAILURES — silent carry-forward,
    // no event, counter attributed to w2 alone and nowhere else.
    expect(result.nextSnapshot.dirtyFailures['/repo-worktrees/w2']).toBe(1)
    expect(result.nextSnapshot.dirty['/repo-worktrees/w2']).toBeUndefined()
    expect(result.events.some((event) => event.type === 'worktree.dirtyStatusFailed')).toBe(false)
    expect(Object.keys(result.nextSnapshot.dirtyFailures)).toEqual(['/repo-worktrees/w2'])
  })
})
