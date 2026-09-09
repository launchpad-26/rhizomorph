import { isCompletedVerdict } from '@rhizomorph/core'
import { contourLayers } from '../../scene/contour.js'
import { type Point, pointAt, tangentAt } from '../../scene/geometry.js'
import { heartAnatomy } from '../../scene/heart.js'
import { type Dissolve, dissolutionMotes, type Mote } from '../../scene/motes.js'
import { DARK_PALETTE, type Ink, ink, type ScenePalette } from '../../scene/palette.js'
import { type RibbonShape, ribbonOutline, smoothSpine } from '../../scene/ribbon.js'
import { AXIS_INSET, markerX, sessionFraction } from '../axis/position.js'
import type { FailedArm } from '../compare/types.js'
import type { LabCheckpoint, LabExperiment, LabRun } from '../types.js'

/**
 * THE LANE CANVAS, AS A PICTURE (prd-55 ruling 11, refining prd-53 rulings 5,
 * 7 and 8): the lab's record handed to the scene's six PURE paint modules —
 * `geometry`, `palette`, `ribbon`, `contour`, `motes`, `heart` — and nothing
 * else. This file is the model half: a pure function from the record to a
 * display list. `paint.ts` fills what it returns and decides nothing;
 * `LaneCanvas.tsx` mounts both.
 *
 * What the record becomes, and from which fact — every line below is a
 * brush handed a fact, never a fact invented for a brush:
 *
 * - **one RIBBON per dispatch record** (`ribbon.ts`): its spine leaves the
 *   root's rim on its own bearing and runs to the run's node; its width
 *   profile is booked cost on the ABSOLUTE log scale ({@link costWidth},
 *   prd-6 ruling 1 kept — a thin floor for nothing booked); it is PINCHED
 *   just off the root, where the reality forked; and it is DASHED, because
 *   everything after the playhead is dashed — prd-53 ruling 5's shared
 *   grammar, the same one the frame's series wear — so a forked reality can
 *   never read as observed history;
 * - **the TIP is the verdict** — prd-53 ruling 5's mapping, unchanged: pass
 *   `DONE`, fail `BROKEN`, not-run `NECROTIC`, unmeasured `WORKING` and
 *   hollow. Form pairs with hue so the verdict survives greyscale: a disc, a
 *   cross, a square, a ring;
 * - **the ROOT-MASS is the checkpoint** (`contour.ts`, `heart.ts`): contour
 *   layers on the tissue ramp, at the fork's TRUE x on an inset axis
 *   (`axis/position.ts` — the one position function), with the heart's hyphal
 *   fan seeded by the checkpoint id and one growth ring per run a gate has
 *   judged — nothing draws a ring the gate did not judge;
 * - **MOTES only where a channel carries nothing** (`motes.ts`): a run with
 *   nothing booked wears the thin floor and a drift of tissue motes along its
 *   spine — absence told as matter with no measure, never as zero;
 * - **a failed-to-dispatch arm is a STUB** in necrotic ink: drawn on its own
 *   row below the band, named with its error, and never counted among the
 *   ribbons (prd-53 ruling 7).
 *
 * THE FAN OPENS TOWARD THE FREE SIDE (prd-55 ruling 8, the design seat's
 * geometry): the root keeps its true x, and past {@link FAN_FLIP_FRACTION}
 * of the session the ribbons open leftward into the room that is actually
 * there. The reach is measured from the room in the chosen direction, so no
 * node can lie outside the drawing at any fork position — `organism.test.ts`
 * sweeps 0 % to 100 % to say so.
 *
 * No clock, no random, no motion input: the same record draws the same
 * picture, under `prefers-reduced-motion` and without it. Every ink is one of
 * the palette's own constants — `paint.ts` turns them into CSS and nothing
 * here reaches for a hex.
 */

// ── the record's own vocabulary ─────────────────────────────────────────────

export type OrganismState = 'unmeasured' | 'passed' | 'failed' | 'not-run'

