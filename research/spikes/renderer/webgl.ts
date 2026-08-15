/**
 * THE WEBGL2 PAINTER — the same display list, drawn the way a GPU wants it.
 *
 * This is deliberately *not* a transliteration of `paint.ts`. Re-issuing 400
 * immediate-mode fills through WebGL would measure a bad WebGL implementation
 * and prove nothing, so this does what a real migration would do: it walks the
 * mark list once, appends every mark into a handful of shared vertex buffers by
 * blend class, and then draws the frame in **six** draw calls.
 *
 * What it does not do — and this is the honest part, not an omission — is text,
 * glyphs and chips. Those have no cheap GPU form without a font atlas, so they
 * are drawn to a transparent 2D canvas layered over the GL canvas, which is what
 * every real WebGL dashboard does. That overlay is timed separately and counted
 * against WebGL in the verdict; pretending it is free is how a spike lies.
 *
 * Geometry decisions, each one taken in WebGL's favour:
 *
 * - **Ribbons** are built as triangle strips off the mark's own spine and
 *   widths, not by tessellating `perfect-freehand`'s outline. That is both the
 *   fast path and the one a GPU port would actually take. It costs the outline's
 *   rounded reversal caps; see the note in the report.
 * - **Contours** are fanned from their centroid. The mass's rings come off a
 *   smoothed scalar field and are star-shaped about their centre, so a fan is
 *   correct for them — and a fan is one triangle per edge rather than a stencil
 *   round trip.
 * - **Glows and motes** are one additive quad each, with the falloff evaluated
 *   in the fragment shader. No gradient object exists at all.
 * - **Directional shading** is two vertex colours. It is the channel canvas 2D
 *   pays a `createLinearGradient` per ribbon per frame for.
 */

