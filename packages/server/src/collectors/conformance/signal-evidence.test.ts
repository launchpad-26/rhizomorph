import { createEvent, UNATTRIBUTED_LANE, type RhizomorphEvent } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { observeEventSignals } from './signal-evidence.js'

let counter = 0
function event<T extends Parameters<typeof createEvent>[0]>(
  type: T,
  payload: Parameters<typeof createEvent<T>>[1],
): RhizomorphEvent {
  return createEvent(type, payload, { id: `id-${(counter += 1)}`, ts: 1_000 })
}

describe('observeEventSignals', () => {
  it('reports every signal absent for an empty event stream', () => {
    const observed = observeEventSignals([])
    expect(observed.identity.emitted).toBe(false)
    expect(observed.activity.emitted).toBe(false)
    expect(observed.telemetry.emitted).toBe(false)
    expect(observed.cost.emitted).toBe(false)
    // liveness/attention have no event home at all — always false here,
    // regardless of what else the stream carries.
    expect(observed.liveness.emitted).toBe(false)
    expect(observed.attention.emitted).toBe(false)
  })

  it('identity requires a lane other than UNATTRIBUTED_LANE — an unattributed event alone is not evidence', () => {
    const events = [
      event('llm.usage', {
        lane: UNATTRIBUTED_LANE,
        role: 'unattributed',
        model: 'claude-sonnet-5',
        tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
      }),
    ]
    expect(observeEventSignals(events).identity.emitted).toBe(false)
  })

  it('identity is proven by one real lane, sibling events staying unattributed', () => {
    const events = [
      event('llm.usage', {
        lane: UNATTRIBUTED_LANE,
        role: 'unattributed',
        model: 'claude-sonnet-5',
        tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
      }),
      event('llm.usage', {
        lane: 'lane-a',
        role: 'worker',
        model: 'claude-sonnet-5',
        tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
      }),
    ]
    expect(observeEventSignals(events).identity.emitted).toBe(true)
  })

  it('telemetry and activity are distinct signals — a tool.activity event alone does not prove telemetry', () => {
    const events = [event('tool.activity', { lane: 'lane-a', tool: 'Bash' })]
    const observed = observeEventSignals(events)
    expect(observed.activity.emitted).toBe(true)
    expect(observed.telemetry.emitted).toBe(false)
  })

  it('cost requires an llm.cost event specifically — llm.usage tokens are not dollars', () => {
    const events = [
      event('llm.usage', {
        lane: 'lane-a',
        role: 'worker',
        model: 'claude-sonnet-5',
        tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
      }),
    ]
    expect(observeEventSignals(events).cost.emitted).toBe(false)

    const withCost = [
      ...events,
      event('llm.cost', {
        lane: 'lane-a',
        role: 'worker',
        model: 'claude-sonnet-5',
        costUsd: 0.01,
        authoritative: true,
      }),
    ]
    expect(observeEventSignals(withCost).cost.emitted).toBe(true)
  })
})
