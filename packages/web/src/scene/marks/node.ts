import { formatTokens } from '../../lib/format.js'
import type { LadderRank, PathologyKind } from '../../fleet/index.js'
import { tangentAt, type Point, type ThreadGeometry } from '../geometry.js'
import {
  BROKEN,
  ICE_200,
  ICE_400,
  ICE_700,
  ICE_950,
  NECROTIC,
  NEEDS_YOU,
  NOTICE,
  ink,
  mix,
  type Ink,
  type Rgb,
} from '../palette.js'
import { budget, type SceneFrame } from './frame.js'
import { CARTOUCHE, NODE_LENS, THORN_OUT } from './glyphs.js'
import type { Mark } from './types.js'

/**
 * THE NODES — where a lane's thread ends, and where its state is legible.
 *
 * A node is a lens, not a bead: pointed at both ends, lying along its own
 * thread, with a thorn curl off the outer tip (ruling 23). Its size is the
 * lane's work, its fill is its freshness, and its *behaviour* is its state —
 * which is the difference between this scene and a chart with coloured dots.
 *
 * The five pathologies are behaviours of the thread and its tip, and each is
 * built so it survives greyscale (law 9's "colour is never the sole carrier"):
 *
 * | state     | form                                   | hue        |
 * | --------- | -------------------------------------- | ---------- |
 * | LOOPING   | ring at the node, knot on the thread   | amber      |
 * | FROZEN    | hollow node, dashed dark thread, cuts  | magenta-red|
 * | WAITING   | raised hand, upright, thread stays lit | amber      |
 * | EXPENSIVE | rising chevrons off the tip            | cyan       |
 * | OFF-FENCE | barb on the node, reach to the victim  | amber      |
 *
 * FROZEN and WAITING are the pair the prd says must never be confusable, so
 * they are opposed on three axes at once: **dark vs light** (a dead thread and a
 * lit one), **broken vs continuous** (dashed vs whole), and **cut vs raised** (a
 * severing stroke across the thread vs a hand standing up off the node).
 * `marks.test.ts` asserts all three, so no future tuning can quietly collapse
 * one of them.
 */

const PATHOLOGY_HUE: Record<PathologyKind, Rgb> = {
  looping: NEEDS_YOU,
  waiting: NEEDS_YOU,
  'off-fence': NEEDS_YOU,
  frozen: BROKEN,
  expensive: NOTICE,
}

const RANK_HUE: Record<LadderRank, Rgb> = {
  calm: ICE_200,
  notice: NOTICE,
  'needs-you': NEEDS_YOU,
  broken: BROKEN,
}

/** How far a raised hand stands off its node. Tall enough to clear the label. */
const HAND_LIFT = 15

export function nodeMarks(frame: SceneFrame, thread: ThreadGeometry): Mark[] {
  const marks: Mark[] = []
  const { laneId, lane } = thread
  const along = tangentAt(thread.path, 1)
  const angle = Math.atan2(along.y, along.x)
  const hue = hueOf(thread)
  const alarm = thread.alarm

  const length = (9 + 9 * thread.sizeFrac) * frame.breath
  const freshness = 1 - thread.ageFrac
  const frozen = thread.pathology === 'frozen'
  const done = lane.activity === 'done'
  const plain = thread.pathology === null && lane.rank === 'calm'

  // The lens. Hollow for a frozen lane and for a finished one — an outline is
  // "no longer filling with work", which is true of a corpse and of a landed
  // lane alike; what tells them apart is everything else about them.
  const body: Ink = frozen
    ? ink(hue, 0.95)
    : done
      ? ink(mix(NECROTIC, ICE_200, 0.45), 0.75)
      : plain
        ? ink(mix(ICE_700, ICE_200, 0.35 + 0.65 * freshness), 0.55 + 0.4 * freshness)
        : ink(hue, 0.92)

  marks.push({
    kind: 'path',
    role: 'node',
    laneId,
    alarm,
    d: NODE_LENS,
    at: thread.node,
    size: length,
    // The lens is drawn in a unit square, so its girth is a squash of its
    // length: the same glyph, at every lane's own proportions.
    squash: (0.34 + 0.42 * thread.sizeFrac) * 1.6,
    rotate: angle,
    ink: budget(frame, laneId, alarm, body),
    ...(frozen || done ? { stroke: frozen ? 1.4 : 1 } : {}),
  })

  // Every terminal in this scene ends in a hook.
  marks.push({
    kind: 'path',
    role: 'node-thorn',
    laneId,
    alarm,
    d: THORN_OUT,
    at: {
      x: thread.node.x + Math.cos(angle) * length * 0.5,
      y: thread.node.y + Math.sin(angle) * length * 0.5,
    },
    size: 9,
    rotate: angle,
    ink: budget(frame, laneId, alarm, ink(plain ? mix(ICE_700, ICE_200, freshness) : hue, plain ? 0.6 : 0.9)),
  })

  marks.push(...stateMarks(frame, thread, hue, angle, length))

  // The cartouche: the one enclosure in the instrument, and the same mark the
  // fleet table brackets an alarmed row with (graft g1). Exempt from every fade
  // (graft g2), which is the whole reason a frozen lane — the state *defined* by
  // being old — is not the dimmest thing on the page.
  if (alarm) {
    marks.push({
      kind: 'path',
      role: 'cartouche',
      laneId,
      alarm: true,
      d: CARTOUCHE,
      at: thread.node,
      size: length * 1.9 + 10,
      rotate: angle,
      ink: ink(hue, 0.85),
      stroke: 1.3,
    })
  }

  if (frame.salience.spotlightId === laneId || frame.salience.hoverId === laneId) {
    marks.push(...spotlightMarks(thread, hue, length))
  }

  return marks
}

