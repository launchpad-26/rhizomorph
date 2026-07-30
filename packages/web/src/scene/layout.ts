import type { SceneCommit, SceneModel, SceneStation } from './sceneModel.js'

/**
 * Pure geometry. Given a `SceneModel` and a clock, where does everything sit?
 *
 * Kept free of three.js so it is trivially unit-testable and so the renderer
 * stays a dumb consumer: layout decides, `Constellation` draws.
 */

export type Vec3 = readonly [number, number, number]

export const TRUNK_HEIGHT = 6
/** Closest a station ever orbits; branches push out as commits land. */
export const BASE_RADIUS = 2.8
export const COMMIT_RADIUS_STEP = 0.06
export const MAX_RADIUS = 6.4
/** How long a removed worktree takes to converge into the trunk and fade. */
export const CONVERGENCE_MS = 2_600
/** Hard ceiling on instanced commit beads — perf floor, not a data limit. */
export const MAX_BEADS = 1_200
/** Newest N commits drawn per branch; older ones are folded into the length. */
export const MAX_BEADS_PER_BRANCH = 80
/** A branch's vertical rise per commit it holds ahead of main. */
export const TILT_PER_AHEAD = 0.05
/** Ceiling on that rise, so a very ahead branch doesn't fly off-screen. */
export const MAX_TILT = 1.6

export interface CommitBead {
  commit: SceneCommit
  stationId: string
  position: Vec3
  /** 0 = oldest drawn on this branch, 1 = newest. Drives brightness. */
  recency: number
  /** Beads on the main trunk read colder than branch beads. */
  onTrunk: boolean
}

export interface BranchLayout {
  station: SceneStation
  /** Where the branch leaves the trunk. */
  anchor: Vec3
  /** Where the station sits — the far tip of the branch. */
  tip: Vec3
  angle: number
  radius: number
  beads: CommitBead[]
  /** 0 while alive, → 1 as a removed worktree converges into the trunk. */
  convergence: number
  /** Renderable at all? False once a removed station has fully converged. */
  visible: boolean
}

export interface SceneLayout {
  trunkTop: Vec3
  trunkBottom: Vec3
  trunkBeads: CommitBead[]
  branches: BranchLayout[]
  /** Every bead in one array, ready for a single instanced draw. */
  beads: CommitBead[]
}

export const EMPTY_LAYOUT: SceneLayout = {
  trunkTop: [0, TRUNK_HEIGHT / 2, 0],
  trunkBottom: [0, -TRUNK_HEIGHT / 2, 0],
  trunkBeads: [],
  branches: [],
  beads: [],
}

/**
 * `now` is wall-clock time: it only drives the convergence animation, so a
 * historical (replayed) removal simply arrives already converged.
 */
export function layoutScene(model: SceneModel, now: number): SceneLayout {
  const stations = model.stations
  const count = stations.length

  const branches: BranchLayout[] = stations.map((station, index) => {
    const angle = ((index + 0.5) / Math.max(count, 1)) * Math.PI * 2
    const anchorY = -TRUNK_HEIGHT / 2 + ((index + 1) / (count + 1)) * TRUNK_HEIGHT
    const anchor: Vec3 = [0, anchorY, 0]

    const radius = Math.min(
      MAX_RADIUS,
      BASE_RADIUS + station.commits.length * COMMIT_RADIUS_STEP,
    )
    // Vertical rise reads as progress: a branch pulled further ahead of main
    // sits higher, not just further out.
    const tilt =
      station.aheadOfMain === null ? 0 : Math.min(station.aheadOfMain * TILT_PER_AHEAD, MAX_TILT)
    const tip: Vec3 = [Math.cos(angle) * radius, anchorY + tilt, Math.sin(angle) * radius]

    const convergence =
      station.removedAt === null
        ? 0
        : clamp01((now - station.removedAt) / CONVERGENCE_MS)

    return {
      station,
      anchor,
      tip,
      angle,
      radius,
      beads: beadsAlong(station, anchor, tip),
      convergence,
      visible: station.removedAt === null || convergence < 1,
    }
  })

  const trunkBottom: Vec3 = [0, -TRUNK_HEIGHT / 2, 0]
  const trunkTop: Vec3 = [0, TRUNK_HEIGHT / 2, 0]
  const trunkBeads =
    model.trunk === null ? [] : beadsAlong(model.trunk, trunkBottom, trunkTop, true)

  const beads: CommitBead[] = [...trunkBeads]
  for (const branch of branches) {
    if (!branch.visible) continue
    for (const bead of branch.beads) {
      if (beads.length >= MAX_BEADS) break
      beads.push(bead)
    }
  }

  return { trunkTop, trunkBottom, trunkBeads, branches, beads }
}

/** Evenly spaces a station's newest commits along its line, oldest inward. */
function beadsAlong(
  station: SceneStation,
  from: Vec3,
  to: Vec3,
  onTrunk = false,
): CommitBead[] {
  const drawn = station.commits.slice(-MAX_BEADS_PER_BRANCH)
  const total = drawn.length
  return drawn.map((commit, index) => ({
    commit,
    stationId: station.id,
    position: lerp3(from, to, (index + 1) / (total + 1)),
    recency: total <= 1 ? 1 : index / (total - 1),
    onTrunk,
  }))
}

export function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** Where a station actually renders, once convergence has pulled it inward. */
export function stationPosition(branch: BranchLayout): Vec3 {
  return branch.convergence === 0
    ? branch.tip
    : lerp3(branch.tip, branch.anchor, easeIn(branch.convergence))
}

/** Mutable copy — three.js props reject readonly tuples. */
export function toTuple(v: Vec3): [number, number, number] {
  return [v[0], v[1], v[2]]
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function easeIn(t: number): number {
  return t * t
}
