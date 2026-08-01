import type { Fleet, Lane, PathologyKind } from '../fleet/index.js'
import { clamp01 } from './palette.js'
import { isAlarmRank } from './salience.js'

/**
 * WHERE THE MYCELIUM GROWS.
 *
 * Four facts carry meaning in the layout, and each one is a recorded fact rather
 * than a decoration:
 *
 * - **distance from the root-mass = recency.** A lane that just spoke is pulled
 *   in tight against the mass; as it falls silent its node drifts out and its
 *   thread stretches. A finished fleet and a working fleet therefore look
 *   categorically different with no text read at all.
 * - **thread width = work size.** Output tokens, log-scaled against the fleet's
 *   own busiest lane, tapering root→tip like a real hypha.
 * - **angular position = identity, and it is stable for the session** (graft
 *   g7). The angle comes from {@link Lane.slot} — assigned by first sighting in
 *   the derived model and never reshuffled by rank — so "72 lives at four
 *   o'clock" stays true while the attention ordering churns above it. Nothing
 *   here reads a pathology, a rank or a token count to decide where a lane sits.
 * - **length of the drawn thread = how grown-in it is** (graft g3). A lane
 *   discovered while we are watching grows out of the mass over
 *   {@link SETTLE_MS} rather than appearing at full length.
 *
 * The one honest caveat: the ring is subdivided by how many lanes there are, so
 * a *new dispatch* re-spaces everyone. That is a different fact from the one g7
 * protects against — a lane must not move because its mood changed — and even
 * spacing is what keeps twenty labels legible (ruling 31's collision trigger).
 * `geometry.test.ts` pins both halves: same lanes → same angles in any event
 * order, and a lane's angle is untouched by its rank, age or size.
 */

export interface Point {
  x: number
  y: number
}

export interface Knot {
  centre: Point
  radius: number
  /** Direction of the thread where the knot is tied — the orbit's zero phase. */
  tangent: number
}

export interface Rogue {
  /** Node → the fence it crossed. Stops short: a reach, not an arrival. */
  path: Point[]
  /** The lane whose fence claims the touched files, when the manifest named one. */
  victimId: string | null
}

export interface FilamentGeometry {
  /** Where it splits off the parent thread. 0 = root-mass, 1 = node. */
  at: number
  path: Point[]
  width: number
  /**
   * Finer hyphae in the bundle. This is request **volume**, not a count of
   * distinct subagents: the log names exactly three thread kinds, so a strand
   * count that implied otherwise would be an invented number. The honesty note
   * stands until the collectors name individual threads.
   */
  strands: Point[][]
  thread: string
}

export interface ThreadGeometry {
  laneId: string
  lane: Lane
  /** Stable for the session — see the note above. */
  angle: number
  /** Sampled centreline, root-mass rim → node. Everything else indexes into it. */
  path: Point[]
  node: Point
  /** Outward unit normal of the rim at this lane's angle — where its label goes. */
  outward: Point
  widthRoot: number
  widthTip: number
  /** 0–1, log-scaled output tokens against the fleet's busiest lane. */
  sizeFrac: number
  /** 0–1, where 0 = spoke just now and 1 = silent for {@link RECENCY_SPAN_MS}. */
  ageFrac: number
  /** 0–1 grow-in progress. 1 for every lane that was already there (graft g3). */
  growth: number
  filaments: FilamentGeometry[]
  knot: Knot | null
  rogue: Rogue | null
  label: { anchor: Point; align: 'left' | 'right' | 'centre' }
  /** The worst fault this lane carries — what the node's behaviour draws. */
  pathology: PathologyKind | null
  /** True at needs-you or broken: this lane's marks are exempt from every fade. */
  alarm: boolean
}

export interface SceneGeometry {
  width: number
  height: number
  centre: Point
  rootRadius: number
  /** Half-axes of the rim: where a fully-drifted node sits. */
  rx: number
  ry: number
  threads: ThreadGeometry[]
  byLane: Map<string, ThreadGeometry>
  /**
   * Ruling 31's named cheap retreat. `all` up to {@link LABELS_ALL_MAX} lanes;
   * past it only the hovered, spotlit and alarmed lanes are named. Lanes are
   * never hidden — that stayed off the table.
   */
  labelPolicy: 'all' | 'hover'
}

/** Silent this long and a lane has drifted all the way out to the rim. */
export const RECENCY_SPAN_MS = 10 * 60_000

/**
 * How long a newly discovered lane takes to grow in (graft g3). Long enough to
 * read as growth, short enough that it is over before anyone looks twice.
 * Matches `--duration-settle` in the theme.
 */
export const SETTLE_MS = 900

/**
 * Where labels stop being drawn for every lane. B and C independently predicted
 * label collisions near 30–35 lanes (ruling 31), so the retreat is armed just
 * below that — and at the twenty-lane fixture every label still renders.
 */