/** How a tip is drawn — the form half of the verdict, so it survives greyscale. */
export type TipForm = 'disc' | 'cross' | 'square' | 'ring'

/** prd-53 ruling 5's mapping, unchanged since #329. */
export function organismState(verified: 'pass' | 'fail' | 'not-run' | undefined): OrganismState {
  if (verified === undefined) return 'unmeasured'
  if (verified === 'pass') return 'passed'
  if (verified === 'fail') return 'failed'
  return 'not-run'
}

export const TIP_FORM: Readonly<Record<OrganismState, TipForm>> = {
  unmeasured: 'ring',
  passed: 'disc',
  failed: 'cross',
  'not-run': 'square',
}

/**
 * The verdict's ink, per theme — the ONE place prd-53 ruling 5's mapping
 * becomes a colour, shared with the branching glyph so the two drawings
 * cannot disagree: pass DONE · fail BROKEN · not-run NECROTIC · unmeasured
 * WORKING (drawn hollow, see {@link TIP_FORM}).
 */
export function verdictInks(palette: ScenePalette): Readonly<Record<OrganismState, Ink>> {
  return {
    unmeasured: ink(palette.status.working, 0.85),
    passed: ink(palette.status.done, 0.9),
    failed: ink(palette.status.broken, 0.9),
    'not-run': ink(palette.necrotic, 0.9),
  }
}

/** Width floor and cap, in picture units — an absolute scale over booked dollars, log-spaced from a cent to ten dollars. */
export const WIDTH_FLOOR = 1.25
export const WIDTH_CAP = 6
const COST_MIN = 0.01
const COST_MAX = 10

/** Booked cost → ribbon width at the root. Null (nothing booked) is the floor: a ribbon that is there, and thin. Never fleet-relative. */
export function costWidth(costUsd: number | null): number {
  if (costUsd === null || !Number.isFinite(costUsd) || costUsd <= COST_MIN) return WIDTH_FLOOR
  if (costUsd >= COST_MAX) return WIDTH_CAP
  const t = (Math.log(costUsd) - Math.log(COST_MIN)) / (Math.log(COST_MAX) - Math.log(COST_MIN))
  return Math.round((WIDTH_FLOOR + t * (WIDTH_CAP - WIDTH_FLOOR)) * 100) / 100
}

/** The same dollar, 0–1 on the same absolute scale — what a growth ring's weight carries. */
export function costFraction(costUsd: number | null): number {
  return (costWidth(costUsd) - WIDTH_FLOOR) / (WIDTH_CAP - WIDTH_FLOOR)
}

// ── the picture ─────────────────────────────────────────────────────────────

export interface Ribbon {
  /** The run's lane handle — the record's own key, never invented. */
  id: string
  arm: number
  run: number
  state: OrganismState
  costUsd: number | null
  /** The smoothed centre-line, root rim → node. */
  spine: readonly Point[]
  /** What the ribbon brush was handed — so a test can read the width profile back through `widthOf`. */
  shape: RibbonShape
  /** The filled polygons `ribbon.ts` built — several, because the ribbon is dashed. */
  polygons: readonly (readonly Point[])[]
  /** The ENCODED width at the root ({@link costWidth}) — the number a test reads back. */
  width: number
  ink: Ink
  node: Point
  /** Direction of the ribbon at its tip, radians — the cross lies along it. */
  tangent: number
  tip: { form: TipForm; ink: Ink; radius: number }
  /** Tissue motes along the spine — present only when nothing is booked. */
  motes: readonly Mote[]
}

export interface Stub {
  arm: number
  error: string
  spine: readonly Point[]
  polygons: readonly (readonly Point[])[]
  ink: Ink
  /** Where the stub ends. */
  tip: Point
  /** Where its name goes — just past the tip, on the free side. */
  at: Point
}

export interface Shell {
  rings: readonly (readonly Point[])[]
  ink: Ink
}

