/**
 * THE HARNESS — and, first, why it does not use `requestAnimationFrame`.
 *
 * The obvious measurement is "run a rAF loop and count frames". On this box it
 * measures the compositor and nothing else: under WSLg an **empty** rAF callback
 * returns a median period of 34.4 ms whatever the page is drawing, and
 * `--disable-gpu-vsync --disable-frame-rate-limit` do not lift it. A renderer
 * comparison read off that clock would have found both arms identical at 29 fps
 * and concluded nothing.
 *
 * So the frame is paced by a `MessageChannel` — which yields to the event loop
 * without waiting for a display — and the run is closed by a **forced pipeline
 * sync**, so the number includes the GPU's work rather than just the time to
 * queue it:
 *
 * - WebGL: `fenceSync` + `clientWaitSync`, the exact primitive for this.
 * - Canvas 2D: a 1×1 `getImageData`, which forces Skia to flush and read back.
 *
 * **Once per run, and that is not fastidiousness.** The first cut of this
 * harness synced every frame, and canvas 2D came back at 198 ms/frame against
 * WebGL's 15 — a 13× gap that was mostly the instrument. Two separate reasons,
 * both real:
 *
 * 1. A GPU→CPU readback under WSL2 costs ~150 ms per call on this box, so a
 *    per-frame `getImageData` measured the virtualisation layer.
 * 2. Chrome demotes a canvas that is read back repeatedly to software raster,
 *    which would have made the canvas arm a CPU rasteriser wearing a GPU's name.
 *
 * `clientWaitSync` has neither problem, so the two arms' sync primitives are not
 * comparable per-frame and cannot be made so. What *is* comparable is
 * throughput: issue the whole run's frames back to back, sync **once** at the
 * end, and divide. That is {@link stream}, and it is the headline number.
 * {@link paced} is kept beside it as the diagnostic that shows the asymmetry
 * rather than hiding it — WebGL's two numbers agree, canvas's do not, and the
 * reason is the readback and not the painter.
 *
 * The p95 the brief asks for comes off `stream`'s per-frame wall times: with no
 * sync in the loop, a frame that runs long is a frame where the pipeline applied
 * backpressure, which is exactly the hitch a viewer feels.
 */

import { paint } from '../../../packages/web/src/scene/paint.js'
import type { Mark } from '../../../packages/web/src/scene/marks/index.js'
import { makeWorld, AMBIENT_MOTES } from './scene.js'
import { createGlPainter } from './webgl.js'

const params = new URLSearchParams(location.search)
const num = (key: string, fallback: number): number => Number(params.get(key) ?? fallback)
const CONFIG = {
  renderer: (params.get('renderer') ?? 'canvas') as 'canvas' | 'webgl',
  lanes: num('lanes', 30),
  colonies: num('colonies', 3),
  width: num('width', 1440),
  height: num('height', 900),
  dpr: num('dpr', 2),
  seconds: num('seconds', 30),
  run: num('run', 1),
  material: (params.get('material') ?? 'living') as 'living' | 'flat',
  noGrain: params.get('noGrain') === '1',
  noShells: params.get('noShells') === '1',
  /** Render one frame, post it back as a PNG, and stop. The visual check. */
  shot: params.get('shot') === '1',
}

/** How many frames the paced diagnostic runs for. Short: it is not the metric. */
const PACED_FRAMES = 40

const tick = (): Promise<void> =>
  new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => resolve()
    channel.port2.postMessage(0)
  })

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))
  return sorted[at] as number
}

interface Stats {
  n: number
  median: number
  p95: number
  min: number
  max: number
  mean: number
}

function stats(values: readonly number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((a, b) => a + b, 0) / (values.length || 1)
  return {
    n: values.length,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    min: sorted[0] ?? Number.NaN,
    max: sorted[sorted.length - 1] ?? Number.NaN,
    mean,
  }
}

