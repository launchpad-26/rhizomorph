import { describe, expect, it } from 'vitest'
import { CHECKPOINT_AT_38, cellOf } from './fixtures.js'
import { canvasHeightFor, layoutCanvas } from './organism.js'
import { type Paintable, paintPicture } from './paint.js'

/**
 * THE FRAME-BUDGET MEASUREMENT, in the form Stage 1 set and prd-55 keeps
 * (ruling 11: "the 16.67 ms discipline is inherited and, as in Stage 1,
 * reported and never asserted"): the 60 × 3 cell — the harness's own 180
 * threads (prd-49) — laid out AND painted, timed, and printed beside the
 * budget. A wall clock under concurrent workers measures the box, not the
 * code, so the assertion is the count, which is the shape ruling 5 pins.
 *
 * Two figures, because the two stages cost differently: the layout builds 180
 * ribbons through `perfect-freehand` and bakes one contour; the paint is a
 * pass over the finished vertices. A static drawing pays the first once per
 * record and the second once per size — neither per frame.
 */

/** A context that does nothing, so the paint's own walk is what is timed. */
class Sink implements Paintable {
  fillStyle: string | CanvasGradient | CanvasPattern = ''
  strokeStyle: string | CanvasGradient | CanvasPattern = ''
  lineWidth = 1
  lineCap: CanvasLineCap = 'butt'
  lineJoin: CanvasLineJoin = 'miter'
  setTransform() {}
  setLineDash() {}
  clearRect() {}
  beginPath() {}
  moveTo() {}
  lineTo() {}
  closePath() {}
  arc() {}
  rect() {}
  fill() {}
  stroke() {}
}

const FRAME_MS = 1000 / 60
const ROUNDS = 10

describe('lane canvas — the 180-ribbon cell (reported, never asserted)', () => {
  it('lays out and paints 60 arms × 3 runs into exactly 180 ribbons, and reports what each stage cost', () => {
    const experiment = cellOf(60, 3)
    const options = { experiment, checkpoint: CHECKPOINT_AT_38, width: 1000, height: canvasHeightFor(180) }

    // Warm: the first layout bakes the contour and JITs the ribbon brush; a running page never pays that per record.
    let picture = layoutCanvas(options)
    const layoutStarted = performance.now()
    for (let i = 0; i < ROUNDS; i += 1) picture = layoutCanvas(options)
    const layoutMs = (performance.now() - layoutStarted) / ROUNDS

    const sink = new Sink()
    paintPicture(sink, picture, { scale: 1.8, dpr: 2 })
    const paintStarted = performance.now()
    for (let i = 0; i < ROUNDS; i += 1) paintPicture(sink, picture, { scale: 1.8, dpr: 2 })
    const paintMs = (performance.now() - paintStarted) / ROUNDS

    expect(picture.ribbons).toHaveLength(180)
    expect(picture.height).toBe(640)
    // Reported beside the harness's own cells; the 16.67 ms budget is the yardstick, not the assertion.
    console.info(
      `lane canvas · 60×3 = 180 ribbons · layout ${layoutMs.toFixed(3)} ms · paint ${paintMs.toFixed(3)} ms per pass over ${ROUNDS} ` +
        `(budget ${FRAME_MS.toFixed(2)} ms; ratios ${(layoutMs / FRAME_MS).toFixed(3)} / ${(paintMs / FRAME_MS).toFixed(3)})`,
    )
  })
})
