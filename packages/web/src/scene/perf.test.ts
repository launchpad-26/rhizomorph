import { reduceAll } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { buildFleet, fixtureHistory, fleet20Spec, manifestFor, type Fleet } from '../fleet/index.js'
import { layoutScene } from './geometry.js'
import { breathOf, motionMode, sceneMarks, type SceneFrame } from './marks/index.js'
import { ambientScreenMarks, ambientWorldMarks } from './marks/ambient.js'
import { dissolveMarks } from './marks/dissolve.js'
import { lightMarks } from './marks/light.js'
import { labelMarks, nodeMarks } from './marks/node.js'
import { rootMarks } from './marks/root.js'
import { loopingMarks, offFenceMarks, threadMarks } from './marks/thread.js'
import { DISSOLUTION } from './motion.js'
import { paint } from './paint.js'
import { ICE_050, ink, type Ink } from './palette.js'
import { PulseField } from './pulses.js'
import { RETURN, returnAt, type RetireState } from './retire.js'
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
 *
 * ---
 *
 * **#157's OWN BEFORE/AFTER**, taken because the operator suspected a frame-rate
 * cost in the round above. Six paired rounds, before and after **interleaved** so
 * both saw the same machine — which mattered: the same code measured 6.6 ms on a
 * quiet box and 22 ms while four sibling worktrees ran their suites, and a
 * before/after taken an hour apart would have "found" a 3× regression that was
 * the load average. Median of the quiet rounds:
 *
 * | measurement                          | before  | after   | budget |
 * | ------------------------------------ | ------- | ------- | ------ |
 * | whole frame, 30 lanes + 2 cuts       | 6.61ms  | 6.40ms  | 16.67  |
 * | …worst frame of sixty                | 9.9ms   | 8.8ms   | 16.67  |
 * | …as a share of a 60 fps frame        | 39.7%   | 38.4%   | 100%   |
 * | layout / marks / paint (after)       | 0.64 / 5.13 / 0.51 ms    ||
 * | marks by builder (after)             | thread 1.63 · root 1.36 · node 0.54 ||
 *
 * **No change, and by construction rather than by luck**: #157 moved colour
 * constants, and its one new per-frame call (`ambientLift`/`ambientVeil`) returns
 * its argument unchanged when `frame.vibrancy` is 1, which it always is live. The
 * two numbers above differ by less than the run-to-run spread on an idle box.
 *
 * **So the scene was not over budget and nothing was optimised**, which was the
 * brief's own condition. What the profile *does* say, for whoever needs it later:
 * the marks stage is 80% of the frame, and inside it `root` is the one builder
 * doing avoidable work — `contourLayers` re-samples the heart's scalar field and
 * re-walks 18–26 levels every frame for a shape that differs by the breath's
 * ±1.6%. Baking that field in unit space and *placing* it by a transform (what
 * `BakedMark` already does for the rim flora) would cache it across every calm
 * frame and take ~1.3 ms out of 6.4. That is the next win, and it is a real
 * refactor rather than a tweak — worth taking when the budget is tight, and not
 * worth the regression risk while the frame sits at 38% of it.
 *
 * ---
 *
 * **#161's OWN BEFORE/AFTER** is the third suite below, and it has its own
 * header: prd10 ruling 13 made a finished lane keep its strand, so the question
 * became what a thirty-lane field of mostly-finished lanes costs now that the
 * deletion is gone. Short answer, and the operator's own condition: **less than
 * the same lanes cost while they were alive**.
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

/**
 * A frame's cost, twice over.
 *
 * **Median** is the frame the operator actually watches — one GC pause in sixty
 * frames is not the frame cost. **Worst** is the one they *feel*: 60 fps is not a
 * mean, it is a deadline, and a scene whose median is comfortable but whose worst
 * frame doubles the budget reads as a stutter rather than as a fast picture. #157
 * opened on a suspected frame-rate cost, so both numbers are reported and both go
 * in the summary; neither is asserted, for the reason the header gives.
 */
