import { describe, expect, it } from 'vitest'
import { DARK_PALETTE, LIGHT_PALETTE, type ScenePalette } from '../../scene/palette.js'
import { CHECKPOINT_AT_38, LIVE_TWO_BY_THREE, STOPPED_LAUNCH_FAILED_ARMS } from './fixtures.js'
import { layoutCanvas } from './organism.js'
import { type Paintable, paintHighlight, paintPicture } from './paint.js'

/**
 * THE PAINTER'S LAW: what reaches the canvas is the palette and only the
 * palette. jsdom has no 2D context, so the observable is the sequence of calls
 * — this recorder implements `Paintable` and keeps every colour assigned, in
 * order, which is exactly the surface a stray hex would have to cross.
 */
class Recorder implements Paintable {
  ops: string[] = []
  colours: string[] = []
  // `fillColour`, not `fill`: a field named `fill` would shadow the `fill()` method below
  // on the instance (the previous lane's first draft did exactly that, and every paint went red).
  private fillColour: string | CanvasGradient | CanvasPattern = ''
  private strokeColour: string | CanvasGradient | CanvasPattern = ''
  lineWidth = 1
  lineCap: CanvasLineCap = 'butt'
  lineJoin: CanvasLineJoin = 'miter'
  get fillStyle() {
    return this.fillColour
  }
  set fillStyle(value: string | CanvasGradient | CanvasPattern) {
    this.fillColour = value
    this.colours.push(String(value))
  }
  get strokeStyle() {
    return this.strokeColour
  }
  set strokeStyle(value: string | CanvasGradient | CanvasPattern) {
    this.strokeColour = value
    this.colours.push(String(value))
  }
  setTransform(...args: number[]) {
    this.ops.push(`setTransform ${args.join(' ')}`)
  }
  setLineDash(segments: number[]) {
    this.ops.push(`setLineDash ${segments.join(' ')}`)
  }
  clearRect(...args: number[]) {
    this.ops.push(`clearRect ${args.join(' ')}`)
  }
  beginPath() {
    this.ops.push('beginPath')
  }
  moveTo() {
    this.ops.push('moveTo')
  }
  lineTo() {
    this.ops.push('lineTo')
  }
  closePath() {
    this.ops.push('closePath')
  }
  arc() {
    this.ops.push('arc')
  }
  rect() {
    this.ops.push('rect')
  }
  fill(rule?: CanvasFillRule) {
    this.ops.push(`fill${rule === undefined ? '' : ` ${rule}`}`)
  }
  stroke() {
    this.ops.push('stroke')
  }
}

function paletteConstants(palette: ScenePalette): Set<string> {
  return new Set(
    [...Object.values(palette.status), ...Object.values(palette.register), ...palette.tissue, ...palette.fruit, palette.necrotic, palette.ground].map((rgb) => rgb.join(', ')),
  )
}

/** `rgba(r, g, b, a)` → `r, g, b`. Anything else is not a palette colour and fails by shape. */
function rgbOf(css: string): string {
  const match = /^rgba\((\d+), (\d+), (\d+), (0(?:\.\d+)?|1(?:\.0+)?)\)$/.exec(css)
  if (match === null) throw new Error(`not a palette colour string: ${css}`)
  return `${match[1]}, ${match[2]}, ${match[3]}`
}

