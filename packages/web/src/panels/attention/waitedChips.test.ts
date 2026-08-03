import { describe, expect, it } from 'vitest'
import type { SpanDecision } from '@rhizomorph/core'
import type { Lane } from '../../fleet/index.js'
import { MAX_WAITED_CHIPS, selectWaitedChips } from './waitedChips.js'

/** Just enough of a `Lane` for `selectWaitedChips`, which reads exactly two fields. */
function laneWithWait(
  id: string,
  waitMs: number | null,
  toolName = 'Bash',
  decision: SpanDecision | null = 'accept',
): Lane {
  return {
    id,
    label: id,
    waitedOnHuman: {
      totalWaitMs: waitMs ?? 0,
      waitCount: waitMs === null ? 0 : 1,
      decisions: { accept: 0, reject: 0, unknown: 0 },
      longestWait:
        waitMs === null ? null : { waitMs, toolName, lane: id, traceId: `trace-${id}`, spanId: `span-${id}` },
      longestWaitDecision: waitMs === null ? null : decision,
    },
  } as Lane
}

describe('selectWaitedChips', () => {
  it('is empty when no lane has ever sat blocked on a human', () => {
    expect(selectWaitedChips([laneWithWait('a', null), laneWithWait('b', null)])).toEqual([])
  })

  it('excludes a lane with no wait from the list entirely, never a zero-duration chip', () => {
    const chips = selectWaitedChips([laneWithWait('a', null), laneWithWait('b', 5_000)])
    expect(chips).toHaveLength(1)
    expect(chips[0]?.laneId).toBe('b')
  })

  it('ranks the biggest wait first', () => {
    const chips = selectWaitedChips([
      laneWithWait('a', 5_000),
      laneWithWait('b', 90_000),
      laneWithWait('c', 30_000),
    ])
    expect(chips.map((chip) => chip.laneId)).toEqual(['b', 'c', 'a'])
  })

  it('breaks a tie alphabetically by label, for a deterministic order', () => {
    const chips = selectWaitedChips([laneWithWait('z', 10_000), laneWithWait('a', 10_000)])
    expect(chips.map((chip) => chip.laneId)).toEqual(['a', 'z'])
  })

  it('caps the list at MAX_WAITED_CHIPS, biggest waits surviving the cut', () => {
    const lanes = [
      laneWithWait('a', 10_000),
      laneWithWait('b', 40_000),
      laneWithWait('c', 20_000),
      laneWithWait('d', 50_000),
      laneWithWait('e', 30_000),
    ]
    const chips = selectWaitedChips(lanes)
    expect(chips).toHaveLength(MAX_WAITED_CHIPS)
    expect(chips.map((chip) => chip.laneId)).toEqual(['d', 'b', 'e'])
  })

  it('respects a caller-supplied limit', () => {
    const lanes = [laneWithWait('a', 10_000), laneWithWait('b', 20_000), laneWithWait('c', 30_000)]
    expect(selectWaitedChips(lanes, 1)).toHaveLength(1)
  })

  it("carries the longest wait's OWN decision and tool name, not the census", () => {
    const chips = selectWaitedChips([laneWithWait('a', 10_000, 'Write', 'reject')])
    expect(chips[0]).toMatchObject({ toolName: 'Write', decision: 'reject' })
  })

  it('reports a null decision honestly rather than inventing one', () => {
    const chips = selectWaitedChips([laneWithWait('a', 10_000, 'Bash', null)])
    expect(chips[0]?.decision).toBeNull()
  })
})
