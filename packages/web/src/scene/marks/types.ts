import type { Point } from '../geometry.js'
import { luminance, type Ink } from '../palette.js'
import { ribbonOutline, type RibbonShape } from '../ribbon.js'

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
 * `NODE_LENS` and `THORN_OUT`, and `paint.ts` still knows eight `kind`s of
 * geometry — those files *are* the form layer, and naming the form is their job.
 * What no longer exists is a shape name in the one channel the laws read. A
 * future painter may draw a summons as anything it likes; what it may not do is
 * draw it as nothing.
 *
 * prd7 ruling 3 collected on that immediately, and the receipt is worth keeping:
 * a chevron became a taper, a cut stroke became a pinch, a cartouche became a
 * blob, a seal became a knot and a travelling dot became a swell — and not one
 * assertion about what any of those *mean* had to move. `CARTOUCHE` is still in
 * `glyphs.ts` and nothing draws it any more, which is exactly the right way for
 * a shape to die.
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
  /**
   * The mass's own surface — one `contour`, not a set of shapes (prd7 ruling 5).
   * `root-arrival` used to sit beside it, an expanding ring drawn on top of the
   * mass whenever work landed; the surface carries that fact now, by swelling
   * toward the lane it is coming from, so the role went with the ring.
   */
  | 'root-mass'
  | 'root-core'
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

/**
 * A filled ribbon whose width varies along its length — how a hypha is drawn
 * (prd7 ruling 3).
 *
 * Two geometries, and both are load-bearing:
 *
 * - **`path`** is the spine, and it is what the *encodings* are read off. A test
 *   asking where a lane's thread runs, or how wide it is, asks these fields;
 *   they are unchanged by every pinch, swell and jitter the form layer applies
 *   on top, which is exactly why bounded variation is safe (`variation.ts`).
 * - **`outline`** is what is actually filled: closed polygons, built by
 *   `ribbon.ts` and carried on the mark as plain data. More than one whenever
 *   the ribbon is broken — a dashed thread, or one pinched shut by a cut.
 *
 * A ribbon with a **closed** spine and zero width is the degenerate case the
 * painter also handles: the outline *is* the shape, and nothing is offset from a
 * centre-line at all. That is how an organic enclosure is drawn (`node.ts`), and
 * it is the reason `widthRoot`/`widthTip` may legitimately be zero here.
 */
export interface RibbonMark extends MarkBase {
  kind: 'ribbon'
  /** The spine. The encoded geometry, untouched by the form applied over it. */
  path: readonly Point[]
  /** The closed polygons the painter fills. One per unbroken run. */
  outline: readonly (readonly Point[])[]
  /** The encoded widths — the work-size channel, and LOCKED as such. */
  widthRoot: number
  widthTip: number
  paint: Paint
  /** Drawn in short runs with gaps: the line itself is severed, not merely thin. */
  dashed?: boolean
}

/**
 * AN ISO-CONTOUR of a scalar field: closed rings, filled as one region (prd7
 * ruling 5).
 *
 * Not a {@link RibbonMark}, and the difference is the winding. A ribbon's
 * polygons are independent runs of one broken stripe, so the painter fills each
 * separately and two of them may safely overlap. A contour's rings are one
 * region's boundary — an island beside the body, or a hole inside it — so they
 * are filled together under the even-odd rule, where a ring inside a ring is a
 * hole rather than a second lobe painted over the first.
 *
 * `rings` is the geometry the laws read: where the root-mass's surface actually
 * is, after the field has been sampled and the corners cut. Everything about
 * *how* it got that way lives in `contour.ts`; what arrives here is vertices.
 */
export interface ContourMark extends MarkBase {
  kind: 'contour'
  /** Closed rings, in world coordinates. Each is implicitly closed — no repeated first point. */
  rings: readonly (readonly Point[])[]
  fill: Ink
  /** The lit skin. Absent for a surface that is meant to read as a shadow. */
  edge?: { width: number; ink: Ink }
  /**
   * THE SAME FIELD, FURTHER IN — what gives a surface a body instead of a face.
   *
   * Each shell is another iso-level of the scalar field this mark's `rings` are
   * the zero-level of (`contour.ts`'s {@link contourLayers}), painted over the
   * fill in order. Because they all come off one sampling of one field they nest
   * by construction, and the density that builds up where they overlap *is* the
   * field getting deeper — which is the difference between a translucent body
   * and a flat shape with a gradient sprite laid on top of it (#117).
   *
   * Not part of `rings`, and deliberately: `rings` is the geometry the laws read
   * — where the mass's surface is — and a shell is not the surface. It is the
   * same claim at a different depth, and no law is written about it.
   */
  shells?: readonly { rings: readonly (readonly Point[])[]; ink: Ink }[]
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
  | ContourMark
  | GlowMark
  | StrokeMark
  | ArcMark
  | PathMark
  | TextMark
  | ChipMark

/**
 * The one way a ribbon mark is made.
 *
 * Every ribbon in the scene goes through here so that its `outline` cannot drift
 * out of step with its `path` — a mark whose filled polygon disagreed with the
 * spine the tests read would be a picture that lies about its own encoding, and
 * nothing downstream could catch it. The width modulations (`stops`, `modulate`,
 * `taperTip`) are spent on the outline and deliberately *not* recorded on the
 * mark: they are form, and the mark carries meaning.
 */
export type RibbonSpec = MarkBase &
  Omit<RibbonShape, 'spine'> & {
    role: MarkRole
    path: readonly Point[]
    paint: Paint
  }

export function ribbonMark(spec: RibbonSpec): RibbonMark {
  const { role, laneId, alarm, path, widthRoot, widthTip, paint, dashed } = spec
  return {
    kind: 'ribbon',
    role,
    laneId,
    alarm,
    path,
    outline: ribbonOutline({ ...spec, spine: path }),
    widthRoot,
    widthTip,
    paint,
    ...(dashed === true ? { dashed: true } : {}),
  }
}

/**
 * A closed region, filled as it stands: no spine, no offsetting, no width. The
 * organic-enclosure case — see {@link RibbonMark}.
 */
export function regionMark(spec: {
  role: MarkRole
  laneId: string | null
  alarm: boolean
  ring: readonly Point[]
  paint: Paint
}): RibbonMark {
  return {
    kind: 'ribbon',
    role: spec.role,
    laneId: spec.laneId,
    alarm: spec.alarm,
    path: spec.ring,
    outline: [spec.ring],
    widthRoot: 0,
    widthTip: 0,
    paint: spec.paint,
  }
}

/** Every ink a mark paints with — what the contrast-budget assertions read. */
export function inksOf(mark: Mark): readonly Ink[] {
  switch (mark.kind) {
    case 'ribbon':
      return isLinear(mark.paint) ? mark.paint.stops.map((stop) => stop.ink) : [mark.paint]
    case 'contour':
      // The shells count. They are ink this mark puts on the canvas, so a
      // brightness law asserted over the mass has to see the brightest of them
      // — otherwise depth would be a way of smuggling light past the budget.
      return [
        mark.fill,
        ...(mark.edge === undefined ? [] : [mark.edge.ink]),
        ...(mark.shells ?? []).map((shell) => shell.ink),
      ]
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
