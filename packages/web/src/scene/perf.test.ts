import v8 from 'node:v8'
import vm from 'node:vm'
import { reduceAll } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { buildFleet, fixtureHistory, fleet20Spec, manifestFor, type Fleet } from '../fleet/index.js'
import { layoutScene } from './geometry.js'
import { breathOf, motionMode, sceneMarks, type Mark, type SceneFrame } from './marks/index.js'
import { ambientScreenMarks, ambientWorldMarks } from './marks/ambient.js'
import { dissolveMarks } from './marks/dissolve.js'
import { lightMarks } from './marks/light.js'
import { labelMarks, nodeMarks } from './marks/node.js'
import { rootMarks } from './marks/root.js'
import { loopingMarks, offFenceMarks, threadMarks } from './marks/thread.js'
import { DISSOLUTION } from './motion.js'
import { Batch, buildFrame, settledRibbonCacheCounts } from './gl/index.js'
import { DARK_PALETTE, ICE_050, ink, type Ink } from './palette.js'
import { PulseField } from './pulses.js'
import { RETURN, returnAt, type RetireState } from './retire.js'
import { salienceOf } from './salience.js'

// @gate-timing — wall-clock frame/measurement suite (#209). scripts/gate.sh
// greps for this exact marker to route the file into its serial, alone
// timing pass instead of the 4x load batches: these numbers only mean
// anything under that condition. Carry this comment with the file if you
// rename or move it; a file without it is invisible to that pass.

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
/**
 * How long a benchmark in this file may take, wall-clock.
 *
 * Every `it` below is given it explicitly, because vitest's 5 s default is a
 * *timing* assertion and this file's whole discipline is that timings are
 * reported and never asserted. Each of these draws sixty to a hundred and eighty
 * thirty-lane frames, and under `--maxWorkers` it does so alongside 144 other
 * test files: the same sixty frames that take 0.4 s on a quiet box took 7.7 s
 * while four sibling worktrees ran their suites, which is a failure about the
 * load average rather than about the scene. Generous enough that only a genuine
 * hang trips it.
 */
const BENCH_TIMEOUT_MS = 120_000

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
  }, BENCH_TIMEOUT_MS)
})

/**
 * …ALONGSIDE THE EXISTING SCENE, which is the half the handoff actually turns
 * on: 240 motes cheap in isolation would still be a regression if the frame they
 * land in has no room left. So this is the whole loop — `layoutScene`,
 * `sceneMarks`, `paint` — at thirty lanes with a cord mid-cut, which is the
 * frame a dissolve is drawn in.
 */
function fleetSized(total: number): Fleet {
  const state = reduceAll(fixtureHistory(fleet20Spec(), NOW))
  const base = buildFleet(state, { now: NOW, manifest: manifestFor(fleet20Spec()) })
  return {
    ...base,
    lanes: Array.from({ length: total }, (_unused, i) => ({
      ...(base.lanes[i % base.lanes.length] as (typeof base.lanes)[number]),
      id: `lane-${i}`,
      handles: [`lane-${i}`],
      slot: i,
    })),
  }
}

function fleet30(): Fleet {
  return fleetSized(30)
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
    quality: 'rich',
  vibrancy: 1,
    reducedMotion: false,
    paused: false,
    breath: breathOf(now, motionMode({ reducedMotion: false, paused: false })),
    palette: DARK_PALETTE,
  }
}

describe('the whole frame, before and after', () => {
  it('draws thirty lanes and a cut inside a 60 fps frame', () => {
    const fleet = fleet30()
    const retire = midCut()

    const vertices = new Batch()
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
      buildFrame(marks, SIZE, vertices)
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
  }, BENCH_TIMEOUT_MS)
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
    const vertices = new Batch()

    /** One whole frame — layout, marks, paint — for one configuration. */
    const frame = (
      now: number,
      of: ReadonlyMap<string, RetireState> | undefined,
      hideFinished: boolean,
    ): number => {
      const geometry = layoutScene(fleet, { ...SIZE, now, retire: of, hideFinished })
      const marks = sceneMarks(frameFor(fleet, geometry, now))
      buildFrame(marks, SIZE, vertices)
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
  }, BENCH_TIMEOUT_MS)
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
  }, BENCH_TIMEOUT_MS)
})