export interface RootMass {
  at: Point
  radius: number
  /** Outermost first — the accumulation is the body. The last is the rind: two rings, filled even-odd. */
  shells: readonly Shell[]
  fan: { paths: readonly (readonly Point[])[]; ink: Ink; width: number }
  /** One per judged run, innermost oldest. */
  rings: readonly { id: string; ring: readonly Point[]; ink: Ink; width: number }[]
  core: { radius: number; ink: Ink }
}

export type FanDirection = 'right' | 'left'

export interface CanvasPicture {
  width: number
  height: number
  /** 0–1 of the session, or null when the session's length cannot be known (the file moved). */
  fraction: number | null
  direction: FanDirection
  axis: { y: number; from: number; to: number; ink: Ink }
  /** The hairline from the axis down to the root — the fork's position, made visible. */
  drop: { x: number; from: number; to: number; ink: Ink }
  root: RootMass
  /** Exactly the dispatch records, arm-major then run. */
  ribbons: readonly Ribbon[]
  /** Arms that never dispatched — drawn, named, and NOT ribbons. */
  stubs: readonly Stub[]
  /** The inks the highlight layer answers a hover or a selection in — decided here, so `paint.ts` decides nothing. */
  emphasis: { body: Ink; ring: Ink }
}

export interface CanvasLayoutOptions {
  experiment: LabExperiment
  /** The checkpoint the experiment was forked from — places the root on the session axis. */
  checkpoint?: LabCheckpoint | null
  failedArms?: readonly FailedArm[]
  width?: number
  height?: number
  /** The theme's table. Dark is the instrument's home register. */
  palette?: ScenePalette
}

// ── the numbers ─────────────────────────────────────────────────────────────

/** Past this fraction of the session the fan opens leftward (prd-55 ruling 8's "past 60 %"). */
export const FAN_FLIP_FRACTION = 0.6

/** Where the session axis runs, and the band the ribbons fan through. */
export const AXIS_Y = 18
const BAND_TOP = 44
const BAND_BOTTOM = 26

/** How far apart two neighbouring runs sit at most — crowding compresses, never overflows. */
const PITCH_MAX = 26
/** A stub's own row, below the band: present and named, never among the runs. */
const STUB_PITCH = 16
/** The smallest and largest reach a ribbon may have, in picture units. */
const REACH_MIN = 8
const REACH_MAX = 320
/** Room kept between a node and the edge for its tip, its focus ring and its name. */
const TIP_MARGIN = 18

/** An unmeasured run is still reaching — shorter than a judged one (grow-in, graft g3). */
const UNMEASURED_REACH = 0.62

/** The root-mass's radius, in picture units — a mass the ribbons are threaded into, not a bead they hang off. */
export const ROOT_RADIUS = 20

/** How much of the root's own width a ribbon keeps at its tip. */
const TIP_WIDTH = 0.7
/**
 * The pinch at the fork: where, how far, and how narrow. Never zero — a closed
 * ribbon is a severed one. Its span stops short of the root end, so the width
 * a test reads at t = 0 is exactly the encoded {@link costWidth}.
 */
export const PINCH = { at: 0.12, span: 0.1, scale: 0.35, flat: 0.25 } as const
/** Samples the spine is smoothed to before it is widened. */
const SPINE_SAMPLES = 32
/**
 * THE DASH — prd-53 ruling 5's after-the-playhead grammar, at a constant pitch.
 * `ribbon.ts` dashes by sample index (five on, two off), so the dash's length
 * on screen is the sample spacing; sampling the spine every `DASH_SAMPLE`
 * picture units makes every ribbon's dash the same size whatever its reach,
 * instead of a long cord wearing long dashes. Flat-ended, so a dash is a piece
 * of a cord and not a pill.
 */
