import type {
  Collector,
  CollectorContext,
  CollectorState,
  EventType,
  Exec,
  PayloadOf,
  PollResult,
} from '@rhizomorph/core'
import { createEvent, createIdFactory } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import type { GitSnapshot } from './git/types.js'
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

// #454: withBranchReconciliation's signature now names GitSnapshot
// concretely rather than a generic bound, so every fake collector here has
// to be a real (if minimal) GitSnapshot, not just "something with branches."
function branchState(head: string): GitSnapshot['branches'][string] {
  return { head, aheadOfMain: null, behindMain: null }
}

function fakeGitSnapshot(branches: GitSnapshot['branches']): GitSnapshot {
  return {
    disabled: false,
    mainBranch: 'main',
    mainBranchGapVoiced: false,
    worktrees: {},
    branches,
    dirty: {},
    dirtyFailures: {},
  }
}

function fakeGitCollector(
  name: string,
  responses: readonly GitSnapshot['branches'][],
): Collector<GitSnapshot> {
  const branchQueue = [...responses]
  return {
    name,
    initialSnapshot: (): GitSnapshot => fakeGitSnapshot({}),
    poll: (_prev: GitSnapshot, _ctx: CollectorContext) => {
      const branches = branchQueue.shift() ?? {}
      return { nextSnapshot: fakeGitSnapshot(branches), events: [] }
    },
  }
}

describe('withBranchReconciliation — fold holds ghost branches, reality has moved on', () => {
  it('emits one branch.removed per ghost the fold believes live but for-each-ref lacks', async () => {
    const inner = fakeGitCollector('git', [{ main: branchState('aaa') }])
    const reconciled = withBranchReconciliation(inner, new Set(['132-old-feature', '134-something', 'main']))

    const result = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))

    expect(result.events.map((event) => event.type)).toEqual(['branch.removed', 'branch.removed'])
    expect(result.events.map((event) => event.payload)).toEqual([
      { branch: '132-old-feature' },
      { branch: '134-something' },
    ])
  })

  it('reconciles only once — a later poll does not re-emit for the same ghosts', async () => {
    const inner = fakeGitCollector('git', [{ main: branchState('aaa') }, { main: branchState('aaa') }])
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
    const inner: Collector<GitSnapshot> = {
      name: 'git',
      initialSnapshot: (): GitSnapshot => fakeGitSnapshot({}),
      poll: (_prev, ctx) => ({
        nextSnapshot: fakeGitSnapshot({}),
        events: [ctx.emit('branch.removed', { branch: '132-old-feature' })],
      }),
    }
    const reconciled = withBranchReconciliation(inner, new Set(['132-old-feature']))

    const result = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))

    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.payload).toEqual({ branch: '132-old-feature' })
  })
})

describe('withBranchReconciliation — the first poll after a resume fails transiently', () => {
  // Same shape as withAgentReconciliation's equivalent test below (#449): a
  // resumed session with no persisted git snapshot whose first poll hits a
  // transient `git worktree list --porcelain` failure (git-collector.ts
  // carries prevSnapshot forward and emits collector.disabled) must not burn
  // its one reconciliation shot on that non-observation. The ghost has to
  // survive to the next poll that actually comes back healthy, and get
  // retired there.
  it('does not latch on a failed poll, and retires the ghost on the next healthy poll', async () => {
    let call = 0
    const inner: Collector<GitSnapshot> = {
      name: 'git',
      initialSnapshot: (): GitSnapshot => fakeGitSnapshot({}),
      poll: (prev, ctx) => {
        call += 1
        if (call === 1) {
          return {
            nextSnapshot: prev,
            events: [
              ctx.emit('collector.disabled', {
                collector: 'git',
                reason: 'git worktree list --porcelain failed',
              }),
            ],
          }
        }
        return { nextSnapshot: fakeGitSnapshot({}), events: [] }
      },
    }
    const reconciled = withBranchReconciliation(inner, new Set(['132-old-feature']))

    const first = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))
    expect(first.events.map((event) => event.type)).toEqual(['collector.disabled'])

    const second = await reconciled.poll(first.nextSnapshot, makeContext(nullExec, 2000))
    expect(second.events.map((event) => event.type)).toEqual(['branch.removed'])
    expect(second.events[0]?.payload).toEqual({ branch: '132-old-feature' })
  })
})

describe('withBranchReconciliation — the first poll after a resume hits a for-each-ref-only failure', () => {
  // Verify report on #449, step 10: `git worktree list` succeeds but `git
  // for-each-ref` fails — the collector emits `collector.error` (not
  // `collector.disabled`) and, per `diffBranches` (`git-collector.ts`),
  // returns `prevSnapshot.branches` completely unchanged (the very same
  // object, not a copy — that's what `nextSnapshot: prev` below models).
  // Both folded branches are still alive on this poll; the fold must not
  // read "no branches observed" as "every folded branch is gone." Only
  // '132-old-feature' is a real ghost — it goes missing on the next, healthy
  // poll, and only then should it be retired.
  it('does not latch on a collector.error-only poll, and retires only the real ghost on the next healthy poll', async () => {
    let call = 0
    const inner: Collector<GitSnapshot> = {
      name: 'git',
      initialSnapshot: (): GitSnapshot => fakeGitSnapshot({}),
      poll: (prev, ctx) => {
        call += 1
        if (call === 1) {
          return {
            nextSnapshot: prev,
            events: [
              ctx.emit('collector.error', {
                collector: 'git',
                message: 'git for-each-ref failed',
              }),
            ],
          }
        }
        return { nextSnapshot: fakeGitSnapshot({ main: branchState('aaa') }), events: [] }
      },
    }
    const reconciled = withBranchReconciliation(inner, new Set(['main', '132-old-feature']))

    const first = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))
    expect(first.events.map((event) => event.type)).toEqual(['collector.error'])

    // The latch was not spent on the failed poll above, so this healthy poll
    // still gets to reconcile — and only the branch actually missing from
    // reality ('132-old-feature') is retired. 'main' is observed live both
    // times and must not be touched.
    const second = await reconciled.poll(first.nextSnapshot, makeContext(nullExec, 2000))
    expect(second.events.map((event) => event.type)).toEqual(['branch.removed'])
    expect(second.events[0]?.payload).toEqual({ branch: '132-old-feature' })
  })
})