/**
 * A LONG-LIVED FIELD OF RETIRED STRANDS (#175 measured it, #178 fixed it —
 * the 2026-08-05 adversarial audit's P2 scene finding).
 *
 * The audit's own reading of prd10 rulings 13–16: since #161 a finished lane's
 * strand is never removed (`byDepth`, `marks/index.ts:54`), and every thread —
 * finished included — got a full `ThreadGeometry` from `layoutScene` every
 * frame, and a full ribbon rebuild from `persistentMarks`/`persistNodeMarks`
 * every frame after that. The `mostlyFinished` suite above already measured
 * 24-of-30 finished; the field it left unmeasured is the one a multi-day
 * session actually accumulates — thirty *working* lanes standing in front of a
 * hundred or two hundred lanes that landed hours or days ago and are never
 * coming back. This suite is that field, at the sizes the audit named.
 *
 * **#175 measured; #178 built the cache.** Three caches, all keyed on the same
 * fact — a settled strand is provably `unmoving` (prd10 ruling 14) — and all
 * gated the same way, on `layoutScene`'s own `dissolve >= 1` (`geometry.ts`'s
 * `retiredSpineCacheFor`):
 *
 * 1. `geometry.ts` caches a settled lane's spine itself — the waypoints, the
 *    Catmull-Rom fit, the release deformation, the filaments — keyed on the
 *    world frame (a resize, or the mass growing as *other* lanes land, #118)
 *    plus this lane's own angle and drift. Once cached, `layoutScene` hands
 *    every mark builder the SAME `path` array, frame after frame.
 * 2. `marks/thread.ts`'s `persistRibbon` and `marks/node.ts`'s
 *    `persistNodeRibbons` cache the `ribbonOutline` polygons built from that
 *    path (the strand itself, its tail, its seal) — the marks-stage cost the
 *    audit's own numbers below show was the *larger* half. Both are keyed on
 *    `thread.path`'s own identity, so they warm exactly when (1) does and need
 *    no gate of their own to stay in sync with it.
 *
 * **What is never cached: the paint.** `budget()` reads `frame.salience`, so a
 * settled lane's brightness still answers a hover, a selection, or a summons
 * dimming the calm world around it — every cached mark's `.paint` is
 * overwritten fresh every frame at its call site, which is the same split a
 * `RibbonMark` already makes between `outline` (what is filled, cached) and
 * `paint` (what fills it, live).
 *
 * Same interleaved discipline as every suite above and for the same reason
 * (#157): `living30` (the ceiling — thirty lanes, all working, nothing
 * retired), `persistent100`/`persistent200` (thirty working standing in front
 * of a hundred/two hundred retired) and `hidden100`/`hidden200` (the same
 * fields with HIDE FINISHED on) are drawn one frame each per round, so a
 * sibling worktree's test run inflates all five equally rather than forging a
 * comparison between them.
 *
 * **THE HIDE FINISHED QUESTION (prd10 ruling 16), answered by construction —
 * and the answer has inverted.** `layoutScene` used to compute a retired
 * lane's full spine and only *after* that full build read the hide-finished
 * toggle, so a hidden lane's geometry was identical to a shown one's and the
 * toggle skipped paint only. It now reads the toggle first: once a lane is
 * `hideable` (`cut.stage === 'persistent' && hideFinished`), no waypoints, no
 * Catmull-Rom fit, no release, no filaments are built for it at all — the
 * assertions below now prove the STRONGER law, that a hidden lane's geometry
 * is *empty* rather than merely unpainted.
 *
 * **What it measured, on the dev box, before and after** — one representative
 * interleaved run each (the suite alone, filtered by name, so the numbers
 * below are not also carrying 144 sibling test files the way a whole-file run
 * does; every run agreed on ordering, and the after numbers move around with
 * the box's own load exactly as the before ones did — see #157's own lesson
 * about reading ratios, not absolutes, on a shared machine):
 *
 * | frame                                       | before   | after    | Δ     | marks (aft.) | budget (aft.) |
 * | -------------------------------------------- | -------- | -------- | ----- | ------------- | -------------- |
 * | living30 — ceiling (paired w/ 100)          |  8.02 ms |  6.56 ms | 0.82× |      331      |     39.4%      |
 * | persistent100 — 30 living + 100 retired     | 22.10 ms |  9.17 ms | 0.42× |      831      |     55.0%      |
 * | hidden100 — same, HIDE FINISHED on          | 12.61 ms |  8.35 ms | 0.66× |      431      |     50.1%      |
 * | living30 — ceiling (paired w/ 200)          |  6.73 ms |  7.71 ms | 1.15× |      331      |     46.3%      |
 * | persistent200 — 30 living + 200 retired     | 28.37 ms | 11.95 ms | 0.42× |     1331      |     71.7%      |
 * | hidden200 — same, HIDE FINISHED on          | 13.43 ms |  9.06 ms | 0.67× |      531      |     54.4%      |
 *
 * …by stage, after (median, ms) — layout / marks / paint:
 *
 * | frame          | before (l/m/p)         | after (l/m/p)        |
 * | -------------- | ----------------------- | --------------------- |
 * | persistent100  | 3.87 / 16.71 / 1.53     | 0.90 / 6.57 / 1.36    |
 * | hidden100      | 3.03 / 7.84 / 1.07      | 0.84 / 6.71 / 0.91    |
 * | persistent200  | 4.28 / 19.89 / 2.93     | 1.21 / 7.77 / 2.58    |
 * | hidden200      | 4.05 / 7.28 / 1.70      | 0.96 / 6.38 / 1.52    |
 *
 * **THE PAINT COLUMN ABOVE IS NOT COMPARABLE TO A POST-`8686f24` READING, AND
 * #32 IS A NET REGRESSION ON IT.** Both facts came out of one bisect, run
 * 2026-08-28 on macOS in a throwaway worktree, each cell the suite's own
 * `retired-field persistent200` line, endpoints re-measured minutes apart.
 * `docs/review/2026-08-24-input-latency-audit.md`'s addendum reported this cell
 * at ~7x its committed paint figure on a second box and named two candidate
 * causes; it is neither of them.
 *
 * *One — the stage changed meaning.* These rows were written at `da9d10a`
 * (2026-08-05), when the paint stage timed `paint({ ctx: draw.ctx, … })`: the
 * canvas-2D painter issuing calls into this file's own recording stub, whose
 * methods are empty bodies incrementing counters, because jsdom has no 2D
 * context at all (ADR-0006). `8686f24` (#578) replaced that with `buildFrame`,
 * which really does tessellate, under the same jsdom. Across that one commit:
 *
 * | commit                        | paint (persistent200) | paint (living30) |
 * | ----------------------------- | --------------------- | ---------------- |
 * | `8686f24^` — 2D calls into a stub |  1.638 ms         | 0.235 ms         |
 * | `8686f24` — #578, real tessellation | 12.543 ms       | 1.104 ms         |
 *
 * So 2.58 ms and 17.1–19.5 ms are not the same quantity measured twice, and the
 * *before* column (2.93 ms) is exactly as unreproducible as the after — which
 * is the tell the audit read as suspicious and could not place. Nothing
 * regressed here; a stage started measuring work it had never been able to
 * reach.
 *
 * *Two — and this one is real.* Bisecting the 31 scene commits from `8686f24`
 * to `48c3476` puts the whole of the remaining rise on **one commit, #32's own**
 * (`f60e0af` → `b89ca23`), with the living-only ceiling flat across it:
 *
 * | commit                        | paint (persistent200) | paint (living30) |
 * | ----------------------------- | --------------------- | ---------------- |
 * | `c31d04b` (mid-range)         | 12.539 ms             | 1.095 ms         |
 * | `d6bbf78` (#32's grandparent) | 13.297 ms             | 1.879 ms         |
 * | `f60e0af` (#32's parent)      | 13.392 ms             | 1.904 ms         |
 * | `b89ca23` (#32)               | **24.682 ms**         | 1.888 ms         |
 *
 * **The cache hits perfectly and is still a 1.84x regression.** The counting law
 * below reads 600 settled ribbons tessellated on frame one and zero misses for
 * every frame after, so this is not a cache that fails to warm — it is a cache
 * whose key costs more than the work it saves. `digestRibbon` walks every point
 * of every settled outline into a string every frame; at this size that is a few
 * hundred points x 600 ribbons x 60 Hz. Two measurements at `b89ca23` isolate it:
 * forcing `isSettledRibbon` to `false` (the pre-#32 path) returns paint to
 * **13.312 ms**, and keying the slot on the `outline` array's own identity
 * instead of its contents — which is what `geometry.ts`'s and `marks/thread.ts`'s
 * sibling caches already do one stage up, and what makes them cheap — gives
 * **10.309 ms**, a genuine 23% win over pre-#32 rather than an 84% loss.
 *
 * That last figure is a probe, not a proposal: identity-keying can only ever
 * produce a false MISS (a fresh array degrades to the pre-#32 path), never a
 * false hit, provided no builder mutates an outline in place — but three arms of
 * `gl/frame.test.ts`'s cache suite hand `buildFrame` a freshly-built outline each
 * frame and assert a hit, so they encode content-digest semantics and would have
 * to be restated as the production invariant they stand in for. Filed rather than
 * fixed here.
 *
 * **Both conditions the issue set are met.** 200-retired, shown, is now 71.7%
 * of a 60 fps frame's budget — comfortably inside it, where it was 170.2%
 * (4.2–4.7× the living-only ceiling) before. Hidden is now within a run's own
 * noise of living-only (200 retired hidden: 1.17× `living30`, against 2.0×
 * before) rather than still spending 80.6% of the budget on thirty working
 * lanes' worth of visual result. `layoutScene`'s own stage collapses to
 * roughly `living30`'s cost regardless of retired count (0.90–1.21 ms against
 * a 4.28 ms high before); the marks stage — the larger half, and the one this
 * lane's own fence had to reach past `geometry.ts` for — drops from
 * 16.71–19.89 ms to 6.57–7.77 ms, because a settled lane's three ribbons
 * (strand, tail, seal) are now built once and reused rather than rebuilt every
 * frame at every one of the sizes the audit named.
 */
