import { reduceAll } from '@observatory/core'
import { describe, expect, it } from 'vitest'
import {
  buildFleet,
  fixtureHistory,
  manifestFor,
  pathologySpec,
  type Fleet,
} from '../fleet/index.js'
import {
  CLICK_DISTANCE,
  FIT_DURATION_MAX_MS,
  FIT_PADDING,
  IDENTITY,
  SCALE_EXTENT,
  VISIBLE_SLIVER,
  ZOOM_STEP,
  boundsCentre,
  clampScale,
  contentBounds,
  fitCamera,
  flight,
  gestureFilter,
  isContentVisible,
  scaleAbout,
  toScreen,
  toWorld,
  translateExtentFor,
  wheelDelta,
  type Bounds,
  type Camera,
} from './camera.js'
import { layoutScene, type SceneGeometry } from './geometry.js'

/**
 * THE CAMERA'S LAWS.
 *
 * All of it is arithmetic over `{ k, x, y }`, which is the point: the vehicle
 * that drives these transforms in a browser is d3-zoom, but a browser is not
 * where a reader finds out whether zooming at the cursor keeps the cursor still.
 * `SceneView.test.tsx` pins the wiring — that a real ctrl+wheel event on the
 * real canvas produces the transform these laws describe; this file pins the
 * laws themselves, so a failure says *which* one broke.
 */

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)
const VIEWPORT = { width: 900, height: 500 }

function fleet(): Fleet {
  const spec = pathologySpec()
  return buildFleet(reduceAll(fixtureHistory(spec, NOW)), { now: NOW, manifest: manifestFor(spec) })
}

function geometry(): SceneGeometry {
  return layoutScene(fleet(), { ...VIEWPORT, now: NOW })
}

/** A known box, so the fit arithmetic is checkable by hand rather than by hope. */
const BOX: Bounds = { minX: 100, minY: 100, maxX: 300, maxY: 200 }

describe('the two coordinate spaces', () => {
  it('round-trips a point through any transform', () => {
    const camera: Camera = { k: 2.5, x: -140, y: 63 }
    const world = { x: 317, y: -12.5 }
    const back = toWorld(camera, toScreen(camera, world))

    expect(back.x).toBeCloseTo(world.x, 10)
    expect(back.y).toBeCloseTo(world.y, 10)
  })

  it('is the identity transform when the camera is home', () => {
    expect(toWorld(IDENTITY, { x: 42, y: 7 })).toEqual({ x: 42, y: 7 })
    expect(toScreen(IDENTITY, { x: 42, y: 7 })).toEqual({ x: 42, y: 7 })
  })
})

describe('zoom at the pointer', () => {
  /**
   * The law the whole gesture rests on, and the classic mistake it guards
   * against: d3-zoom scales about the *centre* of its extent unless it is
   * handed a focal point, which feels like the scene is sliding away from you.
   */
  it('leaves the point under the cursor exactly where it was', () => {
    const focus = { x: 712, y: 96 }
    const before = { k: 1.3, x: -40, y: 25 }
    const world = toWorld(before, focus)

    for (const factor of [1.4, 0.7, 2, 1 / 3]) {
      const after = scaleAbout(before, factor, focus)
      const moved = toScreen(after, world)
      expect(moved.x).toBeCloseTo(focus.x, 9)
      expect(moved.y).toBeCloseTo(focus.y, 9)
    }
  })

  it('still holds the focal point when the scale clamps at an extent', () => {
    // The clamp must move the *scale* and nothing else. A naive implementation
    // that clamps after computing the translation drifts here, and the drift is
    // only visible at the extremes — which is where a user leans on the wheel.
    const focus = { x: 120, y: 400 }
    const at = { k: SCALE_EXTENT[1], x: 15, y: -60 }
    const world = toWorld(at, focus)

    const after = scaleAbout(at, 3, focus)
    expect(after.k).toBe(SCALE_EXTENT[1])
    expect(toScreen(after, world).x).toBeCloseTo(focus.x, 9)
    expect(toScreen(after, world).y).toBeCloseTo(focus.y, 9)
  })

  it('clamps to the scale extent from both ends', () => {
    expect(clampScale(1e6)).toBe(SCALE_EXTENT[1])
    expect(clampScale(0)).toBe(SCALE_EXTENT[0])
    expect(clampScale(1)).toBe(1)

    expect(scaleAbout({ k: 5, x: 0, y: 0 }, 10, { x: 0, y: 0 }).k).toBe(SCALE_EXTENT[1])
    expect(scaleAbout({ k: 0.5, x: 0, y: 0 }, 0.01, { x: 0, y: 0 }).k).toBe(SCALE_EXTENT[0])
  })

  it('reaches both extents in a sane number of keypresses', () => {
    // A step nobody can be bothered to repeat is a step nobody uses. Six or so
    // presses from home to either end is the budget.
    const presses = (factor: number) => {
      let k = 1
      let n = 0
      while (clampScale(k * factor) !== k && n < 100) {
        k = clampScale(k * factor)
        n += 1
      }
      return n
    }

    expect(presses(ZOOM_STEP)).toBeLessThanOrEqual(6)
    expect(presses(1 / ZOOM_STEP)).toBeLessThanOrEqual(4)
  })
})

