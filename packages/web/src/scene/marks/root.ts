import { contourLayers, type Falloff } from '../contour.js'
import {
  ICE_050,
  ICE_100,
  ICE_200,
  ICE_300,
  ICE_400,
  ICE_500,
  clamp01,
  hotter,
  ink,
  mix,
  type Ink,
  type Rgb,
} from '../palette.js'
import { homecoming } from '../retire.js'
import { budget, type SceneFrame } from './frame.js'
import type { Mark } from './types.js'

/**
 * MAIN — the root-mass everything grows out of and lands back into.
 *
 * **One organic contour** (prd7 ruling 5), not a set of shapes. What was here
 * before was fifty-four curls inside a pair of concentric glows, and it was the
 * most obviously *drawn* thing in the picture at exactly the place the eye rests
 * longest. It is now a surface: a field of smooth falloffs, sampled and walked
 * into a closed ring by `contour.ts`, whose silhouette is a consequence of what
 * is currently in the mass rather than an arrangement of marks around it.
 *
 * Five facts are drawn into it and nothing else is:
 *
 * - **its resting glow is the conductor's own burn.** prd2's point is that
 *   orchestration is not free, so the mass at the centre of the picture is lit by
 *   the orchestrator. A conductor nobody instrumented has reported no tokens, so
 *   the mass sits at its floor — dimmer, and honest about it. The words belong to
 *   the gap voice elsewhere (law 12); the scene's job is to not fake the light.
 * - **it surges when work comes home**, and only ever because a packet's journey
 *   ended here (ruling 32). No arrival without a commit.
 * - **it thickens with the session's landed work** (prd6 ruling 2). Every lane
 *   whose cord has been cut has sent its substance back down the thread, and this
 *   is where it went: the mass is visibly bigger by the end of a night than it was
 *   at the start of it, which is the honest reading of a merge — the work is part
 *   of main now. See {@link rootGirth}.
 * - **it melts where substance is arriving.** Each cord still parting adds a
 *   falloff of its own at that lane's bearing, so the surface swells toward the
 *   lane the work is coming from and settles back as the scar cools. That is what
 *   replaced the expanding arrival ring: an arrival is now something the mass
 *   *does*, not a circle drawn on top of it. See {@link arrivalSwell}.
 * - **it breathes**, ±1.6%, which is the one ambient motion in the instrument —
 *   and it is the contour that breathes, since there is nothing else left to.
 *
 * **What #117 changed, and why it was the same bug twice.** The first pass at
 * ruling 5 got the *idea* right and the material wrong: a flat opaque fill, a
 * 1px lighter outline round it, and a radial-gradient core sitting inside the
 * silhouette without being aligned to it. Three objects pretending to be one, in
 * a substance nothing else on screen shares — everything else in this instrument
 * is thin, translucent and ice-toned. So the mass is now painted from the field
 * rather than over it: one body, no outline, {@link DEPTHS} levels of the same
 * scalar field accumulating into density, a {@link DEPTH.rind} of skin where the
 * light travels furthest through it, and a core glow reduced to the small bright
 * thing at the bottom of all that. The silhouette gained two more octaves at the
 * same time, for the same reason: one wavelength is a shape, three is a thing.
 */

/** Conductor output tokens that read as a fully warm root. */
const CONDUCTOR_FULL_TOKENS = 400_000

/**
 * The floor: enough to see the mass, little enough to read as un-lit.
 *
 * Raised from prd3's 0.2 by ruling 3. The old floor was tuned against a scene
 * where every thread around it was also dim; with the fleet now carrying its own
 * colour, a mass at 0.2 stopped reading as the thing the threads are threaded
 * *into* and started reading as a smudge behind them. It still has to sit far
 * enough below a warm conductor for gap honesty to survive on brightness alone,
 * which is what the root-mass test compares.
 */
const RESTING_FLOOR = 0.35