interface Arm {
  draw: (marks: readonly Mark[]) => { submitMs: number; overlayMs: number; drawCalls: number }
  sync: () => void
  clear: () => void
  info: () => Record<string, unknown>
  gpuMs: () => number | null
}

function canvasArm(): Arm {
  const canvas = document.getElementById('scene') as HTMLCanvasElement
  canvas.width = Math.round(CONFIG.width * CONFIG.dpr)
  canvas.height = Math.round(CONFIG.height * CONFIG.dpr)
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
  return {
    draw: (marks) => {
      const t0 = performance.now()
      paint({ ctx, marks, width: CONFIG.width, height: CONFIG.height, dpr: CONFIG.dpr })
      return { submitMs: performance.now() - t0, overlayMs: 0, drawCalls: Number.NaN }
    },
    sync: () => {
      ctx.getImageData(0, 0, 1, 1)
    },
    clear: () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    },
    info: () => ({ backend: '2d' }),
    gpuMs: () => null,
  }
}

function webglArm(): Arm {
  const canvas = document.getElementById('scene') as HTMLCanvasElement
  const overlayCanvas = document.getElementById('overlay') as HTMLCanvasElement
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: true,
    depth: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  }) as WebGL2RenderingContext
  if (gl === null) throw new Error('no webgl2')
  const overlay = overlayCanvas.getContext('2d') as CanvasRenderingContext2D
  const painter = createGlPainter(gl, overlay, CONFIG.width, CONFIG.height, CONFIG.dpr)
  const scratch = new Uint8Array(4)
  return {
    draw: (marks) => painter.paint(marks),
    sync: () => painter.sync(),
    clear: () => {
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, scratch)
    },
    info: () => painter.info() as unknown as Record<string, unknown>,
    gpuMs: () => painter.gpuMs(),
  }
}

/**
 * THE CONTROL — an empty frame, closed the same way a real one is.
 *
 * This is what the two arms' sync primitives cost when there is nothing to draw,
 * and it is the floor under every number below. Reported, never subtracted:
 * subtracting a control turns a measurement into an argument.
 */
async function calibrate(arm: Arm): Promise<Stats> {
  const samples: number[] = []
  for (let i = 0; i < 120; i += 1) {
    const t0 = performance.now()
    arm.clear()
    arm.sync()
    samples.push(performance.now() - t0)
    if (i % 20 === 0) await tick()
  }
  return stats(samples.slice(20))
}