describe('what there is to look at', () => {
  it('covers every drawn thing, not just the nodes', () => {
    const scene = geometry()
    const bounds = contentBounds(scene)

    for (const thread of scene.threads) {
      for (const point of thread.path) {
        expect(point.x).toBeGreaterThanOrEqual(bounds.minX)
        expect(point.x).toBeLessThanOrEqual(bounds.maxX)
        expect(point.y).toBeGreaterThanOrEqual(bounds.minY)
        expect(point.y).toBeLessThanOrEqual(bounds.maxY)
      }
      expect(thread.label.anchor.x).toBeGreaterThanOrEqual(bounds.minX)
      expect(thread.label.anchor.x).toBeLessThanOrEqual(bounds.maxX)
    }
  })

  it('includes the rogue reach, which is the part that leaves the rim', () => {
    // The staged fixture has a trespass; its filament is drawn past every node
    // and is exactly the thing a viewport-shaped fit would crop.
    const scene = geometry()
    const rogue = scene.threads.find((thread) => thread.rogue !== null)
    expect(rogue, 'the staged fixture lost its off-fence lane').toBeDefined()

    const bounds = contentBounds(scene)
    for (const point of rogue?.rogue?.path ?? []) {
      expect(point.x).toBeGreaterThanOrEqual(bounds.minX)
      expect(point.y).toBeGreaterThanOrEqual(bounds.minY)
      expect(point.x).toBeLessThanOrEqual(bounds.maxX)
      expect(point.y).toBeLessThanOrEqual(bounds.maxY)
    }
  })

  it('is the root-mass alone when there are no lanes', () => {
    const empty = layoutScene(buildFleet(reduceAll([]), { now: NOW }), { ...VIEWPORT, now: NOW })
    const bounds = contentBounds(empty)

    expect(boundsCentre(bounds).x).toBeCloseTo(VIEWPORT.width / 2, 9)
    expect(boundsCentre(bounds).y).toBeCloseTo(VIEWPORT.height / 2, 9)
    expect(bounds.maxX - bounds.minX).toBeCloseTo(empty.rootRadius * 2, 9)
  })
})

describe('fit', () => {
  it('computes the transform a known layout deserves', () => {
    // 200×100 of content, 32px of padding either side, in 900×500: width needs
    // (900-64)/200 = 4.18, height needs (500-64)/100 = 4.36, so width binds.
    const camera = fitCamera(BOX, VIEWPORT)

    expect(camera.k).toBeCloseTo((VIEWPORT.width - FIT_PADDING * 2) / 200, 9)
    // And the box's centre lands on the viewport's centre.
    const centre = toScreen(camera, boundsCentre(BOX))
    expect(centre.x).toBeCloseTo(VIEWPORT.width / 2, 9)
    expect(centre.y).toBeCloseTo(VIEWPORT.height / 2, 9)
  })

  it('takes whichever axis binds', () => {
    const tall: Bounds = { minX: 0, minY: 0, maxX: 100, maxY: 1000 }
    const camera = fitCamera(tall, VIEWPORT)
    expect(camera.k).toBeCloseTo((VIEWPORT.height - FIT_PADDING * 2) / 1000, 9)
  })

  it('leaves the whole network on screen, with its padding', () => {
    const scene = geometry()
    const bounds = contentBounds(scene)
    const camera = fitCamera(bounds, VIEWPORT)

    const topLeft = toScreen(camera, { x: bounds.minX, y: bounds.minY })
    const bottomRight = toScreen(camera, { x: bounds.maxX, y: bounds.maxY })

    expect(topLeft.x).toBeGreaterThanOrEqual(FIT_PADDING - 0.001)
    expect(topLeft.y).toBeGreaterThanOrEqual(FIT_PADDING - 0.001)
    expect(bottomRight.x).toBeLessThanOrEqual(VIEWPORT.width - FIT_PADDING + 0.001)
    expect(bottomRight.y).toBeLessThanOrEqual(VIEWPORT.height - FIT_PADDING + 0.001)
  })

  it('obeys the scale extent rather than magnifying a speck to fill the panel', () => {
    const speck: Bounds = { minX: 400, minY: 240, maxX: 402, maxY: 242 }
    expect(fitCamera(speck, VIEWPORT).k).toBe(SCALE_EXTENT[1])

    const vast: Bounds = { minX: -50_000, minY: -50_000, maxX: 50_000, maxY: 50_000 }
    expect(fitCamera(vast, VIEWPORT).k).toBe(SCALE_EXTENT[0])
  })
})