/**
 * HOW MUCH BIGGER A NIGHT'S WORK MAKES THE MASS (prd6 ruling 2).
 *
 * The same discipline as ruling 1's seeds, and for the same reason: an absolute
 * scale so the mass means the same thing at 9 a.m. and at midnight, a two-ended
 * log so the range is spent where landings actually sit rather than below the
 * first ten thousand tokens, and a hard cap because a root-mass that could grow
 * without limit would eat the picture it is the centre of.
 *
 * 30% is deliberately a lot more than the breath's 1.6% and deliberately far less
 * than a doubling: over a session it is unmistakable when you look away and look
 * back, and it never once reads as movement.
 */
export const ROOT_GROWTH = {
  /** Landed output below which the mass is still its own size. */
  seedTokens: 10_000,
  /** …and at which it has thickened all the way. A long night of landings. */
  fullTokens: 500_000,
  /** The cap. The mass thickens; it does not balloon. */
  maxGirth: 0.3,
} as const

/** How much bigger the mass is for having taken this much landed output home. */
export function rootGirth(landedOutputTokens: number): number {
  const span = Math.log1p(ROOT_GROWTH.fullTokens) - Math.log1p(ROOT_GROWTH.seedTokens)
  const above = Math.log1p(Math.max(0, landedOutputTokens)) - Math.log1p(ROOT_GROWTH.seedTokens)
  return ROOT_GROWTH.maxGirth * clamp01(above / span)
}

/**
 * The output of every lane whose substance has come home, weighted by how far
 * along its journey is ({@link homecoming}).
 *
 * Read off the *drawn* scene rather than off `isRetired`, so a landing that is
 * still queued behind the structural cap has not landed here either — the mass
 * grows as each cord actually parts, one lane at a time, which is what makes a
 * wave of twelve landings read as twelve arrivals instead of one lurch.
 *
 * A scar the operator has hidden still counts. Hiding finished lanes is a request
 * about clutter, not a claim that the work was undone.
 */
function landedTokens(frame: SceneFrame): number {
  let total = 0
  for (const thread of frame.geometry.threads) {
    if (thread.retire === null) continue
    total += thread.lane.outputTokens * homecoming(thread.retire)
  }
  return total
}

/**
 * THE BODY — the mass's own likeness, in units of its radius.
 *
 * Authored rather than generated, and fixed, for the reason the old tangle's
 * golden-angle placement was fixed: the mass has to be recognisably *itself*
 * every frame and every session.
 *
 * **Three octaves, not one** (#117). The first pass at this was six falloffs of
 * roughly one size, and the finding against it was precise: the silhouette had a
 * single wavelength, so every lobe was the same lobe and the whole thing read as
 * a shape rather than as a thing. Nature does not have one wavelength. So the
 * body is now a *trunk* of four large falloffs, a set of five *shoulders* at
 * half their size sitting further out, and eight *grains* at a fifth of it out
 * near the skin — and the silhouette that comes off the field has features at
 * three scales, which is what "multi-octave" buys and the only thing it buys.
 *
 * Two constraints held the tuning down, and both are pinned elsewhere:
 *
 * - **the narrowest bearing stays between 0.6 and 0.9 of the widest**
 *   (`marks.test.ts`). Above 0.9 it has collapsed back into the circle prd7
 *   ruling 5 is removing; below 0.6 it has come apart into a scatter of lumps.
 * - **every lobe overlaps its neighbours**, so the field is one component at any
 *   melt. An island would be a second ring, and the mass is one closed ring by
 *   law — `contour.test.ts` walks this exact table at the coarse melt to say so.
 *
 * The furthest anything reaches is ~0.99 of the radius including the fillet's
 * own overshoot, so the finished contour sits on the rim — which is where the
 * hit target already is (`SceneView`'s `ROOT_HIT_SLACK`).
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
 * How far the falloffs melt into each other, in units of the radius.
 *
 * The one number that decides whether this reads as an organism or as a bag of
 * circles — and it had to come *down* when the body gained its second and third
 * octaves, because a fillet is a low-pass filter over the silhouette. At the
 * 0.24 the single-octave body used, a grain of radius 0.13 is entirely inside
 * the weld and changes the outline not at all: the finer octaves would have been
 * paid for and then smoothed away. At 0.13 the trunk and the shoulders still
 * read as one continuous surface (they overlap by much more than the fillet)
 * while the grain survives as texture on the skin.
 */
const MELT = 0.13

