import { tmpdir } from 'node:os'
import type { Collector, CollectorContext, Exec, ExecResult, EventType, PayloadOf } from '@observatory/core'
import { createEvent, createIdFactory } from '@observatory/core'
import { describe, expect, it } from 'vitest'
import { createSessionlogCollector } from './sessionlog/collector.js'
import { tmuxCollector } from './tmux/collector.js'
import { createWorkmuxCollector } from './workmux/collector.js'
import {
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_RETRY_INTERVAL_MS,
  withResilience,
  type ResilientSnapshot,
} from './resilience.js'

function makeContext(exec: Exec, now: number): CollectorContext {
  const nextId = createIdFactory('evt')
  return {
    repoPath: '/repo',
    now,
    exec,
    nextId,
    emit: <T extends EventType>(type: T, payload: PayloadOf<T>) =>
      createEvent(type, payload, { id: nextId(), ts: now }),
  }
}

interface FakeSnapshot {
  disabled: boolean
  polls: number
}

/**
 * A minimal stand-in for "a collector whose poll can fail on a transient
 * exec" — latches its own `disabled` flag on failure, same convention every
 * real collector here follows, so the wrapper's job (undoing that latch to
 * retry) is exercised the same way it would be against the real thing.
 */
function fakeCollector(name: string, outcomes: readonly ('ok' | 'fail')[]): Collector<FakeSnapshot> & {
  attempts: boolean[]
} {
  const queue = [...outcomes]
  const attempts: boolean[] = []
  return {
    name,
    attempts,
    initialSnapshot: () => ({ disabled: false, polls: 0 }),
    poll: (prev, ctx) => {
      attempts.push(prev.disabled)
      if (prev.disabled) return { nextSnapshot: prev, events: [] }
      const outcome = queue.shift() ?? 'ok'
      if (outcome === 'fail') {
        return {
          nextSnapshot: { ...prev, disabled: true },
          events: [ctx.emit('collector.disabled', { collector: name, reason: `${name} exec failed` })],
        }
      }
      return { nextSnapshot: { disabled: false, polls: prev.polls + 1 }, events: [] }
    },
  }
}

const nullExec: Exec = async () => ({ stdout: '', stderr: '', code: 0, failed: false })

describe('withResilience — one failure does not disable', () => {
  it('retries instead of disabling on a lone failure', async () => {
    const inner = fakeCollector('flaky', ['fail', 'ok'])
    const wrapped = withResilience(inner)
    let snapshot = wrapped.initialSnapshot()

    const tick1 = await wrapped.poll(snapshot, makeContext(nullExec, 1000))
    expect(tick1.events).toHaveLength(1)
    expect(tick1.events[0]?.type).toBe('collector.degraded')
    expect(tick1.events[0]?.payload).toMatchObject({ collector: 'flaky', consecutiveFailures: 1 })
    snapshot = tick1.nextSnapshot

    const tick2 = await wrapped.poll(snapshot, makeContext(nullExec, 2000))
    expect(tick2.events).toHaveLength(1)
    expect(tick2.events[0]?.type).toBe('collector.recovered')
    expect(tick2.nextSnapshot.resilience.consecutiveFailures).toBe(0)
    // The inner collector must have been asked to actually try again, not
    // short-circuited by its own latch from the first failure.
    expect(inner.attempts).toEqual([false, false])
  })
})

