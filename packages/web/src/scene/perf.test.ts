import { reduceAll } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { buildFleet, fixtureHistory, fleet20Spec, manifestFor, type Fleet } from '../fleet/index.js'
import { layoutScene } from './geometry.js'
import { breathOf, motionMode, sceneMarks, type SceneFrame } from './marks/index.js'
import { DISSOLUTION } from './motion.js'
import { paint } from './paint.js'
import { ICE_050, ink, type Ink } from './palette.js'
import { PulseField } from './pulses.js'
import { CUT, cutAt, type RetireState } from './retire.js'
import { salienceOf } from './salience.js'

/**
 * THE SPIKE'S HANDOFF, MEASURED (prd10 ruling 7, and #144's first task).
 *
 * The spike ruled that {@link DISSOLUTION}'s motes must be **pre-rendered sprite
 * stamps** rather than the per-frame radial gradients `paint.ts`'s `glow` builds
 * (its finding against `paint.ts:214`), and handed the measurement over rather
 * than making it: at the class's cap of {@link DISSOLUTION.maxLive} motes, is a
 * sprite blit cheap enough to run *alongside* the existing scene inside a 60 fps
 * frame on this box?
 *
 * **What can and cannot be measured here, stated plainly.** This suite runs in
 * jsdom, which has no 2D context at all — `getContext('2d')` returns `null`, and
 * a rasterising one (`node-canvas`) is a new dependency and outside this issue's
 * fence. So the numbers below are the **CPU side** of each approach: the calls
 * the executor issues, the objects it allocates, and the JS time to issue them,
 * against a recording context that answers like a real one. The raster side —
 * shading π·r² pixels through a gradient versus copying a 32×32 tile — is the
 * spike's own verdict and is not re-measured here; what *is* measured is the
 * thing that made the spike rule at all, which is that the gradient path
 * allocates a `CanvasGradient` **per mote per frame** and the sprite path
 * allocates none.
 *
 * The deliberate shape of every assertion follows prd7's renderer note and the
 * two failures recorded in `marks.test.ts`'s frame-budget suite: **timings are
 * reported and never asserted** (under `--maxWorkers` a wall clock measures the
 * machine, not the code), and the laws beside them are counts, which are
 * deterministic on a loaded CI box and on a quiet laptop alike.
 *
 * **What it measured, on the dev box, before and after #144** (ruling 7's
 * before/after, written down rather than left in a terminal):
 *
 * | measurement                          | before  | after   | budget |
 * | ------------------------------------ | ------- | ------- | ------ |
 * | 240 motes, per-frame gradient-glow   | 0.063ms | 0.073ms | —      |
 * | 240 motes, sprite-blit               | 0.017ms | 0.024ms | —      |
 * | whole frame, 30 lanes + 2 cuts       | 5.109ms | 7.499ms | 16.67  |
 * | …as a share of a 60 fps frame        | 30.7%   | 45.0%   | 100%   |
 * | marks in that frame                  | 203     | 329     | —      |
 *
 * So the answer to the handoff is yes with room: the ruled technique is a third of
 * the cost of the one it replaces and allocates nothing, and the whole gorgeous
 * round — apices, buds, the heart's rings, the ambient layer and a composting cord
 * — spends about 2.4 ms of the 11.5 ms that was spare.
 */

const N = DISSOLUTION.maxLive
const NOW = Date.UTC(2026, 7, 4, 12, 0, 0)
const SIZE = { width: 900, height: 260 }
/** 60 fps. The number every report below is read against. */
const FRAME_MS = 1000 / 60

interface Counters {
  gradients: number
  fills: number
  arcs: number
  draws: number
  /** How many times the blend mode was *changed* — the batching claim. */
  composites: number
}

interface Stub {
  ctx: CanvasRenderingContext2D
  counters: Counters
  reset: () => void
}

/**
 * A context that answers like a real one and counts. `globalCompositeOperation`
 * is a real accessor rather than a field, because "how many `lighter` blocks did
 * the frame open?" is the whole of the batching law and a plain property could
 * not see a write.
 */
