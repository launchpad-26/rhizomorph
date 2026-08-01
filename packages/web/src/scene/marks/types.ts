import type { Point } from '../geometry.js'
import { luminance, type Ink } from '../palette.js'

/**
 * THE DISPLAY LIST — what the scene draws, as data.
 *
 * Every decision about the picture is made in `marks/`, which is pure; `paint.ts`
 * executes the result and is the only file in the scene that touches a canvas
 * context. The seam is what makes the encodings testable at all: "the frozen lane
 * is severed twice, across a thread that is broken rather than merely dim" is a
 * query over this list, not an interpretation of a screenshot or a recording of
 * imperative calls.
 *
 * Every mark carries three things beyond its geometry:
 *
 * - `role` — what it *means*, which is what a test asks about;
 * - `laneId` — whose it is, or null for the root-mass and its chrome;
 * - `alarm` — whether it is a needs-you/broken mark, and therefore exempt from
 *   every fade (graft g2) and free of the calm luminance ceiling (graft g6).
 */

/**
 * THE VOCABULARY (prd7 ruling 2) — every name below says what a mark **means**,
 * and none of them says what it looks like.
 *
 * The rule is one line: *a role is the law layer's word, and the law layer may
 * not know the drawing.* Before this the two were the same word — a waiting lane
 * carried a `raised-hand`, an expensive one carried `chevron`s — so the scene's
 * laws were written in the shapes' own vocabulary and could not survive the
 * shapes changing. Every one of those assertions would have had to be rewritten
 * to redraw a summons, which is the coupling that makes an encoding
 * unamendable: you cannot try a different form for WAITING without editing the
 * tests that hold WAITING's *meaning*.
 *
 * So the shape names went where the shapes are. `glyphs.ts` still says
 * `CARTOUCHE`, `NODE_LENS` and `THORN_OUT`, and `paint.ts` still knows seven
 * `kind`s of geometry — those files *are* the form layer, and naming the form is
 * their job. What no longer exists is a shape name in the one channel the laws
 * read. A future painter may draw a summons as anything it likes; what it may
 * not do is draw it as nothing.
 *
 * Three names look like shapes and are not, so they stay:
 *
 * - **`orbit`** / **`orbit-wake`** — to orbit is to go round and never arrive,
 *   which is LOOPING's meaning exactly, not the circle it is drawn on.
 * - **`tick`** — the *event* (a tool call), the same word `PulseKind` uses in
 *   `pulses.ts`. The flick across the thread is only how it is drawn.
 * - **`scar`** and its family — what is left of a lane, told as the thing it is.
 *
 * Two more are structure rather than silhouette: a **`-tip`** is where a reach
 * ends (the same word `widthTip` uses), and a **`-bloom`** is the light a lit
 * line has.
 */
export type MarkRole =
  // the root-mass
  | 'root-halo'
  | 'root-mass'
  | 'root-core'
  | 'root-arrival'
  | 'root-label'
  // threads and second growth
  | 'thread'
  | 'thread-bloom'
  | 'thread-flow'
  | 'filament'
  /** Where a filament stops: a reach that ended, rather than one that faded out. */
  | 'filament-tip'
  /**
   * The cord-cut (prd5 ruling 3). A retiring lane draws **no** `thread` mark —
   * these are what it draws instead, which is how "it left the living network"
   * is a query over the display list rather than a matter of brightness. The
   * bloom is present only while the cut is running: a settled scar has none,
   * because a bloom is what a lit thread has.
   */
  | 'scar'
  | 'scar-bloom'
  | 'scar-mark'
  /**
   * The severed lane's substance on its way into the root-mass (prd6 ruling 2).
   * A ribbon rather than a `pulse`, because it is the thread's own matter being
   * reabsorbed and not light in flight — and present only while a cut the scene
   * actually watched is retracting, so a replay never draws one.
   */
  | 'homeward'
  // light in flight
  | 'pulse'
  | 'pulse-wake'
  | 'tick'
  /**
   * THE FIVE PATHOLOGIES. Each is named for the state it reports, so a law says
   * "the looping lane carries its looping marking" rather than "the looping lane
   * has a knot in it".
   */
  // LOOPING — a closed circuit, and light going round it that never comes home
  | 'looping-mark'
  | 'orbit'
  | 'orbit-wake'
  // FROZEN — the line itself is cut through
  | 'severed'
  // WAITING — light that has stopped, and the lane asking for a human
  | 'held'
  | 'summons'
  // EXPENSIVE — burning money, told as luminance on the thread and as a marking
  | 'heat'
  | 'expensive-mark'
  /**
   * OFF-FENCE is a two-party fact, so the picture names both parties: the
   * offender wears a mark of its own, its reach crosses the gap and takes hold
   * of something, and the fence it breached is drawn around the lane whose
   * ground it entered.
   */
  | 'off-fence-mark'
  | 'off-fence-reach'
  | 'off-fence-grasp'
  | 'off-fence-victim'
  // nodes and naming
  | 'node'
  /** Where a lane's thread stops. Every reach in this scene ends deliberately. */
  | 'node-tip'
  /** DONE — landed, and not a fault. */
  | 'done-mark'
  /** The enclosure a lane above calm wears. Nothing calm may ever wear one. */
  | 'rank-enclosure'
  | 'spotlight'
  | 'label'
  | 'label-figure'
  | 'label-chip'
  /** The scene's own gap voice (law 12) — what it cannot show, and why. */
  | 'gap'

