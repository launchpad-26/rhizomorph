import { IDENTITY, type Camera } from './camera.js'
import type { Point } from './geometry.js'
import { cssColour } from './palette.js'
import {
  BACKDROP,
  isLinear,
  type ArcMark,
  type ChipMark,
  type GlowMark,
  type Mark,
  type PathMark,
  type Paint,
  type RibbonMark,
  type StrokeMark,
  type TextMark,
} from './marks/index.js'

/**
 * THE EXECUTOR — the only file in the scene that touches a canvas context, and
 * the only one with no opinion about the picture.
 *
 * Every decision (what is bright, what is faded, what shape a state takes) is
 * already made by the time a mark arrives here; this file turns seven mark kinds
 * into canvas calls and nothing else. That seam is what makes the encodings
 * testable: `marks.test.ts` asks the display list what it contains, rather than
 * a screenshot what it looks like.
 *
 * The one rule the executor does own is the blend: **light adds, ink covers.**
 * A `glow` is light — pulses, the root-mass core, a raised hand's halo — so it
 * composites additively and two overlapping pulses read brighter, the way light
 * does. Everything else is pigment and paints over.
 *
 * The second rule it owns is **where** the marks land, which is the whole of
 * the camera as far as drawing is concerned: the picture is painted through
 * `setTransform`, and the chrome is not. See {@link paint}.
 */

export interface PaintOptions {
  ctx: CanvasRenderingContext2D
  marks: readonly Mark[]
  /** The panel, in CSS pixels. Not the world — the world is what the camera moves. */
  width: number
  height: number
  /** Where the scene is being looked at from. Identity until somebody moves. */
  camera?: Camera
  /** Device pixels per CSS pixel. The camera composes on top of it. */
  dpr?: number
}

/** Cached by path data: the same glyph is drawn on every frame, at every node. */
const glyphCache = new Map<string, Path2D>()

/**
 * Two passes, and the difference between them is the camera.
 *
 * **The picture** — every thread, node, pulse and label — is drawn through the
 * camera transform, so panning moves it and zooming magnifies it, strokes and
 * type and all. That is what makes zoom feel like a lens rather than a
 * re-layout: the geometry underneath never changes, so a lane stays at four
 * o'clock however far in you go (graft g7).
 *
 * **The chrome** — the gap voice in the gutter (law 12) — is drawn at device
 * scale only. It is the scene talking *about* the picture rather than part of
 * it, so it stays legible at 0.4× and stays put at 6×, pinned to the panel's
 * bottom-left corner where it was written. A caveat that scrolls off the edge
 * when you pan is a caveat that was not made.
 *
 * The backdrop belongs with the chrome for the same reason: it is the panel's
 * floor, not the void the network hangs in, and it has to cover the canvas
 * whatever the camera is doing.
 */
export function paint({
  ctx,
  marks,
  width,
  height,
  camera = IDENTITY,
  dpr = 1,
}: PaintOptions): void {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const screen = () => ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  screen()
  ctx.fillStyle = cssColour(BACKDROP)
  ctx.fillRect(0, 0, width, height)

  const scale = dpr * camera.k
  ctx.setTransform(scale, 0, 0, scale, dpr * camera.x, dpr * camera.y)
  for (const mark of marks) if (!isChrome(mark)) blend(ctx, mark)

  screen()
  for (const mark of marks) if (isChrome(mark)) blend(ctx, mark)

  ctx.globalCompositeOperation = 'source-over'
  ctx.restore()
}

/** What the camera does not move: the scene's own voice, in the gutter. */
function isChrome(mark: Mark): boolean {
  return mark.role === 'gap'
}

function blend(ctx: CanvasRenderingContext2D, mark: Mark): void {
  ctx.globalCompositeOperation = mark.kind === 'glow' ? 'lighter' : 'source-over'
  draw(ctx, mark)
}

function draw(ctx: CanvasRenderingContext2D, mark: Mark): void {
  switch (mark.kind) {
    case 'ribbon':
      return ribbon(ctx, mark)
    case 'glow':
      return glow(ctx, mark)
    case 'stroke':
      return stroke(ctx, mark)
    case 'arc':
      return arc(ctx, mark)
    case 'path':
      return glyph(ctx, mark)
    case 'text':
      return text(ctx, mark)
    case 'chip':
      return chip(ctx, mark)
  }
}

/**
 * A tapering ribbon along a sampled path, as one filled polygon. A hypha gets
 * thinner as it reaches, and a constant-width stroke would lose that entirely —
 * which is the whole reason the scene draws in filled polygons (ruling 23).
 */
function ribbon(ctx: CanvasRenderingContext2D, mark: RibbonMark): void {
  const { path } = mark
  if (path.length < 2) return
  const last = path.length - 1

  ctx.fillStyle = style(ctx, mark.paint)
  for (const [from, to] of runs(last, mark.dashed === true)) {
    ctx.beginPath()
    for (let i = from; i <= to; i += 1) side(ctx, mark, i, last, 1, i === from)
    for (let i = to; i >= from; i -= 1) side(ctx, mark, i, last, -1, false)
    ctx.closePath()
    ctx.fill()
  }
}

/** One edge of the ribbon at sample `i`, offset along the path's normal. */
function side(
  ctx: CanvasRenderingContext2D,
  mark: RibbonMark,
  i: number,
  last: number,
  sign: number,
  move: boolean,
): void {
  const t = i / last
  const half = ((mark.widthRoot + (mark.widthTip - mark.widthRoot) * t) / 2) * sign
  const point = mark.path[i] as Point
  const tangent = localTangent(mark.path, i)
  const x = point.x - tangent.y * half
  const y = point.y + tangent.x * half
  if (move) ctx.moveTo(x, y)
  else ctx.lineTo(x, y)
}

