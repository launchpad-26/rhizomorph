import { pointAt, tangentAt, type Point, type ThreadGeometry } from '../geometry.js'
import { alarmPulse } from '../motion.js'
import { ICE_100, ICE_200, NEEDS_YOU, clamp01, hotter, incandescent, ink } from '../palette.js'
import { PulseField, type Pulse } from '../pulses.js'
import { budget, motionMode, summonsAgeMs, type SceneFrame } from './frame.js'
import { ribbonMark, type Mark } from './types.js'

/**
 * LIGHT IN FLIGHT — the part of the picture that is allowed to move.
 *
 * Everything here is downstream of a real event: {@link PulseField} only ever
 * spawns from the news tail, so a mark in this file exists because something
 * happened. The colour is the ice register's own white (ruling 29) — pulses are
 * *light*, not a fifth hue, so nothing that travels ever competes with the
 * ladder for meaning.
 *
 * prd7 ruling 3 split the file's traffic in two, along a line the scene already
 * drew elsewhere. A **mote** is a model request — light, nourishment going out —
 * and is drawn as light. A **commit** is work, so it is drawn as matter: a
 * travelling swell in the thread's own width, the same reading the homeward flow
 * has at the other end of a lane's life. Nine objects a journey became two, and
 * the packet stopped being a bead riding on a wire.
 *
 * Everything here belongs to the budget's **event** class, and the class's cap
 * is what makes the file readable in a storm: the field will never hand us more
 * than five journeys at once, and the sixth arrives as an *aggregate* — one
 * packet carrying a count of the events that folded into it (ruling 4). A count
 * beside one moving light is a fact; twelve moving lights are a mood.
 *
 * Two of the things drawn here are states rather than journeys, and both are
 * lawful under ruling 32's motion amendment because they are the encoding rather
 * than decoration:
 *
 * - the LOOPING orbit advances one notch per real `tool.activity`, so a loop
 *   that stops looks stopped — the wheel turns because the agent turned it;
 * - the WAITING throb is a blessed exception, and it now ages: ruling 5 lets an
 *   unanswered summons pulse *slower and brighter* the longer it goes unanswered.
 *   Slower, never faster — insistent, not frantic.
 *
 * The two degradations are not the same shape, and the difference is deliberate.
 * Under **reduced motion** travelling pulses are not drawn at all and the same
 * facts are carried by the standing brightness gradient in `thread.ts`. Under
 * **pause** they are drawn exactly where they were: the scene holds its clock
 * still, so a paused frame is the picture the operator was looking at when they
 * pressed the button, rather than a different picture with the light removed.
 */

/** How far along the thread a tool-call tick flicks. Near the tip: work is there. */
const TICK_AT = 0.94

/** Where a held pulse sits — just inside the node, so the hand has the tip. */
const HELD_AT = 0.9

export function lightMarks(frame: SceneFrame, thread: ThreadGeometry): Mark[] {
  const marks: Mark[] = []

  if (motionMode(frame) !== 'reduced') {
    for (const pulse of frame.field.pulses()) {
      if (pulse.laneId !== thread.laneId) continue
      marks.push(...pulseMarks(frame, thread, pulse))
    }
  }

  if (thread.pathology === 'looping') marks.push(...orbitMarks(frame, thread))
  if (thread.pathology === 'waiting') marks.push(...heldMarks(frame, thread))

  return marks
}

