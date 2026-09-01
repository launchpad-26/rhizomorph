import { describe, expect, it } from 'vitest'
import { MAIN_SELECTION } from '../../fleet/index.js'
import type { Camera } from '../camera.js'
import type { Point, SceneGeometry, ThreadGeometry } from '../geometry.js'
import { HIT_RADIUS, ROOT_HIT_SLACK, pickAt, type ViewOrigin } from './hitTest.js'

/**
 * `pickAt`'s OWN LAWS, in isolation from the model stage — the thing that
 * becoming pure (#159) makes possible for the first time. Every geometry
 * below is a small literal rather than a real fleet's layout: `pickAt` reads
 * only `threads[].node`, `threads[].laneId`, `centre` and `rootRadius`, so a
 * fixture that fills in nothing else is the honest minimum, not a shortcut.
 */

const IDENTITY: Camera = { k: 1, x: 0, y: 0 }
const ORIGIN_ZERO: ViewOrigin = { left: 0, top: 0 }
/** Far from every fixture's lanes and mass, so "outside everything" is unambiguous. */
const FAR_AWAY = { x: -100_000, y: -100_000 }

/** `pickAt` never reads a thread's `lane` payload — only `node` and `laneId`. */
function thread(laneId: string, node: Point): ThreadGeometry {
  return {
    laneId,
    lane: {} as unknown as ThreadGeometry['lane'],
    angle: 0,
    path: [],
    node,
    outward: { x: 1, y: 0 },
    widthRoot: 1,
    widthTip: 1,
    sizeFrac: 0,
    ageFrac: 0,
    lifeFrac: 0,
    germinatedFrom: null,
    growth: 1,
    filaments: [],
    bud: null,
    knot: null,
    rogue: null,
    label: { anchor: node, align: 'left' },
    pathology: null,
    alarm: false,
    retire: null,
  }
}

function geometryOf(threads: ThreadGeometry[], centre: Point, rootRadius: number): SceneGeometry {
  return {
    width: 900,
    height: 500,
    centre,
    rootRadius,
    rootFullness: 1,
    rx: rootRadius,
    ry: rootRadius,
    threads,
    byLane: new Map(threads.map((t) => [t.laneId, t])),
    labelPolicy: 'all',
  }
}

/** Two lanes, well apart from each other and from a distant mass. */
function twoLanes(): SceneGeometry {
  return geometryOf(
    [thread('lane-a', { x: 200, y: 200 }), thread('lane-b', { x: 400, y: 200 })],
    { x: 300, y: 900 },
    40,
  )
}

