import type { ReactElement } from 'react'
import type { LadderRank, LaneActivity, PathologyKind } from './buildFleet.js'
import { PATHOLOGY_RANK } from './buildFleet.js'
import { arcPath, line, polar, segment, spiral, taper, thorn } from './strokes.js'

/**
 * THE GLYPH ALPHABET — ruling 23's cyber-sigilist register, and the instrument's
 * one visual vocabulary.
 *
 * Every mark is drawn in a **unit square** and scaled once, so the scene's node
 * sigil and the fleet table's row glyph are literally the same code at two
 * sizes (graft g1). That is what lets the fleet table's STATE column *be* the
 * scene's legend: a reader learns the alphabet from the rows, where every mark
 * sits beside its own word, and then reads the scene without one.
 *
 * Two laws are built into the shapes rather than remembered by the caller:
 *
 * - **Hue is meaning, form is kind** (graft g4, law 9a). A mark takes its colour
 *   from `currentColor`, so the hue is set once by a class on the parent
 *   ({@link stateTextClass}) and the glyph itself is never the thing that
 *   decides what state it is. The three NEEDS-YOU marks therefore share one
 *   amber and must be told apart by silhouette alone — LOOPING is round and
 *   closed, WAITING is tall and vertical, OFF-FENCE is a horizontal spear
 *   crossing vertical posts. No two share an axis, a fill or an enclosure. The
 *   same now goes for the activity marks, which share the green family.
 * - **Colour is never the sole carrier** (law 9a). Every state has a mark, and
 *   every mark survives greyscale: FROZEN is the only wide horizontal, WAITING
 *   the only tall vertical, EXPENSIVE the only radial burst.
 *
 * FROZEN and WAITING are the pair the prd says must not resemble each other, so
 * they are made opposite on every channel at once: axis (horizontal vs
 * vertical), fill (hollow vs solid), and terminal (severed serifs vs a live
 * capped tip).
 */

/** The fleet table's row scale — the legend. */
export const SIGIL_ROW_SIZE = 15
/** The scene's node scale. Same code, same silhouette, more room for the curl. */
export const SIGIL_SCENE_SIZE = 64

export type SigilKind = PathologyKind | LaneActivity

export const SIGIL_KINDS = [
  'looping',
  'frozen',
  'waiting',
  'expensive',
  'off-fence',
  'working',
  'done',
  'idle',
  'unknown',
] as const satisfies readonly SigilKind[]

/** The word beside the mark. Together they are the legend. */
export const SIGIL_WORD: Record<SigilKind, string> = {
  looping: 'LOOPING',
  frozen: 'FROZEN',
  waiting: 'WAITING',
  expensive: 'EXPENSIVE',
  'off-fence': 'OFF-FENCE',
  working: 'working',
  done: 'done',
  idle: 'idle',
  unknown: 'unknown',
}

/**
 * Which ladder rung a mark sits on. The four non-pathological states are CALM by
 * definition — including `done`, which is a finished lane and not a silent one.
 *
 * A rung is no longer the same question as a hue: since ruling 3 a calm state
 * has a colour of its own, and {@link stateTextClass} is what resolves the two
 * together. This record stays about severity, which is what the ladder, the
 * spotlight and the fade exemption all read.
 */
export const SIGIL_RANK: Record<SigilKind, LadderRank> = {
  // The five pathologies keep the rungs the model gave them; `waiting` is in
  // both vocabularies and is the same amber in each, which is the point.
  ...PATHOLOGY_RANK,
  working: 'calm',
  done: 'calm',
  idle: 'calm',
  unknown: 'calm',
}

/**
 * The one place a rung becomes a colour. Every surface uses these classes, so
 * the status hues stay exclusive (law 9a) by construction rather than by review.
 */
export const RANK_TEXT_CLASS: Record<LadderRank, string> = {
  calm: 'text-calm',
  notice: 'text-notice',
  'needs-you': 'text-needs-you',
  broken: 'text-broken',
}

/**
 * Glow is alarm grammar (law 9b), so there is deliberately nothing here for the
 * activity states — a calm row wears its family's hue and nothing is lit.
 */
export const RANK_GLOW_CLASS: Record<LadderRank, string> = {
  calm: 'glow-calm',
  notice: 'glow-notice',
  'needs-you': 'glow-needs-you',
  broken: 'glow-broken',
}

/**
 * The same map for the activity half of the scale (law 9a, prd4 ruling 3), and
 * the panel-side mirror of `scene/palette.ts`'s `ACTIVITY_HUE`.
 *
 * Idle and unknown deliberately point at the ice ramp rather than at a token of
 * their own: nothing-to-say is structure, and a lane the log has never mentioned
 * must not be able to borrow the confidence a status hue would lend it.
 */
export const ACTIVITY_TEXT_CLASS: Record<LaneActivity, string> = {
  working: 'text-working',
  waiting: 'text-waiting-benign',
  done: 'text-done',
  idle: 'text-ice-400',
  unknown: 'text-ice-400',
}

