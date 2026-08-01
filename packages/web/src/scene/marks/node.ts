import { formatTokens } from '../../lib/format.js'
import type { LadderRank, PathologyKind } from '../../fleet/index.js'
import { tangentAt, type Point, type RetireGeometry, type ThreadGeometry } from '../geometry.js'
import { alarmPulse } from '../motion.js'
import {
  ACTIVITY_HUE,
  BROKEN,
  ICE_100,
  ICE_200,
  ICE_300,
  ICE_500,
  ICE_600,
  ICE_950,
  NEEDS_YOU,
  NOTICE,
  hotter,
  incandescent,
  ink,
  mix,
  type Ink,
  type Rgb,
} from '../palette.js'
import { SCAR, toward } from '../retire.js'
import { blobRing, variationFor, variationSeed } from '../variation.js'
import { budget, motionMode, summonsAgeMs, type SceneFrame } from './frame.js'
import { NODE_LENS, THORN_OUT } from './glyphs.js'
import { regionMark, ribbonMark, type Mark, type MarkRole } from './types.js'

/**
 * THE NODES — where a lane's thread ends, and where its state is legible.
 *
 * A node is a lens, not a bead: pointed at both ends, lying along its own
 * thread, with a thorn curl off the outer tip (ruling 23). Its size is the
 * lane's work, its fill is its freshness, and its *behaviour* is its state —
 * which is the difference between this scene and a chart with coloured dots.
 *
 * The five pathologies are behaviours of the thread and its tip, and each is
 * built so it survives greyscale (law 9a's "colour is never the sole carrier").
 *
 * This is the one table in the scene where the two vocabularies meet, and the
 * split down the middle is the point (prd7 ruling 2): the **roles** are what the
 * laws in `marks.test.ts` are written in and are not allowed to change when the
 * picture does; the **form** is this file's answer today, and is free to.
 *
 * | state     | roles it emits            | form, today                    | hue   |
 * | --------- | ------------------------- | ------------------------------ | ----- |
 * | LOOPING   | `looping-mark`, `orbit`   | knot, light going round it     | amber |
 * | FROZEN    | `severed`                 | the ribbon pinched shut, twice | red   |
 * | WAITING   | `summons`, `held`         | raised hand, light stopped     | amber |
 * | EXPENSIVE | `expensive-mark`, `heat`  | needled tip, licks coming off  | cyan  |
 * | OFF-FENCE | `off-fence-*` (four)      | barb, reach, breached arc      | amber |
 *
 * Three of those cells were rewritten by prd7 ruling 3 and the left-hand column
 * did not move an inch, which is the whole return on ruling 2.
 *
 * A lane with none of them is no longer hueless. Under prd4's law 9a its node
 * takes its **activity's** colour — green while working, dim green once landed,
 * muted amber while stopped, ice when idle or unread — so the picture answers
 * "what is the fleet doing?" before anyone has learned the alphabet. What
 * separates it from a summons is the band (law 9b), not the absence of colour.
 *
 * FROZEN and WAITING are the pair the prd says must never be confusable, so
 * they are opposed on three axes at once: **dark vs light** (a dead thread and a
 * lit one), **broken vs continuous** (dashed vs whole), and **severed vs
 * summoning** (a line cut through vs a lane asking for a human). The third axis
 * is the one that used to be stated as "cut vs raised", which was the drawing
 * describing itself; the two states have to stay distinguishable however either
 * is drawn. `marks.test.ts` asserts all three, so no future tuning can quietly
 * collapse one of them.
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

/** How much of its hue a node's lens keeps once its lane has aged all the way out. */
const LENS_HUE_FLOOR = 0.45

/** How far a raised hand stands off its node. Tall enough to clear the label. */
const HAND_LIFT = 15

