import { pointAt, tangentAt, type Point, type ThreadGeometry } from '../geometry.js'
import { ICE_200, NEEDS_YOU, clamp01, hotter, incandescent, ink } from '../palette.js'
import { PulseField, type Pulse } from '../pulses.js'
import { budget, type SceneFrame } from './frame.js'
import type { Mark } from './types.js'

/**
 * LIGHT IN FLIGHT — the part of the picture that is allowed to move.
 *
 * Everything here is downstream of a real event: {@link PulseField} only ever
 * spawns from the news tail, so a mark in this file exists because something
 * happened. The colour is the ice register's own white (ruling 29) — pulses are
 * *light*, not a fifth hue, so nothing that travels ever competes with the
 * ladder for meaning.
 *
 * Two of the three things drawn here are states rather than journeys, and both
 * are lawful under ruling 32's motion amendment because they are the encoding
 * rather than decoration:
 *
 * - the LOOPING orbit advances one notch per real `tool.activity`, so a loop
 *   that stops looks stopped — the wheel turns because the agent turned it;
 * - the WAITING throb is a blessed exception, and degrades to a static bright
 *   dot under `prefers-reduced-motion`.
 *
 * Under reduced motion travelling pulses are not drawn at all: the same facts
 * are carried by the standing brightness gradient in `thread.ts`.
 */

/** How far along the thread a tool-call tick flicks. Near the tip: work is there. */
const TICK_AT = 0.94

/** Where a held pulse sits — just inside the node, so the hand has the tip. */
const HELD_AT = 0.9

export function lightMarks(frame: SceneFrame, thread: ThreadGeometry): Mark[] {
  const marks: Mark[] = []

  if (!frame.reducedMotion) {
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
  const size = pulse.size * (0.75 + 0.35 * envelope)
  const marks: Mark[] = []

  // A commit is a packet with a wake: sharp head, tapered tail pointing back
  // the way it came, so its direction reads in a single frame. The tail's
  // length is the file count — the journey carries how much rode in.
  if (pulse.kind === 'commit' || pulse.kind === 'landing') {
    const tail = 0.05 + Math.min(0.1, pulse.weight * 0.006)
    const steps = 7
    for (let i = steps; i >= 1; i -= 1) {
      const behind = clamp01(t + (pulse.homeward ? tail : -tail) * (i / steps))
      const fade = (1 - i / steps) ** 1.6
      marks.push({
        kind: 'glow',
        role: 'pulse-wake',
        laneId,
        alarm: false,
        at: pointAt(thread.path, behind),
        radius: size * (0.35 + 0.5 * fade),
        ink: budget(frame, laneId, false, ink(hotter(ICE_200, 0.8), 0.45 * fade * envelope)),
      })
    }
  }

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
      ink: budget(
        frame,
        laneId,
        false,
        ink(hotter(ICE_200, 0.92), (pulse.kind === 'mote' ? 0.72 : 1) * envelope),
      ),
    },
  )

  return marks
}

/**
 * LOOPING — a pulse going round the knot, never reaching the root-mass. Its
 * phase is the lane's orbit energy, which only ever advances on a real tool
 * call, so the wheel is the agent's own and not an animation.
 */
function orbitMarks(frame: SceneFrame, thread: ThreadGeometry): Mark[] {
  const knot = thread.knot
  if (knot === null) return []

  const phase = frame.field.energyOf(thread.laneId).orbitPhase
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
 * Reduced motion pins the throb to a static bright dot (ruling 32).
 */
function heldMarks(frame: SceneFrame, thread: ThreadGeometry): Mark[] {
  const throb = frame.reducedMotion
    ? 0.75
    : 0.55 + 0.45 * (0.5 + 0.5 * Math.sin((frame.now / 620) * Math.PI))
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
