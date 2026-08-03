import { pointAt, type Point, type RetireGeometry, type ThreadGeometry } from '../geometry.js'
import { EVENT, allowance } from '../motion.js'
import {
  BROKEN,
  ICE_050,
  ICE_100,
  ICE_200,
  ICE_500,
  ICE_700,
  NECROTIC,
  NEEDS_YOU,
  TISSUE_500,
  activityInk,
  clamp01,
  fade,
  hotter,
  incandescent,
  ink,
  mix,
  type Ink,
} from '../palette.js'
import { SCAR, toward } from '../retire.js'
import type { WidthStop } from '../ribbon.js'
import { SHIMMER_PERIOD_MS, variationFor, variationSeed } from '../variation.js'
import { budget, motionMode, type SceneFrame } from './frame.js'
import { THORN_OUT } from './glyphs.js'
import { ribbonMark, type Mark } from './types.js'

/**
 * THE THREADS — a lane as a hypha, root-mass rim to node.
 *
 * Since prd7 ruling 3 a thread is a **filled ribbon** rather than a stroked
 * centre-line: `ribbon.ts` turns its spine and its width profile into closed
 * polygons, and the width becomes a channel this file can spend. Two of the five
 * pathologies collect on that here — FROZEN's cut is the ribbon closing to
 * nothing twice over, and EXPENSIVE's direction is a needle taper rather than
 * three chevrons at the tip — and both spend zero new objects doing it.
 *
 * The resting picture is quiet but no longer colourless. Under prd4's law 9a a
 * living thread wears its lane's own family — green while the lane is working,
 * a muted amber while it is stopped, dim green once it has landed, ice when
 * there is nothing to say — so a layman can read the scene as a status board
 * before learning a single glyph. What the calm world still may not do is reach
 * the band above `CALM_CEILING`: that belongs to the alarms (law 9b).
 *
 * Three constraints pull against each other in a thread's brightness, and
 * `activityInk` is where they meet. The floor: ruling 22 says render everything,
 * and prd4 adds that a rendered thread must be genuinely legible — `CALM_FLOOR`.
 * The ceiling: light in flight has to out-read the thread it travels on, and a
 * summons has to out-read all of it.
 */

/** Under this much heat a thread is at its resting brightness. */
const HEAT_FULL = 2.5

/**
 * FROZEN's severance, as two positions along the thread (prd7 ruling 3).
 *
 * Two, and the count is still the reading: one closure is a thread that got
 * thin, two is unmistakably a thing that was cut. What changed is only how they
 * are drawn — see {@link severedMarks}.
 */
const SEVERED_AT = [0.68, 0.76] as const
/**
 * How much of the thread each closure consumes: a short neck down to nothing,
 * and a gap you can see across at the bottom of it. Small — the reading is "this
 * line stops", and a gap wide enough to be a third of the thread would read as
 * three threads.
 */
const SEVERED_SPAN = 0.06
const SEVERED_FLAT = 0.45

/**
 * EXPENSIVE's taper. The last fifth of a burning lane's thread is drawn down to
 * a needle: direction and urgency told as a width gradient that is legible along
 * the whole thread, rather than as three 6px arrowheads legible at one point.
 */
const HEAT_TAPER = 0.2