export function nodeMarks(frame: SceneFrame, thread: ThreadGeometry): Mark[] {
  if (thread.retire !== null) return scarNodeMarks(frame, thread, thread.retire)

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

  const tint = lensTint(hue, freshness)

  // The lens. Hollow for a frozen lane and for a finished one — an outline is
  // "no longer filling with work", which is true of a corpse and of a landed
  // lane alike; what tells them apart is everything else about them, starting
  // with the hue: dead is red, landed is the working green gone quiet.
  const body: Ink = frozen
    ? ink(hue, 0.95)
    : done
      ? ink(hue, 0.85)
      : plain
        ? ink(tint, 0.6 + 0.35 * freshness)
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

  // Where the thread stops, and it stops deliberately: every terminal in this
  // scene ends in a hook rather than trailing off (ruling 23).
  marks.push({
    kind: 'path',
    role: 'node-tip',
    laneId,
    alarm,
    d: THORN_OUT,
    at: {
      x: thread.node.x + Math.cos(angle) * length * 0.5,
      y: thread.node.y + Math.sin(angle) * length * 0.5,
    },
    size: 9,
    rotate: angle,
    ink: budget(frame, laneId, alarm, ink(plain ? tint : hue, plain ? 0.75 : 0.9)),
  })

  marks.push(...stateMarks(frame, thread, hue, angle, length))

  if (alarm) marks.push(enclosureMark(thread, hue))

  if (frame.salience.spotlightId === laneId || frame.salience.hoverId === laneId) {
    marks.push(...spotlightMarks(thread, hue, length))
  }

  return marks
}

/**
 * A plain lane's lens hue, dimmed toward ice as the lane ages — recency in the
 * same channel the thread reads it in, so a fresh green node and a stale one are
 * the same colour at two temperatures rather than two colours. Never mixed all
 * the way to ice: a lane that worked an hour ago still worked.
 */
function lensTint(hue: Rgb, freshness: number): Rgb {
  return mix(ICE_600, hue, LENS_HUE_FLOOR + (1 - LENS_HUE_FLOOR) * freshness)
}

/**
 * THE SCAR'S OWN MARK (prd5 ruling 3) — what is left at the rim.
 *
 * Deliberately the *same three marks* a landed lane already wore — hollow lens,
 * outward thorn, and the knot it was tied off with — at the same inks the
 * instant the cut begins, and desaturating into `SCAR.glyph` over the settle.
 * (The knot was a seal bar before prd7 ruling 3; the continuity claim is what
 * matters and it is unchanged, because both ends of it moved together.) That
 * continuity is the whole
 * point of splitting the stages by channel: the tension release changes the
 * thread's curvature and *nothing else*, so there is no pop at the tip to
 * distract from the one thing that is happening.
 *
 * Two things are taken away, and both are the same statement:
 *
 * - **it does not breathe.** The lens's size loses `frame.breath` entirely. The
 *   ambient layer is the scene being alive, and this lane is not.
 * - **it gets smaller.** A third off, over the settle — "a small desaturated
 *   mark near the rim" — while keeping its work-size in what is left, so a big
 *   landing scars bigger than a small one.
 *
 * No cartouche and no state mark: a scar cannot be an alarm, because a lane
 * nobody can act on has nothing to summon anybody for. The spotlight ring stays,
 * because an operator may still click a scar to read it — hidden ≠ gone applies
 * to the *toggle*, and pointing at one has never been hiding it.
 */
function scarNodeMarks(frame: SceneFrame, thread: ThreadGeometry, cut: RetireGeometry): Mark[] {
  if (cut.hidden) return []

  const { laneId } = thread
  const along = tangentAt(thread.path, 1)
  const angle = Math.atan2(along.y, along.x)
  const hue = hueOf(thread)
  const freshness = 1 - thread.ageFrac
  const length = (9 + 9 * thread.sizeFrac) * (1 - 0.35 * cut.scar)

  const cold = (living: Ink): Ink =>
    budget(frame, laneId, false, toward(living, SCAR.glyph, cut.scar))

  const marks: Mark[] = [
    {
      kind: 'path',
      role: 'scar-mark',
      laneId,
      alarm: false,
      d: NODE_LENS,
      at: thread.node,
      size: length,
      squash: (0.34 + 0.42 * thread.sizeFrac) * 1.6,
      rotate: angle,
      ink: cold(ink(hue, 0.85)),
      // Hollow, exactly as a landed lane's lens already is: an outline is "no
      // longer filling with work", and that has only become more true.
      stroke: 1,
    },
    {
      kind: 'path',
      role: 'scar-mark',
      laneId,
      alarm: false,
      d: THORN_OUT,
      at: {
        x: thread.node.x + Math.cos(angle) * length * 0.5,
        y: thread.node.y + Math.sin(angle) * length * 0.5,
      },
      size: 9,
      rotate: angle,
      ink: cold(ink(lensTint(hue, freshness), 0.75)),
    },
    knotMark('scar-mark', thread, angle, length, cold(ink(ACTIVITY_HUE.done, 0.9))),
  ]

  if (frame.salience.spotlightId === laneId || frame.salience.hoverId === laneId) {
    marks.push(...spotlightMarks(thread, hue, length))
  }

  return marks
}