function stub(): Stub {
  const counters: Counters = { gradients: 0, fills: 0, arcs: 0, draws: 0, composites: 0 }
  let blend = 'source-over'

  const ctx = {
    save() {},
    restore() {},
    setTransform() {},
    translate() {},
    rotate() {},
    scale() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {
      counters.arcs += 1
    },
    fill() {
      counters.fills += 1
    },
    stroke() {},
    fillRect() {},
    strokeRect() {},
    fillText() {},
    setLineDash() {},
    drawImage() {
      counters.draws += 1
    },
    createRadialGradient() {
      counters.gradients += 1
      return { addColorStop() {} }
    },
    createLinearGradient() {
      counters.gradients += 1
      return { addColorStop() {} }
    },
    createPattern() {
      return { setTransform() {} }
    },
    get globalCompositeOperation(): string {
      return blend
    },
    set globalCompositeOperation(value: string) {
      if (value !== blend) counters.composites += 1
      blend = value
    },
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    imageSmoothingEnabled: true,
  }

  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    counters,
    reset: () => {
      counters.gradients = 0
      counters.fills = 0
      counters.arcs = 0
      counters.draws = 0
      counters.composites = 0
      blend = 'source-over'
    },
  }
}

/** jsdom has no `Path2D`; the glyph and baked painters both construct one. */
function withPath2D<T>(work: () => T): T {
  const had = 'Path2D' in globalThis
  if (!had) {
    ;(globalThis as { Path2D?: unknown }).Path2D = class {
      constructor(public d?: string) {}
      moveTo(): void {}
      lineTo(): void {}
      closePath(): void {}
    }
  }
  try {
    return work()
  } finally {
    if (!had) delete (globalThis as { Path2D?: unknown }).Path2D
  }
}

interface Mote {
  x: number
  y: number
  radius: number
  ink: Ink
}

/** A field of motes to draw, laid out deterministically. No clock, no random. */
function field(count: number): Mote[] {
  return Array.from({ length: count }, (_unused, i) => ({
    x: 120 + ((i * 37) % 700),
    y: 40 + ((i * 53) % 180),
    radius: 2.5 + ((i * 7) % 9) * 0.4,
    ink: ink(ICE_050, 0.2 + ((i * 11) % 60) / 200),
  }))
}

/**
 * THE OLD WAY — one `glow` mark per mote, exactly as `paint.ts`'s `glow` draws
 * one: a fresh `createRadialGradient`, two stops, an `arc` and a `fill`, with the
 * blend switched per mark by `blend()`.
 */
function gradientFrame(ctx: CanvasRenderingContext2D, motes: readonly Mote[]): void {
  for (const mote of motes) {
    // What `blend()` does per mark: a glow is light, so it opens its own block.
    ctx.globalCompositeOperation = 'lighter'
    const gradient = ctx.createRadialGradient(mote.x, mote.y, 0, mote.x, mote.y, mote.radius)
    gradient.addColorStop(0, 'rgba(240, 245, 252, 0.5)')
    gradient.addColorStop(1, 'rgba(240, 245, 252, 0)')
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(mote.x, mote.y, mote.radius, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
  }
}

/**
 * THE RULED WAY — one 32 px sprite, stamped. One blend switch for the whole
 * field, one `drawImage` per mote, and **no gradient allocated at all**: the
 * falloff was rasterised once, into a tile the size a mote is ever drawn at.
 */
function spriteFrame(
  ctx: CanvasRenderingContext2D,
  sprite: CanvasImageSource,
  motes: readonly Mote[],
): void {
  ctx.globalCompositeOperation = 'lighter'
  for (const mote of motes) {
    const size = mote.radius * 2
    ctx.globalAlpha = mote.ink.alpha
    ctx.drawImage(sprite, mote.x - mote.radius, mote.y - mote.radius, size, size)
  }
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
}

/** Median rather than mean: one GC pause in sixty frames is not the frame cost. */
function medianMs(work: () => void, frames: number): number {
  const samples: number[] = []
  for (let i = 0; i < frames; i += 1) {
    const started = performance.now()
    work()
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)] as number
}

function report(line: string): void {
  // eslint-disable-next-line no-console -- the measurement is the deliverable
  console.log(line)
}

