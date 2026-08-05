import { contourLayers, type Falloff } from '../contour.js'
import { budLife, type BudGeometry, type Point, type ThreadGeometry } from '../geometry.js'
import { heartAnatomy, type HeartRing } from '../heart.js'
import { DISSOLUTION, STRUCTURAL } from '../motion.js'
import {
  ACTIVITY_HUE,
  ICE_050,
  ICE_100,
  ICE_200,
  ICE_300,
  ICE_400,
  ICE_500,
  TISSUE_400,
  TISSUE_700,
  clamp01,
  hotter,
  ink,
  mix,
  type Ink,
  type Rgb,
} from '../palette.js'
import { variationFor, variationSeed } from '../variation.js'
import { budget, type SceneFrame } from './frame.js'
import { flareAt } from './thread.js'
import { ribbonMark, type Mark } from './types.js'

/**
 * MAIN — the root-mass everything grows out of and lands back into.
 *
 * One organic contour (prd7 ruling 5), not a set of shapes: a surface, a
 * field of smooth falloffs sampled and walked into a closed ring by
 * `contour.ts`, whose silhouette is a consequence of what is currently in
 * the mass rather than an arrangement of marks around it. See
 * docs/decisions/root-organic-contour-not-sticker.md for what this replaced
 * and the #117 finding that reshaped it.
 *
 * Five facts are drawn into it and nothing else is:
 *
 * - **its resting glow is the conductor's own burn.** Orchestration is not
 *   free (prd2), so the mass at the centre of the picture is lit by the
 *   orchestrator: an un-instrumented conductor has reported no tokens, so
 *   the mass sits at its floor — dimmer, and honest about it. The words
 *   belong to the gap voice elsewhere (law 12); the scene's job is to not
 *   fake the light.
 * - **it surges when work comes home**, only ever because a packet's
 *   journey ended here (ruling 32). No arrival without a commit.
 * - **it grows with the session's landed work** (prd6 ruling 2). The size
 *   is `geometry.rootRadius`: everything that must stay clear of the mass
 *   (newborn nodes, the bundle trunk, the threads' exit from the surface)
 *   is laid out before this file runs, so growth is a geometry fact this
 *   builder only reads. See {@link depthsFor} for what the growth does to
 *   the *material*, and docs/decisions/root-growth-is-geometry-not-render.md
 *   for why the number isn't here.
 * - **it melts where substance is arriving.** Each cord still parting adds
 *   a falloff of its own at that lane's bearing, so the surface swells
 *   toward the lane the work is coming from and settles back as the strand
 *   stills. See {@link arrivalSwell} and
 *   docs/decisions/root-arrival-swell-not-ring.md.
 * - **it breathes**, ±1.6%, the one ambient motion in the instrument — the
 *   contour breathes because there is nothing else left to.
 */

/** Conductor output tokens that read as a fully warm root. */
const CONDUCTOR_FULL_TOKENS = 400_000

/**
 * The floor: enough to see the mass, little enough to read as un-lit. Must
 * sit far enough below a warm conductor for gap honesty to survive on
 * brightness alone — the root-mass case in `marks.test.ts` compares exactly
 * that. (Raised from prd3's 0.2 by ruling 3: a 0.2 floor stopped reading as
 * "what the threads are threaded into" once the fleet carried its own
 * colour.)
 */
const RESTING_FLOOR = 0.35

/**
 * The mass's growth-with-landed-work multiplier used to live here
 * (`ROOT_GROWTH.maxGirth`); it now lives in `geometry.ts`'s
 * {@link rootRadiusFor}. See
 * docs/decisions/root-growth-is-geometry-not-render.md.
 */

/**
 * THE BODY — the mass's own likeness, in units of its radius.
 *
 * Authored rather than generated, and fixed, for the reason the old tangle's
 * golden-angle placement was fixed: the mass has to be recognisably *itself*
 * every frame and every session.
 *
 * Three octaves — a trunk of four large falloffs, five shoulders at half
 * their size further out, and eight grains at a fifth of it near the skin —
 * so the silhouette has features at three scales rather than one. See
 * docs/decisions/root-organic-contour-not-sticker.md for the #117 finding
 * that put the octaves there.
 *
 * Two constraints held the tuning down, and both are pinned elsewhere:
 *
 * - **the narrowest bearing stays between 0.6 and 0.9 of the widest**
 *   (`marks.test.ts`). Above 0.9 it collapses back into a circle; below 0.6
 *   it comes apart into a scatter of lumps.
 * - **every lobe overlaps its neighbours**, so the field is one component at
 *   any melt — the mass is one closed ring by law, and `contour.test.ts`
 *   walks this exact table at the coarse melt to say so.
 *
 * The furthest anything reaches is ~0.99 of the radius including the
 * fillet's own overshoot, so the finished contour sits on the rim — which is
 * where the hit target already is (`SceneView`'s `ROOT_HIT_SLACK`).
 */
