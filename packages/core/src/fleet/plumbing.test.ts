import { describe, expect, it } from 'vitest'
import { agentStatusSchema, type AgentStatus } from '../events/workmux.js'
import type { Lane, LaneActivity } from './types.js'
import { activityOf } from './plumbing.js'

/**
 * `activityOf` is the seam where the EVENT vocabulary meets the FLEET's.
 *
 * Those are two different sets on purpose. `agentStatusSchema` carries seven
 * words since prd-57 ruling 5; `LaneActivity` carries five and is not widening
 * to match. This file asserts the mapping at the seam rather than through a
 * consumer — `selectors/condition.test.ts` exercises `activityOf` today, but
 * only incidentally, and a mapping change asserted there reads as a consumer
 * regression rather than as the thing it is.
 */

const IDLE_AFTER_MS = 90_000

function laneWith(overrides: Partial<Lane> = {}): Lane {
  return {
    id: 'lane',
    label: 'lane',
    handles: [],
    branch: null,
    worktreePath: null,
    issue: null,
    role: 'worker',
    telemetryOnly: false,
    present: true,
    agentStatus: null,
    pathologies: [],
    workAgeMs: 1_000,
    ...overrides,
  } as unknown as Lane
}

describe('the event vocabulary maps onto the fleet vocabulary (prd-57 ruling 5)', () => {
  it.each<[AgentStatus, LaneActivity]>([
    ['tool-running', 'working'],
    ['waiting-permission', 'waiting'],
    ['stopped', 'done'],
  ])('a declared %s reads as %s', (status, expected) => {
    expect(activityOf(laneWith({ agentStatus: status }))).toBe(expected)
  })

  it('a declared tool call beats the clock — an inference may not overrule a declaration', () => {
    // Work-age well past idle. Without the explicit arm this reads `idle`,
    // which is a clock overruling a harness that just said it is running a
    // tool.
    const stale = laneWith({ agentStatus: 'tool-running', workAgeMs: IDLE_AFTER_MS * 10 })
    expect(activityOf(stale)).toBe('working')
  })

  it('the three original words still mean what they always meant', () => {
    expect(activityOf(laneWith({ agentStatus: 'done' }))).toBe('done')
    expect(activityOf(laneWith({ agentStatus: 'waiting' }))).toBe('waiting')
    expect(activityOf(laneWith({ agentStatus: 'working', workAgeMs: 1_000 }))).toBe('working')
  })

  it('an absent lane is done however it last spoke — present beats status, as before', () => {
    expect(activityOf(laneWith({ agentStatus: 'tool-running', present: false }))).toBe('done')
  })

  it('an inferred waiting pathology still reaches waiting, with no status at all', () => {
    const lane = laneWith({
      agentStatus: null,
      pathologies: [{ kind: 'waiting', rank: 'needs-you', since: 1, evidence: 'inferred' }],
    } as Partial<Lane>)
    expect(activityOf(lane)).toBe('waiting')
  })
})

describe('crashed is not an activity, and does not fall through to the clock', () => {
  it('reads as unknown rather than taking the work-age branch', () => {
    // The failure this test exists to prevent: an unmapped word falls past
    // every arm above and is answered by work-age, so a crashed lane whose
    // transcript was recent reads `working` and a stale one reads `idle`. Both
    // are confident and wrong. `unknown` is weaker and true, and holds only
    // until wave 4 gives the word a home as a PathologyKind.
    expect(activityOf(laneWith({ agentStatus: 'crashed', workAgeMs: 1_000 }))).toBe('unknown')
    expect(activityOf(laneWith({ agentStatus: 'crashed', workAgeMs: IDLE_AFTER_MS * 10 }))).toBe('unknown')
  })

  it('is NOT mapped to done — that is the crash-as-success failure ruling 5 exists to remove', () => {
    expect(activityOf(laneWith({ agentStatus: 'crashed' }))).not.toBe('done')
  })
})

describe('every word the schema admits has an answer here', () => {
  it('no status falls through unconsidered — the enum and this mapping cannot drift apart silently', () => {
    // The guard that makes the rest of this file non-vacuous: if ruling 5's
    // successor adds an eighth word and nobody touches `activityOf`, this fails
    // rather than the word quietly inheriting the work-age branch.
    const answered = new Map<AgentStatus, LaneActivity>()
    for (const status of agentStatusSchema.options) {
      answered.set(status, activityOf(laneWith({ agentStatus: status, workAgeMs: IDLE_AFTER_MS * 10 })))
    }

    // Every word, with a stale clock, so the work-age branch's answer is the
    // one a fall-through would produce — which is what makes an unmapped word
    // visible here rather than plausible.
    expect([...answered.entries()].sort()).toEqual([
      ['crashed', 'unknown'],
      ['done', 'done'],
      ['stopped', 'done'],
      ['tool-running', 'working'],
      ['waiting', 'waiting'],
      ['waiting-permission', 'waiting'],
      ['working', 'idle'],
    ])
    expect(answered.size).toBe(agentStatusSchema.options.length)
  })
})
