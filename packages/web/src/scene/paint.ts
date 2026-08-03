import { IDENTITY, type Camera } from './camera.js'
import type { Point } from './geometry.js'
import { cssColour, type Rgb } from './palette.js'
import {
  BACKDROP,
  isLinear,
  type ArcMark,
  type BakedMark,
  type ChipMark,
  type ContourMark,
  type GlowMark,
  type GrainMark,
  type Mark,
  type MotesMark,
  type PathMark,
  type Paint,
  type RibbonMark,
  type StrokeMark,
  type TextMark,
  type WashMark,
} from './marks/index.js'

/**
 * THE EXECUTOR — the only file in the scene that touches a canvas context, and
 * the only one with no opinion about the picture.
 *
 * Every decision (what is bright, what is faded, what shape a state takes) is
 * already made by the time a mark arrives here; this file turns eight mark kinds
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
 * THE FOUR CACHES prd10 ruling 6 and the spike's verdict ask for, and the one
 * property they share: **nothing in this file allocates a raster or a gradient on
 * a frame that could have reused one.**
 *
 * That is not a general optimisation instinct, it is where the whole gorgeous
 * round's frame budget went. Four things were about to be built per frame — a
 * radial gradient per mote (240 of them), the heart's ring geometry (breathing, so
 * ostensibly new every frame), a panel-sized fog and vignette, and a grain tile —
 * and every one of them is instead built once and keyed on the thing that actually
 * changes: a colour, a landing, a resize.
 *
 * Each cache is bounded and each bound is a leak-stop rather than a policy: a
 * session sees a few dozen ring rosters and a few dozen mote colours, so `clear()`
 * at the ceiling is both correct and never reached in practice.
 */
const CACHE_MAX = 128

/** `bake` + index → the unit-space path. See {@link BakedMark}. */
const bakedCache = new Map<string, Path2D>()
/** A pre-rendered mote: one soft falloff, in one quantised colour. */
const spriteCache = new Map<number, CanvasImageSource | null>()
/** A wash's gradient, keyed on everything that could change it. */
const washCache = new Map<string, CanvasGradient>()
/** The grain tile, and the pattern made from it. */
const grainCache = new Map<string, CanvasPattern | null>()

/** How big a mote sprite is rasterised. The spike's number; see {@link motes}. */
const SPRITE_PX = 32

/**
 * How coarsely a mote's colour is quantised before it becomes a sprite key.
 *
 * Five bits per channel. The alternative — one sprite per exact colour — would
 * rasterise a new 32 px tile for every step of ruling 12's cooling gradient on
 * every lane, which is the per-frame allocation the sprite exists to remove,
 * arrived at from the other direction. Five bits is a step of 8/255 in a soft
 * falloff at low alpha: below anything anyone can see, and it collapses a whole
 * dissolve to a handful of tiles.
 */
function spriteKey(rgb: Rgb): number {
  return ((rgb[0] >> 3) << 10) | ((rgb[1] >> 3) << 5) | (rgb[2] >> 3)
}

/** A scratch canvas, or null where there is no DOM (jsdom, a worker, a test). */
function scratch(size: number): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  return canvas.getContext('2d')
}

/**
 * One mote, rasterised once — the spike's verdict against `paint.ts:214`.
 *
 * The falloff is `1 - r` squared rather than a linear ramp, because a linear
 * radial gradient has a visible edge where it reaches zero and a squared one does
 * not; at 240 overlapping stamps under `lighter` that edge is the difference
 * between a drift of light and a field of discs. Null (and therefore skipped)
 * wherever no canvas can be made, which is what keeps `paint` runnable under test.
 */
function spriteFor(rgb: Rgb): CanvasImageSource | null {
  const key = spriteKey(rgb)
  const known = spriteCache.get(key)
  if (known !== undefined) return known

  const ctx = scratch(SPRITE_PX)
  let sprite: CanvasImageSource | null = null
  if (ctx !== null) {
    const half = SPRITE_PX / 2
    const gradient = ctx.createRadialGradient(half, half, 0, half, half, half)
    for (let i = 0; i <= 8; i += 1) {
      const t = i / 8
      gradient.addColorStop(t, cssColour({ rgb, alpha: (1 - t) ** 2 }))
    }
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, SPRITE_PX, SPRITE_PX)
    sprite = ctx.canvas
  }

  if (spriteCache.size >= CACHE_MAX) spriteCache.clear()
  spriteCache.set(key, sprite)
  return sprite
}

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

