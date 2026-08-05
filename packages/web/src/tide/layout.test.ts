import { describe, expect, it } from 'vitest'
import { bandsFor, totalDurationMs, type LaneBands } from './bands.js'
import { coalesce } from './coalesce.js'
import { TIDE_START_TS, generateEventLog } from './fixtures.js'
import { layoutBands } from './layout.js'
import { timeScale } from './scale.js'

const T0 = TIDE_START_TS
const SEEDS = [1, 7, 42, 1_337, 90_210]
const WIDTHS = [100, 320, 900]

/** Every generated lane's bands, so the law is checked against real runs, not three fixtures. */
function generatedLanes(): LaneBands[] {
  return SEEDS.flatMap((seed) => bandsFor(generateEventLog(seed, 200)))
}

/** A lane with an observed span to map — a lane seen exactly once has zero duration and is its own, separate law below. */
function withSpan(lanes: readonly LaneBands[]): LaneBands[] {
  return lanes.filter((lane) => lane.lastSeenTs > lane.firstSeenTs)
}

describe('layoutBands — no time invented at the pixel layer', () => {
  it('a lane\'s laid-out band widths sum to the mapped width of its own observed span', () => {
    for (const lane of withSpan(generatedLanes())) {
      for (const width of WIDTHS) {
        const scale = timeScale(lane.firstSeenTs, lane.lastSeenTs, width)
        const laid = layoutBands(lane.bands, scale)
        const summed = laid.reduce((sum, entry) => sum + entry.width, 0)
        // The lane's own span maps to exactly `width` — the laid bands must
        // account for every pixel of it, since bandsFor tiles the span with
        // no gaps between the bands themselves (a gap is a band too).
        expect(summed).toBeCloseTo(width, 5)
      }
    }
  })

  it('holds against a shared session scale too — the same law, but the scale a real render actually uses', () => {
    // Tide never builds a per-lane scale; every row shares one timeScale over
    // the whole session. `bandsFor` always leaves a lane's last band open
    // ("in force at the log's edge"), so under a shared scale every lane's
    // bands reach the bar's own right edge, not just that lane's own
    // `lastSeenTs` — an idle-but-still-open lane visually reaches "now" the
    // same as an active one. The law still holds: no pixel is invented or
    // dropped between a lane's first sighting and the bar's own edge.
    const lanes = withSpan(generatedLanes())
    const sessionStart = Math.min(...lanes.map((l) => l.firstSeenTs))
    const sessionEnd = Math.max(...lanes.map((l) => l.lastSeenTs))
    const scale = timeScale(sessionStart, sessionEnd, 1200)

    for (const lane of lanes) {
      const laid = layoutBands(lane.bands, scale)
      const summed = laid.reduce((sum, entry) => sum + entry.width, 0)
      const expected = scale.width - scale.xOf(lane.firstSeenTs)
      expect(summed).toBeCloseTo(expected, 5)
    }
  })

  it('holds after coalescing too — merging bands must not invent or drop pixels', () => {
    for (const lane of withSpan(generatedLanes())) {
      const scale = timeScale(lane.firstSeenTs, lane.lastSeenTs, 400)
      const coalesced = coalesce(lane.bands, 45_000)
      const laid = layoutBands(coalesced, scale)
      const summed = laid.reduce((sum, entry) => sum + entry.width, 0)
      expect(summed).toBeCloseTo(400, 5)
    }
  })

  it('a band\'s own width is proportional to its own duration', () => {
    const lane = withSpan(generatedLanes()).find((l) => l.bands.length > 1)
    if (lane === undefined) throw new Error('fixture produced no multi-band lane')
    const span = lane.lastSeenTs - lane.firstSeenTs
    const scale = timeScale(lane.firstSeenTs, lane.lastSeenTs, 1000)
    const laid = layoutBands(lane.bands, scale)
    for (const entry of laid) {
      const expected = (entry.band.durationMs / span) * 1000
      expect(entry.width).toBeCloseTo(expected, 5)
    }
  })

  it('a window narrower than the lane\'s span still tiles exactly — clipping loses no pixels', () => {
    const lane = withSpan(generatedLanes()).find((l) => l.bands.length > 2)
    if (lane === undefined) throw new Error('fixture produced no lane with 3+ bands')
    const mid = lane.firstSeenTs + Math.floor((lane.lastSeenTs - lane.firstSeenTs) / 2)
    const scale = timeScale(lane.firstSeenTs, mid, 500)
    const laid = layoutBands(lane.bands, scale)
    const summed = laid.reduce((sum, entry) => sum + entry.width, 0)
    // Bands past `mid` clamp to the right edge and contribute zero width —
    // the sum still exactly fills the bar rather than overshooting it.
    expect(summed).toBeCloseTo(500, 5)
  })

  it('a lane seen exactly once has zero span, and zero span is not stretched to fill a bar', () => {
    const zeroSpan = generatedLanes().find((lane) => lane.lastSeenTs === lane.firstSeenTs)
    if (zeroSpan === undefined) return // the seed set happens not to produce one; the law is untestable, not false
    const scale = timeScale(zeroSpan.firstSeenTs, zeroSpan.firstSeenTs, 900)
    const summed = layoutBands(zeroSpan.bands, scale).reduce((sum, entry) => sum + entry.width, 0)
    expect(summed).toBe(0)
  })

  it('sanity: the fixtures actually exercise multi-band lanes, so the laws above are not vacuous', () => {
    const lanes = generatedLanes()
    expect(lanes.some((l) => l.bands.length > 1)).toBe(true)
    expect(totalDurationMs(lanes[0]?.bands ?? [])).toBeGreaterThanOrEqual(0)
  })
})