export function threadMarks(frame: SceneFrame, thread: ThreadGeometry): Mark[] {
  const marks: Mark[] = []
  const { laneId } = thread
  const frozen = thread.pathology === 'frozen'
  const resting = threadInk(frame, thread)

  // A retiring lane is not part of the living network, and the display list says
  // so: no `thread`, no bloom once it has settled, no heat, no standing flow, no
  // second growth. See `scarMarks`. It also does not shimmer — the iridescence
  // below is the lane being alive, and this one is not.
  if (thread.retire !== null) return scarMarks(frame, thread, thread.retire, resting)

  const base = frozen ? resting : shimmered(frame, thread, resting)

  // The form this lane's thread takes, in three parts, and all three are shared
  // by the bloom so the two read as one object: the cuts that close it, the
  // needle a burning lane tapers to, and the lane's own ±10% width habit.
  const shape = {
    ...(frozen ? { dashed: true as const, stops: severedStops() } : {}),
    ...(thread.pathology === 'expensive' ? { taperTip: HEAT_TAPER } : {}),
    modulate: variationFor(variationSeed(thread.lane)).widthJitter,
  }

  // Bloom first, wide and faint, then the core. Two ribbons rather than a shadow
  // blur: shadows on forty paths a frame is where canvas 2D falls over.
  marks.push(
    ribbonMark({
      ...shape,
      role: 'thread-bloom',
      laneId,
      alarm: false,
      path: thread.path,
      widthRoot: thread.widthRoot * 3.6,
      widthTip: thread.widthTip * 3.6,
      // Half the thread's resolution: a wash at 10% alpha has no edge anybody
      // can find a facet in, and it is the second-widest ribbon on screen.
      samples: 24,
      // THE THREAD UNDERGLOW (prd10 ruling 5) — the bloom, mixed toward the
      // accent. It is the ruling's second named tissue draw, and it costs nothing:
      // the widest, faintest ribbon on the lane was already being painted, so the
      // undertone is a change of colour rather than a new object. A third of the
      // way to `TISSUE_500` keeps the lane's own family unmistakable in the mark
      // above it while the light *around* it reads as bioluminal — which is the
      // whole difference between a lit line and a living one.
      paint: budget(frame, laneId, false, {
        rgb: mix(base.rgb, TISSUE_500, UNDERGLOW),
        alpha: base.alpha * 0.1,
      }),
    }),
    ribbonMark({
      ...shape,
      role: 'thread',
      laneId,
      alarm: false,
      path: thread.path,
      widthRoot: thread.widthRoot,
      widthTip: thread.widthTip,
      paint: budget(frame, laneId, false, base),
    }),
  )

  if (thread.pathology === 'expensive') marks.push(...heatMarks(frame, thread))
  if (frozen) marks.push(...severedMarks(frame, thread))
  if (frame.reducedMotion) marks.push(...standingFlow(frame, thread))

  marks.push(...filamentMarks(frame, thread, base))
  marks.push(...budMarks(frame, thread, base))

  return marks
}

/** How far a thread's bloom is mixed toward the accent (prd10 ruling 5). */
const UNDERGLOW = 0.34

/**
 * PER-THREAD IRIDESCENCE (prd10 ruling 6) — ±3%, in luminance and nothing else.
 *
 * Ambient class, and the two things that keep it inside the class are both here:
 * the amplitude is `variation.ts`'s own cap (a bounded channel that carries
 * nothing, seeded off the lane so twenty threads shimmer out of phase), and the
 * channel is **alpha**, never rgb — a hue that wobbled would be a lane whose
 * *state* wobbled, which is law 9a's whole subject.
 *
 * No motion gate, and that is not an oversight. Opacity is exactly what WCAG 2.3.3
 * excludes from "motion animation", so reduced motion keeps it; and pause holds the
 * scene's clock still, so `frame.now` stops advancing and the shimmer stops with
 * everything else that is a function of it. One mechanism, no special cases — the
 * property `SceneView`'s pause comment promises for animations added later by
 * somebody who never read it.
 */
function shimmered(frame: SceneFrame, thread: ThreadGeometry, resting: Ink): Ink {
  const habit = variationFor(variationSeed(thread.lane))
  return {
    rgb: resting.rgb,
    alpha: clamp01(resting.alpha * habit.shimmer(frame.now / SHIMMER_PERIOD_MS)),
  }
}