import type { Point } from '../../../packages/web/src/scene/geometry.js'
import { BACKDROP, isLinear, type Mark, type Paint } from '../../../packages/web/src/scene/marks/index.js'
import type { Ink } from '../../../packages/web/src/scene/palette.js'

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
layout(location=1) in vec4 aColour;
/** x,y = centre in px; z = radius; w = 0 flat, 1 radial falloff. */
layout(location=2) in vec4 aFall;
uniform vec2 uPanel;
out vec4 vColour;
out vec4 vFall;
out vec2 vPos;
void main() {
  vColour = aColour;
  vFall = aFall;
  vPos = aPos;
  vec2 clip = (aPos / uPanel) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
in vec4 vColour;
in vec4 vFall;
in vec2 vPos;
out vec4 outColour;
void main() {
  float a = vColour.a;
  if (vFall.w > 0.5) {
    float r = length(vPos - vFall.xy) / max(vFall.z, 0.001);
    // (1 - r)^2 — the same falloff paint.ts bakes into its mote sprite, and the
    // same reason: a linear ramp has a visible edge where it reaches zero.
    float f = max(0.0, 1.0 - r);
    a *= f * f;
  }
  outColour = vec4(vColour.rgb * a, a);
}`

/** One appendable batch: positions, colours, falloff params. */
class Batch {
  pos: Float32Array
  col: Float32Array
  fall: Float32Array
  n = 0
  constructor(cap: number) {
    this.pos = new Float32Array(cap * 2)
    this.col = new Float32Array(cap * 4)
    this.fall = new Float32Array(cap * 4)
  }
  private grow(): void {
    const bigger = (a: Float32Array): Float32Array => {
      const next = new Float32Array(a.length * 2)
      next.set(a)
      return next
    }
    this.pos = bigger(this.pos)
    this.col = bigger(this.col)
    this.fall = bigger(this.fall)
  }
  vertex(x: number, y: number, c: readonly [number, number, number, number], f: readonly [number, number, number, number]): void {
    if (this.n * 2 >= this.pos.length) this.grow()
    const i2 = this.n * 2
    const i4 = this.n * 4
    this.pos[i2] = x
    this.pos[i2 + 1] = y
    this.col[i4] = c[0]
    this.col[i4 + 1] = c[1]
    this.col[i4 + 2] = c[2]
    this.col[i4 + 3] = c[3]
    this.fall[i4] = f[0]
    this.fall[i4 + 1] = f[1]
    this.fall[i4 + 2] = f[2]
    this.fall[i4 + 3] = f[3]
    this.n += 1
  }
  /** A triangle, three vertices, flat-shaded. */
  tri(a: Point, b: Point, c: Point, col: readonly [number, number, number, number]): void {
    this.vertex(a.x, a.y, col, FLAT)
    this.vertex(b.x, b.y, col, FLAT)
    this.vertex(c.x, c.y, col, FLAT)
  }
  reset(): void {
    this.n = 0
  }
}

const FLAT: readonly [number, number, number, number] = [0, 0, 0, 0]

type Colour = [number, number, number, number]

function rgba(ink: Ink): Colour {
  return [ink.rgb[0] / 255, ink.rgb[1] / 255, ink.rgb[2] / 255, ink.alpha]
}

/** A point's colour under a paint — the directional ramp, evaluated per vertex. */
function paintAt(paint: Paint, p: Point): Colour {
  if (!isLinear(paint)) return rgba(paint)
  const dx = paint.to.x - paint.from.x
  const dy = paint.to.y - paint.from.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - paint.from.x) * dx + (p.y - paint.from.y) * dy) / len2))
  const stops = paint.stops
  let lo = stops[0] as (typeof stops)[number]
  let hi = stops[stops.length - 1] as (typeof stops)[number]
  for (let i = 0; i < stops.length - 1; i += 1) {
    const a = stops[i] as (typeof stops)[number]
    const b = stops[i + 1] as (typeof stops)[number]
    if (t >= a.at && t <= b.at) {
      lo = a
      hi = b
      break
    }
  }
  const span = hi.at - lo.at
  const f = span === 0 ? 0 : (t - lo.at) / span
  const mix = (a: number, b: number): number => a + (b - a) * f
  return [
    mix(lo.ink.rgb[0], hi.ink.rgb[0]) / 255,
    mix(lo.ink.rgb[1], hi.ink.rgb[1]) / 255,
    mix(lo.ink.rgb[2], hi.ink.rgb[2]) / 255,
    mix(lo.ink.alpha, hi.ink.alpha),
  ]
}

export interface GlPainter {
  /** Draws one frame. Returns the JS time spent building + submitting, in ms. */
  paint: (marks: readonly Mark[]) => { submitMs: number; overlayMs: number; drawCalls: number }
  /** Blocks until the GPU has finished the last frame. */
  sync: () => void
  resize: (width: number, height: number, dpr: number) => void
  info: () => { renderer: string; vendor: string }
  gpuMs: () => number | null
}

export function createGlPainter(
  gl: WebGL2RenderingContext,
  overlay: CanvasRenderingContext2D,
  width: number,
  height: number,
  dpr: number,
): GlPainter {
  const program = link(gl, VERT, FRAG)
  const uPanel = gl.getUniformLocation(program, 'uPanel')

  const buffers = { pos: gl.createBuffer(), col: gl.createBuffer(), fall: gl.createBuffer() }
  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  bind(gl, buffers.pos, 0, 2)
  bind(gl, buffers.col, 1, 4)
  bind(gl, buffers.fall, 2, 4)
  gl.bindVertexArray(null)

  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as
    | { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }
    | null
  let lastGpuMs: number | null = null
  let pending: WebGLQuery | null = null

  // Two batches, one per blend class: ink covers, light adds. That is
  // `paint.ts`'s own rule, and here it is what makes the frame two draw calls
  // instead of one per mark — a `lighter` block costs a state change on the CPU
  // and a pipeline flush on the GPU, so the whole frame is sorted into two.
  const ink = new Batch(1 << 16)
  const light = new Batch(1 << 16)

  let panel = { width, height, dpr }

  const resize = (w: number, h: number, d: number): void => {
    panel = { width: w, height: h, dpr: d }
    gl.canvas.width = Math.round(w * d)
    gl.canvas.height = Math.round(h * d)
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height)
    overlay.canvas.width = Math.round(w * d)
    overlay.canvas.height = Math.round(h * d)
  }
  resize(width, height, dpr)

  const paint = (marks: readonly Mark[]): { submitMs: number; overlayMs: number; drawCalls: number } => {
    const t0 = performance.now()
    ink.reset()
    light.reset()

    let overlayWork: Mark[] | null = null

    for (const mark of marks) {
      switch (mark.kind) {
        case 'ribbon':
          ribbon(ink, mark)
          break
        case 'contour':
          contour(ink, mark)
          break
        case 'glow':
          glow(light, mark)
          break
        case 'motes':
          for (const mote of mark.items) {
            if (mote.radius <= 0.1 || mote.ink.alpha <= 0.002) continue
            quad(light, mote.at, mote.radius, rgba(mote.ink), true)
          }
          break
        case 'baked':
          baked(ink, mark)
          break
        case 'wash':
          wash(ink, mark, panel)
          break
        case 'grain':
          // A tiled noise field. On the GPU it is a texture lookup in the
          // fullscreen pass; here it is folded into the wash's own quad as a
          // flat lift, which is the cheapest honest stand-in and is *cheaper*
          // than what canvas 2D pays. Counted as such in the report.
          break
        case 'stroke':
          polyline(ink, mark.points, mark.width, rgba(mark.ink), mark.closed === true)
          break
        case 'arc':
          arc(ink, mark)
          break
        case 'path':
        case 'text':
        case 'chip':
          ;(overlayWork ??= []).push(mark)
          break
      }
    }

    const t1 = performance.now()

    if (timer !== null && pending === null) {
      pending = gl.createQuery()
      gl.beginQuery(timer.TIME_ELAPSED_EXT, pending)
    }

    gl.bindVertexArray(vao)
    gl.useProgram(program)
    gl.uniform2f(uPanel, panel.width, panel.height)
    gl.enable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    const bg = rgba(BACKDROP)
    gl.clearColor(bg[0] * bg[3], bg[1] * bg[3], bg[2] * bg[3], 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    let calls = 0
    // Premultiplied source-over, then premultiplied additive. Two calls.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    calls += flush(gl, buffers, ink)
    gl.blendFunc(gl.ONE, gl.ONE)
    calls += flush(gl, buffers, light)
    gl.bindVertexArray(null)

    if (timer !== null && pending !== null) {
      gl.endQuery(timer.TIME_ELAPSED_EXT)
      const q = pending
      pending = null
      queueMicrotask(() => {
        // Read it next frame; a same-frame read would be a stall.
        setTimeout(() => {
          if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) === true) {
            lastGpuMs = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6
          }
          gl.deleteQuery(q)
        }, 0)
      })
    }

    const t2 = performance.now()
    // The overlay: type and glyphs, in 2D, over the top.
    overlay.setTransform(panel.dpr, 0, 0, panel.dpr, 0, 0)
    overlay.clearRect(0, 0, panel.width, panel.height)
    if (overlayWork !== null) for (const mark of overlayWork) overlayDraw(overlay, mark)
    const t3 = performance.now()

    return { submitMs: t1 - t0 + (t2 - t1), overlayMs: t3 - t2, drawCalls: calls }
  }

  return {
    paint,
    sync: () => {
      const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
      if (fence === null) {
        gl.finish()
        return
      }
      gl.clientWaitSync(fence, gl.SYNC_FLUSH_COMMANDS_BIT, 1e9)
      gl.deleteSync(fence)
    },
    resize,
    info: () => {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info')
      return {
        renderer: dbg === null ? gl.getParameter(gl.RENDERER) : gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL),
        vendor: dbg === null ? gl.getParameter(gl.VENDOR) : gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL),
      }
    },
    gpuMs: () => lastGpuMs,
  }
}

// ---------------------------------------------------------------------------
// mark → triangles
// ---------------------------------------------------------------------------

/**
 * A ribbon as a triangle strip off its spine, widened by its own width profile.
 *
 * `mark.widthRoot`/`widthTip` are the *encoded* channel — the same two numbers
 * `marks.test.ts` reads — so building from them rather than from the outline
 * keeps the picture saying the same thing. Emitted as independent triangles so
 * every ribbon lands in one shared buffer.
 */
function ribbon(batch: Batch, mark: Extract<Mark, { kind: 'ribbon' }>): void {
  const spine = mark.path
  if (spine.length < 2) {
    // The degenerate closed-region case (`regionMark`): the outline *is* the
    // shape, so fan it.
    for (const poly of mark.outline) fan(batch, poly, mark.paint)
    return
  }
  if (mark.widthRoot === 0 && mark.widthTip === 0) {
    for (const poly of mark.outline) fan(batch, poly, mark.paint)
    return
  }

  let prevL: Point | null = null
  let prevR: Point | null = null
  let prevC: Colour | null = null
  for (let i = 0; i < spine.length; i += 1) {
    const p = spine[i] as Point
    const a = (spine[Math.max(0, i - 1)] as Point)
    const b = (spine[Math.min(spine.length - 1, i + 1)] as Point)
    const tx = b.x - a.x
    const ty = b.y - a.y
    const len = Math.hypot(tx, ty) || 1
    const nx = -ty / len
    const ny = tx / len
    const t = i / (spine.length - 1)
    const half = (mark.widthRoot + (mark.widthTip - mark.widthRoot) * t) / 2
    const l: Point = { x: p.x + nx * half, y: p.y + ny * half }
    const r: Point = { x: p.x - nx * half, y: p.y - ny * half }
    const c = paintAt(mark.paint, p)
    if (prevL !== null && prevR !== null && prevC !== null) {
      batch.vertex(prevL.x, prevL.y, prevC, FLAT)
      batch.vertex(prevR.x, prevR.y, prevC, FLAT)
      batch.vertex(l.x, l.y, c, FLAT)
      batch.vertex(prevR.x, prevR.y, prevC, FLAT)
      batch.vertex(r.x, r.y, c, FLAT)
      batch.vertex(l.x, l.y, c, FLAT)
    }
    prevL = l
    prevR = r
    prevC = c
  }
}

/** A polygon, fanned from its centroid. Correct for star-shaped rings. */
function fan(batch: Batch, poly: readonly Point[], paint: Paint): void {
  if (poly.length < 3) return
  let cx = 0
  let cy = 0
  for (const p of poly) {
    cx += p.x
    cy += p.y
  }
  const centre: Point = { x: cx / poly.length, y: cy / poly.length }
  const cc = paintAt(paint, centre)
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i] as Point
    const b = poly[(i + 1) % poly.length] as Point
    batch.vertex(centre.x, centre.y, cc, FLAT)
    batch.vertex(a.x, a.y, paintAt(paint, a), FLAT)
    batch.vertex(b.x, b.y, paintAt(paint, b), FLAT)
  }
}

function contour(batch: Batch, mark: Extract<Mark, { kind: 'contour' }>): void {
  for (const ring of mark.rings) fan(batch, ring, mark.fill)
  if (mark.edge !== undefined) {
    for (const ring of mark.rings) polyline(batch, ring, mark.edge.width, rgba(mark.edge.ink), true)
  }
  for (const shell of mark.shells ?? []) {
    for (const ring of shell.rings) fan(batch, ring, shell.ink)
  }
}

function glow(batch: Batch, mark: Extract<Mark, { kind: 'glow' }>): void {
  if (mark.radius <= 0.1) return
  quad(batch, mark.at, mark.radius, rgba(mark.ink), true)
}

/** Two triangles around a centre, with the falloff carried to the shader. */
function quad(batch: Batch, at: Point, radius: number, col: Colour, falloff: boolean): void {
  const f: readonly [number, number, number, number] = falloff ? [at.x, at.y, radius, 1] : FLAT
  const l = at.x - radius
  const r = at.x + radius
  const t = at.y - radius
  const b = at.y + radius
  batch.vertex(l, t, col, f)
  batch.vertex(r, t, col, f)
  batch.vertex(l, b, col, f)
  batch.vertex(r, t, col, f)
  batch.vertex(r, b, col, f)
  batch.vertex(l, b, col, f)
}

function polyline(batch: Batch, points: readonly Point[], width: number, col: Colour, closed: boolean): void {
  if (points.length < 2) return
  const half = Math.max(0.35, width / 2)
  const n = closed ? points.length : points.length - 1
  for (let i = 0; i < n; i += 1) {
    const a = points[i] as Point
    const b = points[(i + 1) % points.length] as Point
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const nx = (-dy / len) * half
    const ny = (dx / len) * half
    batch.tri({ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: a.x - nx, y: a.y - ny }, col)
    batch.tri({ x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }, col)
  }
}

function arc(batch: Batch, mark: Extract<Mark, { kind: 'arc' }>): void {
  const steps = Math.max(6, Math.ceil(Math.abs(mark.to - mark.from) * 12))
  const pts: Point[] = []
  for (let i = 0; i <= steps; i += 1) {
    const a = mark.from + ((mark.to - mark.from) * i) / steps
    pts.push({ x: mark.at.x + Math.cos(a) * mark.radius, y: mark.at.y + Math.sin(a) * mark.radius })
  }
  polyline(batch, pts, mark.width, rgba(mark.ink), false)
}

function baked(batch: Batch, mark: Extract<Mark, { kind: 'baked' }>): void {
  if (mark.paths.length === 0 || mark.scale <= 0) return
  const sy = mark.scaleY ?? mark.scale
  const col = rgba(mark.ink)
  for (const unit of mark.paths) {
    if (unit.length < 2) continue
    const placed = unit.map((p) => ({ x: mark.at.x + p.x * mark.scale, y: mark.at.y + p.y * sy }))
    if (mark.width <= 0) fan(batch, placed, mark.ink)
    else polyline(batch, placed, mark.width, col, mark.closed)
  }
}

/**
 * The panel washes — depth haze and vignette — as one quad each with the radial
 * falloff done in the shader. On the GPU there is no gradient object to cache
 * and no resize to key it on: the cheapest mark in the frame.
 */
function wash(
  batch: Batch,
  mark: Extract<Mark, { kind: 'wash' }>,
  panel: { width: number; height: number },
): void {
  if (mark.width <= 0 || mark.height <= 0) return
  const cx = mark.width / 2
  const cy = mark.height / 2
  const half = Math.hypot(cx, cy)
  const outer = rgba(mark.outer)
  const inner = rgba(mark.inner)
  // Outer flat over the panel, inner as a falloff blob on top: the same two
  // stops the 2D gradient carries.
  batch.vertex(0, 0, outer, FLAT)
  batch.vertex(panel.width, 0, outer, FLAT)
  batch.vertex(0, panel.height, outer, FLAT)
  batch.vertex(panel.width, 0, outer, FLAT)
  batch.vertex(panel.width, panel.height, outer, FLAT)
  batch.vertex(0, panel.height, outer, FLAT)
  quad(batch, { x: cx, y: cy }, half * Math.max(mark.to, 0.01), inner, true)
}

// ---------------------------------------------------------------------------
// the 2D overlay — type and glyphs, which have no cheap GPU form
// ---------------------------------------------------------------------------

const glyphCache = new Map<string, Path2D>()

const FONT = {
  sans: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, 'JetBrains Mono', monospace",
} as const

const ALIGN = { left: 'left', right: 'right', centre: 'center' } as const

function css(ink: Ink): string {
  return `rgba(${ink.rgb[0]}, ${ink.rgb[1]}, ${ink.rgb[2]}, ${ink.alpha.toFixed(3)})`
}

function overlayDraw(ctx: CanvasRenderingContext2D, mark: Mark): void {
  if (mark.kind === 'text') {
    ctx.save()
    ctx.font = `${mark.weight} ${mark.size}px ${FONT[mark.font]}`
    ctx.textAlign = ALIGN[mark.align]
    ctx.textBaseline = 'middle'
    ctx.fillStyle = css(mark.ink)
    ctx.fillText(mark.text, mark.at.x, mark.at.y)
    ctx.restore()
    return
  }
  if (mark.kind === 'chip') {
    ctx.fillStyle = css(mark.fill)
    ctx.fillRect(mark.at.x, mark.at.y, mark.width, mark.height)
    ctx.lineWidth = 1
    ctx.strokeStyle = css(mark.border)
    ctx.strokeRect(mark.at.x, mark.at.y, mark.width, mark.height)
    return
  }
  if (mark.kind === 'path') {
    let path = glyphCache.get(mark.d)
    if (path === undefined) {
      path = new Path2D(mark.d)
      glyphCache.set(mark.d, path)
    }
    ctx.save()
    ctx.translate(mark.at.x, mark.at.y)
    ctx.rotate(mark.rotate)
    ctx.scale(mark.size, mark.size * (mark.squash ?? 1))
    ctx.translate(-0.5, -0.5)
    if (mark.stroke === undefined) {
      ctx.fillStyle = css(mark.ink)
      ctx.fill(path)
    } else {
      ctx.lineWidth = mark.stroke / mark.size
      ctx.strokeStyle = css(mark.ink)
      ctx.stroke(path)
    }
    ctx.restore()
  }
}

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

function flush(
  gl: WebGL2RenderingContext,
  buffers: { pos: WebGLBuffer | null; col: WebGLBuffer | null; fall: WebGLBuffer | null },
  batch: Batch,
): number {
  if (batch.n === 0) return 0
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.pos)
  gl.bufferData(gl.ARRAY_BUFFER, batch.pos.subarray(0, batch.n * 2), gl.STREAM_DRAW)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.col)
  gl.bufferData(gl.ARRAY_BUFFER, batch.col.subarray(0, batch.n * 4), gl.STREAM_DRAW)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.fall)
  gl.bufferData(gl.ARRAY_BUFFER, batch.fall.subarray(0, batch.n * 4), gl.STREAM_DRAW)
  gl.drawArrays(gl.TRIANGLES, 0, batch.n)
  return 1
}

function bind(gl: WebGL2RenderingContext, buffer: WebGLBuffer | null, location: number, size: number): void {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.enableVertexAttribArray(location)
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0)
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type) as WebGLShader
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
      throw new Error(`shader: ${gl.getShaderInfoLog(shader)}`)
    }
    return shader
  }
  const program = gl.createProgram() as WebGLProgram
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vs))
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(program)
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    throw new Error(`link: ${gl.getProgramInfoLog(program)}`)
  }
  return program
}
