import { createNoise2D } from 'simplex-noise'
import type { Point } from '../geometry.js'
import { allowance } from '../motion.js'
import type { Mote } from '../motes.js'
import {
  ICE_1000,
  ICE_200,
  TISSUE_200,
  TISSUE_500,
  TISSUE_900,
  ambientLift,
  ambientVeil,
  clamp01,
  ink,
} from '../palette.js'
import { BREATH_DEPTH, motionMode, type SceneFrame } from './frame.js'
import type { Mark } from './types.js'

/**
 * DEPTH, TEXTURE AND AMBIENT LIFE (prd10 ruling 6) — everything in this file is
 * ambient class, and the budget's caps do not move for any of it.
 *
 * The ruling grants five things and the grant has a condition attached that is
 * easy to read past: *within the motion budget*. Ambient's whole claim is that a
 * display earns the periphery only if it can be **ignored** (`motion.ts`), so the
 * test every mark here has to pass is not "is it pretty" but "would a viewer have
 * to consciously suppress it". Hence:
 *
 * - **the fog and the vignette do not move at all.** They are two radial washes
 *   cached on resize (`paint.ts`), and their whole job is to put the rim further
 *   away than the middle — which is what makes a lane's journey outward read as a
 *   journey rather than as a diagram. A *still* gradient costs the periphery
 *   nothing and buys the picture depth.
 * - **the grain steps at ≤12 fps**, and at 1.5% alpha. Film grain that resolves at
 *   60 fps is the one texture in this instrument that would genuinely read as
 *   motion.
 * - **the spores and the rim flora ride the breath that was already there.** No
 *   new clock, no new period: they read `frame.breath`, which is the one ambient
 *   cycle the scene has (±1.6%, `BREATH_DEPTH`), so freezing the breath freezes
 *   them and nothing here has to know that pause exists.
 * - **nothing here carries a fact.** Every position is seeded off a constant and
 *   the *count* is fixed, so no viewer can read a spore drift as "more work" or a
 *   flowering rim as "more lanes". This is the one place in the scene where that
 *   is the requirement rather than the failure: substrate is allowed to be
 *   substrate, and law 12's honesty rule is about the picture's *claims*.
 *
 * The accent lives here too (ruling 5): the fog, the spores and the flora are
 * organic tissue, which is exactly what the tissue ramp is permitted for.
 *
 * **AND THIS FILE IS THE ONLY THING A MODE MAY TOUCH** (#157). `frame.vibrancy` is
 * 1 live and {@link REPLAY_VIBRANCY} in a replay, and every mark below is drawn
 * through `ambientLift` (the lit ones) or `ambientVeil` (the two washes that dim).
 * The argument is the one this header already makes, read backwards: everything
 * here is faint *because a live instrument must be glanceable*, and a replay is not
 * glanced at. Nothing else in the scene is dimmed for that reason, so nothing else
 * in the scene is brightened by this number — no status hue, no alarm mark, no
 * ladder rung, and not one figure in the motion budget. A replay is brighter, not
 * busier, and it says the same things about the fleet that the live scene did.
 */

/** How many spores drift in the void. Fixed: a count that varied would be a claim. */
const SPORES = 18

/**
 * How far a spore wanders, as a fraction of the scene's smaller half-axis.
 *
 * The ambient class's own ±3% ceiling, spent on position instead of on scale —
 * which is the strictest available reading of "drifting spores riding the existing
 * breath cycle". A spore therefore hangs in the light and stirs; it does not fly
 * across the picture, and no eye tracks it.
 */
const SPORE_DRIFT = BREATH_DEPTH * 2

/** The band spores hang in, as fractions of the smaller half-axis. */
const SPORE_BAND = { from: 0.3, to: 0.98 } as const

/** How many tufts of flora sit on the rim, and how far they reach off it in px. */
const FLORA = 22
const FLORA_REACH = { min: 3.5, span: 5.5 } as const
const FLORA_POINTS = 4

/**
 * THE DEPTH FOG — a haze that thickens toward the rim.
 *
 * Tissue rather than ice, and that is ruling 5 being spent rather than borrowed:
 * the void a mycelium hangs in is not empty air, and a faint bioluminal wash out
 * at the rim is the difference between a network drawn on black and one growing
 * inside something. It is additive-looking without being additive — the deepest
 * step of the ramp is nearly the void's own luminance, so what it does is *tint*
 * the far field rather than lighten it.
 */
const FOG = { from: 0.18, to: 1.02, alpha: 0.28 } as const

/** …and the vignette over it, in the void's own colour. Corners, not edges. */
const VIGNETTE = { from: 0.62, to: 1.18, alpha: 0.5 } as const

/**
 * WHERE THE DEPTH HAD TO STOP, and it is not a taste.
 *
 * Both washes are painted in the chrome pass, which puts them **over** the world —
 * including over the lane names, which live at the rim, which is exactly where a
 * radial wash is thickest. So a fog tuned by eye against the threads would quietly
 * be a fog tuned against prd4's legibility floor, and nothing in the display list
 * would notice: a `text` mark's own ink is unchanged by a wash laid on top of it.
 *
 * Hence {@link RIM_VEIL}, and a test that reads it. The two alphas above are
 * whatever they need to be *given* that ceiling, rather than the ceiling being
 * whatever the alphas happened to produce — which is the difference between a
 * bound and a note. The gap voice is exempt by construction: it is chrome too, and
 * it is drawn after both.
 */