/**
 * SUBAGENT BUDS (prd10 ruling 9) — a side-branchlet off **this lane's** thread.
 *
 * Two marks at most, and the second only while something is actually happening:
 *
 * - the **bud** itself, a fine ribbon of the lane's own substance tapering to
 *   nothing, at the lane's own colour. It is anatomy of its parent, not a lane
 *   (prd2's "sub-rows are never a lane of their own"), and it reads that way
 *   because it is drawn in the parent's ink at the parent's habit;
 * - the **flare**, an event-class response at the tip to the freshest thing the
 *   telemetry reports. `sinceMs` is the age of the newest thread-marked reading,
 *   so this is a bud pulsing when its subagent works — fast in and slow out over
 *   the event class's own flare envelope, and nothing at all once the reading is
 *   older than that envelope.
 *
 * The absorption is not here: a bud coming back is a *dissolution*, and it is drawn
 * where every other return is (`marks/dissolve.ts`).
 *
 * Liveness is **read**, never re-derived — `geometry.ts`'s `layoutBud` is the only
 * thing that touches the vital, and this file only draws what it was handed. A lane
 * with no telemetry has `bud === null` and loses nothing else, which is the ruling's
 * own gap-honesty clause.
 */
function budMarks(frame: SceneFrame, thread: ThreadGeometry, base: Ink): Mark[] {
  const bud = thread.bud
  if (bud === null) return []

  const { laneId } = thread
  const marks: Mark[] = [
    ribbonMark({
      role: 'bud',
      laneId,
      alarm: false,
      path: bud.path,
      // Off the parent's own tip width, so a bud on a big lane is a little thicker
      // than one on a small lane — the same absolute scale everything else on this
      // thread is drawn on, and no new channel.
      widthRoot: bud.width + thread.widthTip * 0.5,
      widthTip: 0.2,
      taperTip: 0.5,
      samples: 10,
      caps: false,
      paint: budget(frame, laneId, false, {
        rgb: base.rgb,
        // Dimming as it is absorbed: the branchlet goes quiet before it goes.
        alpha: base.alpha * 0.7 * bud.vitality,
      }),
    }),
  ]

  // The flare. Fast in, slow out (`EVENT.flareInMs`/`flareOutMs`) off the age of
  // the newest reading — so a bud whose subagent just spoke is briefly bright and
  // one that has been quiet for a minute is not, without anything here holding
  // state or starting a clock.
  const struck = flareAt(bud.sinceMs)
  if (struck > 0.02 && allowance('event', motionMode(frame)).opacity) {
    marks.push({
      kind: 'glow',
      role: 'bud-flare',
      laneId,
      alarm: false,
      at: bud.tip,
      radius: 4 + 3 * struck,
      ink: budget(frame, laneId, false, ink(hotter(base.rgb, 0.55), 0.5 * struck * bud.vitality)),
    })
  }

  return marks
}

/**
 * The event class's flare envelope, read off an age rather than a start time:
 * fast in over {@link EVENT.flareInMs}, slow out over {@link EVENT.flareOutMs}, and
 * zero past both. "A flare is struck, not faded up" — `motion.ts` owns the numbers
 * and this is the only place they are shaped.
 */
export function flareAt(sinceMs: number): number {
  const age = Math.max(0, sinceMs)
  if (age < EVENT.flareInMs) return age / EVENT.flareInMs
  const out = (age - EVENT.flareInMs) / EVENT.flareOutMs
  return out >= 1 ? 0 : 1 - out
}

/** The two closures, as width stops the thread and its bloom both carry. */
function severedStops(): WidthStop[] {
  return SEVERED_AT.map((at) => ({ at, span: SEVERED_SPAN, scale: 0, flat: SEVERED_FLAT }))
}

/**
 * THE CORD-CUT, as marks (prd5 ruling 3) — what a lane looks like once it has
 * stopped being part of the network.
 *
 * The display list is where the claim is made: a retiring lane has **no**
 * `thread` mark, no `heat`, no `thread-flow` and no `filament`. It is not a
 * dimmed thread, it is a different kind of object, and `marks.test.ts` can say so
 * by counting rather than by comparing brightnesses.
 *
 * Three marks at most, and each drops out at the stage where it stops being true:
 *
 * - the **bloom** goes out over the retract. Light leaves before colour does —
 *   which is the right order, because it is the light that was the lane working.
 *   A settled scar has none, and that flatness is half of why it reads as past.
 * - the **remnant** is the thread's own last fifth, tapering as it always did,
 *   desaturating into `SCAR.thread` over the settle.
 * - the **freed end** gathers. A cord that let go springs back and bunches at
 *   the end that was holding, which is the fact — rather than an end that was
 *   chopped. It used to be a stamped thorn curl and is now the remnant's own
 *   substance, swollen where the tension was and needled away up its own thread
 *   (#117): the same reading, in the material, with nothing repeated.
 *
 * What it deliberately does not have is a `glow`. A glow is light, and there is
 * no light here any more — no pulse, no heat, never again.
 *
 * The fourth mark is the one prd6 ruling 2 added, and it is the reason a cut is no
 * longer a dead end: the **homeward flow**, the lane's own substance running down
 * the severing thread into the mass while the remnant springs the other way. It is
 * a ribbon of the thread, at the thread's own colour and a little narrower — the
 * matter *inside* the hypha, not a packet of light travelling on it — and it is
 * absent from a scar that was never watched leaving, which is what keeps a replay
 * from re-landing work it is only reading about.
 */