const DASH_SAMPLE = 2
const DASH_SAMPLES = { min: 24, max: 192 } as const
/**
 * THE EXIT — where on the rim a ribbon leaves. Its bearing is read against a
 * point {@link EXIT_REACH} radii out on the free side at the node's own height,
 * so near rows leave nearly level and far rows leave steeply: a fan of
 * bearings around the rim, the way hyphae leave the observatory's mass, rather
 * than every cord leaving one point on a bar. The shoulder holds that bearing
 * for {@link SHOULDER} radii before the cord bends toward its row.
 */
const EXIT_REACH = 2.2
const SHOULDER = 1.8

const TIP_RADIUS = 5.5

/** The point along a nothing-booked run's dissolve the motes are drawn at — fixed, so the drift is a still. */
const MOTE_PROGRESS = 0.5
const MOTE_SIZE = 0.18
const MOTE_PEAK = 0.55
const MOTE_SCALE = 0.45

/**
 * THE BODY — the checkpoint's likeness, in units of its radius, on the same
 * three-octave discipline as the observatory's mass (`marks/root.ts`):
 * unequal on purpose, so it has a direction to it; every lobe overlapping its
 * neighbours, so the field is one component at this melt.
 */
const BODY: readonly { id: string; angle: number; distance: number; radius: number }[] = [
  { id: 'body-0', angle: 0.3, distance: 0.07, radius: 0.6 },
  { id: 'body-1', angle: 1.9, distance: 0.3, radius: 0.5 },
  { id: 'body-2', angle: 3.9, distance: 0.33, radius: 0.46 },
  { id: 'body-3', angle: 0.9, distance: 0.62, radius: 0.3 },
  { id: 'body-4', angle: 2.7, distance: 0.66, radius: 0.27 },
  { id: 'body-5', angle: 4.6, distance: 0.6, radius: 0.31 },
  { id: 'body-6', angle: 5.6, distance: 0.72, radius: 0.22 },
  { id: 'body-7', angle: 1.4, distance: 0.76, radius: 0.19 },
]
const MELT = 0.13
const CELL = 0.078
const SMOOTHING = 2
/**
 * THE BODY, AS DEPTH — the observatory's own recipe (`marks/root.ts`), at the
 * lab's scale: the surface and the shells beneath it are levels of ONE scalar
 * field, walked once, painted outermost first and each nearly transparent, so
 * what the eye reads is the accumulation — thin at the skin, dense in the
 * middle — and no single step is an edge. The spacing widens toward the skin
 * (`bias` above 1), and the levels climb the tissue ramp as they deepen: the
 * ramp is declared ground-ward first, so "deeper" is "further from the ground"
 * in both worlds. Twelve levels, not eighteen: the mass is forty units across,
 * and twelve is where the steps stop showing at the scale a panel draws it.
 */
export const TISSUE_LEVELS = 12
const DEPTH = { reach: 0.6, bias: 1.4, alpha: 0.115 } as const
const RIND_ALPHA = 0.45
/** The heart's fan, held inside the skin — anatomy of the body, not hairs on it. */
const FAN_SCALE = 0.82
const FAN_ALPHA = 0.3
const FAN_WIDTH = 0.6

const RING_WIDTH = { min: 0.7, span: 1.6 } as const

/**
 * The picture's height for this many runs — one row each at most {@link PITCH_MAX}
 * apart, within sane bounds — plus a row per stub below the band, so a named
 * failure never lands on a run's line.
 */
export function canvasHeightFor(runCount: number, stubCount = 0): number {
  const wanted = BAND_TOP + Math.max(1, runCount) * PITCH_MAX + BAND_BOTTOM
  return Math.min(640, Math.max(160, wanted)) + Math.max(0, stubCount) * STUB_PITCH
}

// ── the layout ──────────────────────────────────────────────────────────────

