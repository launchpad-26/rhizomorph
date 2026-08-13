import type { Collector, CollectorContext, CollectorState, EventType, Exec, PayloadOf } from '@rhizomorph/core'
import { createEvent, createIdFactory } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { withResilience, type ResilientSnapshot } from './resilience.js'
import { withAgentReconciliation, withBranchReconciliation, withResumeReconciliation } from './resume-reconcile.js'

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

function fakeCollector(name: string, outcomes: readonly ('ok' | 'fail')[]) {
  const queue = [...outcomes]
  return {
    name,
    initialSnapshot: (): FakeSnapshot => ({ disabled: false, polls: 0 }),
    poll: (prev: FakeSnapshot, ctx: CollectorContext) => {
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

function foldedState(overrides: Partial<CollectorState>): CollectorState {
  return {
    name: 'flaky',
    status: 'healthy',
    errorCount: 0,
    lastErrorTs: null,
    lastErrorMessage: null,
    consecutiveFailures: 0,
    disabledReason: null,
    disabledAt: null,
    ...overrides,
  }
}

describe('withResumeReconciliation — fold says disabled, memory starts fresh', () => {
  it('emits collector.recovered on the first clean poll after a resume', async () => {
    const inner = fakeCollector('flaky', ['ok'])
    const resilient = withResilience(inner)
    const reconciled = withResumeReconciliation(
      resilient,
      foldedState({ status: 'disabled', consecutiveFailures: 3, disabledAt: 500 }),
    )

    const result = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))

    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.type).toBe('collector.recovered')
    expect(result.events[0]?.payload).toMatchObject({ collector: 'flaky', consecutiveFailures: 3 })
  })

  it('only reconciles once — later polls behave exactly like the inner resilient collector', async () => {
    const inner = fakeCollector('flaky', ['ok', 'fail'])
    const resilient = withResilience(inner, { failureThreshold: 1 })
    const reconciled = withResumeReconciliation(resilient, foldedState({ status: 'disabled' }))

    const first = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))
    expect(first.events[0]?.type).toBe('collector.recovered')

    const second = await reconciled.poll(first.nextSnapshot, makeContext(nullExec, 2000))
    expect(second.events).toHaveLength(1)
    expect(second.events[0]?.type).toBe('collector.disabled')
  })

  it('does not double-emit when the inner wrapper already recovered on its own', async () => {
    // Memory genuinely remembers the failure this time (disabledAt set), so
    // withResilience's own self-heal already fires — reconciliation must not
    // pile a second collector.recovered on top.
    const inner = fakeCollector('flaky', ['ok'])
    const resilient = withResilience(inner)
    const alreadyDisabledSnapshot: ResilientSnapshot<FakeSnapshot> = {
      inner: { disabled: false, polls: 0 },
      resilience: { consecutiveFailures: 3, disabledAt: 500, nextAttemptAt: 0 },
    }
    const reconciled = withResumeReconciliation(resilient, foldedState({ status: 'disabled' }))

    const result = await reconciled.poll(alreadyDisabledSnapshot, makeContext(nullExec, 1000))

    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.type).toBe('collector.recovered')
  })
})

describe('withResumeReconciliation — fold says healthy, memory says disabled', () => {
  it('emits collector.disabled immediately instead of silently honoring the backoff window', async () => {
    const inner = fakeCollector('flaky', ['ok'])
    const resilient = withResilience(inner, { retryIntervalMs: 30_000 })
    const disabledSnapshot: ResilientSnapshot<FakeSnapshot> = {
      inner: { disabled: false, polls: 0 },
      resilience: { consecutiveFailures: 3, disabledAt: 500, nextAttemptAt: 30_500 },
    }
    const reconciled = withResumeReconciliation(resilient, foldedState({ status: 'healthy' }))

    // Still well inside the backoff window (now=1000 < nextAttemptAt=30500):
    // withResilience alone would return zero events here.
    const result = await reconciled.poll(disabledSnapshot, makeContext(nullExec, 1000))

    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.type).toBe('collector.disabled')
    expect(result.events[0]?.payload).toMatchObject({ collector: 'flaky', consecutiveFailures: 3 })
  })
})

