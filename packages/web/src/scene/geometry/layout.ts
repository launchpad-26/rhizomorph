import type { Fleet, Lane, PathologyKind } from '../../fleet/index.js'
import { clamp01 } from '../palette.js'
import type { RetireState } from '../retire.js'
import { smoothSpine } from '../ribbon.js'
import { isAlarmRank } from '../salience.js'
import { WANDER_MAX_SPACING, variationFor, variationSeed } from '../variation.js'
import { layoutBud } from './bud.js'
import { angleDelta, cubicPoint, easeOut, hash, truncate } from './curves.js'
import { layoutFilaments } from './filaments.js'
import { knotAt, outwardReach, rogueFilament, victimLaneId } from './faults.js'
import { persistence, relaxRest, released } from './return.js'
import { bundleLeader, germination, rimNormal, ringAngles, rimSpacing } from './ring.js'
import {
  LABELS_ALL_MAX,
  RADIAL_RIM,
  RECENCY_SPAN_MS,
  bornRadial,
  bundleRadial,
  lifecycleFrac,
  relaxReachPx,
  rootFullness,
  rootRadiusFor,
  seedSize,
} from './scale.js'
import type {
  BudGeometry,
  FilamentGeometry,
  LayoutOptions,
  Point,
  SceneGeometry,
  ThreadGeometry,
} from './types.js'

const THREAD_SAMPLES = 44

/**
 * How many data waypoints a thread's spine is built from before centripetal
 * Catmull-Rom smooths it (prd7 ruling 3). Sparse on purpose: the waypoints are
 * where the *encoding* lives (exit from the mass, lean into the bundle, node
 * at its lifecycle radius), and Catmull-Rom interpolates each exactly — dense
 * sampling would be the same picture at higher cost with nothing left to
 * interpolate.
 */
const SPINE_SEGMENTS = 8

/** Worst first: when a lane carries two faults, this one owns its node. */
const PATHOLOGY_PRIORITY: readonly PathologyKind[] = [
  'frozen',
  'looping',
  'waiting',
  'off-fence',
  'expensive',
]

/**
 * THE DRIFT BAND (#117) — how far a finished lane's *tip* relaxes outward, on
 * top of the lifecycle pin's own journey to the rim: a local bend, each lane
 * by its own amount between `min` and `max`. See
 * docs/design-notes/geometry-relax-reach.md for why a band and why seeded from
 * the lane's identity rather than from when it retired.
 *
 * Outward only, so a retired lane stays at the rim or past it and a living
 * one stays inside it — no amount of scatter may blur that line.
 */
const RETIRE_RELAX_PX = { min: 3, max: 27 } as const

/**
 * How far the root end of the thread bows out as the tension leaves it, as a
 * fraction of the smaller rim half-axis — clamped, so the slack is the same
 * perceptible sag on a tall panel and on a letterbox one.
 */
const SLACK_FRACTION = 0.06
const SLACK_MIN_PX = 4
const SLACK_MAX_PX = 12
/**
 * …times the lane's own habit. The same free phase the drift band reads, taken
 * the other way round, so a lane that springs a long way out sags a little less
 * on the way and no two cuts have the same silhouette. Both ends of the range
 * are above zero: a cord that went slack by nothing would not have gone slack,
 * and `geometry.test.ts` measures that the loosening is a root-end fact.
 */
const SLACK_HABIT = { min: 0.7, max: 1.5 } as const

/**
 * A THREAD'S SPINE, EXACTLY ONCE for a settled retired lane (#178). Still is
 * load-bearing (prd10 ruling 14) — nothing here may animate a settled cut, so
 * once the caller decides a lane's return is over, calling this again can
 * only reproduce the same points. See docs/design-notes/geometry-cache-audit-178.md.
 */
interface ThreadSpine {
  path: Point[]
  filaments: FilamentGeometry[]
  bud: BudGeometry | null
}