export function layoutCanvas({
  experiment,
  checkpoint = null,
  failedArms = [],
  width = 1000,
  height,
  palette = DARK_PALETTE,
}: CanvasLayoutOptions): CanvasPicture {
  const runs = experiment.arms.flatMap((arm) => arm.runs.map((run) => ({ arm: arm.arm, run })))
  const h = height ?? canvasHeightFor(runs.length, failedArms.length)

  // THE ROOT'S TRUE X — through the one position function, never clamped.
  const fraction = checkpoint === null ? null : sessionFraction(checkpoint.sessionCutByte, checkpoint.sessionByteLength)
  const rootX = checkpoint === null ? AXIS_INSET : (markerX(checkpoint, width) ?? AXIS_INSET)
  const stubRows = failedArms.length * STUB_PITCH
  const band = { top: BAND_TOP, bottom: h - BAND_BOTTOM - stubRows }
  const root: Point = { x: rootX, y: (band.top + band.bottom) / 2 }

  // THE FREE SIDE. Past the flip the fan opens leftward; the reach is what
  // the room in that direction can hold, so a node never leaves the drawing.
  const direction: FanDirection = fraction !== null && fraction > FAN_FLIP_FRACTION ? 'left' : 'right'
  const dir = direction === 'right' ? 1 : -1
  const room = direction === 'right' ? width - AXIS_INSET - rootX : rootX - AXIS_INSET
  const reach = Math.max(REACH_MIN, Math.min(REACH_MAX, room - TIP_MARGIN))

  const pitch = runs.length <= 1 ? 0 : Math.min(PITCH_MAX, (band.bottom - band.top) / runs.length)
  const firstY = root.y - (pitch * (runs.length - 1)) / 2

  const bodyInk = ink(palette.register.body, 0.72)
  const tipInk = verdictInks(palette)
  const moteInk = palette.tissue[2] ?? palette.necrotic

  const ribbons: Ribbon[] = runs.map(({ arm, run }, index) => {
    const state = organismState(run.outcome?.verified)
    const grown = state === 'unmeasured' ? UNMEASURED_REACH : 1
    const node: Point = { x: root.x + dir * reach * grown, y: firstY + pitch * index }
    // The cord stops at the tip's rim, so a hollow ring is hollow — the verdict is drawn AT the node, not over its end.
    const spine = spineOf(root, { x: node.x - dir * TIP_RADIUS * 0.9, y: node.y }, dir)
    const width = costWidth(run.outcome?.costUsd ?? null)
    const shape: RibbonShape = {
      spine,
      widthRoot: width,
      widthTip: width * TIP_WIDTH,
      stops: [PINCH],
      dashed: true,
      caps: false,
      samples: dashSamples(spine),
    }
    const heading = tangentAt(spine, 1)
    const costUsd = run.outcome?.costUsd ?? null
    return {
      id: run.laneHandle,
      arm,
      run: run.run,
      state,
      costUsd,
      spine,
      shape,
      polygons: ribbonOutline(shape),
      width,
      ink: bodyInk,
      node,
      tangent: Math.atan2(heading.y, heading.x),
      tip: { form: TIP_FORM[state], ink: tipInk[state], radius: TIP_RADIUS },
      motes: costUsd === null ? absenceMotes(spine, run.laneHandle, moteInk) : [],
    }
  })

  // Stubs: from the rim's underside, the fan's way, down to a row of their own
  // below the band — present, named, not ribbons. The fan's way, because that
  // is where the room is; below the band, so the name never lands on a run.
  const stubs: Stub[] = failedArms.map((failed, index) => {
    const from: Point = { x: root.x + dir * ROOT_RADIUS * 0.55, y: root.y + ROOT_RADIUS * 0.8 }
    const tip: Point = { x: root.x + dir * (ROOT_RADIUS + 34 + index * 10), y: band.bottom + 10 + index * STUB_PITCH }
    const spine = smoothSpine([from, { x: from.x + dir * 6, y: (from.y + tip.y) / 2 }, tip], 12)
    return {
      arm: failed.arm,
      error: failed.error,
      spine,
      polygons: ribbonOutline({ spine, widthRoot: 1.6, widthTip: 0.3, taperTip: 0.5, samples: 12, caps: false }),
      ink: ink(palette.necrotic, 0.85),
      tip,
      at: { x: tip.x + dir * 8, y: tip.y },
    }
  })

  const hair = ink(palette.register.cold, 0.9)
  return {
    width,
    height: h,
    fraction,
    direction,
    axis: { y: AXIS_Y, from: AXIS_INSET, to: width - AXIS_INSET, ink: hair },
    drop: { x: root.x, from: AXIS_Y, to: root.y - ROOT_RADIUS, ink: hair },
    root: rootMass(root, ROOT_RADIUS, palette, experiment.checkpointId, runs.map((entry) => entry.run)),
    ribbons,
    stubs,
    // The same two hairlines a picked node wears in the observatory (`rootSpotlight`): a pointer, not a state — ice, never the alarm band.
    emphasis: { body: ink(palette.register.emphasis, 0.95), ring: ink(palette.register.data, 0.75) },
  }
}