/**
 * What the camera does not move: the scene's own voice in the gutter, and the
 * panel's own depth (prd10 ruling 6).
 *
 * The fog, the vignette and the grain join the gap voice here for the same reason
 * it is here: they are facts about the *picture plane* rather than about the world
 * — light falls off toward the edges of a frame, and film grain sits on the print
 * — so panning must not slide them across the scene and zooming must not magnify
 * a grain tile into porridge. They are drawn in the chrome pass, in list order,
 * before the gap voice, so a caveat is never dimmed by the fog laid over the
 * picture it is a caveat about.
 */
function isChrome(mark: Mark): boolean {
  return mark.role === 'gap' || mark.kind === 'wash' || mark.kind === 'grain'
}

function blend(ctx: CanvasRenderingContext2D, mark: Mark): void {
  // Light adds, ink covers — and a drift of motes is light, which is the whole of
  // why it is one mark: the block is opened once for the drift rather than once
  // per mote (`perf.test.ts` counts the difference).
  const lit = mark.kind === 'glow' || mark.kind === 'motes'
  ctx.globalCompositeOperation = lit ? 'lighter' : 'source-over'
  draw(ctx, mark)
}

function draw(ctx: CanvasRenderingContext2D, mark: Mark): void {
  switch (mark.kind) {
    case 'ribbon':
      return ribbon(ctx, mark)
    case 'contour':
      return contour(ctx, mark)
    case 'glow':
      return glow(ctx, mark)
    case 'motes':
      return motes(ctx, mark)
    case 'baked':
      return baked(ctx, mark)
    case 'wash':
      return wash(ctx, mark)
    case 'grain':
      return grain(ctx, mark)
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
 * A ribbon: closed polygons, filled (prd7 ruling 3).
 *
 * The whole of the shape decision has already been made by `ribbon.ts` — the
 * taper, the pinches, the swells, the runs a broken thread is drawn in — and it
 * arrives here as vertices. That is the point of the seam: this file cannot
 * change what a thread means because it no longer knows what a thread is.
 *
 * One `fill()` per polygon rather than one per ribbon, because two polygons in a
 * single path would interact through the winding rule: a lobe drawn inside
 * another lobe's turn would punch a hole in it.
 */
function ribbon(ctx: CanvasRenderingContext2D, mark: RibbonMark): void {
  if (mark.outline.length === 0) return
  ctx.fillStyle = style(ctx, mark.paint)

  for (const polygon of mark.outline) {
    if (polygon.length < 3) continue
    ctx.beginPath()
    polygon.forEach((point, i) => {
      if (i === 0) ctx.moveTo(point.x, point.y)
      else ctx.lineTo(point.x, point.y)
    })
    ctx.closePath()
    ctx.fill()
  }
}

/**
 * An iso-contour: every ring in **one** path, filled even-odd (prd7 ruling 5).
 *
 * The opposite call from {@link ribbon}, and for the opposite reason. A ribbon's
 * polygons are separate runs of one stripe and must not interact, so they get a
 * `fill()` each. A contour's rings are one region's boundary, so they must
 * interact: a ring drawn inside another ring is a *hole* in the surface, and
 * even-odd is what makes it one. Filling them separately would paint the hole
 * back in.
 *
 * The rim is stroked over the same path rather than a rebuilt one, so it can
 * never disagree with the edge it is supposed to be on.
 *
 * The shells are the same call again, one level of the field deeper each time.
 * Painted in the order they arrive and each one translucent, so what the eye
 * reads is accumulated density rather than a stack of discs — the material
 * getting thicker toward the middle, which is what the field is actually saying.
 */
function contour(ctx: CanvasRenderingContext2D, mark: ContourMark): void {
  const trace = (rings: readonly (readonly Point[])[]): number => {
    let drawn = 0
    ctx.beginPath()
    for (const ring of rings) {
      if (ring.length < 3) continue
      ring.forEach((point, i) => {
        if (i === 0) ctx.moveTo(point.x, point.y)
        else ctx.lineTo(point.x, point.y)
      })
      ctx.closePath()
      drawn += 1
    }
    return drawn
  }

  if (trace(mark.rings) === 0) return

  ctx.fillStyle = cssColour(mark.fill)
  ctx.fill('evenodd')

  if (mark.edge !== undefined) {
    ctx.lineWidth = mark.edge.width
    ctx.strokeStyle = cssColour(mark.edge.ink)
    ctx.stroke()
  }

  for (const shell of mark.shells ?? []) {
    if (trace(shell.rings) === 0) continue
    ctx.fillStyle = cssColour(shell.ink)
    ctx.fill('evenodd')
  }
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

/**
 * A DRIFT OF MOTES — one sprite, stamped (prd10 ruling 10, the spike's verdict).
 *
 * The `glow` above is what this is not, and the difference is the whole of the
 * spike's finding about `paint.ts:214`: that function builds a `CanvasGradient`
 * every time it runs, which is correct for the handful of glows a frame has and
 * ruinous for two hundred and forty. Here the falloff was rasterised once per
 * quantised colour ({@link spriteFor}) and a mote costs one `drawImage`.
 *
 * `globalAlpha` carries the mote's own luminance rather than a per-mote sprite,
 * which is what makes ruling 10's "luminance-only fades" free: dimming is a
 * multiply the compositor was going to do anyway, where a fading *sprite* would be
 * a new raster per step. The size is the mote's own diameter, always **down** from
 * the 32 px tile — a sprite scaled up is a blur, and every mote in this scene is
 * under 6 px (`motes.ts`'s `MOTE_RADIUS`).
 */
function motes(ctx: CanvasRenderingContext2D, mark: MotesMark): void {
  const before = ctx.globalAlpha
  for (const mote of mark.items) {
    if (mote.radius <= 0.1 || mote.ink.alpha <= 0.002) continue
    const sprite = spriteFor(mote.ink.rgb)
    if (sprite === null) continue
    const size = mote.radius * 2
    ctx.globalAlpha = mote.ink.alpha
    ctx.drawImage(sprite, mote.at.x - mote.radius, mote.at.y - mote.radius, size, size)
  }
  ctx.globalAlpha = before
}

/**
 * BAKED GEOMETRY, PLACED (prd10 ruling 3) — the heart's rings and its hyphal fan.
 *
 * Two things are happening, and the second is why this exists at all. The
 * `Path2D` is built once per {@link BakedMark.bake} and kept, exactly as a glyph
 * is; and the *placement* is a `translate`/`scale` rather than new coordinates, so
 * a mass that is breathing and growing all session redraws the same cached path at
 * a different size instead of rebuilding it sixty times a second.
 *
 * The line width is divided back out of the scale for the reason the glyph painter
 * already documents: the transform is in unit space, so a width in pixels would
 * otherwise be multiplied by the mass's radius and a hairline ring would come out
 * a hundred pixels thick.
 */
function baked(ctx: CanvasRenderingContext2D, mark: BakedMark): void {
  if (mark.paths.length === 0 || mark.scale <= 0) return

  const scaleY = mark.scaleY ?? mark.scale
  ctx.save()
  ctx.translate(mark.at.x, mark.at.y)
  ctx.scale(mark.scale, scaleY)

  mark.paths.forEach((points, i) => {
    if (points.length < 2) return
    const key = `${mark.bake}#${i}`
    let path = bakedCache.get(key)
    if (path === undefined) {
      path = new Path2D()
      points.forEach((point, at) => {
        if (at === 0) path?.moveTo(point.x, point.y)
        else path?.lineTo(point.x, point.y)
      })
      if (mark.closed) path.closePath()
      if (bakedCache.size >= CACHE_MAX * 8) bakedCache.clear()
      bakedCache.set(key, path)
    }

    if (mark.width <= 0) {
      ctx.fillStyle = cssColour(mark.ink)
      ctx.fill(path)
      return
    }
    // The mean of the two scales, so an anisotropic placement still strokes at
    // about the width that was asked for rather than at the wider axis's.
    ctx.lineWidth = (mark.width * 2) / (mark.scale + scaleY)
    ctx.strokeStyle = cssColour(mark.ink)
    ctx.stroke(path)
  })

  ctx.restore()
}

/**
 * A RADIAL WASH over the panel — the depth fog and the vignette (prd10 ruling 6).
 *
 * The gradient is cached on everything that could change it, which in practice
 * means it is built **once per resize** and then reused for the life of the panel.
 * That is the ruling's own instruction, and it is the difference between depth
 * being free and depth costing a panel-sized gradient allocation sixty times a
 * second — the same mistake at panel scale that the mote sprite fixes at mote
 * scale.
 */
function wash(ctx: CanvasRenderingContext2D, mark: WashMark): void {
  if (mark.width <= 0 || mark.height <= 0) return
  const key = `${mark.role}:${mark.width}x${mark.height}:${mark.from},${mark.to}:${cssColour(mark.inner)}>${cssColour(mark.outer)}`

  let gradient = washCache.get(key)
  if (gradient === undefined) {
    const cx = mark.width / 2
    const cy = mark.height / 2
    const half = Math.hypot(cx, cy)
    gradient = ctx.createRadialGradient(cx, cy, half * mark.from, cx, cy, half * mark.to)
    gradient.addColorStop(0, cssColour(mark.inner))
    gradient.addColorStop(1, cssColour(mark.outer))
    if (washCache.size >= CACHE_MAX) washCache.clear()
    washCache.set(key, gradient)
  }

  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, mark.width, mark.height)
}

/**
 * GRAIN — one rasterised tile, repeated (prd10 ruling 6).
 *
 * The tile is a fixed noise field built once and cached; the mark's `tick` (which
 * advances at most twelve times a second) offsets the pattern, so the grain
 * *crawls* rather than boiling. Both halves are deliberate: a per-frame grain is
 * the one texture in this instrument that would genuinely read as movement, and
 * WCAG's whole point about ambient motion is that a viewer must be able to ignore
 * it. Twelve steps a second of a 1–2% wash is texture; sixty is a screen door.
 *
 * The tile is deterministic — a fixed hash walk, not `Math.random` — so two panels
 * in one session, or a replay on another machine, carry the same grain.
 */
function grain(ctx: CanvasRenderingContext2D, mark: GrainMark): void {
  if (mark.width <= 0 || mark.height <= 0 || mark.ink.alpha <= 0.002) return
  const key = `${mark.tile}:${cssColour({ rgb: mark.ink.rgb, alpha: 1 })}`

  let pattern = grainCache.get(key)
  if (pattern === undefined) {
    pattern = null
    const tile = scratch(mark.tile)
    if (tile !== null) {
      const image = tile.createImageData(mark.tile, mark.tile)
      const [r, g, b] = mark.ink.rgb
      let hash = 0x9e3779b9
      for (let i = 0; i < image.data.length; i += 4) {
        // xorshift over the pixel index: deterministic, and flat enough that no
        // structure appears when the tile repeats across a 900 px panel.
        hash ^= hash << 13
        hash ^= hash >>> 17
        hash ^= hash << 5
        hash |= 0
        image.data[i] = r
        image.data[i + 1] = g
        image.data[i + 2] = b
        image.data[i + 3] = (hash >>> 24) & 0xff
      }
      tile.putImageData(image, 0, 0)
      pattern = ctx.createPattern(tile.canvas, 'repeat')
    }
    if (grainCache.size >= CACHE_MAX) grainCache.clear()
    grainCache.set(key, pattern)
  }

  if (pattern === null) return
  const shift = mark.tick % mark.tile
  ctx.save()
  ctx.globalAlpha = mark.ink.alpha
  ctx.translate(-shift, -((mark.tick * 7) % mark.tile))
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, mark.width + mark.tile, mark.height + mark.tile)
  ctx.restore()
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
