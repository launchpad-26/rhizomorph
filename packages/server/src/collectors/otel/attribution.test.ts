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

  it('falls back to the unattributed lane when no lane attribute is set, session.id or not', () => {
    expect(resolveLane(undefined, [kv('session.id', 'sess-1')])).toBe('unattributed')
    expect(resolveLane(undefined, undefined)).toBe('unattributed')
  })

  it('never mints a synthetic hash lane across a simulated restart', () => {
    // Same untagged agent, two different session ids (one per boot) — a
    // hash-of-session-id fallback would produce two distinct lanes here.
    const beforeRestart = resolveLane(undefined, [kv('session.id', 'sess-boot-1')])
    const afterRestart = resolveLane(undefined, [kv('session.id', 'sess-boot-2')])
    expect(beforeRestart).toBe('unattributed')
    expect(afterRestart).toBe('unattributed')
    expect(beforeRestart).toBe(afterRestart)
  })
})

describe('resolveRole', () => {
  it('trusts an explicit, valid resource role attribute over everything else', () => {
    expect(resolveRole([kv('role', 'auxiliary')], 'conductor', 'main')).toBe('auxiliary')
  })

  it('ignores a garbage resource role attribute and falls through to the query_source/default path', () => {
    expect(resolveRole([kv('role', 'not-a-real-role')], 'conductor', 'auxiliary')).toBe('auxiliary')
    expect(resolveRole([kv('role', 'not-a-real-role')], 'conductor', undefined)).toBe('worker')
  })

  it('books a lane literally named "conductor" as worker when role=worker is declared', () => {
    expect(resolveRole([kv('role', 'worker')], 'conductor', 'main')).toBe('worker')
  })

  it('books an explicit role=conductor as conductor no matter what the lane is called', () => {
    expect(resolveRole([kv('role', 'conductor')], 'some-other-lane-name', 'main')).toBe('conductor')
    expect(resolveRole([kv('role', 'conductor')], '2-core', undefined)).toBe('conductor')
  })

  it('never infers conductor from the lane string when no role attribute is set', () => {
    expect(resolveRole(undefined, 'conductor', 'main')).toBe('worker')
  })

  it('maps query_source: auxiliary to the auxiliary role', () => {
    expect(resolveRole(undefined, '2-core', 'auxiliary')).toBe('auxiliary')
  })

  it('defaults to worker as a backstop, not an inference channel', () => {
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
