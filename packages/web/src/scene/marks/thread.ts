import { pointAt, tangentAt, type Point, type ThreadGeometry } from '../geometry.js'
import {
  BROKEN,
  ICE_050,
  ICE_200,
  ICE_700,
  NECROTIC,
  NEEDS_YOU,
  clamp01,
  hotter,
  ink,
  mix,
  type Ink,
} from '../palette.js'
import { budget, type SceneFrame } from './frame.js'
import { THORN_OUT } from './glyphs.js'
import type { Mark } from './types.js'

/**
 * THE THREADS — a lane as a hypha, root-mass rim to node.
 *
 * The resting picture is deliberately quiet: cold blue-white linework on
 * near-black-blue, no saturation anywhere. Only two things are allowed to break
 * that quiet, and between them they are the whole of the glance test —
 * **light**, which is always an event in flight, and the **ladder hues**, which
 * only ever appear on a fault.
 *
 * Two constraints pull against each other in a thread's brightness, and the
 * numbers below are where they meet. The floor: ruling 22 says render
 * everything, and a thread too faint to trace back to the mass is hinted at
 * rather than rendered. The ceiling: light in flight has to out-read the thread
 * it travels on, or the flow disappears into its own substrate.
 */

/** Under this much heat a thread is at its resting brightness. */
const HEAT_FULL = 2.5

export function threadMarks(frame: SceneFrame, thread: ThreadGeometry): Mark[] {
  const marks: Mark[] = []
  const { laneId } = thread
  const frozen = thread.pathology === 'frozen'
  const base = threadInk(frame, thread)

  // Bloom first, wide and faint, then the core. Two ribbons rather than a shadow
  // blur: shadows on forty paths a frame is where canvas 2D falls over.
  marks.push({
    kind: 'ribbon',
    role: 'thread-bloom',
    laneId,
    alarm: false,
    path: thread.path,
    widthRoot: thread.widthRoot * 3.6,
    widthTip: thread.widthTip * 3.6,
    paint: budget(frame, laneId, false, { rgb: base.rgb, alpha: base.alpha * 0.1 }),
    ...(frozen ? { dashed: true } : {}),
  })

  marks.push({
    kind: 'ribbon',
    role: 'thread',
    laneId,
    alarm: false,
    path: thread.path,
    widthRoot: thread.widthRoot,
    widthTip: thread.widthTip,
    paint: budget(frame, laneId, false, base),
    ...(frozen ? { dashed: true } : {}),
  })

  if (thread.pathology === 'expensive') marks.push(...heatMarks(frame, thread))
  if (frozen) marks.push(...cutMarks(frame, thread))
  if (frame.reducedMotion) marks.push(...standingFlow(frame, thread))

  marks.push(...filamentMarks(frame, thread, base))

  return marks
}

/**
 * A thread's resting ink. Freshness — the same fact the node's distance from the
 * mass carries — is read a second time here as lightness, because two channels
 * saying the same thing is what makes recency legible without a legend.
 */
function threadInk(frame: SceneFrame, thread: ThreadGeometry): Ink {
  if (thread.pathology === 'frozen') {
    // Gone dark. Still drawn (ruling 22) but barely lit: absence of light *is*
    // the encoding, so this is not a fade the alarm exemption should undo — the
    // magenta-red cut strokes on top of it are what stays at full strength.
    return ink(mix(NECROTIC, ICE_700, 0.4), 0.5)
  }

  const freshness = 1 - thread.ageFrac
  const resting = mix(ICE_700, ICE_200, freshness)
  const heat = clamp01(frame.field.energyOf(thread.laneId).heat / HEAT_FULL)

  if (thread.pathology === 'expensive') {
    // White-hot: luminance at its ceiling, not a fifth hue (ruling 29). The
    // contrast budget then holds it under a summons (graft g6).
    return ink(hotter(resting, 0.95), 1)
  }

  const alpha = 0.22 + 0.32 * freshness + 0.16 * heat
  return ink(resting, thread.lane.activity === 'done' ? alpha * 0.78 : alpha)
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
    {
      kind: 'ribbon',
      role: 'heat',
      laneId,
      alarm: false,
      path: thread.path,
      widthRoot: thread.widthRoot * 7,
      widthTip: thread.widthTip * 7,
      paint: budget(frame, laneId, false, ink(ICE_050, 0.06)),
    },
    {
      kind: 'ribbon',
      role: 'heat',
      laneId,
      alarm: false,
      path: thread.path,
      widthRoot: thread.widthRoot * 0.5,
      widthTip: thread.widthTip * 0.55,
      paint: budget(frame, laneId, false, ink(ICE_050, 0.85)),
    },
  ]
}