/**
 * The grid pitch, in units of the radius — **~4 px at the scale the scene
 * actually runs at**. Down from the 6 px the single-octave body used, for the
 * same reason the melt came down: a lattice cannot resolve a feature smaller
 * than about two of its cells, and the grain octave is 0.11–0.17 of the radius.
 * A 6 px grid would have quantised it into the same smooth outline as before.
 *
 * A fraction of the radius rather than an absolute pixel count, and that is a
 * decision worth its own paragraph. The whole lattice — pitch, origin, extent —
 * is then a *similarity transform* of the mass, so a mass that has thickened by
 * 30% has a contour exactly 30% larger rather than one re-quantised against a
 * fixed grid. It is what lets prd6 ruling 2's cap be an exact law about the
 * picture instead of a law about the picture give or take half a cell, and it
 * also means the silhouette is the same likeness at every scene size instead of
 * gaining detail on a big panel.
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
 * `at` is a distance in units of the radius, in the field's own sign convention:
 * 0 is the surface (the ring the laws read), negative is inside it. So this is
 * the silhouette and seventeen shells beneath it, each a real level of the same
 * scalar field, sampled once and walked eighteen times (`contour.ts`).
 *
 * They are painted outermost first and every one of them is nearly transparent,
 * so what the eye reads is the **accumulation**: about 0.05 where only the skin
 * is in the way and about 0.7 where all eighteen are. That is a translucent
 * body, and it is a thing a fill plus an outline cannot be at any alpha — which
 * was the finding. Nothing here is a gradient sprite: every edge in the stack is
 * the field's own, so the depth breathes, thickens and takes arrivals along with
 * the silhouette, with nothing to keep in step by hand.
 *
 * Three properties were tuned by looking at it at 2×, and all three took more
 * than one attempt:
 *
 * - **the spacing widens toward the skin.** Evenly spaced levels put most of the
 *   ramp in the first fifth and gave the mass a hard shoulder again. The outer
 *   steps are the big ones, so the edge fades over most of the radius.
 * - **the count is what kills the banding, not the total.** Nine levels at 0.06
 *   is the same density as eighteen at 0.03 and comes out as a contour map of
 *   itself: a 6% alpha step on this backdrop is an edge the eye finds. Fifteen
 *   at 0.058 still showed it faintly around the core; eighteen at 0.05 does not.
 * - **the interior is lumpy, and stays lumpy.** A multi-octave body has a
 *   multi-octave inside: the deeper levels come out as two or three components
 *   rather than one disc, because that is what the field is. At these alphas it
 *   reads as mottling — the material being denser in some places than others —
 *   which is the honest picture and a better one than a smooth ball.
 *
 * Up the ICE ramp as they go deeper, and no further than {@link ICE_100}: the
 * ramp's ceiling belongs to light — pulses, and the core glow — and a body that
 * reached it would read as lit rather than as dense.
 */
const DEPTH = {
  /** Levels, the surface included. */
  count: 18,
  /** How far in the innermost one sits, in units of the radius. */
  reach: 0.62,
  /**
   * How the levels bunch. Above 1 spreads the outer steps and crowds the inner
   * ones, which is the profile a translucent body has: a long soft shoulder at
   * the skin, and the density arriving in the last third.
   */
  bias: 1.45,
  /**
   * Per level. Small enough that no single step is visible as an edge — the
   * number that had to be found by looking, because a stack of nine at 0.06
   * came out as a contour map of itself. Eighteen at 0.05 is a body you can see,
   * with no step anybody can point at.
   */
  alpha: 0.055,
  /**
   * THE RIND — how thick the mass's skin is, in units of the radius.
   *
   * The band between the surface and the level just inside it, painted as one
   * shell with a hole in it (the painter fills a shell's rings even-odd, so two
   * nested rings in one entry *are* the band between them). It is what gives the
   * silhouette an edge now that the hard outline is gone, and it is a different
   * thing from that outline in the way that matters: an outline is a stroke laid
   * on a boundary at whatever width somebody typed, and this is the material
   * itself, three pixels of it, lit because light travelling the long way
   * through a translucent body is what makes its edge visible. It thickens and
   * thins with the mass because it is measured in the field.
   */
  rind: 0.06,
  /** How much brighter the rind is than one ordinary level. */
  rindGain: 3.2,
} as const

