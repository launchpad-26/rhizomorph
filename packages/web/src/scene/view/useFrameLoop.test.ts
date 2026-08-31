import { reduceAll } from '@rhizomorph/core'
import { act, createEvent, fireEvent, render } from '@testing-library/react'
import { createElement, useRef, useState, type FunctionComponent } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildFleet, fixtureHistory, fleet20Spec, manifestFor, type Fleet } from '../../fleet/index.js'
import type { SceneGeometry } from '../geometry.js'
import { scenePaintCounts } from '../gl/index.js'
import type { ThemeName } from '../palette.js'
import { PulseField } from '../pulses.js'
import { RetireRegistry } from '../retire.js'
import { SettleRegistry } from '../settle.js'
import { useCamera, type CameraRig } from './useCamera.js'
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
 * TWO SUITES, because the gate has two halves and a pinned clock can only see
 * one of them. The first pins the clock (`now` is passed), which stops the rAF
 * and makes the counts belong to the gesture rather than to however many frames
 * elapsed. The second deliberately runs LIVE with the rAF in hand, because
 * every defect the first is blind to — the flight recursion, the in-handler
 * rebuild — needs a running loop and a React commit landing inside a gesture to
 * exist at all.
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

/**
 * A live snapshot source: no `now`, so the loop runs on the rAF like a real
 * page.
 *
 * Returns a FACTORY, and the split is the whole point. Production mints a fresh
 * state literal every render out of references that are stable across renders —
 * the fleet is a prop, the three registries are refs. A factory that rebuilt
 * the fleet each call would invalidate the gate on every render for a reason no
 * real page has, and the drag law below would report a clean zero while
 * measuring nothing.
 */
function liveSource(): () => SceneLatestState {
  const { now: _now, asOf: _asOf, ...base } = stateFor('dark')
  return () => ({ ...base })
}

/**
 * A mouse event that carries a `view`, which is not a thing jsdom will make.
 *
 * d3-zoom follows a drag by registering mousemove/mouseup on `event.view` and
 * asks `dragDisable` for that window's document, so a press without one is a
 * press it cannot follow. jsdom's `MouseEvent` constructor rejects every
 * candidate for `view` under vitest, so the property is defined on the built
 * event instead — `SceneView.test.tsx` carries the long form of this note.
 */
function withView(event: Event): Event {
  Object.defineProperty(event, 'view', { value: window, configurable: true })
  return event
}

interface HarnessProps {
  state: SceneLatestState
  host: HTMLDivElement
  canvas: HTMLCanvasElement
  overlay: HTMLCanvasElement
  onRig?: (rig: CameraRig) => void
}

/**
 * SceneView's own wiring, minus everything that is not the loop.
 *
 * `latestRef.current` is a FRESH OBJECT every render, and that is not a detail
 * — it is the one property the repaint gate keys on, and a harness that held
 * one object for the life of a mount diverged from production in exactly the
 * place the gate reads. Every internal re-render (`setPanning`, which the loop
 * itself fires at both ends of a drag) would have kept the same identity here
 * while production minted a new literal, so the laws below would pass against a
 * gate no real drag could satisfy. `SceneView.tsx` rebuilds the whole literal
 * on every render; this copies it.
 */
const Harness: FunctionComponent<HarnessProps> = ({ state, host, canvas, overlay, onRig }) => {
  const hostRef = useRef<HTMLDivElement | null>(host)
  const canvasRef = useRef<HTMLCanvasElement | null>(canvas)
  const overlayRef = useRef<HTMLCanvasElement | null>(overlay)
  const geometryRef = useRef<SceneGeometry | null>(null)
  const latestRef = useRef<SceneLatestState>({ ...state })
  latestRef.current = { ...state }
  const rig = useCamera(canvasRef, latestRef)
  useFrameLoop(hostRef, canvasRef, overlayRef, geometryRef, latestRef, rig, () => {}, state.now)
  onRig?.(rig)
  return null
}

/** The counters live for one test FILE — vitest isolates the module registry
 * per file (`isolate` defaults to true and `vitest.config.ts` does not override
 * it) — but many laws run against them inside this one, so each reads a DELTA. */
function since(before: { builds: number; repaints: number }) {
  const now = scenePaintCounts()
  return { builds: now.builds - before.builds, repaints: now.repaints - before.repaints }
}

function surfaces() {
  const host = document.createElement('div')
  const canvas = document.createElement('canvas')
  const overlay = document.createElement('canvas')
  host.append(canvas, overlay)
  document.body.append(host)
  return { host, canvas, overlay }
}

