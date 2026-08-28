import { reduceAll } from '@rhizomorph/core'
import { fireEvent, render } from '@testing-library/react'
import { createElement, useRef, type FunctionComponent } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildFleet, fixtureHistory, fleet20Spec, manifestFor, type Fleet } from '../../fleet/index.js'
import type { SceneGeometry } from '../geometry.js'
import { scenePaintCounts } from '../gl/index.js'
import type { ThemeName } from '../palette.js'
import { PulseField } from '../pulses.js'
import { RetireRegistry } from '../retire.js'
import { SettleRegistry } from '../settle.js'
import { useCamera } from './useCamera.js'
import { lastPaintedFrame, useFrameLoop, type SceneLatestState } from './useFrameLoop.js'

/**
 * THE CAMERA ANSWERS WITHOUT A REBUILD (prd-47 ruling 1, #156) — the loop's half.
 *
 * PRD success 1 is about the MODEL stage, and this file cannot see it directly:
 * `layoutScene` and `sceneMarks` live in prd-33's territory, outside this
 * lane's fence. `scenePaintCounts()` stands in for them by the call graph —
 * `paint()` is the only caller of `buildFrame`, `drawFrame` the only caller of
 * `paint()`, and the model stage runs only inside `drawFrame` — so `builds`
 * unchanged across a frame is exactly "no model stage ran". The reasoning lives
 * on the counter itself in `gl/index.ts`.
 *
 * Every law here is a count or an identity. Nothing reads a clock: under
 * `--maxWorkers` a wall clock measures the machine, which is the defect prd-24
 * named and prd-44 success 6 inherited.
 *
 * The clock is PINNED (`now` is passed), which is what stops the rAF and makes
 * the counts belong to the gesture rather than to however many frames elapsed.
 */
const NOW = Date.UTC(2026, 7, 4, 12, 0, 0)
const HOST = { width: 900, height: 260 }

function fleet(): Fleet {
  const state = reduceAll(fixtureHistory(fleet20Spec(), NOW))
  return buildFleet(state, { now: NOW, manifest: manifestFor(fleet20Spec()) })
}

function stateFor(theme: ThemeName): SceneLatestState {
  return {
    fleet: fleet(),
    field: new PulseField(),
    settle: new SettleRegistry(),
    retire: new RetireRegistry(),
    quality: 'rich',
    selectedId: null,
    hoverId: null,
    reducedMotion: false,
    paused: false,
    hideFinished: false,
    theme,
    now: NOW,
    asOf: NOW,
    replaying: false,
  }
}

interface HarnessProps {
  state: SceneLatestState
  host: HTMLDivElement
  canvas: HTMLCanvasElement
  overlay: HTMLCanvasElement
}

/** SceneView's own wiring, minus everything that is not the loop. */
const Harness: FunctionComponent<HarnessProps> = ({ state, host, canvas, overlay }) => {
  const hostRef = useRef<HTMLDivElement | null>(host)
  const canvasRef = useRef<HTMLCanvasElement | null>(canvas)
  const overlayRef = useRef<HTMLCanvasElement | null>(overlay)
  const geometryRef = useRef<SceneGeometry | null>(null)
  const latestRef = useRef<SceneLatestState>(state)
  latestRef.current = state
  const rig = useCamera(canvasRef, latestRef)
  useFrameLoop(hostRef, canvasRef, overlayRef, geometryRef, latestRef, rig, () => {}, state.now)
  return null
}