describe('a long field of retired strands (#175, prd10 rulings 13-16)', () => {
  /** Every lane at index ≥ `livingCount` is settled past the last mote. */
  function retiredBeyond(fleet: Fleet, livingCount: number): ReadonlyMap<string, RetireState> {
    const settled = returnAt(RETURN.dissolvedMs)
    return new Map(fleet.lanes.slice(livingCount).map((lane) => [lane.id, settled]))
  }

  const LIVING_COUNT = 30
  /** Fewer than the 60-round suites above: each round now draws up to five
   * frames of a 230-lane field rather than one of a 30-lane one, and the
   * interleave's whole point survives on far fewer samples than a single-frame
   * suite needs — the comparison is between columns of the same round, not
   * within one column across many. */
  const ROUNDS = 30

  function measureField(retiredCount: number): void {
    const fleet = fleetSized(LIVING_COUNT + retiredCount)
    const livingFleet = fleetSized(LIVING_COUNT)
    const retire = retiredBeyond(fleet, LIVING_COUNT)
    const vertices = new Batch()

    const frame = (
      now: number,
      of: Fleet,
      cuts: ReadonlyMap<string, RetireState> | undefined,
      hideFinished: boolean,
      into?: Stages,
    ): number => {
      const at = () => performance.now()
      const t0 = at()
      const geometry = layoutScene(of, { ...SIZE, now, retire: cuts, hideFinished })
      const t1 = at()
      const marks = sceneMarks(frameFor(of, geometry, now))
      const t2 = at()
      buildFrame(marks, SIZE, vertices)
      const t3 = at()
      if (into !== undefined) {
        into.layout.push(t1 - t0)
        into.marks.push(t2 - t1)
        into.paint.push(t3 - t2)
      }
      return marks.length
    }

    const living = (now: number, into?: Stages) => frame(now, livingFleet, undefined, false, into)
    const persistent = (now: number, into?: Stages) => frame(now, fleet, retire, false, into)
    const hidden = (now: number, into?: Stages) => frame(now, fleet, retire, true, into)
    const variants = [
      ['living30', living],
      [`persistent${retiredCount}`, persistent],
      [`hidden${retiredCount}`, hidden],
    ] as const

    let clock = NOW
    withPath2D(() => {
      // Warm the JIT on all three, so the first measured round is steady state.
      for (let i = 0; i < 8; i += 1) {
        clock = NOW + i * 16
        for (const [, work] of variants) work(clock)
      }

      const stagesOf = (): Stages => ({ layout: [], marks: [], paint: [] })
      const stages: Record<string, Stages> = {}
      const samples: Record<string, number[]> = {}
      for (const [name] of variants) {
        stages[name] = stagesOf()
        samples[name] = []
      }

      // INTERLEAVED: one frame of each variant per round (#157) — the only
      // comparison that survives a loaded box, since all three see the same
      // instant rather than being timed minutes apart.
      for (let i = 0; i < ROUNDS; i += 1) {
        clock += 16
        for (const [name, work] of variants) {
          const started = performance.now()
          work(clock, stages[name])
          samples[name]?.push(performance.now() - started)
        }
      }

      const worst = (of: readonly number[]): number => Math.max(...of)
      const counts: Record<string, number> = {}
      for (const [name, work] of variants) counts[name] = work(clock)

      for (const [name] of variants) {
        const sample = samples[name] as number[]
        const stage = stages[name] as Stages
        report(
          `retired-field ${name}: ${median(sample).toFixed(3)} ms median · ` +
            `${worst(sample).toFixed(3)} ms worst · ${counts[name]} marks · ` +
            `layout ${median(stage.layout).toFixed(3)} / marks ${median(stage.marks).toFixed(3)} / ` +
            `paint ${median(stage.paint).toFixed(3)} ms ` +
            `(60fps budget ${FRAME_MS.toFixed(2)} ms — ` +
            `${((median(sample) / FRAME_MS) * 100).toFixed(1)}% median, ` +
            `${((worst(sample) / FRAME_MS) * 100).toFixed(1)}% worst)`,
        )
      }

      // THE LAW, and it is a count. HIDE FINISHED really does take the retired
      // field off the canvas (ruling 16), whatever the field's size.
      expect(counts[`hidden${retiredCount}`] as number).toBeLessThan(
        counts[`persistent${retiredCount}`] as number,
      )

      // Every retired lane still draws its strand when it is not hidden, and
      // none when it is — the count moves because a strand is cheap, never
      // because a lane went missing.
      const shownGeometry = layoutScene(fleet, { ...SIZE, now: clock, retire, hideFinished: false })
      const shownMarks = sceneMarks(frameFor(fleet, shownGeometry, clock))
      const shownStrands = shownMarks.filter((mark) => mark.role === 'persist')
      expect(shownStrands).toHaveLength(retiredCount)

      const hiddenGeometry = layoutScene(fleet, { ...SIZE, now: clock, retire, hideFinished: true })
      const hiddenMarks = sceneMarks(frameFor(fleet, hiddenGeometry, clock))
      expect(hiddenMarks.filter((mark) => mark.role === 'persist')).toHaveLength(0)

      // THE HIDE FINISHED QUESTION, pinned as a count rather than argued from
      // the code alone — and the law is now the STRONGER one (#178). It used to
      // be that `layoutScene` built the identical strand whether or not it would
      // ever be shown, and this assertion pinned that as the honest reading of
      // "hidden ≠ gone": the geometry existed, only the paint was skipped. That
      // was the audit's own finding against it — a hidden field still paid the
      // Catmull-Rom fit, the release deformation and the filament sampling for
      // every lane in it, 80.6% of a frame's budget at 200 retired for thirty
      // living lanes' worth of visible result. Hidden now means skipped, all the
      // way up: a lane past the hide-finished gate gets no spine built for it at
      // all, so its geometry is empty rather than merely unpainted. The thread
      // still exists — the lane is never removed from the ring (graft g7) — but
      // it carries no path and no filaments to build them from.
      expect(hiddenGeometry.threads).toHaveLength(shownGeometry.threads.length)
      const probeId = fleet.lanes[LIVING_COUNT]?.id as string
      const shownThread = shownGeometry.threads.find((t) => t.laneId === probeId)
      const hiddenThread = hiddenGeometry.threads.find((t) => t.laneId === probeId)
      expect(shownThread?.path.length).toBeGreaterThan(2)
      expect(hiddenThread?.path).toHaveLength(0)
      expect(hiddenThread?.filaments).toHaveLength(0)
      // …and the strand it would have drawn is gone from the retire wrapper too
      // (`persistence()` copies whatever path it is handed), not just from the
      // top-level thread — the same "no code path can shorten or empty it" law
      // `retire.ts` states for a SHOWN strand, read the other way for a hidden one.
      expect(hiddenThread?.retire?.path).toHaveLength(0)
      expect(shownThread?.retire?.hidden).toBe(false)
      expect(hiddenThread?.retire?.hidden).toBe(true)
    })
  }

  it('reports 30 living + 100 retired against the living ceiling', () => {
    measureField(100)
  }, BENCH_TIMEOUT_MS)

  it('reports 30 living + 200 retired against the living ceiling', () => {
    measureField(200)
  }, BENCH_TIMEOUT_MS)
})