function scarMarks(
  frame: SceneFrame,
  thread: ThreadGeometry,
  cut: RetireGeometry,
  living: Ink,
): Mark[] {
  if (cut.hidden) return []
  // THE CORD IS GONE (prd10 ruling 2): "no stubs persist; the scene may forget the
  // thread's geometry because the LEDGER remembers the thread". Once the last mote
  // has landed there is nothing left of this cord to draw, so nothing is drawn —
  // which is what makes a scrubbed-to-the-end replay a heart full of rings rather
  // than a wreath of amputated stubs (ruling 1's judgement). What survives at the
  // rim is prd5 law 1's own list, and only that list: the lane's lens, its name and
  // its figure, so completion is still never invisible and the operator can still
  // read *which* lane finished (`scarNodeMarks`).
  if (cut.dissolve >= 1) return []

  const { laneId } = thread
  const marks: Mark[] = []
  const leaving = composting(cut.dissolve)
  const cold = fade(toward(living, SCAR.thread, cut.scar), leaving)

  const lit = 1 - cut.retract
  if (lit > 0.01) {
    marks.push(
      ribbonMark({
        role: 'scar-bloom',
        laneId,
        alarm: false,
        path: cut.path,
        widthRoot: cut.widthRoot * 3.6,
        widthTip: cut.widthTip * 3.6,
        paint: budget(frame, laneId, false, { rgb: cold.rgb, alpha: cold.alpha * 0.1 * lit }),
      }),
    )
  }

  marks.push(
    ribbonMark({
      role: 'scar',
      laneId,
      alarm: false,
      path: cut.path,
      widthRoot: cut.widthRoot,
      widthTip: cut.widthTip,
      paint: budget(frame, laneId, false, cold),
    }),
  )

  if (cut.homeward !== null && leaving > 0) {
    marks.push(
      ribbonMark({
        role: 'homeward',
        laneId,
        alarm: false,
        path: cut.homeward,
        // Narrower than the thread it is inside, and thicker at the leading end:
        // matter being drawn along, rather than a second thread beside the first.
        widthRoot: thread.widthRoot * 0.8,
        widthTip: thread.widthTip * 0.9,
        // …and it bulges where the substance actually is, so what travels down a
        // cut cord is one parcel rather than a uniform stripe (ruling 3's swell,
        // spent on the mark that was already the honest reading of a merge).
        stops: [{ at: 0.3, span: 0.45, scale: 1.5 }],
        // The lane's own colour, warmed — it is the work that is moving, and the
        // budget still holds it under a summons the way every calm mark is held.
        paint: budget(
          frame,
          laneId,
          false,
          ink(hotter(living.rgb, 0.5), Math.min(1, living.alpha * 1.25)),
        ),
      }),
    )
  }

  // Nothing has parted yet during the tension release, so there is no freed end
  // to gather: the thread is still tied into the mass, just slack.
  if (cut.from > 0 && cut.path.length > 2) {
    const gathered = Math.min(0.36, GATHER_PX / Math.max(1, arcLengthOf(cut.path)))
    marks.push(
      ribbonMark({
        role: 'scar-mark',
        laneId,
        alarm: false,
        // The first stretch of the remnant, from the freed end inward — so it
        // lies exactly on the mark it belongs to and cannot drift off it.
        path: stretch(cut.path, 0, gathered, 8),
        // Swollen at the end that let go and gone by the far end of itself: the
        // bunching of a cord that sprang back, which is what actually happens
        // and what the thorn was standing in for.
        widthRoot: cut.widthRoot * 1.5,
        widthTip: 0,
        taperTip: 0.85,
        samples: 8,
        paint: budget(frame, laneId, false, fade(toward(living, SCAR.glyph, cut.scar), leaving)),
      }),
    )
  }

  return marks
}