const BODY: readonly { id: string; angle: number; distance: number; radius: number }[] = [
  // The trunk: unequal on purpose, so the mass has a direction to it.
  { id: 'body-0', angle: 0.3, distance: 0.0696, radius: 0.6032 },
  { id: 'body-1', angle: 1.15, distance: 0.348, radius: 0.522 },
  { id: 'body-2', angle: 2.85, distance: 0.406, radius: 0.4292 },
  { id: 'body-3', angle: 4.35, distance: 0.3364, radius: 0.4988 },
  // Shoulders: half the trunk's size, sitting out where they show on the skin.
  { id: 'body-4', angle: 0.7, distance: 0.6032, radius: 0.3364 },
  { id: 'body-5', angle: 2.02, distance: 0.638, radius: 0.2668 },
  { id: 'body-6', angle: 3.6, distance: 0.5916, radius: 0.3132 },
  { id: 'body-7', angle: 5, distance: 0.58, radius: 0.348 },
  { id: 'body-8', angle: 6, distance: 0.5452, radius: 0.29 },
  // Grain: a third of the trunk, near the surface, and the only reason the edge
  // has any texture on it at all.
  { id: 'body-a', angle: 0.46, distance: 0.7888, radius: 0.2079 },
  { id: 'body-b', angle: 1.42, distance: 0.7308, radius: 0.1689 },
  { id: 'body-c', angle: 2.4, distance: 0.7656, radius: 0.2209 },
  { id: 'body-d', angle: 3.24, distance: 0.696, radius: 0.1559 },
  { id: 'body-e', angle: 4.12, distance: 0.7772, radius: 0.1949 },
  { id: 'body-f', angle: 4.72, distance: 0.7076, radius: 0.1429 },
  { id: 'body-g', angle: 5.54, distance: 0.7656, radius: 0.2079 },
  { id: 'body-h', angle: 6.28, distance: 0.6844, radius: 0.1689 },
]

/**
 * How far the falloffs melt into each other, in units of the radius — the
 * one number that decides whether this reads as an organism or a bag of
 * circles. At 0.13, the trunk and shoulders still fuse into one continuous
 * surface (they overlap by much more than the fillet) while the grain
 * octave survives as texture on the skin. See
 * docs/decisions/root-organic-contour-not-sticker.md for why it had to come
 * down from the single-octave body's 0.24.
 */
const MELT = 0.13

/**
 * The grid pitch, in units of the radius (~4 px at the scene's usual
 * scale). A fraction of the radius rather than an absolute pixel count: the
 * whole lattice — pitch, origin, extent — is then a *similarity transform*
 * of the mass, so a mass that thickens by 30% gets a contour exactly 30%
 * larger rather than one re-quantised against a fixed grid. That is what
 * lets prd6 ruling 2's growth cap be an exact law about the picture rather
 * than one that holds give-or-take half a cell, and it is why the
 * silhouette is the same likeness at every scene size instead of gaining
 * detail on a big panel. See docs/decisions/root-organic-contour-not-sticker.md
 * for why 4 px (not the single-octave body's 6 px).
 */
const CELL = 0.078

/**
 * Corner-cutting passes. Two, of the three the ruling allows: at this pitch the
 * second pass already puts the vertices well under a pixel apart, and the third
 * would only buy points.
 */
const SMOOTHING = 2

