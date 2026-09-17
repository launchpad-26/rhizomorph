import { describe, expect, it } from 'vitest'
import type { DeclaredAttention } from '../state.js'
import {
  attentionReading,
  BEACON_LAPSE_MS,
  CONFIGURED_SILENT_REASON,
  declarationStatus,
  lapsedForMs,
  lapsedVoice,
} from './lapse.js'

/**
 * prd-27 ruling 6 (#218). Two things are under test and they are different:
 * the **boundary** — which is only meaningful because every case below reads
 * `BEACON_LAPSE_MS` rather than typing a literal, so changing the constant
 * moves every case with it — and the **voice**, which is byte-exact because a
 * `TTL ± 1` pair on its own passes at any interval (AGENTS.md's own named
 * failure shape). The constant's *value* is held to the design note by a
 * separate law in `packages/server/src/collectors/beacon/collector.test.ts`;
 * nothing here can pin it, and nothing here pretends to.
 */

const AT = 1_000_000

function beacon(kind: DeclaredAttention['kind'], at = AT): DeclaredAttention {
  return { kind, at, writer: 'claude-hook', digest: 'd'.repeat(64), file: 'claude-hook.jsonl', offset: 0, joinedBy: 'lane' }
}

describe('declarationStatus — the boundary', () => {
  it('reads a working declaration one millisecond inside the interval as live', () => {
    expect(declarationStatus(beacon('working'), AT + BEACON_LAPSE_MS - 1, null)).toBe('live')
  })

  it('reads a working declaration exactly at the interval as live — the boundary is inclusive', () => {
    expect(declarationStatus(beacon('working'), AT + BEACON_LAPSE_MS, null)).toBe('live')
  })

  it('reads a working declaration one millisecond past the interval as lapsed', () => {
    expect(declarationStatus(beacon('working'), AT + BEACON_LAPSE_MS + 1, null)).toBe('lapsed')
  })

  it('lapses a stopped declaration on age alone, exactly as it lapses a working one', () => {
    expect(declarationStatus(beacon('stopped'), AT + BEACON_LAPSE_MS - 1, null)).toBe('live')
    expect(declarationStatus(beacon('stopped'), AT + BEACON_LAPSE_MS + 1, null)).toBe('lapsed')
  })

  it('says nothing at all about a lane nothing was declared for', () => {
    expect(declarationStatus(null, AT + BEACON_LAPSE_MS * 10, null)).toBeNull()
  })
})

describe('declarationStatus — a waiting declaration needs work after it to lapse', () => {
  const now = AT + BEACON_LAPSE_MS + 1

  it('stands past the interval when no work has landed at all — a human takes as long as they take', () => {
    expect(declarationStatus(beacon('waiting'), now, null)).toBe('live')
  })

  it('stands past the interval when the last work is the moment it was declared, not after it', () => {
    expect(declarationStatus(beacon('waiting'), now, AT)).toBe('live')
  })

  it('lapses once work lands after it — the lane went back to work without saying so', () => {
    expect(declarationStatus(beacon('waiting'), now, AT + 1)).toBe('lapsed')
  })

  it('does not lapse on later work while still inside the interval', () => {
    expect(declarationStatus(beacon('waiting'), AT + BEACON_LAPSE_MS, AT + 1)).toBe('live')
  })
})

describe('lapsedForMs and the voice', () => {
  it('counts from the moment the declaration lapsed, not from when it was made', () => {
    expect(lapsedForMs(beacon('working'), AT + BEACON_LAPSE_MS + 60_000)).toBe(60_000)
  })

  it('never reads negative for a declaration that has not lapsed yet', () => {
    expect(lapsedForMs(beacon('working'), AT)).toBe(0)
  })

  it('speaks prd-27 ruling 6 verbatim, to the byte', () => {
    expect(lapsedVoice(60_000)).toBe('declared attention lapsed 1m00s ago; reading turn shape')
  })
})

describe('attentionReading — the three readings plus live', () => {
  const declared: Record<string, DeclaredAttention> = {
    '2-core': beacon('working'),
    '3-web': beacon('waiting'),
  }

  it('reads never-declared when no lane in this session has been declared for', () => {
    expect(attentionReading({}, '2-core', AT, null)).toEqual({ kind: 'never-declared' })
  })

  it('reads configured-silent for a lane with no beacon beside one that has', () => {
    expect(attentionReading(declared, '4-docs', AT, null)).toEqual({ kind: 'configured-silent' })
  })

  it('reads live for a lane whose declaration still stands', () => {
    expect(attentionReading(declared, '2-core', AT + BEACON_LAPSE_MS, null)).toEqual({
      kind: 'live',
      declared: declared['2-core'],
    })
  })

  it('reads lapsed, with how long ago, for a lane whose declaration no longer stands', () => {
    expect(attentionReading(declared, '2-core', AT + BEACON_LAPSE_MS + 60_000, null)).toEqual({
      kind: 'lapsed',
      declared: declared['2-core'],
      lapsedForMs: 60_000,
    })
  })

  it("reads the waiting lane as live past the interval — the kind's own asymmetry, through the reading", () => {
    expect(attentionReading(declared, '3-web', AT + BEACON_LAPSE_MS + 60_000, null).kind).toBe('live')
    expect(attentionReading(declared, '3-web', AT + BEACON_LAPSE_MS + 60_000, AT + 1).kind).toBe('lapsed')
  })

  it('names the configured-but-silent reason the beacon manifest carries, from one constant', () => {
    expect(CONFIGURED_SILENT_REASON).toBe('hooks configured; no beacon for this lane yet')
  })

  it('is a pure function: the same inputs three times give equal answers', () => {
    const at = AT + BEACON_LAPSE_MS + 60_000
    const answers = [0, 1, 2].map(() => attentionReading(declared, '2-core', at, null))
    expect(answers[0]).toEqual(answers[1])
    expect(answers[1]).toEqual(answers[2])
  })
})
