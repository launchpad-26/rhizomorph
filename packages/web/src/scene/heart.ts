import { createNoise2D } from 'simplex-noise'
import type { Point } from './geometry.js'
import { clamp01 } from './palette.js'

/**
 * THE MYCORRHIZAL HEART (prd10 ruling 3) — the mass's anatomy, baked.
 *
 * "The heart is mycorrhizal anatomy, not a blob." What ruling 5 of prd7 built is
 * a *surface*: a multi-octave field walked into a closed silhouette with
 * translucent depth behind it, and it is the right body. What it has no inside
 * of is a **history**. A night's work makes it bigger (prd6 ruling 2) and denser
 * (#118's shells), and neither of those says *how many* lanes came home or when.
 *
 * So the mass gains two structures, and this file is where their geometry comes
 * from:
 *
 * - **growth rings**, one per landed lane — the session's tree-ring memoir. Every
 *   ring is a real landing, deposited by the composting act (ruling 2) as that
 *   lane's matter arrives. Nothing here can draw a ring the fleet did not land.
 * - **a hyphal fan**, radiating rimward — the fine lattice the threads outside
 *   are the continuation of, so the mass reads as the middle of a network rather
 *   than as an object the network is tied to.
 *
 * **Everything is in unit space, and that is the whole performance argument.**
 * A ring is a closed contour at |p| ≈ its own radius fraction, where 1 is the
 * mass's rim; the mark carries it *un-placed*, and the painter puts it on the
 * canvas through a `translate`/`scale` with a `Path2D` it built once. That is
 * what makes "baked once per landing, never per frame" literally true rather
 * than nearly true: the mass breathes ±1.6% and grows all session, and neither
 * touches this geometry — they are the transform. Bake in world coordinates
 * instead and every breath is a rebake.
 *
 * The other half of the discipline is `variation.ts`'s: no clock, no `Math.random`.
 * A ring's contour is seeded from the lane whose landing deposited it, so the
 * same session draws the same rings on every frame, in every replay, on anybody's
 * machine.
 */

/** Where the innermost ring sits, as a fraction of the mass's radius. */
const RING_INNER = 0.2
/** …and the outermost. Inside the rind, so a ring is interior anatomy. */
const RING_OUTER = 0.9
/**
 * How many rings the band is divided for before they start crowding.
 *
 * Below this count a ring's radius is **fixed** — the second landing of the
 * session deposits its ring at the same place whether it turns out to be the
 * second of three or the second of forty. That is what a growth ring is: wood
 * laid down outside the wood that was already there, not a redrawn diagram. Past
 * ten the band compresses to fit, which is also what a tree does.
 */
const RING_SLOTS = 10

/** How many points a ring's contour is walked at. Baked, so it can afford them. */
const RING_POINTS = 72

/**
 * THE CONTOUR AMPLITUDE BAND, from the spike: 0.02–0.06 of the ring's own
 * radius. Below 0.02 the ring is a compass circle — the exact form prd7 ruling 5
 * removed from this mass — and past about 0.06 two neighbouring rings cross,
 * which turns a memoir into a scribble.
 *
 * The band is not a free choice inside those bounds: it carries the landing's
 * **work size** (prd6 ruling 1), so a 216K landing leaves a heavier, more
 * irregular ring than a 0K one. That matters more than it looks — the rim used
 * to be where a session's finished work was on display, in the length of each
 * scar's stub, and ruling 2 has just taken those stubs away. The channel is not
 * lost; it moved here, where it is permanent.
 */
const RING_AMPLITUDE = { min: 0.02, span: 0.04 } as const

/**
 * How many features go round a ring's circumference.
 *
 * A whole number, and it has to be: the contour is sampled **around a circle in
 * the noise field** (the spike's verdict for seamless closure), so the sample
 * path is closed by construction and the ring cannot have a visible join
 * wherever the walk happens to start. A non-integer frequency would still close
 * — the path is a circle either way — so this is about the feature count reading
 * as organic rather than about the seam. Five and a bit is a lobed ring; twenty
 * would be a gear.
 */
const RING_WAVES = 5.5

/** The fan: how many strands, and the band they run through. */
const FAN_STRANDS = 24
const FAN_FROM = 0.34
/** Just past the rim, so a strand meets the threads outside rather than stopping short. */
const FAN_TO = 1.04
const FAN_POINTS = 9
/** How far a strand may wander off its own bearing, in radians. */
const FAN_SWAY = 0.09

export interface HeartRing {
  /** Whose landing deposited it. Every ring is a real one (ruling 3). */
  laneId: string
  /** Where it sits, as a fraction of the mass's radius. */
  at: number
  /** The lane's work size, 0–1 — what the ring's weight and roughness carry. */
  sizeFrac: number
  /** The closed contour, in unit space. Implicitly closed: no repeated point. */
  ring: readonly Point[]
}

export interface HeartAnatomy {
  /**
   * What the painter caches its `Path2D` set under. Changes only when the ring
   * roster does — which is to say, only when a lane's matter comes home.
   */
  bake: string
  rings: readonly HeartRing[]
  /** Open polylines, unit space, running rimward. Baked once and never again. */
  fan: readonly (readonly Point[])[]
}

/** One landing, as much of it as the anatomy needs. */
export interface Landing {
  laneId: string
  /** The lane's own seed (`variationSeed`), so its ring is *its* ring. */
  seed: string
  sizeFrac: number
}

