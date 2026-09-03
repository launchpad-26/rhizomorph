import type { Camera } from '../camera.js'
import type { Ink } from '../palette.js'
import type { Run } from './batch.js'
import type { GlFrame } from './frame.js'
import {
  createResources,
  releaseResources,
  uploadNoise,
  type Resources,
} from './programs.js'

/**
 * THE EXECUTOR'S SECOND HALF — the frame, submitted.
 *
 * Everything that decides what the picture is happened in `frame.ts`; this file
 * uploads one vertex buffer and walks the run list, and it is the only place in
 * the scene that holds a GPU handle.
 *
 * **A WebGL context can be lost and a 2D one cannot** (ADR-0021's last "Bad").
 * The compositor takes one away on a driver reset, a GPU hang, a laptop switching
 * adapters, or simply because too many contexts are alive on the page — and every
 * program, buffer and texture dies with it. The whole recovery path is that all
 * of those live in one {@link Resources} record: on `webglcontextlost` the record
 * is dropped and the painter stops drawing; on `webglcontextrestored` it is built
 * again from nothing and drawing resumes on the next frame. Nothing else in the
 * scene has to know it happened.
 *
 * `preventDefault()` on the lost event is not a formality — without it the
 * browser never fires `webglcontextrestored` and the panel stays black for the
 * rest of the session, which for a read-only observer is a silent lie about the
 * fleet rather than a visible failure.
 */

export interface GlPainter {
  /** Uploads and draws one already-built frame. */
  submit(frame: GlFrame, panel: Panel, camera: Camera): void
  /** The backing store has changed size; the viewport follows it. */
  resize(): void
  dispose(): void
  /** True between `webglcontextlost` and `webglcontextrestored`. */
  readonly lost: boolean
}

export interface GlPainterOptions {
  /** Told when the context goes, and when it comes back. Law 12's voice. */
  onLost?: () => void
  onRestored?: () => void
  /** Keep the drawing buffer readable after the frame — the capture rig needs it. */
  capture?: boolean
}

/**
 * A WebGL2 context, or `null` where there is none.
 *
 * jsdom answers `null` for every context type, which is the case this exists to
 * survive: `SceneView` mounts, the DOM around the scene renders, and the picture
 * is simply not drawn. The duck test on top of it is not paranoia — the suite
 * hands `getContext` a *2D* double in several places, and a painter that took one
 * of those for a GL context would throw inside the frame loop rather than decline
 * to draw.
 */
export function createGlPainter(
  canvas: HTMLCanvasElement,
  options: GlPainterOptions = {},
): GlPainter | null {
  let gl: WebGL2RenderingContext | null = null
  try {
    gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      depth: false,
      stencil: true,
      preserveDrawingBuffer: options.capture === true,
    }) as WebGL2RenderingContext | null
  } catch {
    return null
  }
  if (gl === null || !isWebgl2(gl)) return null
  const context = gl

  let resources: Resources | null = createResources(context)
  /** The frame whose bytes are currently on the GPU, and the buffers they went
   * into. Both terms are needed — see the note on {@link submit}. */
  let uploadedFrame: GlFrame | null = null
  let uploadedInto: Resources | null = null
  let lost = false

  const onLost = (event: Event): void => {
    event.preventDefault()
    lost = true
    resources = null
    options.onLost?.()
  }
  const onRestored = (): void => {
    resources = createResources(context)
    lost = false
    // The backing store survives the round trip, but the viewport does not.
    context.viewport(0, 0, canvas.width, canvas.height)
    options.onRestored?.()
  }
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)

  const resize = (): void => {
    if (lost) return
    context.viewport(0, 0, canvas.width, canvas.height)
  }

  const submit = (frame: GlFrame, panel: Panel, camera: Camera): void => {
    const own = resources
    if (own === null || lost || context.isContextLost()) return

    context.viewport(0, 0, canvas.width, canvas.height)
    context.disable(context.DEPTH_TEST)
    context.disable(context.SCISSOR_TEST)
    context.enable(context.BLEND)
    context.clearColor(frame.backdrop[0], frame.backdrop[1], frame.backdrop[2], 1)
    context.clearStencil(0)
    context.clear(context.COLOR_BUFFER_BIT | context.STENCIL_BUFFER_BIT)

    // A REPAINT RE-SENDS NOTHING (prd-47 #178). `repaint()` hands us the
    // retained frame OBJECT (`gl/index.ts`), and a frame object is minted fresh
    // by every `buildFrame` — so `frame === uploadedFrame` is exactly "the
    // Batch has not been rewritten since we last uploaded it". Identity, never
    // content: comparing forty thousand floats to discover they match costs
    // more than the upload it would save, which is the same discipline ruling 2
    // states for the build.
    //
    // `uploadedInto` is the second term and it is not belt-and-braces. A
    // context restore rebuilds `resources` from nothing (`onRestored`), so the
    // new buffers are EMPTY while `uploadedFrame` still names a frame we
    // uploaded into the dead ones — the frame would draw from an empty buffer.
    // Keying on the record we actually uploaded into means every future path
    // that replaces `resources` invalidates this cache without having to
    // remember to.
    if (frame !== uploadedFrame || own !== uploadedInto) {
      upload(context, own, frame)
      uploadedFrame = frame
      uploadedInto = own
    }
    walk(context, own, frame, panel, camera)
  }

  return {
    submit,
    resize,
    dispose: () => {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      if (resources !== null && !context.isContextLost()) releaseResources(context, resources)
      resources = null
    },
    get lost(): boolean {
      return lost
    },
  }
}