function pulseMarks(frame: SceneFrame, thread: ThreadGeometry, pulse: Pulse): Mark[] {
  // The ANIMATION clock (#157), and it is the same one the pulse was stamped with
  // at ingest (`scene/index.tsx`). A pulse's whole life is a 400–600 ms envelope
  // out of the event class's budget; put it on the scrub clock instead and a
  // replay at 8× would fire that envelope in 60 ms and the class would be out of
  // its own band. Held still by the pause control, like everything else here.
  const progress = PulseField.progress(pulse, frame.now)
  // A staggered mote is born in the future; it has not left yet.
  if (progress <= 0) return []

  // Fades in and out, so a pulse enters and leaves rather than blinking.
  const envelope = Math.sin(Math.PI * progress) ** 0.6
  const { laneId } = thread

  if (pulse.kind === 'tick') {
    // A tool call is a flick across the thread at the tip. It never travels:
    // the work is *there*, and a travelling tick would claim a journey that
    // no event made.
    const at = pointAt(thread.path, TICK_AT)
    const along = tangentAt(thread.path, TICK_AT)
    return [
      {
        kind: 'stroke',
        role: 'tick',
        laneId,
        alarm: false,
        width: 1.1,
        ink: budget(frame, laneId, false, ink(hotter(ICE_200, 0.7), 0.5 * envelope)),
        points: [
          { x: at.x - along.y * 3.4, y: at.y + along.x * 3.4 },
          { x: at.x + along.y * 3.4, y: at.y - along.x * 3.4 },
        ],
      },
    ]
  }

  const t = PulseField.position(pulse, frame.now)
  const at = pointAt(thread.path, t)
  const size = pulse.size * (0.75 + 0.35 * envelope) * swell(pulse.count)
  const marks: Mark[] = []

  // A COMMIT IS MATTER, SO IT IS A SWELL (prd7 ruling 3).
  //
  // It used to be a bright dot with seven fading glows trailing it. That was a
  // discrete object riding *above* the thread, and it read as one — a bead on a
  // wire rather than something the lane had produced. A commit is work: the
  // honest picture is the hypha itself bulging as the substance passes, which is
  // exactly the reading the homeward flow already had at the other end of a
  // lane's life. So the packet becomes a travelling thickening of the thread's
  // own width, asymmetric so its direction reads in one frame, and nine objects
  // become two.
  //
  // Motes keep their glow, and the split is the scene's own distinction rather
  // than an inconsistency: a mote is a model request — *light*, nourishment
  // going out — and light is drawn as light. Matter is drawn as matter.
  if (pulse.kind === 'commit' || pulse.kind === 'landing' || pulse.kind === 'aggregate') {
    marks.push(...swellMarks(frame, thread, pulse, t, envelope))
  } else {
    marks.push(
      {
        kind: 'glow',
        role: 'pulse',
        laneId,
        alarm: false,
        at,
        radius: size * 2.6,
        ink: budget(frame, laneId, false, ink(hotter(ICE_200, 0.55), 0.16 * envelope)),
      },
      {
        kind: 'glow',
        role: 'pulse',
        laneId,
        alarm: false,
        at,
        radius: size,
        ink: budget(frame, laneId, false, ink(hotter(ICE_200, 0.92), 0.72 * envelope)),
      },
    )
  }

  if (pulse.count > 1) marks.push(countMark(frame, thread, pulse, at, size, envelope))

  return marks
}

/**
 * The swell, and the wake behind it — the commit packet's whole geometry.
 *
 * Both are stretches of the lane's *own* thread with a bulge in the width, so
 * neither is a new object in the picture: what travels is the thread being
 * thicker for a moment. The head is short and steep; the wake is longer, wider
 * back the way it came, and much fainter, which is what makes direction legible
 * in a single frame without an arrowhead. The wake's length is the file count —
 * the journey still carries how much rode in.
 */
function swellMarks(
  frame: SceneFrame,
  thread: ThreadGeometry,
  pulse: Pulse,
  t: number,
  envelope: number,
): Mark[] {
  const { laneId } = thread
  const behind = pulse.homeward ? 1 : -1
  const tail = 0.06 + Math.min(0.12, pulse.weight * 0.007)

  /** The thread's own width where the parcel is — what the swell swells *from*. */
  const widthAt = (at: number): number =>
    thread.widthRoot + (thread.widthTip - thread.widthRoot) * clamp01(at)

  /**
   * How much thicker the thread gets, in **pixels** rather than as a multiple.
   *
   * A multiple would be the obvious choice and it is the wrong one: a small
   * lane's thread is a hairline, and twice a hairline is a hairline. A commit is
   * the same event whoever made it, so the bulge is an absolute amount — which
   * also means it reads as *proportionally* larger on a small lane, exactly as a
   * parcel of the same size travelling down a narrower tube would.
   *
   * Bigger for an aggregate, as the packet was: the count is the number, and the
   * size only says "this one is carrying more than itself".
   */
  const bulge = 3.2 * swell(pulse.count)
  const peaked = (local: number, amount: number): number => (local + amount) / local

  const wakeAt = clamp01(t + behind * tail * 0.5)
  const head = widthAt(t)
  const trail = widthAt(wakeAt)

  return [
    ribbonMark({
      role: 'pulse-wake',
      laneId,
      alarm: false,
      path: stretch(thread.path, wakeAt - tail, wakeAt + tail),
      widthRoot: trail,
      widthTip: trail,
      stops: [
        { at: pulse.homeward ? 0.7 : 0.3, span: 0.8, scale: peaked(trail, bulge * 0.45) },
      ],
      samples: 12,
      paint: budget(frame, laneId, false, ink(hotter(ICE_200, 0.8), 0.4 * envelope)),
    }),
    ribbonMark({
      role: 'pulse',
      laneId,
      alarm: false,
      path: stretch(thread.path, t - tail * 0.55, t + tail * 0.55),
      widthRoot: head,
      widthTip: head,
      stops: [{ at: 0.5, span: 0.7, scale: peaked(head, bulge) }],
      samples: 12,
      paint: budget(frame, laneId, false, ink(hotter(ICE_200, 0.92), envelope)),
    }),
  ]
}

/** The stretch of the thread a swell occupies, resampled at its own resolution. */
function stretch(path: readonly Point[], from: number, to: number): Point[] {
  const steps = 12
  return Array.from({ length: steps + 1 }, (_unused, i) =>
    pointAt(path, from + (to - from) * (i / steps)),
  )
}