/**
 * How much of a cord is left to draw, as a multiplier on its ink (prd10 ruling 2).
 *
 * 1 for three quarters of the dissolve and then out over the last quarter, and the
 * shape is the point. The cord does not dim while its matter is leaving — the motes
 * *are* the matter leaving, and a cord that faded in step with them would be saying
 * the same thing twice while looking like a rendering artefact. It goes at the end,
 * over about half a second, so that the last thing to happen is the cord letting go
 * of the picture rather than the cord snapping out of it.
 *
 * The quarter matters for one more reason: `CUT.totalMs` lands at dissolve ≈ 0.52,
 * which is inside the flat stretch. Every brightness law prd5 wrote about a settled
 * scar reads exactly the ink it always did.
 */
export function composting(dissolve: number): number {
  const out = (clamp01(dissolve) - COMPOST_HOLD) / (1 - COMPOST_HOLD)
  if (out <= 0) return 1
  const eased = clamp01(out)
  return 1 - eased * eased * (3 - 2 * eased)
}

/** How long the cord holds its ink before it lets go. */
const COMPOST_HOLD = 0.75

/**
 * How much of the remnant the gathered end occupies, in px of arc — a length
 * rather than a fraction, for the same reason the scar itself is measured in px
 * (`geometry.ts`): a lane at three o'clock has a longer thread than one at noon,
 * and how much cord bunched up when it let go is not a fact about the clock.
 */
const GATHER_PX = 9

function arcLengthOf(path: readonly Point[]): number {
  let total = 0
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1] as Point
    const b = path[i] as Point
    total += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return total
}

/**
 * A thread's resting ink — its lane's activity, as a colour (law 9a). The whole
 * decision is `activityInk`'s; this function only picks which of the three
 * threads a lane can be is being drawn.
 */
function threadInk(frame: SceneFrame, thread: ThreadGeometry): Ink {
  if (thread.pathology === 'frozen') {
    // Gone dark. Still drawn (ruling 22) but barely lit: absence of light *is*
    // the encoding, so this is not a fade the alarm exemption should undo — the
    // magenta-red cut strokes on top of it are what stays at full strength. It
    // is also the one thread allowed under `CALM_FLOOR`, for the same reason.
    return ink(mix(NECROTIC, ICE_700, 0.4), 0.5)
  }

  const freshness = 1 - thread.ageFrac
  const heat = clamp01(frame.field.energyOf(thread.laneId).heat / HEAT_FULL)

  if (thread.pathology === 'expensive') {
    // White-hot: luminance at its ceiling, not a hue (ruling 29). Burning
    // through money is a *quantity*, so it is told in the channel quantities are
    // told in, and the lane's cyan NOTICE stays with the chevrons at the tip.
    // The contrast budget then holds all of it under a summons (graft g6).
    return ink(hotter(mix(ICE_500, ICE_100, freshness), 0.95), 1)
  }

  return activityInk(thread.lane.activity, freshness, heat)
}

/**
 * EXPENSIVE — over-exposed. A wide halo and a blown-out core: the one thread on
 * screen that should look like it is damaging the sensor. Both are non-alarm
 * marks, so the calm luminance ceiling applies and a NOTICE cannot out-read a
 * summons however hot it runs (graft g6).
 */