export const RIM_VEIL = 0.3

/** The grain: one cached tile, and the step rate that keeps it texture. */
const GRAIN = { tile: 64, alpha: 0.016, fps: 12 } as const

/**
 * The screen-side ambient layer: the fog, the vignette and the grain, in that
 * order — furthest thing first, then the frame's own falloff, then the print's
 * texture over both. Painted in the chrome pass (`paint.ts`'s `isChrome`), so the
 * camera moves the picture underneath them and never them.
 */
export function ambientScreenMarks(frame: SceneFrame): Mark[] {
  const { width, height } = frame.geometry
  // Pause and reduced motion both leave every one of these exactly where it is:
  // a still gradient is not motion, and WCAG 2.3.3 excludes colour and opacity
  // from the definition. What the frozen clock *does* take away is the grain's
  // crawl, below.
  const still = !allowance('ambient', motionMode(frame)).opacity
  const { vibrancy } = frame

  return [
    {
      kind: 'wash',
      role: 'depth-fog',
      laneId: null,
      alarm: false,
      width,
      height,
      from: FOG.from,
      to: FOG.to,
      inner: ink(TISSUE_900, 0),
      // Relaxed rather than lifted (#157): the fog is what holds the rim back, and
      // in a retrospective the rim is worth seeing.
      outer: ambientVeil(ink(TISSUE_900, FOG.alpha), vibrancy),
    },
    {
      kind: 'wash',
      role: 'vignette',
      laneId: null,
      alarm: false,
      width,
      height,
      from: VIGNETTE.from,
      to: VIGNETTE.to,
      inner: ink(ICE_1000, 0),
      outer: ambientVeil(ink(ICE_1000, VIGNETTE.alpha), vibrancy),
    },
    {
      kind: 'grain',
      role: 'grain',
      laneId: null,
      alarm: false,
      width,
      height,
      tile: GRAIN.tile,
      // Floor of the clock in twelfths of a second: the tile offset can change at
      // most twelve times a second however often this frame is drawn, and stops
      // changing entirely when the scene's clock is held (pause).
      //
      // `frame.now` — the ANIMATION clock, and legitimately so in a replay (#157).
      // The grain crawls at a rate an eye reads, not at the rate history happened.
      tick: still ? 0 : Math.floor((frame.now / 1000) * GRAIN.fps),
      // The one ambient mark `frame.vibrancy` deliberately does NOT reach. Grain is
      // texture rather than light — brightening it adds noise, not vibrancy — and a
      // multiplier on a 1.6% wash that crawls is the one place this number could
      // have turned into movement. The motion budget stays exactly where it was.
      ink: ink(ICE_200, GRAIN.alpha),
    },
  ]
}

/**
 * The world-side ambient layer: spores in the void and flora on the rim.
 *
 * Drawn **first** of everything (`marks/index.ts`), so it is substrate: a thread
 * passes in front of a spore, and the mass covers the ones behind it. Substrate
 * that drew over the network would be decoration; substrate that the network sits
 * on top of is depth.
 */
export function ambientWorldMarks(frame: SceneFrame): Mark[] {
  return [sporeMarks(frame), floraMark(frame)]
}

/**
 * SPORES — one `motes` mark, and therefore one sprite blit each (ruling 10's
 * technique, spent on an ambient drift rather than on a dissolve).
 *
 * They are the accent's third permitted home (ruling 5 names spore motes
 * explicitly): tissue-coloured, dim, and cooler toward the rim so the drift reads
 * as being *in* the fog rather than on top of it.
 *
 * Ambient class means the count is fixed and the class's cap is untouched: these
 * are not dissolution motes, they do not come from a severance or an absorption,
 * and they are deliberately not counted against {@link DISSOLUTION.maxLive} — a
 * cord composting must never be short of pool because the void was dusty.
 */
