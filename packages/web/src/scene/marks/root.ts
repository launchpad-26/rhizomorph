import type { Point } from '../geometry.js'
import { ICE_050, ICE_200, ICE_300, clamp01, hotter, ink } from '../palette.js'
import { budget, type SceneFrame } from './frame.js'
import type { Mark } from './types.js'

/**
 * MAIN — the root-mass everything grows out of and lands back into.
 *
 * A dense tangle of curls rather than a disc, so it reads as *mass*: the thing
 * the threads are threaded to. Three facts are drawn into it and nothing else is:
 *
 * - **its resting glow is the conductor's own burn.** prd2's point is that
 *   orchestration is not free, so the mass at the centre of the picture is lit by
 *   the orchestrator. A conductor nobody instrumented has reported no tokens, so
 *   the mass sits at its floor — dimmer, and honest about it. The words belong to
 *   the gap voice elsewhere (law 12); the scene's job is to not fake the light.
 * - **it surges when work comes home**, and only ever because a packet's journey
 *   ended here (ruling 32). No arrival without a commit.
 * - **it breathes**, ±1.6%, which is the one ambient motion in the instrument.
 */

/** How many curls the tangle is made of. Fixed, so the mass has a likeness. */
const CURLS = 54

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

export function rootMarks(frame: SceneFrame): Mark[] {
  const { geometry, field, fleet } = frame
  const { centre } = geometry
  const marks: Mark[] = []

  const surge = clamp01(field.surge())
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
    radius: radius * 4.2,
    ink: budget(frame, null, false, ink(hotter(ICE_200, 0.35), 0.45 * intensity)),
  })

  // The tangle. Golden-angle placement, deterministic by index — the mass looks
  // grown, and it looks the same every frame.
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < CURLS; i += 1) {
    const angle = i * golden
    const spiral = 0.24 + 0.76 * Math.sqrt((i + 0.5) / CURLS)
    const r = radius * spiral
    const sweep = 0.7 + ((i * 37) % 11) / 12
    const start: Point = { x: centre.x + r * Math.cos(angle), y: centre.y + r * Math.sin(angle) }
    const control: Point = {
      x: centre.x + r * 1.32 * Math.cos(angle + sweep * 0.5),
      y: centre.y + r * 1.32 * Math.sin(angle + sweep * 0.5),
    }
    const end: Point = {
      x: centre.x + r * 1.02 * Math.cos(angle + sweep),
      y: centre.y + r * 1.02 * Math.sin(angle + sweep),
    }

    marks.push({
      kind: 'stroke',
      role: 'root-mass',
      laneId: null,
      alarm: false,
      points: quad(start, control, end, 8),
      width: 0.5 + 1.5 * (1 - spiral),
      // Inner curls are brighter: the mass has a lit core and a soft edge.
      ink: budget(
        frame,
        null,
        false,
        ink(hotter(ICE_200, 0.2 + 0.5 * surge), 0.16 + 0.5 * (1 - spiral) + 0.3 * surge),
      ),
    })
  }

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

  // The arrival ring, only while a real surge is decaying.
  if (surge > 0.04 && !frame.reducedMotion) {
    marks.push({
      kind: 'arc',
      role: 'root-arrival',
      laneId: null,
      alarm: false,
      at: centre,
      radius: radius * (1.1 + (1 - surge) * 2.4),
      from: 0,
      to: Math.PI * 2,
      width: 1.2,
      ink: budget(frame, null, false, ink(hotter(ICE_200, 0.5), 0.32 * surge)),
    })
  }

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

function quad(p0: Point, p1: Point, p2: Point, steps: number): Point[] {
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