describe(`sprite-blit vs per-frame gradient-glow at N=${N}`, () => {
  const motes = field(N)
  const sprite = { width: 32, height: 32 } as unknown as CanvasImageSource

  it('reports both costs, and allocates a gradient per mote only one way', () => {
    const gradient = stub()
    const blit = stub()

    // Warm the JIT: the steady state a running loop sees, not the first call.
    for (let i = 0; i < 8; i += 1) {
      gradientFrame(gradient.ctx, motes)
      spriteFrame(blit.ctx, sprite, motes)
    }

    gradient.reset()
    blit.reset()
    const gradientMs = medianMs(() => gradientFrame(gradient.ctx, motes), 60)
    const blitMs = medianMs(() => spriteFrame(blit.ctx, sprite, motes), 60)

    report(
      `motes at N=${N}: gradient-glow ${gradientMs.toFixed(3)} ms/frame · ` +
        `sprite-blit ${blitMs.toFixed(3)} ms/frame ` +
        `(60fps budget ${FRAME_MS.toFixed(2)} ms)`,
    )
    report(
      `motes at N=${N}: gradient-glow allocates ${gradient.counters.gradients / 60} gradients and ` +
        `opens ${gradient.counters.composites / 60} blend blocks per frame · ` +
        `sprite-blit allocates ${blit.counters.gradients / 60} and opens ` +
        `${blit.counters.composites / 60}`,
    )

    // THE LAW, and it is a count rather than a clock. One gradient per mote per
    // frame is the allocation the spike ruled against; the sprite path's is zero
    // by construction, and its blend switching is O(1) in the mote count.
    expect(gradient.counters.gradients).toBe(N * 60)
    expect(gradient.counters.fills).toBe(N * 60)
    expect(blit.counters.gradients).toBe(0)
    expect(blit.counters.draws).toBe(N * 60)
    // Two switches per frame (in and out), whatever N is — the batching claim.
    expect(blit.counters.composites).toBe(2 * 60)
    expect(gradient.counters.composites).toBe(2 * N * 60)

    // Reported, not asserted (see the header): a wall clock under concurrent
    // workers measures the box. The numbers go in the issue's summary.
    expect(gradientMs).toBeGreaterThan(0)
    expect(blitMs).toBeGreaterThan(0)
  })
})

/**
 * …ALONGSIDE THE EXISTING SCENE, which is the half the handoff actually turns
 * on: 240 motes cheap in isolation would still be a regression if the frame they
 * land in has no room left. So this is the whole loop — `layoutScene`,
 * `sceneMarks`, `paint` — at thirty lanes with a cord mid-cut, which is the
 * frame a dissolve is drawn in.
 */
describe('the whole frame, before and after', () => {
  function fleet30(): Fleet {
    const state = reduceAll(fixtureHistory(fleet20Spec(), NOW))
    const base = buildFleet(state, { now: NOW, manifest: manifestFor(fleet20Spec()) })
    return {
      ...base,
      lanes: Array.from({ length: 30 }, (_unused, i) => ({
        ...(base.lanes[i % base.lanes.length] as (typeof base.lanes)[number]),
        id: `lane-${i}`,
        handles: [`lane-${i}`],
        slot: i,
      })),
    }
  }

  it('draws thirty lanes and a cut inside a 60 fps frame', () => {
    const fleet = fleet30()
    // Two cords mid-retract: the structural cap's own concurrency, which is the
    // most dissolution the scene can ever be running.
    const retire: ReadonlyMap<string, RetireState> = new Map([
      ['lane-3', cutAt(CUT.tensionMs + 300)],
      ['lane-11', cutAt(CUT.tensionMs + 520)],
    ])

    const draw = stub()
    const frame = (now: number): number => {
      const mode = motionMode({ reducedMotion: false, paused: false })
      const geometry = layoutScene(fleet, { ...SIZE, now, retire })
      const sceneFrame: SceneFrame = {
        fleet,
        geometry,
        field: new PulseField(),
        salience: salienceOf({ fleet, hoverId: null, selectedId: null }),
        now,
        asOf: now,
        vibrancy: 1,
        reducedMotion: false,
        paused: false,
        breath: breathOf(now, mode),
      }
      const marks = sceneMarks(sceneFrame)
      paint({ ctx: draw.ctx, marks, ...SIZE, dpr: 2 })
      return marks.length
    }

    withPath2D(() => {
      let clock = NOW
      for (let i = 0; i < 8; i += 1) frame(clock + i * 16)
      const marks = frame(clock)
      const whole = medianMs(() => {
        clock += 16
        frame(clock)
      }, 60)

      report(
        `whole frame at 30 lanes + 2 cuts: ${whole.toFixed(3)} ms/frame median, ` +
          `${marks} marks (60fps budget ${FRAME_MS.toFixed(2)} ms, ` +
          `${((whole / FRAME_MS) * 100).toFixed(1)}% of it)`,
      )
      expect(whole).toBeGreaterThan(0)
      expect(marks).toBeGreaterThan(0)
    })
  })
})
