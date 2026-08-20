import { reduceAll } from '@rhizomorph/core'
import { buildFleet, fixtureHistory, fleet20Spec, manifestFor, type Fleet } from '../../fleet/index.js'
import { layoutScene, type Point } from '../geometry.js'
import { DARK_PALETTE } from '../palette.js'
import { breathOf, motionMode, type SceneFrame } from '../marks/index.js'
import { rootMarks } from '../marks/root.js'
import { PulseField } from '../pulses.js'
import { RETURN, returnAt, type RetireState } from '../retire.js'
import { salienceOf } from '../salience.js'

/**
 * THE MASS'S OWN PARITY EVIDENCE (#579).
 *
 * `contour.ts` now bakes the mass's field in unit space and *places* it by the
 * frame's own transform instead of re-sampling and re-walking it every frame.
 * The whole claim beside that saving is that **the scene is visually
 * unchanged**, and a claim like that is worth exactly what stands beside it:
 * this reads the mass's surface and every shell under it straight off
 * `rootMarks`, and `contour.test.ts` compares them against
 * `contour-before.json` — a file produced by running this same code against the
 * tree *before* the bake.
 *
 * It is a stricter check than a screenshot, and deliberately so. A pixel
 * comparison of an eighteen-level stack at five per cent alpha cannot resolve a
 * quarter-pixel move in the silhouette; these are the vertices themselves.
 *
 * **Nothing about the mass is restated here.** The melt, the pitch, the
 * smoothing and the depth stack all live in `marks/root.ts`, and this calls
 * `rootMarks` rather than rebuilding the spec — so this is the shape the scene
 * draws, not a shape shaped like it, and a retune of the body cannot leave the
 * evidence quietly measuring the old one.
 *
 * **The states are the ones that could break it**, since the bake is keyed on
 * the shape in units of the mass's own radius:
 *
 * - **breath** — the ±1.6% the mass is always doing, and the reason a cache
 *   keyed on the world-space field would never hit at all. Three phases.
 * - **growth** — landed work thickens the mass (prd6 ruling 2). The other pure
 *   scale change, and it deepens the depth stack with it (`depthsFor`), so the
 *   level list changes as well as the radius.
 * - **an arrival mid-withdraw** — a falloff that is not in the body table, on a
 *   bearing the body has no symmetry about. This is the case the bake *cannot*
 *   answer from a previous frame, and it has to come out identical anyway.
 * - **an off-centre panel** — a different origin and a different mass radius, so
 *   a placement that had quietly assumed the fixture's own centre would show.
 */

/** Pinned. Every duration in these states is measured from here. */
export const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

export interface ContourState {
  name: string
  size: { width: number; height: number }
  /** How many lanes have landed — the mass's growth, and its depth stack with it. */
  landed: number
  /** How far into the return those lanes are, or `null` for a fleet with none. */
  returnAtMs: number | null
  /** Where in the breath to sample. The mass is never not breathing. */
  breathAtMs: number
}

export const STATES: readonly ContourState[] = [
  { name: 'calm', size: { width: 900, height: 260 }, landed: 0, returnAtMs: null, breathAtMs: 0 },
  {
    name: 'calm-breathed',
    size: { width: 900, height: 260 },
    landed: 0,
    returnAtMs: null,
    breathAtMs: 1_700,
  },
  {
    name: 'calm-breathed-again',
    size: { width: 900, height: 260 },
    landed: 0,
    returnAtMs: null,
    breathAtMs: 3_100,
  },
  {
    name: 'grown',
    size: { width: 900, height: 260 },
    landed: 12,
    returnAtMs: RETURN.totalMs,
    breathAtMs: 900,
  },
  {
    name: 'arriving',
    size: { width: 900, height: 260 },
    landed: 6,
    returnAtMs: RETURN.tensionMs + RETURN.withdrawMs - 60,
    breathAtMs: 400,
  },
  {
    name: 'off-centre-panel',
    size: { width: 1280, height: 700 },
    landed: 3,
    returnAtMs: RETURN.totalMs,
    breathAtMs: 2_200,
  },
]