describe('withResilience — disables after N consecutive failures', () => {
  it('disables only once the threshold is crossed, with the count in the reason', async () => {
    const inner = fakeCollector('flaky', ['fail', 'fail', 'fail'])
    const wrapped = withResilience(inner, { failureThreshold: 3 })
    let snapshot = wrapped.initialSnapshot()
    let now = 1000

    for (let attempt = 1; attempt < 3; attempt++) {
      const result = await wrapped.poll(snapshot, makeContext(nullExec, now))
      expect(result.events[0]?.type).toBe('collector.degraded')
      expect(result.events[0]?.payload).toMatchObject({ consecutiveFailures: attempt })
      snapshot = result.nextSnapshot
      now += 1000
    }

    const finalResult = await wrapped.poll(snapshot, makeContext(nullExec, now))
    expect(finalResult.events).toHaveLength(1)
    expect(finalResult.events[0]?.type).toBe('collector.disabled')
    expect(finalResult.events[0]?.payload).toMatchObject({ collector: 'flaky', consecutiveFailures: 3 })
    const reason = (finalResult.events[0]?.payload as { reason: string }).reason
    expect(reason).toContain('3 consecutive failures')
    expect(finalResult.nextSnapshot.resilience.disabledAt).toBe(now)
  })
})

describe('withResilience — backoff and self-heal', () => {
  it('skips attempts until the retry interval elapses, then re-enables on success', async () => {
    const inner = fakeCollector('flaky', ['fail', 'fail', 'fail', 'ok'])
    const wrapped = withResilience(inner, { failureThreshold: 3, retryIntervalMs: 10_000 })
    let snapshot = wrapped.initialSnapshot()
    let now = 0

    for (let i = 0; i < 3; i++) {
      const result = await wrapped.poll(snapshot, makeContext(nullExec, now))
      snapshot = result.nextSnapshot
      now += 1000
    }
    expect(snapshot.resilience.disabledAt).not.toBeNull()
    const attemptsBeforeBackoffCheck = inner.attempts.length

    // Still inside the backoff window: the wrapper must not even call the
    // inner poll, let alone retry the exec.
    const skipped = await wrapped.poll(snapshot, makeContext(nullExec, now + 1))
    expect(skipped.events).toHaveLength(0)
    expect(inner.attempts).toHaveLength(attemptsBeforeBackoffCheck)

    // Past the backoff window and the source is healthy again.
    const recovered = await wrapped.poll(snapshot, makeContext(nullExec, snapshot.resilience.nextAttemptAt))
    expect(recovered.events).toHaveLength(1)
    expect(recovered.events[0]?.type).toBe('collector.recovered')
    expect(recovered.events[0]?.payload).toMatchObject({ collector: 'flaky', consecutiveFailures: 3 })
    expect(recovered.nextSnapshot.resilience.consecutiveFailures).toBe(0)
    expect(recovered.nextSnapshot.resilience.disabledAt).toBeNull()
  })

  it('uses the documented defaults when no options are passed', () => {
    expect(DEFAULT_FAILURE_THRESHOLD).toBe(3)
    expect(DEFAULT_RETRY_INTERVAL_MS).toBeGreaterThan(0)
  })
})