/**
 * THE BODY, AS DEPTH — the levels of the field the mass is painted from.
 *
 * `at` is a distance in units of the radius, in the field's own sign
 * convention: 0 is the surface (the ring the laws read), negative is inside
 * it. This is the silhouette and seventeen shells beneath it, each a real
 * level of the same scalar field, sampled once and walked eighteen times
 * (`contour.ts`).
 *
 * Painted outermost first, each nearly transparent, so what the eye reads is
 * the accumulation — about 0.05 where only the skin is in the way, about 0.7
 * where all eighteen are. Every edge in the stack is the field's own (not a
 * gradient sprite), so the depth breathes, thickens and takes arrivals along
 * with the silhouette, with nothing to keep in step by hand. See
 * docs/decisions/root-organic-contour-not-sticker.md for why this replaced a
 * flat fill plus an outline.
 *
 * Three properties, tuned by eye and each worth keeping as written:
 *
 * - **the spacing widens toward the skin.** Evenly spaced levels put most of
 *   the ramp in the first fifth and give the mass a hard shoulder again; the
 *   outer steps are the big ones, so the edge fades over most of the radius.
 * - **the count is what kills banding, not the total alpha.** Nine levels at
 *   0.06 is the same density as eighteen at 0.03 but shows as a contour map
 *   of itself — an alpha step that size is an edge the eye finds. Eighteen
 *   at 0.05 does not band.
 * - **the interior stays lumpy.** A multi-octave body has a multi-octave
 *   inside — the deeper levels come out as two or three components rather
 *   than one disc, because that is what the field is. At these alphas it
 *   reads as mottling (denser in some places than others), which is the
 *   honest picture rather than a smooth ball.
 *
 * Up the ICE ramp as they go deeper, and no further than {@link ICE_100}:
 * the ramp's ceiling belongs to light (pulses, the core glow), and a body
 * that reached it would read as lit rather than as dense.
 */
const DEPTH = {
  /**
   * Levels, the surface included — **at rest**. See {@link depthsFor}: a mass
   * that has taken a night's work home carries {@link DEPTH.countFull} of them.
   */
  count: 18,
  /** …and the count a full mass carries. */
  countFull: 26,
  /**
   * How far in the innermost one sits, in units of the radius. Unchanged by
   * the growth: the field bottoms out around 0.58 of the radius (where the
   * trunk's own falloffs run out of depth), and 0.62 puts the last level
   * just past that, at any size. See
   * docs/decisions/root-growth-is-geometry-not-render.md for the #118
   * attempt that reached further and why it didn't work.
   */
  reach: 0.62,
  /**
   * How the levels bunch. Above 1 spreads the outer steps and crowds the inner
   * ones, which is the profile a translucent body has: a long soft shoulder at
   * the skin, and the density arriving in the last third.
   */
  bias: 1.45,
  /**
   * Per level — small enough that no single step reads as an edge on its
   * own. See the "count kills banding" note above.
   */
  alpha: 0.055,
  /**
   * THE RIND — how thick the mass's skin is, in units of the radius.
   *
   * The band between the surface and the level just inside it, painted as
   * one shell with a hole in it (the painter fills a shell's rings even-odd,
   * so two nested rings in one entry *are* the band between them). It
   * thickens and thins with the mass because it is measured in the field.
   * See docs/decisions/root-organic-contour-not-sticker.md for why this is
   * the mass's material rather than an outline.
   *
   * **It does not scale with the growth.** A skin is a material fact — how
   * far light travels through the edge of this stuff — so a mass that has
   * doubled has the same skin, not one twice as thick. See
   * {@link DEPTH.rindFull} (this in units of a full mass's radius) and
   * docs/decisions/root-growth-is-geometry-not-render.md.
   */
  rind: 0.06,
  /** The same three or four pixels, in units of a *full* mass's radius. */
  rindFull: 0.032,
  /** How much brighter the rind is than one ordinary level. */
  rindGain: 3.2,
} as const

/**
 * How far the deepest shell is washed toward the accent, in `depthsFor`
 * (prd10 ruling 3). Squared in `t`, so it lands almost entirely in the core
 * — the one region that is large, still and carries no state — and mixes
 * toward {@link TISSUE_700}, which sits near the deep shells' own
 * luminance, so the mass gains an undertone without costing a hundredth
 * against `CALM_CEILING`. The rind stays untouched, so the picture's edge
 * never picks up a hue to explain. See
 * docs/decisions/root-depth-tissue-vibrancy.md.
 */
const DEPTH_TISSUE = 0.44

interface Depth {
  at: number
  rgb: Rgb
  alpha: number
}