describe('a camera change repaints without rebuilding (prd-47 ruling 1)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  /**
   * The measured host, and the ResizeObserver that reports a change to it.
   *
   * Both are mutable on purpose: `dpr`, `width` and `height` are the three gate
   * terms that are NOT in the state object, and the only production path that
   * moves them is this observer — which changes them without React rendering at
   * all. A law that cannot fire it cannot see those three terms.
   */
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
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => rect as DOMRect,
    )
    const observers: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          observers.push(callback)
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    const { host, canvas, overlay } = surfaces()
    const state = stateFor(theme)
    let rig!: CameraRig
    const utils = render(
      createElement(Harness, { state, host, canvas, overlay, onRig: (r) => (rig = r) }),
    )
    return {
      canvas,
      state,
      rig: () => rig,
      /** Re-render with a snapshot that differs in exactly the named fields. */
      rerender: (changed: Partial<SceneLatestState>) =>
        utils.rerender(
          createElement(Harness, {
            state: { ...state, ...changed },
            host,
            canvas,
            overlay,
            onRig: (r) => (rig = r),
          }),
        ),
      /** A resize, through the only path production has for one. */
      resizeTo: (next: { width?: number; height?: number; dpr?: number }) => {
        if (next.width !== undefined) rect.width = next.width
        if (next.height !== undefined) rect.height = next.height
        if (next.dpr !== undefined) {
          Object.defineProperty(window, 'devicePixelRatio', {
            value: next.dpr,
            configurable: true,
          })
        }
        for (const observe of observers) observe([], {} as ResizeObserver)
      },
    }
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

  it('moves the parity seam onto the rig, so it cannot go stale-and-green', () => {
    // A repaint that forgot to update `painted.camera` passes the law above and
    // fails this one — which is why both exist. The camera suite reads a
    // frame's camera off this seam.
    //
    // Asserted against the RIG rather than against the previous frame: "it
    // changed" is the weak form, and a repaint writing a wrong-but-different
    // camera satisfies it. The seam's whole job is to report the camera the
    // frame was painted under, so that is what is compared.
    const m = mount()
    pinch(m.canvas, { x: 300, y: 120 }, -120)
    expect(lastPaintedFrame()?.camera).toEqual(m.rig().cameraRef.current)
    const first = lastPaintedFrame()?.camera

    pinch(m.canvas, { x: 620, y: 60 }, -240)

    expect(lastPaintedFrame()?.camera).toEqual(m.rig().cameraRef.current)
    expect(lastPaintedFrame()?.camera).not.toEqual(first)
  })

  it('rebuilds when the theme moved under the retained frame', () => {
    // `ground` and `lightBlend` are baked into the retained frame by
    // `buildFrame`, so a repaint across a theme change would paint the old
    // palette's floor under the new palette's page. One instance of the law
    // below rather than a term of its own — the gate compares the state's own
    // keys, so it cannot be told which field moved, and does not need to be.
    //
    // The re-render changes the theme and NOTHING else: every other field is
    // the same reference it was. A snapshot rebuilt from scratch would
    // invalidate on the fleet alone and this law would pass without the theme
    // ever being compared.
    const m = mount('dark')
    pinch(m.canvas, { x: 300, y: 120 }, -120)

    m.rerender({ theme: 'light' })
    const before = scenePaintCounts()
    pinch(m.canvas, { x: 420, y: 90 }, -120)

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
    const m = mount()
    const unselected = JSON.stringify(lastPaintedFrame()?.marks ?? [])
    const lane = m.state.fleet.lanes[0]?.id ?? 'lane-0'

    m.rerender({ selectedId: lane })
    const before = scenePaintCounts()
    pinch(m.canvas, { x: 300, y: 120 }, -120)

    expect(since(before)).toEqual({ builds: 1, repaints: 0 })
    // …and the rebuild is what makes it a fix rather than a counter moving.
    // Compared against the picture painted BEFORE the selection, because
    // "a mark carries this lane's id" is true of every frame ever painted and
    // would pass whether or not the selection reached the picture.
    expect(JSON.stringify(lastPaintedFrame()?.marks ?? [])).not.toBe(unselected)
  })

  it('repaints across a render that changed nothing — the drag commit case', () => {
    // The other direction, and the reason the gate compares fields rather than
    // object identity. `SceneView` mints a fresh state literal on every render
    // and `setPanning` commits one at both ends of every drag; a gate reading
    // identity therefore refused the first move of every real gesture. Nothing
    // in this snapshot moved, so the retained frame is still the truth.
    const m = mount()
    m.rerender({})
    const before = scenePaintCounts()

    pinch(m.canvas, { x: 300, y: 120 }, -120)

    expect(since(before)).toEqual({ builds: 0, repaints: 1 })
  })

  /**
   * THE THREE TERMS THAT ARE NOT IN THE STATE OBJECT.
   *
   * `dpr`, `width` and `height` reach the frame through the ResizeObserver,
   * which changes them without React rendering — so `sameSceneState` cannot see
   * a resize, and `resize()` itself does not redraw. Without these three terms
   * a resize followed by a camera nudge replays the old-size frame, and under a
   * pinned clock it does so indefinitely.
   *
   * One law per term, because one law for all three is killed by deleting any
   * one of them and therefore says nothing about the other two. Before these
   * existed, deleting all three left the whole scene suite green.
   */
  for (const term of [
    { name: 'the device pixel ratio', change: { dpr: 2 } },
    { name: 'the width', change: { width: 700 } },
    { name: 'the height', change: { height: 400 } },
  ]) {
    it(`rebuilds when ${term.name} moved under the retained frame`, () => {
      const m = mount()
      pinch(m.canvas, { x: 300, y: 120 }, -120)

      m.resizeTo(term.change)
      const before = scenePaintCounts()
      pinch(m.canvas, { x: 420, y: 90 }, -120)

      expect(since(before)).toEqual({ builds: 1, repaints: 0 })
    })
  }

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

