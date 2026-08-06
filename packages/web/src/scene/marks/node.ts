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
  TUFT_WASH,
  clamp01,
  hotter,
  incandescent,
  ink,
  mix,
  type Ink,
  type Rgb,
} from '../palette.js'
import { PERSIST, toward } from '../retire.js'
import { TIP_GLOW_RADIUS, spendTip } from '../salience.js'
import { blobRing, variationFor, variationSeed } from '../variation.js'
import { budget, motionMode, summonsAgeMs, type SceneFrame } from './frame.js'
import { NODE_LENS, THORN_OUT } from './glyphs.js'
import { regionMark, ribbonMark, type Mark, type MarkRole, type RibbonMark } from './types.js'

/**
 * THE NODES — where a lane's thread ends, and where its state is legible.
 *
 * A node is a lens, not a bead: pointed at both ends, lying along its own
 * thread, with a thorn curl off the outer tip (ruling 23). Its size is the
 * lane's work, its fill is its freshness, and its *behaviour* is its state.
 *
 * The five pathologies are behaviours of the thread and its tip, and each
 * must survive greyscale (law 9a's "colour is never the sole carrier").
 *
 * The **roles** each pathology emits are what the laws in `marks.test.ts` are
 * written in and must not change when the picture does; the **form** below
 * is this file's answer today, and is free to (prd7 ruling 2).
 *
 * A lane with none of them takes its **activity's** colour under law 9a
 * (green while working, dim green once landed, muted amber while stopped,
 * ice when idle or unread) — never its identity. What separates it from a
 * summons is the band (law 9b), not the absence of colour.
 *
 * FROZEN and WAITING must never be confusable, so they are opposed on three
 * axes at once: **dark vs light**, **broken vs continuous**, and **severed
 * vs summoning**. `marks.test.ts` asserts all three, so no future tuning can
 * quietly collapse one of them.
 *
 * See docs/design-notes/node-role-shape-split.md for the full role/form table
 * and the third axis's naming history.
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

/**
 * A LENS'S LENGTH, from the lane's work — the same absolute scale everything
 * else on this lane is drawn on (prd6 ruling 1). `5 + 14 · size` spends the
 * whole encoding range on screen; see docs/design-notes/node-lens-length-scale.md
 * for the #117 history of the formula this replaced.
 *
 * Shared by the living node and the finished one it becomes, so nothing pops
 * at the tip when a cord parts — the marks at the node must not change at the
 * moment the thread does.
 */
function lensLength(sizeFrac: number): number {
  return 5 + 14 * sizeFrac
}

export function nodeMarks(frame: SceneFrame, thread: ThreadGeometry): Mark[] {
  if (thread.retire !== null) return persistNodeMarks(frame, thread, thread.retire)

  const marks: Mark[] = []
  const { laneId, lane } = thread
  const along = tangentAt(thread.path, 1)
  const angle = Math.atan2(along.y, along.x)
  const hue = hueOf(thread)
  const alarm = thread.alarm

  const length = lensLength(thread.sizeFrac) * frame.breath
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

  marks.push(...tuftMarks(frame, thread, hue, angle, length))
  marks.push(...stateMarks(frame, thread, hue, angle, length))

  if (alarm) marks.push(enclosureMark(thread, hue))

  if (frame.salience.spotlightId === laneId || frame.salience.hoverId === laneId) {
    marks.push(...spotlightMarks(thread, hue, length))
  }

  return marks
}

/**
 * APICAL TUFTS (prd10 ruling 4) — a growing tip is a growth cone, not a full
 * stop. A **working** lane's tip splits into two or three fine branchlets; a
 * lane that is not working keeps the thorn alone. Branchlet count, reach and
 * light each read off a fact the lane already carries rather than a number
 * invented for the mark — see {@link branchlets}.
 *
 * The glow is the 9b amendment and the only calm mark in the instrument
 * permitted past `CALM_CEILING`. Its bounds are `salience.ts`'s
 * (`TIP_CEILING`, `TIP_GLOW_RADIUS`) rather than this file's, and `spendTip`
 * is the only door: it recedes like every other calm mark, so a summons
 * anywhere still owns the band.
 *
 * See docs/design-notes/node-apical-tuft-glow.md for why, and for the landing
 * flare's law.
 */