function layoutSpine(
  lane: Lane,
  outward: Point,
  root: Point,
  bundle: Point,
  rim: Point,
  rx: number,
  ry: number,
  sizeFrac: number,
  widthTip: number,
  spacing: number,
  growth: number,
  cut: RetireState | null,
  now: number,
): ThreadSpine {
  // Deterministic sideways lean, keyed on the lane id (same wander every frame
  // and session). Every thread gets a *minimum* bow — sign from the hash,
  // magnitude floored — so a lane whose hash lands near the middle doesn't run
  // dead straight and read as a beam among curves.
  const perp: Point = { x: -outward.y, y: outward.x }
  const lean = hash(lane.id) - 0.5
  const wander = Math.sign(lean || 1) * (0.3 + Math.abs(lean) * 1.4) * Math.min(rx, ry) * 0.45
  const control: Point = {
    x: bundle.x + (rim.x - bundle.x) * 0.6 + perp.x * wander,
    y: bundle.y + (rim.y - bundle.y) * 0.6 + perp.y * wander,
  }

  // THE SPINE (prd7 rulings 3–4) — see the file header for the wander bound
  // this nudge respects.
  const sway = WANDER_MAX_SPACING * spacing
  const variation = variationFor(variationSeed(lane))
  const waypoints: Point[] = []
  for (let i = 0; i <= SPINE_SEGMENTS; i += 1) {
    const t = i / SPINE_SEGMENTS
    const on = cubicPoint(root, bundle, control, rim, t)
    const off = sway * variation.wander(t)
    waypoints.push({ x: on.x + perp.x * off, y: on.y + perp.y * off })
  }

  const full = smoothSpine(waypoints, THREAD_SAMPLES)
  const grown = growth >= 1 ? full : truncate(full, easeOut(growth))

  // The lane's own free phase (`variation.ts`'s `curl`), spent on the two
  // things about a return that carry nothing: how far its tip relaxes past the
  // rim, and how deeply the released strand sags. Two lanes that finished the
  // same work still let go differently — see docs/design-notes/geometry-relax-reach.md
  // (#117) for why a rim where they did not is a problem.
  const habit = variation.curl
  const relax = RETIRE_RELAX_PX.min + (RETIRE_RELAX_PX.max - RETIRE_RELAX_PX.min) * habit
  const slack =
    Math.min(SLACK_MAX_PX, Math.max(SLACK_MIN_PX, Math.min(rx, ry) * SLACK_FRACTION)) *
    (SLACK_HABIT.min + (SLACK_HABIT.max - SLACK_HABIT.min) * (1 - habit))
  // How much of the strand the outward relax is allowed to bend, measured in px
  // of arc off the lane's own work-size. Measured on the thread as it *was*,
  // because this is the number the deformation is computed from and the stretch
  // it bends cannot shift under the bending.
  const rest = cut === null ? 1 : relaxRest(grown, relaxReachPx(sizeFrac))
  const path =
    cut === null
      ? grown
      : released(grown, {
          along: perp,
          side: Math.sign(lean || 1),
          slack: slack * cut.tension,
          outward,
          drift: relax * cut.drift,
          from: rest,
        })

  return {
    path,
    filaments: layoutFilaments(lane, path, widthTip, perp),
    // A retiring lane grows no bud: whatever it had handed out, it has finished.
    bud: cut === null ? layoutBud(lane, path, perp, now, variation.phase) : null,
  }
}

/** A hideable lane's spine is `[]`, never built. See docs/design-notes/geometry-cache-audit-178.md. */
const EMPTY_PATH: readonly Point[] = []
const EMPTY_FILAMENTS: readonly FilamentGeometry[] = []

/**
 * One generation of settled spines, dropped whole (not pruned) whenever the
 * `world` they were built in moves — every entry was keyed to a world that no
 * longer exists. See {@link layoutScene}'s own `world` and
 * docs/design-notes/geometry-cache-audit-178.md.
 */
let retiredSpineCache: { world: string; entries: Map<string, ThreadSpine> } | null = null

function retiredSpineCacheFor(world: string): Map<string, ThreadSpine> {
  if (retiredSpineCache === null || retiredSpineCache.world !== world) {
    retiredSpineCache = { world, entries: new Map() }
  }
  return retiredSpineCache.entries
}