export const LABELS_ALL_MAX = 28

/** Neighbours leave the mass together and fan apart, the way hyphae do. */
const BUNDLE_SIZE = 4

const THREAD_SAMPLES = 44

/** Worst first: when a lane carries two faults, this one owns its node. */
const PATHOLOGY_PRIORITY: readonly PathologyKind[] = [
  'frozen',
  'looping',
  'waiting',
  'off-fence',
  'expensive',
]

export interface LayoutOptions {
  width: number
  height: number
  /**
   * The frame's clock. Recency is continuous, so a node's drift is carried
   * forward from the fleet snapshot by `now - fleet.now` rather than being read
   * straight off it — otherwise every lane would jump outward once a second, in
   * step, as the derived model is rebuilt. Ruling 32 blesses the glide.
   *
   * Measured *against the snapshot* rather than as an absolute instant, so a
   * pinned fleet rendered at its own `now` is exactly the still image the
   * snapshot describes. That is what makes a fixture screenshot reproducible.
   */
  now: number
  /** laneId → grow-in progress 0–1. Absent means "already grown" (graft g3). */
  growth?: ReadonlyMap<string, number>
}

export function layoutScene(fleet: Fleet, options: LayoutOptions): SceneGeometry {
  const { width, height, now } = options
  const centre: Point = { x: width / 2, y: height / 2 }
  // Big enough to read as the *mass* the threads are threaded into, rather than
  // as one more node that happens to sit in the middle.
  const rootRadius = Math.max(26, Math.min(width, height) * 0.11)

  // Labels live outside the nodes, so the rim has to leave them room — two lines
  // of 10px type radially outward, plus the widest lane name we might draw.
  const rx = Math.max(70, width / 2 - 116)
  const ry = Math.max(46, height / 2 - 32)

  // Slot order, not attention order: this is the whole of graft g7.
  const lanes = [...fleet.lanes].sort((a, b) => a.slot - b.slot)
  const angles = ringAngles(lanes.length, rx, ry)

  const maxOutput = Math.max(1, ...lanes.map((lane) => lane.outputTokens))
  const sinceSnapshot = Math.max(0, now - fleet.now)

  const threads: ThreadGeometry[] = []
  const byLane = new Map<string, ThreadGeometry>()

  lanes.forEach((lane, index) => {
    const angle = angles[index] as number
    const outward = rimNormal(angle, rx, ry)

    const ageFrac =
      lane.ageMs === null ? 0.98 : clamp01((lane.ageMs + sinceSnapshot) / RECENCY_SPAN_MS)
    const radial = 0.62 + 0.38 * easeOut(ageFrac)
    const rim: Point = {
      x: centre.x + rx * radial * Math.cos(angle),
      y: centre.y + ry * radial * Math.sin(angle),
    }

    // The bundle: a shared trunk the group leaves the mass through. Without it
    // twenty threads read as a starburst rather than as a network.
    const bundleAngle = angles[bundleLeader(index, lanes.length)] as number
    const bundle: Point = {
      x: centre.x + rx * 0.32 * Math.cos(bundleAngle),
      y: centre.y + ry * 0.32 * Math.sin(bundleAngle),
    }

    // It leaves the mass already leaning toward its bundle.
    const exitAngle = angle + angleDelta(angle, bundleAngle) * 0.6
    const root: Point = {
      x: centre.x + rootRadius * 0.94 * Math.cos(exitAngle),
      y: centre.y + rootRadius * 0.94 * Math.sin(exitAngle),
    }

    // A deterministic sideways lean, so no two threads are congruent and the
    // network looks grown rather than drafted. Keyed on the lane id, so it is
    // the same wander every frame and every session.
    //
    // Every thread gets a *minimum* bow, not just a random one: a lane whose
    // hash lands near the middle would otherwise run dead straight out of the
    // mass, and a straight line among curves reads as a beam rather than as a
    // hypha. The sign is the hash's; only the magnitude is floored.
    const perp: Point = { x: -outward.y, y: outward.x }
    const lean = hash(lane.id) - 0.5
    const wander =
      Math.sign(lean || 1) * (0.3 + Math.abs(lean) * 1.4) * Math.min(rx, ry) * 0.45
    const control: Point = {
      x: bundle.x + (rim.x - bundle.x) * 0.6 + perp.x * wander,
      y: bundle.y + (rim.y - bundle.y) * 0.6 + perp.y * wander,
    }

    const growth = clamp01(options.growth?.get(lane.id) ?? 1)
    const full = sampleCubic(root, bundle, control, rim, THREAD_SAMPLES)
    const path = growth >= 1 ? full : truncate(full, easeOut(growth))
    const node = path[path.length - 1] as Point

    const sizeFrac = clamp01(Math.log1p(lane.outputTokens) / Math.log1p(maxOutput))
    const widthRoot = 1.2 + 5 * sizeFrac
    const widthTip = 0.4 + 1.3 * sizeFrac

    const pathology =
      PATHOLOGY_PRIORITY.find((kind) => lane.pathologies.some((p) => p.kind === kind)) ?? null

    // Labels are pushed off the *rim*, not away from the centre: on the wide flat
    // ellipse a landscape panel produces, the two differ by 90° along the top and
    // bottom runs, and only the normal keeps a name clear of its neighbours.
    const reach = 12 + 6 * sizeFrac

    threads.push({
      laneId: lane.id,
      lane,
      angle,
      path,
      node,
      outward,
      widthRoot,
      widthTip,
      sizeFrac,
      ageFrac,
      growth,
      filaments: layoutFilaments(lane, path, widthTip, perp),
      knot: pathology === 'looping' ? knotAt(path, 0.78, 8 + 5 * sizeFrac) : null,
      rogue: null, // needs every node placed first; filled in below
      label: {
        anchor: { x: node.x + outward.x * reach, y: node.y + outward.y * reach },
        align: Math.abs(outward.x) < 0.5 ? 'centre' : outward.x > 0 ? 'left' : 'right',
      },
      pathology,
      alarm: isAlarmRank(lane.rank),
    })
  })

  for (const thread of threads) byLane.set(thread.laneId, thread)

  // A trespass reaches for the lane it trespassed against, so every node has to
  // exist before any rogue filament can be aimed. `lane.trespasses` is empty
  // whenever there was no manifest to judge against (ruling 19), which is what
  // makes OFF-FENCE structurally unable to appear on a guess.
  for (const thread of threads) {
    if (thread.lane.trespasses.length === 0) continue
    const victimId = victimLaneId(thread.lane, threads)
    const target = victimId === null ? outwardReach(thread, rx, ry) : byLane.get(victimId)?.node
    if (target === undefined || target === null) continue
    thread.rogue = { path: rogueFilament(thread.node, target), victimId }
  }

  return {
    width,
    height,
    centre,
    rootRadius,
    rx,
    ry,
    threads,
    byLane,
    labelPolicy: threads.length > LABELS_ALL_MAX ? 'hover' : 'all',
  }
}

