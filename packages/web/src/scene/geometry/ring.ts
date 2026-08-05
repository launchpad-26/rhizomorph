import type { Lane } from '../../fleet/index.js'
import type { RetireState } from '../retire.js'
import type { Point } from './types.js'

/** Neighbours leave the mass together and fan apart, the way hyphae do. */
const BUNDLE_SIZE = 4

// ── seeds that germinate ────────────────────────────────────────────────────

/**
 * Living lane id → the retired lane whose seat and size it inherits
 * (prd6 ruling 3). A retired lane keeps its slot, so a returning handle grows
 * out of the seed already sitting at that angle instead of re-spacing the ring.
 *
 * **Handles, not ids**: a re-dispatch that reuses the branch is already the
 * same lane to `buildFleet`; this function exists for the case where the
 * identity moved (new worktree, new branch) and the handle workmux launched it
 * under is the only thread of continuity left.
 *
 * "Retired" means the registry's map, not `isRetired`: a lane whose cut is
 * still queued behind the structural cap is visibly living and not yet a seed
 * to grow from. At most one sprout per seed, earliest slot first, so two
 * returning lanes cannot claim the same ground.
 */
export function germination(
  lanes: readonly Lane[],
  retire: ReadonlyMap<string, RetireState> | undefined,
): Map<string, string> {
  const grown = new Map<string, string>()
  if (retire === undefined || retire.size === 0) return grown

  const seeds = lanes.filter((lane) => retire.has(lane.id))
  if (seeds.length === 0) return grown

  const taken = new Set<string>()
  for (const lane of lanes) {
    if (retire.has(lane.id)) continue
    const seed = seeds.find(
      (candidate) =>
        candidate.id !== lane.id &&
        !taken.has(candidate.id) &&
        candidate.handles.some((handle) => lane.handles.includes(handle)),
    )
    if (seed === undefined) continue
    taken.add(seed.id)
    grown.set(lane.id, seed.id)
  }
  return grown
}

// ── the ring ────────────────────────────────────────────────────────────────

/**
 * `count` angles spaced by equal **arc length** around the rim (not equal
 * angle — on a wide short panel that piles lanes into the two ends where
 * there's no room for a label), starting at the top and running clockwise.
 * Deterministic in `(count, rx, ry)`, so a lane's angle stays a pure function
 * of its slot.
 */
export function ringAngles(count: number, rx: number, ry: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [-Math.PI / 2]

  const steps = 720
  const cumulative: number[] = [0]
  let previous = polar(rx, ry, 0)
  for (let i = 1; i <= steps; i += 1) {
    const at = polar(rx, ry, (i / steps) * Math.PI * 2)
    cumulative.push((cumulative[i - 1] as number) + Math.hypot(at.x - previous.x, at.y - previous.y))
    previous = at
  }
  const total = cumulative[steps] as number

  const angles: number[] = []
  for (let n = 0; n < count; n += 1) {
    const wanted = (total * n) / count
    // The table is monotonic, so a linear walk is exact and needs no search.
    let i = 1
    while (i < steps && (cumulative[i] as number) < wanted) i += 1
    const before = cumulative[i - 1] as number
    const span = (cumulative[i] as number) - before
    const within = span === 0 ? 0 : (wanted - before) / span
    angles.push(-Math.PI / 2 + ((i - 1 + within) / steps) * Math.PI * 2)
  }
  return angles
}

/**
 * How much rim there is per lane, in px — the unit prd7 ruling 4's wander cap
 * is expressed in, as a *fraction of the spacing* rather than a pixel amount,
 * so the bound stays true at every fleet size and zoom (a fixed px wander
 * would be gentle on four lanes and cross a neighbour's line on thirty).
 * Ramanujan's ellipse perimeter, exact to a part in 10⁵ at any aspect ratio.
 */
export function rimSpacing(rx: number, ry: number, count: number): number {
  const perimeter = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)))
  return perimeter / Math.max(1, count)
}

/** Outward unit normal of the ellipse at parametric `angle`. */
export function rimNormal(angle: number, rx: number, ry: number): Point {
  const nx = Math.cos(angle) / rx
  const ny = Math.sin(angle) / ry
  const length = Math.hypot(nx, ny) || 1
  return { x: nx / length, y: ny / length }
}

function polar(rx: number, ry: number, angle: number): Point {
  return { x: rx * Math.cos(angle), y: ry * Math.sin(angle) }
}

/** The middle of this lane's bundle: whose angle the shared trunk leaves on. */
export function bundleLeader(index: number, count: number): number {
  const first = Math.floor(index / BUNDLE_SIZE) * BUNDLE_SIZE
  const members = Math.min(BUNDLE_SIZE, count - first)
  return first + Math.floor((members - 1) / 2)
}
