import { buildFleet, fixtureHistory, manifestFor, pathologySpec, reduceAll, type Fleet } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { digestOf, emptyDigest } from './digest.js'

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0)

function pathologyFleet(): Fleet {
  const spec = pathologySpec()
  return buildFleet(reduceAll(fixtureHistory(spec, NOW, 7)), { now: NOW, manifest: manifestFor(spec) })
}

describe('the digest is a projection, not a second derivation', () => {
  const fleet = pathologyFleet()
  const digest = digestOf(fleet)

  it('carries the ladder\'s rung verbatim', () => {
    expect(digest.rank).toBe(fleet.rank)
  })

  it('takes needs-you and broken from the ladder itself, by id', () => {
    expect(digest.needsYou.map((ref) => ref.id)).toEqual(
      fleet.ladder.items.filter((item) => item.rank === 'needs-you').map((item) => item.id),
    )
    expect(digest.broken.map((ref) => ref.id)).toEqual(
      fleet.ladder.items.filter((item) => item.rank === 'broken').map((item) => item.id),
    )
  })

  it('reads the staged fixture as a fleet that wants a human — a vacuous empty ladder would prove nothing', () => {
    expect(digest.needsYou.length + digest.broken.length).toBeGreaterThan(0)
  })

  it('takes landings, spend and lane count off the fleet rather than recounting them', () => {
    expect(digest.landings).toBe(fleet.root.landings)
    expect(digest.costUsd).toBe(fleet.burn.costUsd)
    expect(digest.costIsAuthoritative).toBe(fleet.burn.costIsAuthoritative)
    expect(digest.laneCount).toBe(fleet.lanes.length)
  })

  it('keeps the ladder\'s own ids, so the notifier can tell one tick from the next', () => {
    for (const ref of [...digest.needsYou, ...digest.broken]) {
      expect(ref.id).toMatch(/^[a-z-]+(:.+)?$/)
      expect(fleet.ladder.items.some((item) => item.id === ref.id)).toBe(true)
    }
  })
})

describe('the rung, not a hand-picked pathology', () => {
  it('includes every needs-you item the ladder has, not only the waiting ones', () => {
    const fleet = pathologyFleet()
    const kinds = new Set(digestOf(fleet).needsYou.map((ref) => ref.kind))
    // The staged fixture stages more than one way to need a human. A digest
    // that only carried `waiting` would leave a looping or off-fence lane
    // invisible to the tray while the instrument escalated it on screen.
    expect(kinds.size).toBeGreaterThan(1)
  })
})

describe('before anything has arrived', () => {
  it('is calm, empty, and honest about cost being unmeasured', () => {
    expect(emptyDigest()).toEqual({
      rank: 'calm',
      needsYou: [],
      broken: [],
      landings: 0,
      costUsd: 0,
      costIsAuthoritative: null,
      laneCount: 0,
    })
  })
})
