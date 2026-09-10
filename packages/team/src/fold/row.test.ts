import { describe, expect, it } from 'vitest'
import { laneOf, toEventRow, worktreeOf } from './row.js'

/**
 * ONE WIRE LINE -> ONE ROW.
 *
 * The lines here are real event lines that `packages/core`'s own schemas
 * accept, not hand-shaped fixtures: the whole point of using core's lenient
 * reader is that the fold cannot fold something core would refuse, and a
 * fixture invented here would test the fixture.
 */

const USAGE = JSON.stringify({
  id: 'evt_usage_1',
  ts: 1785739192632,
  source: 'sessionlog',
  type: 'llm.usage',
  payload: {
    lane: 'prd51-w3',
    worktreePath: '/repo-wt/prd51-w3',
    role: 'worker',
    model: 'opus',
    tokens: { input: 10, output: 20, cacheRead: 0, cacheCreation: 0 },
  },
})

const SESSION_STARTED = JSON.stringify({
  id: 'evt_session_1',
  ts: 1785739100000,
  source: 'system',
  type: 'session.started',
  payload: { sessionId: 's1', repoPath: '/repo', repoName: 'rhizomorph' },
})

const AGENT_STATUS = JSON.stringify({
  id: 'evt_status_1',
  ts: 1785739192700,
  source: 'workmux',
  type: 'agent.status',
  payload: { handle: 'prd51-w3', status: 'working', worktreePath: '/repo-wt/prd51-w3' },
})

describe('a foldable line becomes a row with every column derived from the event', () => {
  it('llm.usage carries its id, ts, type, source, lane and worktree', () => {
    const result = toEventRow('acme-widgets', 'lane-7', 42, USAGE)
    expect(result.ok).toBe(true)
    expect(result.ok && result.row).toEqual({
      projectId: 'acme-widgets',
      actorInstance: 'lane-7',
      n: 42,
      eventId: 'evt_usage_1',
      tsMs: 1785739192632,
      type: 'llm.usage',
      source: 'sessionlog',
      lane: 'prd51-w3',
      worktree: '/repo-wt/prd51-w3',
      payload: JSON.parse(USAGE).payload,
      line: USAGE,
    })
  })

  /**
   * `line` is the INPUT bytes. The shipper already re-serialized through the
   * current schema (ruling 6); re-serializing again here would be a second
   * transformation of something already canonical, and the failure would be
   * invisible because the row would still parse.
   */
  it('line is the input verbatim, byte for byte', () => {
    // Field order and spacing a re-serialization would normalise away.
    const odd = '{"ts":1785739192632,"id":"e","type":"llm.cost","source":"otel","payload":{"lane":"l","role":"worker","model":"m","costUsd":1,"authoritative":true}}'
    const result = toEventRow('p', 'a', 1, odd)
    expect(result.ok && result.row.line).toBe(odd)
    expect(Buffer.from(result.ok ? result.row.line : '', 'utf8').equals(Buffer.from(odd, 'utf8'))).toBe(true)
  })

  it('session.started has neither a lane nor a worktree, and both are NULL rather than empty', () => {
    const result = toEventRow('acme-widgets', 'lane-7', 1, SESSION_STARTED)
    expect(result.ok && result.row.lane).toBeNull()
    expect(result.ok && result.row.worktree).toBeNull()
    expect(result.ok && result.row.type).toBe('session.started')
  })

  it('agent.status carries its lane under workmux own name for it, `handle`', () => {
    const result = toEventRow('acme-widgets', 'lane-7', 1, AGENT_STATUS)
    expect(result.ok && result.row.lane).toBe('prd51-w3')
    // …and reading only `payload.lane` would have left it null, which would
    // leave lane_state with nothing to key the one event that carries a state on.
    expect(laneOf({ handle: 'h' })).toBe('h')
    expect(laneOf({ lane: 'l', handle: 'h' })).toBe('l')
    expect(laneOf({ branch: 'b' })).toBeNull()
    expect(laneOf({ lane: '' })).toBeNull()
    expect(laneOf(null)).toBeNull()
  })

  it('worktree comes from payload.worktreePath and from nothing else', () => {
    expect(worktreeOf({ worktreePath: '/x' })).toBe('/x')
    expect(worktreeOf({ worktree: '/x' })).toBeNull()
    expect(worktreeOf({ worktreePath: null })).toBeNull()
    expect(worktreeOf(undefined)).toBeNull()
  })
})

describe('an unfoldable line refuses rather than being skipped', () => {
  it('not JSON at all', () => {
    const result = toEventRow('p', 'a', 7, 'nonsense')
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('n=7')
  })

  it('JSON, but not an event envelope', () => {
    const result = toEventRow('p', 'a', 8, '{"hello":"world"}')
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('n=8')
  })

  it('an envelope this era cannot fold names the type and the reason', () => {
    const line = JSON.stringify({ id: 'e', ts: 1, source: 'git', type: 'from.the.future', payload: {} })
    const result = toEventRow('p', 'a', 9, line)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('from.the.future')
    expect(result.ok ? '' : result.error).toContain('unknown-type')
  })

  it('a known type with the wrong payload shape is unfoldable too, not silently stored', () => {
    const line = JSON.stringify({ id: 'e', ts: 1, source: 'otel', type: 'llm.cost', payload: { nope: true } })
    const result = toEventRow('p', 'a', 10, line)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('unknown-shape')
  })

  it('a blank line is a refusal, not a zero-row success', () => {
    expect(toEventRow('p', 'a', 11, '').ok).toBe(false)
    expect(toEventRow('p', 'a', 12, '   ').ok).toBe(false)
  })
})