function heatMarks(frame: SceneFrame, thread: ThreadGeometry): Mark[] {
  const { laneId } = thread
  return [
    ribbonMark({
      role: 'heat',
      laneId,
      alarm: false,
      path: thread.path,
      widthRoot: thread.widthRoot * 7,
      widthTip: thread.widthTip * 7,
      taperTip: HEAT_TAPER,
      samples: 24,
      paint: budget(frame, laneId, false, ink(ICE_050, 0.06)),
    }),
    ribbonMark({
      role: 'heat',
      laneId,
      alarm: false,
      path: thread.path,
      widthRoot: thread.widthRoot * 0.5,
      widthTip: thread.widthTip * 0.55,
      taperTip: HEAT_TAPER,
      paint: budget(frame, laneId, false, ink(ICE_050, 0.85)),
    }),
  ]
}

/**
 * FROZEN's cut, as form rather than as a glyph laid over it (prd7 ruling 3).
 *
 * It used to be two strokes drawn *across* the thread — a tick marking a place
 * where something had happened to a line that carried on regardless. Now the
 * thread genuinely parts: {@link severedStops} closes the ribbon to nothing at
 * both positions, so the dark hypha is in three pieces, and these two marks are
 * the **lips** of those closures — a short collar of the thread's own substance,
 * swollen a little and stained the broken hue, tapering to the point where the
 * line ends.
 *
 * Two objects, exactly as before: the substitution spends nothing. What it buys
 * is that the severing survives being looked at closely. A tick across a
 * continuous line is a claim about the line; a line that stops is the fact.
 *
 * Still the third of the three axes FROZEN and WAITING are separated on
 * (dark/light, broken/continuous, cut/summoning), and still alarm marks: exempt
 * from every fade (graft g2), because the one state defined by being old must
 * not be dimmed by a recency ramp.
 */
function severedMarks(frame: SceneFrame, thread: ThreadGeometry): Mark[] {
  const { laneId } = thread
  /** How much thread each lip is drawn over — a shade wider than the closure. */
  const reach = SEVERED_SPAN * 1.15

  return SEVERED_AT.map((at) => {
    const local = thread.widthRoot + (thread.widthTip - thread.widthRoot) * at
    return ribbonMark({
      role: 'severed',
      laneId,
      alarm: true,
      path: stretch(thread.path, at - reach, at + reach, 12),
      // Swollen: dead tissue gathers at a break rather than thinning into one.
      widthRoot: local * 1.45,
      widthTip: local * 1.45,
      stops: [{ at: 0.5, span: SEVERED_SPAN / reach / 2, scale: 0, flat: SEVERED_FLAT }],
      samples: 12,
      paint: ink(BROKEN, 0.95),
    })
  })
}

/** The stretch of a path between two parameters, resampled at its own resolution. */
function stretch(path: readonly Point[], from: number, to: number, steps: number): Point[] {
  const out: Point[] = []
  for (let i = 0; i <= steps; i += 1) out.push(pointAt(path, from + (to - from) * (i / steps)))
  return out
}

/**
 * `prefers-reduced-motion`: travelling light becomes a **standing brightness
 * gradient** — bright at the root-mass for homeward traffic, bright at the tip
 * for nourishment going out, driven by the same decaying event energy the pulses
 * would have carried. Same facts, same directions, no movement.
 */
function standingFlow(frame: SceneFrame, thread: ThreadGeometry): Mark[] {
  const energy = frame.field.energyOf(thread.laneId)
  const inbound = clamp01(energy.inbound / 1.6)
  const outbound = clamp01(energy.outbound / 1.6)
  if (inbound < 0.03 && outbound < 0.03) return []

  const hot = hotter(ICE_200, 0.75)
  const emphasis = (value: number): Ink =>
    budget(frame, thread.laneId, false, ink(hot, 0.85 * value))

  return [
    ribbonMark({
      role: 'thread-flow',
      laneId: thread.laneId,
      alarm: false,
      path: thread.path,
      widthRoot: thread.widthRoot * 0.8,
      widthTip: thread.widthTip * 1.4,
      paint: {
        type: 'linear',
        from: pointAt(thread.path, 0),
        to: pointAt(thread.path, 1),
        stops: [
          { at: 0, ink: emphasis(inbound) },
          { at: 0.45, ink: emphasis(0.07 * Math.max(inbound, outbound)) },
          { at: 1, ink: emphasis(outbound) },
        ],
      },
    }),
  ]
}