/**
 * The runs a ribbon is drawn in. A whole thread is one; a severed one is drawn
 * five-on, two-off, because a *dashed* line reads as broken while a merely thin
 * one reads as far away — and FROZEN's whole encoding is that it is broken.
 */
function runs(last: number, dashed: boolean): [number, number][] {
  if (!dashed) return [[0, last]]

  const out: [number, number][] = []
  let start = 0
  for (let i = 0; i <= last; i += 1) {
    if (i % 7 !== 5) continue
    if (i - start > 1) out.push([start, i])
    start = i + 2
  }
  if (last - start > 1) out.push([start, last])
  return out
}

function localTangent(path: readonly Point[], i: number): Point {
  const a = path[Math.max(0, i - 1)] as Point
  const b = path[Math.min(path.length - 1, i + 1)] as Point
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy) || 1
  return { x: dx / length, y: dy / length }
}

/** A soft radial falloff. The only thing in the scene that glows. */
function glow(ctx: CanvasRenderingContext2D, mark: GlowMark): void {
  if (mark.radius <= 0.1) return
  const { x, y } = mark.at
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, mark.radius)
  gradient.addColorStop(0, cssColour(mark.ink))
  gradient.addColorStop(1, cssColour({ rgb: mark.ink.rgb, alpha: 0 }))
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.arc(x, y, mark.radius, 0, Math.PI * 2)
  ctx.fill()
}

function stroke(ctx: CanvasRenderingContext2D, mark: StrokeMark): void {
  if (mark.points.length < 2) return
  ctx.save()
  if (mark.dash !== undefined) ctx.setLineDash([...mark.dash])
  ctx.lineWidth = mark.width
  ctx.strokeStyle = cssColour(mark.ink)
  ctx.beginPath()
  mark.points.forEach((point, i) => {
    if (i === 0) ctx.moveTo(point.x, point.y)
    else ctx.lineTo(point.x, point.y)
  })
  if (mark.closed === true) ctx.closePath()
  ctx.stroke()
  ctx.restore()
}

function arc(ctx: CanvasRenderingContext2D, mark: ArcMark): void {
  ctx.save()
  if (mark.dash !== undefined) ctx.setLineDash([...mark.dash])
  ctx.lineWidth = mark.width
  ctx.strokeStyle = cssColour(mark.ink)
  ctx.beginPath()
  ctx.arc(mark.at.x, mark.at.y, mark.radius, mark.from, mark.to)
  ctx.stroke()
  ctx.restore()
}

/**
 * A glyph from the sigil alphabet, authored in a unit square by `fleet/strokes`
 * and placed here. The same path data draws the fleet table's 15px row mark and
 * the scene's node sigil — one alphabet, one hand (graft g1).
 */
function glyph(ctx: CanvasRenderingContext2D, mark: PathMark): void {
  let path = glyphCache.get(mark.d)
  if (path === undefined) {
    path = new Path2D(mark.d)
    glyphCache.set(mark.d, path)
  }

  ctx.save()
  ctx.translate(mark.at.x, mark.at.y)
  ctx.rotate(mark.rotate)
  ctx.scale(mark.size, mark.size * (mark.squash ?? 1))
  // Authored around (0.5, 0.5); placed by its centre.
  ctx.translate(-0.5, -0.5)

  if (mark.stroke === undefined) {
    ctx.fillStyle = cssColour(mark.ink)
    ctx.fill(path)
  } else {
    // The transform is in glyph units, so a line width in pixels has to be
    // divided back out or a scaled-up mark would grow a scaled-up outline.
    ctx.lineWidth = mark.stroke / mark.size
    ctx.strokeStyle = cssColour(mark.ink)
    ctx.stroke(path)
  }
  ctx.restore()
}

/**
 * Law 11: sans for names, mono for every figure. Canvas has no
 * `font-variant-numeric`, so the law's "tabular numerals" clause is carried by
 * the choice of a monospaced face — in which every figure is the same width by
 * construction rather than by an opt-in feature the canvas cannot request.
 */
const FONT: Record<TextMark['font'], string> = {
  sans: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, 'JetBrains Mono', monospace",
}

const ALIGN: Record<TextMark['align'], CanvasTextAlign> = {
  left: 'left',
  right: 'right',
  centre: 'center',
}

function text(ctx: CanvasRenderingContext2D, mark: TextMark): void {
  ctx.save()
  ctx.font = `${mark.weight} ${mark.size}px ${FONT[mark.font]}`
  ctx.textAlign = ALIGN[mark.align]
  ctx.textBaseline = 'middle'
  ctx.fillStyle = cssColour(mark.ink)
  ctx.fillText(mark.text, mark.at.x, mark.at.y)
  ctx.restore()
}

function chip(ctx: CanvasRenderingContext2D, mark: ChipMark): void {
  ctx.fillStyle = cssColour(mark.fill)
  ctx.fillRect(mark.at.x, mark.at.y, mark.width, mark.height)
  ctx.lineWidth = 1
  ctx.strokeStyle = cssColour(mark.border)
  ctx.strokeRect(mark.at.x, mark.at.y, mark.width, mark.height)
}

/** A flat ink, or the brightness ramp the reduced-motion flow treatment needs. */
function style(ctx: CanvasRenderingContext2D, paint: Paint): string | CanvasGradient {
  if (!isLinear(paint)) return cssColour(paint)
  const gradient = ctx.createLinearGradient(paint.from.x, paint.from.y, paint.to.x, paint.to.y)
  for (const stop of paint.stops) gradient.addColorStop(stop.at, cssColour(stop.ink))
  return gradient
}
