import { DONE, ICE_300, type Ink, ink, NECROTIC, WORKING } from '../../scene/palette.js'

/**
 * THE BRANCHING LAYOUT GRAMMAR (prd14 ruling 1) — a trunk running to a fork
 * point, then N strands diverging:
 *
 * ```
 *         ┌──── run 1 ──────▶
 *         │
 * ──trunk─┼──── run 2 ──────▶
 *    ▲    │
 *    │    └──── run 3 ──▶ (dead)
 * fork point
 * ```
 *
 * **A HEADER GLYPH, NOT A DIAGRAM** (prd-55 ruling 11, wave 2, #385). Until
 * now this was the only picture the lab had of a fork, so it was drawn at
 * diagram size: a panel of its own, 36 px of height per arm. The lane canvas
 * (`../canvas/`) is now that picture — the same fork, painted with the
 * scene's own brushes, one ribbon per dispatch record and its verdict at the
 * tip. Two full-size drawings of one fork is one drawing too many, and the
 * one that reads a RECORD wins. So this becomes what a header can carry: a
 * band of at most {@link GLYPH_HEIGHT_MAX} whatever height the caller asks
 * for, a hairline trunk, and a strand per **run** rather than per arm — the
 * count the canvas below it draws, so header and drawing cannot disagree
 * about how many things there are.
 *
 * The strand count follows the caller: hand an arm its {@link ArmInput.runs}
 * and the glyph draws one strand per run, named `<arm>-run-<n>`; hand it
 * none and it draws the single strand an arm-shaped caller expects, under
 * the arm's own id. Telling the glyph about runs is what makes it draw runs.
 *
 * This is **new geometry only** — the growth metaphor's canvas 2D approach,
 * its palette (`../../scene/palette.js`, imported and never forked) and its
 * frame-budget discipline are reused as-is. No second renderer is built
 * here: this module returns coordinates and paint hints, never touches a
 * `CanvasRenderingContext2D`, and nothing in `packages/web/src/scene/` is
 * edited to make room for it.
 *
 * Two facts this grammar has to tell honestly, in channels beyond hue alone
 * (prd10's own discipline, e.g. `retire.ts`'s three-channel "luminous, but
 * not alive"):
 *
 * - **an abandoned arm reads as DEAD, distinctly from a finished one** — told
 *   in ink (`NECROTIC`, the palette's own "dead tissue" grey, vs `DONE`'s dim
 *   green) *and* in shape (a dead arm's path stops short of the full reach,
 *   and its terminal is an open stub rather than a sealed cap).
 * - **every arm is a forked reality and must never read as observed
 *   history** (prd12 ruling 3) — every arm carries {@link SYNTHETIC_DASH};
 *   the trunk, which is the real lane run up to the checkpoint, never does.
 */

export interface Point {
  readonly x: number
  readonly y: number
}

export type ArmState = 'running' | 'finished' | 'dead'

/** Plain inputs only (no `lab/types.ts` import) — an arm's identity and state. */
export interface ArmInput {
  readonly id: string
  readonly state: ArmState
  /**
   * How many runs this arm dispatched. Given, the glyph draws a strand PER
   * RUN (prd-55 ruling 11) — the same count the canvas below it draws from
   * the record. Omitted, it draws the one strand an arm-shaped caller
   * expects, under the arm's own id, so a caller that has not learned about
   * runs yet still gets a correct picture of what it does know.
   */
  readonly runs?: number
}

export interface BranchingLayoutOptions {
  readonly width: number
  readonly height: number
  readonly arms: readonly ArmInput[]
}

export interface TrunkGeometry {
  readonly path: readonly Point[]
  readonly ink: Ink
}

export interface ForkMarker {
  readonly at: Point
  readonly radius: number
  readonly ink: Ink
}

/** How an arm's line ends — the shape half of the dead-vs-finished distinction. */
export type ArmTerminal = 'arrow' | 'seal' | 'stub'