/**
 * THE ENCLOSURE (prd7 ruling 3) — a lane above calm is bracketed, and a calm one
 * never is.
 *
 * That statement is unchanged from prd3: it is the same claim the fleet table
 * makes when it brackets an alarmed row (graft g1), and it is exempt from every
 * fade (graft g2), which is the whole reason a frozen lane — the state *defined*
 * by being old — is not the dimmest thing on the page.
 *
 * What changed is that it stopped being a cartouche. Two things were wrong with
 * the ring: it was a struck circle in a picture of grown things, and it sat at
 * the node, where it competed with the state mark it was supposed to frame. It
 * is now a **midpoint-displaced blob behind the lane's name** — Hobbs'
 * subdivision, seeded off the lane so no two enclosures are the same shape — and
 * it does its job better for having moved, because the thing an operator needs
 * bracketed at a glance is *which lane*, and the answer to that is the name.
 *
 * Low alpha and drawn a layer under the label (`marks/index.ts` puts nodes
 * before names), so it grounds the text rather than shouting over it. Enclosure
 * is the signal; nothing about it was ever circular.
 */
function enclosureMark(thread: ThreadGeometry, hue: Rgb): Mark {
  const { anchor, align } = thread.label
  // The block the name and its figure occupy — roughly, and roughly is right: a
  // blob has no edge to line up with anyway.
  const width = thread.lane.label.length * 5.9 + 16
  const centre: Point = {
    x: align === 'left' ? anchor.x + width / 2 - 5 : align === 'right' ? anchor.x - width / 2 + 5 : anchor.x,
    y: anchor.y + 1,
  }

  return regionMark({
    role: 'rank-enclosure',
    laneId: thread.laneId,
    alarm: true,
    ring: blobRing(centre, width / 2, 15, variationSeed(thread.lane)),
    paint: ink(hue, 0.14),
  })
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
      return expensiveMarks(frame, thread, angle, length)

    case 'looping':
      // Nothing at the tip. The fault is the knot tied into the thread and the
      // light going round it, and both are already drawn there — a third amber
      // ring at the node only crowds the two marks that carry the meaning.
      return []

    case 'off-fence':
      // The offender's own marking — `off-fence-mark`, and the only one of the
      // four the *offender* wears. Drawn as a barb: this one has a hook out. The
      // reach, its grasp and the breached boundary are all at the other end of
      // the fact, by `offFenceMarks`.
      //
      // Incandescent, so an off-fence lane clears `ALARM_FLOOR` the way a knot
      // and a raised hand do — every needs-you lane owes the band one mark inside
      // it, and for this pathology this is that mark.
      return [
        {
          kind: 'path',
          role: 'off-fence-mark',
          laneId,
          alarm: true,
          d: THORN_OUT,
          at: thread.node,
          size: 13,
          rotate: angle - Math.PI / 2,
          ink: ink(incandescent(hue), 0.98),
        },
      ]

    case 'waiting':
      return summonsMarks(frame, thread, hue)

    case 'frozen':
      // The cut strokes are on the thread (`thread.ts`) and the node is already
      // hollow: a frozen lane's tip says nothing more, because there is nothing
      // more happening there.
      return []

    default:
      return thread.lane.activity === 'done'
        ? [
            knotMark(
              'done-mark',
              thread,
              angle,
              length,
              budget(frame, laneId, false, ink(ACTIVITY_HUE.done, 0.9)),
            ),
          ]
        : []
  }
}

/**
 * EXPENSIVE — heat coming off the tip (prd7 ruling 3).
 *
 * The chevrons are gone. Three arrowheads stacked over a node were the scene at
 * its most drafted: a fixed ladder of identical glyphs, legible only within a
 * few pixels of one point, saying "outward" about a thread whose direction is
 * already the most obvious thing on it. Substituted for **tapers** — the burning
 * thread itself now draws down to a needle over its last fifth (`thread.ts`'s
 * `HEAT_TAPER`), and these three are the licks leaving it: short ribbons, thick
 * where they part from the tip and needled to nothing, each curling a little on
 * the lane's own free phase so no two lanes exhale alike.
 *
 * The law they answer is unchanged, and it was never the count: the marking
 * *rises away* from the node and *fades as it goes*, which is what makes it read
 * as heat leaving rather than as a fixed ladder of three.
 *
 * NOTICE, and therefore non-alarm: they pass through the contrast budget like
 * everything else calm does, which is how a white-hot thread stays structurally
 * unable to out-read a summons (g6).
 */
