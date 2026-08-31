import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mark } from '../marks/index.js'
import { ICE_200, TISSUE_900, ink } from '../palette.js'
import { createGlPainter, createScenePainter } from './index.js'
import { recordingGl, type RecordingGl } from './recorder.js'

/**
 * THE SUBMISSION — and the failure mode canvas 2D did not have.
 *
 * A `CanvasRenderingContext2D` is handed out once and lives as long as the
 * element. A WebGL context is a *lease*: the compositor takes it back on a driver
 * reset, a GPU hang, a laptop switching adapters, or simply because too many
 * contexts are alive on the page, and every program, buffer and texture dies with
 * it. That is a new failure mode, it is entirely silent, and on a read-only
 * observer a silent failure is worse than a loud one — a scene that has stopped
 * redrawing looks exactly like a fleet where nothing is happening.
 *
 * ADR-0021 booked it as a "Bad" and #578 required it handled and tested. This is
 * the test.
 */

const base = { role: 'thread' as const, laneId: null, alarm: false }

/** Enough of the picture to exercise every path the painter has. */
const MARKS: Mark[] = [
  {
    ...base,
    role: 'root-mass',
    kind: 'contour',
    rings: [
      [
        { x: 100, y: 100 },
        { x: 160, y: 100 },
        { x: 160, y: 160 },
        { x: 100, y: 160 },
      ],
    ],
    fill: ink(TISSUE_900, 0.6),
  },
  { ...base, kind: 'glow', at: { x: 130, y: 130 }, radius: 20, ink: ink(ICE_200, 0.4) },
  {
    ...base,
    role: 'depth-fog',
    kind: 'wash',
    width: 900,
    height: 260,
    from: 0.2,
    to: 1,
    inner: ink(TISSUE_900, 0),
    outer: ink(TISSUE_900, 0.3),
  },
  {
    ...base,
    role: 'grain',
    kind: 'grain',
    width: 900,
    height: 260,
    tile: 32,
    tick: 3,
    ink: ink(ICE_200, 0.016),
  },
]

const PAINT = { marks: MARKS, width: 900, height: 260, dpr: 2 }

afterEach(() => {
  vi.restoreAllMocks()
})

/** Two canvases and a recording GL context on the first of them. */
function mount(): { gl: RecordingGl; canvas: HTMLCanvasElement; overlay: HTMLCanvasElement } {
  const gl = recordingGl()
  const canvas = document.createElement('canvas')
  const overlay = document.createElement('canvas')
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
    type === 'webgl2' ? gl.gl : null) as unknown as HTMLCanvasElement['getContext'])
  return { gl, canvas, overlay }
}