/**
 * The spine: out of the rim on the run's OWN bearing (see {@link EXIT_REACH}),
 * held for a shoulder, then a gentle bend that arrives level at the node — the
 * way a hypha leaves the mass in the observatory rather than a comb's teeth
 * leaving a bar. Four waypoints, smoothed by the ribbon brush.
 */
function spineOf(root: Point, node: Point, dir: number): Point[] {
  const dx = node.x - root.x
  const dy = node.y - root.y
  const bearing = Math.atan2(dy, dir * ROOT_RADIUS * EXIT_REACH)
  const out = (radii: number): Point => ({ x: root.x + ROOT_RADIUS * radii * Math.cos(bearing), y: root.y + ROOT_RADIUS * radii * Math.sin(bearing) })
  const rim = out(0.94)
  const shoulder = out(SHOULDER)
  // The shoulder never reaches past the node's own level or its x: a short reach bends at once.
  const bend: Point = { x: root.x + dx * 0.62, y: root.y + dy * 0.93 }
  const waypoints: Point[] =
    Math.abs(shoulder.x - root.x) < Math.abs(dx) * 0.55 && Math.abs(shoulder.y - root.y) < Math.abs(dy) + ROOT_RADIUS
      ? [rim, shoulder, bend, node]
      : [rim, bend, node]
  return smoothSpine(waypoints, SPINE_SAMPLES)
}

