import { describe, expect, it } from 'vitest'
import { resolveLane, resolveRole, shortHash } from './attribution.js'
import type { OtlpKeyValue } from './types.js'

function kv(key: string, stringValue: string): OtlpKeyValue {
  return { key, value: { stringValue } }
}

describe('resolveLane', () => {
  it('prefers the resource lane attribute', () => {
    expect(resolveLane([kv('lane', '2-core')], [kv('session.id', 'sess-1')])).toBe('2-core')
  })

  it('falls back to a short-hash of the datapoint session.id', () => {
    const lane = resolveLane(undefined, [kv('session.id', 'sess-1')])
    expect(lane).toBe(shortHash('sess-1'))
    expect(lane).toMatch(/^[0-9a-f]{8}$/)
  })

  it('is stable for the same session id', () => {
    expect(resolveLane(undefined, [kv('session.id', 'sess-1')])).toBe(
      resolveLane(undefined, [kv('session.id', 'sess-1')]),
    )
  })

  it('falls back to the unattributed lane with neither a lane attribute nor a session id', () => {
    expect(resolveLane(undefined, undefined)).toBe('unattributed')
  })
})

describe('resolveRole', () => {
  it('trusts an explicit, valid resource role attribute over everything else', () => {
    expect(resolveRole([kv('role', 'auxiliary')], 'conductor', 'main')).toBe('auxiliary')
  })

  it('ignores a garbage resource role attribute and falls through', () => {
    expect(resolveRole([kv('role', 'not-a-real-role')], 'conductor', undefined)).toBe('conductor')
  })

  it('infers conductor from the lane when no role attribute is set', () => {
    expect(resolveRole(undefined, 'conductor', 'main')).toBe('conductor')
  })

  it('maps query_source: auxiliary to the auxiliary role', () => {
    expect(resolveRole(undefined, '2-core', 'auxiliary')).toBe('auxiliary')
  })

  it('defaults to worker', () => {
    expect(resolveRole(undefined, '2-core', 'main')).toBe('worker')
    expect(resolveRole(undefined, '2-core', undefined)).toBe('worker')
  })
})

describe('shortHash', () => {
  it('is deterministic and short', () => {
    expect(shortHash('sess-abc')).toBe(shortHash('sess-abc'))
    expect(shortHash('sess-abc')).toHaveLength(8)
  })

  it('differs for different input', () => {
    expect(shortHash('sess-abc')).not.toBe(shortHash('sess-xyz'))
  })
})