/**
 * The anatomy for this roster of landings, built once and kept.
 *
 * Keyed on the roster itself rather than on its length, so two sessions that have
 * landed three lanes each do not share three rings — a ring belongs to a lane.
 * The cache is a bake, not a memo of a cheap function: a rebuild is
 * {@link RING_POINTS} noise samples per ring plus the fan, which is nothing once
 * per landing and about forty thousand samples a second if it were per frame.
 */
export function heartAnatomy(landings: readonly Landing[], fanSeed: string): HeartAnatomy {
  const bake = `heart:${fanSeed}:${landings.map((landing) => landing.seed).join('|')}`
  const known = cache.get(bake)
  if (known !== undefined) return known

  const slots = Math.max(RING_SLOTS, landings.length)
  const step = (RING_OUTER - RING_INNER) / slots

  const built: HeartAnatomy = {
    bake,
    rings: landings.map((landing, i) => ({
      laneId: landing.laneId,
      // Outward as the session goes on, and fixed while there is room: the ring
      // a lane deposited does not move because another lane landed after it.
      at: RING_INNER + step * (i + 0.5),
      sizeFrac: clamp01(landing.sizeFrac),
      ring: ringContour(
        RING_INNER + step * (i + 0.5),
        RING_AMPLITUDE.min + RING_AMPLITUDE.span * clamp01(landing.sizeFrac),
        landing.seed,
      ),
    })),
    fan: hyphalFan(fanSeed),
  }

  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(bake, built)
  return built
}

/**
 * One ring, as a closed contour — noise sampled **around a circle in noise
 * space**, which is the spike's answer to the seam.
 *
 * The obvious way to make an irregular ring is `r(θ) = at · (1 + a·noise(θ))`,
 * and it has a join: `noise(0)` and `noise(2π)` are different numbers, so the
 * contour has a step in it at whatever angle the walk started. Sampling the
 * field along the *circle* `(cos θ, sin θ)` instead closes by construction —
 * θ and θ + 2π are the same point in the field, so there is nothing to blend and
 * no seam to hide. `heart.test.ts` walks across the join to say so.
 */
export function ringContour(at: number, amplitude: number, seed: string): Point[] {
  const noise = createNoise2D(mulberry32(cyrb128(`${seed}/ring`)))
  return Array.from({ length: RING_POINTS }, (_unused, i) => {
    const theta = (i / RING_POINTS) * Math.PI * 2
    const radius = at * (1 + amplitude * noise(Math.cos(theta) * RING_WAVES, Math.sin(theta) * RING_WAVES))
    return { x: radius * Math.cos(theta), y: radius * Math.sin(theta) }
  })
}

/**
 * THE HYPHAL FAN — fine strands leaving the middle for the rim, baked once.
 *
 * Not a decoration and not a sunburst: what it says is that the mass and the
 * threads are one organism. Before this, every thread stopped at the mass's rim
 * and the mass had no interior direction at all, so the picture read as lines
 * tied to a lump. A lattice that runs *out* to where the threads run *in* is the
 * anatomy that makes the join true.
 *
 * Deliberately unequal: the strand count is fixed but each one takes its own
 * length, its own bearing offset and its own lazy sway from the seed, so no two
 * are congruent and the fan has no radial symmetry for the eye to lock onto.
 */
function hyphalFan(seed: string): Point[][] {
  const noise = createNoise2D(mulberry32(cyrb128(`${seed}/fan`)))
  const strands: Point[][] = []

  for (let s = 0; s < FAN_STRANDS; s += 1) {
    const base = (s / FAN_STRANDS) * Math.PI * 2
    // Off the field rather than off the index: an even fan is a sunburst.
    const skew = noise(Math.cos(base) * 2.1, Math.sin(base) * 2.1)
    const bearing = base + skew * (Math.PI / FAN_STRANDS)
    const from = FAN_FROM * (0.8 + 0.35 * (skew + 1) * 0.5)
    const to = FAN_TO * (0.86 + 0.14 * (noise(base * 0.7, 4.2) + 1))

    strands.push(
      Array.from({ length: FAN_POINTS }, (_unused, i) => {
        const t = i / (FAN_POINTS - 1)
        const radius = from + (to - from) * t
        // Zero sway at both ends: a strand leaves the middle and meets the rim
        // where it said it would, and bends in between.
        const sway = FAN_SWAY * Math.sin(Math.PI * t) * noise(radius * 3.3, s * 0.61)
        const angle = bearing + sway
        return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) }
      }),
    )
  }

  return strands
}

/** Bakes, kept by roster. A session lands tens of lanes, not thousands. */
const cache = new Map<string, HeartAnatomy>()
const CACHE_MAX = 128

/**
 * Bryc's `cyrb128` and `mulberry32`, as `variation.ts` uses them — restated here
 * rather than imported so that this file's determinism does not depend on
 * another module's cache being warm, and because `variation.ts` keeps them
 * private on purpose (they are that file's seeding discipline, not a utility).
 */
function cyrb128(value: string): number {
  let h1 = 1779033703
  let h2 = 3144134277
  let h3 = 1013904242
  let h4 = 2773480762
  for (let i = 0; i < value.length; i += 1) {
    const k = value.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  return (h1 ^ h2 ^ h3 ^ h4) >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
