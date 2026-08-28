import { describe, expect, it } from 'vitest'
import { ICE_200, ink } from '../palette.js'
import { createScenePainter, scenePaintCounts, type ScenePainter } from './index.js'
import type { Mark } from '../marks/index.js'

/**
 * THE REPAINT SEAM (prd-47 ruling 1, #156) — the painter's half.
 *
 * `createScenePainter` is where the retained frame lives, so it is where a
 * camera change either does or does not cost a build. Under jsdom both contexts
 * are null, so neither `gl.submit` nor `overlay.draw` does anything — which is
 * fine and is the point: what is under test here is the DECISION (build vs.
 * replay the retained frame), and that decision is taken above both painters.
 *
 * Every assertion is a count or an identity. Nothing here reads a clock.
 */
describe('the scene painter repaints without rebuilding (prd-47 ruling 1)', () => {
  const PANEL = { width: 900, height: 260 }

  function thread(y: number): Mark {
    return {
      kind: 'stroke',
      role: 'thread',
      laneId: null,
      alarm: false,
      points: [
        { x: 0, y },
        { x: 300, y },
      ],
      width: 2,
      ink: ink(ICE_200, 1),
    }
  }

  function painterFor(): ScenePainter {
    return createScenePainter(document.createElement('canvas'), document.createElement('canvas'))
  }

  /** The counters outlive this file and one worker runs many against it, so
   * every law below reads a DELTA. */
  function since(before: { builds: number; repaints: number }) {
    const now = scenePaintCounts()
    return { builds: now.builds - before.builds, repaints: now.repaints - before.repaints }
  }

  it('a repaint after a paint builds nothing', () => {
    const painter = painterFor()
    const before = scenePaintCounts()

    painter.paint({ ...PANEL, marks: [thread(80)], camera: { k: 1, x: 0, y: 0 }, dpr: 1 })
    expect(since(before)).toEqual({ builds: 1, repaints: 0 })

    const moved = painter.repaint({ ...PANEL, camera: { k: 1.4, x: 30, y: -12 }, dpr: 1 })
    expect(moved).toBe(true)
    expect(since(before)).toEqual({ builds: 1, repaints: 1 })
  })

  it('a repaint with nothing retained declines, and is not counted as one', () => {
    // The fallback the frame loop depends on for every frame between mount and
    // the first build. A `true` here would send the loop down a path with no
    // frame to replay.
    const painter = painterFor()
    const before = scenePaintCounts()

    expect(painter.repaint({ ...PANEL, camera: { k: 1, x: 0, y: 0 }, dpr: 1 })).toBe(false)
    expect(since(before)).toEqual({ builds: 0, repaints: 0 })
  })

  it('three cameras in a row still build once — the second call is where a rebuild would hide', () => {
    const painter = painterFor()
    const before = scenePaintCounts()

    painter.paint({ ...PANEL, marks: [thread(80)], camera: { k: 1, x: 0, y: 0 }, dpr: 1 })
    for (const camera of [
      { k: 1.2, x: 10, y: 0 },
      { k: 1.6, x: 24, y: -8 },
      { k: 2.1, x: 40, y: -20 },
    ]) {
      expect(painter.repaint({ ...PANEL, camera, dpr: 1 })).toBe(true)
    }
    expect(since(before)).toEqual({ builds: 1, repaints: 3 })
  })

  it('the retained frame is read, never replaced', () => {
    // `last` is what every later repaint replays. A repaint that rebuilt it —
    // or that reset the shared Batch underneath it — would pass the counting
    // laws above and quietly hand the next repaint a different picture.
    const painter = painterFor()
    const built = painter.paint({
      ...PANEL,
      marks: [thread(80)],
      camera: { k: 1, x: 0, y: 0 },
      dpr: 1,
    })
    const vertices = built.vertices.n
    expect(vertices).toBeGreaterThan(0)

    painter.repaint({ ...PANEL, camera: { k: 2, x: 8, y: 4 }, dpr: 1 })

    expect(painter.last).toBe(built)
    expect(painter.last?.vertices.n).toBe(vertices)
  })
})