describe('pickAt', () => {
  it('picks the nearest lane inside HIT_RADIUS', () => {
    const geometry = twoLanes()
    expect(pickAt(geometry, ORIGIN_ZERO, IDENTITY, 205, 205)).toBe('lane-a')
    expect(pickAt(geometry, ORIGIN_ZERO, IDENTITY, 395, 205)).toBe('lane-b')
  })

  it('is null one pixel past HIT_RADIUS — the boundary is real', () => {
    const geometry = twoLanes()
    const node = geometry.threads[0]?.node as Point
    // Exactly on the boundary still counts (`<`, not `<=`, is the miss).
    expect(pickAt(geometry, ORIGIN_ZERO, IDENTITY, node.x + HIT_RADIUS - 1, node.y)).toBe('lane-a')
    expect(pickAt(geometry, ORIGIN_ZERO, IDENTITY, node.x + HIT_RADIUS + 1, node.y)).toBeNull()
  })

  /**
   * THE LOAD-BEARING CASE. The same `clientX`/`clientY` must pick a different
   * lane depending on the origin alone — proof the origin is actually being
   * subtracted, not just accepted and ignored.
   *
   * Mutation this survives: dropping `- origin.left` (or `- origin.top`) from
   * `pickAt`'s `toWorld` call returns `lane-a` for both origins below, because
   * the world point would never move off `(300, 300)`.
   */
  it('applies the origin — the same pointer picks a different lane at a different origin', () => {
    const geometry = geometryOf(
      [thread('lane-a', { x: 300, y: 300 }), thread('lane-b', { x: 200, y: 250 })],
      { x: -5_000, y: -5_000 },
      10,
    )
    const clientX = 300
    const clientY = 300

    expect(pickAt(geometry, { left: 0, top: 0 }, IDENTITY, clientX, clientY)).toBe('lane-a')
    expect(pickAt(geometry, { left: 100, top: 50 }, IDENTITY, clientX, clientY)).toBe('lane-b')
  })

  describe('radii are screen quantities, divided by the scale', () => {
    /**
     * The tolerance is `HIT_RADIUS / camera.k`. A node `HIT_RADIUS * 1.5`
     * WORLD units away is outside the un-scaled radius, so this only passes
     * while the division by `k` is really happening.
     */
    it('widens the tolerance at a small k', () => {
      const k = 0.5
      const node = { x: 100, y: 0 }
      const geometry = geometryOf([thread('lane-a', node)], FAR_AWAY, 1)
      const worldOffset = HIT_RADIUS * 1.5
      const clientX = (node.x + worldOffset) * k

      expect(pickAt(geometry, ORIGIN_ZERO, { k, x: 0, y: 0 }, clientX, 0)).toBe('lane-a')
    })

    it('narrows the tolerance at a large k', () => {
      const k = 2
      const node = { x: 100, y: 0 }
      const geometry = geometryOf([thread('lane-a', node)], FAR_AWAY, 1)
      const worldOffset = HIT_RADIUS * 1.5
      const clientX = (node.x + worldOffset) * k

      expect(pickAt(geometry, ORIGIN_ZERO, { k, x: 0, y: 0 }, clientX, 0)).toBeNull()
    })
  })

  it('picks a lane over the mass when the pointer is inside both', () => {
    // The mass sits right where the lane is, so only the "lanes first" rule
    // can be what makes this pick the lane.
    const node = { x: 300, y: 300 }
    const geometry = geometryOf([thread('lane-a', node)], node, 50)

    expect(pickAt(geometry, ORIGIN_ZERO, IDENTITY, node.x, node.y)).toBe('lane-a')
  })

  describe('the mass, and its slack', () => {
    function massOnly(): SceneGeometry {
      return geometryOf([], { x: 500, y: 500 }, 50)
    }

    it('selects MAIN inside the rim', () => {
      const { centre } = massOnly()
      expect(pickAt(massOnly(), ORIGIN_ZERO, IDENTITY, centre.x, centre.y)).toBe(MAIN_SELECTION)
    })

    it('still selects MAIN inside the slack, just past the rim', () => {
      const geometry = massOnly()
      const { centre, rootRadius } = geometry
      const x = centre.x + rootRadius + ROOT_HIT_SLACK - 1
      expect(pickAt(geometry, ORIGIN_ZERO, IDENTITY, x, centre.y)).toBe(MAIN_SELECTION)
    })

    it('is null well past the slack', () => {
      const geometry = massOnly()
      const { centre, rootRadius } = geometry
      const x = centre.x + rootRadius + ROOT_HIT_SLACK + 1
      expect(pickAt(geometry, ORIGIN_ZERO, IDENTITY, x, centre.y)).toBeNull()
    })
  })

  describe('the failure paths', () => {
    it('is null with no geometry', () => {
      expect(pickAt(null, ORIGIN_ZERO, IDENTITY, 0, 0)).toBeNull()
    })

    it('is null with no origin — the pre-mount case', () => {
      // `originRef` always exists, but a caller may still hold `null` before
      // the frame loop's mount effect has run its first `resize()`.
      expect(pickAt(twoLanes(), null, IDENTITY, 205, 205)).toBeNull()
    })
  })

  it('is a pure read: repeated calls agree and the geometry is untouched', () => {
    const geometry = twoLanes()
    const before = structuredClone(geometry)

    const results = [
      pickAt(geometry, ORIGIN_ZERO, IDENTITY, 205, 205),
      pickAt(geometry, ORIGIN_ZERO, IDENTITY, 205, 205),
      pickAt(geometry, ORIGIN_ZERO, IDENTITY, 205, 205),
    ]

    expect(results).toEqual(['lane-a', 'lane-a', 'lane-a'])
    expect(geometry).toEqual(before)
  })
})
