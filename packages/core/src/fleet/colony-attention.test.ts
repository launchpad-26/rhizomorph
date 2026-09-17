import { describe, expect, it } from 'vitest'
import { COLONY_NEEDS_YOU_KINDS, colonyAttention, colonyAttentionAll, lanesAcrossColonies } from './colony-attention.js'
import { PATHOLOGY_KINDS, type Pathology, type PathologyKind } from './pathology.js'
import type { Fleet, Lane } from './types.js'

/**
 * prd-58 ruling 5 — an unwatched colony is still heard.
 *
 * The property the whole design rests on: rendering one colony is only
 * acceptable if not rendering the others hides nothing that needs you.
 */

function pathology(kind: PathologyKind): Pathology {
  return { kind, since: 1_000, evidence: `${kind} evidence`, inferred: false, rank: 'needs-you' }
}

function lane(id: string, kinds: PathologyKind[], present = true): Lane {
  return { id, present, pathologies: kinds.map(pathology) } as unknown as Lane
}

function fleet(lanes: Lane[]): Fleet {
  return { lanes } as unknown as Fleet
}

describe('colonyAttention', () => {
  it('counts the three kinds ruling 5 names', () => {
    const counts = colonyAttention('c1', fleet([lane('a', ['waiting']), lane('b', ['crashed']), lane('c', ['frozen'])]))
    expect(counts).toEqual({ colonyId: 'c1', waiting: 1, crashed: 1, frozen: 1, needsYou: 3 })
  })

  it('needsYou is a SUM, not a max', () => {
    // Three lanes needing a human is three things to do. A reader who sees `1`
    // because the worst kind happened once has been told something false about
    // their own morning.
    const counts = colonyAttention('c1', fleet([lane('a', ['waiting']), lane('b', ['waiting']), lane('c', ['waiting'])]))
    expect(counts.needsYou).toBe(3)
  })

  it('counts a lane carrying two of the kinds under both', () => {
    const counts = colonyAttention('c1', fleet([lane('a', ['waiting', 'frozen'])]))
    expect(counts).toMatchObject({ waiting: 1, frozen: 1, needsYou: 2 })
  })

  it('ignores a lane that is not present — a summons to a removed worktree is a false one', () => {
    const counts = colonyAttention('c1', fleet([lane('gone', ['waiting', 'crashed'], false)]))
    expect(counts.needsYou).toBe(0)
  })

  it('does not count the kinds ruling 5 leaves out', () => {
    // `expensive`, `looping` and `off-fence` are real pathologies and
    // none of them is a person being waited on. Counting them would make the
    // badge mean "something is happening", which is every badge nobody reads.
    const others = PATHOLOGY_KINDS.filter((kind) => !(COLONY_NEEDS_YOU_KINDS as readonly string[]).includes(kind))
    expect(others.length).toBeGreaterThan(0)
    const counts = colonyAttention('c1', fleet([lane('a', [...others])]))
    expect(counts.needsYou).toBe(0)
  })

  it('an empty colony counts zero rather than being absent', () => {
    expect(colonyAttention('c1', fleet([]))).toEqual({
      colonyId: 'c1',
      waiting: 0,
      crashed: 0,
      frozen: 0,
      needsYou: 0,
    })
  })
})

describe('colonyAttentionAll — the selector, and the case ruling 5 exists for', () => {
  it('counts a colony that is NOT the rendered one', () => {
    // The whole criterion: "not met while the only way to learn of it is to
    // switch to it". A test that switched first would have tested the thing
    // ruling 5 makes unnecessary.
    const counts = colonyAttentionAll([
      { colonyId: 'rendered', fleet: fleet([lane('a', [])]) },
      { colonyId: 'offscreen', fleet: fleet([lane('b', ['waiting']), lane('c', ['crashed'])]) },
    ])

    expect(counts.find((c) => c.colonyId === 'offscreen')?.needsYou).toBe(2)
    expect(counts.find((c) => c.colonyId === 'rendered')?.needsYou).toBe(0)
  })

  it('keeps the caller order — a row that jumps when a lane changes is unclickable', () => {
    const counts = colonyAttentionAll([
      { colonyId: 'quiet', fleet: fleet([]) },
      { colonyId: 'loud', fleet: fleet([lane('a', ['waiting'])]) },
    ])
    expect(counts.map((c) => c.colonyId)).toEqual(['quiet', 'loud'])
  })
})

describe('lanesAcrossColonies — the fleet list is a table, not a scene', () => {
  it('shows every colony at once, each lane labelled with the colony it is in', () => {
    const rows = lanesAcrossColonies([
      { colonyId: 'one', fleet: fleet([lane('a', []), lane('b', [])]) },
      { colonyId: 'two', fleet: fleet([lane('c', ['waiting'])]) },
    ])

    expect(rows.map((r) => [r.colonyId, r.lane.id])).toEqual([
      ['one', 'a'],
      ['one', 'b'],
      ['two', 'c'],
    ])
  })

  it('a lane is never listed twice, and never under the wrong colony', () => {
    const rows = lanesAcrossColonies([
      { colonyId: 'one', fleet: fleet([lane('shared', [])]) },
      { colonyId: 'two', fleet: fleet([lane('shared', [])]) },
    ])
    // Same lane ID in two colonies is two different lanes. The label is what
    // makes them distinguishable, and losing it would merge two repos' work.
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.colonyId)).toEqual(['one', 'two'])
  })
})
