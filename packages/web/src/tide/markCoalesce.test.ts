import { describe, expect, it } from 'vitest'
import type { Chapter } from './chapters.js'
import { coalesceMarks } from './markCoalesce.js'

const T0 = Date.UTC(2026, 7, 4, 14, 0, 0)

function born(lane: string, ts: number): Chapter {
  return { kind: 'lane-born', ts, lane, toolName: null }
}

describe('coalesceMarks — every input mark survives, in exactly one group', () => {
  it('accounts for every chapter across all groups, none dropped or duplicated', () => {
    const chapters = [born('a', T0), born('b', T0 + 100), born('c', T0 + 10_000), born('d', T0 + 10_050)]
    const groups = coalesceMarks(chapters, 1_000)

    const seen = groups.flatMap((group) => group.members)
    expect(seen).toHaveLength(chapters.length)
    for (const chapter of chapters) expect(seen).toContainEqual(chapter)
  })
})

describe('coalesceMarks — clustering', () => {
  it('merges marks within the threshold into one group', () => {
    const chapters = [born('a', T0), born('b', T0 + 500)]
    const groups = coalesceMarks(chapters, 1_000)

    expect(groups).toHaveLength(1)
    expect(groups[0]?.members).toHaveLength(2)
  })

  it('keeps marks farther apart than the threshold in separate groups', () => {
    const chapters = [born('a', T0), born('b', T0 + 5_000)]
    const groups = coalesceMarks(chapters, 1_000)

    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.members.length)).toEqual([1, 1])
  })

  it('chains a dense run into one group even when its total span exceeds the threshold', () => {
    // Each neighbour is 400ms from the last (under the 1000ms threshold), but
    // the run's first and last marks are 1600ms apart — chain-linkage, not a
    // fixed-width bucket, is what a coalescing law demands.
    const chapters = [born('a', T0), born('b', T0 + 400), born('c', T0 + 800), born('d', T0 + 1_600)]
    const groups = coalesceMarks(chapters, 1_000)

    expect(groups).toHaveLength(1)
    expect(groups[0]?.members).toHaveLength(4)
  })

  it('never merges a dense stretch across a wide-open gap just because both stretches are tight', () => {
    const early = [born('a', T0), born('b', T0 + 200)]
    const late = [born('c', T0 + 50_000), born('d', T0 + 50_200)]
    const groups = coalesceMarks([...early, ...late], 1_000)

    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.members.length)).toEqual([2, 2])
  })

  it('a threshold of zero coalesces nothing — every mark is its own group', () => {
    const chapters = [born('a', T0), born('b', T0), born('c', T0 + 1)]
    const groups = coalesceMarks(chapters, 0)
    expect(groups.map((g) => g.members.length)).toEqual([1, 1, 1])
  })
})

describe('coalesceMarks — the seek law: exact, never approximate', () => {
  it("a lone mark's group ts is exactly its own ts", () => {
    const groups = coalesceMarks([born('a', T0 + 42)], 1_000)
    expect(groups[0]?.ts).toBe(T0 + 42)
  })

  it("a cluster's group ts is exactly its earliest member's ts — never a midpoint or average", () => {
    const chapters = [born('a', T0 + 900), born('b', T0), born('c', T0 + 500)]
    const groups = coalesceMarks(chapters, 1_000)

    expect(groups).toHaveLength(1)
    expect(groups[0]?.ts).toBe(T0)
  })
})

describe('coalesceMarks — determinism', () => {
  it('is byte-equal on repeat, and insensitive to input order', () => {
    const chapters = [born('c', T0 + 10_000), born('a', T0), born('b', T0 + 5_000)]
    const once = JSON.stringify(coalesceMarks(chapters, 1_000))
    expect(JSON.stringify(coalesceMarks(chapters, 1_000))).toBe(once)
    expect(JSON.stringify(coalesceMarks([...chapters].reverse(), 1_000))).toBe(once)
  })

  it('an empty run coalesces to nothing', () => {
    expect(coalesceMarks([], 1_000)).toEqual([])
  })
})
