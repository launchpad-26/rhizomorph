import { mkdtemp, rm } from 'node:fs/promises'
import type * as FsPromisesModule from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Collector, PollResult } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readSessionLock } from '../log/session-lock.js'
import { runCli, type CliHandle } from './index.js'

/**
 * A clean stop releases the session log's descriptor.
 *
 * Since prd44 ruling 2 (#31) the log writer holds one descriptor open across
 * appends and releases it in `sync()`. Rotation reaches `sync()` through
 * `closeWith`; a plain shutdown did not reach it at all, so the session open at
 * shutdown was left to garbage collection. Node names that exactly:
 *
 *     [DEP0137] Closing a FileHandle object on garbage collection is deprecated
 *     ... In the future, an error will be thrown ...
 *
 * Found in review of PR #50. `main` at 4140f6b emitted that warning zero times
 * across `src/api/`, `src/cli/` and `src/log/`; PR #50's head emitted it once in
 * `src/cli/`, from this path.
 *
 * **Why a file of its own.** The law needs a module-level `node:fs/promises`
 * mock to count opens against closes, and `cli/index.test.ts` is 1,846 lines
 * with no mock in it — scoping the mock here keeps it off all of them.
 *
 * **What it counts.** Only `.jsonl` opens, which is the session log alone:
 * `ensureHandle()` is the one caller that opens it, `dropTrailingPartialLine`
 * uses `readFile`/`truncate`, and `sync()`'s own `open(path, 'r+')` is gone as
 * of #31. Counting every open in the process would pass on locks and snapshots
 * balancing out while the log's own descriptor leaked.
 *
 * `vi.mock` hoists above the imports, so the counters go through `vi.hoisted` —
 * the same reason, and the same technique, as `session-log-writer.test.ts:16`.
 */
const logHandles = vi.hoisted(() => ({ opens: 0, closes: 0, failSync: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromisesModule>()
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (!String(args[0]).endsWith('.jsonl')) return handle
      logHandles.opens += 1
      const originalClose = handle.close.bind(handle)
      const originalSync = handle.sync.bind(handle)
      handle.close = async () => {
        logHandles.closes += 1
        return originalClose()
      }
      handle.sync = async () => {
        if (logHandles.failSync) throw Object.assign(new Error('simulated fsync failure'), { code: 'EIO' })
        return originalSync()
      }
      return handle
    }) as typeof actual.open,
  }
})

const silentLog = { log: () => {}, warn: () => {} }

/** Emits nothing and never fails — this law is about shutdown, not collection. */
function idleCollector(): Collector<{ n: number }> {
  return {
    name: 'idle',
    initialSnapshot: () => ({ n: 0 }),
    poll: (prev: { n: number }): PollResult<{ n: number }> => ({ events: [], nextSnapshot: prev }),
  }
}

describe("a clean stop releases the session log's descriptor (prd44 ruling 2, review of #50)", () => {
  let dataRoot: string
  let handle: CliHandle | undefined
  const repoPath = path.join(tmpdir(), 'rhizomorph-descriptor-law-repo')

  const boot = async (...argv: readonly string[]): Promise<CliHandle> =>
    await runCli([repoPath, '--port', '0', ...argv], {
      dataRoot,
      now: () => 1_760_000_000_000,
      collectors: [idleCollector()],
      intervalMs: 10_000,
      log: silentLog,
    })

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-descriptor-law-'))
    logHandles.opens = 0
    logHandles.closes = 0
    logHandles.failSync = false
  })

  afterEach(async () => {
    await handle?.stop().catch(() => {})
    handle = undefined
    await rm(dataRoot, { recursive: true, force: true })
  })

  it('closes every descriptor it opened — nothing is left for garbage collection', async () => {
    handle = await boot()
    // The boot records `session.started`, so a descriptor is genuinely open by
    // now. Asserting that first is what stops this law passing vacuously on a
    // build where nothing ever opened the log at all.
    expect(logHandles.opens).toBeGreaterThan(0)
    expect(logHandles.closes).toBeLessThan(logHandles.opens)

    await handle.stop()
    handle = undefined

    expect(logHandles.closes).toBe(logHandles.opens)
  })

  it('a second session is balanced too — the release is not a once-per-process accident', async () => {
    handle = await boot()
    await handle.stop()
    const afterFirst = { ...logHandles }
    expect(afterFirst.closes).toBe(afterFirst.opens)

    // `--fresh`, not a bare reboot: a default boot RESUMES the recent session
    // (`decideSessionBoot`), and a resumed session with an idle collector
    // records nothing, so it never opens the log at all — the assertion below
    // would then pass on a build that had stopped releasing anything.
    handle = await boot('--fresh')
    await handle.stop()
    handle = undefined

    expect(logHandles.opens).toBeGreaterThan(afterFirst.opens)
    expect(logHandles.closes).toBe(logHandles.opens)
  })

  it('a failing fsync reaches the caller AND still releases the session lock', async () => {
    handle = await boot()
    const sessionId = handle.recorder.sessionId
    const sessionDir = path.dirname(handle.recorder.filePath)
    expect(await readSessionLock(sessionDir, sessionId)).not.toBeNull()

    logHandles.failSync = true
    const stopping = handle.stop()
    await expect(stopping).rejects.toThrow(/simulated fsync failure/)
    handle = undefined

    // The sibling case: the lock must not outlive the process because the
    // fsync that ran beside it failed. `finally`, not a sequence.
    expect(await readSessionLock(sessionDir, sessionId)).toBeNull()
  })
})