describe('a lost context, and the way back', () => {
  it('recovers: it stops drawing, says so, rebuilds and resumes', () => {
    const { gl, canvas, overlay } = mount()
    const said: string[] = []
    const painter = createScenePainter(canvas, overlay, {
      onLost: () => said.push('lost'),
      onRestored: () => said.push('restored'),
    })

    painter.paint(PAINT)
    expect(gl.of('drawArrays').length).toBeGreaterThan(0)
    expect(painter.lost).toBe(false)

    const lost = new Event('webglcontextlost', { cancelable: true })
    canvas.dispatchEvent(lost)

    // `preventDefault` is not a formality. Without it the browser never fires
    // `webglcontextrestored` and the panel stays black for the rest of the
    // session — which for a read-only observer is a silent lie about the fleet.
    expect(lost.defaultPrevented).toBe(true)
    expect(painter.lost).toBe(true)
    expect(said).toEqual(['lost'])

    // While it is gone the frame is still *built* — the display list is what the
    // rest of the scene reads — and not one GL call is made against a dead
    // context.
    gl.reset()
    const frame = painter.paint(PAINT)
    expect(frame.vertices.n).toBeGreaterThan(0)
    expect(gl.calls).toEqual([])

    gl.reset()
    canvas.dispatchEvent(new Event('webglcontextrestored'))
    // Everything the painter owns on the GPU died with the context, so all of it
    // is built again: three programs, and the shaders under them.
    expect(gl.of('createProgram')).toHaveLength(3)
    expect(gl.of('createVertexArray')).toHaveLength(2)
    expect(painter.lost).toBe(false)
    expect(said).toEqual(['lost', 'restored'])

    gl.reset()
    painter.paint(PAINT)
    expect(gl.of('drawArrays').length).toBeGreaterThan(0)
  })

  it('declines to draw against a context that reports itself lost', () => {
    // The event is not the only signal: a context can come back lost, and a
    // frame already in flight when the loss lands would submit into nothing.
    const { gl, canvas, overlay } = mount()
    const painter = createScenePainter(canvas, overlay)

    gl.contextLost = true
    gl.reset()
    painter.paint(PAINT)
    expect(gl.of('drawArrays')).toHaveLength(0)
  })

  it('lets go of everything it owns when the scene unmounts', () => {
    const { gl, canvas, overlay } = mount()
    const painter = createScenePainter(canvas, overlay)
    gl.reset()
    painter.dispose()

    expect(gl.of('deleteProgram')).toHaveLength(3)
    expect(gl.of('deleteBuffer')).toHaveLength(4)
    // …and the listeners with them: a disposed painter must not answer a loss
    // event on a canvas React has moved on from.
    const lost = new Event('webglcontextlost', { cancelable: true })
    canvas.dispatchEvent(lost)
    expect(lost.defaultPrevented).toBe(false)
  })
})

describe('the frame, submitted', () => {
  it('uploads once and draws the runs in order', () => {
    const { gl, canvas, overlay } = mount()
    const painter = createScenePainter(canvas, overlay)
    gl.reset()
    const frame = painter.paint(PAINT)

    // One `bufferData` per attribute for the whole frame, not one per mark.
    expect(gl.of('bufferData')).toHaveLength(3)
    expect(gl.of('drawArrays')).toHaveLength(frame.drawCalls)
    expect(gl.names().indexOf('clear')).toBeLessThan(gl.names().indexOf('drawArrays'))
  })

  it('runs the even-odd pass as stencil-then-cover, and resets the bit as it goes', () => {
    const { gl, canvas, overlay } = mount()
    const painter = createScenePainter(canvas, overlay)
    gl.reset()
    painter.paint(PAINT)

    const sequence = gl.names().filter((name) =>
      ['colorMask', 'stencilFunc', 'stencilOp', 'drawArrays'].includes(name),
    )
    // Rings into the stencil with colour writes off, then the cover box with the
    // stencil test on. The cover's `stencilOp` zeroes what the rings set, so no
    // clear is needed between one region and the next.
    expect(sequence.slice(0, 6)).toEqual([
      'colorMask',
      'stencilFunc',
      'stencilOp',
      'drawArrays',
      'colorMask',
      'stencilFunc',
    ])
    const ops = gl.of('stencilOp')
    expect(ops[0]?.args[2]).toBe(gl.gl.INVERT)
    expect(ops[1]?.args[2]).toBe(gl.gl.ZERO)
  })

  it('hands the camera to the world pass and identity to the chrome', () => {
    const { gl, canvas, overlay } = mount()
    const painter = createScenePainter(canvas, overlay)
    gl.reset()
    painter.paint({ ...PAINT, camera: { k: 2.5, x: 30, y: -12 } })

    const cameras = gl.of('uniform3f').map((call) => call.args.slice(1))
    expect(cameras).toContainEqual([2.5, 30, -12])
    // The chrome — the fog and the grain — is a fact about the picture plane, so
    // it is not moved by the camera. It is drawn by the quad programs, which take
    // no camera at all, so identity never has to be sent for them.
    expect(cameras.every((camera) => camera[0] === 2.5)).toBe(true)
  })

  it('switches blend function per run rather than sorting the frame', () => {
    const { gl, canvas, overlay } = mount()
    const painter = createScenePainter(canvas, overlay)
    gl.reset()
    painter.paint(PAINT)

    const additive = gl
      .of('blendFunc')
      .filter((call) => call.args[0] === gl.gl.ONE && call.args[1] === gl.gl.ONE)
    expect(additive.length).toBeGreaterThan(0)
  })

  it('uploads the grain tile once and keeps it', () => {
    const { gl, canvas, overlay } = mount()
    const painter = createScenePainter(canvas, overlay)
    painter.paint(PAINT)
    gl.reset()
    painter.paint(PAINT)
    painter.paint(PAINT)

    expect(gl.of('texImage2D')).toHaveLength(0)
    expect(gl.of('bindTexture').length).toBeGreaterThan(0)
  })
})