describe('a camera change repaints without rebuilding (prd-47 ruling 1)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  function mount(theme: ThemeName = 'dark') {
    const rect = {
      ...HOST,
      top: 0,
      left: 0,
      right: HOST.width,
      bottom: HOST.height,
      x: 0,
      y: 0,
      toJSON() {},
    }
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue(rect as DOMRect)
    const host = document.createElement('div')
    const canvas = document.createElement('canvas')
    const overlay = document.createElement('canvas')
    host.append(canvas, overlay)
    document.body.append(host)
    const utils = render(
      createElement(Harness, { state: stateFor(theme), host, canvas, overlay }),
    )
    return { canvas, utils, host, overlay }
  }

  /** The counters outlive this file, so every law reads a DELTA. */
  function since(before: { builds: number; repaints: number }) {
    const now = scenePaintCounts()
    return { builds: now.builds - before.builds, repaints: now.repaints - before.repaints }
  }

  const pinch = (canvas: HTMLCanvasElement, at: { x: number; y: number }, deltaY: number) => {
    fireEvent.wheel(canvas, { deltaY, ctrlKey: true, clientX: at.x, clientY: at.y })
  }

  it('answers a camera change with no build at all', () => {
    // PRD success 1, and the whole issue. Before this, the `zoom` handler set
    // the camera ref and painted nothing under a live clock; the hand waited
    // for the next rAF's full rebuild.
    const { canvas } = mount()
    const before = scenePaintCounts()

    pinch(canvas, { x: 300, y: 120 }, -120)

    expect(since(before)).toEqual({ builds: 0, repaints: 1 })
  })

  it('moves the parity seam with the repaint, so it cannot go stale-and-green', () => {
    // A repaint that forgot to update `painted.camera` passes the law above and
    // fails this one — which is why both exist. The camera suite reads a
    // frame's camera off this seam.
    const { canvas } = mount()
    pinch(canvas, { x: 300, y: 120 }, -120)
    const first = lastPaintedFrame()?.camera
    pinch(canvas, { x: 620, y: 60 }, -240)
    const second = lastPaintedFrame()?.camera

    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(second).not.toEqual(first)
  })

  it('rebuilds when the theme moved under the retained frame', () => {
    // `ground` and `lightBlend` are baked into the retained frame by
    // `buildFrame`, so a repaint across a theme change would paint the old
    // palette's floor under the new palette's page. One instance of the law
    // below rather than a term of its own — the gate reads the state's
    // identity, so it cannot be told which field moved, and does not need to be.
    const { canvas, utils, host, overlay } = mount('dark')
    pinch(canvas, { x: 300, y: 120 }, -120)

    utils.rerender(
      createElement(Harness, { state: stateFor('light'), host, canvas, overlay }),
    )
    const before = scenePaintCounts()
    pinch(canvas, { x: 420, y: 90 }, -120)

    expect(since(before)).toEqual({ builds: 1, repaints: 0 })
  })

  it('rebuilds when ANYTHING else moved under the retained frame, not only the theme', () => {
    /**
     * The case the first form of this gate got wrong, and the one every other
     * law here is blind to: they all move the camera and nothing else, so none
     * of them re-renders between the build and the gesture.
     *
     * A frame is built from the whole `SceneLatestState`. A gate naming four
     * fields replayed a frame that predated a selection — and under a pinned
     * clock there is no rAF and `SceneView`'s redraw effect keys on
     * `[hideFinished, theme, motion]`, so the stale picture never resolved: an
     * operator in replay selected a lane, nudged the camera to look at it, and
     * the selection did not appear. Measured against `main`, where the same
     * sequence rebuilt and picked it up.
     *
     * `selectedId` stands in for the whole class here — hover, quality, pause,
     * reduced motion, the replay flag and the fleet itself all reach the frame
     * the same way and none of them is named in the gate by design.
     */
    const { canvas, utils, host, overlay } = mount()
    const unselected = JSON.stringify(lastPaintedFrame()?.marks ?? [])
    const lane = fleet().lanes[0]?.id ?? 'lane-0'
    const selected = { ...stateFor('dark'), selectedId: lane }

    utils.rerender(createElement(Harness, { state: selected, host, canvas, overlay }))
    const before = scenePaintCounts()
    pinch(canvas, { x: 300, y: 120 }, -120)

    expect(since(before)).toEqual({ builds: 1, repaints: 0 })
    // …and the rebuild is what makes it a fix rather than a counter moving.
    // Compared against the picture painted BEFORE the selection, because
    // "a mark carries this lane's id" is true of every frame ever painted and
    // would pass whether or not the selection reached the picture.
    expect(JSON.stringify(lastPaintedFrame()?.marks ?? [])).not.toBe(unselected)
  })

  it('five camera moves in a row still build nothing — where a rebuild would hide', () => {
    const { canvas } = mount()
    const before = scenePaintCounts()

    for (const [i, at] of [
      { x: 200, y: 100 },
      { x: 260, y: 110 },
      { x: 320, y: 120 },
      { x: 380, y: 130 },
      { x: 440, y: 140 },
    ].entries()) {
      pinch(canvas, at, -60 - i)
    }

    expect(since(before)).toEqual({ builds: 0, repaints: 5 })
  })

  it('a camera that did not move costs nothing at all', () => {
    // A gesture that ends where it started, or a wheel the scale extent
    // clamped: d3 still fires `zoom`, and without this guard every one of them
    // would repaint the identical picture.
    const { canvas } = mount()
    pinch(canvas, { x: 300, y: 120 }, -120)
    const before = scenePaintCounts()

    // Same event again: d3-zoom fires, and the transform it computes is the one
    // already in the ref for a zoom already at the extent.
    fireEvent.wheel(canvas, { deltaY: 0, ctrlKey: true, clientX: 300, clientY: 120 })

    expect(since(before)).toEqual({ builds: 0, repaints: 0 })
  })
})