/** One level of the stack, digested. See {@link ContourDigest} for why not every vertex. */
export interface LevelDigest {
  rings: number
  vertices: number
  /** Sums rather than means: a mean can hide a compensating pair of moves. */
  sumX: number
  sumY: number
  minRadius: number
  maxRadius: number
}

/**
 * One state's mass.
 *
 * The **silhouette carries every vertex** — it is the ring the scene's laws
 * read, the edge the eye finds, and the only one worth a hundred kilobytes of
 * repository. The shells beneath it are digested instead: ring count, vertex
 * count, the coordinate sums and the radial extremes. That is enough that no
 * geometric change to a shell can pass — a shell that moved, gained a ring, lost
 * a vertex or changed size moves at least one of those numbers — without
 * carrying eighteen levels of point cloud in git for ever.
 */
export interface ContourDigest {
  name: string
  centre: Point
  /** How many marks `rootMarks` built for this state, contour and all. */
  marks: number
  /** Every vertex of the silhouette, one flat `x, y, x, y, …` array per ring. */
  surface: number[][]
  /** The rind and every shell under it, in the order the painter fills them. */
  levels: LevelDigest[]
}

export function contourDigests(): ContourDigest[] {
  return STATES.map(contourDigest)
}

export function contourDigest(state: ContourState): ContourDigest {
  const frame = frameFor(state)
  const marks = rootMarks(frame)
  const mass = marks.find((mark) => mark.role === 'root-mass')
  if (mass === undefined || mass.kind !== 'contour') {
    throw new Error(`${state.name}: rootMarks built no root-mass contour`)
  }

  const centre = frame.geometry.centre
  return {
    name: state.name,
    centre: { x: round(centre.x), y: round(centre.y) },
    marks: marks.length,
    surface: mass.rings.map((ring) => ring.flatMap((point) => [round(point.x), round(point.y)])),
    levels: (mass.shells ?? []).map((shell) => digest(shell.rings, centre)),
  }
}

/**
 * Six decimals. Far below anything a screen can show, and far above the bake's
 * own rounding — 1e-6 of a grid cell about 8 px across, i.e. eight nanometres of
 * picture — so a difference at this precision is a real one rather than the last
 * bit of a double moving.
 */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

function digest(rings: readonly (readonly Point[])[], about: Point): LevelDigest {
  let vertices = 0
  let sumX = 0
  let sumY = 0
  let minRadius = Number.POSITIVE_INFINITY
  let maxRadius = 0
  for (const ring of rings) {
    for (const point of ring) {
      vertices += 1
      sumX += point.x
      sumY += point.y
      const r = Math.hypot(point.x - about.x, point.y - about.y)
      if (r < minRadius) minRadius = r
      if (r > maxRadius) maxRadius = r
    }
  }
  return {
    rings: rings.length,
    vertices,
    sumX: round(sumX),
    sumY: round(sumY),
    minRadius: vertices === 0 ? 0 : round(minRadius),
    maxRadius: round(maxRadius),
  }
}

function fleetFor(): Fleet {
  return buildFleet(reduceAll(fixtureHistory(fleet20Spec(), NOW)), {
    now: NOW,
    manifest: manifestFor(fleet20Spec()),
  })
}

function frameFor(state: ContourState): SceneFrame {
  const fleet = fleetFor()
  const at = state.returnAtMs
  const retire: ReadonlyMap<string, RetireState> | undefined =
    at === null
      ? undefined
      : new Map(fleet.lanes.slice(0, state.landed).map((lane) => [lane.id, returnAt(at)]))

  const geometry = layoutScene(fleet, {
    ...state.size,
    now: NOW,
    ...(retire === undefined ? {} : { retire }),
  })

  const clock = NOW + state.breathAtMs
  return {
    fleet,
    geometry,
    field: new PulseField(),
    salience: salienceOf({ fleet, hoverId: null, selectedId: null }),
    now: clock,
    asOf: NOW,
    vibrancy: 1,
    reducedMotion: false,
    paused: false,
    breath: breathOf(clock, motionMode({ reducedMotion: false, paused: false })),
    palette: DARK_PALETTE,
  }
}
