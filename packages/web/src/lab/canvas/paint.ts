import type { Point } from '../../scene/geometry.js'
import { cssColour, type Ink } from '../../scene/palette.js'
import type { CanvasPicture, Ribbon } from './organism.js'

/**
 * THE PAINTER — executes a {@link CanvasPicture} on a Canvas 2D context and
 * decides nothing. Every colour it sets is `cssColour` of an ink the model
 * chose, so what reaches the canvas is the palette and only the palette;
 * `paint.test.ts` records every colour assignment and holds each one to a
 * constant the palette exports.
 *
 * Two layers, two functions, one reason (the DoD's "no per-frame work beyond
 * the paint of what changed"): {@link paintPicture} draws the record and runs
 * only when the record, the size or the theme changes; {@link paintHighlight}
 * draws the hover and the selection on a second canvas over it and runs only
 * when they change. A hover never repaints a ribbon it did not touch.
 *
 * No text is painted here. Type is set in the DOM, through the theme's own
 * tokens (`figures`, `font-sans`), so the lab never spells a face name and a
 * canvas never guesses at one — see `LaneCanvas.tsx`.
 */

/**
 * The subset of `CanvasRenderingContext2D` the painter uses. Named so a test
 * can hand in a recorder: jsdom answers `null` for a 2D context, and the
 * observable is the sequence of calls, not the pixels.
 */
export interface Paintable {
  fillStyle: string | CanvasGradient | CanvasPattern
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  lineCap: CanvasLineCap
  lineJoin: CanvasLineJoin
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  setLineDash(segments: number[]): void
  clearRect(x: number, y: number, width: number, height: number): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  closePath(): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void
  rect(x: number, y: number, width: number, height: number): void
  fill(fillRule?: CanvasFillRule): void
  stroke(): void
}

/** How picture units reach device pixels: the CSS scale of the host, times the device's own ratio. */
export interface PaintTransform {
  scale: number
  dpr: number
}

/** The drop line's dash — a position, not a thread, so it is drawn as a rule rather than a ribbon. */
const DROP_DASH = [3, 5]
const RING_WIDTH = 1.5
const CROSS_WIDTH = 2.2

export function paintPicture(ctx: Paintable, picture: CanvasPicture, transform: PaintTransform): void {
  begin(ctx, picture, transform)

  // The session axis and the fork's drop to the root — hairlines, structure.
  ctx.lineCap = 'butt'
  ctx.lineJoin = 'round'
  strokeLine(ctx, [{ x: picture.axis.from, y: picture.axis.y }, { x: picture.axis.to, y: picture.axis.y }], picture.axis.ink, 1)
  ctx.setLineDash(DROP_DASH)
  strokeLine(ctx, [{ x: picture.drop.x, y: picture.drop.from }, { x: picture.drop.x, y: picture.drop.to }], picture.drop.ink, 1)
  ctx.setLineDash([])

  // The ribbons, then the motes riding the ones that carry nothing.
  for (const ribbon of picture.ribbons) {
    fillPolygons(ctx, ribbon.polygons, ribbon.ink)
    for (const mote of ribbon.motes) fillDisc(ctx, mote.at, mote.radius, mote.ink)
  }

  // The root over the ribbons' inner ends, so they read as threaded into it.
  const { root } = picture
  for (const shell of root.shells) fillRings(ctx, shell.rings, shell.ink)
  ctx.lineCap = 'round'
  for (const strand of root.fan.paths) strokeLine(ctx, strand, root.fan.ink, root.fan.width)
  for (const ring of root.rings) strokeRing(ctx, ring.ring, ring.ink, ring.width)
  fillDisc(ctx, root.at, root.core.radius, root.core.ink)

  // The stubs: drawn and named elsewhere, never counted.
  for (const stub of picture.stubs) fillPolygons(ctx, stub.polygons, stub.ink)

  // The tips last — a verdict is never occluded by a ribbon.
  for (const ribbon of picture.ribbons) paintTip(ctx, ribbon)
}

export interface Highlight {
  hover: string | null
  selected: string | null
}