export interface ArmGeometry {
  /** The strand's own id: the arm's when the caller declared no runs, `<arm>-run-<n>` when it did. */
  readonly id: string
  /** The arm this strand belongs to, by the caller's own id — unchanged however the strand is named. */
  readonly arm: string
  /** Which run of that arm this strand is, 1-based. 1 when the caller declared no runs. */
  readonly run: number
  readonly state: ArmState
  /** Fork point → the strand's own terminal point. Shorter than full reach when dead. */
  readonly path: readonly Point[]
  readonly ink: Ink
  /** prd12 ruling 3: a forked reality, drawn so it can never be read as observed history. */
  readonly dash: readonly [number, number]
  readonly terminal: ArmTerminal
}

export interface BranchingLayout {
  readonly width: number
  /** The glyph's own height — bounded by {@link GLYPH_HEIGHT_MAX}, whatever the caller asked for. */
  readonly height: number
  readonly fork: ForkMarker
  readonly trunk: TrunkGeometry
  /** One entry per strand: per RUN when the caller declared runs, per arm when it did not. */
  readonly arms: readonly ArmGeometry[]
}

/** Left/right clearance, in px, so a line never touches the panel edge. */
const MARGIN_PX = 24

/**
 * THE GLYPH'S BAND (prd-55 ruling 11). A header carries a band, not a panel:
 * whatever height a caller asks for, the glyph answers with at most
 * {@link GLYPH_HEIGHT_MAX} — so a caller sized for the old diagram
 * (`36 px × arms + 40`) shrinks the moment it renders this layout's own
 * `height`, with no change of its own. The floor keeps a one-strand glyph
 * from collapsing to a rule.
 */
export const GLYPH_HEIGHT_MAX = 44
export const GLYPH_HEIGHT_MIN = 20

/** Top/bottom clearance inside the band, in px. Small, because the band is small. */
const GLYPH_MARGIN_Y = 5

/** Where the fork point sits, as a fraction of the drawable width. */
const FORK_FRACTION = 0.32

/** How far apart two neighbouring strands sit, in px, before crowding clamps it. */
const ARM_GAP_PX = 9

/** Points sampled along each curved path. Cheap, and plenty for a hairline. */
const ARM_SAMPLES = 32
const TRUNK_SAMPLES = 8

/**
 * How far a dead arm's path reaches, as a fraction of a living arm's — the
 * geometric half of "dead, distinctly from finished" (the diagram's own
 * "arm C ──▶ (dead)" drawn shorter than "arm A ──────▶"). Must stay well
 * under 1: a dead arm that reached as far as a living one would say nothing
 * about having stopped.
 */
const DEAD_REACH_FRACTION = 0.55

/** Radius of the fork-point marker, in px — a glyph's dot, not a diagram's node. */
const FORK_RADIUS_PX = 2.5

/**
 * Every arm's dash — the uniform "this is a forked reality" marker (prd12
 * ruling 3). One pattern for every state: the fact that an arm is synthetic
 * is not a fact about whether it is running, finished or dead, so the three
 * states must not each invent their own dash.
 */
export const SYNTHETIC_DASH: readonly [number, number] = [7, 5]

/** The trunk's ink — structural, meaning nothing but "this happened" (law 9a: ice is structure). */
const TRUNK_INK: Ink = ink(ICE_300, 0.9)

const ARM_INK: Record<ArmState, Ink> = {
  running: ink(WORKING, 0.85),
  finished: ink(DONE, 0.85),
  // NECROTIC is the palette's own "dead tissue" grey (`retire.ts`'s reading of
  // it: "that grey is a corpse"), which is exactly what an abandoned arm is —
  // never DONE's green, and never a luminance trick on top of it.
  dead: ink(NECROTIC, 0.6),
}

const ARM_TERMINAL: Record<ArmState, ArmTerminal> = {
  running: 'arrow',
  finished: 'seal',
  dead: 'stub',
}

const ARM_REACH: Record<ArmState, number> = {
  running: 1,
  finished: 1,
  dead: DEAD_REACH_FRACTION,
}

