import { describe, expect, it } from 'vitest'
import { createEventFactory } from '../fixtures.js'
import { reduceAll } from '../reduce.js'
import { selectActiveSecondsForLane, selectActiveTimeByLane } from './activity.js'

/**
 * #141 — the fold this file exercises is entirely about counter resets: OTel's
 * `claude_code.active_time.total` is monotonic PER SESSION, but a session that
 * restarts starts counting from zero again, so a naive sum or a naive "latest
 * wins" would both misreport a lane's real total.
 */

describe('selectActiveTimeByLane', () => {
  it('reports the one reading a lane sent', () => {
    const f = createEventFactory()
    const state = reduceAll([f.agentActiveTime({ lane: 'a', sessionId: 'sess-a', activeSeconds: 300 })])
    expect(selectActiveTimeByLane(state)).toEqual([
      { lane: 'a', activeSeconds: 300, sessionIds: ['sess-a'] },
    ])
    expect(selectActiveSecondsForLane(state, 'a')).toBe(300)
  })

  it('takes the latest reading within one session that never reset', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.agentActiveTime({ lane: 'a', sessionId: 'sess-a', activeSeconds: 100 }, { ts: 1_000 }),
      f.agentActiveTime({ lane: 'a', sessionId: 'sess-a', activeSeconds: 250 }, { ts: 2_000 }),
    ])
    expect(selectActiveSecondsForLane(state, 'a')).toBe(250)
  })

  it('takes the high-water mark within a session, not the latest, once it resets', () => {
    const f = createEventFactory()
    // The session climbs to 250s, restarts (a fresh CLI process reports 40s),
    // then climbs again but not past its own former peak. The honest answer
    // is 250 — the largest this one session ever actually reported — never
    // the post-restart 90 a "latest wins" fold would report instead.
    const state = reduceAll([
      f.agentActiveTime({ lane: 'a', sessionId: 'sess-a', activeSeconds: 100 }, { ts: 1_000 }),
      f.agentActiveTime({ lane: 'a', sessionId: 'sess-a', activeSeconds: 250 }, { ts: 2_000 }),
      f.agentActiveTime({ lane: 'a', sessionId: 'sess-a', activeSeconds: 40 }, { ts: 3_000 }),
      f.agentActiveTime({ lane: 'a', sessionId: 'sess-a', activeSeconds: 90 }, { ts: 4_000 }),
    ])
    expect(selectActiveSecondsForLane(state, 'a')).toBe(250)
  })

  it('sums per-session watermarks for a lane with two sessions', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.agentActiveTime({ lane: 'a', sessionId: 'sess-1', activeSeconds: 300 }, { ts: 1_000 }),
      // sess-2 restarts once; its watermark is 400, not the post-restart 120.
      f.agentActiveTime({ lane: 'a', sessionId: 'sess-2', activeSeconds: 400 }, { ts: 1_000 }),
      f.agentActiveTime({ lane: 'a', sessionId: 'sess-2', activeSeconds: 120 }, { ts: 2_000 }),
    ])
    expect(selectActiveSecondsForLane(state, 'a')).toBe(700)
    expect(selectActiveTimeByLane(state)[0]?.sessionIds).toEqual(['sess-1', 'sess-2'])
  })

  it('keeps two lanes apart when each has its own session', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.agentActiveTime({ lane: 'a', sessionId: 'sess-a', activeSeconds: 100 }),
      f.agentActiveTime({ lane: 'b', sessionId: 'sess-b', activeSeconds: 250 }),
    ])
    expect(selectActiveSecondsForLane(state, 'a')).toBe(100)
    expect(selectActiveSecondsForLane(state, 'b')).toBe(250)
  })

  it('treats each session-less reading as its own group rather than folding them together', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.agentActiveTime({ lane: 'a', sessionId: null, activeSeconds: 50 }),
      f.agentActiveTime({ lane: 'a', sessionId: null, activeSeconds: 30 }),
    ])
    // Two independent, session-less readings: 50 + 30, never max(50, 30).
    expect(selectActiveSecondsForLane(state, 'a')).toBe(80)
  })

  it('is null, never zero, for a lane the counter has never reached', () => {
    const f = createEventFactory()
    const state = reduceAll([f.agentActiveTime({ lane: 'a', activeSeconds: 10 })])
    expect(selectActiveSecondsForLane(state, 'no-such-lane')).toBeNull()
    expect(selectActiveSecondsForLane(state, 'a')).not.toBeNull()
  })

  it('is empty for a session with no active-time telemetry at all', () => {
    const f = createEventFactory()
    const state = reduceAll([f.llmUsage({ lane: 'a' })])
    expect(selectActiveTimeByLane(state)).toEqual([])
    expect(selectActiveSecondsForLane(state, 'a')).toBeNull()
  })

  it('orders dearest lane first, name as the tiebreak', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.agentActiveTime({ lane: 'b', sessionId: 'sess-b', activeSeconds: 100 }),
      f.agentActiveTime({ lane: 'a', sessionId: 'sess-a', activeSeconds: 100 }),
      f.agentActiveTime({ lane: 'c', sessionId: 'sess-c', activeSeconds: 500 }),
    ])
    expect(selectActiveTimeByLane(state).map((entry) => entry.lane)).toEqual(['c', 'a', 'b'])
  })
})