/**
 * THE RUNNING LOOP — what a pinned clock structurally cannot see.
 *
 * Every law above pins the clock, and a pinned clock has no rAF, no camera
 * flight and no React commit landing in the middle of a gesture. All three
 * defects below need exactly those, and all three were live on the first form
 * of this change.
 *
 * The rAF is stubbed into a hand-driven queue rather than left to jsdom, so a
 * "tick" is a statement about one frame instead of a race with the scheduler —
 * still a count, never a clock.
 *
 * Each input event is flushed in its own `act()`. That is not tidiness: a
 * harness that batched a press and the moves after it never let React commit
 * the `setPanning` render between them, and the whole class of defect here is
 * *what happens to a gesture when a commit lands inside it*. Batched, this
 * suite reports a clean zero and means nothing.
 */
describe('a running loop is not re-entered by the camera it is moving (prd-47 ruling 1)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  const LiveHarness: FunctionComponent<{
    host: HTMLDivElement
    canvas: HTMLCanvasElement
    overlay: HTMLCanvasElement
    onMount: (rig: CameraRig, rerender: () => void, select: (id: string | null) => void) => void
    onFailure: (message: string | null) => void
  }> = ({ host, canvas, overlay, onMount, onFailure }) => {
    const hostRef = useRef<HTMLDivElement | null>(host)
    const canvasRef = useRef<HTMLCanvasElement | null>(canvas)
    const overlayRef = useRef<HTMLCanvasElement | null>(overlay)
    const geometryRef = useRef<SceneGeometry | null>(null)
    // A fresh literal every render over stable references, exactly as
    // `SceneView` does it — the property the repaint gate reads.
    const source = useRef(liveSource())
    const [, bump] = useState(0)
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const latestRef = useRef<SceneLatestState>(source.current())
    latestRef.current = { ...source.current(), selectedId }
    const rig = useCamera(canvasRef, latestRef)
    useFrameLoop(hostRef, canvasRef, overlayRef, geometryRef, latestRef, rig, onFailure, undefined)
    onMount(rig, () => bump((n) => n + 1), setSelectedId)
    return null
  }

  function mountLive() {
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
    let queued: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      queued.push(callback)
      return queued.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const { host, canvas, overlay } = surfaces()
    let rig!: CameraRig
    let rerender!: () => void
    let select!: (id: string | null) => void
    let failure: string | null = null
    render(
      createElement(LiveHarness, {
        host,
        canvas,
        overlay,
        onMount: (r, b, s) => {
          rig = r
          rerender = b
          select = s
        },
        onFailure: (message) => (failure = message),
      }),
    )
    /** One frame of the loop, and only one. */
    const tick = () => {
      const pending = queued
      queued = []
      act(() => {
        for (const callback of pending) callback(0)
      })
    }
    return {
      canvas,
      tick,
      rig: () => rig,
      rerender: () => act(() => rerender()),
      select: (id: string | null) => act(() => select(id)),
      failure: () => failure,
    }
  }

  const pinch = (canvas: HTMLCanvasElement, at: { x: number; y: number }, deltaY: number) => {
    act(() => fireEvent.wheel(canvas, { deltaY, ctrlKey: true, clientX: at.x, clientY: at.y }))
  }

  /**
   * A camera far enough from the fit camera that `flight()` gives it a real
   * duration. Without this the flight takes the JUMP path (`durationMs <= 0`)
   * and never steps at all — the near-miss that first reported this defect
   * fixed, so the law asserts the flight is genuinely armed before it counts.
   */
  const armFlight = (m: ReturnType<typeof mountLive>) => {
    act(() => m.rig().moveTo({ k: 4, x: -900, y: -400 }))
    m.tick()
    act(() => m.rig().fit())
    expect(m.rig().flightRef.current).not.toBeNull()
  }

  it('a flight tick after a React commit builds once, and the scene keeps drawing', () => {
    /**
     * The fatal arm. `drawFrame` steps a live flight before it paints, and
     * `stepFlight` moves the camera through `zoom.transform` — which lands in
     * the `zoom` handler on the running build's own stack. `builtFrom` is
     * assigned at the END of a build, so a repaint gate reading it there saw a
     * stale one, called `drawFrame` again, stepped the flight again, and
     * recursed until the stack blew. `guard` catches that `RangeError`, sets
     * `stopped` and reports a failure — so the scene stops drawing for good,
     * until remount.
     *
     * The arming condition is ordinary: `setPanning(false)` commits at the end
     * of every drag. Drag, then press Fit or Home, and the scene died.
     * Measured on the first form of this change at 478 builds and
     * "Maximum call stack size exceeded"; on `main`, and here, at one build.
     */
    const m = mountLive()
    m.tick()
    armFlight(m)
    m.rerender()

    const before = scenePaintCounts()
    m.tick()

    expect(since(before)).toEqual({ builds: 1, repaints: 0 })
    expect(m.failure()).toBeNull()
    // …and the loop is still alive: `stopped` would make every later tick 0/0.
    const next = scenePaintCounts()
    m.tick()
    expect(since(next).builds).toBe(1)
  })

  it('a flight tick submits the frame once, never twice', () => {
    // The milder arm of the same line, and the one that needs no re-render at
    // all: with `builtFrom` still current, the flight's own camera move passed
    // the gate and repainted — so every tick of every flight submitted the
    // frame twice, a build and a repaint, against `main`'s one.
    const m = mountLive()
    m.tick()
    armFlight(m)

    const before = scenePaintCounts()
    m.tick()

    expect(since(before)).toEqual({ builds: 1, repaints: 0 })
  })

  it('no move of a real drag builds inside the input handler', () => {
    /**
     * PRD success 1 on the path the operator actually takes, and the one place
     * this change could be worse than `main` rather than better.
     *
     * `setPanning(true)` commits a render as the press lands, `SceneView` mints
     * a fresh state literal, and a gate reading object identity therefore
     * refused the very first mousemove — running a full `layoutScene` +
     * `sceneMarks` + `buildFrame` synchronously inside the input handler, on
     * precisely the event this issue exists to answer faster. `main` builds
     * nothing in that handler; the first form of this change built once per
     * React commit landing mid-gesture.
     *
     * Both terms are load-bearing. `builds: 0` is the regression; `repaints: 4`
     * is the win — a gate that refused these moves and merely deferred them to
     * the rAF would report `builds: 0` too, and would have given the hand back
     * exactly nothing.
     */
    const m = mountLive()
    m.tick()
    const before = scenePaintCounts()

    act(() =>
      fireEvent(
        m.canvas,
        withView(createEvent.mouseDown(m.canvas, { clientX: 300, clientY: 120, button: 0 })),
      ),
    )
    expect(since(before)).toEqual({ builds: 0, repaints: 0 })

    for (const x of [310, 320, 330, 340]) {
      act(() =>
        fireEvent(window, withView(createEvent.mouseMove(window, { clientX: x, clientY: 120 }))),
      )
    }

    expect(since(before)).toEqual({ builds: 0, repaints: 4 })
  })

  it('a refused repaint waits for the frame already coming, instead of building in the handler', () => {
    /**
     * The other half of the same guarantee, and the one the law above cannot
     * reach: there the gate passes, so nothing is ever refused.
     *
     * When something in the snapshot HAS moved, the retained frame is a lie and
     * the repaint is correctly refused — but under a running loop a refusal
     * must cost nothing at all, because the `zoom` handler has already written
     * the new camera to `rig.cameraRef` and the rAF about to run reads it
     * there. That is exactly what `main` did for every camera move before this
     * issue, which is the only sense in which "never worse than `main`" is a
     * fact rather than a claim. Building here instead puts a full model stage
     * inside the input handler on the frame the operator is dragging.
     *
     * A PINNED clock is the opposite case and has its own laws above: there
     * nothing else will draw, so the refusal has to build or the picture never
     * resolves.
     */
    const m = mountLive()
    m.tick()
    m.select('lane-anything')
    const before = scenePaintCounts()

    pinch(m.canvas, { x: 300, y: 120 }, -120)

    // Refused, and free: the selection means the retained frame may not be
    // replayed, and the frame that will pick it up is already scheduled.
    expect(since(before)).toEqual({ builds: 0, repaints: 0 })

    m.tick()

    expect(since(before)).toEqual({ builds: 1, repaints: 0 })
  })
})