describe('withBranchReconciliation — fold and reality already agree', () => {
  it('passes through untouched when there is no folded branch history', async () => {
    const inner = fakeGitCollector('git', [{ main: branchState('aaa') }])
    const reconciled = withBranchReconciliation(inner, undefined)

    const result = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))

    expect(result.events).toHaveLength(0)
  })

  it('passes through untouched when every folded branch is still present in reality', async () => {
    const inner = fakeGitCollector('git', [{ main: branchState('aaa') }])
    const reconciled = withBranchReconciliation(inner, new Set(['main']))

    const result = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))

    expect(result.events).toHaveLength(0)
  })
})

describe('withBranchReconciliation — #454, the observation contract is explicit', () => {
  it('rejects a collector whose snapshot is not a GitSnapshot at compile time', () => {
    interface NotAGitSnapshot {
      branches: Record<string, unknown>
    }
    const notGit: Collector<NotAGitSnapshot> = {
      name: 'not-git',
      initialSnapshot: () => ({ branches: {} }),
      poll: (prev) => ({ nextSnapshot: prev, events: [] }),
    }

    // @ts-expect-error — withBranchReconciliation is no longer generic over
    // any `{ branches }` shape; only a real GitSnapshot type-checks. Before
    // #454 this line compiled fine even though `notGit` never satisfied the
    // identity-allocation contract the wrapper depends on.
    withBranchReconciliation(notGit, new Set(['ghost']))
  })

  it('reports a loud collector.error instead of silently disabling reconciliation forever, when a poll returns unchanged branches with no explaining event', async () => {
    // Models the exact hypothetical #449's re-verify finding warned about: a
    // "nothing changed → return prevSnapshot" fast path that emits neither
    // collector.disabled nor collector.error. Before #454's runtime backstop
    // this poll would silently look like "not observed yet" forever — no
    // event, no log line, and the ghost would never be retired.
    let call = 0
    const inner: Collector<GitSnapshot> = {
      name: 'git',
      initialSnapshot: (): GitSnapshot => fakeGitSnapshot({}),
      poll: (prev, _ctx) => {
        call += 1
        if (call <= 2) return { nextSnapshot: prev, events: [] }
        return { nextSnapshot: fakeGitSnapshot({}), events: [] }
      },
    }
    const reconciled = withBranchReconciliation(inner, new Set(['132-old-feature']))

    const first = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))
    expect(first.events.map((event) => event.type)).toEqual(['collector.error'])
    expect(first.events[0]?.payload).toMatchObject({ collector: 'git' })

    // The violation recurs on the next poll too — it is not a one-shot
    // report, since the contract is broken every tick until whatever
    // regressed it is fixed.
    const second = await reconciled.poll(first.nextSnapshot, makeContext(nullExec, 2000))
    expect(second.events.map((event) => event.type)).toEqual(['collector.error'])

    // The latch was never spent on either broken poll, so a poll that
    // finally does allocate fresh branches still gets to reconcile.
    const third = await reconciled.poll(second.nextSnapshot, makeContext(nullExec, 3000))
    expect(third.events.map((event) => event.type)).toEqual(['branch.removed'])
    expect(third.events[0]?.payload).toEqual({ branch: '132-old-feature' })
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

describe('withAgentReconciliation — the gate asymmetry is not portable', () => {
  // workmux/collector.ts:154 — the missing-binary path returns a *fresh*
  // `agents: {}` alongside collector.disabled, not a carry-forward. Porting
  // withBranchReconciliation's identity gate here would read that as "observed
  // an empty roster" and retire every folded handle. The transient-failure test
  // above cannot catch that: its fake returns `prev`, where both gates agree.
  it('does not latch when a failed poll hands back a fresh empty roster', async () => {
    let call = 0
    const inner: Collector<FakeAgentSnapshot> = {
      name: 'workmux',
      initialSnapshot: (): FakeAgentSnapshot => ({ agents: {} }),
      poll: (_prev: FakeAgentSnapshot, ctx: CollectorContext): PollResult<FakeAgentSnapshot> => {
        call += 1
        if (call === 1) {
          return {
            nextSnapshot: { agents: {} },
            events: [ctx.emit('collector.disabled', { collector: 'workmux', reason: 'workmux binary not found' })],
          }
        }
        return { nextSnapshot: { agents: { 'lane-alpha': { status: 'working' } } }, events: [] }
      },
    }
    const reconciled = withAgentReconciliation(inner, new Set(['lane-alpha']))

    const first = await reconciled.poll(reconciled.initialSnapshot(), makeContext(nullExec, 1000))
    expect(first.events.map((event) => event.type)).toEqual(['collector.disabled'])

    // The handle is alive — a poll that never observed must not have retired it.
    const second = await reconciled.poll(first.nextSnapshot, makeContext(nullExec, 2000))
    expect(second.events).toEqual([])
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
