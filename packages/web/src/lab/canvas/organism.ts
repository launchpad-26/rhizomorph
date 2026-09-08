import { BROKEN, DONE, ICE_300, ink, type Ink, NECROTIC, WORKING } from '../../scene/palette.js'
import { AXIS_INSET, markerX } from '../axis/position.js'
import type { Point } from '../branching/index.js'
import type { FailedArm } from '../compare/types.js'
import type { LabCheckpoint, LabExperiment } from '../types.js'

/**
 * THE LANE CANVAS (prd53 ruling 5, #329): n ORGANISMS, one per run — never a
 * synthesised count. Each dispatch record the fold holds becomes exactly one
 * organism here, keyed by its lane handle; an arm the launch asked for that
 * never dispatched is a STUB, drawn and named, and not counted among them
 * (ruling 7). `organism.test.ts`'s law: `organisms.length === runs.length`,
 * and the ids are the run handles, as a set.
 *
 * This is a different surface from the scene (charter §8, coexist-by-surface;
 * ruling 8): the scene draws ONE organism through `scene/`; the lab draws n
 * small ones in its own SVG, reading only the scene's PALETTE through its
 * public exports (`no-live-fleet-law`'s named exception) — and never its fold.
 *
 * What the shape says, and from which fact:
 * - the ROOT-MASS is the checkpoint, at the fork's x on the session axis
 *   (`axis/position.ts` — the one function), or at the inset when unplaced;
 * - each THREAD is one run, fanned by arm then run — angle is identity, stable
 *   for the experiment (graft g7's rule, restated);
 * - thread LENGTH is whether the run has been measured — a measured run has
 *   grown in, an unmeasured one is still reaching (grow-in, graft g3);
 * - thread WIDTH is booked cost on an ABSOLUTE scale ({@link costWidth}),
 *   never relative to its siblings (prd6 ruling 1's rule, kept);
 * - the NODE's ink is the verdict: pass `DONE`, fail `BROKEN`, not-run
 *   `NECROTIC` (dead tissue), unmeasured `WORKING` (still live).
 * Every organism wears `SYNTHETIC_DASH`-style dashing's meaning: this is a
 * forked reality, never live fleet history (prd12 ruling 3).
 */

export type OrganismState = 'unmeasured' | 'passed' | 'failed' | 'not-run'

export interface Organism {
  /** The run's lane handle — the record's own key, never invented. */
  id: string
  arm: number
  run: number
  state: OrganismState
  /** Root-mass rim → node. */
  path: readonly Point[]
  node: Point
  width: number
  ink: Ink
  nodeInk: Ink
}

export interface FailedStub {
  arm: number
  error: string
  at: Point
}

export interface CanvasLayout {
  width: number
  height: number
  root: { at: Point; radius: number; ink: Ink }
  organisms: readonly Organism[]
  /** Arms that never dispatched — drawn, named, and NOT organisms. */
  stubs: readonly FailedStub[]
}

export interface CanvasLayoutOptions {
  experiment: LabExperiment
  /** The checkpoint the experiment was forked from — places the root on the session axis. */
  checkpoint?: LabCheckpoint | null
  failedArms?: readonly FailedArm[]
  width?: number
  height?: number
}

/** Width floor and cap, in viewBox units — an absolute scale over booked dollars, log-spaced from a cent to ten dollars. */
export const WIDTH_FLOOR = 1.25
export const WIDTH_CAP = 6
const COST_MIN = 0.01
const COST_MAX = 10

/** Booked cost → thread width. Null (nothing booked) is the floor: a thread that is there, and thin. Never fleet-relative. */
export function costWidth(costUsd: number | null): number {
  if (costUsd === null || !Number.isFinite(costUsd) || costUsd <= COST_MIN) return WIDTH_FLOOR
  if (costUsd >= COST_MAX) return WIDTH_CAP
  const t = (Math.log(costUsd) - Math.log(COST_MIN)) / (Math.log(COST_MAX) - Math.log(COST_MIN))
  return Math.round((WIDTH_FLOOR + t * (WIDTH_CAP - WIDTH_FLOOR)) * 100) / 100
}

export function organismState(verified: 'pass' | 'fail' | 'not-run' | undefined): OrganismState {
  if (verified === undefined) return 'unmeasured'
  if (verified === 'pass') return 'passed'
  if (verified === 'fail') return 'failed'
  return 'not-run'
}

const NODE_INK: Readonly<Record<OrganismState, Ink>> = {
  unmeasured: ink(WORKING, 0.85),
  passed: ink(DONE, 0.9),
  failed: ink(BROKEN, 0.9),
  'not-run': ink(NECROTIC, 0.9),
}

const THREAD_INK = ink(ICE_300, 0.75)
const ROOT_INK = ink(ICE_300, 0.35)

/** The fan: ±60° around horizontal, evenly by position — identity, stable for the experiment. */
function angleFor(index: number, count: number): number {
  if (count === 1) return 0
  const spread = Math.PI / 1.5
  return -spread / 2 + (spread * index) / (count - 1)
}

export function layoutCanvas({ experiment, checkpoint = null, failedArms = [], width = 480, height = 160 }: CanvasLayoutOptions): CanvasLayout {
  const rootRadius = 9
  const rootX = checkpoint === null ? AXIS_INSET : (markerX(checkpoint, width) ?? AXIS_INSET)
  const root = { x: rootX, y: height / 2 }
  const reach = Math.max(40, Math.min(width - rootX - 24, height / 2 - 12))

  // Exactly the dispatch records, arm-major then run — one organism each.
  const runs = experiment.arms.flatMap((arm) => arm.runs.map((run) => ({ arm: arm.arm, run })))
  const organisms: Organism[] = runs.map(({ arm, run }, index) => {
    const state = organismState(run.outcome?.verified)
    const grown = state === 'unmeasured' ? 0.62 : 1
    const angle = angleFor(index, runs.length)
    const length = rootRadius + (reach - rootRadius) * grown
    const node = { x: root.x + Math.cos(angle) * length, y: root.y + Math.sin(angle) * length }
    const rim = { x: root.x + Math.cos(angle) * rootRadius, y: root.y + Math.sin(angle) * rootRadius }
    const mid = { x: (rim.x + node.x) / 2 + Math.sin(angle) * 6, y: (rim.y + node.y) / 2 - Math.cos(angle) * 6 }
    return {
      id: run.laneHandle,
      arm,
      run: run.run,
      state,
      path: [rim, mid, node],
      node,
      width: costWidth(run.outcome?.costUsd ?? null),
      ink: THREAD_INK,
      nodeInk: NODE_INK[state],
    }
  })

  // Failed arms: stubs at the rim, below the fan — present, named, not organisms.
  const stubs: FailedStub[] = failedArms.map((failed, index) => ({
    arm: failed.arm,
    error: failed.error,
    at: { x: root.x + 14 + index * 12, y: root.y + rootRadius + 10 },
  }))

  return { width, height, root: { at: root, radius: rootRadius, ink: ROOT_INK }, organisms, stubs }
}