/**
 * THE STRANDS this glyph draws, from what the caller declared: one per RUN
 * where an arm carries a run count, one per arm where it does not. A count
 * below one is one — an arm the caller mentions is an arm the glyph draws,
 * and a strand nobody can see would be a fork silently unreported. A
 * fractional or non-finite count is floored to whole runs the same way.
 */
export function strandsOf(arms: readonly ArmInput[]): ReadonlyArray<{ id: string; arm: string; run: number; state: ArmState }> {
  return arms.flatMap((arm) => {
    if (arm.runs === undefined) return [{ id: arm.id, arm: arm.id, run: 1, state: arm.state }]
    const runs = Math.max(1, Math.floor(Number.isFinite(arm.runs) ? arm.runs : 1))
    return Array.from({ length: runs }, (_unused, i) => ({ id: `${arm.id}-run-${i + 1}`, arm: arm.id, run: i + 1, state: arm.state }))
  })
}

/**
 * THE LAYOUT (prd14 ruling 1, as a header glyph since prd-55 ruling 11). Pure
 * and deterministic: the same arms at the same panel size always return the
 * same points, which is what makes this testable on a number rather than a
 * screenshot.
 *
 * Strands keep the order they arrive in — first strand topmost, fanning
 * downward — so a caller's own ordering (launch order, arm-major then run,
 * whatever it decides) is the picture's ordering too, with no re-sorting here
 * to disagree with it.
 */
export function layoutBranching(options: BranchingLayoutOptions): BranchingLayout {
  const { width, height, arms } = options
  const w = Math.max(1, width)
  // The band, not the panel: a caller sized for the old diagram shrinks here.
  const h = Math.min(GLYPH_HEIGHT_MAX, Math.max(GLYPH_HEIGHT_MIN, height))
  const centreY = h / 2

  const marginX = Math.min(MARGIN_PX, w / 4)
  const drawableWidth = Math.max(1, w - marginX * 2)
  const forkX = marginX + drawableWidth * FORK_FRACTION
  const armEndX = w - marginX
  const fork: Point = { x: forkX, y: centreY }

  const trunk: TrunkGeometry = {
    path: samplePoints(TRUNK_SAMPLES, (t) => ({
      x: marginX + (forkX - marginX) * t,
      y: centreY,
    })),
    ink: TRUNK_INK,
  }

  const strands = strandsOf(arms)

  // Evenly spaced offsets around the trunk's own y, clamped so a large strand
  // count still fits the band rather than running off it.
  const count = strands.length
  const span = Math.max(1, h - GLYPH_MARGIN_Y * 2)
  const gap = count <= 1 ? 0 : Math.min(ARM_GAP_PX, span / (count - 1))
  const totalSpread = gap * Math.max(0, count - 1)
  const firstOffset = -totalSpread / 2

  const armGeometry = strands.map((strand, index) => {
    const endY = centreY + firstOffset + gap * index
    const reach = ARM_REACH[strand.state]
    const controlX = forkX + (armEndX - forkX) * 0.5
    const control: Point = { x: controlX, y: centreY }
    const end: Point = { x: armEndX, y: endY }

    const path = samplePoints(ARM_SAMPLES, (t) => quadraticPoint(fork, control, end, t * reach))

    return {
      id: strand.id,
      arm: strand.arm,
      run: strand.run,
      state: strand.state,
      path,
      ink: ARM_INK[strand.state],
      dash: SYNTHETIC_DASH,
      terminal: ARM_TERMINAL[strand.state],
    }
  })

  return {
    width: w,
    height: h,
    fork: { at: fork, radius: FORK_RADIUS_PX, ink: TRUNK_INK },
    trunk,
    arms: armGeometry,
  }
}

function quadraticPoint(p0: Point, p1: Point, p2: Point, t: number): Point {
  const u = 1 - t
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  }
}

function samplePoints(steps: number, at: (t: number) => Point): Point[] {
  const points: Point[] = []
  for (let i = 0; i <= steps; i += 1) points.push(at(i / steps))
  return points
}