function sporeMarks(frame: SceneFrame): Mark {
  const { centre, rx, ry } = frame.geometry
  const smaller = Math.max(1, Math.min(rx, ry))
  // One field, built once and kept: the drift is a *place* in a noise field read
  // at the breath's own phase, so it wanders without a per-spore clock.
  const drift = sporeField()
  // The breath, recovered as a phase: ±BREATH_DEPTH around 1 (`breathOf`), so this
  // is the same cycle the mass inhales on and no second period enters the scene.
  const phase = (frame.breath - 1) / BREATH_DEPTH

  const items: Mote[] = Array.from({ length: SPORES }, (_unused, i) => {
    const t = (i + 0.5) / SPORES
    // Golden-angle bearings, so the drift has no rotational symmetry at any count.
    const bearing = t * Math.PI * 2 * 5 + drift(t * 7.3, 0.5) * 0.8
    const band = SPORE_BAND.from + (SPORE_BAND.to - SPORE_BAND.from) * ((i * 7) % SPORES) / SPORES
    const wobble = SPORE_DRIFT * smaller * drift(t * 3.1, phase * 0.5 + 1.7)
    const radius = band * smaller + wobble

    return {
      at: {
        x: centre.x + Math.cos(bearing) * radius * (rx / smaller),
        y: centre.y + Math.sin(bearing) * radius * (ry / smaller),
      },
      radius: 1.6 + 1.1 * ((i * 3) % 4) / 3,
      // Cooling outward: bright tissue near the middle, deep tissue at the rim,
      // which is the fog's own gradient read on a moving thing. Lifted at this
      // frame's vibrancy (#157) — the drift is the most visible thing in the
      // substrate, so it is where a retrospective's extra light does the most.
      ink: ambientLift(
        ink(
          mixTissue(
            clamp01((radius / smaller - SPORE_BAND.from) / (SPORE_BAND.to - SPORE_BAND.from)),
          ),
          0.1 + 0.14 * (0.5 + 0.5 * drift(t * 11.7, phase * 0.5)),
        ),
        frame.vibrancy,
      ),
    }
  })

  return { kind: 'motes', role: 'spore', laneId: null, alarm: false, items }
}

/** Light tissue in, deep tissue out. Two steps of the ramp, not the whole of it. */
function mixTissue(t: number): [number, number, number] {
  const k = clamp01(t)
  return [
    Math.round(TISSUE_200[0] + (TISSUE_500[0] - TISSUE_200[0]) * k),
    Math.round(TISSUE_200[1] + (TISSUE_500[1] - TISSUE_200[1]) * k),
    Math.round(TISSUE_200[2] + (TISSUE_500[2] - TISSUE_200[2]) * k),
  ]
}

/**
 * RIM FLORA ON THE FOLD — small tufts growing on the retirement band.
 *
 * One `baked` mark for the whole rim rather than twenty-two strokes, and baked on
 * a **circle** placed onto the rim's ellipse (`BakedMark.scaleY`): the geometry is
 * built once for the life of the panel and the ellipse is a transform, so a
 * flowering rim costs one cached `Path2D` and one stroke call per frame.
 *
 * What it says is that the rim is a *place* — the fold a mycelium fruits along —
 * rather than the edge of a chart. It carries nothing: the tuft count is fixed and
 * their positions are seeded, so nobody can read a bushy rim as a busy fleet.
 */
function floraMark(frame: SceneFrame): Mark {
  const { centre, rx, ry } = frame.geometry
  const smaller = Math.max(1, Math.min(rx, ry))

  return {
    kind: 'baked',
    role: 'rim-flora',
    laneId: null,
    alarm: false,
    bake: 'rim-flora:v1',
    at: centre,
    scale: rx,
    scaleY: ry,
    paths: floraPaths(smaller),
    closed: false,
    // Breathing in luminance only — the one ambient channel a hairline can spend
    // without moving. Deep tissue: the rim is the furthest thing from the light,
    // and at replay vibrancy it is the furthest thing worth looking at.
    ink: ambientLift(ink(TISSUE_500, 0.24 * frame.breath), frame.vibrancy),
    width: 0.9,
  }
}

/**
 * The tufts, in unit space on a circle. Cached by reach, which is a function of
 * the panel — so this is built once per resize, and the `paint.ts` bake it feeds
 * is built once for the whole session.
 */
function floraPaths(smaller: number): readonly (readonly Point[])[] {
  const known = floraCache.get(smaller)
  if (known !== undefined) return known

  const noise = createNoise2D(mulberry32(0x1f0a3b5d))
  const paths: Point[][] = []

  for (let i = 0; i < FLORA; i += 1) {
    const bearing = (i / FLORA) * Math.PI * 2 + noise(i * 0.37, 2.1) * (Math.PI / FLORA)
    const lean = noise(i * 0.71, 5.3)
    // In units of the *placed* radius, so a tuft is the same few pixels tall on a
    // letterbox panel as on a square one.
    const reach = (FLORA_REACH.min + FLORA_REACH.span * (0.5 + 0.5 * lean)) / smaller

    paths.push(
      Array.from({ length: FLORA_POINTS }, (_unused, s) => {
        const t = s / (FLORA_POINTS - 1)
        const out = 1 + reach * t
        const angle = bearing + lean * 0.06 * t * t
        return { x: Math.cos(angle) * out, y: Math.sin(angle) * out }
      }),
    )
  }

  if (floraCache.size >= 8) floraCache.clear()
  floraCache.set(smaller, paths)
  return paths
}

const floraCache = new Map<number, readonly (readonly Point[])[]>()

/** One noise field for the whole drift, built once. Never rebuilt per frame. */
let spores: ((x: number, y: number) => number) | null = null
function sporeField(): (x: number, y: number) => number {
  spores ??= createNoise2D(mulberry32(0x5eed517e))
  return spores
}

/** Bryc's `mulberry32`, as `variation.ts` and `heart.ts` use it. */
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