export function paintHighlight(ctx: Paintable, picture: CanvasPicture, highlight: Highlight, transform: PaintTransform): void {
  begin(ctx, picture, transform)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const ribbon of picture.ribbons) {
    const selected = ribbon.id === highlight.selected
    const hovered = ribbon.id === highlight.hover
    if (!selected && !hovered) continue
    fillPolygons(ctx, ribbon.polygons, picture.emphasis.body)
    // The picked node's ring — and a ghost beyond it for a selection, so the two states read apart.
    strokeDisc(ctx, ribbon.node, ribbon.tip.radius + 4, picture.emphasis.ring, 1.4)
    if (selected) strokeDisc(ctx, ribbon.node, ribbon.tip.radius + 9, { rgb: picture.emphasis.ring.rgb, alpha: picture.emphasis.ring.alpha * 0.3 }, 1)
  }
}

function begin(ctx: Paintable, picture: CanvasPicture, transform: PaintTransform): void {
  const k = transform.scale * transform.dpr
  ctx.setTransform(k, 0, 0, k, 0, 0)
  ctx.clearRect(0, 0, picture.width, picture.height)
}

function paintTip(ctx: Paintable, ribbon: Ribbon): void {
  const { node, tip, tangent } = ribbon
  switch (tip.form) {
    case 'disc':
      fillDisc(ctx, node, tip.radius, tip.ink)
      return
    case 'ring':
      strokeDisc(ctx, node, tip.radius - RING_WIDTH / 2, tip.ink, RING_WIDTH)
      return
    case 'square': {
      ctx.fillStyle = cssColour(tip.ink)
      ctx.beginPath()
      ctx.rect(node.x - tip.radius, node.y - tip.radius, tip.radius * 2, tip.radius * 2)
      ctx.fill()
      return
    }
    case 'cross': {
      // Two strokes at ±45° to the ribbon's own heading, so the cross lies along the thread like a lens does.
      const r = tip.radius
      for (const turn of [Math.PI / 4, -Math.PI / 4]) {
        const angle = tangent + turn
        const dx = Math.cos(angle) * r
        const dy = Math.sin(angle) * r
        strokeLine(ctx, [{ x: node.x - dx, y: node.y - dy }, { x: node.x + dx, y: node.y + dy }], tip.ink, CROSS_WIDTH)
      }
      return
    }
  }
}

function fillPolygons(ctx: Paintable, polygons: readonly (readonly Point[])[], ink: Ink): void {
  ctx.fillStyle = cssColour(ink)
  for (const polygon of polygons) {
    if (polygon.length < 3) continue
    ctx.beginPath()
    trace(ctx, polygon)
    ctx.closePath()
    ctx.fill()
  }
}

/** Every ring of a shell in ONE path, filled even-odd — two nested rings are the band between them. */
function fillRings(ctx: Paintable, rings: readonly (readonly Point[])[], ink: Ink): void {
  if (rings.length === 0) return
  ctx.fillStyle = cssColour(ink)
  ctx.beginPath()
  for (const ring of rings) {
    if (ring.length < 3) continue
    trace(ctx, ring)
    ctx.closePath()
  }
  ctx.fill('evenodd')
}

function strokeRing(ctx: Paintable, ring: readonly Point[], ink: Ink, width: number): void {
  if (ring.length < 3) return
  ctx.strokeStyle = cssColour(ink)
  ctx.lineWidth = width
  ctx.beginPath()
  trace(ctx, ring)
  ctx.closePath()
  ctx.stroke()
}

function strokeLine(ctx: Paintable, points: readonly Point[], ink: Ink, width: number): void {
  if (points.length < 2) return
  ctx.strokeStyle = cssColour(ink)
  ctx.lineWidth = width
  ctx.beginPath()
  trace(ctx, points)
  ctx.stroke()
}

function fillDisc(ctx: Paintable, at: Point, radius: number, ink: Ink): void {
  ctx.fillStyle = cssColour(ink)
  ctx.beginPath()
  ctx.arc(at.x, at.y, radius, 0, Math.PI * 2)
  ctx.fill()
}

function strokeDisc(ctx: Paintable, at: Point, radius: number, ink: Ink, width: number): void {
  ctx.strokeStyle = cssColour(ink)
  ctx.lineWidth = width
  ctx.beginPath()
  ctx.arc(at.x, at.y, radius, 0, Math.PI * 2)
  ctx.stroke()
}

function trace(ctx: Paintable, points: readonly Point[]): void {
  const [first, ...rest] = points
  if (first === undefined) return
  ctx.moveTo(first.x, first.y)
  for (const point of rest) ctx.lineTo(point.x, point.y)
}