/**
 * What colour a lane's STATE reads in — and the reason the fleet table can *be*
 * the scene's legend (graft g1).
 *
 * A rung above calm wins outright: full-strength rung colour belongs to alarm
 * marks alone (law 9b), so a summons is never softened into its family's benign
 * end by the fact that the lane is also, technically, working. Below that the
 * activity speaks, which is what makes the STATE column teach the same six hues
 * the scene paints with — the reader learns "green = getting on with it" beside
 * the word, and then reads the picture without one.
 *
 * `waiting` is the pair to watch: it is a member of *both* vocabularies. As a
 * pathology it is a summons and wears NEEDS_YOU; as a bare activity it is a lane
 * that has merely stopped, and wears the muted end of the same amber. One scale,
 * two brightnesses — which is precisely ruling 3's claim.
 */
export function stateTextClass(rank: LadderRank, activity: LaneActivity): string {
  return rank === 'calm' ? ACTIVITY_TEXT_CLASS[activity] : RANK_TEXT_CLASS[rank]
}

export interface SigilProps {
  kind: SigilKind
  /** Rendered size in px. 15 is the table row, 64 the scene node. */
  size?: number
  /**
   * Accessible name. Omitted, the mark is decorative — which is correct
   * whenever its word is already beside it, and wrong whenever it is alone.
   */
  label?: string
  className?: string
}

/**
 * One mark, at any size. The parent sets the hue with a ladder class
 * (`RANK_TEXT_CLASS`); the glyph only ever draws in `currentColor`.
 */
export function Sigil({ kind, size = SIGIL_ROW_SIZE, label, className }: SigilProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1 1"
      // Every mark is authored in a unit square, so the whole alphabet scales
      // from one number and nothing has to be redrawn per size.
      data-sigil={kind}
      className={className}
      {...(label === undefined
        ? { 'aria-hidden': true }
        : { role: 'img' as const, 'aria-label': label })}
    >
      {label === undefined ? null : <title>{label}</title>}
      {mark(kind)}
    </svg>
  )
}

function mark(kind: SigilKind): ReactElement {
  switch (kind) {
    case 'looping':
      return <LoopMark />
    case 'frozen':
      return <FrozenMark />
    case 'waiting':
      return <WaitMark />
    case 'expensive':
      return <HeatMark />
    case 'off-fence':
      return <TrespassMark />
    case 'working':
      return <WorkingMark />
    case 'done':
      return <DoneMark />
    case 'idle':
      return <IdleMark />
    default:
      return <UnknownMark />
  }
}

const C = 0.5

/**
 * LOOPING — a coil that bites its own tail. The stroke must visibly pass
 * *inside* where it started or it reads as a ring rather than as a cycle, so
 * the spiral loses a third of its radius on the way round and ends in a thorn
 * curl aimed back at its own head.
 */
function LoopMark(): ReactElement {
  const start = -0.55
  const coil = spiral(C, C, 0.42, 0.19, start, start + Math.PI * 2.15, 72)
  const head = polar(C, C, 0.42, start)
  return (
    <g fill="currentColor">
      <path d={taper(coil, 0.13, 0.05)} />
      <path d={thorn(C, C, 0.19, start + Math.PI * 2.15, 0.9, 0.05)} />
      {/* the seam: where the cycle began, so the eye finds the repeat */}
      <circle cx={head.x} cy={head.y} r={0.075} />
    </g>
  )
}

/**
 * FROZEN — hollow, horizontal, severed. The flatline made a glyph: a bar all
 * the way across with end serifs (a trace that *stopped*, not one that ran off
 * the edge), through the middle of a hollow ring — the pulse that isn't.
 */
function FrozenMark(): ReactElement {
  return (
    <g fill="currentColor">
      <circle cx={C} cy={C} r={0.2} fill="none" stroke="currentColor" strokeWidth={0.075} />
      <path d={taper(segment({ x: 0.04, y: C }, { x: 0.96, y: C }, 12), 0.075, 0.075, () => 1)} />
      {[0.04, 0.96].map((x) => (
        <path
          key={x}
          d={line([
            { x, y: C - 0.13 },
            { x, y: C + 0.13 },
          ])}
          stroke="currentColor"
          strokeWidth={0.055}
        />
      ))}
    </g>
  )
}

/**
 * WAITING — the raised hand. Vertical, solid, capped and unmistakably alive:
 * the opposite of FROZEN on axis, fill and terminal at once. The thorn at the
 * wrist is what anchors the arm to the lane rather than floating above it.
 */
function WaitMark(): ReactElement {
  return (
    <g fill="currentColor">
      <circle cx={C} cy={0.85} r={0.115} />
      <path d={thorn(C, 0.85, 0.2, Math.PI * 0.62, -1.0, 0.07)} />
      <path d={taper(segment({ x: C, y: 0.78 }, { x: C, y: 0.16 }, 16), 0.135, 0.06)} />
      <circle cx={C} cy={0.12} r={0.085} />
    </g>
  )
}