describe('the painter fills what the model built and colours it from the palette alone', () => {
  it.each([
    ['dark', DARK_PALETTE],
    ['light', LIGHT_PALETTE],
  ] as const)('%s: every colour assigned while painting the record and its highlight is a palette constant', (_name, palette) => {
    const picture = layoutCanvas({ experiment: LIVE_TWO_BY_THREE, checkpoint: CHECKPOINT_AT_38, failedArms: STOPPED_LAUNCH_FAILED_ARMS, palette })
    const constants = paletteConstants(palette)
    const base = new Recorder()
    paintPicture(base, picture, { scale: 1.5, dpr: 2 })
    const over = new Recorder()
    paintHighlight(over, picture, { hover: 'lane-a1', selected: 'lane-b2' }, { scale: 1.5, dpr: 2 })
    const colours = [...base.colours, ...over.colours]
    expect(colours.length).toBeGreaterThan(20)
    for (const colour of colours) expect(constants.has(rgbOf(colour)), `${colour} is not a palette constant`).toBe(true)
  })

  it('begins with the transform and a clear in picture units, fills a ribbon polygon per dash, and fills a shell even-odd', () => {
    const picture = layoutCanvas({ experiment: LIVE_TWO_BY_THREE, checkpoint: CHECKPOINT_AT_38 })
    const ctx = new Recorder()
    paintPicture(ctx, picture, { scale: 1.5, dpr: 2 })
    expect(ctx.ops[0]).toBe('setTransform 3 0 0 3 0 0')
    expect(ctx.ops[1]).toBe(`clearRect 0 0 ${picture.width} ${picture.height}`)
    const polygons = picture.ribbons.reduce((n, ribbon) => n + ribbon.polygons.length, 0)
    const stubPolygons = picture.stubs.reduce((n, stub) => n + stub.polygons.length, 0)
    const motes = picture.ribbons.reduce((n, ribbon) => n + ribbon.motes.length, 0)
    const shells = picture.root.shells.filter((shell) => shell.rings.length > 0).length
    const discs = picture.ribbons.filter((ribbon) => ribbon.tip.form === 'disc').length
    const squares = picture.ribbons.filter((ribbon) => ribbon.tip.form === 'square').length
    // Plain fills: a polygon per dash, a stub polygon, a mote, the core, a disc tip, a square tip.
    expect(ctx.ops.filter((op) => op === 'fill')).toHaveLength(polygons + stubPolygons + motes + 1 + discs + squares)
    expect(ctx.ops.filter((op) => op === 'fill evenodd')).toHaveLength(shells)
  })

  it('the highlight paints only the picked ribbons — nothing at all when nothing is picked', () => {
    const picture = layoutCanvas({ experiment: LIVE_TWO_BY_THREE, checkpoint: CHECKPOINT_AT_38 })
    const idle = new Recorder()
    paintHighlight(idle, picture, { hover: null, selected: null }, { scale: 1, dpr: 1 })
    expect(idle.ops).toEqual(['setTransform 1 0 0 1 0 0', `clearRect 0 0 ${picture.width} ${picture.height}`])
    const one = new Recorder()
    paintHighlight(one, picture, { hover: 'lane-a1', selected: null }, { scale: 1, dpr: 1 })
    const dashes = picture.ribbons.find((ribbon) => ribbon.id === 'lane-a1')?.polygons.length ?? 0
    expect(one.ops.filter((op) => op === 'fill')).toHaveLength(dashes)
    expect(one.ops.filter((op) => op === 'stroke')).toHaveLength(1)
    const chosen = new Recorder()
    paintHighlight(chosen, picture, { hover: null, selected: 'lane-a1' }, { scale: 1, dpr: 1 })
    expect(chosen.ops.filter((op) => op === 'stroke')).toHaveLength(2)
  })

  it('a real CanvasRenderingContext2D satisfies Paintable — the recorder is a stand-in, not a second contract', () => {
    // The assertion is the assignment, and it is made by the typecheck gate: `Paintable` is a
    // structural subset of the DOM lib's `CanvasRenderingContext2D`, so a member added to the
    // interface that the real context lacks fails `npm run typecheck` on this line. jsdom ships no
    // `CanvasRenderingContext2D` global (it answers `null` for a 2D context), so there is no
    // prototype to probe at runtime — the recorder above is what the suite paints into instead.
    const accepts = (ctx: CanvasRenderingContext2D): Paintable => ctx
    expect(typeof accepts).toBe('function')
    // What CAN be checked here: the recorder answers every member `paintPicture` and `paintHighlight` call.
    const recorder = new Recorder()
    for (const member of ['setTransform', 'setLineDash', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'arc', 'rect', 'fill', 'stroke'] as const) {
      expect(typeof recorder[member], member).toBe('function')
    }
  })
})