/**
 * THE COUNTING LAW UNDER THE TABLE ABOVE (#32, prd-44 ruling 5).
 *
 * Asked for by `docs/review/2026-08-24-input-latency-audit.md`'s addendum, which
 * read the `persistent200` paint cell at ~7x the committed figure on a second
 * box (17.1–19.5 ms against 2.58 ms) and could not tell, from a wall clock,
 * which of two opposite defects it was looking at: the cache failing to hit
 * under that box's run shape, or a table whose paint column never reproduced.
 * Those have opposite fixes, and a millisecond is silent between them.
 *
 * A count is not silent, and it is valid under every condition the audit found
 * the timings sensitive to — filtered vs. whole-suite, quiet vs. loaded, one box
 * vs. another — because it counts DECISIONS rather than time: over a settled
 * field held still, a hitting cache tessellates each settled ribbon exactly
 * ONCE, on the frame it first sees it, and never again. That is the claim the
 * after-table was reaching for and could not state.
 *
 * Note what this law does NOT say, and the bisect above is why it matters: a
 * cache that hits is not a cache that pays. This one hits on every settled
 * ribbon of every frame after the first and is still 1.84x slower than not
 * having it, because its key is walked and its saving is not. The law answers
 * "does the cache warm"; it deliberately does not answer "is the cache worth
 * it", and nothing here should be read as the second.
 *
 * **Two arms, and the second is what stops the first from going vacuous.** A law
 * that asserted only `misses === 0` would pass exactly as happily if
 * `isSettledRibbon` stopped matching anything at all, or if `sceneMarks` stopped
 * emitting `persist` roles — nothing would reach the cache, nothing would miss,
 * and the law would report success over an empty population. So the negative arm
 * moves one settled ribbon's paint and requires exactly one miss to appear: the
 * counter is proven live on the same field, in the same run.
 *
 * Own lane-id prefix (`law-`), because {@link settledRibbonCache} outlives a
 * single test file and every other suite here builds `lane-N` fleets — a slot
 * this law expects to be cold could otherwise have been filled by a sibling
 * `it()` minutes earlier, and the cold-frame count would be wrong for a reason
 * that has nothing to do with the cache.
 */