/**
 * SECOND GROWTH (ruling 20) — a subagent thread as a finer filament off the
 * parent, ending in a thorn curl so it stops rather than fades out.
 */
function filamentMarks(frame: SceneFrame, thread: ThreadGeometry, base: Ink): Mark[] {
  const marks: Mark[] = []

  const habit = variationFor(variationSeed(thread.lane))

  for (const filament of thread.filaments) {
    for (const strand of filament.strands) {
      marks.push(
        ribbonMark({
          role: 'filament',
          laneId: thread.laneId,
          alarm: false,
          path: strand,
          widthRoot: filament.width * 1.15,
          widthTip: filament.width * 0.25,
          // Second growth inherits the parent's width habit — the whole lane is
          // one organism, so one hand drew all of it. Fewer samples: a 30px
          // strand has no edge anybody reads at 6× (`ribbon.ts`).
          modulate: habit.widthJitter,
          samples: 12,
          // A strand is under a pixel wide and ends in a thorn glyph; its round
          // caps would be two thirds of the mark spent on a curve nobody can
          // resolve. Sixty-six strands a frame at thirty lanes, so it counts.
          caps: false,
          paint: budget(frame, thread.laneId, false, { rgb: base.rgb, alpha: base.alpha * 0.62 }),
        }),
      )
    }

    const tip = filament.path[filament.path.length - 1]
    const before = filament.path[Math.max(0, filament.path.length - 3)]
    if (tip === undefined || before === undefined) continue

    marks.push({
      kind: 'path',
      role: 'filament-tip',
      laneId: thread.laneId,
      alarm: false,
      d: THORN_OUT,
      at: tip,
      size: Math.max(5, filament.width * 7),
      rotate: Math.atan2(tip.y - before.y, tip.x - before.x),
      ink: budget(frame, thread.laneId, false, { rgb: base.rgb, alpha: base.alpha * 0.8 }),
    })
  }

  return marks
}

/**
 * LOOPING's knot — a closed circuit tied into the thread, with the crossed tails
 * that make it a knot rather than a plain ring. The circuit is the encoding: the
 * light that goes round it comes back to where it started, and never home.
 *
 * An alarm mark, so a stuck lane's knot is never dimmed by a recency ramp or by
 * another lane holding the spotlight (graft g2).
 */
export function loopingMarks(frame: SceneFrame, thread: ThreadGeometry): Mark[] {
  const knot = thread.knot
  // A retired lane carries no faults forward. Whatever it was doing when it
  // stopped, it has stopped — and a knot on a scar would be an accusation about
  // a lane nobody can act on any more.
  if (knot === null || thread.retire !== null) return []

  const { centre, radius, tangent } = knot
  const width = Math.max(1.2, thread.widthRoot * 0.7)
  // The ring is the summons, so it is the incandescent end of the amber family
  // and clears `ALARM_FLOOR`; the tails behind it stay at full saturation, which
  // is what makes the ring read as the lit part of one object rather than as a
  // paler second one.
  const amber = ink(incandescent(NEEDS_YOU), 0.98)

  // Knot-local space: +x runs along the thread, so the tails trail behind it.
  const at = (along: number, across: number): Point => ({
    x: centre.x + Math.cos(tangent) * along - Math.sin(tangent) * across,
    y: centre.y + Math.sin(tangent) * along + Math.cos(tangent) * across,
  })

  const marks: Mark[] = [
    {
      kind: 'arc',
      role: 'looping-mark',
      laneId: thread.laneId,
      alarm: true,
      at: centre,
      radius,
      from: 0,
      to: Math.PI * 2,
      width,
      ink: amber,
    },
  ]

  for (const side of [-1, 1]) {
    marks.push({
      kind: 'stroke',
      role: 'looping-mark',
      laneId: thread.laneId,
      alarm: true,
      width: width * 0.9,
      ink: ink(NEEDS_YOU, 0.92),
      points: [
        at(-radius * 1.9, radius * 0.75 * side),
        at(-radius * 0.7, radius * 0.2 * side),
        at(-radius * 0.15, -radius * 0.98 * side),
      ],
    })
  }

  return marks
}