describe('withResumeReconciliation — fold and memory already agree', () => {
  it('passes through untouched when the fold has no history for this collector', async () => {
    const inner = fakeCollector('flaky', ['ok'])
    const resilient = withResilience(inner)
    const reconciled = withResumeReconciliation(resilient, undefined)

    const result = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))

    expect(result.events).toHaveLength(0)
  })

  it('passes through untouched when the fold already says healthy and memory agrees', async () => {
    const inner = fakeCollector('flaky', ['ok'])
    const resilient = withResilience(inner)
    const reconciled = withResumeReconciliation(resilient, foldedState({ status: 'healthy' }))

    const result = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))

    expect(result.events).toHaveLength(0)
  })
})

interface FakeBranchSnapshot {
  branches: Record<string, { head: string }>
}

function fakeBranchCollector(
  name: string,
  responses: readonly Record<string, { head: string }>[],
): Collector<FakeBranchSnapshot> {
  const branchQueue = [...responses]
  return {
    name,
    initialSnapshot: (): FakeBranchSnapshot => ({ branches: {} }),
    poll: (_prev: FakeBranchSnapshot, _ctx: CollectorContext) => {
      const branches = branchQueue.shift() ?? {}
      return { nextSnapshot: { branches }, events: [] }
    },
  }
}

describe('withBranchReconciliation — fold holds ghost branches, reality has moved on', () => {
  it('emits one branch.removed per ghost the fold believes live but for-each-ref lacks', async () => {
    const inner = fakeBranchCollector('git', [{ main: { head: 'aaa' } }])
    const reconciled = withBranchReconciliation(inner, new Set(['132-old-feature', '134-something', 'main']))

    const result = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))

    expect(result.events.map((event) => event.type)).toEqual(['branch.removed', 'branch.removed'])
    expect(result.events.map((event) => event.payload)).toEqual([
      { branch: '132-old-feature' },
      { branch: '134-something' },
    ])
  })

  it('reconciles only once — a later poll does not re-emit for the same ghosts', async () => {
    const inner = fakeBranchCollector('git', [{ main: { head: 'aaa' } }, { main: { head: 'aaa' } }])
    const reconciled = withBranchReconciliation(inner, new Set(['132-old-feature']))

    const first = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))
    expect(first.events.map((event) => event.type)).toEqual(['branch.removed'])

    const second = await reconciled.poll(first.nextSnapshot, makeContext(nullExec, 2000))
    expect(second.events).toHaveLength(0)
  })

  it('does not double-report a ghost the inner collector already reported this same poll', async () => {
    // The inner collector's own diff (e.g. #137's snapshot-diff) got to
    // '132-old-feature' independently, in the same poll — reconciliation
    // must not pile a second branch.removed on top of it.
    const inner: Collector<FakeBranchSnapshot> = {
      name: 'git',
      initialSnapshot: (): FakeBranchSnapshot => ({ branches: {} }),
      poll: (_prev, ctx) => ({
        nextSnapshot: { branches: {} },
        events: [ctx.emit('branch.removed', { branch: '132-old-feature' })],
      }),
    }
    const reconciled = withBranchReconciliation(inner, new Set(['132-old-feature']))

    const result = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))

    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.payload).toEqual({ branch: '132-old-feature' })
  })
})

describe('withBranchReconciliation — fold and reality already agree', () => {
  it('passes through untouched when there is no folded branch history', async () => {
    const inner = fakeBranchCollector('git', [{ main: { head: 'aaa' } }])
    const reconciled = withBranchReconciliation(inner, undefined)

    const result = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))

    expect(result.events).toHaveLength(0)
  })

  it('passes through untouched when every folded branch is still present in reality', async () => {
    const inner = fakeBranchCollector('git', [{ main: { head: 'aaa' } }])
    const reconciled = withBranchReconciliation(inner, new Set(['main']))

    const result = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))

    expect(result.events).toHaveLength(0)
  })
})

interface FakeAgentSnapshot {
  agents: Record<string, { status: string }>
}

function fakeAgentCollector(
  name: string,
  responses: readonly Record<string, { status: string }>[],
): Collector<FakeAgentSnapshot> {
  const agentQueue = [...responses]
  return {
    name,
    initialSnapshot: (): FakeAgentSnapshot => ({ agents: {} }),
    poll: (_prev: FakeAgentSnapshot, _ctx: CollectorContext) => {
      const agents = agentQueue.shift() ?? {}
      return { nextSnapshot: { agents }, events: [] }
    },
  }
}