describe('a repaint re-sends nothing (prd-47 #178)', () => {
  /** The submit's journal minus the upload. `walk` never touches a buffer
   * binding — only `upload` does — so this is exactly "everything that decides
   * the picture". */
  const drawing = (gl: RecordingGl) =>
    gl.calls.filter((call) => call.name !== 'bufferData' && call.name !== 'bindBuffer')

  it('a repaint after a build sends zero bufferData, and still draws (L1)', () => {
    const { gl, canvas, overlay } = mount()
    const painter = createScenePainter(canvas, overlay)

    gl.reset()
    painter.paint(PAINT)
    // One `bufferData` per attribute — the existing law at `:161` states the
    // same number for a build, so the two agree on what a full upload costs.
    expect(gl.of('bufferData')).toHaveLength(3)

    gl.reset()
    painter.repaint({ width: PAINT.width, height: PAINT.height, dpr: PAINT.dpr, camera: { k: 2, x: 40, y: -10 } })
    expect(gl.of('bufferData')).toHaveLength(0)
    expect(gl.of('drawArrays').length).toBeGreaterThan(0)
  })

  it('a real build after a repaint still uploads (L2)', () => {
    // A one-shot L1 cannot see a cache that latches on the first frame and
    // never uploads again — this continues past the repaint into a second
    // build to prove the gate re-arms.
    const { gl, canvas, overlay } = mount()
    const painter = createScenePainter(canvas, overlay)

    painter.paint(PAINT)
    gl.reset()
    painter.repaint({ width: PAINT.width, height: PAINT.height, dpr: PAINT.dpr, camera: { k: 2, x: 40, y: -10 } })
    expect(gl.of('bufferData')).toHaveLength(0)

    gl.reset()
    painter.paint(PAINT)
    expect(gl.of('bufferData')).toHaveLength(3)
  })

  it('draws the identical sequence whether or not the upload ran (L3)', () => {
    // Same camera, twice: once as the build that uploads, once as a repaint
    // that skips it. `upload` depends on nothing `walk` reads, so the two
    // journals — upload calls excluded — must be the same calls in the same
    // order with the same arguments. A gate that skipped more than the upload
    // would show up here as a mismatch.
    //
    // Both painters get a throwaway warm-up paint first: `uploadNoise`
    // (`programs.ts`) caches the grain tile on the resources it is handed, so
    // an *uncached* first call and a *cached* second call differ in their own
    // right (a `texImage2D`/`texParameteri` burst) — a fact about the grain
    // cache, not about this one. Warming both painters identically removes
    // that confound and leaves only what L3 is actually about.
    const camera = { k: 1.7, x: 12, y: -6 }

    const a = mount()
    const painterA = createScenePainter(a.canvas, a.overlay)
    painterA.paint(PAINT)
    a.gl.reset()
    painterA.paint({ ...PAINT, camera })
    const journalA = drawing(a.gl)

    const b = mount()
    const painterB = createScenePainter(b.canvas, b.overlay)
    painterB.paint(PAINT)
    b.gl.reset()
    painterB.repaint({ width: PAINT.width, height: PAINT.height, dpr: PAINT.dpr, camera })
    const journalB = drawing(b.gl)

    expect(journalB).toEqual(journalA)
  })

  it('two builds are two frame objects — the premise this cache rests on (L4)', () => {
    // `frame.ts`'s contract: `buildFrame` returns a fresh object literal on
    // every call. This cache gates on `frame === uploadedFrame`, so if a
    // future `frame.ts` ever reused the frame object this law goes red here
    // rather than the picture going silently wrong on a stranger's machine.
    const { canvas, overlay } = mount()
    const painter = createScenePainter(canvas, overlay)
    expect(painter.paint(PAINT)).not.toBe(painter.paint(PAINT))
  })

  it('a context restore invalidates the cache (L5)', () => {
    // Driven through the real events, as the existing recovery law does
    // (`:93-117`), not by reaching inside. The new buffers `onRestored`
    // creates are empty, so the retained frame — unchanged by the loss —
    // must be re-uploaded into them rather than skipped as "already there".
    const { gl, canvas, overlay } = mount()
    const painter = createScenePainter(canvas, overlay)

    painter.paint(PAINT)
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    canvas.dispatchEvent(new Event('webglcontextrestored'))

    gl.reset()
    const repainted = painter.repaint({
      width: PAINT.width,
      height: PAINT.height,
      dpr: PAINT.dpr,
      camera: { k: 1.3, x: 5, y: -2 },
    })
    expect(repainted).toBe(true)
    expect(gl.of('bufferData')).toHaveLength(3)
  })

  it('three repaints in a row skip the upload every time (L6)', () => {
    // A gate that skips once and then forgets would show up as a nonzero
    // `bufferData` count on the second or third repaint.
    const { gl, canvas, overlay } = mount()
    const painter = createScenePainter(canvas, overlay)

    painter.paint(PAINT)
    gl.reset()
    for (const camera of [
      { k: 1.1, x: 2, y: 0 },
      { k: 1.4, x: 10, y: -4 },
      { k: 1.9, x: 22, y: -9 },
    ]) {
      painter.repaint({ width: PAINT.width, height: PAINT.height, dpr: PAINT.dpr, camera })
      expect(gl.of('drawArrays').length).toBeGreaterThan(0)
    }
    expect(gl.of('bufferData')).toHaveLength(0)
  })
})

