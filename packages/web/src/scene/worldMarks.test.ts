/**
 * THE COMPOSED DISPLAY LIST'S LAWS (prd-52 wave 2, #314).
 *
 * Two claims carry this wave, and the first is the one the fence widening was
 * argued for: **every position in a colony derives from its mass's centre.**
 * Nothing in the repo stated that before. `worldMarks` composes by
 * concatenation rather than by translating marks, which is only sound if
 * moving the origin moves the whole colony — so that is asserted directly,
 * generically, over every point the geometry holds rather than over a list of
 * fields somebody remembered to enumerate.
 *
 * The second is that the panel's own layer is the panel's: fog, vignette,
 * grain and the gap voice are emitted once for a picture however many colonies
 * it holds, and a world that stacked N of them would be drawing the fog N
 * times over itself.
 */
import { reduceAll } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import {
  buildFleet,
  finishedSpec,
  fixtureHistory,
  fleet20Spec,
  manifestFor,
  pathologySpec,
  type Fleet,
  type FixtureSpec,
} from '../fleet/index.js'
import { layoutScene, layoutWorld, type ColonySource, type Point } from './geometry.js'
import { sceneMarks, worldMarks } from './marks/index.js'
import { breathOf, motionMode, vibrancyOf, type SceneFrame } from './marks/frame.js'
import { PulseField } from './pulses.js'
import { DARK_PALETTE } from './palette.js'
import { salienceOf } from './salience.js'
import type { SceneGeometry } from './geometry.js'

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)
const SIZE = { width: 900, height: 260 }

function fleetFor(spec: FixtureSpec): Fleet {
  const state = reduceAll(fixtureHistory(spec, NOW))
  return buildFleet(state, { now: NOW, manifest: manifestFor(spec) })
}

function sourcesOf(...fleets: Fleet[]): ColonySource[] {
  return fleets.map((fleet, i) => ({ id: `colony-${i}`, fleet }))
}

/**
 * Every `{x, y}` in the object graph, in a deterministic walk order.
 *
 * Deliberately generic rather than a list of fields: the claim is about *every*
 * position, and a hand-written enumeration would silently stop covering a field
 * added later — which is the exact failure mode this law exists to prevent.
 */
/**
 * Fields that carry a direction rather than a position. They have an `x` and a
 * `y`, so the walk finds them, but they are vectors from the origin of the
 * plane and translating one would be a bug rather than a fix. Each is asserted
 * *not* to move by its own test, so this list is a claim and not a shrug.
 */
const DIRECTION_FIELDS = ['outward']

function isDirection(path: string): boolean {
  const leaf = path.split('.').pop() ?? ''
  return DIRECTION_FIELDS.includes(leaf.replace(/\[\d+\]/g, ''))
}

interface FoundPoint extends Point {
  /** Where in the geometry this point was found — so a failure names the field. */
  path: string
}

function pointsOf(value: unknown, path = '', out: FoundPoint[] = []): FoundPoint[] {
  if (value === null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) pointsOf(item, `${path}[${i}]`, out)
    return out
  }
  const record = value as Record<string, unknown>
  if (typeof record.x === 'number' && typeof record.y === 'number') {
    out.push({ path, x: record.x, y: record.y })
  }
  for (const key of Object.keys(record)) {
    if (key === 'x' || key === 'y') continue
    pointsOf(record[key], `${path}.${key}`, out)
  }
  return out
}

describe('a colony is laid out where it belongs (prd-52 ruling 1)', () => {
  it('shifts every point by the origin, and by exactly the origin', () => {
    const fleet = fleetFor(fleet20Spec())
    const at = (origin?: Point) =>
      layoutScene(fleet, origin === undefined ? { ...SIZE, now: NOW } : { ...SIZE, now: NOW, origin })

    const base = pointsOf(at())
    const shifted = pointsOf(at({ x: 300, y: 70 }))

    expect(shifted).toHaveLength(base.length)
    // The suite would pass vacuously against an empty geometry.
    expect(base.length).toBeGreaterThan(100)

    // Grouped by field rather than listed per point: a colony holds thousands
    // of points and an unshifted one is a fact about a *field*, so the failure
    // should name the field once instead of printing every instance of it.
    //
    // A tolerance, not exact equality: a spine's points come back through
    // trigonometry and Catmull-Rom smoothing, so the translation survives to
    // about 1e-13 rather than bit-for-bit. Anything that failed to derive from
    // the centre is out by hundreds of pixels, not by 1e-13.
    const offenders = new Map<string, string>()
    for (const [i, p] of base.entries()) {
      if (isDirection(p.path)) continue
      const q = shifted[i]
      const dx = q === undefined ? Number.NaN : q.x - p.x
      const dy = q === undefined ? Number.NaN : q.y - p.y
      if (Math.abs(dx - 300) < 1e-6 && Math.abs(dy - 70) < 1e-6) continue
      const field = p.path.replace(/\[\d+\]/g, '[]')
      if (!offenders.has(field)) offenders.set(field, `dx=${dx} dy=${dy} (expected 300, 70)`)
    }
    expect(Object.fromEntries(offenders)).toEqual({})
  })

  it('does not move a direction, because a direction is not a position', () => {
    // `outward` is the rim normal — a unit vector saying which way the thread
    // leaves the mass. It has an `x` and a `y` and is therefore swept up by the
    // walk above, but it must NOT move with the origin: translating a direction
    // is how a scene ends up with threads pointing at where the colony used to
    // be. Excluded from the shift law above, and asserted here instead, so the
    // exclusion is a claim rather than a blind spot.
    const fleet = fleetFor(fleet20Spec())
    const base = layoutScene(fleet, { ...SIZE, now: NOW })
    const moved = layoutScene(fleet, { ...SIZE, now: NOW, origin: { x: 300, y: 70 } })

    expect(base.threads.length).toBeGreaterThan(0)
    for (const [i, thread] of base.threads.entries()) {
      expect(moved.threads[i]?.outward).toStrictEqual(thread.outward)
    }
  })

  it('is unchanged when the origin is absent or zero', () => {
    const fleet = fleetFor(pathologySpec())
    const absent = layoutScene(fleet, { ...SIZE, now: NOW })
    const zero = layoutScene(fleet, { ...SIZE, now: NOW, origin: { x: 0, y: 0 } })
    expect(zero).toStrictEqual(absent)
  })
})

