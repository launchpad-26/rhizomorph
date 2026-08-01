import {
  pointAt,
  tangentAt,
  type Point,
  type RetireGeometry,
  type ThreadGeometry,
} from '../geometry.js'
import {
  BROKEN,
  ICE_050,
  ICE_100,
  ICE_200,
  ICE_500,
  ICE_700,
  NECROTIC,
  NEEDS_YOU,
  activityInk,
  clamp01,
  hotter,
  incandescent,
  ink,
  mix,
  type Ink,
} from '../palette.js'
import { SCAR, toward } from '../retire.js'
import type { WidthStop } from '../ribbon.js'
import { variationFor, variationSeed } from '../variation.js'
import { budget, type SceneFrame } from './frame.js'
import { THORN_OUT } from './glyphs.js'
import { ribbonMark, type Mark } from './types.js'

/**
 * THE THREADS — a lane as a hypha, root-mass rim to node.
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
 * How much of the thread each closure consumes. Wide enough that a sample always
 * lands inside the flat bottom of the pinch, so the ribbon genuinely parts
 * rather than necking down to a hairline.
 */
const SEVERED_SPAN = 0.07
const SEVERED_FLAT = 0.5

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
  const base = threadInk(frame, thread)

  // A retiring lane is not part of the living network, and the display list says
  // so: no `thread`, no bloom once it has settled, no heat, no standing flow, no
  // second growth. See `scarMarks`.
  if (thread.retire !== null) return scarMarks(frame, thread, thread.retire, base)

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
      paint: budget(frame, laneId, false, { rgb: base.rgb, alpha: base.alpha * 0.1 }),
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

  return marks
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
 * - the **freed end** curls back on itself. Every terminal in this scene ends in
 *   a hook (ruling 23); one pointing back down its own thread is an end that was
 *   *released*, which is the fact, rather than an end that was chopped.
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

  const { laneId } = thread
  const marks: Mark[] = []
  const cold = toward(living, SCAR.thread, cut.scar)

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

  if (cut.homeward !== null) {
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
  // to curl: the thread is still tied into the mass, just slack.
  const freed = cut.path[0]
  const next = cut.path[1]
  if (cut.from > 0 && freed !== undefined && next !== undefined) {
    marks.push({
      kind: 'path',
      role: 'scar-mark',
      laneId,
      alarm: false,
      d: THORN_OUT,
      at: freed,
      size: Math.max(6, cut.widthRoot * 4),
      // Back down its own thread, away from the mass it let go of.
      rotate: Math.atan2(freed.y - next.y, freed.x - next.x),
      ink: budget(frame, laneId, false, toward(living, SCAR.glyph, cut.scar)),
    })
  }

  return marks
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