/**
 * THE STACK FOR A MASS THIS FULL.
 *
 * Everything about the silhouette is measured in units of the radius, so a
 * mass that has doubled keeps exactly the same likeness at twice the size —
 * what a body actually gains when it grows is **interior**, not girth. So
 * exactly one number here moves with {@link SceneGeometry.rootFullness}:
 * the **count**, from {@link DEPTH.count} at rest to
 * {@link DEPTH.countFull} at a full centre, each level thinner in
 * proportion so the accumulation through the middle stays where it was
 * tuned. See docs/decisions/root-growth-is-geometry-not-render.md for why
 * growth lands here as resolution rather than as size, and for
 * {@link DEPTH.reach}, which deliberately does not move with it.
 *
 * Continuous in `fullness`, so nothing steps: the count only changes on a
 * frame where a cord actually parted, and one more shell at 5.5% alpha is
 * not a thing anybody can see happen.
 */
function depthsFor(fullness: number): readonly Depth[] {
  const count = Math.round(DEPTH.count + (DEPTH.countFull - DEPTH.count) * fullness)
  return Array.from({ length: count }, (_unused, i) => {
    const t = i / (count - 1)
    return {
      at: -DEPTH.reach * Math.pow(t, DEPTH.bias),
      // Up the ramp as it goes deeper: thin ice at the skin, dense ice at
      // the core, exponent 1.35 — the most lift the ramp gives before a
      // step becomes an edge. Washed toward the tissue ramp only on the
      // deep half and squared in `t`, so the skin stays untouched — see
      // {@link DEPTH_TISSUE} and docs/decisions/root-organic-contour-not-sticker.md.
      rgb: mix(mix(ICE_500, ICE_100, Math.pow(t, 1.35)), TISSUE_700, DEPTH_TISSUE * t * t),
      // Thinner per level as the stack deepens, so a fuller mass gains
      // *structure*, not opacity: the accumulation through the middle stays
      // put, and the material simply has more gradations in it. Without
      // this the full mass is a solid disc and the depth stops reading as
      // depth.
      alpha: DEPTH.alpha * (DEPTH.count / count),
    }
  })
}

/**
 * The level the rind's inner edge is read off: the first one at least
 * {@link DEPTH.rind} deep. Found rather than fixed, so the skin stays the
 * same thickness whatever the ramp above it is spaced at, which varies
 * within a session now that {@link DEPTH.count} does.
 */
function rindIndexOf(depths: readonly Depth[], fullness: number): number {
  const rind = DEPTH.rind + (DEPTH.rindFull - DEPTH.rind) * fullness
  return Math.max(1, depths.findIndex((depth) => -depth.at >= rind))
}

/**
 * How far out an arrival's swell sits, and how big it gets, in units of
 * radius. Small, and out at the rim: a falloff parked deep inside the body
 * barely bulges the silhouette at this scale, and reads as a facet rather
 * than a swell. At full swell it reaches ~1.16 of the radius on that
 * bearing — inside the slack the mass's hit target already carries. See
 * docs/decisions/root-arrival-swell-not-ring.md.
 */
const ARRIVAL = { distance: 0.9, radius: 0.26 } as const

/**
 * How much this lane is currently bulging the surface, 0–1.
 *
 * Squared on the withdraw, so the swell concentrates at the end of the
 * journey — the substance is still on the thread for most of the cut and
 * only arrives here at the finish. `1 - stilled` then melts it away over the
 * settle, which is what makes it an arrival rather than a permanent lump;
 * the permanent part is the mass's own growth (`geometry.rootRadius`), a
 * deliberately different channel.
 *
 * The three motion regimes fall out of this rather than being special-cased:
 *
 * - **reduced motion** collapses the cut to its endpoint (`returnAt`'s
 *   `SETTLED_IN_PLACE`: withdraw 1, stilled 1), so the product is exactly 0
 *   and no swell ever happens;
 * - **pause** freezes the clock, so the swell holds wherever it was rather
 *   than snapping to nothing;
 * - **history and replay** arrive already settled, so a landing the scene
 *   never watched leave never bulges the mass it didn't land in.
 */
export function arrivalSwell(withdraw: number, stilled: number): number {
  const arriving = clamp01(withdraw)
  return arriving * arriving * (1 - clamp01(stilled))
}

/**
 * The whole field, as falloffs — the body, plus one per cord currently parting.
 *
 * The ids are what the blend is sorted by (`contour.ts`), and an arrival's id is
 * the **lane handle**, which is the only identifier here that is stable across a
 * frame in which lanes were added, retired or re-sorted. Exported because the
 * order-independence law is worth pinning against the real field rather than
 * against a fixture of three circles.
 */