describe('the settled-ribbon tessellation cache, counted (#32, prd-44 ruling 5)', () => {
  const LIVING = 30
  const RETIRED = 200
  const FRAMES = 4

  /** {@link fleetSized}, with ids this file's other suites can never collide
   * with — see the header.
   *
   * `ns` is per-ARM, not merely per-file, and the reason is the header's own
   * reason carried one level in: the arms below are siblings sharing one
   * module-global cache, and the second warms every slot the first needs COLD.
   * Sharing one namespace made the first arm's cold-frame count depend on
   * declaration order — green under vitest's default source order, red the
   * moment anything reorders them (measured: under `--sequence.shuffle
   * --sequence.seed=3` the first arm reads 1 miss where it asserts 600). A
   * cache that outlives the file has to be namespaced against everything that
   * can reach it, and that includes the test beside this one. */
  function lawFleet(total: number, ns: string): Fleet {
    const base = fleetSized(total)
    return {
      ...base,
      lanes: base.lanes.map((lane, i) => ({ ...lane, id: `${ns}-${i}`, handles: [`${ns}-${i}`] })),
    }
  }

  function settledBeyond(fleet: Fleet, livingCount: number): ReadonlyMap<string, RetireState> {
    const at = returnAt(RETURN.dissolvedMs)
    return new Map(fleet.lanes.slice(livingCount).map((lane) => [lane.id, at]))
  }

  /** Exactly the population `gl/frame.ts`'s `isSettledRibbon` admits. Narrowing
   * rather than `boolean`, so {@link settledByRole} can read the role back out
   * without re-asserting it. */
  function isSettledRibbon(mark: Mark): mark is Mark & { role: 'persist' | 'persist-mark' } {
    return mark.kind === 'ribbon' && (mark.role === 'persist' || mark.role === 'persist-mark')
  }

  /** The settled population split by role, because one aggregate floor cannot
   * see a role leave. See the assertion in the first arm for what that costs. */
  function settledByRole(marks: readonly Mark[]): { persist: number; persistMark: number } {
    let persist = 0
    let persistMark = 0
    for (const mark of marks) {
      if (!isSettledRibbon(mark)) continue
      if (mark.role === 'persist') persist += 1
      else persistMark += 1
    }
    return { persist, persistMark }
  }

  it('tessellates each settled ribbon once and never again while the field is still', () => {
    const fleet = lawFleet(LIVING + RETIRED, 'law-still')
    const retire = settledBeyond(fleet, LIVING)
    const vertices = new Batch()

    const marksFor = (now: number): readonly Mark[] => {
      const geometry = layoutScene(fleet, { ...SIZE, now, retire, hideFinished: false })
      return sceneMarks(frameFor(fleet, geometry, now))
    }

    const cold = marksFor(NOW)
    const settledCount = cold.filter(isSettledRibbon).length
    // The population must be non-empty for anything below to mean anything, and
    // it must carry BOTH settled roles. One aggregate floor cannot say that:
    // each retired lane draws one `persist` strand and TWO `persist-mark` marks
    // (measured 200 + 400 = 600 over 200 lanes), so `settledCount > RETIRED`
    // still reads true at 400 when the `persist` role stops arriving at all —
    // the law would then count a two-thirds field and report success, which is
    // the exact vacuity the second arm exists to prevent, arriving by the other
    // door. Each floor is derived from RETIRED, never from the 600 observed
    // here; what they catch is a role VANISHING, not a role thinning.
    const byRole = settledByRole(cold)
    expect(byRole.persist).toBeGreaterThanOrEqual(RETIRED)
    expect(byRole.persistMark).toBeGreaterThanOrEqual(RETIRED)
    expect(settledCount).toBeGreaterThan(RETIRED)

    const before = settledRibbonCacheCounts()
    buildFrame(cold, SIZE, vertices)
    const afterCold = settledRibbonCacheCounts()
    // Frame one: every settled ribbon is a slot this session has never filled.
    expect(afterCold.misses - before.misses).toBe(settledCount)
    expect(afterCold.hits - before.hits).toBe(0)

    for (let i = 1; i < FRAMES; i += 1) {
      // A FRESH mark array from a FRESH `now`, exactly as the frame loop hands
      // one over — the paint is rebuilt every frame by construction, and a
      // settled lane's geometry is what must not be.
      buildFrame(marksFor(NOW + i * 16), SIZE, vertices)
    }
    const warm = settledRibbonCacheCounts()
    expect(warm.misses - afterCold.misses).toBe(0)
    expect(warm.hits - afterCold.hits).toBe(settledCount * (FRAMES - 1))
  }, BENCH_TIMEOUT_MS)

  it('one settled ribbon whose paint moved is one miss — the counter is live, not asleep', () => {
    const fleet = lawFleet(LIVING + RETIRED, 'law-moved')
    const retire = settledBeyond(fleet, LIVING)
    const vertices = new Batch()

    const marksFor = (now: number): readonly Mark[] => {
      const geometry = layoutScene(fleet, { ...SIZE, now, retire, hideFinished: false })
      return sceneMarks(frameFor(fleet, geometry, now))
    }

    // Warm every slot first, so the only cold thing in the frame below is the
    // one mark this arm deliberately changes.
    buildFrame(marksFor(NOW), SIZE, vertices)

    const next = marksFor(NOW + 16)
    const settledCount = next.filter(isSettledRibbon).length
    const at = next.findIndex(isSettledRibbon)
    expect(at).toBeGreaterThanOrEqual(0)
    const moved = next.map((mark, i) =>
      i === at ? ({ ...mark, paint: ink(ICE_050, 0.1234) } as Mark) : mark,
    )

    const before = settledRibbonCacheCounts()
    buildFrame(moved, SIZE, vertices)
    const after = settledRibbonCacheCounts()
    expect(after.misses - before.misses).toBe(1)
    expect(after.hits - before.hits).toBe(settledCount - 1)
  }, BENCH_TIMEOUT_MS)
})

