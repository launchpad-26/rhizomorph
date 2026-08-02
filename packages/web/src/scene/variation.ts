import { createNoise2D } from 'simplex-noise'
import type { Lane } from '../fleet/index.js'
import type { Point } from './geometry.js'

/**
 * BOUNDED UNIQUENESS (prd7 ruling 4) — every lane hand-grown, no lane misread.
 *
 * The operator asked for a scene that looks less drafted. The obvious way to get
 * there is to jitter everything, and it is the one way that breaks the
 * instrument: every geometric channel in this picture already carries a fact, so
 * a wobble in the wrong channel is not decoration, it is a *lie about the fleet*
 * — a lane that looks further through its life than it is, or wider than the
 * work it did.
 *
 * So variation is granted by table rather than by taste. {@link CHANNELS} is the
 * whole permission system, exported as data and pinned by `variation.test.ts`,
 * and the rule it encodes is one line: **perturb only the channels that carry
 * nothing.**
 *
 * | channel | carries | permission |
 * | --- | --- | --- |
 * | position along life (radial) | the lifecycle (prd6 ruling 4) | LOCKED |
 * | hue | state (law 9a/9b) | LOCKED |
 * | encoded width | work size (prd6 ruling 1) | LOCKED as the baseline |
 * | width jitter | nothing | ±{@link WIDTH_JITTER_MAX}, low-frequency only |
 * | sideways wander | nothing | ≤ {@link WANDER_MAX_SPACING} × lane spacing |
 * | curl phase | nothing | free |
 *
 * Two properties make it safe to run this inside a live instrument:
 *
 * - **the wander is zero at both ends of a thread.** The two points that carry
 *   the encoding — where a thread leaves the mass, and where its node came to
 *   rest — are the two points nothing is allowed to move. So a lane's radius,
 *   its angle and its label anchor come out of the wander bit-identical, and
 *   `geometry.test.ts` says so.
 * - **the seed is the lane's identity, never the clock.** `Math.random` and
 *   `Date.now` are banned from this file and from everything it feeds: the same
 *   lane draws the same shape on every frame, in every session, and — the reason
 *   it matters — in a replay of a log recorded on somebody else's machine. The
 *   noise instance is rebuilt from the handle rather than carried, which is the
 *   property `variation.test.ts` proves by constructing a fresh one.
 */

export type ChannelPermission = 'locked' | 'bounded' | 'free'

export interface Channel {
  /** What this channel of the geometry encodes, or null when it encodes nothing. */
  meaning: string | null
  permission: ChannelPermission
  /**
   * The hard cap, in the channel's own units — a fraction of the encoded width
   * for the jitter, a fraction of lane spacing for the wander. Absent for a
   * channel that is locked (nothing is allowed) or free (nothing is measured).
   */
  limit?: number
}

/** THE CHANNEL TABLE. Law, as data — ruling 4's whole permission system. */
export const CHANNELS = {
  radial: { meaning: 'position along life', permission: 'locked' },
  hue: { meaning: 'state', permission: 'locked' },
  width: { meaning: 'work size', permission: 'locked' },
  widthJitter: { meaning: null, permission: 'bounded', limit: 0.1 },
  wander: { meaning: null, permission: 'bounded', limit: 0.3 },
  curl: { meaning: null, permission: 'free' },
} as const satisfies Record<string, Channel>

/** ±10% around the encoded width, and never more. */
export const WIDTH_JITTER_MAX: number = CHANNELS.widthJitter.limit
/**
 * …and how much of the noise field a whole thread is sampled across. Under one
 * feature's width, so a lane is a *little* fatter here and thinner there over
 * its whole length: the ruling says low-frequency, and a ribbon that wobbled
 * five times between the mass and its node would read as serrated rather than
 * as grown.
 */
export const WIDTH_JITTER_WAVES = 1

/** The sideways cap, as a fraction of the spacing between two lanes at the rim. */
export const WANDER_MAX_SPACING: number = CHANNELS.wander.limit
/** One lazy bend along a thread, not a wave train. */
export const WANDER_WAVES = 1.1

/**
 * One lane's allowance, evaluated along its own thread. Every method is a pure
 * function of the seed and the path parameter — no clock, no frame, no state.
 */
export interface LaneVariation {
  /**
   * Sideways offset at `t`, in units of the cap: −1…1, and exactly 0 at both
   * ends. Multiply by `WANDER_MAX_SPACING × spacing` to get pixels.
   */
  wander(t: number): number
  /** Width multiplier at `t`, inside 1 ± {@link WIDTH_JITTER_MAX}. */
  widthJitter(t: number): number
  /**
   * A free 0–1 phase, for habits that carry nothing: which way a lane's heat
   * leans, how tightly it ties itself off, how far its cut end relaxes past the
   * rim.
   *
   * **Uniform, and it was not** (#117). This used to be one sample of a simplex
   * field at the fixed point (0.5, 0.5), which sounds like a random number and
   * is not: a gradient-noise field evaluated at one point close to a lattice
   * node returns a small set of values, and across a twenty-lane fleet the whole
   * channel took four — 0.35, 0.50, 0.65, 0.81. Everything spent on it therefore
   * came in four flavours, which is a pattern rather than a scatter, and it is
   * half of why a rim of thirty-seven scars read as one mark repeated. It is a
   * hash now, so it is flat over 0–1 and two lanes share a habit only by
   * coincidence.
   */
  readonly curl: number
}