function tuftMarks(
  frame: SceneFrame,
  thread: ThreadGeometry,
  hue: Rgb,
  angle: number,
  length: number,
): Mark[] {
  const cut = thread.retire
  // THE LANDING FLARE (ruling 4): the *whole* of what a finishing lane's apex
  // does — the branchlets blaze once and go out as the vitality leaves.
  // Deliberately not a glow: no glow is ever drawn on a retiring lane ("matter,
  // not light"), and the 9b amendment's glow stays scoped to a **working** tip
  // and nothing else. See docs/design-notes/node-apical-tuft-glow.md.
  if (cut !== null) {
    if (cut.hidden || cut.withdraw >= 1) return []
    return branchlets(frame, thread, hue, angle, length, {
      // Fast in over the tension, out over the withdraw — `EVENT`'s own shape, read
      // off the return's own stages rather than off a clock of its own.
      strength: 1 - cut.withdraw,
      flare: cut.tension * (1 - cut.withdraw),
      glow: false,
    })
  }

  // Otherwise: only a *growing* tip. A waiting lane's apex is not growing, a landed
  // one's has stopped and a frozen one's is dead — each of those has its own
  // vocabulary at the node already, and a tuft on top of it would be a second claim.
  if (thread.lane.activity !== 'working' || thread.pathology !== null) return []

  return branchlets(frame, thread, hue, angle, length, {
    strength: 1,
    flare: 0,
    glow: true,
  })
}

interface Tuft {
  /** How much of the tuft is there at all — 1 while growing, out over a cut. */
  strength: number
  /** The landing's once-only brightening, 0–1. */
  flare: number
  /** Whether this apex carries the 9b amendment's glow. Working tips only. */
  glow: boolean
}

function branchlets(
  frame: SceneFrame,
  thread: ThreadGeometry,
  hue: Rgb,
  angle: number,
  length: number,
  tuft: Tuft,
): Mark[] {
  const { laneId } = thread
  const habit = variationFor(variationSeed(thread.lane))
  const branchlets = habit.phase < 0.45 ? 2 : 3
  const forward: Point = { x: Math.cos(angle), y: Math.sin(angle) }
  const across: Point = { x: -Math.sin(angle), y: Math.cos(angle) }
  const at = (along: number, sideways: number): Point => ({
    x: thread.node.x + forward.x * along + across.x * sideways,
    y: thread.node.y + forward.y * along + across.y * sideways,
  })

  // Vivid: the family hue at its live end rather than the aged tint the lens
  // wears — the apex is the newest part of the organism, so this is the one
  // mark on a lane whose brightness is not its age. This is also where a
  // commit is legible, not in the glow below (the calm-to-tip band is only
  // three hundredths wide, so the branchlets carry the arrival instead).
  // `TUFT_WASH` (#157) is deliberately the smallest of the three terms here,
  // given back in alpha so `budget()` still holds the pair under
  // `CALM_CEILING`. See docs/design-notes/node-apical-tuft-glow.md.
  const arriving = clamp01(frame.field.energyOf(laneId).inbound / 1.4)
  const vivid = ink(
    hotter(hue, TUFT_WASH + 0.35 * arriving + 0.4 * tuft.flare),
    clamp01(tuft.strength) * (1 + 0.1 * tuft.flare),
  )
  const base = length * 0.46
  const reach = length * (0.42 + 0.3 * habit.curl) * clamp01(0.55 + 0.45 * tuft.strength)

  const marks: Mark[] = []
  for (let i = 0; i < branchlets; i += 1) {
    // Splayed about the thread's own direction, unevenly: a fan of equal angles is
    // a diagram of a growth cone rather than one.
    const spread = ((i - (branchlets - 1) / 2) / Math.max(1, branchlets - 1)) * 2
    const lean = spread * (0.5 + 0.4 * habit.curl)
    marks.push(
      ribbonMark({
        role: 'tuft',
        laneId,
        alarm: false,
        path: [
          at(base, 0),
          at(base + reach * 0.55, lean * reach * 0.3),
          at(base + reach, lean * reach * 0.62 + (0.2 - 0.4 * habit.phase) * reach * 0.2),
        ],
        // Off the thread's own tip width: a branchlet leaves the apex at the width
        // the thread arrived at, and needles away to nothing.
        widthRoot: Math.max(0.8, thread.widthTip * 0.85),
        widthTip: 0.15,
        taperTip: 0.6,
        samples: 8,
        caps: false,
        paint: budget(frame, laneId, false, vivid),
      }),
    )
  }

  if (!tuft.glow) return marks

  // THE AMENDMENT: a small steady glow at the apex, above the calm ceiling and
  // below the alarm floor. Brightness is the lane's own decaying `inbound`
  // energy — only a real `commit.landed` ever raises it (`pulses.ts`) — and it
  // decays over about one agent turn, on no clock of its own.
  const lit = clamp01(TIP_LIGHT.floor + TIP_LIGHT.commit * arriving)
  marks.push({
    kind: 'glow',
    role: 'tuft-glow',
    laneId,
    alarm: false,
    at: at(base + reach * 0.7, 0),
    // Small, and *fixed* small: the radius is a bound (`TIP_GLOW_RADIUS`), not a
    // channel. A tip glow that grew with anything would be spending the band.
    radius: TIP_GLOW_RADIUS,
    ink: spendTip(ink(hotter(hue, 0.5), lit), frame.salience, laneId),
  })

  return marks
}