/**
 * THE MODEL FLOOR (#579, prd-33 wave 2) — `layoutScene` + `sceneMarks` alone,
 * at the sizes prd-33 wants and with nothing drawing a pixel.
 *
 * `research/2026-08-15-renderer-spike.md` measured this in Chromium across both
 * renderer arms and found it identical in both, which is the whole point: **no
 * painter swap touches it.** At 60 lanes × 3 colonies the model spent 14.6 ms of
 * a 16.67 ms frame deciding what to draw, so the WebGL2 painter that has since
 * landed (ADR-0021) inherits 2.1 ms to draw 180 threads in. The spike's own
 * matrix, which the cells below reproduce in Node so the number can be watched
 * from the suite rather than from a spike nobody re-runs:
 *
 * | lanes × colonies | threads | model ms (spike, Chromium) | share of 60 fps |
 * | ---------------- | ------- | -------------------------- | --------------- |
 * | 30 × 1           |   30    | 2.9 – 3.6                  | 17–22%          |
 * | 30 × 3           |   90    | 9.4 – 10.5                 | 56–63%          |
 * | 60 × 3           |  180    | 14.6 – 16.5                | **88–99%**      |
 *
 * **A colony is a whole fleet, mass and all** (prd-33 ruling 7), so three
 * colonies is three `layoutScene` + `sceneMarks` pairs per frame and three of
 * everything the mass costs — three scalar fields sampled, three depth stacks
 * walked. `lanes` is per colony: "60 × 3" is 180 threads.
 *
 * ---
 *
 * **WHAT #579 CHANGED, and the number it is measured on.** `contour.ts` now
 * bakes the mass's field in unit space and *places* it by the frame's own
 * similarity transform ({@link contourLayers}'s cache). The whole lattice —
 * pitch, origin, extent, every falloff and every level — is already a multiple
 * of `geometry.rootRadius` (`marks/root.ts`'s `CELL`, `MELT`, `BODY`,
 * `depthsFor`), so a frame that only *breathed* (±1.6%) or only grew the mass
 * asks for a shape that has already been walked, at a different scale.
 *
 * Two regimes, and both are reported below because they are genuinely
 * different and reporting only the first would be a press release:
 *
 * - **a calm mass** — no cord arriving, or one frozen mid-withdraw. The unit
 *   field is unchanged frame to frame, so the sampling and the eighteen walks
 *   happen once and every later frame pays only the placement.
 * - **a cord actually arriving** — `arrivalSwell` moves every frame, so the
 *   unit field is a new shape every frame and the walk runs in full. This is
 *   the pessimal cell and it is measured, not argued: the bake must cost
 *   nothing when it cannot help.
 *
 * **What it measured, on the dev box** (13th Gen i9-13900H, WSL2, Node 22,
 * `perf.test.ts` alone so the numbers are not also carrying 144 sibling files) —
 * median of 60 interleaved frames, model stage only, **before and after taken
 * as two pairs of alternating runs** in one session (B A B A), because #157's
 * own lesson is that a before and an after taken minutes apart measure the load
 * average. Both rounds agreed on every ordering; the medians of the two:
 *
 * | cell   | threads | before   | after    | Δ     | share of 60 fps (after) |
 * | ------ | ------- | -------- | -------- | ----- | ----------------------- |
 * | 30 × 1 |   30    |  5.49 ms |  3.87 ms | 0.70× | 23%                     |
 * | 30 × 3 |   90    | 15.84 ms | 10.59 ms | 0.67× | 64%                     |
 * | 60 × 3 |  180    | 25.77 ms | 20.24 ms | 0.79× | 121%                    |
 *
 * …and the builder it came out of, from the `by builder` suite above, same runs:
 *
 * | builder | before  | after   |
 * | ------- | ------- | ------- |
 * | root    | 1.47 ms | 0.25 ms |
 * | thread  | 2.06 ms | 2.04 ms |
 *
 * **The absolutes are this box and the ratios are not.** These are Node medians
 * and the spike's are Chromium's, and this cell drives `growth` per lane per
 * frame where the spike drove its own — so 25.77 ms here is *not* the spike's
 * 14.6 ms measured again, and the honest transfer is the ratio. prd-33 ruling 13
 * states the ceiling that follows: **90 threads at 60 fps, 180 at 30.**
 *
 * Reported, never asserted, for the reason the file header gives. The laws
 * beside it are **counts**: the same cells must produce the same number of
 * marks before and after, since an optimisation that dropped a mark would be a
 * different picture rather than a faster one — and the three colonies must be
 * three *different* masses, or the multi-colony rows would be one mass's saving
 * counted three times. That the picture itself is unchanged is evidenced
 * elsewhere and by capture: `parity/contour.test.ts` (every vertex, against the
 * pre-bake implementation's own output) and `parity/README.md` (the same seeded
 * frame rendered before and after — the canvas arm byte-identical, the WebGL arm
 * one pixel in 682,000 differing by 1/255).
 */