describe('reset', () => {
  it('is the identity transform, and that is all it is', () => {
    expect(IDENTITY).toEqual({ k: 1, x: 0, y: 0 })
    // Home is where the layout put things: at identity, world *is* screen, so
    // every node is exactly where `geometry.ts` laid it out.
    const scene = geometry()
    const node = scene.threads[0]?.node
    expect(node).toBeDefined()
    expect(toScreen(IDENTITY, node ?? { x: 0, y: 0 })).toEqual(node)
  })
})

describe('the way home', () => {
  it('arcs out on the way, and ends exactly on target', () => {
    const from: Camera = { k: 5.5, x: -3_100, y: -1_400 }
    const to = fitCamera(contentBounds(geometry()), VIEWPORT)
    const path = flight(from, to, VIEWPORT)

    expect(path.durationMs).toBeGreaterThan(0)
    expect(path.at(0).k).toBeCloseTo(from.k, 6)
    expect(path.at(1)).toEqual(to)

    // Van Wijk's whole point: the flight pulls *out* as it travels rather than
    // scaling straight through, so what you are leaving and what you are
    // arriving at are both on screen the whole way. A plain interpolation would
    // put the midpoint at the geometric mean of the two scales; the arc is
    // always wider than that.
    expect(path.at(0.5).k).toBeLessThan(Math.sqrt(from.k * to.k))
  })

  it('pulls out past both ends when the journey is a long one', () => {
    // A pan across the whole scene at a scale neither end wants to change: the
    // only way to keep both ends visible is to rise above both.
    const from: Camera = { k: 1, x: -1_800, y: -1_000 }
    const to: Camera = { k: 1.4, x: 0, y: 0 }
    const path = flight(from, to, VIEWPORT)

    expect(path.at(0.5).k).toBeLessThan(Math.min(from.k, to.k))
  })

  it('is capped at the keypress budget, however far it has to fly', () => {
    // Van Wijk suggests upwards of two seconds for the corner-of-the-world
    // case. Fit is bound to a key; two seconds of animation on a keypress is
    // not a camera control, it is a cutscene.
    const corner: Camera = { k: SCALE_EXTENT[1], x: -5_000, y: -2_500 }
    const path = flight(corner, IDENTITY, VIEWPORT)

    expect(path.durationMs).toBe(FIT_DURATION_MAX_MS)

    // Short hops still get the shorter duration — the suggestion is the pacing,
    // the cap is only a ceiling.
    const nudge = flight({ k: 1.05, x: -6, y: 3 }, IDENTITY, VIEWPORT)
    expect(nudge.durationMs).toBeGreaterThan(0)
    expect(nudge.durationMs).toBeLessThan(FIT_DURATION_MAX_MS)
  })

  it('never overruns its ends, whatever it is handed', () => {
    const path = flight(IDENTITY, { k: 3, x: -100, y: -200 }, VIEWPORT)
    expect(path.at(-1)).toEqual(path.at(0))
    expect(path.at(2)).toEqual(path.at(1))
  })

  it('has nowhere to go when it is already there', () => {
    // Zero duration is the signal SceneView reads to jump instead of animating.
    expect(flight(IDENTITY, IDENTITY, VIEWPORT).durationMs).toBe(0)
  })
})