describe('an environment with no GPU', () => {
  // The split this describe now records: jsdom (BOTH contexts null) stays
  // silent — the frame is built, nothing is drawn, and every unit test in the
  // repo keeps rendering; a REAL environment that can draw 2D but refused
  // WebGL2 is reported as `unavailable`, which the frame loop turns into
  // prd-36 S1's *error* state instead of a blank frame. The discriminator is
  // which half came up, decided once at creation.
  it('builds the frame and draws nothing, rather than throwing', () => {
    // jsdom's own answer, which is the shape `SceneView` has always survived.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const painter = createScenePainter(
      document.createElement('canvas'),
      document.createElement('canvas'),
    )

    expect(painter.lost).toBe(false)
    // Both halves absent is the TEST environment, not a GPU failure — silence
    // stays correct, or every jsdom mount in the repo would render the error
    // state.
    expect(painter.unavailable).toBe(false)
    expect(painter.paint(PAINT).vertices.n).toBeGreaterThan(0)
    expect(() => painter.resize()).not.toThrow()
    expect(() => painter.dispose()).not.toThrow()
  })

  it('refuses a 2D context handed back under a GL name', () => {
    // The suite mocks `getContext` to a 2D double in several places, and a
    // painter that took one of those for a WebGL2 context would throw inside the
    // frame loop rather than decline to draw.
    const twoD = { setTransform() {}, clearRect() {}, fillRect() {}, fillText() {} }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      twoD as unknown as CanvasRenderingContext2D,
    )
    expect(createGlPainter(document.createElement('canvas'))).toBeNull()

    const painter = createScenePainter(
      document.createElement('canvas'),
      document.createElement('canvas'),
    )
    expect(() => painter.paint(PAINT)).not.toThrow()
    // And this mock IS the real-browser-without-GL shape: 2D answers, GL does
    // not. The painter says so, rather than silently drawing only the labels —
    // the Electron shell without GPU access was the first live case.
    expect(painter.unavailable).toBe(true)
  })
})