describe('the model floor (#579, prd-33 w2)', () => {
  /** The spike's own matrix. `lanes` is per colony. */
  const CELLS: readonly { lanes: number; colonies: number }[] = [
    { lanes: 30, colonies: 1 },
    { lanes: 30, colonies: 3 },
    { lanes: 60, colonies: 3 },
  ]

  /** Enough that the median is a median; few enough that three cells stay quick. */
  const ROUNDS = 60

  /**
   * One colony's fleet, and **no two colonies are the same fleet**.
   *
   * Each gets its own lane ids *and* its own output volume, which matters twice
   * over and would have quietly forged the measurement if it were skipped:
   * `layoutScene`'s retired-spine cache is keyed on the lane id, and #579's own
   * contour bake is keyed on the mass's shape — three identical colonies would
   * have shared one baked surface between them and reported a saving three
   * times the one a real second colony gets. The token scale moves
   * `rootFullness`, which moves the mass's radius *and* the depth stack
   * (`depthsFor`), so the three masses are three different shapes.
   */
  function colonyFleet(lanes: number, colony: number): Fleet {
    const base = fleetSized(lanes)
    if (colony === 0) return base
    const scale = 1 + colony * 0.6
    return {
      ...base,
      lanes: base.lanes.map((lane) => ({
        ...lane,
        id: `${lane.id}@${colony}`,
        handles: [`${lane.id}@${colony}`],
        outputTokens: Math.round(lane.outputTokens * scale) + colony * 37,
      })),
    }
  }

  /**
   * Two cords mid-withdraw in this colony — the structural cap's own
   * concurrency, which is the most dissolution the scene can ever be running,
   * and the same fixture every suite above uses. `at` is how far into the
   * return they are: **frozen** for the steady-state cells (the cut holds where
   * it is while the clock advances, so the mass's field is calm), and advanced
   * per frame for the arriving cell below.
   */
  function cutsFor(fleet: Fleet, at: number): ReadonlyMap<string, RetireState> {
    const state = returnAt(at)
    const ids = [fleet.lanes[3]?.id, fleet.lanes[11]?.id].filter((id) => id !== undefined)
    return new Map(ids.map((id) => [id as string, state]))
  }

  /**
   * Continuous growth on every living thread (prd-33 ruling 9) — the fact that
   * makes the model stage a per-frame cost at all. Advanced every frame and per
   * lane, so a spine is genuinely rebuilt rather than answered from a cache
   * that a still fleet would have made free.
   */
  function growthFor(fleet: Fleet, tick: number): ReadonlyMap<string, number> {
    return new Map(
      fleet.lanes.map((lane, i) => [lane.id, ((i * 7 + tick) % 97) / 97] as const),
    )
  }

  interface Model {
    /** `layoutScene` + `sceneMarks`, summed over the colonies. */
    ms: number
    layoutMs: number
    marksMs: number
    marks: number
  }

  /** One frame of the whole model stage, across every colony in the cell. */
  function modelFrame(
    fleets: readonly Fleet[],
    now: number,
    tick: number,
    cutAt: number | null,
  ): Model {
    const at = () => performance.now()
    let layoutMs = 0
    let marksMs = 0
    let marks = 0
    for (const fleet of fleets) {
      const retire = cutAt === null ? undefined : cutsFor(fleet, cutAt)
      const growth = growthFor(fleet, tick)
      const t0 = at()
      const geometry = layoutScene(fleet, { ...SIZE, now, retire, growth })
      const t1 = at()
      const built = sceneMarks(frameFor(fleet, geometry, now))
      const t2 = at()
      layoutMs += t1 - t0
      marksMs += t2 - t1
      marks += built.length
    }
    return { ms: layoutMs + marksMs, layoutMs, marksMs, marks }
  }

  it('reports the model stage at every cell prd-33 asks for', () => {
    withPath2D(() => {
      const cells = CELLS.map((cell) => ({
        ...cell,
        fleets: Array.from({ length: cell.colonies }, (_unused, c) =>
          colonyFleet(cell.lanes, c),
        ),
        samples: [] as number[],
        layout: [] as number[],
        marks: [] as number[],
        counts: 0,
      }))

      // Warm the JIT on every cell before any of them is measured.
      for (let i = 0; i < 8; i += 1) {
        for (const cell of cells) modelFrame(cell.fleets, NOW + i * 16, i, RETURN.tensionMs + 300)
      }

      // INTERLEAVED (#157): one frame of every cell per round, so all three see
      // the same machine at the same instant rather than being timed apart.
      for (let round = 0; round < ROUNDS; round += 1) {
        const now = NOW + (8 + round) * 16
        for (const cell of cells) {
          const model = modelFrame(cell.fleets, now, 8 + round, RETURN.tensionMs + 300)
          cell.samples.push(model.ms)
          cell.layout.push(model.layoutMs)
          cell.marks.push(model.marksMs)
          cell.counts = model.marks
        }
      }

      for (const cell of cells) {
        const ms = median(cell.samples)
        report(
          `model floor ${cell.lanes}x${cell.colonies} (${cell.lanes * cell.colonies} threads): ` +
            `${ms.toFixed(3)} ms median · ${Math.max(...cell.samples).toFixed(3)} ms worst · ` +
            `layout ${median(cell.layout).toFixed(3)} / marks ${median(cell.marks).toFixed(3)} ms · ` +
            `${cell.counts} marks ` +
            `(60fps budget ${FRAME_MS.toFixed(2)} ms — ${((ms / FRAME_MS) * 100).toFixed(1)}%)`,
        )
      }

      // THE LAW, and it is a count rather than a clock: the model stage's job is
      // to produce the display list, and a cell that got faster by producing
      // fewer marks would be a different picture. Three colonies of thirty draw
      // about three times what one does — *about*, because a colony's lanes
      // carry their own ids and a lane's id is what its wander, its knot and
      // its filament count are seeded from, so the three colonies are three
      // different fleets rather than one drawn thrice. Sixty lanes draw more
      // than thirty.
      const [one, three, big] = cells as [
        (typeof cells)[number],
        (typeof cells)[number],
        (typeof cells)[number],
      ]
      expect(three.counts).toBeGreaterThan(one.counts * 2.9)
      expect(three.counts).toBeLessThan(one.counts * 3.1)
      expect(big.counts).toBeGreaterThan(three.counts)

      // …AND THE THREE COLONIES ARE THREE MASSES, which is the assumption the
      // multi-colony rows above are worth nothing without. `contour.ts`'s bake
      // is keyed on the *shape* rather than on the caller, so three colonies
      // that happened to be the same fleet would share one baked surface and
      // report a saving three times the one a real second colony gets. Pinned
      // on the drawn rings rather than on the cache, so it stays a fact about
      // the picture: three colonies, three different surfaces.
      const surfaces = three.fleets.map((fleet) => {
        const geometry = layoutScene(fleet, {
          ...SIZE,
          now: NOW,
          retire: cutsFor(fleet, RETURN.tensionMs + 300),
          growth: growthFor(fleet, 0),
        })
        const mass = sceneMarks(frameFor(fleet, geometry, NOW)).find(
          (mark) => mark.role === 'root-mass',
        )
        return JSON.stringify(mass?.kind === 'contour' ? mass.rings : null)
      })
      expect(new Set(surfaces).size).toBe(3)
    })
  }, BENCH_TIMEOUT_MS)

  /**
   * THE PESSIMAL CELL, reported beside the steady-state one so the bake cannot
   * be read as a win it does not have. A cord genuinely arriving moves
   * `arrivalSwell` every frame, so the mass's field is a **new shape** every
   * frame and `contourLayers` walks it in full — exactly as it did before #579.
   * The two lines together are the honest claim: calm frames get the saving,
   * arriving frames pay what they always paid.
   */
  it('reports the same cell with a cord actually arriving, not frozen', () => {
    withPath2D(() => {
      const fleets = Array.from({ length: 3 }, (_unused, c) => colonyFleet(60, c))
      const frozen: number[] = []
      const arriving: number[] = []

      for (let i = 0; i < 8; i += 1) {
        modelFrame(fleets, NOW + i * 16, i, RETURN.tensionMs + 300)
        modelFrame(fleets, NOW + i * 16, i, RETURN.tensionMs + 300 + i * 16)
      }

      for (let round = 0; round < ROUNDS; round += 1) {
        const now = NOW + (8 + round) * 16
        // Interleaved, same instant, same fleets — only the cut's own clock differs.
        frozen.push(modelFrame(fleets, now, 8 + round, RETURN.tensionMs + 300).ms)
        arriving.push(
          modelFrame(fleets, now, 8 + round, RETURN.tensionMs + 300 + (round % 24) * 16).ms,
        )
      }

      report(
        `model floor 60x3, cut frozen mid-withdraw: ${median(frozen).toFixed(3)} ms median · ` +
          `${Math.max(...frozen).toFixed(3)} ms worst · ` +
          `cut arriving (field moves every frame): ${median(arriving).toFixed(3)} ms median · ` +
          `${Math.max(...arriving).toFixed(3)} ms worst ` +
          `(60fps budget ${FRAME_MS.toFixed(2)} ms)`,
      )

      expect(median(frozen)).toBeGreaterThan(0)
      expect(median(arriving)).toBeGreaterThan(0)
    })
  }, BENCH_TIMEOUT_MS)

  /**
   * `globalThis.gc` if the run already exposed it, otherwise one obtained
   * through v8's own flag seam — vitest runs each file in a worker with its own
   * isolate, so this works with no `NODE_OPTIONS` and no change to how anyone
   * runs the suite. `null` when neither route yields a function, which is a
   * REPORTED condition rather than a failure: CI does not expose gc, and a
   * silently skipped measurement would read as a verdict it never earned.
   *
   * The flag is deliberately not restored — the captured function must stay
   * valid for the rest of this file, and this is a test worker that exits.
   */
  function forcedCollector(): (() => void) | null {
    const direct = (globalThis as { gc?: () => void }).gc
    if (typeof direct === 'function') return direct
    try {
      v8.setFlagsFromString('--expose_gc')
      const exposed = vm.runInNewContext('gc') as unknown
      return typeof exposed === 'function' ? (exposed as () => void) : null
    } catch {
      return null
    }
  }

  /**
   * IS THE VARIANCE GC? (prd-47 ruling 4.)
   *
   * The method, and it is the whole point of #160: run the same cell twice,
   * interleaved, and force a collection **out of band** — immediately before a
   * sample, outside the timed region — for one of the two series. If the tail
   * is GC pauses landing inside timed frames, forcing collection between frames
   * moves them out and `worst/median` collapses toward 1. If it does not
   * collapse, the attribution was wrong and prd-47 w4 is never built.
   *
   * One cell (60x3, the heaviest, where the tail is widest) rather than all
   * three: this file carries `// @gate-timing`, so `scripts/gate.sh` runs it
   * serially and alone, and three cells would triple that pass for no extra
   * signal.
   *
   * Reported, never asserted — a wall clock under `--maxWorkers` measures the
   * box. The verdict is prose, in `research/2026-08-28-variance-attribution.md`
   * and on #160. The laws below are counts.
   */
  it('reports the model floor under forced out-of-band collection (prd-47 ruling 4)', () => {
    withPath2D(() => {
      const collect = forcedCollector()
      const fleets = Array.from({ length: 3 }, (_unused, c) => colonyFleet(60, c))
      const plain: number[] = []
      const forced: number[] = []
      let plainMarks = 0
      let forcedMarks = 0

      for (let i = 0; i < 8; i += 1) modelFrame(fleets, NOW + i * 16, i, RETURN.tensionMs + 300)

      if (collect === null) {
        report(
          'model floor 60x3 under forced collection: NOT MEASURED — no gc function ' +
            'available in this worker (neither globalThis.gc nor v8 --expose_gc). ' +
            'Ruling 4 is unanswered by this run; the research note carries the ' +
            'measurement from a run where it was available.',
        )
        return
      }

      // INTERLEAVED, one of each per round, same instant and same fleets — the
      // discipline #157 imposed on this file. Timed apart, the two series would
      // differ by whatever else the box was doing between them, which is
      // precisely the quantity under test.
      for (let round = 0; round < ROUNDS; round += 1) {
        const now = NOW + (8 + round) * 16
        const bare = modelFrame(fleets, now, 8 + round, RETURN.tensionMs + 300)
        plain.push(bare.ms)
        plainMarks = bare.marks

        collect()
        const after = modelFrame(fleets, now, 8 + round, RETURN.tensionMs + 300)
        forced.push(after.ms)
        forcedMarks = after.marks
      }

      const tail = (of: readonly number[]): number => Math.max(...of) / median(of)
      report(
        `model floor 60x3 plain:  ${median(plain).toFixed(3)} ms median · ` +
          `${Math.max(...plain).toFixed(3)} ms worst · ${tail(plain).toFixed(2)}x tail`,
      )
      report(
        `model floor 60x3 forced: ${median(forced).toFixed(3)} ms median · ` +
          `${Math.max(...forced).toFixed(3)} ms worst · ${tail(forced).toFixed(2)}x tail ` +
          '(gc forced out of band, immediately before each sample)',
      )

      // THE LAW, and it is a count rather than a clock: the two series must have
      // measured the SAME PICTURE, or a collapsed tail is an artefact of
      // measuring less work rather than evidence about GC.
      expect(forcedMarks).toBe(plainMarks)
      // And both series must be complete. `Math.max(...[])` is -Infinity and
      // `median([])` is 0, so a loop that silently produced no forced samples
      // would report a 0x tail — a total collapse — and forge the verdict.
      expect(plain).toHaveLength(ROUNDS)
      expect(forced).toHaveLength(ROUNDS)
    })
  }, BENCH_TIMEOUT_MS)
})