async function main(): Promise<void> {
  const arm = CONFIG.renderer === 'canvas' ? canvasArm() : webglArm()
  const world = makeWorld({
    lanes: CONFIG.lanes,
    colonies: CONFIG.colonies,
    width: CONFIG.width,
    height: CONFIG.height,
    material: CONFIG.material,
    noGrain: CONFIG.noGrain,
    noShells: CONFIG.noShells,
  })

  // Warm every cache both painters keep — paint.ts's four, the GL program link,
  // the glyph Path2Ds — so the steady state is a steady state.
  let markCount = 0
  for (let i = 0; i < 30; i += 1) {
    const built = world.frame(i * 16.7)
    markCount = built.marks.length
    arm.draw(built.marks)
  }
  arm.sync()
  await tick()

  const control = await calibrate(arm)

  // ---- stream: the whole run back to back, one sync at the end -------------
  const frameMs: number[] = []
  const modelMs: number[] = []
  const submitMs: number[] = []
  const overlayMs: number[] = []
  const gpuMs: number[] = []
  let drawCalls = Number.NaN

  let t = 0
  const runStarted = performance.now()
  while (performance.now() - runStarted < CONFIG.seconds * 1000) {
    const t0 = performance.now()
    const built = world.frame(t)
    const drawn = arm.draw(built.marks)
    const total = performance.now() - t0

    frameMs.push(total)
    modelMs.push(built.modelMs)
    submitMs.push(drawn.submitMs)
    overlayMs.push(drawn.overlayMs)
    const g = arm.gpuMs()
    if (g !== null) gpuMs.push(g)
    drawCalls = drawn.drawCalls
    markCount = built.marks.length

    t += 16.7
    await tick()
  }
  arm.sync()
  // Elapsed over the whole run, including the trailing drain: the honest
  // throughput. Anything still queued when the loop exited is paid for here.
  const streamFrameMs = (performance.now() - runStarted) / frameMs.length

  // ---- paced: one sync per frame. The diagnostic, not the metric -----------
  await tick()
  const pacedMs: number[] = []
  for (let i = 0; i < PACED_FRAMES; i += 1) {
    const t0 = performance.now()
    const built = world.frame(t)
    arm.draw(built.marks)
    arm.sync()
    pacedMs.push(performance.now() - t0)
    t += 16.7
    await tick()
  }

  // What is actually in the frame, by kind — so "both arms draw the same
  // picture" is a number a reviewer can check rather than a claim to take.
  const kinds: Record<string, number> = {}
  for (const mark of world.frame(t).marks) kinds[mark.kind] = (kinds[mark.kind] ?? 0) + 1

  const result = {
    config: CONFIG,
    marks: markCount,
    markKinds: kinds,
    ambientMotes: AMBIENT_MOTES,
    drawCalls,
    info: arm.info(),
    controlEmptyFrameMs: control,
    /** THE HEADLINE: wall-clock over the run ÷ frames, one sync at the end. */
    streamFrameMs,
    frames: frameMs.length,
    /** Per-frame wall time inside the stream — where the p95 hitch shows. */
    streamPerFrameMs: stats(frameMs),
    modelMs: stats(modelMs),
    submitMs: stats(submitMs),
    overlayMs: stats(overlayMs),
    gpuMs: gpuMs.length > 0 ? stats(gpuMs) : null,
    /** The diagnostic. Comparable within an arm, never across them. */
    pacedFrameMs: stats(pacedMs.slice(5)),
    devicePixelRatio: devicePixelRatio,
    userAgent: navigator.userAgent,
  }

  await fetch('/result', { method: 'POST', body: JSON.stringify(result) })
}

/**
 * THE VISUAL CHECK, and it is not optional.
 *
 * A painter that draws nothing is extremely fast. The only thing standing
 * between this spike and that failure mode is a pair of images a human can put
 * side by side, so the harness can render one deterministic frame in either arm
 * and post it back as a PNG.
 */
async function shot(): Promise<void> {
  const arm = CONFIG.renderer === 'canvas' ? canvasArm() : webglArm()
  const world = makeWorld({
    lanes: CONFIG.lanes,
    colonies: CONFIG.colonies,
    width: CONFIG.width,
    height: CONFIG.height,
    material: CONFIG.material,
    noGrain: CONFIG.noGrain,
    noShells: CONFIG.noShells,
  })
  for (let i = 0; i < 3; i += 1) arm.draw(world.frame(4000).marks)
  arm.sync()
  await tick()
  arm.draw(world.frame(4000).marks)
  arm.sync()

  // The GL arm's picture is two layers; flatten them the way the browser does.
  const scene = document.getElementById('scene') as HTMLCanvasElement
  const flat = document.createElement('canvas')
  flat.width = scene.width
  flat.height = scene.height
  const into = flat.getContext('2d') as CanvasRenderingContext2D
  into.drawImage(scene, 0, 0)
  if (CONFIG.renderer === 'webgl') {
    into.drawImage(document.getElementById('overlay') as HTMLCanvasElement, 0, 0)
  }

  await fetch('/result', {
    method: 'POST',
    body: JSON.stringify({ shot: true, config: CONFIG, png: flat.toDataURL('image/png') }),
  })
}

const entry = CONFIG.shot ? shot : main

entry().catch((error: unknown) => {
  void fetch('/result', {
    method: 'POST',
    body: JSON.stringify({ error: String(error), stack: (error as Error)?.stack, config: CONFIG }),
  })
})
