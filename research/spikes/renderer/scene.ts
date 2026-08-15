/**
 * THE SHARED MODEL — one display list, two painters.
 *
 * The whole point of this spike is that the *content* is not in question. Both
 * renderers consume the identical `Mark[]`, built by the scene's own
 * `layoutScene` + `sceneMarks` — the shipping code, imported, not re-implemented
 * — and then augmented to prd-33's material load by {@link livingMaterial}.
 *
 * So the number the harness reports is the cost of the **painter**, not the cost
 * of somebody's idea of what a thread looks like. The model stage is timed
 * separately and is a floor no renderer swap can move: it is the same JS in both
 * arms.
 *
 * Nothing here is production code and none of it is imported by the app.
 */

import {
  buildFleet,
  fixtureHistory,
  fleet20Spec,
  manifestFor,
  reduceAll,
  type Fleet,
} from '../../../packages/web/src/fleet/index.js'
import { layoutScene } from '../../../packages/web/src/scene/geometry.js'
import type { Point } from '../../../packages/web/src/scene/geometry.js'
import { breathOf, motionMode, sceneMarks, type SceneFrame } from '../../../packages/web/src/scene/marks/index.js'
import type { Mark, RibbonMark } from '../../../packages/web/src/scene/marks/index.js'
import type { Mote } from '../../../packages/web/src/scene/motes.js'
import { ICE_300, ICE_400, TISSUE_200, ink, type Ink, type Rgb } from '../../../packages/web/src/scene/palette.js'
import { PulseField } from '../../../packages/web/src/scene/pulses.js'
import { RETURN, returnAt, type RetireState } from '../../../packages/web/src/scene/retire.js'
import { salienceOf } from '../../../packages/web/src/scene/salience.js'

const NOW = Date.UTC(2026, 7, 4, 12, 0, 0)

/**
 * A fleet of `total` lanes, built the way `perf.test.ts`'s `fleetSized` builds
 * one — the real fixture, cloned across slots. Copied rather than imported
 * because it is test-local there, and the spike must not edit the suite.
 */
function fleetSized(total: number, salt: number): Fleet {
  const state = reduceAll(fixtureHistory(fleet20Spec(), NOW))
  const base = buildFleet(state, { now: NOW, manifest: manifestFor(fleet20Spec()) })
  return {
    ...base,
    lanes: Array.from({ length: total }, (_unused, i) => ({
      ...(base.lanes[(i + salt) % base.lanes.length] as (typeof base.lanes)[number]),
      id: `c${salt}-lane-${i}`,
      handles: [`c${salt}-lane-${i}`],
      slot: i,
    })),
  }
}

/** Two cords mid-withdraw — the structural cap's own concurrency, per colony. */
function midCut(salt: number): ReadonlyMap<string, RetireState> {
  return new Map([
    [`c${salt}-lane-3`, returnAt(RETURN.tensionMs + 300)],
    [`c${salt}-lane-11`, returnAt(RETURN.tensionMs + 520)],
  ])
}

function frameFor(fleet: Fleet, geometry: ReturnType<typeof layoutScene>, now: number): SceneFrame {
  return {
    fleet,
    geometry,
    field: new PulseField(),
    salience: salienceOf({ fleet, hoverId: null, selectedId: null }),
    now,
    asOf: now,
    vibrancy: 1,
    reducedMotion: false,
    paused: false,
    breath: breathOf(now, motionMode({ reducedMotion: false, paused: false })),
  }
}

// ---------------------------------------------------------------------------
// Placing a colony
// ---------------------------------------------------------------------------

const shift = (p: Point, dx: number, dy: number): Point => ({ x: p.x + dx, y: p.y + dy })
const shiftAll = (ps: readonly Point[], dx: number, dy: number): Point[] =>
  ps.map((p) => shift(p, dx, dy))

/**
 * A colony, moved into its seat in the world (prd-33 ruling 7).
 *
 * Marks are plain data by construction (`marks.test.ts` guards it with a
 * `structuredClone` conformance test), so placing a second colony is a pure
 * translation of its geometry rather than a second camera — which is what lets
 * all three colonies arrive at the painter as **one** list and be drawn in one
 * pass, exactly as they would be in the real thing.
 *
 * Screen-space chrome (`wash`, `grain`, the gap voice) is dropped from every
 * colony but the first: those are facts about the panel, and three of them would
 * be three vignettes.
 */