describe('recentre', () => {
  it('sees the network when the camera is home', () => {
    const bounds = contentBounds(geometry())
    expect(isContentVisible(IDENTITY, VIEWPORT, bounds)).toBe(true)
    expect(isContentVisible(fitCamera(bounds, VIEWPORT), VIEWPORT, bounds)).toBe(true)
  })

  it('does not, once the network has been panned off the side', () => {
    const bounds = contentBounds(geometry())
    const gone: Camera = { k: 1, x: -(bounds.maxX + 10), y: 0 }
    expect(isContentVisible(gone, VIEWPORT, bounds)).toBe(false)
  })

  it('counts a sliver at the edge as gone, because it cannot be read', () => {
    const bounds: Bounds = { minX: 0, minY: 0, maxX: 400, maxY: 400 }
    const sliver: Camera = { k: 1, x: -(400 - VISIBLE_SLIVER + 1), y: 0 }
    expect(isContentVisible(sliver, VIEWPORT, bounds)).toBe(false)

    const enough: Camera = { k: 1, x: -(400 - VISIBLE_SLIVER - 1), y: 0 }
    expect(isContentVisible(enough, VIEWPORT, bounds)).toBe(true)
  })

  it('is answered in either axis, not just horizontally', () => {
    const bounds: Bounds = { minX: 0, minY: 0, maxX: 400, maxY: 400 }
    expect(isContentVisible({ k: 1, x: 0, y: -600 }, VIEWPORT, bounds)).toBe(false)
  })
})

describe('the pan bounds', () => {
  it('gives a viewport of slack in every direction — generous, but finite', () => {
    const [low, high] = translateExtentFor(VIEWPORT)
    expect(low).toEqual([-VIEWPORT.width, -VIEWPORT.height])
    expect(high).toEqual([VIEWPORT.width * 2, VIEWPORT.height * 2])

    // Finite is the load-bearing half: an infinite extent is a scene that can
    // be thrown away, and Recenter can only find what is still in bounds.
    expect(Number.isFinite(low[0]) && Number.isFinite(high[0])).toBe(true)
  })
})

describe('which events the camera claims', () => {
  const wheel = (init: WheelEventInit) => new WheelEvent('wheel', init)
  const mouse = (type: string, init: MouseEventInit) => new MouseEvent(type, init)

  it('leaves a plain wheel to the page, so the panel can be scrolled past', () => {
    expect(gestureFilter(wheel({ deltaY: 120 }))).toBe(false)
  })

  it('takes ctrl and cmd wheel — which is also how a trackpad pinch arrives', () => {
    expect(gestureFilter(wheel({ deltaY: 4, ctrlKey: true }))).toBe(true)
    expect(gestureFilter(wheel({ deltaY: 120, metaKey: true }))).toBe(true)
  })

  it('pans on left and middle drag, and leaves right to the context menu', () => {
    expect(gestureFilter(mouse('mousedown', { button: 0 }))).toBe(true)
    expect(gestureFilter(mouse('mousedown', { button: 1 }))).toBe(true)
    expect(gestureFilter(mouse('mousedown', { button: 2 }))).toBe(false)
  })

  it('leaves ctrl-click alone, because on a Mac that is a right click', () => {
    expect(gestureFilter(mouse('mousedown', { button: 0, ctrlKey: true }))).toBe(false)
  })

  it('scales a trackpad pinch and a mouse notch to comparable steps', () => {
    // d3's default boosts every ctrlKey wheel ×10 for the pinch case, which
    // turns one ctrl+notch on a mouse into a 4× jump. Both of these should be
    // one comfortable step, not one step and one leap.
    const pinch = wheelDelta(wheel({ deltaY: -6, ctrlKey: true }))
    const notch = wheelDelta(wheel({ deltaY: -100, ctrlKey: true }))

    expect(Math.pow(2, pinch)).toBeLessThan(1.15)
    expect(Math.pow(2, notch)).toBeLessThan(1.2)
    expect(Math.pow(2, notch)).toBeGreaterThan(1.05)
  })

  it('zooms out when the wheel goes the other way', () => {
    expect(wheelDelta(wheel({ deltaY: 100, ctrlKey: true }))).toBeLessThan(0)
    expect(wheelDelta(wheel({ deltaY: -100, ctrlKey: true }))).toBeGreaterThan(0)
  })

  it('reads line and page wheel modes without treating them as pixels', () => {
    const lines = wheelDelta(wheel({ deltaY: -3, deltaMode: 1 }))
    const pixels = wheelDelta(wheel({ deltaY: -100, deltaMode: 0 }))
    // Three lines and a hundred pixels are the same notch on the same mouse.
    expect(lines).toBeCloseTo(0.15, 6)
    expect(pixels).toBeCloseTo(0.2, 6)
  })

  it('keeps a click distinguishable from a drag by a hand tremor', () => {
    expect(CLICK_DISTANCE).toBeGreaterThan(0)
    expect(CLICK_DISTANCE).toBeLessThan(10)
  })
})
