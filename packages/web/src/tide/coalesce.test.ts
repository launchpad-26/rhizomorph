import { describe, expect, it } from 'vitest'
import { bandsFor, totalDurationMs, type Band } from './bands.js'
import { coalesce } from './coalesce.js'
import { TIDE_START_TS, generateEventLog } from './fixtures.js'

const T0 = TIDE_START_TS
const SEEDS = [1, 7, 42, 1_337, 90_210]
/** Thresholds either side of everything the generator produces. */
const THRESHOLDS = [1, 1_000, 60_000, 90_000, 10 * 60_000]

/** A closed band, or — with `endTs: null` — an open one observed `openMs` long. */
function state(
  startTs: number,
  endTs: number | null,
  name: 'working' | 'waiting' | 'done',
  openMs = 0,
): Band {
  return {
    kind: 'state',
    lane: 'ke5',
    state: name,
    startTs,
    endTs,
    durationMs: endTs === null ? openMs : endTs - startTs,
  }
}

function gap(startTs: number, endTs: number | null, openMs = 0): Band {
  return {
    kind: 'gap',
    lane: 'ke5',
    startTs,
    endTs,
    durationMs: endTs === null ? openMs : endTs - startTs,
  }
}

/** Every generated lane's bands, so the laws are checked against real runs. */
function generatedRuns(): Band[][] {
  return SEEDS.flatMap((seed) => bandsFor(generateEventLog(seed, 200)).map((lane) => [...lane.bands]))
}

describe('coalesce — what merging is allowed to cost', () => {
  it('preserves total duration exactly — merging never invents or loses time', () => {
    for (const bands of generatedRuns()) {
      const before = totalDurationMs(bands)
      for (const minSpanMs of THRESHOLDS) {
        expect(totalDurationMs(coalesce(bands, minSpanMs))).toBe(before)
      }
    }
  })

  it('keeps the run contiguous, non-overlapping and open at exactly one end', () => {
    for (const bands of generatedRuns()) {
      for (const minSpanMs of THRESHOLDS) {
        const merged = coalesce(bands, minSpanMs)
        expect(merged.length).toBeGreaterThan(0)
        expect(merged[0]?.startTs).toBe(bands[0]?.startTs)
        expect(merged.filter((band) => band.endTs === null)).toHaveLength(1)
        expect(merged.at(-1)?.endTs).toBe(null)

        for (let i = 0; i + 1 < merged.length; i += 1) {
          const band = merged[i] as Band
          expect(band.endTs).toBe(merged[i + 1]?.startTs)
          expect(band.durationMs).toBe((band.endTs as number) - band.startTs)
        }
      }
    }
  })

  it('leaves no sliver behind: nothing under the threshold survives a merge', () => {
    for (const bands of generatedRuns()) {
      for (const minSpanMs of THRESHOLDS) {
        const merged = coalesce(bands, minSpanMs)
        if (merged.length === 1) continue
        for (const band of merged) expect(band.durationMs).toBeGreaterThanOrEqual(minSpanMs)
      }
    }
  })

  it('returns a lone band untouched, however short — a young lane is not a sliver', () => {
    const lone = [state(T0, null, 'working')]
    expect(coalesce(lone, 10 * 60_000)).toEqual(lone)
  })
})

describe('coalesce — ruling 8 held at the one place it could be traded away', () => {
  it('never swallows a gap the caller could have seen', () => {
    for (const bands of generatedRuns()) {
      for (const minSpanMs of THRESHOLDS) {
        const merged = coalesce(bands, minSpanMs)
        const visible = bands.filter((band) => band.kind === 'gap' && band.durationMs >= minSpanMs)

        for (const original of visible) {
          const survivor = merged.find(
            (band) =>
              band.kind === 'gap' &&
              band.startTs <= original.startTs &&
              (band.endTs ?? Number.POSITIVE_INFINITY) >=
                (original.endTs ?? Number.POSITIVE_INFINITY),
          )
          expect(survivor).toBeDefined()
        }
      }
    }
  })

  it('never invents a state — an all-gap lane stays all gap at every threshold', () => {
    const allGap = [gap(T0, T0 + 60_000), gap(T0 + 60_000, null)]
    for (const minSpanMs of THRESHOLDS) {
      expect(coalesce(allGap, minSpanMs).every((band) => band.kind === 'gap')).toBe(true)
    }

    for (const bands of generatedRuns()) {
      const before = new Set(bands.filter((b) => b.kind === 'state').map((b) => b.state))
      for (const minSpanMs of THRESHOLDS) {
        for (const band of coalesce(bands, minSpanMs)) {
          if (band.kind === 'state') expect(before).toContain(band.state)
        }
      }
    }
  })

  it('lets a sliver gap go, because the caller declared it unrenderable', () => {
    const merged = coalesce(
      [
        state(T0, T0 + 60_000, 'working'),
        gap(T0 + 60_000, T0 + 60_100),
        state(T0 + 60_100, null, 'working', 30_000),
      ],
      1_000,
    )

    expect(merged).toEqual([
      { kind: 'state', lane: 'ke5', state: 'working', startTs: T0, endTs: null, durationMs: 90_100 },
    ])
  })
})

describe('coalesce — how it chooses', () => {
  it('merges a sliver into its longer neighbour', () => {
    const merged = coalesce(
      [
        state(T0, T0 + 10_000, 'waiting'),
        state(T0 + 10_000, T0 + 10_100, 'done'),
        state(T0 + 10_100, null, 'working', 5_000),
      ],
      1_000,
    )

    // The `done` sliver dies into `waiting` (10s) rather than `working` (5s).
    expect(merged.map((band) => (band.kind === 'state' ? band.state : 'gap'))).toEqual([
      'waiting',
      'working',
    ])
    expect(merged[0]).toMatchObject({ startTs: T0, endTs: T0 + 10_100, durationMs: 10_100 })
  })

  it('carries openness across a merge: an absorbed edge is still the edge', () => {
    const merged = coalesce(
      [state(T0, T0 + 60_000, 'working'), state(T0 + 60_000, null, 'waiting')],
      10 * 60_000,
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ endTs: null, startTs: T0 })
  })

  it('folds two abutting bands that say the same thing into one', () => {
    const merged = coalesce(
      [state(T0, T0 + 60_000, 'working'), state(T0 + 60_000, null, 'working')],
      1,
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ startTs: T0, endTs: null, durationMs: 60_000 })
  })
})

describe('coalesce — determinism', () => {
  it('is byte-equal on repeat, and reaches a fixed point in one call', () => {
    for (const bands of generatedRuns()) {
      for (const minSpanMs of THRESHOLDS) {
        const once = coalesce(bands, minSpanMs)
        expect(JSON.stringify(coalesce(bands, minSpanMs))).toBe(JSON.stringify(once))
        expect(JSON.stringify(coalesce(once, minSpanMs))).toBe(JSON.stringify(once))
      }
    }
  })

  it('is a no-op below any duration the run contains', () => {
    for (const bands of generatedRuns()) {
      // Threshold 0: nothing is "shorter than zero", so nothing merges — except
      // the canonicalising fold of abutting like bands, which `bandsFor` never
      // emits in the first place.
      expect(coalesce(bands, 0)).toEqual(bands)
    }
  })
})