interface Cost {
  medianMs: number
  worstMs: number
}

function costOf(work: () => void, frames: number): Cost {
  const samples: number[] = []
  for (let i = 0; i < frames; i += 1) {
    const started = performance.now()
    work()
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  return {
    medianMs: samples[Math.floor(samples.length / 2)] as number,
    worstMs: samples[samples.length - 1] as number,
  }
}

/** The median alone, for the two mote paths — they have no stages to break down. */
function medianMs(work: () => void, frames: number): number {
  return costOf(work, frames).medianMs
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

/**
 * Two cords mid-withdraw: the structural cap's own concurrency, which is the most
 * dissolution the scene can ever be running.
 */
function midCut(): ReadonlyMap<string, RetireState> {
  return new Map([
    ['lane-3', returnAt(RETURN.tensionMs + 300)],
    ['lane-11', returnAt(RETURN.tensionMs + 520)],
  ])
}

function frameFor(fleet: Fleet, geometry: ReturnType<typeof layoutScene>, now: number): SceneFrame {
  return {
    fleet,
    geometry,
    field: new PulseField(),
    salience: salienceOf({ fleet, hoverId: null, selectedId: null }),
    now,
    asOf: now,
    vibrancy: 1,
    reducedMotion: false,
    paused: false,
    breath: breathOf(now, motionMode({ reducedMotion: false, paused: false })),
  }
}

describe('the whole frame, before and after', () => {
  it('draws thirty lanes and a cut inside a 60 fps frame', () => {
    const fleet = fleet30()
    const retire = midCut()

    const draw = stub()
    /**
     * One frame, in its three stages. They are timed separately because "the scene
     * is over budget" is not an actionable sentence: the fix for a slow
     * `layoutScene` (cache the geometry) and the fix for a slow `paint` (blit a
     * sprite) are different fixes, and #157's brief is to find *the cheapest
     * offender first*. The stages are still run back-to-back in one call, so the
     * sum is the real frame and not three frames measured apart.
     */
    const frame = (now: number, into?: Stages): number => {
      const at = () => performance.now()
      const t0 = at()
      const geometry = layoutScene(fleet, { ...SIZE, now, retire })
      const t1 = at()
      const marks = sceneMarks(frameFor(fleet, geometry, now))
      const t2 = at()
      paint({ ctx: draw.ctx, marks, ...SIZE, dpr: 2 })
      const t3 = at()

      if (into !== undefined) {
        into.layout.push(t1 - t0)
        into.marks.push(t2 - t1)
        into.paint.push(t3 - t2)
      }
      return marks.length
    }

    withPath2D(() => {
      let clock = NOW
      for (let i = 0; i < 8; i += 1) frame(clock + i * 16)
      const marks = frame(clock)
      const stages: Stages = { layout: [], marks: [], paint: [] }
      const whole = costOf(() => {
        clock += 16
        frame(clock, stages)
      }, 60)

      report(
        `whole frame at 30 lanes + 2 cuts: ${whole.medianMs.toFixed(3)} ms median · ` +
          `${whole.worstMs.toFixed(3)} ms worst, ${marks} marks ` +
          `(60fps budget ${FRAME_MS.toFixed(2)} ms — ` +
          `${((whole.medianMs / FRAME_MS) * 100).toFixed(1)}% median, ` +
          `${((whole.worstMs / FRAME_MS) * 100).toFixed(1)}% worst)`,
      )
      report(
        `…by stage (median): layout ${median(stages.layout).toFixed(3)} ms · ` +
          `marks ${median(stages.marks).toFixed(3)} ms · ` +
          `paint ${median(stages.paint).toFixed(3)} ms`,
      )

      expect(whole.medianMs).toBeGreaterThan(0)
      expect(whole.worstMs).toBeGreaterThanOrEqual(whole.medianMs)
      expect(marks).toBeGreaterThan(0)
    })
  })
})

/**
 * A FIELD WHERE MOST LANES HAVE FINISHED (#161, prd10 rulings 13–16).
 *
 * The round's own measurement, and the condition the operator attached to it:
 * *"do not let persistent strands cost more than living ones did."* Before this
 * round a finished lane drew nothing at all — prd10 ruling 2 erased its geometry
 * when the dissolve completed — so a night of landed work emptied the canvas and
 * cost nothing to draw. Ruling 13 rescinds that, and the question is what a
 * thirty-lane field of mostly-finished lanes now costs.
 *
 * **Three frames, and they are measured INTERLEAVED** — one frame of each per
 * round, sixty rounds, in one process. #157 recorded why that matters and the
 * number that proved it: the same code measured 6.6 ms on a quiet box and 22 ms
 * while four sibling worktrees ran their suites, so a before and an after taken
 * even minutes apart would "find" a regression that was the load average. Round
 * robin is the only comparison that survives a busy machine, and it is what makes
 * these three numbers comparable to each other on any box, including a CI one.
 *
 * | frame                                    | what it is                        |
 * | ---------------------------------------- | --------------------------------- |
 * | **living** — 30 working lanes            | the ceiling the ruling caps against |
 * | **persistent** — 24 finished, 6 working  | what a long session now draws     |
 * | **hidden** — the same, HIDE FINISHED on  | the field the deletion used to leave |
 *
 * The same thirty lanes in all three, so nothing but their state differs. The
 * `hidden` frame is the closest thing the shipped code has to the old world: with
 * the toggle on, a settled lane contributes no marks at all, which is what every
 * settled lane did unconditionally before this round. It is a slight *under*-count
 * of the old cost (the old code still drew a finished lane's lens, name and
 * figure), so the gap it reports is the pessimistic reading of what persistence
 * bought — and it is also what ruling 16's load-bearing control is worth in ms.
 *
 * **What it measured, on the dev box** — median of the interleaved rounds, itself
 * the median of four consecutive runs, all four taken in the same session so the
 * rows are comparable to each other:
 *
 * | frame                                     | median  | worst   | marks | budget |
 * | ----------------------------------------- | ------- | ------- | ----- | ------ |
 * | 30 living lanes — the ceiling             | 6.79 ms | 13.2 ms |  331  | 16.67  |
 * | 24 persistent + 6 living — **after**      | 6.57 ms | 11.9 ms |  195  | 16.67  |
 * | …with HIDE FINISHED on — **before**       | 4.08 ms |  7.9 ms |   99  | 16.67  |
 * | whole frame, 30 lanes + 2 cuts (#157's)   | 8.45 ms | 13.0 ms |  327  | 16.67  |
 *
 * So the answer to the operator's condition is **yes**: a field where twenty-four
 * of thirty lanes have finished draws 195 marks where the same thirty lanes alive
 * draw 331, and it timed at or under the living frame in three of the four runs
 * and within the run-to-run spread in the fourth — 6.57 against 6.79 at the
 * median. The two are close enough that the honest reading is *no more
 * expensive* rather than *cheaper*, with the mark count being the part that will
 * still be true on somebody else's box. Persistence over deletion costs 2.5 ms of a 16.67 ms frame,
 * which is also exactly what ruling 16's load-bearing toggle is worth in ms.
 *
 * **The absolutes in that table are a loaded box and the ratios are not.** Taken
 * twenty minutes earlier on the same machine while it was quiet, the same four
 * rows read 5.31 / 4.87 / 3.14 / 6.52 ms — every number about 25% lower, every
 * ordering identical. #157's own benchmark is therefore unmoved (6.52 against its
 * recorded 6.40, inside the run-to-run spread on an idle box), which is the check
 * that this round did not make a *living* frame more expensive on the way past;
 * the 8.45 in the table is that same measurement under the load the other three
 * rows were taken under.
 *
 * A loaded box is where the interleave earns its keep: on one round taken while
 * sibling suites ran, all four numbers roughly doubled (11.7 / 11.2 / 7.5 / 12.5)
 * and the *ordering* did not move by so much as a pair. That is the property a
 * before and an after taken minutes apart cannot have — and it is why the
 * assertion beside the report is a count and the timeout below is generous.
 *
 * The law beside the report is a **count**, for the reason the header gives: a
 * wall clock under concurrent workers measures the box. A persistent field draws
 * strictly fewer marks than the same lanes did while they were alive — a finished
 * lane spends one ribbon and three glyphs where a living one spends a bloom, a
 * thread, its filaments and their tips, its bud, its node, its tuft and its state
 * marks — so "persistent strands cost no more than living ones did" is true by
 * construction of the display list rather than by a timing that happened to
 * come out that way.
 */
describe('thirty lanes where most have finished, before and after', () => {
  /** 24 of the 30 settled, past the last mote: the resting state of a long night. */
  function mostlyFinished(fleet: Fleet): ReadonlyMap<string, RetireState> {
    const settled = returnAt(RETURN.dissolvedMs)
    return new Map(fleet.lanes.slice(0, 24).map((lane) => [lane.id, settled]))
  }

  /**
   * Enough rounds that the median is a median rather than a sample. Three of
   * these frames per round is why the timeout below is generous: under
   * `--maxWorkers` this suite runs alongside 144 other files, and 180 thirty-lane
   * frames take as long as the box lets them.
   */
  const ROUNDS = 60

  it('reports all three interleaved, and draws fewer marks than the living field', () => {
    const fleet = fleet30()
    const retire = mostlyFinished(fleet)
    const draw = stub()

    /** One whole frame — layout, marks, paint — for one configuration. */
    const frame = (
      now: number,
      of: ReadonlyMap<string, RetireState> | undefined,
      hideFinished: boolean,
    ): number => {
      const geometry = layoutScene(fleet, { ...SIZE, now, retire: of, hideFinished })
      const marks = sceneMarks(frameFor(fleet, geometry, now))
      paint({ ctx: draw.ctx, marks, ...SIZE, dpr: 2 })
      return marks.length
    }

    const living = () => frame(clock, undefined, false)
    const persistent = () => frame(clock, retire, false)
    const hidden = () => frame(clock, retire, true)

    let clock = NOW
    withPath2D(() => {
      // Warm the JIT on all three, so the first round is the steady state.
      for (let i = 0; i < 8; i += 1) {
        clock = NOW + i * 16
        living()
        persistent()
        hidden()
      }

      // INTERLEAVED: one frame of each per round, so all three see the same
      // machine at the same instant. Never three separate `costOf` calls.
      const samples = { living: [] as number[], persistent: [] as number[], hidden: [] as number[] }
      for (let i = 0; i < ROUNDS; i += 1) {
        clock += 16
        for (const [name, work] of [
          ['living', living],
          ['persistent', persistent],
          ['hidden', hidden],
        ] as const) {
          const started = performance.now()
          work()
          samples[name].push(performance.now() - started)
        }
      }

      const worst = (of: readonly number[]): number => Math.max(...of)
      const counts = { living: living(), persistent: persistent(), hidden: hidden() }

      for (const name of ['living', 'persistent', 'hidden'] as const) {
        report(
          `30 lanes, ${name}: ${median(samples[name]).toFixed(3)} ms median · ` +
            `${worst(samples[name]).toFixed(3)} ms worst · ${counts[name]} marks ` +
            `(60fps budget ${FRAME_MS.toFixed(2)} ms — ` +
            `${((median(samples[name]) / FRAME_MS) * 100).toFixed(1)}% median)`,
        )
      }

      // THE LAW, and it is a count. 24 of these 30 lanes have finished, and the
      // frame that draws them is strictly cheaper than the frame that drew the
      // same lanes alive — which is the operator's condition, met by construction.
      expect(counts.persistent).toBeLessThan(counts.living)
      // …and the toggle really does take them off the canvas, which is what makes
      // it load-bearing rather than decorative (ruling 16).
      expect(counts.hidden).toBeLessThan(counts.persistent)
      // Every one of the 24 is still drawn when it is not hidden: the count is
      // lower because a strand is cheap, never because a lane went missing.
      const geometry = layoutScene(fleet, { ...SIZE, now: clock, retire })
      const strands = sceneMarks(frameFor(fleet, geometry, clock)).filter(
        (mark) => mark.role === 'persist',
      )
      expect(strands).toHaveLength(24)
    })
  }, 60_000)
})

interface Stages {
  layout: number[]
  marks: number[]
  paint: number[]
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/**
 * …AND WHICH BUILDER IT WENT TO (#157's first task).
 *
 * The stage breakdown above says the marks stage is where a 30-lane frame spends
 * itself. That is still not an actionable sentence — "the display list is slow"
 * has ten possible fixes — so this walks `sceneMarks`'s own layer order and times
 * each layer separately, in the same paint order and against the same frame, so
 * the numbers sum to the stage above rather than describing some other scene.
 *
 * It exists because the *next* round should not have to rediscover it. #157
 * measured, found the frame comfortably inside its budget at thirty lanes, and
 * therefore deliberately did not spend the round optimising: the brief was
 * explicit that the perf work is conditional on being over budget, and a refactor
 * bought against a budget that is not tight is a regression risk taken for
 * nothing. What it leaves behind is this, and the one line in the summary that
 * says where the next win is if the budget ever does get tight.
 */
describe('the marks stage, by builder', () => {
  it('reports where a thirty-lane display list is actually built', () => {
    const fleet = fleet30()
    const retire = midCut()
    const samples = new Map<string, number[]>()

    const time = (name: string, work: () => void): void => {
      const started = performance.now()
      work()
      const taken = performance.now() - started
      const into = samples.get(name)
      if (into === undefined) samples.set(name, [taken])
      else into.push(taken)
    }

    const run = (now: number): void => {
      const geometry = layoutScene(fleet, { ...SIZE, now, retire })
      const frame = frameFor(fleet, geometry, now)
      const { threads } = geometry
      const perThread = (name: string, of: (t: (typeof threads)[number]) => unknown) =>
        time(name, () => {
          for (const thread of threads) of(thread)
        })

      // `sceneMarks`'s own order (`marks/index.ts`), layer by layer.
      time('ambient-world', () => void ambientWorldMarks(frame))
      perThread('thread', (t) => threadMarks(frame, t))
      perThread('off-fence', (t) => offFenceMarks(frame, t))
      time('root', () => void rootMarks(frame))
      perThread('light', (t) => lightMarks(frame, t))
      perThread('looping', (t) => loopingMarks(frame, t))
      time('dissolve', () => void dissolveMarks(frame))
      perThread('node', (t) => nodeMarks(frame, t))
      perThread('label', (t) => labelMarks(frame, t))
      time('ambient-screen', () => void ambientScreenMarks(frame))
    }

    withPath2D(() => {
      let clock = NOW
      for (let i = 0; i < 8; i += 1) run(clock + i * 16)
      samples.clear()
      for (let i = 0; i < 60; i += 1) run((clock += 16))
    })

    const ranked = [...samples.entries()]
      .map(([name, taken]) => [name, median(taken)] as const)
      .sort((a, b) => b[1] - a[1])

    report(
      `marks stage by builder (median, 30 lanes + 2 cuts): ` +
        ranked.map(([name, ms]) => `${name} ${ms.toFixed(3)} ms`).join(' · '),
    )

    // The law, and it is a shape rather than a clock: every layer `sceneMarks`
    // draws was reached and timed, so a builder added later cannot quietly stay
    // out of the profile.
    expect(ranked).toHaveLength(10)
    for (const [name, ms] of ranked) expect(ms, `${name} was not measured`).toBeGreaterThanOrEqual(0)
  })
})