/** How many samples this spine is dashed at — one every {@link DASH_SAMPLE} units, within bounds. */
function dashSamples(spine: readonly Point[]): number {
  let length = 0
  for (let i = 1; i < spine.length; i += 1) {
    const a = spine[i - 1] as Point
    const b = spine[i] as Point
    length += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return Math.max(DASH_SAMPLES.min, Math.min(DASH_SAMPLES.max, Math.round(length / DASH_SAMPLE)))
}

/**
 * The drift a nothing-booked run wears. The brush is handed a still dissolve
 * (`progress` fixed) so the positions and radii are its own; the ink is the
 * tissue step, held to the palette rather than the brush's cooling mix, so
 * every ink in this picture is a constant a law can name.
 */
function absenceMotes(spine: readonly Point[], seed: string, tissue: ScenePalette['tissue'][number]): Mote[] {
  const job: Dissolve = {
    cause: 'absorption',
    spine,
    progress: MOTE_PROGRESS,
    sizeFrac: MOTE_SIZE,
    family: tissue,
    seed,
    peak: MOTE_PEAK,
  }
  return dissolutionMotes(job, Number.POSITIVE_INFINITY).map((mote) => ({
    ...mote,
    // The brush's radii are the observatory's scale; a drift beside a floor-width ribbon is finer.
    radius: mote.radius * MOTE_SCALE,
    ink: ink(tissue, mote.ink.alpha),
  }))
}

/** The level `i` of {@link TISSUE_LEVELS} sits at, in units of the radius — the surface at 0, the deepest near `DEPTH.reach`. */
function depthAt(i: number): number {
  return -DEPTH.reach * (i / (TISSUE_LEVELS - 1)) ** DEPTH.bias
}

/**
 * THE ROOT-MASS: the checkpoint as tissue. Contour layers on the tissue ramp
 * — one sampling of the field, walked at every depth — the heart's hyphal fan
 * seeded by the checkpoint, and one growth ring per judged run.
 */
function rootMass(centre: Point, radius: number, palette: ScenePalette, checkpointId: string, runs: readonly LabRun[]): RootMass {
  const levels = Array.from({ length: TISSUE_LEVELS }, (_unused, i) => depthAt(i))
  const layers = contourLayers(
    {
      falloffs: BODY.map((part) => ({
        id: part.id,
        at: { x: centre.x + radius * part.distance * Math.cos(part.angle), y: centre.y + radius * part.distance * Math.sin(part.angle) },
        radius: radius * part.radius,
      })),
      origin: centre,
      melt: radius * MELT,
      cell: radius * CELL,
      smoothing: SMOOTHING,
    },
    levels.map((at, i) => ({ at: at * radius, ...(i === 0 ? {} : { smoothing: 1 }) })),
  )
  const step = (i: number) => palette.tissue[Math.min(palette.tissue.length - 1, i)] ?? palette.necrotic
  /** Which step of the ramp level `i` wears — the skin the ground-ward end, the core the far end. */
  const stepOfLevel = (i: number) => step(Math.floor((i / TISSUE_LEVELS) * palette.tissue.length))

  const judged = runs.filter((run) => run.outcome !== undefined && isCompletedVerdict(run.outcome.verified))
  const anatomy = heartAnatomy(
    judged.map((run) => ({ laneId: run.laneHandle, seed: run.laneHandle, sizeFrac: costFraction(run.outcome?.costUsd ?? null) })),
    checkpointId,
  )
  const place = (path: readonly Point[], scale: number): Point[] => path.map((p) => ({ x: centre.x + p.x * radius * scale, y: centre.y + p.y * radius * scale }))

  return {
    at: centre,
    radius,
    shells: [
      ...levels.map((_unused, i) => ({ rings: layers[i] ?? [], ink: ink(stepOfLevel(i), DEPTH.alpha) })),
      // The rind last: surface ring and the one just inside it, filled even-odd, so the band between them is the skin.
      { rings: [...(layers[0] ?? []), ...(layers[1] ?? [])], ink: ink(step(3), RIND_ALPHA) },
    ],
    fan: { paths: anatomy.fan.map((strand) => place(strand, FAN_SCALE)), ink: ink(step(3), FAN_ALPHA), width: FAN_WIDTH },
    rings: anatomy.rings.map((ring) => ({
      id: ring.laneId,
      ring: place(ring.ring, 1),
      ink: ink(step(4), 0.55),
      width: RING_WIDTH.min + RING_WIDTH.span * ring.sizeFrac,
    })),
    core: { radius: 2.2, ink: ink(palette.register.data, 0.55) },
  }
}

/** The nearest ribbon's node within `radius` of a point in picture units, or null. */
export function pickRibbon(picture: CanvasPicture, at: Point, radius: number): Ribbon | null {
  let best: Ribbon | null = null
  let bestDistance = radius
  for (const ribbon of picture.ribbons) {
    const distance = Math.hypot(ribbon.node.x - at.x, ribbon.node.y - at.y)
    if (distance < bestDistance) {
      bestDistance = distance
      best = ribbon
    }
  }
  return best
}

/** Where a ribbon's name sits: just past its tip on the free side, so it never crosses the fan. */
export function labelAnchor(picture: CanvasPicture, ribbon: Ribbon): Point {
  const dir = picture.direction === 'right' ? 1 : -1
  return pointAt([ribbon.node, { x: ribbon.node.x + dir * (TIP_RADIUS + 8), y: ribbon.node.y }], 1)
}