export function rootFalloffs(frame: SceneFrame, radius: number): Falloff[] {
  const { centre } = frame.geometry

  const falloffs: Falloff[] = BODY.map((part) => ({
    id: part.id,
    at: {
      x: centre.x + radius * part.distance * Math.cos(part.angle),
      y: centre.y + radius * part.distance * Math.sin(part.angle),
    },
    radius: radius * part.radius,
  }))

  for (const thread of frame.geometry.threads) {
    const cut = thread.retire
    if (cut === null) continue
    // Weighted by the lane's own work: a big merge arrives as a bigger parcel,
    // on the same absolute scale the thread's width is already drawn on.
    const swell = arrivalSwell(cut.withdraw, cut.stilled) * (0.55 + 0.45 * clamp01(thread.sizeFrac))
    if (swell <= 0) continue
    falloffs.push({
      id: `arrival:${thread.laneId}`,
      at: {
        x: centre.x + radius * ARRIVAL.distance * Math.cos(thread.angle),
        y: centre.y + radius * ARRIVAL.distance * Math.sin(thread.angle),
      },
      radius: radius * ARRIVAL.radius * swell,
    })
  }

  return falloffs
}

/**
 * One level's ink. Every level carries the conductor's light and the arrival
 * surge in the same proportions, which is what keeps the body one material: a
 * mass whose skin dimmed while its core did not would have come apart into two
 * objects again, and the un-instrumented floor is asserted over the mass as a
 * whole (`marks.test.ts`) rather than over whichever part is brightest.
 */
function depthInk(depth: Depth, surge: number, intensity: number): Ink {
  return ink(hotter(depth.rgb, 0.14 * surge), depth.alpha * (0.5 + 0.5 * intensity))
}

