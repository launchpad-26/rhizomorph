import type { Band } from './bands.js'
import type { TimeScale } from './scale.js'

/**
 * ONE LANE'S BANDS, IN PIXELS. The law under test: rendering a lane's bands
 * over a span produces widths that sum to the mapped span for that lane — no
 * time is invented at the pixel layer, because every pixel here comes from
 * {@link TimeScale.xOf} and nothing else.
 *
 * `bandsFor` already guarantees the bands tile `[firstSeenTs, lastSeenTs]`
 * contiguously (including the gaps — a gap is a band too); this function does
 * not re-derive that, it only carries the tiling through the one mapping.
 */
export interface LaidBand {
  readonly band: Band
  readonly x: number
  readonly width: number
}

export function layoutBands(bands: readonly Band[], scale: TimeScale): readonly LaidBand[] {
  return bands.map((band) => {
    const x = scale.xOf(band.startTs)
    const right = scale.xOf(band.endTs ?? scale.end)
    return { band, x, width: Math.max(0, right - x) }
  })
}