function upload(gl: WebGL2RenderingContext, own: Resources, frame: GlFrame): void {
  const n = frame.vertices.n
  if (n === 0) return
  gl.bindBuffer(gl.ARRAY_BUFFER, own.pos)
  gl.bufferData(gl.ARRAY_BUFFER, frame.vertices.pos.subarray(0, n * 2), gl.STREAM_DRAW)
  gl.bindBuffer(gl.ARRAY_BUFFER, own.col)
  gl.bufferData(gl.ARRAY_BUFFER, frame.vertices.col.subarray(0, n * 4), gl.STREAM_DRAW)
  gl.bindBuffer(gl.ARRAY_BUFFER, own.fall)
  gl.bufferData(gl.ARRAY_BUFFER, frame.vertices.fall.subarray(0, n * 4), gl.STREAM_DRAW)
}

export interface Panel {
  width: number
  height: number
  dpr: number
}

function walk(
  gl: WebGL2RenderingContext,
  own: Resources,
  frame: GlFrame,
  panel: Panel,
  camera: Camera,
): void {
  let bound: 'marks' | 'quad' | null = null

  const useMarks = (world: boolean): void => {
    if (bound !== 'marks') {
      gl.bindVertexArray(own.markVao)
      gl.useProgram(own.marks.program)
      gl.uniform2f(own.marks.uPanel, panel.width, panel.height)
      bound = 'marks'
    }
    if (world) gl.uniform3f(own.marks.uCam, camera.k, camera.x, camera.y)
    else gl.uniform3f(own.marks.uCam, 1, 0, 0)
  }

  const useQuad = (): void => {
    if (bound === 'quad') return
    gl.bindVertexArray(own.quadVao)
    bound = 'quad'
  }

  const blend = (additive: boolean): void => {
    // Premultiplied source-over, or premultiplied additive. `paint.ts`'s one
    // owned rule — light adds, ink covers — as two blend functions.
    if (additive) gl.blendFunc(gl.ONE, gl.ONE)
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  for (const run of frame.runs) {
    switch (run.kind) {
      case 'tris':
        if (run.count === 0) break
        useMarks(run.world)
        blend(run.additive)
        gl.drawArrays(gl.TRIANGLES, run.start, run.count)
        break

      case 'stencil':
        drawStencil(gl, own, run, useMarks, blend)
        break

      case 'wash': {
        useQuad()
        gl.useProgram(own.wash.program)
        blend(false)
        gl.uniform2f(own.wash.uPanel, panel.width, panel.height)
        gl.uniform2f(own.wash.uSize, run.width, run.height)
        gl.uniform2f(own.wash.uCentre, run.centre.x, run.centre.y)
        const half = Math.hypot(run.width / 2, run.height / 2)
        gl.uniform2f(own.wash.uRadii, half * run.from, half * run.to)
        premultiplied(gl, own.wash.uInner, run.inner)
        premultiplied(gl, own.wash.uOuter, run.outer)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
        bound = 'quad'
        break
      }

      case 'grain': {
        uploadNoise(gl, own, run.tile)
        useQuad()
        gl.useProgram(own.grain.program)
        blend(false)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, own.noise.texture)
        gl.uniform1i(own.grain.uNoise, 0)
        gl.uniform2f(own.grain.uPanel, panel.width, panel.height)
        gl.uniform2f(own.grain.uSize, run.width, run.height)
        gl.uniform1f(own.grain.uTile, run.tile)
        gl.uniform2f(own.grain.uShift, run.shift.x, run.shift.y)
        gl.uniform4f(own.grain.uInk, run.ink.rgb[0] / 255, run.ink.rgb[1] / 255, run.ink.rgb[2] / 255, run.ink.alpha)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
        bound = 'quad'
        break
      }
    }
  }

  gl.bindVertexArray(null)
}

/**
 * ONE EVEN-ODD REGION. Rings into the stencil with `INVERT` — one bit flipped per
 * ring covering a pixel — then the bounding box wherever the bit survived, which
 * zeroes it again as it draws. No `glClear` between regions, so a mass with
 * twenty shells costs twenty of these and nothing else.
 */
function drawStencil(
  gl: WebGL2RenderingContext,
  own: Resources,
  run: Extract<Run, { kind: 'stencil' }>,
  useMarks: (world: boolean) => void,
  blend: (additive: boolean) => void,
): void {
  if (run.fillCount === 0 || run.coverCount === 0) return
  useMarks(run.world)

  gl.enable(gl.STENCIL_TEST)
  gl.colorMask(false, false, false, false)
  gl.stencilFunc(gl.ALWAYS, 0, 0xff)
  gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT)
  gl.stencilMask(0x01)
  gl.drawArrays(gl.TRIANGLES, run.fillStart, run.fillCount)

  gl.colorMask(true, true, true, true)
  gl.stencilFunc(gl.EQUAL, 1, 0x01)
  gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO)
  blend(run.additive)
  gl.drawArrays(gl.TRIANGLES, run.coverStart, run.coverCount)

  gl.stencilMask(0xff)
  gl.disable(gl.STENCIL_TEST)
}

function premultiplied(
  gl: WebGL2RenderingContext,
  location: WebGLUniformLocation | null,
  ink: Ink,
): void {
  const a = ink.alpha
  gl.uniform4f(location, (ink.rgb[0] / 255) * a, (ink.rgb[1] / 255) * a, (ink.rgb[2] / 255) * a, a)
}

/**
 * Is this really a WebGL2 context? Four methods no 2D context has, and the three
 * this painter would die on first.
 */
function isWebgl2(value: unknown): value is WebGL2RenderingContext {
  const candidate = value as Partial<WebGL2RenderingContext>
  return (
    typeof candidate.createProgram === 'function' &&
    typeof candidate.createVertexArray === 'function' &&
    typeof candidate.drawArrays === 'function' &&
    typeof candidate.getUniformLocation === 'function'
  )
}