/** The mark that names the state, in world space around the node. */
function stateMarks(
  frame: SceneFrame,
  thread: ThreadGeometry,
  hue: Rgb,
  angle: number,
  length: number,
): Mark[] {
  const { laneId } = thread

  switch (thread.pathology) {
    case 'expensive':
      return chevronMarks(frame, thread, angle, length)

    case 'looping':
      // A ring at the node echoes the knot tied into the thread: one fault,
      // two marks, so the eye finds it whether it lands on the tip or the line.
      return [
        {
          kind: 'arc',
          role: 'orbit',
          laneId,
          alarm: true,
          at: thread.node,
          radius: length * 0.55 + 5,
          from: 0,
          to: Math.PI * 2,
          width: 1.2,
          ink: ink(hue, 0.6),
        },
      ]

    case 'off-fence':
      // A barb on the lane's own node: this one has a hook out. The reach and
      // the breached fence are drawn at the other end, by `rogueMarks`.
      return [
        {
          kind: 'path',
          role: 'node-thorn',
          laneId,
          alarm: true,
          d: THORN_OUT,
          at: thread.node,
          size: 13,
          rotate: angle - Math.PI / 2,
          ink: ink(hue, 0.95),
        },
      ]

    case 'waiting':
      return handMarks(frame, thread, hue)

    case 'frozen':
      // The cut strokes are on the thread (`thread.ts`) and the node is already
      // hollow: a frozen lane's tip says nothing more, because there is nothing
      // more happening there.
      return []

    default:
      return thread.lane.activity === 'done' ? [sealMark(frame, thread, angle, length)] : []
  }
}

/**
 * EXPENSIVE — cyan chevrons rising off the tip. NOTICE, and therefore non-alarm:
 * they pass through the contrast budget like everything else calm does, which is
 * how a white-hot thread stays structurally unable to out-read a summons (g6).
 */
function chevronMarks(
  frame: SceneFrame,
  thread: ThreadGeometry,
  angle: number,
  length: number,
): Mark[] {
  const out = length * 0.5
  const across: Point = { x: -Math.sin(angle), y: Math.cos(angle) }
  const forward: Point = { x: Math.cos(angle), y: Math.sin(angle) }

  return [0, 1, 2].map((i) => {
    const reach = out + 5 + i * 4.5
    const span = 5.5 - i
    const at = (a: number, c: number): Point => ({
      x: thread.node.x + forward.x * a + across.x * c,
      y: thread.node.y + forward.y * a + across.y * c,
    })
    return {
      kind: 'stroke' as const,
      role: 'chevron' as const,
      laneId: thread.laneId,
      alarm: false,
      width: 1.2,
      // Fainter as they rise: heat leaving, not a fixed ladder of three.
      ink: budget(frame, thread.laneId, false, ink(NOTICE, 0.9 - i * 0.18)),
      points: [at(reach, -span), at(reach + 3.6, 0), at(reach, span)],
    }
  })
}

/**
 * WAITING — the raised hand. Always upright in *screen* space: a hand that
 * pointed along its own thread would aim downward for half the fleet and stop
 * being a hand. Bright, standing, on a thread that is still lit.
 *
 * Under `prefers-reduced-motion` the lift is fixed rather than breathing — the
 * hand is still raised, it just stops waving (ruling 32's degradation).
 */
function handMarks(frame: SceneFrame, thread: ThreadGeometry, hue: Rgb): Mark[] {
  const at = thread.node
  const wave = frame.reducedMotion
    ? 0
    : 2.6 * Math.sin((frame.now / 620) * Math.PI)
  const lift = (HAND_LIFT + wave) * frame.breath
  const wrist: Point = { x: at.x, y: at.y - 5 }
  const palm: Point = { x: at.x, y: at.y - 8.5 - lift }

  return [
    {
      kind: 'glow',
      role: 'held',
      laneId: thread.laneId,
      alarm: true,
      at: { x: at.x, y: at.y - 10 - lift * 0.6 },
      radius: 20,
      ink: ink(hue, 0.16),
    },
    {
      kind: 'stroke',
      role: 'raised-hand',
      laneId: thread.laneId,
      alarm: true,
      points: [wrist, { x: at.x, y: at.y - 5 - lift }],
      width: 3,
      ink: ink(hue, 0.98),
    },
    {
      kind: 'path',
      role: 'raised-hand',
      laneId: thread.laneId,
      alarm: true,
      d: THORN_OUT,
      at: wrist,
      size: 8,
      // The thorn at the wrist anchors the arm to the lane rather than letting
      // it float above one.
      rotate: Math.PI * 0.25,
      ink: ink(hue, 0.8),
    },
    {
      kind: 'path',
      role: 'raised-hand',
      laneId: thread.laneId,
      alarm: true,
      d: PALM,
      at: palm,
      size: 7.6,
      rotate: 0,
      ink: ink(hue, 1),
    },
  ]
}