/**
 * The lane's seed. Its **handle** — what workmux launched it under — rather than
 * its id, because the id is the branch when there is one and a lane that
 * re-branches mid-session is still the same worker on the same ground (prd6
 * ruling 3's germination reads handles for the same reason). Lexicographically
 * smallest of them, so two collectors naming the same lane in a different order
 * cannot give it two different shapes.
 */
export function variationSeed(lane: Pick<Lane, 'id' | 'handles'>): string {
  if (lane.handles.length === 0) return lane.id
  return [...lane.handles].sort()[0] as string
}

/**
 * Bryc's `cyrb128` — a string to four well-mixed 32-bit words. A hash rather
 * than a character sum because adjacent lane names (`113-ribbons`,
 * `114-contour`) must not produce adjacent noise fields, or the fleet would
 * visibly come in families.
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

/** Bryc's `mulberry32`. simplex-noise v4 dropped its own PRNG and takes one. */
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

/**
 * Zero at both ends, one in the middle. This is the function that makes the
 * whole channel table enforceable rather than aspirational: whatever the noise
 * says, it is multiplied by nothing at `t = 0` and at `t = 1`, so the encoded
 * endpoints of every thread survive the wander exactly.
 */
function ends(t: number): number {
  if (t <= 0 || t >= 1) return 0
  // `Math.sin(Math.PI)` is 1.2e-16, not zero, and "the encoded endpoints do not
  // move" is not a claim that survives being approximately true — so the two
  // ends are returned rather than computed.
  return Math.sin(Math.PI * t)
}

/**
 * Built once per lane and kept, because a noise field is the one thing here
 * worth not rebuilding sixty times a second. Rebuilding it would be *correct* —
 * a fresh instance samples identically, which is the property replay depends on
 * — so this is only ever a saving, never a semantic.
 */
const cache = new Map<string, LaneVariation>()
/** A session sees tens of lanes, not thousands. The bound is a leak-stop, not a policy. */
const CACHE_MAX = 512

export function variationFor(seed: string): LaneVariation {
  const known = cache.get(seed)
  if (known !== undefined) return known

  const built = build(seed)
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(seed, built)
  return built
}

function build(seed: string): LaneVariation {
  // One instance per field, seeded apart: simplex-noise v4 warns that sharing a
  // PRNG across constructions changes what each one produces, which would make
  // "the width jitter" depend on whether anybody asked for a wander first.
  const bend = createNoise2D(mulberry32(cyrb128(`${seed}/wander`)))
  const girth = createNoise2D(mulberry32(cyrb128(`${seed}/width`)))

  return {
    wander: (t) => {
      const envelope = ends(t)
      // Not `noise * 0`: that is −0 for half the fleet, and a signed zero is the
      // sort of thing that survives a `structuredClone` and fails a `toEqual`
      // three modules away for no reason anybody can see.
      return envelope === 0 ? 0 : bend(t * WANDER_WAVES, 0.5) * envelope
    },
    widthJitter: (t) => 1 + WIDTH_JITTER_MAX * girth(t * WIDTH_JITTER_WAVES, 0.5),
    // The hash itself, not a noise field sampled at a point. A field is the
    // right tool for something that varies *along* a thread and the wrong one
    // for a single number per lane — see {@link LaneVariation.curl}.
    curl: cyrb128(`${seed}/curl`) / 4_294_967_296,
  }
}

/**
 * A closed, midpoint-displaced ring — Tyler Hobbs' watercolour subdivision,
 * reimplemented from the description rather than copied (his writing carries no
 * licence; prd7 ruling 6).
 *
 * Take a coarse ring, then for every edge insert its midpoint pushed out or in
 * along its own radius, and halve the push each round. The result is a closed
 * blob that is unmistakably *grown* rather than struck with a compass — which is
 * the whole substitution: an enclosure is enclosure, and nothing about the fact
 * being drawn was ever circular.
 *
 * Deterministic in `(seed, rounds)`, and the displacement is a fraction of the
 * ring's own radius, so a blob around a long name and one around a short name
 * are the same shape at two sizes rather than two different amounts of ragged.
 */
export function blobRing(
  centre: Point,
  rx: number,
  ry: number,
  seed: string,
  rounds = 3,
): Point[] {
  const noise = createNoise2D(mulberry32(cyrb128(`${seed}/blob`)))
  const BASE = 6
  /** How far a midpoint may leave the ring, as a fraction of the local radius. */
  const ROUGHNESS = 0.18

  let ring: number[] = Array.from({ length: BASE }, (_unused, i) => {
    const angle = (i / BASE) * Math.PI * 2
    return 1 + ROUGHNESS * noise(Math.cos(angle), Math.sin(angle))
  })

  for (let round = 1; round <= rounds; round += 1) {
    const amplitude = ROUGHNESS / (round + 1)
    const next: number[] = []
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i] as number
      const b = ring[(i + 1) % ring.length] as number
      next.push(a, (a + b) / 2 + amplitude * noise(round * 3.7, i * 0.61))
    }
    ring = next
  }

  return ring.map((radius, i) => {
    const angle = (i / ring.length) * Math.PI * 2
    return { x: centre.x + rx * radius * Math.cos(angle), y: centre.y + ry * radius * Math.sin(angle) }
  })
}