/**
 * FROZEN's cut. Two strokes across the thread, not along it: a cut has to sit
 * *across* the line it severs to read as one. Together with the dashed dark
 * ribbon and the hollow node, this is the third of the three axes FROZEN and
 * WAITING are separated on (dark/light, broken/continuous, cut/raised).
 *
 * Both strokes are alarm marks: exempt from every fade (graft g2), because the
 * one state defined by being old must not be dimmed by a recency ramp.
 */
function cutMarks(frame: SceneFrame, thread: ThreadGeometry): Mark[] {
  const at = pointAt(thread.path, 0.72)
  const along = tangentAt(thread.path, 0.72)
  const across = { x: -along.y, y: along.x }
  const span = 6 + thread.widthRoot
  const lean = 3

  return [-4, 4].map((offset) => ({
    kind: 'stroke' as const,
    role: 'cut' as const,
    laneId: thread.laneId,
    alarm: true,
    width: 1.7,
    ink: ink(BROKEN, 0.95),
    points: [
      {
        x: at.x + along.x * (offset - lean) - across.x * span,
        y: at.y + along.y * (offset - lean) - across.y * span,
      },
      {
        x: at.x + along.x * (offset + lean) + across.x * span,
        y: at.y + along.y * (offset + lean) + across.y * span,
      },
    ],
  }))
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
    {
      kind: 'ribbon',
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
    },
  ]
}

/**
 * SECOND GROWTH (ruling 20) — a subagent thread as a finer filament off the
 * parent, ending in a thorn curl so it stops rather than fades out.
 */
function filamentMarks(frame: SceneFrame, thread: ThreadGeometry, base: Ink): Mark[] {
  const marks: Mark[] = []

  for (const filament of thread.filaments) {
    for (const strand of filament.strands) {
      marks.push({
        kind: 'ribbon',
        role: 'filament',
        laneId: thread.laneId,
        alarm: false,
        path: strand,
        widthRoot: filament.width * 1.15,
        widthTip: filament.width * 0.25,
        paint: budget(frame, thread.laneId, false, { rgb: base.rgb, alpha: base.alpha * 0.62 }),
      })
    }

    const tip = filament.path[filament.path.length - 1]
    const before = filament.path[Math.max(0, filament.path.length - 3)]
    if (tip === undefined || before === undefined) continue

    marks.push({
      kind: 'path',
      role: 'filament-thorn',
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
export function knotMarks(frame: SceneFrame, thread: ThreadGeometry): Mark[] {
  const knot = thread.knot
  if (knot === null) return []

  const { centre, radius, tangent } = knot
  const width = Math.max(1.2, thread.widthRoot * 0.7)
  const amber = ink(NEEDS_YOU, 0.82)

  // Knot-local space: +x runs along the thread, so the tails trail behind it.
  const at = (along: number, across: number): Point => ({
    x: centre.x + Math.cos(tangent) * along - Math.sin(tangent) * across,
    y: centre.y + Math.sin(tangent) * along + Math.cos(tangent) * across,
  })

  const marks: Mark[] = [
    {
      kind: 'arc',
      role: 'knot',
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
      role: 'knot',
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
 * OFF-FENCE — a barbed rogue filament through a dashed amber fence arc at the
 * victim's node.
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
export function rogueMarks(frame: SceneFrame, thread: ThreadGeometry): Mark[] {
  const rogue = thread.rogue
  if (rogue === null) return []

  const marks: Mark[] = []
  const amber = ink(NEEDS_YOU, 0.9)

  marks.push({
    kind: 'stroke',
    role: 'rogue',
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
        role: 'rogue-barb',
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
      role: 'fence',
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
        role: 'fence',
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