/** DONE — sealed. A bar across the tip: finished, and not a fault. */
function sealMark(
  frame: SceneFrame,
  thread: ThreadGeometry,
  angle: number,
  length: number,
): Mark {
  const out = length * 0.5 + 2.5
  const across: Point = { x: -Math.sin(angle), y: Math.cos(angle) }
  const base: Point = {
    x: thread.node.x + Math.cos(angle) * out,
    y: thread.node.y + Math.sin(angle) * out,
  }
  return {
    kind: 'stroke',
    role: 'node-seal',
    laneId: thread.laneId,
    alarm: false,
    width: 1.3,
    ink: budget(frame, thread.laneId, false, ink(mix(NECROTIC, ICE_200, 0.5), 0.7)),
    points: [
      { x: base.x - across.x * 4, y: base.y - across.y * 4 },
      { x: base.x + across.x * 4, y: base.y + across.y * 4 },
    ],
  }
}

/**
 * The spotlight's own ring — two hairlines, so the one lane the ladder picked is
 * unmistakably *one object* rather than merely the brightest. Never faded: it is
 * the mark that says where the light went.
 */
function spotlightMarks(thread: ThreadGeometry, hue: Rgb, length: number): Mark[] {
  const radius = length * 1.5 + 8
  return [0, 5].map((offset) => ({
    kind: 'arc' as const,
    role: 'spotlight' as const,
    laneId: thread.laneId,
    alarm: thread.alarm,
    at: thread.node,
    radius: radius + offset,
    from: 0,
    to: Math.PI * 2,
    width: offset === 0 ? 1.4 : 1,
    ink: ink(hue, offset === 0 ? 0.75 : 0.22),
  }))
}

/**
 * THE NAMES (ruling 31). Every lane is named up to {@link LABELS_ALL_MAX}; past
 * it only the hovered, spotlit and alarmed lanes are, which is the recorded
 * cheap retreat. Lanes are never hidden — that stayed off the table.
 */
export function labelMarks(frame: SceneFrame, thread: ThreadGeometry): Mark[] {
  const { laneId, lane } = thread
  const spotlit = frame.salience.spotlightId === laneId || frame.salience.hoverId === laneId

  if (frame.geometry.labelPolicy === 'hover' && !spotlit && !thread.alarm) return []

  const { anchor, align } = thread.label
  const flagged = thread.pathology !== null
  const hue = hueOf(thread)
  const marks: Mark[] = []

  // A name is a name, so it is sans (law 11) — and the figure below it is data,
  // so that one is mono with tabular numerals.
  const name = lane.label
  const y = anchor.y - 5

  if (spotlit) {
    // A plate behind the winner's name, so it survives whatever it lands on.
    const width = name.length * 5.9 + 10
    marks.push({
      kind: 'chip',
      role: 'label-chip',
      laneId,
      alarm: thread.alarm,
      at: {
        x: align === 'left' ? anchor.x - 4 : align === 'right' ? anchor.x - width + 4 : anchor.x - width / 2,
        y: y - 8,
      },
      width,
      height: 16,
      fill: ink(ICE_950, 0.88),
      border: ink(hue, 0.5),
    })
  }

  marks.push({
    kind: 'text',
    role: 'label',
    laneId,
    alarm: thread.alarm,
    at: { x: anchor.x, y },
    text: name,
    font: 'sans',
    size: 10.5,
    weight: flagged ? 700 : 500,
    align,
    ink: budget(
      frame,
      laneId,
      thread.alarm,
      ink(flagged ? hue : mix(ICE_700, ICE_200, 1 - thread.ageFrac), flagged ? 0.98 : 0.7),
    ),
  })

  marks.push({
    kind: 'text',
    role: 'label-figure',
    laneId,
    alarm: false,
    at: { x: anchor.x, y: y + 11 },
    text: formatTokens(lane.outputTokens),
    font: 'mono',
    size: 10,
    weight: 400,
    align,
    ink: budget(frame, laneId, false, ink(ICE_400, 0.75)),
  })

  return marks
}

/** A lane's hue: its fault when it has one, else its rung. Never its identity. */
export function hueOf(thread: ThreadGeometry): Rgb {
  return thread.pathology === null
    ? RANK_HUE[thread.lane.rank]
    : PATHOLOGY_HUE[thread.pathology]
}

/** The palm of the raised hand: a filled disc, in the same unit space. */
const PALM = 'M0.16 0.5A0.34 0.34 0 1 0 0.84 0.5A0.34 0.34 0 1 0 0.16 0.5Z'