function place(marks: readonly Mark[], dx: number, dy: number, keepChrome: boolean): Mark[] {
  const out: Mark[] = []
  for (const mark of marks) {
    if (mark.kind === 'wash' || mark.kind === 'grain' || mark.role === 'gap') {
      if (keepChrome) out.push(mark)
      continue
    }
    switch (mark.kind) {
      case 'ribbon':
        out.push({
          ...mark,
          path: shiftAll(mark.path, dx, dy),
          outline: mark.outline.map((poly) => shiftAll(poly, dx, dy)),
          paint:
            'type' in mark.paint
              ? { ...mark.paint, from: shift(mark.paint.from, dx, dy), to: shift(mark.paint.to, dx, dy) }
              : mark.paint,
        })
        break
      case 'contour':
        out.push({
          ...mark,
          rings: mark.rings.map((r) => shiftAll(r, dx, dy)),
          shells: mark.shells?.map((s) => ({ ...s, rings: s.rings.map((r) => shiftAll(r, dx, dy)) })),
        })
        break
      case 'motes':
        out.push({ ...mark, items: mark.items.map((m) => ({ ...m, at: shift(m.at, dx, dy) })) })
        break
      case 'stroke':
        out.push({ ...mark, points: shiftAll(mark.points, dx, dy) })
        break
      default:
        out.push({ ...mark, at: shift(mark.at, dx, dy) })
        break
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// prd-33's material, laid over the display list
// ---------------------------------------------------------------------------

/** Where the one directional light is, as a unit vector in panel space. */
const LIGHT: Point = { x: -0.6, y: -0.8 }

/** How far the lit and shadowed sides of a thread part. Ruling 8's "lit from within". */
const SHADE = 0.45

/** How many ambient motes drift in the world. Ruling 8's ambient drift channel. */
export const AMBIENT_MOTES = 200

/**
 * prd-33's WORKLOAD, added to today's display list.
 *
 * ADR-0006 was decided against flat marks and no atmosphere. Measuring today's
 * scene would therefore re-answer a question nobody asked. These four are what
 * ruling 8 actually adds, each written in the display list's existing vocabulary
 * so both painters see it identically:
 *
 * 1. **Directional shading** — every living ribbon's flat ink becomes a
 *    `LinearPaint` ramp across the light axis. In canvas 2D that is a
 *    `createLinearGradient` per ribbon per frame; in WebGL it is two vertex
 *    colours and costs nothing. That asymmetry is not a thumb on the scale, it
 *    is the finding.
 * 2. **Subsurface light** — a soft glow under each living thread's body, so the
 *    material reads as lit from within rather than as a coloured shape.
 * 3. **Ambient drift** — {@link AMBIENT_MOTES} motes over the whole world, as
 *    one `motes` mark (prd-10 ruling 10's batching, honoured).
 * 4. **Depth haze** — already present as `depth-fog`; left alone, and counted.
 */
function livingMaterial(marks: readonly Mark[], t: number, width: number, height: number): Mark[] {
  const out: Mark[] = []

  for (const mark of marks) {
    if (mark.kind === 'ribbon' && mark.role === 'thread' && !('type' in mark.paint)) {
      const flat = mark.paint
      const lit = ramp(flat, mark, 1 + SHADE)
      out.push({ ...mark, paint: lit } as RibbonMark)
      // Subsurface: the body's own light, under it, at a fraction of its alpha.
      const mid = mark.path[Math.floor(mark.path.length / 2)]
      if (mid !== undefined) {
        out.push({
          kind: 'glow',
          role: 'thread-bloom',
          laneId: mark.laneId,
          alarm: mark.alarm,
          at: mid,
          radius: 14 + mark.widthRoot * 3,
          ink: ink(flat.rgb, flat.alpha * 0.22),
        })
      }
      continue
    }
    out.push(mark)
  }

  out.push(ambientDrift(t, width, height))
  return out
}

/** A flat ink, spread along the light axis: bright on the lit side, sunk on the other. */
function ramp(flat: Ink, mark: RibbonMark, gain: number): RibbonMark['paint'] {
  const head = mark.path[0] as Point
  const tail = mark.path[mark.path.length - 1] as Point
  const span = Math.max(1, Math.hypot(tail.x - head.x, tail.y - head.y))
  const from: Point = { x: head.x - LIGHT.x * span * 0.5, y: head.y - LIGHT.y * span * 0.5 }
  const to: Point = { x: head.x + LIGHT.x * span * 0.5, y: head.y + LIGHT.y * span * 0.5 }
  const scale = (f: number): Ink => ({
    rgb: [
      Math.min(255, Math.round(flat.rgb[0] * f)),
      Math.min(255, Math.round(flat.rgb[1] * f)),
      Math.min(255, Math.round(flat.rgb[2] * f)),
    ] as unknown as Rgb,
    alpha: flat.alpha,
  })
  return {
    type: 'linear',
    from,
    to,
    stops: [
      { at: 0, ink: scale(gain) },
      { at: 0.55, ink: flat },
      { at: 1, ink: scale(1 - SHADE) },
    ],
  }
}

/**
 * The ambient drift — one mark, {@link AMBIENT_MOTES} lights, no clock of its
 * own beyond `t`. Deterministic: the same `t` draws the same field on any
 * machine, which is what makes a re-run of this harness comparable.
 */
function ambientDrift(t: number, width: number, height: number): Mark {
  const items: Mote[] = []
  for (let i = 0; i < AMBIENT_MOTES; i += 1) {
    const phase = (i * 0.618033) % 1
    const drift = (t * 0.00004 * (0.4 + phase)) % 1
    const x = ((i * 97.13) % width) + Math.sin(t * 0.0004 + i) * 9
    const y = (((i * 61.7) % height) + drift * height) % height
    items.push({
      at: { x, y },
      radius: 1.6 + ((i * 7) % 5) * 0.5,
      ink: ink(i % 3 === 0 ? TISSUE_200 : i % 3 === 1 ? ICE_300 : ICE_400, 0.05 + ((i * 11) % 40) / 400),
    })
  }
  return { kind: 'motes', role: 'spore', laneId: null, alarm: false, items }
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

export interface WorldOptions {
  /** Lanes **per colony**. The headline axis: 30 today, 60 as the fleet grows. */
  lanes: number
  colonies: number
  width: number
  height: number
  /**
   * `living` is prd-33's material ({@link livingMaterial}); `flat` is today's
   * display list untouched. Measuring both is what makes this spike answer
   * ADR-0006's actual question — *did the workload change the trade?* — rather
   * than re-answering the 2026-08-02 one.
   */
  material?: 'living' | 'flat'
  /**
   * Drop the film grain. The one mark the WebGL arm does not implement, so the
   * gap between the arms is measured rather than waved at.
   */
  noGrain?: boolean
  /**
   * Drop the root-mass's iso-shells — the eighteen-to-twenty-six nested
   * translucent fills each colony's mass is bodied with (prd-07 ruling 5).
   *
   * This exists to bound the strongest objection to the whole spike: *canvas
   * could bake the mass to an offscreen canvas and blit it, so your fill cost is
   * self-inflicted.* That is a real and legitimate canvas technique. Rather than
   * argue it, this cell deletes the shells outright and measures what is left —
   * which is the **floor** such a cache could ever reach, since a cache cannot
   * beat not drawing the thing at all. Whatever canvas still costs here, the
   * objection cannot recover.
   */
  noShells?: boolean
}

export interface World {
  /** One frame's display list, for a given elapsed-ms. Times the model stage. */
  frame: (t: number) => { marks: Mark[]; modelMs: number }
  options: WorldOptions
}

/**
 * The world, ready to draw. Every colony is a full fleet with its own mass, its
 * own ring of threads and its own two cords mid-withdraw.
 *
 * `growth` advances every frame for every living lane, which is ruling 9's
 * "growing continuously while it lives" — and, for the measurement, the thing
 * that makes this an honest steady state rather than a cached still: a moving
 * growth fraction invalidates every spine, so `layoutScene` genuinely rebuilds
 * the geometry on each of the thirty seconds' worth of frames.
 */
export function makeWorld(options: WorldOptions): World {
  const { lanes, colonies, width, height } = options

  // Colonies are laid out in their own sub-panels and then placed. Two across,
  // second row centred — the shape a world of three organisms takes.
  const seats: { w: number; h: number; dx: number; dy: number }[] = []
  if (colonies === 1) seats.push({ w: width, h: height, dx: 0, dy: 0 })
  else {
    const cw = Math.floor(width / 2)
    const ch = Math.floor(height / 2)
    for (let i = 0; i < colonies; i += 1) {
      seats.push({
        w: cw,
        h: ch,
        dx: (i % 2) * cw,
        dy: Math.floor(i / 2) * ch + (i >= 2 ? 0 : 0),
      })
    }
  }

  const built = seats.map((seat, i) => ({
    seat,
    fleet: fleetSized(lanes, i),
    retire: midCut(i),
  }))

  return {
    options,
    frame: (t: number) => {
      const t0 = performance.now()
      const now = NOW + t
      let marks: Mark[] = []
      built.forEach(({ seat, fleet, retire }, i) => {
        // Continuous growth, per lane, moving every frame (ruling 9).
        const growth = new Map<string, number>()
        for (const lane of fleet.lanes) {
          const seed = (lane.slot * 0.37 + i * 0.11) % 1
          growth.set(lane.id, 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 0.0006 + seed * Math.PI * 2)))
        }
        const geometry = layoutScene(fleet, { width: seat.w, height: seat.h, now, retire, growth })
        const colony = sceneMarks(frameFor(fleet, geometry, now))
        marks = marks.concat(place(colony, seat.dx, seat.dy, i === 0))
      })
      if (options.noGrain === true) marks = marks.filter((mark) => mark.kind !== 'grain')
      if (options.noShells === true) {
        marks = marks.map((mark) =>
          mark.kind === 'contour' && mark.shells !== undefined ? { ...mark, shells: [] } : mark,
        )
      }
      const full =
        options.material === 'flat' ? marks : livingMaterial(marks, t, width, height)
      return { marks: full, modelMs: performance.now() - t0 }
    },
  }
}