/**
 * How much bigger an aggregate rides than the single journey it grew out of.
 *
 * Logarithmic and capped: the count is the number, and the size only has to say
 * "this one is carrying more than itself". A packet that scaled linearly with a
 * burst of two hundred would be a disc across the whole scene.
 */
function swell(count: number): number {
  if (count <= 1) return 1
  return 1 + Math.min(0.6, 0.18 * Math.log2(count))
}

/**
 * The count an aggregate carries — the whole reason coalescing is honest rather
 * than merely tidy. Mono with tabular numerals, because it is a figure (law 11),
 * and set beside the packet rather than on it so the light stays light.
 */
function countMark(
  frame: SceneFrame,
  thread: ThreadGeometry,
  pulse: Pulse,
  at: Point,
  size: number,
  envelope: number,
): Mark {
  return {
    kind: 'text',
    role: 'pulse',
    laneId: thread.laneId,
    alarm: false,
    at: { x: at.x, y: at.y - size - 5 },
    text: `×${pulse.count}`,
    font: 'mono',
    size: 9,
    weight: 600,
    align: 'centre',
    ink: budget(frame, thread.laneId, false, ink(ICE_100, 0.9 * envelope)),
  }
}

/**
 * LOOPING — a pulse going round the knot, never reaching the root-mass. Its
 * phase is the lane's orbit energy, which only ever advances on a real tool
 * call, so the wheel is the agent's own and not an animation.
 */
function orbitMarks(frame: SceneFrame, thread: ThreadGeometry): Mark[] {
  const knot = thread.knot
  if (knot === null) return []

  const energy = frame.field.energyOf(thread.laneId)
  // Reduced motion takes the jump-cut: the notch the tool calls have actually
  // put the wheel on, rather than the eased travel toward it. Same fact, same
  // circuit, no movement — which is the sanctioned degradation for a layout
  // that would otherwise animate its way to a solved position.
  const phase = motionMode(frame) === 'reduced' ? energy.orbitTarget : energy.orbitPhase
  const angle = knot.tangent + phase * Math.PI * 2
  const on = (a: number): Point => ({
    x: knot.centre.x + Math.cos(a) * knot.radius,
    y: knot.centre.y + Math.sin(a) * knot.radius,
  })

  const marks: Mark[] = []

  // A short wake behind it, so which way it is going reads in one frame — and
  // so a still screenshot of a looping lane still shows a circuit.
  const wake = 8
  for (let i = wake; i >= 1; i -= 1) {
    const fade = (1 - i / wake) ** 1.5
    marks.push({
      kind: 'glow',
      role: 'orbit-wake',
      laneId: thread.laneId,
      alarm: true,
      at: on(angle - (i / wake) * 0.85),
      radius: 1.4 + 1.8 * fade,
      ink: ink(hotter(NEEDS_YOU, 0.4), 0.4 * fade),
    })
  }

  marks.push(
    {
      kind: 'glow',
      role: 'orbit',
      laneId: thread.laneId,
      alarm: true,
      at: on(angle),
      radius: 10,
      ink: ink(NEEDS_YOU, 0.26),
    },
    {
      kind: 'glow',
      role: 'orbit',
      laneId: thread.laneId,
      alarm: true,
      at: on(angle),
      radius: 3.2,
      // The travelling light itself, at the incandescent end of the amber
      // family: a looping lane's brightest mark, and the one that puts it inside
      // the band the alarms own (`ALARM_FLOOR`).
      ink: ink(incandescent(NEEDS_YOU), 0.98),
    },
  )

  return marks
}

/**
 * WAITING — a held pulse breathing at the node. The thread behind it stays lit,
 * which is half of why this can never be read as FROZEN: waiting is light that
 * has stopped moving, frozen is darkness with a cut across it.
 *
 * The breathing ages (ruling 5). A summons that has gone unanswered for ten
 * minutes pulses more slowly and more brightly than one raised a moment ago —
 * the hand does not start waving faster because nobody came, it gets harder to
 * look away from. Reduced motion and pause both pin the throb to a static bright
 * value (ruling 32's degradation, and the reason a paused alarm can never freeze
 * at the dim end of its own wave).
 */
function heldMarks(frame: SceneFrame, thread: ThreadGeometry): Mark[] {
  const pulse = alarmPulse(summonsAgeMs(frame, thread), motionMode(frame))
  const throb = (0.55 + 0.45 * pulse.throb) * pulse.intensity
  const at = pointAt(thread.path, HELD_AT)

  return [
    {
      kind: 'glow',
      role: 'held',
      laneId: thread.laneId,
      alarm: true,
      at,
      radius: 13 * throb,
      ink: ink(NEEDS_YOU, 0.16),
    },
    {
      kind: 'glow',
      role: 'held',
      laneId: thread.laneId,
      alarm: true,
      at,
      radius: 4.6 * (0.75 + 0.35 * throb),
      // Light that has stopped moving, and still the brightest light there is:
      // the held dot clears `ALARM_FLOOR` like every other needs-you core.
      ink: ink(incandescent(NEEDS_YOU), 0.98),
    },
  ]
}