/**
 * EXPENSIVE — heat. A white-hot core and a radial corona: the only mark in the
 * alphabet with rotational symmetry, so it is unmistakable at any size. Its
 * temperature is carried by luminance, its rung by hue (ruling 29).
 */
function HeatMark(): ReactElement {
  const rays = 8
  return (
    <g fill="currentColor">
      <circle cx={C} cy={C} r={0.13} />
      {Array.from({ length: rays }, (_unused, i) => {
        const angle = (i / rays) * Math.PI * 2 - Math.PI / 2
        const long = i % 2 === 0
        return (
          <path
            key={i}
            d={taper(
              segment(polar(C, C, 0.21, angle), polar(C, C, long ? 0.47 : 0.36, angle), 6),
              long ? 0.095 : 0.065,
              0,
            )}
          />
        )
      })}
    </g>
  )
}

/**
 * OFF-FENCE — the trespass. Three fence posts stand on the left; a barbed spear
 * has gone straight through them and the lane's bead now sits on the far side.
 * Position does the arguing — the bead is *outside* — and the barbs mark where
 * it tore through.
 */
function TrespassMark(): ReactElement {
  return (
    <g fill="currentColor">
      {/* Three posts, kept well inside the height so the mark stays decisively
          wider than it is tall — the axis is half of how it is told apart from
          WAITING at a glance. */}
      {[0.24, 0.5, 0.76].map((y) => (
        <path
          key={y}
          d={line([
            { x: 0.26, y: y - 0.105 },
            { x: 0.26, y: y + 0.105 },
          ])}
          stroke="currentColor"
          strokeWidth={0.05}
          opacity={0.75}
        />
      ))}
      <path d={taper(segment({ x: 0.04, y: C }, { x: 0.78, y: C }, 14), 0.05, 0.115)} />
      {[-1, 1].map((side) => (
        <path
          key={side}
          d={taper(
            segment({ x: 0.3, y: C }, { x: 0.14, y: C + side * 0.2 }, 6),
            0.075,
            0,
          )}
        />
      ))}
      <circle cx={0.87} cy={C} r={0.1} />
    </g>
  )
}

/**
 * WORKING — a four-pointed star with a tight waist: dense, sharp, alive. The
 * calm alphabet's base form, so IDLE can be the same silhouette hollowed out
 * (identity by fill and luminance, never by hue — law 9).
 */
function WorkingMark(): ReactElement {
  return <path d={starPath(0.44, 0.15)} fill="currentColor" />
}

/** IDLE — the working star, hollow and smaller. Same lane; it has gone quiet. */
function IdleMark(): ReactElement {
  return (
    <path
      d={starPath(0.36, 0.13)}
      fill="none"
      stroke="currentColor"
      strokeWidth={0.06}
      opacity={0.8}
    />
  )
}

/**
 * DONE — sealed. A closed ring with its work settled at the centre and one
 * thorn tick to keep the register. Round and compact, so it cannot be mistaken
 * for FROZEN's wide severed bar: a finished lane and a dead one must never
 * share a silhouette (this is the mark that stops a landed fleet from reading
 * as a wall of flatlines).
 */
function DoneMark(): ReactElement {
  return (
    <g fill="currentColor">
      <circle cx={C} cy={C} r={0.3} fill="none" stroke="currentColor" strokeWidth={0.085} />
      <circle cx={C} cy={C} r={0.11} />
      <path d={thorn(C, C, 0.3, -Math.PI / 3, 0.8, 0.07)} />
    </g>
  )
}

/** UNKNOWN — one dot. The log has not said anything about this lane yet. */
function UnknownMark(): ReactElement {
  return <circle cx={C} cy={C} r={0.09} fill="currentColor" opacity={0.7} />
}

/** Four-pointed star: cardinal points at `outer`, diagonal waist at `inner`. */
function starPath(outer: number, inner: number): string {
  const points = Array.from({ length: 8 }, (_unused, i) => {
    const angle = (i / 8) * Math.PI * 2 - Math.PI / 2
    return polar(C, C, i % 2 === 0 ? outer : inner, angle)
  })
  return `${line(points)}Z`
}

/**
 * The cartouche: the thorned ring the scene brackets a needs-you/broken lane
 * with. Nothing else on the page is ever enclosed, so an enclosure means one
 * thing. Unit space, like every other path here.
 *
 * Graft g2 rides on this: an alarm mark is exempt from *every* fade — recency
 * and salience dimming never touch a lane wearing one.
 */
export function alarmCartouche(): string {
  const gap = 0.55
  return [
    arcPath(C, C, 0.46, gap / 2, Math.PI - gap / 2),
    arcPath(C, C, 0.46, Math.PI + gap / 2, Math.PI * 2 - gap / 2),
  ].join(' ')
}