describe('withResilience — shared across real collectors', () => {
  it('keeps the tmux collector alive through a transient list-panes failure', async () => {
    const fail: ExecResult = { stdout: '', stderr: '', code: 1, failed: true }
    const ok: ExecResult = { stdout: '', stderr: '', code: 0, failed: false }
    const calls: string[] = []
    const exec: Exec = async (command, args) => {
      calls.push(`${command} ${args[0] ?? ''}`)
      if (command === 'tmux' && args[0] === 'list-panes') {
        return calls.filter((c) => c === 'tmux list-panes').length <= 1 ? fail : ok
      }
      return ok
    }

    const wrapped = withResilience(tmuxCollector, { failureThreshold: 2 })
    let snapshot = wrapped.initialSnapshot()

    const tick1 = await wrapped.poll(snapshot, makeContext(exec, 1000))
    expect(tick1.events[0]?.type).toBe('collector.degraded')
    snapshot = tick1.nextSnapshot as ResilientSnapshot<typeof snapshot.inner>

    const tick2 = await wrapped.poll(snapshot, makeContext(exec, 2000))
    expect(tick2.events.some((event) => event.type === 'collector.recovered')).toBe(true)
    expect(tick2.nextSnapshot.resilience.disabledAt).toBeNull()
  })

  it('keeps the workmux collector alive through a transient status failure', async () => {
    // workmux only treats a failed `status` as disable-worthy when the
    // binary itself couldn't run (see `isMissingBinary`) — an errorMessage
    // is what distinguishes that from a bare non-zero exit.
    const fail: ExecResult = {
      stdout: '',
      stderr: '',
      code: null,
      failed: true,
      errorMessage: 'spawn workmux ENOENT (transient)',
    }
    const ok: ExecResult = { stdout: 'No active agents\n', stderr: '', code: 0, failed: false }
    let statusCalls = 0
    const exec: Exec = async (command, args) => {
      if (command === 'workmux' && args[0] === 'status') {
        statusCalls += 1
        return statusCalls <= 1 ? fail : ok
      }
      return { stdout: 'BRANCH  AGE  AGENT  MUX  UNMERGED  PATH\n', stderr: '', code: 0, failed: false }
    }

    const wrapped = withResilience(createWorkmuxCollector(), { failureThreshold: 2 })
    let snapshot = wrapped.initialSnapshot()

    const tick1 = await wrapped.poll(snapshot, makeContext(exec, 1000))
    expect(tick1.events[0]?.type).toBe('collector.degraded')
    snapshot = tick1.nextSnapshot

    const tick2 = await wrapped.poll(snapshot, makeContext(exec, 2000))
    expect(tick2.events.some((event) => event.type === 'collector.recovered')).toBe(true)
    expect(tick2.nextSnapshot.resilience.disabledAt).toBeNull()
  })

  it('keeps the sessionlog collector alive through a transient git worktree list failure', async () => {
    const fail: ExecResult = { stdout: '', stderr: 'fatal: transient', code: 128, failed: true }
    const ok: ExecResult = { stdout: `${tmpdir()}\n`, stderr: '', code: 0, failed: false }
    let gitCalls = 0
    const exec: Exec = async (command) => {
      if (command === 'git') {
        gitCalls += 1
        return gitCalls <= 1 ? fail : ok
      }
      return { stdout: '', stderr: '', code: 0, failed: false }
    }

    // Point at a directory that genuinely exists (tmpdir()) so the collector
    // gets past its own "no session log directory" disable path and only the
    // git worktree list failure is under test.
    const wrapped = withResilience(createSessionlogCollector({ claudeProjectsRoot: tmpdir() }), {
      failureThreshold: 2,
    })
    let snapshot = wrapped.initialSnapshot()

    const tick1 = await wrapped.poll(snapshot, makeContext(exec, 1000))
    expect(tick1.events[0]?.type).toBe('collector.degraded')
    snapshot = tick1.nextSnapshot

    const tick2 = await wrapped.poll(snapshot, makeContext(exec, 2000))
    expect(tick2.events.some((event) => event.type === 'collector.recovered')).toBe(true)
    expect(tick2.nextSnapshot.resilience.disabledAt).toBeNull()
  })
})

describe('withResilience — snapshot migration', () => {
  it('treats a pre-existing raw snapshot as a fresh resilience start, without discarding the collector state it carries', async () => {
    const inner = fakeCollector('flaky', ['ok'])
    const wrapped = withResilience(inner)

    // A snapshot shaped like what the *unwrapped* collector persisted before
    // this policy existed — no `{inner, resilience}` envelope at all.
    const legacySnapshot = { disabled: false, polls: 41 } as unknown as ResilientSnapshot<FakeSnapshot>

    const result = await wrapped.poll(legacySnapshot, makeContext(nullExec, 1000))
    expect(result.events).toHaveLength(0)
    expect(result.nextSnapshot.resilience).toEqual({
      consecutiveFailures: 0,
      disabledAt: null,
      nextAttemptAt: 0,
    })
    // The collector received its own prior state (`polls: 41`), not a reset.
    expect(inner.attempts).toEqual([false])
    expect(result.nextSnapshot.inner.polls).toBe(42)
  })
})