function expensiveMarks(
  frame: SceneFrame,
  thread: ThreadGeometry,
  angle: number,
  length: number,
): Mark[] {
  const out = length * 0.5
  const across: Point = { x: -Math.sin(angle), y: Math.cos(angle) }
  const forward: Point = { x: Math.cos(angle), y: Math.sin(angle) }
  // Free channel: which way the licks lean is a habit, and habits carry nothing.
  const lean = (variationFor(variationSeed(thread.lane)).curl - 0.5) * 2

  return [0, 1, 2].map((i) => {
    const reach = out + 5 + i * 4.5
    const side = i % 2 === 0 ? 1 : -1
    const at = (along: number, sideways: number): Point => ({
      x: thread.node.x + forward.x * along + across.x * sideways,
      y: thread.node.y + forward.y * along + across.y * sideways,
    })

    return ribbonMark({
      role: 'expensive-mark',
      laneId: thread.laneId,
      alarm: false,
      path: [
        at(reach, 0),
        at(reach + 2.6, side * (0.8 + lean)),
        at(reach + 5.2, side * (2.4 + lean * 2)),
      ],
      widthRoot: 2.4 - i * 0.45,
      widthTip: 0.3,
      taperTip: 0.45,
      samples: 10,
      // Fainter as they rise: heat leaving, not a fixed ladder of three.
      paint: budget(frame, thread.laneId, false, ink(NOTICE, 0.9 - i * 0.18)),
    })
  })
}

/**
 * WAITING — the raised hand. Always upright in *screen* space: a hand that
 * pointed along its own thread would aim downward for half the fleet and stop
 * being a hand. Bright, standing, on a thread that is still lit.
 *
 * The wave ages with the summons (ruling 5): the longer nobody comes, the slower
 * and the brighter it goes. A hand that waved *faster* the longer it was ignored
 * would read as panic, and the fleet is not panicking — it is waiting, and it
 * has been waiting a while.
 *
 * Under `prefers-reduced-motion` and under pause the lift is fixed rather than
 * breathing — the hand is still raised, it just stops waving (ruling 32's
 * degradation, now stated once for every alarm mark in `motion.ts`).
 */
function summonsMarks(frame: SceneFrame, thread: ThreadGeometry, hue: Rgb): Mark[] {
  const at = thread.node
  const pulse = alarmPulse(summonsAgeMs(frame, thread), motionMode(frame))
  const wave = 2.6 * (pulse.throb * 2 - 1)
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
      // The halo is where the aging is spent. The palm above it does not move:
      // it is the mark that owes the alarm band its floor, and a summons that
      // dimmed while it was young would be lying about which band it is in.
      ink: ink(hue, 0.16 * pulse.intensity),
    },
    ribbonMark({
      role: 'summons',
      laneId: thread.laneId,
      alarm: true,
      path: [wrist, { x: at.x, y: at.y - 5 - lift }],
      // A ribbon, tapering, rather than a 3px stroke: the arm is the lane's own
      // substance standing up, and it is the one place in the scene where a
      // constant-width line would still be visible next to everything that
      // stopped being one (ruling 3).
      widthRoot: 3.2,
      widthTip: 2.1,
      samples: 6,
      // The arm is lifted a little off full saturation so it stays clear of the
      // calm ceiling the fleet around it now reaches; the palm above it is what
      // goes all the way to `ALARM_FLOOR`.
      paint: ink(hotter(hue, 0.2), 0.98),
    }),
    {
      kind: 'path',
      role: 'summons',
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
      role: 'summons',
      laneId: thread.laneId,
      alarm: true,
      d: PALM,
      at: palm,
      size: 7.6,
      rotate: 0,
      // The palm is the summons: the one mark of a waiting lane that reaches the
      // band above the calm ceiling (`ALARM_FLOOR`).
      ink: ink(incandescent(hue), 1),
    },
  ]
}