export function layoutScene(fleet: Fleet, options: LayoutOptions): SceneGeometry {
  const { width, height, now } = options
  const centre: Point = { x: width / 2, y: height / 2 }
  // Big enough to read as the *mass* the threads are threaded into, rather than
  // as one more node that happens to sit in the middle. This is the mass at rest,
  // before anything has landed on it — a quiet session's centre, and the floor
  // the un-instrumented case sits at.
  const resting = Math.max(26, Math.min(width, height) * 0.11)

  // Labels live outside the nodes, so the rim has to leave them room — two lines
  // of 10px type radially outward, plus the widest lane name we might draw.
  const rx = Math.max(70, width / 2 - 116)
  const ry = Math.max(46, height / 2 - 32)

  // Slot order, not attention order: this is the whole of graft g7.
  const lanes = [...fleet.lanes].sort((a, b) => a.slot - b.slot)
  const byId = new Map(lanes.map((lane) => [lane.id, lane]))

  // Seats, not lanes: a re-dispatched handle shares the seat of the seed it grew
  // out of, so a returning lane never re-spaces the ring (prd6 ruling 3).
  const seedOf = germination(lanes, options.retire)
  const seatKey = (lane: Lane): number => {
    const seed = seedOf.get(lane.id)
    return seed === undefined ? lane.slot : (byId.get(seed)?.slot ?? lane.slot)
  }
  const seatKeys = [...new Set(lanes.map(seatKey))].sort((a, b) => a - b)
  const seatOf = new Map(seatKeys.map((key, i) => [key, i]))
  const angles = ringAngles(seatKeys.length, rx, ry)
  const spacing = rimSpacing(rx, ry, seatKeys.length)

  // THE MASS, AS THIS FRAME DRAWS IT (prd6 ruling 2, #118). Read off the
  // registry rather than off `isRetired`, so a landing still queued behind the
  // structural cap has not arrived here either. Hiding finished lanes must not
  // affect this sum: it's a request about clutter, not a claim work was undone.
  //
  // `clamp01(cut.withdraw)` deliberately duplicates `retire.ts`'s `homecoming`
  // rather than importing it: `motion.ts` imports this file and `retire.ts`
  // imports `motion.ts`, so importing from `retire.ts` here would close a
  // cycle. The dependency on `retire.ts` stays type-only; `geometry.test.ts`
  // pins the two readings equal so the copy cannot drift.
  let landedOutputTokens = 0
  for (const lane of lanes) {
    const cut = options.retire?.get(lane.id)
    if (cut === undefined) continue
    landedOutputTokens += lane.outputTokens * clamp01(cut.withdraw)
  }
  const fullness = rootFullness(landedOutputTokens)
  const rootRadius = rootRadiusFor(resting, rx, ry, fullness)

  const born = bornRadial(rootRadius, rx, ry)
  const bundleAt = bundleRadial(rootRadius, rx, ry)

  const sinceSnapshot = Math.max(0, now - fleet.now)

  // ONE WORLD-FRAME SIGNATURE FOR THIS FRAME — everything outside a single
  // lane that its cached spine is a function of. See
  // docs/design-notes/geometry-cache-audit-178.md for why each term is here and
  // what a lane's own per-lane cache key (below) carries instead.
  const world = `${width}x${height}|${rootRadius.toFixed(3)}|${spacing.toFixed(3)}`

  const threads: ThreadGeometry[] = []
  const byLane = new Map<string, ThreadGeometry>()

  lanes.forEach((lane) => {
    const seat = seatOf.get(seatKey(lane)) as number
    const angle = angles[seat] as number
    const outward = rimNormal(angle, rx, ry)

    // Absolute, and floored by whatever the seed this lane grew from had already
    // accomplished: a germinated lane does not start over from nothing, because
    // the handle that came back is the same worker returning to the same ground.
    const seed = seedOf.get(lane.id)
    const seedLane = seed === undefined ? undefined : byId.get(seed)
    const sizeFrac = Math.max(
      seedSize(lane.outputTokens),
      seedLane === undefined ? 0 : seedSize(seedLane.outputTokens),
    )
    const widthRoot = 1.2 + 5 * sizeFrac
    const widthTip = 0.4 + 1.3 * sizeFrac

    const ageFrac =
      lane.ageMs === null ? 0.98 : clamp01((lane.ageMs + sinceSnapshot) / RECENCY_SPAN_MS)

    // The cut's first two stages are deformations of the thread rather than
    // separate marks: the slack bows the root end out, and the drift carries the
    // last stretch — the part that becomes the scar — outward. Its withdraw is also
    // what carries the lane the last of the way to the rim.
    const cut = options.retire?.get(lane.id) ?? null

    // Distance is the lifecycle, not recency (prd6 ruling 4).
    const lifeFrac = lifecycleFrac(sizeFrac, now - lane.firstSeenAt, cut?.drift ?? 0)
    const radial = born + (RADIAL_RIM - born) * lifeFrac
    const rim: Point = {
      x: centre.x + rx * radial * Math.cos(angle),
      y: centre.y + ry * radial * Math.sin(angle),
    }

    // The bundle: a shared trunk the group leaves the mass through. Without it
    // twenty threads read as a starburst rather than as a network.
    const bundleAngle = angles[bundleLeader(seat, seatKeys.length)] as number
    const bundle: Point = {
      x: centre.x + rx * bundleAt * Math.cos(bundleAngle),
      y: centre.y + ry * bundleAt * Math.sin(bundleAngle),
    }

    // It leaves the mass already leaning toward its bundle.
    const exitAngle = angle + angleDelta(angle, bundleAngle) * 0.6
    const root: Point = {
      x: centre.x + rootRadius * 0.94 * Math.cos(exitAngle),
      y: centre.y + rootRadius * 0.94 * Math.sin(exitAngle),
    }

    const growth = clamp01(options.growth?.get(lane.id) ?? 1)

    // HIDE FINISHED SKIPS LAYOUT TOO (prd10 ruling 16) — every mark builder
    // that touches a retired thread must check `cut.hidden` before touching
    // `path`/`node` (`marks/thread.ts`, `marks/node.ts`, `marks/dissolve.ts`).
    // See docs/design-notes/geometry-cache-audit-178.md.
    const hideable = cut !== null && cut.stage === 'persistent' && options.hideFinished === true

    // SETTLED, AND CACHEABLE: gated on `cut.dissolve >= 1`, not
    // `cut.stage === 'persistent'` alone — see the decision doc above.
    const settled = cut !== null && cut.dissolve >= 1

    let path: readonly Point[]
    let filaments: readonly FilamentGeometry[]
    let bud: BudGeometry | null = null

    if (hideable) {
      path = EMPTY_PATH
      filaments = EMPTY_FILAMENTS
    } else if (settled) {
      const key = `${lane.id}|${angle.toFixed(6)}|${bundleAngle.toFixed(6)}|${cut.drift}`
      const cache = retiredSpineCacheFor(world)
      const known = cache.get(key)
      if (known === undefined) {
        const built = layoutSpine(
          lane,
          outward,
          root,
          bundle,
          rim,
          rx,
          ry,
          sizeFrac,
          widthTip,
          spacing,
          growth,
          cut,
          now,
        )
        cache.set(key, built)
        path = built.path
        filaments = built.filaments
      } else {
        path = known.path
        filaments = known.filaments
      }
    } else {
      const built = layoutSpine(
        lane,
        outward,
        root,
        bundle,
        rim,
        rx,
        ry,
        sizeFrac,
        widthTip,
        spacing,
        growth,
        cut,
        now,
      )
      path = built.path
      filaments = built.filaments
      bud = built.bud
    }

    // No re-measurement of the drawn arc after release: work-size is the
    // strand's own width, unbroken from mass to node, not the arc length of a
    // stub (ruling 13). See docs/design-notes/geometry-return-as-shape.md.
    const node = path.length > 0 ? (path[path.length - 1] as Point) : rim

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
      path: path as Point[],
      node,
      outward,
      widthRoot,
      widthTip,
      sizeFrac,
      ageFrac,
      lifeFrac,
      germinatedFrom: seed ?? null,
      growth,
      filaments: filaments as FilamentGeometry[],
      bud,
      knot: pathology === 'looping' ? knotAt(path, 0.78, 8 + 5 * sizeFrac) : null,
      rogue: null, // needs every node placed first; filled in below
      label: {
        anchor: { x: node.x + outward.x * reach, y: node.y + outward.y * reach },
        align: Math.abs(outward.x) < 0.5 ? 'centre' : outward.x > 0 ? 'left' : 'right',
      },
      pathology,
      alarm: isAlarmRank(lane.rank),
      retire:
        cut === null
          ? null
          : persistence(cut, path, widthRoot, widthTip, options.hideFinished === true),
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
    rootFullness: fullness,
    rx,
    ry,
    threads,
    byLane,
    labelPolicy: threads.length > LABELS_ALL_MAX ? 'hover' : 'all',
  }
}