// ── the ring ────────────────────────────────────────────────────────────────

/**
 * `count` angles spaced by equal **arc length** around the rim, starting at the
 * top and running clockwise.
 *
 * Equal arc rather than equal angle because the panel is wide and short: on a
 * 480×95 ellipse, equal angles pile a third of the fleet into the two ends where
 * there is no room for a label, while equal arc lays them out along the long
 * runs where there is. Deterministic in `(count, rx, ry)`, so a lane's angle is
 * still a pure function of its slot.
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

/** Outward unit normal of the ellipse at parametric `angle`. */
function rimNormal(angle: number, rx: number, ry: number): Point {
  const nx = Math.cos(angle) / rx
  const ny = Math.sin(angle) / ry
  const length = Math.hypot(nx, ny) || 1
  return { x: nx / length, y: ny / length }
}

function polar(rx: number, ry: number, angle: number): Point {
  return { x: rx * Math.cos(angle), y: ry * Math.sin(angle) }
}

/** The middle of this lane's bundle: whose angle the shared trunk leaves on. */
function bundleLeader(index: number, count: number): number {
  const first = Math.floor(index / BUNDLE_SIZE) * BUNDLE_SIZE
  const members = Math.min(BUNDLE_SIZE, count - first)
  return first + Math.floor((members - 1) / 2)
}

// ── second growth ───────────────────────────────────────────────────────────

function layoutFilaments(
  lane: Lane,
  path: readonly Point[],
  widthTip: number,
  perp: Point,
): FilamentGeometry[] {
  // The trunk *is* the main thread; only the other threads sprout filaments.
  const branching = lane.filaments.filter((f) => f.thread !== 'main')
  if (branching.length === 0) return []

  const busiest = Math.max(1, ...lane.filaments.map((f) => f.outputTokens))

  return branching.map((filament, i) => {
    const at = 0.58 + i * 0.14
    const origin = pointAt(path, at)
    const along = tangentAt(path, at)
    const side = i % 2 === 0 ? 1 : -1
    const share = clamp01(filament.outputTokens / busiest)
    const length = 24 + 32 * share

    const tip: Point = {
      x: origin.x + along.x * length * 0.55 + perp.x * side * length * 0.78,
      y: origin.y + along.y * length * 0.55 + perp.y * side * length * 0.78,
    }
    const control: Point = {
      x: origin.x + along.x * length * 0.62 + perp.x * side * length * 0.2,
      y: origin.y + along.y * length * 0.62 + perp.y * side * length * 0.2,
    }

    const count = 1 + Math.min(4, Math.floor(Math.log2(1 + filament.requestCount)))
    const strands: Point[][] = []
    for (let s = 0; s < count; s += 1) {
      const spread = (s - (count - 1) / 2) * 0.32
      strands.push(
        sampleQuad(
          origin,
          control,
          {
            x: tip.x + perp.x * side * spread * length * 0.5 + along.x * spread * length * 0.36,
            y: tip.y + perp.y * side * spread * length * 0.5 + along.y * spread * length * 0.36,
          },
          12,
        ),
      )
    }

    return {
      at,
      path: sampleQuad(origin, control, tip, 14),
      width: Math.max(0.35, widthTip * (0.55 + 0.5 * share)),
      strands,
      thread: filament.thread ?? 'unknown',
    }
  })
}