export function rootMarks(frame: SceneFrame): Mark[] {
  const { geometry, field, fleet } = frame
  const { centre } = geometry
  const marks: Mark[] = []

  const surge = clamp01(field.surge())
  // Not a motion: the size changes only when a cut's withdraw advances (the
  // structural class, already capped and queued) or when a new snapshot brings
  // work that has already landed. Nothing here animates on its own clock — the
  // breath is the one thing on this line that does, and it is ±1.6%.
  const fullness = clamp01(geometry.rootFullness)
  const radius = geometry.rootRadius * frame.breath

  // The conductor's burn as a floor under the glow. Zero tokens → RESTING_FLOOR,
  // which is the un-instrumented case reading as dim rather than as calm.
  const conductorHeat = clamp01(
    Math.log1p(fleet.root.conductorOutputTokens) / Math.log1p(CONDUCTOR_FULL_TOKENS),
  )
  const intensity = RESTING_FLOOR + 0.35 * conductorHeat + 0.55 * surge

  marks.push({
    kind: 'glow',
    role: 'root-halo',
    laneId: null,
    alarm: false,
    at: centre,
    // A fixed multiple of the mass — no extra fullness term needed, since
    // `radius` already carries the growth. See
    // docs/decisions/root-growth-is-geometry-not-render.md for the doubled-up
    // term this replaced.
    radius: radius * 4.2,
    // …and it is the same light spread over the wider footprint, not more of
    // it. A fixed alpha here would light the whole panel to a flat haze as
    // the mass grew, erasing the depth (the retired rim stops sitting in a
    // void; the centre stops reading as dense) — thinning as it spreads is
    // what keeps a full session's scene dark.
    ink: budget(
      frame,
      null,
      false,
      ink(hotter(ICE_200, 0.35), 0.45 * intensity * (1 - 0.5 * fullness)),
    ),
  })

  // THE SURFACE. One mark, whatever the field turned out to be — a `contour`
  // rather than a `ribbon`, because a ribbon's polygons paint independently,
  // which is wrong for a body that may enclose a hole.
  //
  // One sampling of the field, walked at every depth in the stack: the
  // silhouette, and the shells beneath it. See {@link depthsFor} — the stack
  // is deeper and more finely divided the fuller the mass is.
  const depths = depthsFor(fullness)
  const rindIndex = rindIndexOf(depths, fullness)
  const layers = contourLayers(
    {
      falloffs: rootFalloffs(frame, radius),
      origin: centre,
      melt: radius * MELT,
      cell: radius * CELL,
      smoothing: SMOOTHING,
    },
    depths.map((depth, i) => ({
      at: depth.at * radius,
      // The surface keeps full corner-cutting: it's the ring the laws read
      // and the edge the eye finds. A shell at 5% alpha has no edge to find,
      // so one pass is enough — the vertices that saves are otherwise paid
      // for three times per level per frame (allocated, smoothed, filled).
      ...(i === 0 ? {} : { smoothing: 1 }),
    })),
  )

  marks.push({
    kind: 'contour',
    role: 'root-mass',
    laneId: null,
    alarm: false,
    rings: layers[0] ?? [],
    // Thin at the skin: the same translucent ice-toned material the threads
    // are, so a thread's last inch shows through its edge. This alone is
    // not the body — the body is this plus the shells below. See
    // docs/decisions/root-organic-contour-not-sticker.md.
    fill: budget(frame, null, false, depthInk(depths[0] as Depth, surge, intensity)),
    // No edge — an outline states a boundary; a surface with depth behind
    // it already has one. See docs/decisions/root-organic-contour-not-sticker.md.
    shells: [
      // The rind first: surface ring and the one just inside it, in a single
      // entry, so the painter's even-odd fill lands on the band between them.
      {
        rings: [...(layers[0] ?? []), ...(layers[rindIndex] ?? [])],
        ink: budget(
          frame,
          null,
          false,
          depthInk(
            { ...(depths[0] as Depth), alpha: (depths[0] as Depth).alpha * DEPTH.rindGain },
            surge,
            intensity,
          ),
        ),
      },
      ...depths.slice(1).map((depth, i) => ({
        rings: layers[i + 1] ?? [],
        ink: budget(frame, null, false, depthInk(depth, surge, intensity)),
      })),
    ],
  })

  // THE ANATOMY INSIDE THE BODY (prd10 ruling 3) — the growth rings and the
  // hyphal fan, over the surface and *under* the core, so the light at the bottom
  // of the mass suffuses them rather than being crossed by them.
  marks.push(...heartMarks(frame, radius, intensity))
  marks.push(...conductorBudMarks(frame, radius))

  // The core: the point every packet is running to. It carries the
  // conductor's burn too, through `intensity`, so an un-instrumented centre
  // reads dim all the way through rather than keeping a bright core that
  // says nothing.
  //
  // Small, on purpose: the depth is the shells' job now, so this is only
  // the light at the bottom of them. See
  // docs/decisions/root-organic-contour-not-sticker.md for what it used to
  // be.
  marks.push({
    kind: 'glow',
    role: 'root-core',
    laneId: null,
    alarm: false,
    at: centre,
    radius: radius * (0.2 + 0.28 * surge),
    ink: budget(frame, null, false, ink(ICE_050, 0.12 + 0.28 * intensity)),
  })

  // `root-arrival` (an expanding ring) used to be drawn here; it's gone,
  // deliberately not replaced. See
  // docs/decisions/root-arrival-swell-not-ring.md.

  marks.push({
    kind: 'text',
    role: 'root-label',
    laneId: null,
    alarm: false,
    at: { x: centre.x, y: centre.y + radius + 13 },
    text: (fleet.root.mainBranch ?? 'main').toUpperCase(),
    // A branch name is data, so it is mono with tabular numerals (law 11).
    font: 'mono',
    size: 10,
    weight: 600,
    align: 'centre',
    ink: budget(frame, null, false, ink(ICE_300, 0.85)),
  })

  return marks
}

// ── the mycorrhizal anatomy (prd10 ruling 3) ────────────────────────────────

/**
 * At what point in a lane's dissolve its ring has *arrived* — the instant
 * the withdraw ends, on the dissolve's own clock. A ring cannot appear
 * before the matter does, so it fades in over what's left of the
 * composting, the same stretch the last motes land in. Derived from the two
 * budgets rather than typed, so it stays true if either span is retuned.
 */
const RING_ARRIVES = STRUCTURAL.durationMs / DISSOLUTION.spanMs

