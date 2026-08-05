import { DONE, ICE_300, NECROTIC, WORKING, ink, type Ink } from '../../scene/palette.js'

/**
 * THE BRANCHING LAYOUT GRAMMAR (prd14 ruling 1) — a trunk running to a fork
 * point, then N arms diverging:
 *
 * ```
 *         ┌──── arm A ──────▶
 *         │
 * ──trunk─┼──── arm B ──────▶
 *    ▲    │
 *    │    └──── arm C ──▶ (dead)
 * fork point
 * ```
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
  readonly id: string
  readonly state: ArmState
  /** Fork point → the arm's own terminal point. Shorter than full reach when dead. */
  readonly path: readonly Point[]
  readonly ink: Ink
  /** prd12 ruling 3: a forked reality, drawn so it can never be read as observed history. */
  readonly dash: readonly [number, number]
  readonly terminal: ArmTerminal
}

export interface BranchingLayout {
  readonly width: number
  readonly height: number
  readonly fork: ForkMarker
  readonly trunk: TrunkGeometry
  readonly arms: readonly ArmGeometry[]
}

/** Left/right/top/bottom clearance, in px, so a line never touches the panel edge. */
const MARGIN_PX = 24

/** Where the fork point sits, as a fraction of the drawable width. */
const FORK_FRACTION = 0.32

/** How far apart two neighbouring arms sit, in px, before crowding clamps it. */
const ARM_GAP_PX = 34

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

/** Radius of the fork-point marker, in px. */
const FORK_RADIUS_PX = 4

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
 * THE LAYOUT (prd14 ruling 1). Pure and deterministic: the same arms at the
 * same panel size always return the same points, which is what makes this
 * testable on a number rather than a screenshot.
 *
 * Arms keep the order they arrive in — first arm topmost, fanning downward —
 * so a caller's own ordering (launch order, alphabetical, whatever wave 2
 * decides) is the picture's ordering too, with no re-sorting here to disagree
 * with it.
 */
export function layoutBranching(options: BranchingLayoutOptions): BranchingLayout {
  const { width, height, arms } = options
  const w = Math.max(1, width)
  const h = Math.max(1, height)
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

  // Evenly spaced offsets around the trunk's own y, clamped so a large arm
  // count still fits the panel rather than running off it.
  const count = arms.length
  const span = Math.max(1, h - marginX * 2)
  const gap = count <= 1 ? 0 : Math.min(ARM_GAP_PX, span / (count - 1))
  const totalSpread = gap * Math.max(0, count - 1)
  const firstOffset = -totalSpread / 2

  const armGeometry = arms.map((arm, index) => {
    const endY = centreY + firstOffset + gap * index
    const reach = ARM_REACH[arm.state]
    const controlX = forkX + (armEndX - forkX) * 0.5
    const control: Point = { x: controlX, y: centreY }
    const end: Point = { x: armEndX, y: endY }

    const path = samplePoints(ARM_SAMPLES, (t) => quadraticPoint(fork, control, end, t * reach))

    return {
      id: arm.id,
      state: arm.state,
      path,
      ink: ARM_INK[arm.state],
      dash: SYNTHETIC_DASH,
      terminal: ARM_TERMINAL[arm.state],
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
