import { IDENTITY, type Camera } from '../camera.js'
import type { Mark } from '../marks/index.js'
import { Batch } from './batch.js'
import { buildFrame, type GlFrame } from './frame.js'
import { createOverlayPainter, type OverlayPainter } from './overlay.js'
import { createGlPainter, type GlPainter, type Panel } from './painter.js'

export * from './batch.js'
export * from './frame.js'
export { createGlPainter, type GlPainter, type Panel } from './painter.js'
export { createOverlayPainter, type OverlayPainter } from './overlay.js'
export * from './tessellate.js'

/**
 * THE PAINTER, WHOLE — the display list in, two canvases out.
 *
 * `paint()` had one production call site and this has the same one. What changed
 * underneath is a renderer; what did not change is the seam, which is why the
 * swap was affordable: `sceneMarks` still returns the same plain data, and
 * nothing in `marks/` knows a GPU exists.
 *
 * Either surface may be missing and the scene must survive both. jsdom answers
 * `null` for `webgl2` *and* `2d`, so under test both painters are absent, the
 * frame is still **built** (which is the half worth asserting — see `frame.ts`),
 * and nothing is drawn. In a browser both exist. A browser that has 2D but no
 * WebGL2 gets the type and loses the picture, which is a degradation the panel
 * around it survives.
 */

export interface ScenePaintOptions {
  marks: readonly Mark[]
  /** The panel, in CSS pixels. Not the world — the world is what the camera moves. */
  width: number
  height: number
  camera?: Camera
  /** Device pixels per CSS pixel. The camera composes on top of it. */
  dpr?: number
}

export interface ScenePainter {
  paint(options: ScenePaintOptions): GlFrame
  /** Both backing stores have been resized; the viewport follows. */
  resize(): void
  dispose(): void
  /** True between `webglcontextlost` and `webglcontextrestored`. */
  readonly lost: boolean
  /** The last frame built. Null before the first paint. */
  readonly last: GlFrame | null
}

export interface ScenePainterOptions {
  onLost?: () => void
  onRestored?: () => void
  capture?: boolean
}

export function createScenePainter(
  glCanvas: HTMLCanvasElement,
  overlayCanvas: HTMLCanvasElement,
  options: ScenePainterOptions = {},
): ScenePainter {
  const gl: GlPainter | null = createGlPainter(glCanvas, options)
  const overlay: OverlayPainter | null = createOverlayPainter(overlayCanvas)
  // One buffer for the life of the painter: a frame's triangles are rewritten in
  // place, so a scene running for a session allocates its vertex arrays once.
  const vertices = new Batch()
  let last: GlFrame | null = null

  return {
    paint(request: ScenePaintOptions): GlFrame {
      const camera = request.camera ?? IDENTITY
      const panel: Panel = {
        width: request.width,
        height: request.height,
        dpr: request.dpr ?? 1,
      }
      const frame = buildFrame(
        request.marks,
        { width: panel.width, height: panel.height, camera },
        vertices,
      )
      last = frame
      gl?.submit(frame, panel, camera)
      overlay?.draw(frame, panel, camera)
      return frame
    },
    resize: () => gl?.resize(),
    dispose: () => gl?.dispose(),
    get lost(): boolean {
      return gl?.lost ?? false
    },
    get last(): GlFrame | null {
      return last
    },
  }
}