/**
 * THE HEART'S RINGS AND ITS FAN.
 *
 * Every ring is a real landing (ruling 3's data-honesty clause), read
 * straight off the cuts the registry is running: nothing here can deposit a
 * ring for a lane that hasn't sent its substance home, and nothing can
 * *remove* one — a landing doesn't un-happen.
 *
 * Ordered oldest-landing innermost, which makes it a memoir rather than a
 * set of circles: `elapsedMs` is how long ago each return began, and a
 * landing the scene never watched leave (history, a replay) has none — so
 * it sorts furthest in. A session's replay grows its rings outward in the
 * order the night actually happened.
 *
 * The geometry is baked (`heart.ts`) and the *ink* is per frame, which is
 * the whole of why this is affordable: a ring's contour is 72 noise samples
 * and is built once when its lane lands, while its brightness — which
 * breathes, recedes with the budget and fades in on arrival — costs
 * nothing.
 */
function heartMarks(frame: SceneFrame, radius: number, intensity: number): Mark[] {
  const landed = landings(frame)
  const anatomy = heartAnatomy(
    landed.map((entry) => ({
      laneId: entry.thread.laneId,
      seed: variationSeed(entry.thread.lane),
      sizeFrac: entry.thread.sizeFrac,
    })),
    frame.fleet.root.mainBranch ?? 'main',
  )

  const marks: Mark[] = [
    {
      kind: 'baked',
      role: 'hyphal-fan',
      laneId: null,
      alarm: false,
      bake: `${anatomy.bake}:fan`,
      at: frame.geometry.centre,
      scale: radius,
      paths: anatomy.fan,
      closed: false,
      // Tissue, faint, lit by the conductor's own burn like everything else
      // in the mass, so gap honesty survives into the anatomy.
      ink: budget(frame, null, false, ink(TISSUE_400, 0.16 * (0.5 + 0.5 * intensity))),
      width: 0.75,
    },
  ]

  anatomy.rings.forEach((ring: HeartRing, i: number) => {
    const arriving = landed[i]
    if (arriving === undefined) return
    const deposit = clamp01((arriving.dissolve - RING_ARRIVES) / (1 - RING_ARRIVES))
    if (deposit <= 0) return

    marks.push({
      kind: 'baked',
      role: 'growth-ring',
      // **The heart's, not the lane's** — load-bearing in three places. A
      // ring deposited by a lane is still the *mass's* anatomy: it must not
      // recede when another lane takes the spotlight (the mass never does),
      // must not vanish when the operator hides finished lanes (hiding is
      // about clutter at the rim, never a claim the work was undone — the
      // same reading `geometry.ts` takes for the mass's own growth), and is
      // not one of the marks `PERSIST_FLOOR` floors, because that floor is
      // about the mark identifying a *lane* and this identifies a
      // *landing*. Which landing is still recorded — the roster is in
      // `bake`, and the ring count is asserted against the fleet's own
      // landings.
      laneId: null,
      alarm: false,
      bake: `${anatomy.bake}:ring:${i}`,
      at: frame.geometry.centre,
      scale: radius,
      paths: [ring.ring],
      closed: true,
      // A whisper of the done green over the tissue: the ring is a landing,
      // so the family that landed is still faintly in it (the same argument
      // `PERSIST_TISSUE` makes about a remnant — "finished" and "nothing to
      // say" must not share a colour), and the accent is what it cooled into.
      ink: budget(frame, null, false, ink(mix(TISSUE_400, ACTIVITY_HUE.done, RING_GREEN), 0.3 * deposit)),
      // THE WORK SIZE, KEPT (prd6 ruling 1). Used to be the stub length a
      // lane left at the rim; ruling 2 removed the stubs, so the channel
      // moved to the one permanent mark a landing leaves instead — a big
      // landing lays down a heavier ring, on the same absolute scale as
      // everything else.
      width: RING_WIDTH.min + RING_WIDTH.span * ring.sizeFrac,
    })
  })

  return marks
}

/** How much of the done green survives in a ring, over the accent. */
const RING_GREEN = 0.22
/** A ring's weight, in world px — the work-size channel (prd6 ruling 1). */
const RING_WIDTH = { min: 0.7, span: 1.6 } as const

/** Every lane whose matter has come home, oldest landing first. */
function landings(frame: SceneFrame): { thread: ThreadGeometry; dissolve: number }[] {
  const out: { thread: ThreadGeometry; dissolve: number; age: number }[] = []
  for (const thread of frame.geometry.threads) {
    const cut = thread.retire
    // The matter must have *arrived*: a cord still retracting hasn't
    // deposited anything yet. A hidden lane still counts — hiding finished
    // lanes is about clutter at the rim, not a claim the work was undone,
    // the same reading `geometry.ts` takes for the mass's own growth.
    if (cut === null || cut.withdraw < 1) continue
    out.push({
      thread,
      dissolve: cut.dissolve,
      // No `elapsedMs` means a cut nobody watched — history, older than
      // anything this session saw, so it sorts innermost.
      age: cut.elapsedMs ?? Number.POSITIVE_INFINITY,
    })
  }
  return out.sort((a, b) => b.age - a.age).map(({ thread, dissolve }) => ({ thread, dissolve }))
}