/**
 * How bright a working apex sits, and how much of that a commit buys. The
 * floor must clear `CALM_CEILING` on its own — a small **steady** glow — and
 * `spendTip` caps the pair at `TIP_CEILING` regardless, so the commit term
 * stays small: the visible response to an arrival is the branchlets above.
 * See docs/design-notes/node-apical-tuft-glow.md.
 */
const TIP_LIGHT = { floor: 0.95, commit: 0.05 } as const

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
 * THE FINISHED LANE'S NODE (prd10 rulings 13–15) — what stands at the far end
 * of a persistent strand: the same three marks a landed lane wears (hollow
 * lens, tail, seal) at the same inks the instant the return begins, cooling
 * into `PERSIST.glyph` over the settle. Only the strand's curvature changes at
 * the cut, so there is no pop at the tip to distract from what's happening.
 *
 * Ruling 14's hierarchy holds at the node too, matching the thinning the
 * strand itself takes:
 *
 * - **it does not breathe.** The lens's size loses `frame.breath` entirely —
 *   the ambient layer is the scene being alive, and this lane is not.
 * - **it gets smaller.** A third off, over the settle, while keeping its
 *   work-size in what is left, so a big landing rests bigger than a small one.
 *
 * No cartouche and no state mark: a finished lane cannot be an alarm, because
 * a lane nobody can act on has nothing to summon anybody for. The spotlight
 * ring stays — hidden ≠ gone applies to the *toggle*, and pointing at one has
 * never been hiding it.
 *
 * See docs/design-notes/node-persist-lane.md for why all three marks now stay
 * permanently rather than being gated on composting, and for the curl glyph's
 * removal (#117).
 */
/**
 * THE TAIL AND THE SEAL, CACHED (#178 — the same finding as `marks/thread.ts`'s
 * `persistRibbon`, at the node instead of the strand). Both are `ribbonMark`s,
 * so both pay a `ribbonOutline` resample-and-offset every call; once a lane is
 * settled neither's *geometry* can change (`angle` and `length` below are
 * functions of `thread.path`, `thread.sizeFrac` and `cut.stilled`, and the last
 * of those is pinned at 1 for the rest of the session), so both are worth
 * exactly one build. Keyed on `thread.path`'s identity for the same reason
 * `persistRibbon` is: `geometry.ts` only hands out a stable `path` reference
 * once `dissolve >= 1`, so this cache is warm exactly when it is safe to be and
 * never needs its own copy of that gate.
 *
 * The placeholder `PERSIST.glyph` passed to `tailMark`/`sealMark` here is never
 * read back — the call site overwrites `.paint` on every frame, because
 * `budget()` is salience-live in exactly the way the outline is not (see
 * `persistRibbon`'s header for the fuller argument).
 */
const PERSIST_NODE_RIBBON_CACHE = new WeakMap<
  readonly Point[],
  { tail: RibbonMark; seal: RibbonMark }
>()

function persistNodeRibbons(
  thread: ThreadGeometry,
  angle: number,
  length: number,
): { tail: RibbonMark; seal: RibbonMark } {
  const known = PERSIST_NODE_RIBBON_CACHE.get(thread.path)
  if (known !== undefined) return known
  const built = {
    tail: tailMark('persist-mark', thread, angle, length, PERSIST.glyph),
    seal: sealMark('persist-mark', thread, angle, length, PERSIST.glyph),
  }
  PERSIST_NODE_RIBBON_CACHE.set(thread.path, built)
  return built
}

function persistNodeMarks(frame: SceneFrame, thread: ThreadGeometry, cut: RetireGeometry): Mark[] {
  if (cut.hidden) return []

  const { laneId } = thread
  const along = tangentAt(thread.path, 1)
  const angle = Math.atan2(along.y, along.x)
  const hue = hueOf(thread)
  const freshness = 1 - thread.ageFrac
  const length = lensLength(thread.sizeFrac) * (1 - 0.35 * cut.stilled)

  const cold = (living: Ink): Ink =>
    budget(frame, laneId, false, toward(living, PERSIST.glyph, cut.stilled))

  const marks: Mark[] = [
    {
      kind: 'path',
      role: 'persist-mark',
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
  ]

  // THE APEX'S LAST ACT (prd10 ruling 4) — the tuft flares once as the lane
  // finishes, and is out by the time its vitality is home.
  marks.push(...tuftMarks(frame, thread, hue, angle, length))

  // The tail and the seal, permanently. The lens above, the name and the figure
  // (`labelMarks`) and these two are what say *which* lane this was — and under
  // ruling 13 the strand behind them says it too.
  const ribbons = persistNodeRibbons(thread, angle, length)
  marks.push(
    { ...ribbons.tail, paint: cold(ink(lensTint(hue, freshness), 0.75)) },
    { ...ribbons.seal, paint: cold(ink(ACTIVITY_HUE.done, 0.9)) },
  )

  if (frame.salience.spotlightId === laneId || frame.salience.hoverId === laneId) {
    marks.push(...spotlightMarks(thread, hue, length))
  }

  return marks
}

/**
 * THE ENCLOSURE (prd7 ruling 3) — a lane above calm is bracketed, and a calm
 * one never is (graft g1); exempt from every fade (graft g2), which is why a
 * frozen lane is not the dimmest thing on the page.
 *
 * A midpoint-displaced blob behind the lane's name (Hobbs' subdivision,
 * seeded off the lane so no two are the same shape), at low alpha and drawn a
 * layer under the label (`marks/index.ts` puts nodes before names) so it
 * grounds the text rather than shouting over it.
 *
 * See docs/design-notes/node-organic-substitutions.md for why it moved off the
 * node and stopped being a ring.
 */
function enclosureMark(thread: ThreadGeometry, hue: Rgb): Mark {
  const { anchor, align } = thread.label
  // The block the name and its figure occupy — roughly, and roughly is right: a
  // blob has no edge to line up with anyway.
  const width = thread.lane.label.length * 5.9 + 14
  const centre: Point = {
    x: align === 'left' ? anchor.x + width / 2 - 5 : align === 'right' ? anchor.x - width / 2 + 5 : anchor.x,
    y: anchor.y + 1,
  }

  return regionMark({
    role: 'rank-enclosure',
    laneId: thread.laneId,
    alarm: true,
    // Sized to the two lines it sits under and no further, and faint: it is the
    // ground a name stands on. The displacement can push it a third past these
    // radii, which is why they are inside the block rather than around it — a
    // blob that read as an object in its own right would be a fifth hue in a
    // picture that has four.
    ring: blobRing(centre, width * 0.44, 12, variationSeed(thread.lane)),
    paint: ink(hue, 0.1),
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
            sealMark(
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
 * EXPENSIVE — heat coming off the tip (prd7 ruling 3). Three short ribbons,
 * thick where they part from the tip and needled to nothing, each curling a
 * little on the lane's own free phase so no two lanes exhale alike.
 *
 * The law is not the count: the marking must *rise away* from the node and
 * *fade as it goes*, or it stops reading as heat leaving. NOTICE, and
 * therefore non-alarm — it passes through the contrast budget like everything
 * else calm does, which is how a white-hot thread stays structurally unable
 * to out-read a summons (g6).
 *
 * See docs/design-notes/node-organic-substitutions.md for what this replaced.
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
  const curl = variationFor(variationSeed(thread.lane)).curl
  const lean = (curl - 0.5) * 2
  // All three the same way, splaying as they rise — heat comes off a thing in a
  // plume. Alternating them read as a zigzag, which is a chevron by another
  // name and would have quietly undone the substitution.
  const side = curl >= 0.5 ? 1 : -1

  return [0, 1, 2].map((i) => {
    const reach = out + 5 + i * 5.5
    const splay = 1 + i * 0.45
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
        at(reach + 4.2, side * splay * (1.4 + lean)),
        at(reach + 8.4, side * splay * (4 + lean * 2)),
      ],
      // Wide where it leaves the tip and gone by the end of itself. Bigger than
      // the chevrons were: a 5px lick is a smudge, and the whole argument for
      // dropping the arrowheads was that a width gradient reads further.
      widthRoot: 3 - i * 0.5,
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
 * THE TAIL — where the thread stops, told as the thread rather than as a
 * glyph stamped on the end of it (#117). A short run of the lane's own
 * substance carried past the node and needled to nothing, leaning off the
 * lane's free phase.
 *
 * Reach, lean and length all vary per lane off the channel that carries
 * nothing ({@link LaneVariation.curl}) — work stays in the channels that
 * encode work; the lens it grows out of already carries the lane's size.
 *
 * See docs/design-notes/node-organic-substitutions.md.
 */
function tailMark(
  role: MarkRole,
  thread: ThreadGeometry,
  angle: number,
  length: number,
  paint: Ink,
): RibbonMark {
  const habit = variationFor(variationSeed(thread.lane)).curl
  const reach = length * (0.55 + 0.85 * habit)
  const lean = (habit - 0.5) * 1.8
  const forward: Point = { x: Math.cos(angle), y: Math.sin(angle) }
  const across: Point = { x: -Math.sin(angle), y: Math.cos(angle) }
  const at = (along: number, sideways: number): Point => ({
    x: thread.node.x + forward.x * along + across.x * sideways,
    y: thread.node.y + forward.y * along + across.y * sideways,
  })

  return ribbonMark({
    role,
    laneId: thread.laneId,
    alarm: false,
    // Three points, bending: a straight tail would read as a whisker, and a
    // whisker is a glyph again.
    path: [
      at(length * 0.42, 0),
      at(length * 0.42 + reach * 0.55, lean * reach * 0.22),
      at(length * 0.42 + reach, lean * reach * 0.75),
    ],
    // Off the lens's own girth, so it leaves the node at the width the node
    // ends at rather than at a width of its own.
    widthRoot: Math.max(0.9, length * 0.13),
    widthTip: 0.2,
    taperTip: 0.5,
    samples: 10,
    paint,
  })
}

/**
 * DONE — SEALED: the cord folding back into itself (prd7 ruling 3, restated
 * by #117). The lane's own substance carried past the tip, turned back
 * through more than a half-circle, and laid down into the body it came from,
 * where its width has already gone to nothing — nothing is added at the tip,
 * the terminal simply stops reaching and comes home.
 *
 * `marks.test.ts` asserts four things about the shape, and any future redraw
 * of this mark must keep all four true:
 *
 * 1. it **turns back on itself** — total turning ≥ π.
 * 2. it **returns into the node's own body** — the spine's last point is
 *    inside the lens, while its furthest point is outside it (what separates
 *    a seal from the tail beside it, which reaches away and ends outside).
 * 3. it is **the cord, not a mark laid on it** — a ribbon, drawn to nothing at
 *    the end, so it closes rather than stopping.
 * 4. **no two lanes wear the same one** — given a fleet whose lanes have done
 *    identical work, every seal must still be a different shape in its own
 *    node's frame.
 *
 * It wears the done green rather than a neutral, so "landed" is one reading
 * of one hue instead of a grey mark a viewer has to be told about.
 *
 * See docs/design-notes/node-seal-fold.md for the bar → knot → fold history and
 * why only clause (1) above is laxer than what it replaced.
 */
function sealMark(
  role: MarkRole,
  thread: ThreadGeometry,
  angle: number,
  length: number,
  paint: Ink,
): RibbonMark {
  const habit = variationFor(variationSeed(thread.lane))
  return ribbonMark({
    role,
    laneId: thread.laneId,
    alarm: false,
    path: sealSpine(thread.node, angle, length, habit.curl, habit.phase),
    // Thick where the cord is still cord and nothing at all by the time it has
    // come home: a fold lying into the body, not a ring drawn round something.
    widthRoot: sealWidth(length),
    widthTip: 0,
    taperTip: 0.6,
    samples: 20,
    paint,
  })
}

/** How thick the cord is where it is still cord. Off the lens, like everything. */
function sealWidth(length: number): number {
  return Math.max(1, length * 0.13)
}

/**
 * THE FOLD, as a spine: out past the tip, round, and home.
 *
 * An arc that starts outside the lens and shrinks as it sweeps, with the last
 * third pulled into an anchor **inside** the lens. The anchor is what makes
 * "it comes back" true by construction rather than by tuning — whatever the
 * turn does, the last point of this path is a fixed short distance up the
 * node's own axis, and `marks.test.ts` reads exactly that.
 *
 * Four things vary per lane, off the two free phases:
 *
 * - **how far past the tip it goes before turning** (`reach`),
 * - **how far round it goes** (`turn`), from a half-circle to most of one,
 * - **which hand it turns on**, which is the one that stops a rim reading as
 *   something somebody wound,
 * - **how tight the turn is**, which follows the lane's own lens as well, so a
 *   big landing folds wide and a small one folds tight.
 */
function sealSpine(
  node: Point,
  angle: number,
  length: number,
  curl: number,
  phase: number,
): Point[] {
  const forward: Point = { x: Math.cos(angle), y: Math.sin(angle) }
  const across: Point = { x: -Math.sin(angle), y: Math.cos(angle) }
  const at = (along: number, sideways: number): Point => ({
    x: node.x + forward.x * along + across.x * sideways,
    y: node.y + forward.y * along + across.y * sideways,
  })

  // Everything below is in units of the lens, which is what makes the two
  // clauses `marks.test.ts` reads true *by construction* rather than by tuning.
  // Which way the cord went over: a rim wound all one way is a rim somebody set.
  const hand = phase < 0.5 ? -1 : 1
  const reach = length * (SEAL.reach.min + SEAL.reach.span * curl)
  // Tied to the cord's own width rather than to the lens, which is the number
  // that decides fold-versus-ring: at half a width the two runs touch and the
  // eye closes, and there is nothing left for the picture to read as a badge.
  const cord = sealWidth(length)
  const tight = cord * (SEAL.tightness.min + SEAL.tightness.span * phase)
  const home = length * SEAL.home
  const bow = length * SEAL.bow * (curl - 0.5) * 2

  const points: Point[] = []

  // THE TURN. A little over a half-circle, at a radius near the cord's own
  // width — so the two runs lie against each other and there is no eye left
  // over. This is the whole difference from the knot: a knot's radius was a
  // size of its own, which is what put a ring at the end of every finished lane.
  const sweep = Math.PI * (1 + SEAL.overturn * phase)
  const arcSteps = 9
  for (let i = 0; i <= arcSteps; i += 1) {
    const theta = -Math.PI / 2 + (i / arcSteps) * sweep
    points.push(at(reach + tight * Math.cos(theta), hand * (tight + tight * Math.sin(theta))))
  }

  // …AND HOME. Back down the outside of what it came out on, into the lens,
  // where the taper has already taken it to nothing. It bows on the way, in the
  // same hand it turned, so the return is a curve rather than a rule and the
  // turning keeps accumulating past the half-circle.
  const backSteps = 7
  const from = points[points.length - 1] as Point
  const alongFrom = (from.x - node.x) * forward.x + (from.y - node.y) * forward.y
  const sideFrom = (from.x - node.x) * across.x + (from.y - node.y) * across.y
  for (let i = 1; i <= backSteps; i += 1) {
    const t = i / backSteps
    const eased = t * t * (3 - 2 * t)
    points.push(
      at(
        alongFrom + (home - alongFrom) * eased,
        sideFrom + hand * bow * Math.sin(Math.PI * t) - sideFrom * eased * 0.35,
      ),
    )
  }

  return points
}

/**
 * The fold's whole shape, in units of the lens it grows out of.
 *
 * Written as a table because the two structural clauses are arithmetic over it,
 * and a reader has to be able to check them by hand. The lens's half-length is
 * 0.46, which is what "inside the body" means:
 *
 * - **it leaves.** The furthest the arc reaches is `pivot + startRadius` at
 *   `t = 0`, since the radius only shrinks from there: 0.52 at the tightest and
 *   0.92 at the widest. Always outside the body.
 * - **it comes home.** The turn is capped **below** 1.5 half-turns, which is
 *   what puts the last point on the *far* side of the pivot rather than back out
 *   where it started — `cos θ ≤ 0` over the whole of `turns`. So the last point
 *   is at most `hypot(pivot, end)` from the node: 0.40 at the very worst, well
 *   inside the body. Letting the turn past 1.5 would bring the cord back round
 *   to where it began, which is a knot, which is the badge this replaced.
 *
 * The ranges are wide on purpose. A fold that varied by a pixel would satisfy
 * every clause and still read as one stamp — the review's whole point — so the
 * widest fold in a fleet is nearly three times the tightest, and how far round
 * it goes, where it pivots and which hand it turns on all move independently.
 */
const SEAL = {
  /** How far past the node the cord runs before it turns. */
  reach: { min: 0.55, span: 0.62 },
  /**
   * The turn's radius, **in units of the cord's own width**. Under a half the
   * two runs overlap and the fold is solid; the span takes the loosest lane to
   * about three quarters, where the two runs still touch. A radius of its own —
   * which is what the knot had — is what leaves a hole, and the hole is the
   * badge.
   */
  tightness: { min: 0.34, span: 0.4 },
  /** How far past a half-circle the turn carries, as a fraction of π. */
  overturn: 0.22,
  /** Where the return lands, up the node's own axis. Well inside the lens. */
  home: 0.1,
  /** How far the return bows on the way back, ± of the lens. */
  bow: 0.16,
} as const

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
    // A finished lane's name recedes to `PERSIST.name` and stops there. It has to
    // stay readable: the whole reason a finished lane is still drawn is so the
    // operator can tell *which* lane finished, and a name too dim to read has
    // deleted it while pretending not to.
    ink: budget(
      frame,
      laneId,
      thread.alarm,
      thread.retire === null ? living : toward(living, PERSIST.name, thread.retire.stilled),
    ),
  })

  // The figure is **kept**, at full label brightness, finished or not. What a lane
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