/**
 * DONE — tied off (prd7 ruling 3).
 *
 * It was a bar struck across the tip: a second vocabulary — flat, geometric,
 * borrowed from wax seals — for a fact about a growing thing. It is now a
 * **knot**: the thread's own substance carried past the node, wrapped once and
 * drawn to nothing, distinguished from every other terminal by hue alone. Same
 * mark, same role, same green; no new shape entered the scene, and one left it.
 *
 * It wears the done green rather than a neutral, so "landed" is one reading of
 * one hue (hollow lens + knot + dim green) instead of a grey mark a viewer has
 * to be told about.
 */
function knotMark(
  role: MarkRole,
  thread: ThreadGeometry,
  angle: number,
  length: number,
  paint: Ink,
): Mark {
  return ribbonMark({
    role,
    laneId: thread.laneId,
    alarm: false,
    path: knotSpine(thread.node, angle, length),
    // Thick where it leaves the node and drawn to nothing round the far side:
    // a cord tied off, not a ring drawn round something.
    widthRoot: 1.9,
    widthTip: 0.35,
    taperTip: 0.3,
    samples: 20,
    paint,
  })
}

/**
 * Where the knot is tied: just past the tip, wrapped a little more than once so
 * the cord crosses its own back. The overlap is what makes it a knot rather than
 * a loop — and it costs nothing, because one filled polygon self-overlapping is
 * still one fill.
 */
function knotSpine(node: Point, angle: number, length: number): Point[] {
  const radius = 3.4
  const out = length * 0.5 + radius * 0.9
  const centre: Point = { x: node.x + Math.cos(angle) * out, y: node.y + Math.sin(angle) * out }

  const turns = Math.PI * 2.35
  const steps = 12
  return Array.from({ length: steps + 1 }, (_unused, i) => {
    const theta = angle + Math.PI + (i / steps) * turns
    // Spiralling in as it goes round, so the wrap tucks under itself.
    const r = radius * (1 - 0.28 * (i / steps))
    return { x: centre.x + Math.cos(theta) * r, y: centre.y + Math.sin(theta) * r }
  })
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
  if (thread.retire?.hidden === true) return []

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

  // A name is not a state, so an unflagged lane's name stays ice — the hue
  // belongs to the node beside it. What changed in prd4 is only how bright: the
  // old ramp bottomed out at `ICE_700`, where a stale lane's name was effectively
  // unreadable against the void.
  const living = ink(
    flagged ? hue : mix(ICE_500, ICE_100, 1 - thread.ageFrac),
    flagged ? 0.98 : 0.85,
  )

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
    // A scar's name recedes to `SCAR.name` and stops there. It has to stay
    // readable: the whole reason a retired lane is still drawn is so the operator
    // can tell *which* lane retired, and a name too dim to read has deleted it
    // while pretending not to.
    ink: budget(
      frame,
      laneId,
      thread.alarm,
      thread.retire === null ? living : toward(living, SCAR.name, thread.retire.scar),
    ),
  })

  // The figure is **kept**, at full label brightness, scar or not. What a lane
  // produced is not diminished by its having finished, and the one number a
  // retired lane is still worth reading is how much work came out of it.
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
    ink: budget(frame, laneId, false, ink(ICE_300, 0.85)),
  })

  return marks
}

/**
 * A lane's hue: its fault when it has one, else what it is *doing*. Never its
 * identity — no lane gets a colour for being itself (law 9a).
 *
 * The activity branch is prd4's amendment. A pathology-free lane used to be
 * `ICE_200` whatever it was up to, which is what made a busy fleet and a dead
 * one look alike at a glance. `ACTIVITY_HUE` in `palette.ts` is the only place
 * that mapping lives, so `marks/` still names no colour of its own.
 *
 * `RANK_HUE` survives for the case the activity map cannot speak to: a lane
 * ranked above calm with no pathology attached to say why.
 */
function hueOf(thread: ThreadGeometry): Rgb {
  if (thread.pathology !== null) return PATHOLOGY_HUE[thread.pathology]
  return thread.lane.rank === 'calm'
    ? ACTIVITY_HUE[thread.lane.activity]
    : RANK_HUE[thread.lane.rank]
}

/** The palm of the raised hand: a filled disc, in the same unit space. */
const PALM = 'M0.16 0.5A0.34 0.34 0 1 0 0.84 0.5A0.34 0.34 0 1 0 0.16 0.5Z'
