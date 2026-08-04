import { describe, expect, it } from 'vitest'
import { branchOutputSpark, LEDGER_SPARK_BUCKET_COUNT, usageEventsByBranch } from './sparkline.js'
import type { UsageRecord } from '@rhizomorph/core'

function usageRecord(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    eventId: 'e1',
    ts: 0,
    origin: 'sessionlog',
    lane: 'a',
    role: 'worker',
    model: 'claude-opus-5',
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    totalTokens: 0,
    requestId: null,
    durationMs: null,
    sessionId: null,
    worktreePath: null,
    branch: 'a',
    thread: null,
    ...overrides,
  }
}

describe('usageEventsByBranch', () => {
  it('groups records by branch, dropping records with no branch at all', () => {
    const byBranch = usageEventsByBranch([
      usageRecord({ branch: 'a', ts: 100, tokens: { input: 0, output: 5, cacheRead: 0, cacheCreation: 0 } }),
      usageRecord({ branch: 'a', ts: 200, tokens: { input: 0, output: 7, cacheRead: 0, cacheCreation: 0 } }),
      usageRecord({ branch: 'b', ts: 150, tokens: { input: 0, output: 3, cacheRead: 0, cacheCreation: 0 } }),
      usageRecord({ branch: null, ts: 300, tokens: { input: 0, output: 999, cacheRead: 0, cacheCreation: 0 } }),
    ])

    expect(byBranch.get('a')).toEqual([{ ts: 100, value: 5 }, { ts: 200, value: 7 }])
    expect(byBranch.get('b')).toEqual([{ ts: 150, value: 3 }])
    expect([...byBranch.values()].flat().some((e) => e.value === 999)).toBe(false)
  })
})

describe('branchOutputSpark', () => {
  const NOW = 1_000_000

  it('produces the fixed bucket count for a branch old enough to fill the window', () => {
    const series = branchOutputSpark([{ ts: NOW - 1_000, value: 42 }], NOW, NOW - 30 * 60_000)
    expect(series).toHaveLength(LEDGER_SPARK_BUCKET_COUNT)
    expect(series.at(-1)).toBe(42)
  })

  it('trims to the branch\'s own firstTs — a young branch draws a short, honest spark', () => {
    const sinceTs = NOW - 6 * 60_000 // two bucket-widths old (3-minute buckets)
    const series = branchOutputSpark([], NOW, sinceTs)
    expect(series).toHaveLength(2)
  })
})