/**
 * THE CONDUCTOR'S OWN BUD (prd10 ruling 9) — "the conductor's subagents bud
 * from MAIN's own anatomy". A worker's bud grows off its own thread
 * (`marks/thread.ts`); the conductor has no thread, because MAIN is the
 * mass rather than a lane, so its bud grows off the mass's rim. One level
 * deep and one bud, exactly as a worker's is.
 *
 * MAIN reads `fleet.root.subagents` — the same shape and vital a lane's own
 * `lane.subagents` comes from — so a worker's bud and the conductor's can
 * never disagree about when a subagent has finished, and a replayed
 * conductor session grows its bud exactly where a live one would. See
 * docs/decisions/root-conductor-bud-liveness.md for what this replaced.
 */
export function conductorBudMarks(frame: SceneFrame, radius: number): Mark[] {
  const bud = conductorBud(frame, radius)
  if (bud === null) return []

  const marks: Mark[] = [
    ribbonMark({
      role: 'bud',
      laneId: null,
      alarm: false,
      path: bud.path,
      widthRoot: 1.5,
      widthTip: 0.2,
      taperTip: 0.5,
      samples: 10,
      caps: false,
      // Ice, not a family hue: the conductor is not a lane and has no activity to
      // wear (`theme.css` on why MAIN gets no token of its own).
      paint: budget(frame, null, false, ink(hotter(ICE_400, 0.3), 0.6 * bud.vitality)),
    }),
  ]

  const struck = flareAt(bud.sinceMs)
  if (struck > 0.02) {
    marks.push({
      kind: 'glow',
      role: 'bud-flare',
      laneId: null,
      alarm: false,
      at: bud.tip,
      radius: 4 + 3 * struck,
      ink: budget(frame, null, false, ink(hotter(ICE_200, 0.5), 0.45 * struck * bud.vitality)),
    })
  }

  return marks
}

/**
 * The conductor's bud, or null — geometry only, so `marks/dissolve.ts` can draw its
 * absorption off the same shape rather than guessing at it.
 *
 * The bearing is seeded off the main branch's name and nothing else, so the bud
 * grows from the same place on the mass all session and in every replay of it.
 */
export function conductorBud(frame: SceneFrame, radius: number): BudGeometry | null {
  const vital = frame.fleet.root.subagents
  if (vital === null) return null

  // Judged against an event timestamp, not the wall clock, so it follows
  // the scrub in a replay — otherwise every recorded session's conductor is
  // a bud that died days ago.
  const sinceMs = Math.max(0, frame.asOf - vital.lastActivityTs)
  const life = budLife(sinceMs)
  if (life.vitality <= 0) return null

  const { centre } = frame.geometry
  const habit = variationFor(`conductor/${frame.fleet.root.mainBranch ?? 'main'}`)
  const bearing = habit.phase * Math.PI * 2
  const reach = (10 + 12 * habit.curl) * life.vitality
  const out: Point = { x: Math.cos(bearing), y: Math.sin(bearing) }
  const across: Point = { x: -out.y, y: out.x }
  const root: Point = { x: centre.x + out.x * radius * 0.92, y: centre.y + out.y * radius * 0.92 }
  const tip: Point = {
    x: root.x + out.x * reach * 0.8 + across.x * reach * 0.5,
    y: root.y + out.y * reach * 0.8 + across.y * reach * 0.5,
  }

  return {
    at: 0,
    path: [
      root,
      { x: root.x + out.x * reach * 0.55, y: root.y + out.y * reach * 0.55 },
      tip,
    ],
    width: 1.5,
    tip,
    vitality: life.vitality,
    absorb: life.absorb,
    sinceMs,
    // Enrichment where the conductor's own telemetry is trace-instrumented, exactly
    // a worker's own bud (`layoutBud`) — read off the vital, never re-derived.
    kind: vital.subagentType,
  }
}