// ── faults with a shape ─────────────────────────────────────────────────────

/** A closed loop tied into the thread. A pulse going round it is going nowhere. */
function knotAt(path: readonly Point[], at: number, radius: number): Knot {
  const on = pointAt(path, at)
  const along = tangentAt(path, at)
  return {
    centre: { x: on.x + along.x * radius * 0.2, y: on.y + along.y * radius * 0.2 },
    radius,
    tangent: Math.atan2(along.y, along.x),
  }
}

/** A bowed reach from the offender's node into the ground it is touching. */
function rogueFilament(from: Point, target: Point): Point[] {
  const dx = target.x - from.x
  const dy = target.y - from.y
  const control: Point = {
    x: from.x + dx * 0.5 - dy * 0.16,
    y: from.y + dy * 0.5 + dx * 0.16,
  }
  // Stops short of the victim's node: it reached in, it did not arrive.
  return sampleQuad(from, control, { x: from.x + dx * 0.9, y: from.y + dy * 0.9 }, 22)
}

/** The manifest named a fence-owner; find the lane wearing that handle. */
function victimLaneId(lane: Lane, threads: readonly ThreadGeometry[]): string | null {
  for (const trespass of lane.trespasses) {
    if (trespass.victim === null) continue
    for (const thread of threads) {
      const other = thread.lane
      if (
        other.id === trespass.victim ||
        other.branch === trespass.victim ||
        other.handles.includes(trespass.victim)
      ) {
        return other.id
      }
    }
  }
  return null
}

/**
 * A trespass on nobody's fence still left the lane's own ground, so the filament
 * still crosses out — just past the rim rather than at another lane.
 */
function outwardReach(thread: ThreadGeometry, rx: number, ry: number): Point {
  const reach = Math.min(rx, ry) * 0.34
  return {
    x: thread.node.x + thread.outward.x * reach,
    y: thread.node.y + thread.outward.y * reach,
  }
}

// ── curves ──────────────────────────────────────────────────────────────────

function sampleCubic(p0: Point, p1: Point, p2: Point, p3: Point, steps: number): Point[] {
  const out: Point[] = []
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const u = 1 - t
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    })
  }
  return out
}

function sampleQuad(p0: Point, p1: Point, p2: Point, steps: number): Point[] {
  const out: Point[] = []
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const u = 1 - t
    out.push({
      x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
      y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
    })
  }
  return out
}

/** The first `fraction` of a path, resampled to the same point count. */
function truncate(path: readonly Point[], fraction: number): Point[] {
  const steps = path.length - 1
  const out: Point[] = []
  for (let i = 0; i <= steps; i += 1) out.push(pointAt(path, (i / steps) * clamp01(fraction)))
  return out
}

/** Point at `t` along a sampled path: 0 = root-mass, 1 = node. */
export function pointAt(path: readonly Point[], t: number): Point {
  if (path.length === 0) return { x: 0, y: 0 }
  const at = clamp01(t) * (path.length - 1)
  const i = Math.floor(at)
  const j = Math.min(path.length - 1, i + 1)
  const f = at - i
  const a = path[i] as Point
  const b = path[j] as Point
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
}

export function tangentAt(path: readonly Point[], t: number): Point {
  const a = pointAt(path, Math.max(0, t - 0.02))
  const b = pointAt(path, Math.min(1, t + 0.02))
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy) || 1
  return { x: dx / length, y: dy / length }
}

function angleDelta(from: number, to: number): number {
  let delta = to - from
  while (delta > Math.PI) delta -= 2 * Math.PI
  while (delta < -Math.PI) delta += 2 * Math.PI
  return delta
}

function easeOut(t: number): number {
  const k = clamp01(t)
  return 1 - (1 - k) * (1 - k)
}

/** Stable 0–1 from a string, so the wander is the same every frame. */
function hash(value: string): number {
  let h = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 10_000) / 10_000
}