/** A brightness ramp along a line — the reduced-motion flow treatment needs one. */
export interface LinearPaint {
  type: 'linear'
  from: Point
  to: Point
  stops: readonly { at: number; ink: Ink }[]
}

export type Paint = Ink | LinearPaint

export function isLinear(paint: Paint): paint is LinearPaint {
  return 'type' in paint
}

interface MarkBase {
  role: MarkRole
  laneId: string | null
  /** Needs-you or broken. Exempt from fades; owns the top of the range. */
  alarm: boolean
}

/** A tapering filled ribbon along a sampled path — how a hypha is drawn. */
export interface RibbonMark extends MarkBase {
  kind: 'ribbon'
  path: readonly Point[]
  widthRoot: number
  widthTip: number
  paint: Paint
  /** Drawn in short runs with gaps: the line itself is severed, not merely thin. */
  dashed?: boolean
}

/** A soft radial blob. Light, always — the only thing in the scene that glows. */
export interface GlowMark extends MarkBase {
  kind: 'glow'
  at: Point
  radius: number
  ink: Ink
}

export interface StrokeMark extends MarkBase {
  kind: 'stroke'
  points: readonly Point[]
  width: number
  ink: Ink
  dash?: readonly [number, number]
  closed?: boolean
}

export interface ArcMark extends MarkBase {
  kind: 'arc'
  at: Point
  radius: number
  from: number
  to: number
  width: number
  ink: Ink
  dash?: readonly [number, number]
}

/**
 * A glyph from the sigil alphabet, authored in a unit square by
 * `fleet/strokes.ts` and placed here. Same stroke engine as the fleet table's
 * row marks (ruling 23), one scale factor apart.
 */
export interface PathMark extends MarkBase {
  kind: 'path'
  /** SVG path data in unit space (0–1 on both axes, centre at 0.5, 0.5). */
  d: string
  at: Point
  size: number
  /** Vertical scale relative to `size`. 1 keeps the glyph's authored proportions. */
  squash?: number
  rotate: number
  ink: Ink
  /** Filled when absent — a stroked glyph is the hollow reading of the same mark. */
  stroke?: number
}

export interface TextMark extends MarkBase {
  kind: 'text'
  at: Point
  text: string
  ink: Ink
  /** Law 11: sans for names, mono with tabular numerals for every figure. */
  font: 'sans' | 'mono'
  size: number
  weight: number
  align: 'left' | 'right' | 'centre'
}

/** The plate behind a spotlit label, so a name survives any background. */
export interface ChipMark extends MarkBase {
  kind: 'chip'
  at: Point
  width: number
  height: number
  fill: Ink
  border: Ink
}

export type Mark =
  | RibbonMark
  | GlowMark
  | StrokeMark
  | ArcMark
  | PathMark
  | TextMark
  | ChipMark

/** Every ink a mark paints with — what the contrast-budget assertions read. */
export function inksOf(mark: Mark): readonly Ink[] {
  switch (mark.kind) {
    case 'ribbon':
      return isLinear(mark.paint) ? mark.paint.stops.map((stop) => stop.ink) : [mark.paint]
    case 'chip':
      return [mark.fill, mark.border]
    default:
      return [mark.ink]
  }
}

/** The brightest thing a mark puts on screen. */
export function brightnessOf(mark: Mark): number {
  return Math.max(0, ...inksOf(mark).map(luminance))
}
