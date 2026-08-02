import { contourRings, type Falloff } from '../contour.js'
import type { Point } from '../geometry.js'
import { ICE_050, ICE_200, ICE_300, clamp01, hotter, ink } from '../palette.js'
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
 * every frame and every session. Six falloffs is few enough that the smooth
 * minimum reads as one surface and enough that the surface is not a disc — which
 * matters, because a disc is what a shape looks like and this has to look like a
 * thing that grew.
 *
 * The proportions were picked by measuring the silhouette, not by eye: a body
 * whose narrowest bearing is about four fifths of its widest reads as *grown*,
 * while anything above about 0.9 has collapsed back into the circle the ruling is
 * removing and anything below about 0.7 has come apart into an egg. The furthest
 * any lobe reaches is 0.99 of the radius, so the finished contour sits on the rim
 * — which is where the hit target already is (`SceneView`'s `ROOT_HIT_SLACK`).
 * The old curls overshot the rim by a third and were only survivable because
 * they were faint.
 */
const BODY: readonly { id: string; angle: number; distance: number; radius: number }[] = [
  { id: 'body-0', angle: 0, distance: 0, radius: 0.58 },
  { id: 'body-1', angle: 0.5, distance: 0.49, radius: 0.51 },
  { id: 'body-2', angle: 1.9, distance: 0.55, radius: 0.4 },
  { id: 'body-3', angle: 3.1, distance: 0.44, radius: 0.56 },
  { id: 'body-4', angle: 4.3, distance: 0.58, radius: 0.37 },
  { id: 'body-5', angle: 5.4, distance: 0.4, radius: 0.47 },
]

/**
 * How far the falloffs melt into each other, in units of the radius.
 *
 * The one number that decides whether this reads as an organism or as a bag of
 * circles. Measured on the same silhouette ratio the body is tuned against: at
 * 0.14 the lobes are still legible as separate circles welded together, at 0.46
 * the field has swallowed them whole and the contour comes out a disc to within
 * 4%. A quarter of the radius is the fillet that reads as one continuous surface
 * with something going on inside it.
 */
const MELT = 0.24

/**
 * The grid pitch, in units of the radius — **~6 px at the scale the scene
 * actually runs at**, which is the grid the research measured (1.28 ms/frame,
 * against 42.8 ms for per-pixel metaballs and 108.5 ms with SDF + smin).
 *
 * A fraction of the radius rather than an absolute six pixels, and that is a
 * decision worth its own paragraph. The whole lattice — pitch, origin, extent —
 * is then a *similarity transform* of the mass, so a mass that has thickened by
 * 30% has a contour exactly 30% larger rather than one re-quantised against a
 * fixed grid. It is what lets prd6 ruling 2's cap be an exact law about the
 * picture instead of a law about the picture give or take half a cell, and it
 * also means the silhouette is the same likeness at every scene size instead of
 * gaining detail on a big panel.
 */
const CELL = 0.13

/**
 * Corner-cutting passes. Two, of the three the ruling allows: at this pitch the
 * second pass already puts the vertices well under a pixel apart, and the third
 * would only buy points.
 */
const SMOOTHING = 2

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
  marks.push({
    kind: 'contour',
    role: 'root-mass',
    laneId: null,
    alarm: false,
    rings: contourRings({
      falloffs: rootFalloffs(frame, radius),
      origin: centre,
      melt: radius * MELT,
      cell: radius * CELL,
      smoothing: SMOOTHING,
    }),
    // Substantial, but not opaque: the threads are painted under the mass, and
    // seeing their last inch faintly through it is what makes them read as
    // threaded *into* the thing rather than as lines that stop behind it.
    fill: budget(frame, null, false, ink(hotter(ICE_200, 0.2 + 0.4 * surge), 0.26 + 0.3 * intensity)),
    // A rim, so the surface has an edge and not just an extent. It is the one
    // place the mass is allowed to be brighter than its own body — a lit skin is
    // what stops a flat fill reading as a sticker laid over the threads.
    edge: {
      width: 1.1,
      ink: budget(
        frame,
        null,
        false,
        ink(hotter(ICE_200, 0.3 + 0.45 * surge), 0.34 + 0.36 * intensity),
      ),
    },
  })

  // The core: the point every packet is running to. It carries the conductor's
  // burn too, through `intensity` — the mass at the centre of the picture is lit
  // by the orchestrator, so an un-instrumented one has to read as dim all the
  // way through rather than keeping a bright core that says nothing.
  marks.push({
    kind: 'glow',
    role: 'root-core',
    laneId: null,
    alarm: false,
    at: centre,
    radius: radius * (0.5 + 0.35 * surge),
    ink: budget(frame, null, false, ink(ICE_050, 0.34 + 0.42 * intensity)),
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