const DEPTHS: readonly { at: number; rgb: Rgb; alpha: number }[] = Array.from(
  { length: DEPTH.count },
  (_unused, i) => {
    const t = i / (DEPTH.count - 1)
    return {
      at: -DEPTH.reach * Math.pow(t, DEPTH.bias),
      // Up the ramp as it goes deeper: thin ice at the skin, dense ice at the
      // core. The exponent is where the lift #117's second look asked for came
      // from, and it is the one number in the stack that has to be *tuned*
      // rather than reasoned: squaring it put nearly all the brightening in the
      // last few shells, so the body between the rind and the core sat at the
      // backdrop's own weight and the mass read as faint against the vignette.
      // Taking it under 1 lifted the middle and brought the banding straight
      // back, because the colour step per level is largest exactly where the
      // levels are furthest apart. 1.35 is the most lift the ramp will give
      // before a step becomes an edge.
      rgb: mix(ICE_500, ICE_100, Math.pow(t, 1.35)),
      alpha: DEPTH.alpha,
    }
  },
)

/**
 * The level the rind's inner edge is read off: the first one at least
 * {@link DEPTH.rind} deep. Found rather than written down, so the skin stays the
 * same thickness if the ramp above it is ever re-spaced.
 */
const RIND_INDEX = Math.max(
  1,
  DEPTHS.findIndex((depth) => -depth.at >= DEPTH.rind),
)

/**
 * How far out an arrival's swell sits, and how big it gets, in units of radius.
 *
 * Out at the rim and **small**, which took three passes at a rendered frame to
 * get right and is worth writing down. A large falloff parked deep inside the
 * body does not read as a bulge at all: its own arc is nearly flat at this scale,
 * so what appears on the silhouette is a *facet*, and three arrivals at once turn
 * the mass into a crystal. A small one at the rim reads as the surface being
 * pushed out from within, which is the thing that is actually happening.
 *
 * It never appears out of nothing, either, and that also falls out of the
 * geometry rather than needing a rule: below about half swell the falloff is
 * still entirely inside the body and changes the silhouette not at all, so the
 * bulge emerges *from* the surface in the last third of the retract instead of
 * popping into existence beside it. At full swell it reaches about 1.16 of the
 * radius on that bearing — unmissable, and still inside the slack the mass's hit
 * target already carries.
 */
const ARRIVAL = { distance: 0.9, radius: 0.26 } as const

/**
 * HOW MUCH THIS LANE IS CURRENTLY BULGING THE SURFACE, 0–1.
 *
 * Squared on the retract, so the swell is concentrated at the end of the
 * journey: the substance is still out on the thread for most of the cut and only
 * arrives here at the finish. Then `1 - scar` melts it away again over the
 * settle, which is what makes it an arrival rather than a permanent lump — the
 * permanent part is {@link rootGirth}, and it is a different channel on purpose.
 *
 * The three motion regimes fall out of this rather than being special-cased:
 *
 * - **reduced motion** collapses the cut to its endpoint (`cutAt`'s
 *   `SETTLED_IN_PLACE`: retract 1, scar 1), so the product is exactly 0 and no
 *   swell ever happens — the same reason a reduced-motion frame draws no homeward
 *   ribbon;
 * - **pause** freezes the clock, so the state stops advancing and the swell holds
 *   wherever it was, rather than snapping back to nothing;
 * - **history and replay** arrive already settled, so a scar the scene never
 *   watched leave never bulges the mass it did not land in.
 */