describe('withAgentReconciliation — fold holds ghost agents, reality has moved on', () => {
  it('emits one agent.removed per ghost the fold believes live but workmux status lacks', async () => {
    const inner = fakeAgentCollector('workmux', [{ main: { status: 'working' } }])
    const reconciled = withAgentReconciliation(inner, new Set(['132-old-lane', '134-something', 'main']))

    const result = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))

    expect(result.events.map((event) => event.type)).toEqual(['agent.removed', 'agent.removed'])
    expect(result.events.map((event) => event.payload)).toEqual([
      { handle: '132-old-lane' },
      { handle: '134-something' },
    ])
  })

  // Pins the latch itself, not just "the ghost is gone": the same missing
  // handle is still absent on the second poll, but only the wrapper's
  // reconciled-once flag — not a fresh diff — decides not to re-emit. If
  // `reconciled` were read before calling collector.poll instead of after,
  // this would still pass; the point is the *second* poll below emitting
  // nothing despite the ghost still being missing.
  it('reconciles only once — a later poll does not re-emit for the same ghost', async () => {
    const inner = fakeAgentCollector('workmux', [{ main: { status: 'working' } }, { main: { status: 'working' } }])
    const reconciled = withAgentReconciliation(inner, new Set(['132-old-lane']))

    const first = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))
    expect(first.events.map((event) => event.type)).toEqual(['agent.removed'])

    const second = await reconciled.poll(first.nextSnapshot, makeContext(nullExec, 2000))
    expect(second.events).toHaveLength(0)
  })

  it('does not double-report a ghost the inner collector already reported this same poll', async () => {
    // The inner collector's own diff (#306's live roster diff) got to
    // '132-old-lane' independently, in the same poll — reconciliation must
    // not pile a second agent.removed on top of it.
    const inner: Collector<FakeAgentSnapshot> = {
      name: 'workmux',
      initialSnapshot: (): FakeAgentSnapshot => ({ agents: {} }),
      poll: (_prev, ctx) => ({
        nextSnapshot: { agents: {} },
        events: [ctx.emit('agent.removed', { handle: '132-old-lane' })],
      }),
    }
    const reconciled = withAgentReconciliation(inner, new Set(['132-old-lane']))

    const result = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))

    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.payload).toEqual({ handle: '132-old-lane' })
  })
})

describe('withAgentReconciliation — the first poll after a resume fails transiently', () => {
  // Verify report on #418, steps 8-9: a resumed session with no workmux
  // snapshot whose first poll hits a transient, non-ENOENT workmux failure
  // (ruling 3 direction 1 — the raw collector carries the prior, empty
  // snapshot forward and emits collector.disabled) must not burn its one
  // reconciliation shot on that non-observation. The ghost has to survive to
  // the next poll that actually comes back healthy, and get retired there.
  it('does not latch on a failed poll, and retires the ghost on the next healthy poll', async () => {
    let call = 0
    const inner: Collector<FakeAgentSnapshot> = {
      name: 'workmux',
      initialSnapshot: (): FakeAgentSnapshot => ({ agents: {} }),
      poll: (prev, ctx) => {
        call += 1
        if (call === 1) {
          return {
            nextSnapshot: prev,
            events: [
              ctx.emit('collector.disabled', {
                collector: 'workmux',
                reason: 'workmux: session index corrupted',
              }),
            ],
          }
        }
        return { nextSnapshot: { agents: {} }, events: [] }
      },
    }
    const reconciled = withAgentReconciliation(inner, new Set(['lane-alpha']))

    const first = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))
    expect(first.events.map((event) => event.type)).toEqual(['collector.disabled'])

    const second = await reconciled.poll(first.nextSnapshot, makeContext(nullExec, 2000))
    expect(second.events.map((event) => event.type)).toEqual(['agent.removed'])
    expect(second.events[0]?.payload).toEqual({ handle: 'lane-alpha' })
  })
})

describe('withAgentReconciliation — fold and reality already agree', () => {
  it('passes through untouched when there is no folded agent history', async () => {
    const inner = fakeAgentCollector('workmux', [{ main: { status: 'working' } }])
    const reconciled = withAgentReconciliation(inner, undefined)

    const result = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))

    expect(result.events).toHaveLength(0)
  })

  it('passes through untouched when every folded handle is still present in reality', async () => {
    const inner = fakeAgentCollector('workmux', [{ main: { status: 'working' } }])
    const reconciled = withAgentReconciliation(inner, new Set(['main']))

    const result = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))

    expect(result.events).toHaveLength(0)
  })
})