/**
 * OFF-FENCE — the reach (`off-fence-reach`), what it took hold of
 * (`off-fence-grasp`) and the boundary it crossed (`off-fence-victim`). The
 * fourth of the family, the offender's own marking, is at its node in
 * `node.ts`. Today they are drawn as a barbed filament through a dashed amber
 * fence arc.
 *
 * Drawn at the victim rather than at the offender because off-fence is a
 * two-party fact and the picture should name both: the reach leaves the
 * offender's node, and the fence it went through is bracketed around the lane
 * whose ground it entered. (Spike C's rim territory wedges are deliberately gone
 * — they read as ambient substrate and never as "this lane's ground", and the
 * prd records that as the finding.)
 *
 * This is manifest-driven only. `lane.trespasses` is empty whenever there was no
 * `.swarm/lanes.json` to judge against, so nothing here can fire on a guess; the
 * scene says the pathology is *unavailable* instead (ruling 19).
 */
export function offFenceMarks(frame: SceneFrame, thread: ThreadGeometry): Mark[] {
  const rogue = thread.rogue
  // Same reason as the knot: a scar reaches for nothing. The fence it crossed
  // while it was alive is the fleet table's and the replay's to remember.
  if (rogue === null || thread.retire !== null) return []

  const marks: Mark[] = []
  const amber = ink(NEEDS_YOU, 0.9)

  marks.push({
    kind: 'stroke',
    role: 'off-fence-reach',
    laneId: thread.laneId,
    alarm: true,
    points: rogue.path,
    width: 1.6,
    ink: amber,
    dash: [6, 4],
  })

  // The barb: a hook, not an arrowhead. It grabbed something.
  const tip = rogue.path[rogue.path.length - 1]
  const before = rogue.path[Math.max(0, rogue.path.length - 4)]
  if (tip !== undefined && before !== undefined) {
    const angle = Math.atan2(tip.y - before.y, tip.x - before.x)
    for (const side of [-1, 1]) {
      marks.push({
        kind: 'stroke',
        role: 'off-fence-grasp',
        laneId: thread.laneId,
        alarm: true,
        width: 1.5,
        ink: ink(NEEDS_YOU, 0.95),
        points: [
          offset(tip, angle, -7, 0),
          offset(tip, angle, -1.5, side * 2),
          offset(tip, angle, 2, side * 5),
        ],
      })
    }
  }

  // The fence itself, around the victim's node, facing the intruder.
  const victim = rogue.victimId === null ? null : frame.geometry.byLane.get(rogue.victimId)
  if (victim !== undefined && victim !== null) {
    const towards = Math.atan2(thread.node.y - victim.node.y, thread.node.x - victim.node.x)
    const radius = 22
    const half = Math.PI * 0.42

    marks.push({
      kind: 'arc',
      role: 'off-fence-victim',
      laneId: thread.laneId,
      alarm: true,
      at: victim.node,
      radius,
      from: towards - half,
      to: towards + half,
      width: 1.4,
      ink: ink(NEEDS_YOU, 0.7),
      dash: [4, 3],
    })

    for (const angle of [towards - half, towards + half]) {
      marks.push({
        kind: 'stroke',
        role: 'off-fence-victim',
        laneId: thread.laneId,
        alarm: true,
        width: 1.4,
        ink: ink(NEEDS_YOU, 0.8),
        points: [
          {
            x: victim.node.x + Math.cos(angle) * (radius - 4),
            y: victim.node.y + Math.sin(angle) * (radius - 4),
          },
          {
            x: victim.node.x + Math.cos(angle) * (radius + 4),
            y: victim.node.y + Math.sin(angle) * (radius + 4),
          },
        ],
      })
    }
  }

  return marks
}

function offset(
  from: { x: number; y: number },
  angle: number,
  along: number,
  across: number,
): { x: number; y: number } {
  return {
    x: from.x + Math.cos(angle) * along - Math.sin(angle) * across,
    y: from.y + Math.sin(angle) * along + Math.cos(angle) * across,
  }
}