export function arrivalSwell(retract: number, scar: number): number {
  const arriving = clamp01(retract)
  return arriving * arriving * (1 - clamp01(scar))
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
    const swell = arrivalSwell(cut.retract, cut.scar) * (0.55 + 0.45 * clamp01(thread.sizeFrac))
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

type Depth = (typeof DEPTHS)[number]

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
  // Not a motion: the girth changes only when a cut's retract advances (the
  // structural class, already capped and queued) or when a new snapshot brings
  // work that has already landed. Nothing here animates on its own clock.
  const girth = rootGirth(landedTokens(frame))
  const radius = geometry.rootRadius * frame.breath * (1 + girth)

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
    // The halo reaches a little further than the mass grew: a session that has
    // taken a lot of work home has a wider footprint, not just a fatter middle.
    radius: radius * (4.2 + 1.4 * (girth / ROOT_GROWTH.maxGirth)),
    ink: budget(frame, null, false, ink(hotter(ICE_200, 0.35), 0.45 * intensity)),
  })

  // THE SURFACE. One mark, whatever the field turned out to be — and it is a
  // `contour` rather than a `ribbon` because a ribbon's polygons are painted
  // independently, which is exactly wrong for a body that may enclose a hole.
  //
  // One sampling of the field, walked at four depths: the silhouette, and three
  // shells beneath it. See `DEPTHS`.
  const layers = contourLayers(
    {
      falloffs: rootFalloffs(frame, radius),
      origin: centre,
      melt: radius * MELT,
      cell: radius * CELL,
      smoothing: SMOOTHING,
    },
    DEPTHS.map((depth, i) => ({
      at: depth.at * radius,
      // The surface keeps the full corner-cutting: it is the ring the laws read
      // and the edge the eye finds. A shell at five per cent alpha has no edge
      // to find, so one pass is the whole of what it needs, and the vertices
      // that buys back are paid for three times over — allocated, smoothed and
      // filled — eighteen times a frame.
      ...(i === 0 ? {} : { smoothing: 1 }),
    })),
  )

  marks.push({
    kind: 'contour',
    role: 'root-mass',
    laneId: null,
    alarm: false,
    rings: layers[0] ?? [],
    // Thin at the skin, and that is the whole change #117 asked for: the mass is
    // made of the same translucent ice-toned material the threads are, so a
    // thread's last inch shows through its edge and the two read as one world.
    // The body is not this number — the body is this number plus the shells.
    fill: budget(frame, null, false, depthInk(DEPTHS[0] as Depth, surge, intensity)),
    // No edge. A 1px lighter outline around a flat fill is how a sticker is
    // drawn, and it was the loudest half of the finding: an outline states a
    // boundary, where a surface with depth behind it *has* one.
    shells: [
      // The rind first: surface ring and the one just inside it, in a single
      // entry, so the painter's even-odd fill lands on the band between them.
      {
        rings: [...(layers[0] ?? []), ...(layers[RIND_INDEX] ?? [])],
        ink: budget(
          frame,
          null,
          false,
          depthInk(
            { ...(DEPTHS[0] as Depth), alpha: DEPTH.alpha * DEPTH.rindGain },
            surge,
            intensity,
          ),
        ),
      },
      ...DEPTHS.slice(1).map((depth, i) => ({
        rings: layers[i + 1] ?? [],
        ink: budget(frame, null, false, depthInk(depth, surge, intensity)),
      })),
    ],
  })

  // The core: the point every packet is running to. It carries the conductor's
  // burn too, through `intensity` — the mass at the centre of the picture is lit
  // by the orchestrator, so an un-instrumented one has to read as dim all the
  // way through rather than keeping a bright core that says nothing.
  //
  // Much smaller than it was, and that is the other half of the sticker finding.
  // It used to be a half-radius radial gradient sitting inside a silhouette it
  // had no relationship to — two objects pretending to be one. The depth is the
  // shells' job now, so all this has left to do is be the light at the bottom of
  // them, and a light at the bottom of something is small.
  marks.push({
    kind: 'glow',
    role: 'root-core',
    laneId: null,
    alarm: false,
    at: centre,
    radius: radius * (0.2 + 0.28 * surge),
    ink: budget(frame, null, false, ink(ICE_050, 0.12 + 0.28 * intensity)),
  })

  // What used to be here was `root-arrival`: an expanding hairline circle, drawn
  // over the mass whenever the surge was decaying. It is gone, and deliberately
  // not replaced. It was a concentric ring — the exact form ruling 5 is removing
  // — and the fact it carried is now carried by the surface itself, which swells
  // toward whichever lane the substance is coming from instead of announcing an
  // arrival with a shape that has no direction in it. The light half of the same
  // fact stays where it was, in the halo and the core.

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
