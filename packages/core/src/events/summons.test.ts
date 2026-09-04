import { describe, expect, it } from 'vitest'
import { createEvent, rhizomorphEventSchema } from './index.js'
import { summonsClearedPayloadSchema, summonsRaisedPayloadSchema } from './summons.js'
import { initialSessionState } from '../state.js'
import { reduce } from '../reduce.js'

const RAISED = { lane: 'feature', kind: 'awaiting-reply', raisedAt: 1000 }
const CLEARED = { lane: 'feature', kind: 'awaiting-reply', clearedAt: 2000 }

describe('summons.raised', () => {
  it('parses a valid payload', () => {
    expect(summonsRaisedPayloadSchema.safeParse(RAISED).success).toBe(true)
  })

  it('round-trips through createEvent with source "gate"', () => {
    const event = createEvent('summons.raised', RAISED, { id: 'evt-1', ts: 1000 })
    expect(event.source).toBe('gate')
    expect(rhizomorphEventSchema.safeParse(event).success).toBe(true)
  })

  it('rejects a missing lane', () => {
    const { lane: _lane, ...withoutLane } = RAISED
    expect(summonsRaisedPayloadSchema.safeParse(withoutLane).success).toBe(false)
  })

  it('rejects a source other than "gate"', () => {
    const result = rhizomorphEventSchema.safeParse({
      id: 'evt-1',
      ts: 1000,
      source: 'system',
      type: 'summons.raised',
      payload: RAISED,
    })
    expect(result.success).toBe(false)
  })
})

describe('summons.cleared', () => {
  it('parses a valid payload', () => {
    expect(summonsClearedPayloadSchema.safeParse(CLEARED).success).toBe(true)
  })

  it('round-trips through createEvent with source "gate"', () => {
    const event = createEvent('summons.cleared', CLEARED, { id: 'evt-2', ts: 2000 })
    expect(event.source).toBe('gate')
    expect(rhizomorphEventSchema.safeParse(event).success).toBe(true)
  })

  it('rejects a missing clearedAt', () => {
    const { clearedAt: _clearedAt, ...withoutClearedAt } = CLEARED
    expect(summonsClearedPayloadSchema.safeParse(withoutClearedAt).success).toBe(false)
  })
})

/**
 * THE SIBLING CASE (issue #219's own mutation): a raise with no clear and a
 * clear with no raise are both real states of the world — a session can end
 * mid-alarm. Neither schema references the other (see summons.ts's doc
 * comments), and the fold must not assume pairing either. Proved at both
 * layers: the schema validates each half alone, and `reduce` folds an orphan
 * of either half without complaint.
 */
describe('the summons pair round-trips independently — a session can end mid-alarm', () => {
  it('a clear with no preceding raise still validates', () => {
    expect(summonsClearedPayloadSchema.safeParse(CLEARED).success).toBe(true)
  })

  it('a raise with no following clear still validates', () => {
    expect(summonsRaisedPayloadSchema.safeParse(RAISED).success).toBe(true)
  })

  it('folding an orphan summons.cleared is counted, not rejected', () => {
    const event = createEvent('summons.cleared', CLEARED, { id: 'evt-orphan-clear', ts: 2000 })
    const state = reduce(initialSessionState(), event)
    expect(state.eventCount).toBe(1)
  })

  it('folding an orphan summons.raised is counted, not rejected', () => {
    const event = createEvent('summons.raised', RAISED, { id: 'evt-orphan-raise', ts: 1000 })
    const state = reduce(initialSessionState(), event)
    expect(state.eventCount).toBe(1)
  })
})