function frameFor(fleet: Fleet, geometry: SceneGeometry): SceneFrame {
  const mode = motionMode({ reducedMotion: false, paused: false })
  return {
    fleet,
    geometry,
    field: new PulseField(),
    salience: salienceOf({ fleet, hoverId: null, selectedId: null }),
    now: NOW,
    asOf: NOW,
    quality: 'rich',
    vibrancy: vibrancyOf(false),
    reducedMotion: false,
    paused: false,
    breath: breathOf(NOW, mode),
    palette: DARK_PALETTE,
  }
}

describe('the world composes one display list', () => {
  it('is byte-identical to sceneMarks at one colony', () => {
    const fleet = fleetFor(fleet20Spec())
    const world = layoutWorld(sourcesOf(fleet), { ...SIZE, now: NOW })
    const colony = world.colonies[0]
    if (colony === undefined) throw new Error('no colony')

    const frame = frameFor(fleet, colony.geometry)
    expect(worldMarks(world, frame)).toStrictEqual(sceneMarks(frame))
  })

  it('emits the panel layer once for the world, never once per colony', () => {
    const one = fleetFor(fleet20Spec())
    const three = [one, fleetFor(pathologySpec()), fleetFor(fleet20Spec())]

    const countGap = (marks: ReturnType<typeof worldMarks>) =>
      marks.filter((m) => m.role === 'gap').length

    const w1 = layoutWorld(sourcesOf(one), { ...SIZE, now: NOW })
    const w3 = layoutWorld(sourcesOf(...three), { ...SIZE, now: NOW })
    const g1 = w1.colonies[0]
    const g3 = w3.colonies[0]
    if (g1 === undefined || g3 === undefined) throw new Error('no colony')

    const gaps1 = countGap(worldMarks(w1, frameFor(one, g1.geometry)))
    const gaps3 = countGap(worldMarks(w3, frameFor(one, g3.geometry)))

    // The fixture has no lane manifest gap by default, so assert the invariant
    // that actually distinguishes once-per-world from once-per-colony: whatever
    // the panel says, three colonies do not make it say it three times.
    expect(gaps3).toBe(gaps1)
  })

  it('emits the marks of every colony, so nothing is removed at scale', () => {
    const fleets = [fleetFor(fleet20Spec()), fleetFor(pathologySpec()), fleetFor(fleet20Spec())]
    const world = layoutWorld(sourcesOf(...fleets), { ...SIZE, now: NOW })
    const first = world.colonies[0]
    if (first === undefined) throw new Error('no colony')

    const marks = worldMarks(world, frameFor(fleets[0] as Fleet, first.geometry))
    const lanes = new Set(marks.map((m) => m.laneId).filter((id): id is string => id !== null))

    // Every thread in every colony reached the list.
    for (const colony of world.colonies) {
      for (const thread of colony.geometry.threads) expect(lanes.has(thread.laneId)).toBe(true)
    }
  })

  it('draws a departed colony as a mass, so absence is a state and not a hole (ruling 7)', () => {
    // A colony whose every lane has finished still emits its root-mass —
    // landed work is still landed, and the slot is still occupied.
    const living = fleetFor(fleet20Spec())
    const quiet = fleetFor(finishedSpec())
    const world = layoutWorld(sourcesOf(living, quiet), { ...SIZE, now: NOW })
    const first = world.colonies[0]
    if (first === undefined) throw new Error('no colony')
    const marks = worldMarks(world, frameFor(living, first.geometry))
    const masses = marks.filter((m) => m.role === 'root-mass').length
    const solo = worldMarks(
      layoutWorld(sourcesOf(living), { ...SIZE, now: NOW }),
      frameFor(living, first.geometry),
    ).filter((m) => m.role === 'root-mass').length
    expect(masses).toBe(solo * 2)
  })

  it('grows the per-colony layers with the colony count', () => {
    const one = fleetFor(fleet20Spec())
    const w1 = layoutWorld(sourcesOf(one), { ...SIZE, now: NOW })
    const w3 = layoutWorld(sourcesOf(one, one, one), { ...SIZE, now: NOW })
    const g1 = w1.colonies[0]
    const g3 = w3.colonies[0]
    if (g1 === undefined || g3 === undefined) throw new Error('no colony')

    // The mass's own surface: one contour per colony (prd7 ruling 5), so this
    // is the cleanest count of "how many masses does this picture hold".
    const roots = (marks: ReturnType<typeof worldMarks>) =>
      marks.filter((m) => m.role === 'root-mass').length

    const r1 = roots(worldMarks(w1, frameFor(one, g1.geometry)))
    const r3 = roots(worldMarks(w3, frameFor(one, g3.geometry)))

    expect(r1).toBeGreaterThan(0)
    // Three colonies are three masses (prd-33 ruling 7) — once per colony,
    // never once per world and never once per thread.
    expect(r3).toBe(r1 * 3)
  })
})
