import { createEvent as rhizomorphEvent, reduceAll } from '@rhizomorph/core'
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { Component, type ReactNode } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ModeProvider } from '../app/ModeContext.js'
import { writePreference } from '../settings/registry.js'
import { StreamProvider } from '../app/StreamContext.js'
import {
  FleetProvider,
  SelectionProvider,
  buildFleet,
  finishedSpec,
  fixtureHistory,
  MAIN_SELECTION,
  manifestFor,
  pathologySpec,
  type Fleet,
} from '../fleet/index.js'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import { SCALE_EXTENT, ZOOM_STEP } from './camera.js'
import { RECENCY_SPAN_MS, layoutScene } from './geometry.js'
import { PulseField } from './pulses.js'
import { laneIndex } from './resolve.js'
import { RetireRegistry } from './retire.js'
import { SettleRegistry } from './settle.js'
import { recordingGl } from './gl/recorder.js'
import { CANVAS_UNAVAILABLE_MESSAGE, lastPaintedFrame } from './view/useFrameLoop.js'
import Scene, { SceneView } from './index.js'
// Straight from the module, not the barrel: `scene/index.ts` is outside this
// issue's fence, and `MotionControl` is exported for this test alone (#389).
import { MotionControl } from './SceneView.js'
import { discloseText } from '../disclosure/testing.js'

/**
 * THE RENDER-COUNTING SEAM (#159) — `SceneView` calls `cursorOf` exactly once
 * per render, in its className, so counting calls to it counts renders. Real
 * behaviour passes straight through (`...actual`); only the count is added.
 */
const renders = vi.hoisted(() => ({ n: 0 }))
vi.mock('./view/input.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./view/input.js')>()
  return {
    ...actual,
    cursorOf: (...args: Parameters<typeof actual.cursorOf>) => {
      renders.n++
      return actual.cursorOf(...args)
    },
  }
})

// @gate-timing — load-sensitive under `--maxWorkers` (#124, #130, #144,
// #151, #157, #172, #189) (#209). scripts/gate.sh greps for this exact
// marker to route the whole file into its serial, alone timing pass instead
// of the 4x load batches — the file is the unit gate.sh excludes at, same as
// before this issue. Carry this comment with the file if you rename or move
// it; a file without it is invisible to that pass.

/**
 * THE SCENE, MOUNTED — the wiring, end to end.
 *
 * What the picture *contains* is settled in `marks.test.ts` against the display
 * list; this suite is about the seams either side of it: that the real component
 * reads the real fleet through the real providers, that the three sources (keys
 * 1/2/3) each reach it, and that it survives an environment with no canvas at
 * all.
 *
 * jsdom has no 2D context, so nothing here is painted — which is itself the
 * thing worth pinning. A missing context must leave the panel standing rather
 * than take the page down with it (architecture.md: if the scene breaks, the
 * panel grid stands alone).
 */

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Pinned, so the fixtures fold identically and the frame loop draws once. */
const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

class FakeEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  close() {}
}

/** The honest wave-1 state: a server that has not shipped `/api/lanes` yet. */
const noLaneManifest = async () => ({ ok: false, json: async () => null })

/**
 * Mounts with no 2D context by default — jsdom's own answer, stated explicitly
 * rather than left to its "not implemented" warning path. The one test that
 * needs a context installs its own.
 */
async function mountScene() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  return mountWithCanvas()
}

async function mountWithCanvas() {
  const utils = render(
    <ModeProvider>
      <StreamProvider url="/api/stream" now={NOW} createSource={() => new FakeEventSource()}>
        <FleetProvider now={NOW} fetchLanes={noLaneManifest}>
          <SelectionProvider>
            <Scene now={NOW} />
          </SelectionProvider>
        </FleetProvider>
      </StreamProvider>
    </ModeProvider>,
  )
  await act(async () => {})
  return utils
}

function summary(): string {
  return screen.getByTestId('scene-summary').textContent ?? ''
}

/** Switches the driving log, exactly as an operator's keypress does. */
async function pressKey(key: string) {
  await act(async () => {
    fireEvent.keyDown(window, { key })
  })
}

describe('the three sources, keys 1 / 2 / 3', () => {
  /**
   * One mount, driven through all three sources in key order across four
   * sequential `beforeAll` hooks — not once per `it`, and not inside the
   * timed test bodies. Each `it` below used to mount fresh and re-drive a
   * fixture from scratch: the same per-test-rebuild cost #87 hoisted away
   * from the attention suite, compounded here by a real ~8,000-event fold and
   * detector pass over a real 20-lane fleet. That fold is inherently the most
   * expensive thing this file does; it belongs in setup, timed against
   * vitest's `hookTimeout` (10s per hook) rather than the tighter default
   * `testTimeout` (5s) each `it` body races. A single hook doing all four
   * steps would still have to fit the whole chain in one 10s window — worse
   * headroom than the four independent 5s-per-test windows it replaces — so
   * each step gets its own `beforeAll`, its own full 10s. The `it`s below
   * only assert against the summaries already captured: same real fold, real
   * detectors, real fixtures, paid for once and off the clock they're read on.
   */
  let liveSummary = ''
  let fleet20Summary = ''
  let pathologySummary = ''
  let backToLiveSummary = ''

  beforeAll(async () => {
    await mountScene()
    liveSummary = summary()
  })

  beforeAll(async () => {
    await pressKey('2')
    fleet20Summary = summary()
  })

  beforeAll(async () => {
    await pressKey('3')
    pathologySummary = summary()
  })

  beforeAll(async () => {
    await pressKey('1')
    backToLiveSummary = summary()
  })

  afterAll(() => {
    cleanup()
  })

  it('starts on the live stream and says so honestly when it is empty', () => {
    // Connected but idle is not the same as not connected, and neither is a
    // fleet: an empty live log threads nothing, and claims nothing either.
    expect(liveSummary).toContain('0 lanes threaded')
  })

  it('threads all twenty lanes of the scale fixture on key 2', () => {
    expect(fleet20Summary).toContain('20 lanes threaded to main')
    expect(fleet20Summary).toContain('None flagged')
  })

  it('finds all five pathologies in the staged fixture on key 3', () => {
    expect(pathologySummary).toContain('9 lanes threaded to main')
    for (const kind of ['looping', 'frozen', 'waiting', 'expensive']) {
      expect(pathologySummary, `the staged fixture lost its ${kind} lane`).toContain(kind)
    }
    // OFF-FENCE needs a manifest, and a fixture carries the one it dispatched
    // with — so this fixture can produce it while the live stream cannot.
    expect(pathologySummary).toContain('off-fence')
  })

  it('goes back to the live stream on key 1', () => {
    expect(backToLiveSummary).toContain('0 lanes')
  })
})

describe('the canvas host', () => {
  // Unlike the describe above, each test here needs its own mount — every
  // one installs a different `getContext` mock (null, throwing, a real fake
  // context), so nothing here can share a single mount.
  afterEach(() => {
    cleanup()
  })

  it('renders without a 2D context rather than taking the panel down', async () => {
    // jsdom returns null from getContext. The scene must be un-drawn, not
    // undefined: the DOM around it is what keeps the demo alive.
    const { container } = await mountScene()
    expect(container.querySelector('canvas')).not.toBeNull()
  })

  it('sizes the canvas backing store from the measured host, DPR-aware — not the old small-box floor (prd4 ruling 2)', async () => {
    // A hero-sized host, well above both the fallback floor and the old
    // small-box numbers it replaced — proves the canvas tracks the *measured*
    // host rather than being stuck at some fixed small default.
    const hostRect = {
      width: 960,
      height: 540,
      top: 0,
      left: 0,
      right: 960,
      bottom: 540,
      x: 0,
      y: 0,
      toJSON() {},
    }
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue(hostRect as DOMRect)
    // Above the DPR cap of 2, so this also pins that the cap is still honoured
    // at hero scale rather than scaling the backing store unbounded.
    vi.stubGlobal('devicePixelRatio', 3)

    const { container } = await mountScene()
    const canvas = container.querySelector('canvas')

    expect(canvas?.width).toBe(960 * 2)
    expect(canvas?.height).toBe(540 * 2)
  })

  it('rasterises a short host at its REAL size — the fallback fires only on a zero rect', async () => {
    // The assertion that would have caught the distortion: the fallback used to
    // be a Math.max floor on every tick, so any host shorter than 420 CSS px
    // got a 420-tall raster squashed by CSS — including at prd-32 S5's own
    // primary window size, where the hero host measures ≈330px.
    const hostRect = {
      width: 800,
      height: 300,
      top: 0,
      left: 0,
      right: 800,
      bottom: 300,
      x: 0,
      y: 0,
      toJSON() {},
    }
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue(hostRect as DOMRect)
    vi.stubGlobal('devicePixelRatio', 1)

    const { container } = await mountScene()
    const canvas = container.querySelector('canvas')

    expect(canvas?.width).toBe(800)
    expect(canvas?.height).toBe(300)
  })

  it('draws exactly one frame under a pinned clock, and starts no loop', async () => {
    // A pinned clock is a test asking for a still image. A running loop under
    // one would redraw the same frame forever and race every assertion below it.
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    await mountScene()
    expect(raf).not.toHaveBeenCalled()
    raf.mockRestore()
  })

  it('stops loudly rather than going black, if drawing ever throws', async () => {
    // The frame loop is outside React, so an error boundary cannot see it. Law
    // 12's voice applies to the scene's own failures too.
    //
    // Type-discriminating on purpose: a real GL for 'webgl2' and the throwing
    // double for '2d'. Returning the double for EVERY type used to accidentally
    // model "a browser that refused WebGL2" — which is now a different, louder
    // state (`ScenePainter.unavailable` → the fleet boundary), not this one.
    const gl = recordingGl()
    const throwing2d = {
      setTransform() {
        throw new Error('canvas is gone')
      },
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
      type === 'webgl2' ? gl.gl : throwing2d) as unknown as HTMLCanvasElement['getContext'])

    await mountWithCanvas()
    expect(screen.getByRole('status').textContent).toContain('canvas is gone')
    expect(screen.getByRole('status').textContent).toContain('panels are unaffected')
  })

  it('throws the unavailable message when this environment can draw 2D but refused WebGL2 — the boundary renders S1\'s error state', async () => {
    // The Electron shell without GPU access was the first live case: overlay
    // labels drew, the picture did not, and nothing said so. The mount effect
    // now throws, so the nearest error boundary (the fleet surface's) speaks.
    const calls: string[] = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
      type === '2d' ? fakeContext(calls) : null) as unknown as HTMLCanvasElement['getContext'])
    // React logs boundary-caught errors; quiet the channel for this test only.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})

    class Boundary extends Component<{ children?: ReactNode }, { message: string | null }> {
      override state: { message: string | null } = { message: null }
      static getDerivedStateFromError(error: Error) {
        return { message: error.message }
      }
      override render() {
        return this.state.message === null ? this.props.children : <p role="alert">{this.state.message}</p>
      }
    }

    const fleet = stagedFleet()
    render(
      <Boundary>
        <SceneView
          fleet={fleet}
          field={new PulseField()}
          settle={new SettleRegistry()}
          retire={new RetireRegistry()}
          selectedId={null}
          onSelect={vi.fn()}
          now={NOW}
        />
      </Boundary>,
    )

    expect(screen.getByRole('alert').textContent).toBe(CANVAS_UNAVAILABLE_MESSAGE)
    quiet.mockRestore()
  })

  it('paints the whole picture when a context exists', async () => {
    // The real executor, against real-shaped contexts — both of them, because
    // the picture now lands on two surfaces (ADR-0021): the WebGL2 canvas takes
    // the geometry and the transparent 2D canvas over it takes the type. jsdom
    // implements neither `Path2D` nor either context; a browser has all three.
    vi.stubGlobal('Path2D', PATH2D)
    const calls: string[] = []
    const context = fakeContext(calls)
    const gl = recordingGl()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
      type === 'webgl2' ? gl.gl : context) as unknown as HTMLCanvasElement['getContext'])

    await mountWithCanvas()
    await pressKey('3')
    // …and then make it draw a frame *of that fleet*. Under a pinned clock the
    // loop draws once, at mount, so everything above this line was painted
    // before the fixture arrived — a picture of an empty fleet, which is the
    // root-mass and nothing else. Toggling the hide-finished control is the operator
    // gesture that redraws (`SceneView`'s `hideFinished` effect), and it is
    // needed for this test to be about what it says it is about: until #117
    // took the hard outline off the mass, the one `stroke` this ever saw was
    // that outline, and no thread, cut or fence was in the picture at all.
    await act(async () => {
      fireEvent.click(screen.getByTestId('scene-hide-finished'))
    })

    // The whole vocabulary reached both surfaces: triangles submitted for the
    // ribbons and the light, a stencil pass for the mass's even-odd surface, and
    // the names on the layer over the top of them.
    expect(gl.of('drawArrays').length).toBeGreaterThan(0)
    expect(gl.names()).toContain('stencilOp')
    expect(gl.of('bufferData').length).toBeGreaterThan(0)
    expect(calls).toContain('fillText')
    expect(screen.queryByRole('status')).toBeNull()
  })
})

/**
 * THE CAMERA, WIRED.
 *
 * `camera.test.ts` pins the laws as arithmetic. This is the other half: that a
 * real ctrl+wheel event on the real canvas produces the transform those laws
 * describe, that a drag pans without eating the click that selects, and that the
 * transform reaches `ctx.setTransform` and the hit test in the same shape.
 *
 * These mount `SceneView` directly rather than `Scene`, because a camera test
 * has to know exactly where the nodes are — and with the fleet in hand the test
 * can lay the scene out itself and compare against the component's own picture,
 * instead of guessing at coordinates.
 */
describe('the camera', () => {
  const HOST = { width: 900, height: 500 }

  /**
   * Generous enough that only a genuine hang trips it (#193's lesson): a
   * single wheel-clamp test body fires 120 events, and under `--maxWorkers`
   * that ran alongside 144 other files at 5,535ms against the 5s default —
   * a docs lane held falsely by this test rather than by anything it found.
   */
  const CLAMP_TIMEOUT_MS = 120_000

  /**
   * A turn of the event loop.
   *
   * d3 suppresses the click at the end of a drag by installing a capture-phase
   * handler on `window` and removing it in a `setTimeout(0)` — which in a
   * browser is over long before the user's next click, and in a synchronous
   * test is still armed when the *next* test clicks something. Waiting a turn
   * is what a real hand does anyway.
   */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  /**
   * A mouse event that carries a `view`, which is not a thing jsdom will make.
   *
   * d3-zoom follows a drag by registering mousemove/mouseup on `event.view` and
   * asks `dragDisable` for that window's document, so a press without one is a
   * press it cannot follow. jsdom's `MouseEvent` constructor rejects *every*
   * candidate for `view` under vitest — the global, `document.defaultView`,
   * `ownerDocument.defaultView` — because vitest hands the window out through a
   * proxy and the brand check does not see through it. Defining the property on
   * the built event shadows `UIEvent.prototype.view` and gets d3 what it reads.
   */
  function withView(event: Event): Event {
    Object.defineProperty(event, 'view', { value: window, configurable: true })
    return event
  }

  const press = (canvas: HTMLCanvasElement, x: number, y: number, button = 0) => {
    fireEvent(canvas, withView(createEvent.mouseDown(canvas, { clientX: x, clientY: y, button })))
  }
  const move = (x: number, y: number) => {
    fireEvent(window, withView(createEvent.mouseMove(window, { clientX: x, clientY: y })))
  }
  const release = (x: number, y: number) => {
    fireEvent(window, withView(createEvent.mouseUp(window, { clientX: x, clientY: y })))
  }
  const drag = (canvas: HTMLCanvasElement, from: [number, number], to: [number, number]) => {
    press(canvas, from[0], from[1])
    move(to[0], to[1])
    release(to[0], to[1])
  }

  afterEach(async () => {
    cleanup()
    await settle()
  })

  function stagedFleet() {
    const spec = pathologySpec()
    return buildFleet(reduceAll(fixtureHistory(spec, NOW)), {
      now: NOW,
      manifest: manifestFor(spec),
    })
  }

  /**
   * A mounted scene, its recorded canvas transforms, and the geometry it is
   * drawing — laid out here with the same inputs the component uses, so a node's
   * world position is a known quantity rather than an inference.
   */
  function mountCamera(
    options: { reducedMotion?: boolean; live?: boolean; selectedId?: string } = {},
  ) {
    const hostRect = {
      ...HOST,
      top: 0,
      left: 0,
      right: HOST.width,
      bottom: HOST.height,
      x: 0,
      y: 0,
      toJSON() {},
    }
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue(hostRect as DOMRect)
    vi.stubGlobal('Path2D', PATH2D)
    if (options.reducedMotion === true) {
      vi.stubGlobal('matchMedia', () => ({
        matches: true,
        addEventListener() {},
        removeEventListener() {},
      }))
    }

    const calls: string[] = []
    const transforms: number[][] = []
    const journal: unknown[][] = []
    // Type-discriminating: the camera assertions read the OVERLAY's
    // setTransform, so the 2D double carries them, while 'webgl2' gets a real
    // recording GL — a blanket 2D-for-everything mock would now read as "a
    // browser that refused WebGL2" and trip the unavailable throw.
    const cameraGl = recordingGl()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
      type === 'webgl2'
        ? cameraGl.gl
        : fakeContext(calls, transforms, journal)) as unknown as HTMLCanvasElement['getContext'])

    const fleet = stagedFleet()
    const onSelect = vi.fn()
    const utils = render(
      <SceneView
        fleet={fleet}
        field={new PulseField()}
        settle={new SettleRegistry()}
        retire={new RetireRegistry()}
        selectedId={options.selectedId ?? null}
        onSelect={onSelect}
        {...(options.live === true ? {} : { now: NOW })}
      />,
    )

    const canvas = utils.container.querySelector('canvas') as HTMLCanvasElement
    const host = utils.container.firstElementChild as HTMLElement
    const geometry = layoutScene(fleet, { ...HOST, now: NOW })

    return { ...utils, canvas, host, geometry, onSelect, transforms, calls, journal }
  }

  /**
   * The camera behind the most recent painted frame.
   *
   * `paint` sets the transform three times a frame — the backdrop at device
   * scale, the picture through the camera, the chrome back at device scale — so
   * the camera is the middle one of the last three.
   */
  function cameraOf(transforms: number[][]) {
    const [k, , , , x, y] = transforms[transforms.length - 2] as number[]
    return { k: k as number, x: x as number, y: y as number }
  }

  const pinch = (canvas: HTMLCanvasElement, at: { x: number; y: number }, deltaY: number) => {
    fireEvent.wheel(canvas, { deltaY, ctrlKey: true, clientX: at.x, clientY: at.y })
  }

  it('paints the picture through the camera and the chrome outside it', () => {
    // The frame's three transforms, in order: backdrop at device scale, the
    // world through the camera, the gutter back at device scale. The gap voice
    // is the scene talking about the picture, so it must not travel with it.
    const { transforms } = mountCamera()
    const frame = transforms.slice(-3)

    expect(frame).toHaveLength(3)
    expect(frame[0]).toEqual([1, 0, 0, 1, 0, 0])
    expect(frame[2]).toEqual([1, 0, 0, 1, 0, 0])
  })

  it('zooms at the cursor, not at the middle of the panel', () => {
    // The classic mistake d3 makes by default. The point under the pointer
    // before the wheel must be the point under the pointer after it — off-centre
    // on purpose, because a centred focal point passes either way.
    const { canvas, transforms } = mountCamera()
    const at = { x: 700, y: 120 }

    pinch(canvas, at, -80)

    const camera = cameraOf(transforms)
    expect(camera.k).toBeGreaterThan(1)
    // At identity the world point under the pointer *was* the pointer.
    expect((at.x - camera.x) / camera.k).toBeCloseTo(at.x, 6)
    expect((at.y - camera.y) / camera.k).toBeCloseTo(at.y, 6)
  })

  it('leaves a plain wheel to the page', () => {
    // The scene is a panel in a scrolling page; a canvas that eats the wheel is
    // a canvas nobody can scroll past.
    const { canvas, transforms } = mountCamera()
    const before = transforms.length

    const event = createEvent.wheel(canvas, { deltaY: 240 })
    const handled = !fireEvent(canvas, event)

    expect(handled, 'the camera claimed a wheel event that belongs to the page').toBe(false)
    expect(transforms.length).toBe(before)
  })

  it('clamps at the scale extent however hard the wheel is turned', () => {
    const { canvas, transforms } = mountCamera()
    for (let i = 0; i < 40; i += 1) pinch(canvas, { x: 450, y: 250 }, -100)
    expect(cameraOf(transforms).k).toBeCloseTo(SCALE_EXTENT[1], 6)

    for (let i = 0; i < 80; i += 1) pinch(canvas, { x: 450, y: 250 }, 100)
    expect(cameraOf(transforms).k).toBeCloseTo(SCALE_EXTENT[0], 6)
  }, CLAMP_TIMEOUT_MS)

  it('pans on drag', () => {
    const { canvas, transforms } = mountCamera()

    drag(canvas, [400, 250], [520, 300])

    const camera = cameraOf(transforms)
    expect(camera.x).toBeCloseTo(120, 6)
    expect(camera.y).toBeCloseTo(50, 6)
    expect(camera.k).toBe(1)
  })

  it('pans on the middle button too', () => {
    const { canvas, transforms } = mountCamera()

    press(canvas, 400, 250, 1)
    move(340, 250)
    release(340, 250)

    expect(cameraOf(transforms).x).toBeCloseTo(-60, 6)
  })

  it('does not steal the click that selects a lane', () => {
    // The Figma resolution, via d3-zoom's `clickDistance` (which is where React
    // Flow resolves the same conflict): a press that did not travel is a click,
    // and a press that did is a pan and eats its own click.
    const { canvas, geometry, onSelect } = mountCamera()
    const node = geometry.threads[0]?.node as { x: number; y: number }

    press(canvas, node.x, node.y)
    release(node.x, node.y)
    fireEvent.click(canvas, { clientX: node.x, clientY: node.y })

    expect(onSelect).toHaveBeenCalledWith(geometry.threads[0]?.laneId)
  })

  it('eats the click at the end of a drag, so panning never selects', () => {
    const { canvas, geometry, onSelect } = mountCamera()
    const node = geometry.threads[0]?.node as { x: number; y: number }

    drag(canvas, [node.x, node.y], [node.x + 90, node.y])
    fireEvent.click(canvas, { clientX: node.x + 90, clientY: node.y })

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('hit-tests in world coordinates: it picks the lane the pointer is over now', () => {
    // The whole composition risk in one test. After a zoom, a lane is picked
    // from where it is *drawn*; a hit test left in screen coordinates would
    // still be picking lanes off the layout the camera stopped agreeing with.
    const { canvas, geometry, onSelect, transforms } = mountCamera()
    const thread = geometry.threads[0]
    const node = thread?.node as { x: number; y: number }

    pinch(canvas, { x: 20, y: 20 }, -200)
    const camera = cameraOf(transforms)
    expect(camera.k).toBeGreaterThan(1.2)

    // Where that node is now drawn.
    const drawn = { x: node.x * camera.k + camera.x, y: node.y * camera.k + camera.y }
    fireEvent.click(canvas, { clientX: drawn.x, clientY: drawn.y })
    expect(onSelect).toHaveBeenLastCalledWith(thread?.laneId)

    // And where it used to be, which at this zoom is a long way from anything.
    onSelect.mockClear()
    fireEvent.click(canvas, { clientX: node.x, clientY: node.y })
    expect(onSelect).toHaveBeenLastCalledWith(null)
  })

  /**
   * THE ROOT-MASS, CLICKABLE (prd6 ruling 5) — the last unclickable thing on
   * the screen.
   *
   * The composition risk is the same one the lane hit test carries and worse:
   * the mass is drawn in world coordinates at a *world* radius, so a hit test
   * that forgot the camera would be catching clicks in a circle that has
   * nothing to do with where the mass is on screen. Both halves are pinned —
   * that it works at all, and that it works after a zoom.
   */
  describe('the root-mass as a hit target', () => {
    it('selects MAIN when the pointer is on the mass', () => {
      const { canvas, geometry, onSelect } = mountCamera()

      fireEvent.click(canvas, { clientX: geometry.centre.x, clientY: geometry.centre.y })

      expect(onSelect).toHaveBeenCalledWith(MAIN_SELECTION)
    })

    it('catches the rim, and lets go a little beyond it', () => {
      const { canvas, geometry, onSelect } = mountCamera()
      const { centre, rootRadius } = geometry

      // Just inside the rim: still the mass.
      fireEvent.click(canvas, { clientX: centre.x + rootRadius - 1, clientY: centre.y })
      expect(onSelect).toHaveBeenLastCalledWith(MAIN_SELECTION)

      // Well past the slack, and nowhere near a node at this radius: nothing.
      onSelect.mockClear()
      fireEvent.click(canvas, { clientX: centre.x + rootRadius + 40, clientY: centre.y })
      expect(onSelect).toHaveBeenLastCalledWith(null)
    })

    it('hit-tests the mass under a non-identity camera, in world coordinates', () => {
      const { canvas, geometry, onSelect, transforms } = mountCamera()

      pinch(canvas, { x: 20, y: 20 }, -200)
      const camera = cameraOf(transforms)
      expect(camera.k).toBeGreaterThan(1.2)

      // Where the mass is now drawn.
      const drawn = {
        x: geometry.centre.x * camera.k + camera.x,
        y: geometry.centre.y * camera.k + camera.y,
      }
      fireEvent.click(canvas, { clientX: drawn.x, clientY: drawn.y })
      expect(onSelect).toHaveBeenLastCalledWith(MAIN_SELECTION)

      // And where it used to be, which the camera has moved it away from.
      onSelect.mockClear()
      fireEvent.click(canvas, { clientX: geometry.centre.x, clientY: geometry.centre.y })
      expect(onSelect).not.toHaveBeenLastCalledWith(MAIN_SELECTION)
    })

    it('keeps the mass out of a lane node\'s way — the smaller target wins', () => {
      // A node is what an operator aiming at a node meant, even when the mass
      // is within reach of the same pointer.
      const { canvas, geometry, onSelect } = mountCamera()
      const thread = geometry.threads[0]
      const node = thread?.node as { x: number; y: number }

      fireEvent.click(canvas, { clientX: node.x, clientY: node.y })

      expect(onSelect).toHaveBeenLastCalledWith(thread?.laneId)
    })

    it('gives the mass the same spotlight ring a selected lane gets', () => {
      // The affordance, as a query over what actually reached the canvas: two
      // concentric hairlines on the mass's rim, drawn only when it is picked.
      const unselected = mountCamera()
      const before = ringsAround(unselected.geometry.centre)
      cleanup()

      const selected = mountCamera({ selectedId: MAIN_SELECTION })
      const after = ringsAround(selected.geometry.centre)

      expect(before).toHaveLength(0)
      expect(after).toHaveLength(2)
      // On the rim, not inside it, and the outer one a hair beyond the inner.
      const [inner, outer] = after as [number, number]
      expect(inner).toBeGreaterThan(selected.geometry.rootRadius)
      expect(outer).toBeCloseTo(inner + 5, 6)
    })

    /**
     * The distinct radii of the full circles the last painted frame **stroked**
     * about `at`.
     *
     * Read off the display list rather than off a canvas journal, which is what
     * ADR-0021 cost and bought back: the 2D painter made this observable for
     * free by recording `ctx.arc`, and a GPU keeps no such transcript — by the
     * time a spotlight ring reaches a buffer it is several hundred floats.
     * `lastPaintedFrame` restores the observable one layer up, in the picture's
     * own vocabulary, which is strictly closer to what this test is about.
     *
     * Stroked, not merely drawn: the root-mass's halo and core are soft radial
     * blobs about the same point, and an `arc` mark is the only thing in the
     * scene that is a stroked circle.
     */
    function ringsAround(at: { x: number; y: number }): number[] {
      const marks = lastPaintedFrame()?.marks ?? []
      const radii = marks
        .filter((mark) => mark.kind === 'arc')
        .filter((mark) => Math.hypot(mark.at.x - at.x, mark.at.y - at.y) <= 0.001)
        .filter((mark) => mark.from === 0 && Math.abs(mark.to - Math.PI * 2) <= 0.001)
        .map((mark) => mark.radius)
      return [...new Set(radii)]
    }
  })

  describe('the keys, scoped to a focused scene', () => {
    it('sends the camera home on 0', () => {
      const { canvas, host, transforms } = mountCamera()
      pinch(canvas, { x: 700, y: 120 }, -100)
      expect(cameraOf(transforms).k).toBeGreaterThan(1)

      fireEvent.keyDown(host, { key: '0' })
      expect(cameraOf(transforms)).toEqual({ k: 1, x: 0, y: 0 })
    })

    it('steps in and out on + and -', () => {
      const { host, transforms } = mountCamera()

      fireEvent.keyDown(host, { key: '+' })
      const zoomedIn = cameraOf(transforms)
      expect(zoomedIn.k).toBeCloseTo(ZOOM_STEP, 6)
      // About the middle of the panel: there is no pointer to zoom at.
      expect((HOST.width / 2 - zoomedIn.x) / zoomedIn.k).toBeCloseTo(HOST.width / 2, 6)

      fireEvent.keyDown(host, { key: '-' })
      expect(cameraOf(transforms).k).toBeCloseTo(1, 6)
    })

    it('fits on 1, and does not let 1 switch the stream underneath it', () => {
      // `1` is already the live-stream key everywhere else on the page. The
      // camera may only claim it while the scene holds focus, and claiming it
      // means the global handler must never see it.
      const { host, transforms } = mountCamera()
      const global = vi.fn()
      window.addEventListener('keydown', global)

      fireEvent.keyDown(host, { key: '1' })

      expect(global).not.toHaveBeenCalled()
      window.removeEventListener('keydown', global)

      // Fit frames the whole network, which is a little tighter than identity
      // because the layout leaves room for labels that fit does not have to.
      expect(cameraOf(transforms).k).not.toBe(1)
    })

    it("leaves the page's own shortcuts alone", () => {
      const { host } = mountCamera()
      const global = vi.fn()
      window.addEventListener('keydown', global)

      // Not the camera's keys, and the camera's keys under a modifier (cmd+0 is
      // the browser's zoom reset, and taking it would be theft).
      fireEvent.keyDown(host, { key: '2' })
      fireEvent.keyDown(host, { key: '0', metaKey: true })

      expect(global).toHaveBeenCalledTimes(2)
      window.removeEventListener('keydown', global)
    })
  })

  describe('recenter', () => {
    it('stays out of the way while the network is on screen', () => {
      const { getByTestId } = mountCamera()
      // Mounted, not absent: the state it reports flips as fast as a drag, and
      // a transition can be interrupted where a mount cannot.
      expect(getByTestId('scene-recenter')).toHaveAttribute('aria-hidden', 'true')
    })

    it('appears once the network has been dragged out of view, and brings it back', async () => {
      const { canvas, getByTestId } = mountCamera()

      drag(canvas, [450, 250], [450 - 1400, 250])
      expect(getByTestId('scene-recenter')).toHaveAttribute('aria-hidden', 'false')

      await settle()
      fireEvent.click(getByTestId('scene-recenter'))
      expect(getByTestId('scene-recenter')).toHaveAttribute('aria-hidden', 'true')
    })
  })

  /**
   * The flight needs a running loop, so these mount with a live clock and drive
   * `requestAnimationFrame` by hand — the only way to watch a camera move
   * without racing it.
   */
  describe('the flight home', () => {
    function mountFlying(options: { reducedMotion?: boolean } = {}) {
      const frames: FrameRequestCallback[] = []
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
        frames.push(callback),
      )
      vi.stubGlobal('cancelAnimationFrame', () => {})
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(NOW)

      const mounted = mountCamera({ ...options, live: true })
      const draw = () => {
        const next = frames.shift()
        act(() => next?.(0))
      }

      return { ...mounted, draw, at: (ms: number) => vi.setSystemTime(NOW + ms) }
    }

    afterEach(() => {
      vi.useRealTimers()
    })

    it('arcs there over several frames rather than cutting', () => {
      const { host, transforms, draw, at } = mountFlying()
      draw()
      const home = cameraOf(transforms)

      act(() => {
        fireEvent.keyDown(host, { key: '1' })
      })

      // Nothing has moved yet: the keypress starts a flight, it does not take it.
      expect(cameraOf(transforms)).toEqual(home)

      at(120)
      draw()
      const midway = cameraOf(transforms)

      at(2_000)
      draw()
      const landed = cameraOf(transforms)

      expect(midway).not.toEqual(home)
      expect(midway).not.toEqual(landed)
      // And it settles: the frame after arrival is the frame it arrived on.
      at(2_400)
      draw()
      expect(cameraOf(transforms)).toEqual(landed)
    })

    it('jumps instead, when motion is reduced', () => {
      // A camera flight is the largest movement in the instrument, so it is the
      // first thing the preference switches off.
      const { host, transforms, draw } = mountFlying({ reducedMotion: true })
      draw()
      const home = cameraOf(transforms)

      act(() => {
        fireEvent.keyDown(host, { key: '1' })
      })
      draw()
      const landed = cameraOf(transforms)

      expect(landed).not.toEqual(home)
      // No time passed and no frames were spent: it was already there.
      draw()
      expect(cameraOf(transforms)).toEqual(landed)
    })

    it('drops the flight when a hand lands on the canvas', () => {
      const { canvas, host, transforms, draw, at } = mountFlying()
      draw()

      act(() => {
        fireEvent.keyDown(host, { key: '1' })
      })
      at(100)
      draw()
      const interrupted = cameraOf(transforms)

      act(() => {
        drag(canvas, [400, 250], [430, 250])
      })

      at(2_000)
      draw()
      // The drag's 30px, and no sign of the flight resuming its arc underneath.
      expect(cameraOf(transforms).x).toBeCloseTo(interrupted.x + 30, 6)
    })
  })
})

/**
 * THE HOVER PATH READS NO LAYOUT (#159) — `pickAt` used to call
 * `canvas.getBoundingClientRect()` on every mousemove; the origin is now
 * published by `useFrameLoop`'s ResizeObserver and refreshed on scroll, so
 * neither the canvas's nor the host's rect should ever be read from a hover.
 *
 * Its own `mountHover` rather than the camera describe's `mountCamera`,
 * because the host rect here has to be a MUTABLE box: the scroll-trap case
 * moves it after mount and dispatches `scroll`, which `mountCamera`'s fixed
 * `mockReturnValue` cannot do.
 */
describe('the hover path reads no layout (#159)', () => {
  const HOST = { width: 900, height: 500 }

  afterEach(() => {
    cleanup()
  })

  function boxAt(left: number, top: number) {
    return {
      width: HOST.width,
      height: HOST.height,
      top,
      left,
      right: HOST.width + left,
      bottom: HOST.height + top,
      x: left,
      y: top,
      toJSON() {},
    }
  }

  function mountHover() {
    let rect = boxAt(0, 0)
    const divRect = vi
      .spyOn(HTMLDivElement.prototype, 'getBoundingClientRect')
      .mockImplementation(() => rect as DOMRect)
    // Never stubbed to return anything — case 1's whole claim is that nothing
    // on the hover path calls this any more.
    const canvasRect = vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect')
    vi.stubGlobal('Path2D', PATH2D)
    const gl = recordingGl()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
      type === 'webgl2' ? gl.gl : fakeContext([])) as unknown as HTMLCanvasElement['getContext'])

    const fleet = stagedFleet()
    const onSelect = vi.fn()
    const utils = render(
      <SceneView
        fleet={fleet}
        field={new PulseField()}
        settle={new SettleRegistry()}
        retire={new RetireRegistry()}
        selectedId={null}
        onSelect={onSelect}
        now={NOW}
      />,
    )

    const canvas = utils.container.querySelector('canvas') as HTMLCanvasElement
    const geometry = layoutScene(fleet, { ...HOST, now: NOW })

    return {
      ...utils,
      canvas,
      geometry,
      onSelect,
      divRect,
      canvasRect,
      /** Moves the host's box and fires the scroll event the fix listens for. */
      moveOrigin(left: number, top: number) {
        rect = boxAt(left, top)
        fireEvent(window, new Event('scroll'))
      },
    }
  }

  const move = (canvas: HTMLCanvasElement, x: number, y: number) =>
    fireEvent.mouseMove(canvas, { clientX: x, clientY: y })

  it('reads no layout across twenty hover moves', () => {
    // Plain moves, no button held: d3-zoom binds `mousedown`/`wheel`, not
    // `mousemove`, so nothing of d3's reads layout on a hover either.
    const { canvas, divRect, canvasRect } = mountHover()
    divRect.mockClear()
    canvasRect.mockClear()

    for (let i = 0; i < 20; i += 1) move(canvas, 60 + i * 3, 60 + i * 2)

    expect(canvasRect).not.toHaveBeenCalled()
    expect(divRect).not.toHaveBeenCalled()
  })

  it('still picks the right lane — the positive control', () => {
    // Without this, case 1 above would pass on a hover handler that had been
    // deleted outright.
    const { canvas, geometry, onSelect } = mountHover()
    const thread = geometry.threads[0]
    const node = thread?.node as { x: number; y: number }

    move(canvas, node.x, node.y)
    expect(canvas.className).toContain('cursor-pointer')

    move(canvas, 5, 5)
    expect(canvas.className).toContain('cursor-default')

    fireEvent.click(canvas, { clientX: node.x, clientY: node.y })
    expect(onSelect).toHaveBeenCalledWith(thread?.laneId)
  })

  it('stays correct on scroll — the trap the audit named', () => {
    // A ResizeObserver never fires for a scroll. At the stale origin {0,0}
    // this point is nowhere near a lane; only the refreshed origin puts it on
    // one. Mutation this survives: remove the scroll listener and this hovers
    // nothing, because the origin never catches up.
    const { canvas, geometry, onSelect, moveOrigin } = mountHover()
    const thread = geometry.threads[0]
    const node = thread?.node as { x: number; y: number }
    const clientX = node.x + 200
    const clientY = node.y + 100

    move(canvas, clientX, clientY)
    expect(canvas.className).toContain('cursor-default')

    moveOrigin(200, 100)
    move(canvas, clientX, clientY)
    expect(canvas.className).toContain('cursor-pointer')

    fireEvent.click(canvas, { clientX, clientY })
    expect(onSelect).toHaveBeenCalledWith(thread?.laneId)
  })

  it('keeps tracking through repeated scrolls, and keeps reading no layout', () => {
    const { canvas, geometry, onSelect, moveOrigin, divRect, canvasRect } = mountHover()
    const thread = geometry.threads[0]
    const node = thread?.node as { x: number; y: number }

    moveOrigin(40, -30)
    move(canvas, node.x + 40, node.y - 30)
    expect(canvas.className).toContain('cursor-pointer')

    moveOrigin(-15, 60)
    move(canvas, node.x - 15, node.y + 60)
    expect(canvas.className).toContain('cursor-pointer')
    fireEvent.click(canvas, { clientX: node.x - 15, clientY: node.y + 60 })
    expect(onSelect).toHaveBeenCalledWith(thread?.laneId)

    // The refresh must not have moved the layout read back onto the hover
    // path — case 1's law still has to hold after all this scrolling.
    divRect.mockClear()
    canvasRect.mockClear()
    for (let i = 0; i < 20; i += 1) move(canvas, node.x - 15 + i, node.y + 60 + i)
    expect(canvasRect).not.toHaveBeenCalled()
    expect(divRect).not.toHaveBeenCalled()
  })
})

/**
 * THE CURSOR COSTS NO RENDER (#159) — `panning` used to be `useState`, whose
 * only consumer was `cursorOf`'s className, so a React commit landed at both
 * ends of every drag to change a CSS cursor. `useFrameLoop`'s gesture bracket
 * now writes `canvas.style.cursor` directly instead.
 */
describe('the cursor costs no render (#159)', () => {
  const HOST = { width: 900, height: 500 }

  function withView(event: Event): Event {
    Object.defineProperty(event, 'view', { value: window, configurable: true })
    return event
  }
  const press = (canvas: HTMLCanvasElement, x: number, y: number, button = 0) => {
    fireEvent(canvas, withView(createEvent.mouseDown(canvas, { clientX: x, clientY: y, button })))
  }
  const move = (x: number, y: number) => {
    fireEvent(window, withView(createEvent.mouseMove(window, { clientX: x, clientY: y })))
  }
  const release = (x: number, y: number) => {
    fireEvent(window, withView(createEvent.mouseUp(window, { clientX: x, clientY: y })))
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  afterEach(async () => {
    cleanup()
    await settle()
  })

  function mountCursor() {
    const hostRect = {
      ...HOST,
      top: 0,
      left: 0,
      right: HOST.width,
      bottom: HOST.height,
      x: 0,
      y: 0,
      toJSON() {},
    }
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue(hostRect as DOMRect)
    vi.stubGlobal('Path2D', PATH2D)
    const gl = recordingGl()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
      type === 'webgl2' ? gl.gl : fakeContext([])) as unknown as HTMLCanvasElement['getContext'])

    const fleet = stagedFleet()
    const onSelect = vi.fn()
    const utils = render(
      <SceneView
        fleet={fleet}
        field={new PulseField()}
        settle={new SettleRegistry()}
        retire={new RetireRegistry()}
        selectedId={null}
        onSelect={onSelect}
        now={NOW}
      />,
    )

    const canvas = utils.container.querySelector('canvas') as HTMLCanvasElement
    const host = utils.container.firstElementChild as HTMLElement
    const geometry = layoutScene(fleet, { ...HOST, now: NOW })

    return { ...utils, canvas, host, geometry, onSelect }
  }

  it('costs no render across a real drag, and writes the cursor inline', () => {
    // Mutation this survives: put `setPanning` back and this is 2, not 0.
    const { canvas } = mountCursor()
    renders.n = 0

    press(canvas, 300, 120)
    expect(canvas.style.cursor).toBe('grabbing')

    move(310, 120)
    move(320, 120)
    release(320, 120)

    expect(canvas.style.cursor).toBe('')
    expect(renders.n).toBe(0)
  })

  it('never shows the grab cursor for a wheel gesture', () => {
    // `.on('start')`'s `!== 'wheel'` test, which the rewrite must not lose.
    const { canvas } = mountCursor()
    fireEvent.wheel(canvas, { deltaY: -80, ctrlKey: true, clientX: 450, clientY: 250 })
    expect(canvas.style.cursor).toBe('')
  })

  it('the class still owns the other three cursors, with no gesture running', () => {
    const { canvas, host, geometry } = mountCursor()
    const node = geometry.threads[0]?.node as { x: number; y: number }

    fireEvent.keyDown(host, { key: ' ' })
    expect(canvas.className).toContain('cursor-grab')
    fireEvent.keyUp(host, { key: ' ' })

    fireEvent.mouseMove(canvas, { clientX: node.x, clientY: node.y })
    expect(canvas.className).toContain('cursor-pointer')

    fireEvent.mouseMove(canvas, { clientX: 5, clientY: 5 })
    expect(canvas.className).toContain('cursor-default')
  })
})

/**
 * THE PAUSE CONTROL — WCAG 2.2.2, Level A.
 *
 * The scene breathes for as long as it is open, which is exactly the moving
 * content that success criterion is about: automatic, longer than five seconds,
 * alongside other content. So this is not a preference, it is the difference
 * between shipping and not.
 *
 * The control is one boolean and the mechanism is one line — while paused the
 * component holds its own clock still — so the tests that matter are the ones
 * that watch the *canvas* rather than the state: two frames a second apart must
 * put light in exactly the same places, with a real packet in flight and a real
 * summons throbbing, or the pause is a label rather than a pause.
 */
/** A fleet with a live summons in it, so there is something to hold still. */
function stagedFleet() {
  const spec = pathologySpec()
  return buildFleet(reduceAll(fixtureHistory(spec, NOW)), {
    now: NOW,
    manifest: manifestFor(spec),
  })
}

/**
 * A live-clock mount with `requestAnimationFrame` driven by hand, which is the
 * only way to watch a scene *not* move without racing it.
 */
function mountMotion(
  options: {
    settle?: SettleRegistry
    retire?: RetireRegistry
    fleet?: Fleet
    /** #157's state clock. Absent is the live case: the same instant as the wall. */
    asOf?: number
  } = {},
) {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    frames.push(callback),
  )
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('Path2D', PATH2D)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)

  // Type-discriminating: a blanket 2D-for-everything mock would read as "a
  // browser that refused WebGL2" and trip the unavailable throw. These suites
  // are about motion and clocks, not the GL half, so 'webgl2' gets a real
  // recording GL and everything else the plain 2D double.
  const liveGl = recordingGl()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
    type === 'webgl2' ? liveGl.gl : fakeContext([])) as unknown as HTMLCanvasElement['getContext'])

  const fleet = options.fleet ?? stagedFleet()
  const field = new PulseField()
  // One commit, half a second into its journey: a packet actually travelling
  // when the operator reaches for the button.
  field.ingest(
    fixtureHistory(pathologySpec(), NOW)
      .filter((event) => event.type === 'commit.landed')
      .slice(-1),
    laneIndex(fleet),
    NOW - 500,
  )

  const settle = options.settle ?? new SettleRegistry()
  const retire = options.retire ?? new RetireRegistry()
  const onSelect = vi.fn()
  const view = (asOf: number | undefined) => (
    <SceneView
      fleet={fleet}
      field={field}
      settle={settle}
      retire={retire}
      selectedId={null}
      onSelect={onSelect}
      {...(asOf === undefined ? {} : { asOf })}
    />
  )

  const utils = render(view(options.asOf))

  /**
   * One frame, and what it drew — the display list at the instant it was
   * painted, serialised.
   *
   * This used to be the canvas journal, and it is the same question asked of a
   * renderer that keeps no journal (see `lastPaintedFrame`). It is also a
   * *stronger* comparison than the one it replaces: the journal only recorded
   * the arguments of `arc`, `moveTo`, `lineTo`, `drawImage` and `fillText`, so a
   * colour that changed under a held clock was invisible to it. Every field of
   * every mark is compared here.
   */
  const frame = (): string => {
    const next = frames.shift()
    act(() => next?.(0))
    return JSON.stringify(lastPaintedFrame()?.marks ?? [])
  }

  return {
    ...utils,
    fleet,
    field,
    frame,
    at: (ms: number) => vi.setSystemTime(NOW + ms),
    /** Move the state clock without moving the wall clock (#157). */
    asOf: (at: number) => act(() => utils.rerender(view(at))),
  }
}

const pause = () => fireEvent.click(screen.getByTestId('scene-motion-pause'))

/** Every mounted-scene suite below leaves the timers and the DOM as it found them. */
function restoreAfterMount(): void {
  cleanup()
  vi.useRealTimers()
}

describe('the pause control (WCAG 2.2.2)', () => {
  afterEach(restoreAfterMount)

  it('yields to the settings choice: still means stilled, and the button says who holds it', () => {
    // Until loop 13 the stored motion level never reached the picture — the
    // registry's own gap note confessed it. Now `still` holds the scene the
    // way pause does, and the pause button disables rather than pretend it is
    // the one holding the picture.
    writePreference('motion.level', 'still')
    try {
      mountMotion()
      const button = screen.getByTestId('scene-motion-pause')
      // `aria-disabled`, not `disabled` (#389, ADR-0047): the string this
      // control carries exists to explain its own unavailability, and a
      // `disabled` button leaves the tab order — so that explanation would be
      // the one thing a keyboard could never reach.
      expect(button).toHaveAttribute('aria-disabled', 'true')
      expect(button.textContent).toMatch(/motion stilled/i)
      expect(screen.getByTestId('scene-motion-state').textContent).toMatch(/motion paused/i)
    } finally {
      localStorage.clear()
    }
  })

  it('is a button that says what it will do, in the tab order', () => {
    // A real button, so it answers Enter and Space and reaches the keyboard
    // without anyone having to find the canvas first.
    mountMotion()
    const button = screen.getByTestId('scene-motion-pause')

    expect(button.tagName).toBe('BUTTON')
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(button.textContent).toMatch(/pause motion/i)
    expect(screen.queryByTestId('scene-motion-state')).toBeNull()
  })

  it('says MOTION PAUSED, out loud, once it is pressed', () => {
    // A stopped scene with no words on it is indistinguishable from a quiet
    // fleet, which is the one confusion this instrument cannot afford.
    mountMotion()
    act(() => {
      pause()
    })

    expect(screen.getByTestId('scene-motion-pause')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('scene-motion-state').textContent).toMatch(/motion paused/i)
    expect(screen.getByTestId('scene-motion-pause').textContent).toMatch(/resume/i)
  })

  it('holds the picture still — the same light in the same places, a second later', () => {
    const { field, frame, at } = mountMotion()
    // The premise: there is light in flight to hold still. Without it this test
    // would pass against a scene with no motion in it at all.
    expect(field.pulses().length).toBeGreaterThan(0)
    frame()

    act(() => {
      pause()
    })
    const held = frame()
    at(1_000)
    const later = frame()

    expect(later).toBe(held)
    // And it is a picture, not an empty canvas: the packet in flight is still
    // drawn, exactly where it was. Pause freezes the scene; it does not strip it.
    expect(held.length).toBeGreaterThan(1_000)
  })

  it('moves again the moment it is released', () => {
    const { frame, at } = mountMotion()
    act(() => {
      pause()
    })
    const held = frame()

    act(() => {
      pause()
    })
    at(1_000)
    expect(frame()).not.toBe(held)
  })

  it('is the difference: the same second of an unpaused scene does move', () => {
    // The control test for the two above. Without this, a scene that had stopped
    // drawing entirely would pass them both.
    const { frame, at } = mountMotion()
    const first = frame()
    at(1_000)
    expect(frame()).not.toBe(first)
  })

  it('lets a thread finish growing in, then stops', () => {
    // Structural motion is the exception the ruling carved out: a thread caught
    // half-way through growing is a picture of a fleet that does not exist, so
    // grow-in keeps the real clock and settles.
    const fleet = stagedFleet()
    const settle = new SettleRegistry()
    const lane = fleet.lanes[0]
    settle.note(
      [
        rhizomorphEvent(
          'worktree.discovered',
          {
            path: `/repo__worktrees/${lane?.branch}`,
            branch: lane?.branch ?? 'x',
            head: 'a1b2c3d',
            isMain: false,
          },
          { id: 'grow-1', ts: NOW },
        ),
      ],
      laneIndex(fleet),
      NOW,
    )

    const { frame, at } = mountMotion({ settle })
    act(() => {
      pause()
    })

    const starting = frame()
    at(400)
    const growing = frame()
    expect(growing).not.toBe(starting)

    // Past SETTLE_MS (1 750 since the growth class landed) the thread has
    // arrived, and now the paused scene is a still.
    at(2_000)
    const grown = frame()
    at(3_000)
    expect(frame()).toBe(grown)
  })
})

/**
 * THE CORD-RETURN, in the mounted scene (prd5 ruling 3).
 *
 * `retire.test.ts` owns the clock and `marks.test.ts` owns the display list; what
 * is left for this file is the two things only a mounted component can answer.
 *
 * **Does a lane finishing while we watch actually move?** The cut is the piece the
 * whole prd exists for, and a staged animation that is correct in the display list
 * and never reaches a canvas is not one. So this drives real frames by hand and
 * compares what was drawn.
 *
 * **Does the toggle work, and does it stay?** Scars are visible by default, the
 * button is the only thing that changes that, and the change outlives a remount.
 */
describe('the return, and the network it leaves standing (prd10 rulings 13–16)', () => {
  /** A fleet that has landed: seventeen lanes, every one of them declared done. */
  function landedFleet(): Fleet {
    const spec = finishedSpec()
    return buildFleet(reduceAll(fixtureHistory(spec, NOW)), {
      now: NOW,
      manifest: manifestFor(spec),
    })
  }

  /**
   * A live-clock mount, driven by hand — the same harness the pause suite uses,
   * because "did the picture change?" is the same question here.
   */
  const mountCut = mountMotion

  const toggle = () => fireEvent.click(screen.getByTestId('scene-hide-finished'))

  afterEach(() => {
    restoreAfterMount()
    localStorage.clear()
  })

  it('cuts the cord of a lane that finishes while we are watching', () => {
    // The whole point, end to end: a real `agent.status: done` through the real
    // registry, and three frames that are three different pictures.
    const fleet = landedFleet()
    const lane = fleet.lanes[0] as Fleet['lanes'][number]
    const retire = new RetireRegistry()
    const started = retire.note(
      [
        rhizomorphEvent(
          'agent.status',
          { handle: lane.handles[0] ?? lane.id, status: 'done', branch: lane.branch },
          { id: 'done-1', ts: NOW },
        ),
      ],
      laneIndex(fleet),
      NOW,
    )
    expect(started).toEqual([lane.id])

    const { frame, at } = mountCut({ fleet, retire })

    const tension = frame()
    at(400)
    const retracting = frame()
    at(1_000)
    const settling = frame()

    // Three stages, three pictures. If any pair matched, a stage would be
    // changing nothing that reaches the canvas.
    expect(retracting).not.toBe(tension)
    expect(settling).not.toBe(retracting)

    // And what is left is still a picture. Never fade to nothing, and since
    // ruling 13 never delete either: seventeen finished lanes are seventeen
    // strands on the canvas, not an empty rectangle. (That the return *ends* is
    // `retire.test.ts`'s and `marks.test.ts`'s — this frame cannot say it,
    // because the root-mass is still breathing behind it.)
    at(1_400)
    expect(frame().length).toBeGreaterThan(1_000)
  })

  it('freezes a cut mid-flight when the operator pauses', () => {
    const fleet = landedFleet()
    const lane = fleet.lanes[0] as Fleet['lanes'][number]
    const retire = new RetireRegistry()
    retire.note(
      [rhizomorphEvent('worktree.removed', { path: lane.worktreePath ?? '/x' }, { id: 'gone-1', ts: NOW })],
      laneIndex(fleet),
      NOW,
    )

    const { frame, at } = mountCut({ fleet, retire })
    at(300)
    frame()

    act(() => {
      pause()
    })
    const held = frame()
    at(1_300)

    // Deliberately unlike grow-in, which settles through a pause: a half-grown
    // thread is a *false* fact about a lane's size, where a half-cut one is a
    // true one — that lane is finishing. And the cut is the loudest thing the
    // scene ever does, so it is the first thing somebody reaching for the pause
    // control wants held still.
    expect(frame()).toBe(held)
  })

  it('offers the toggle with the count of what it would hide', () => {
    const fleet = landedFleet()
    mountCut({ fleet })
    const button = screen.getByTestId('scene-hide-finished')

    expect(button.tagName).toBe('BUTTON')
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(button).toHaveAttribute('tabindex', '0')
    // "Hidden ≠ gone" is only true if the operator can see that something is
    // hidden, so the number is on the button whichever way it is set.
    expect(button.textContent).toBe(`Hide finished · ${fleet.lanes.length}`)
  })

  it('has nothing to say on a fleet where nothing has finished', () => {
    mountCut()
    const button = screen.getByTestId('scene-hide-finished')
    expect(button).toHaveAttribute('aria-hidden', 'true')
    expect(button).toHaveAttribute('tabindex', '-1')
  })

  it('hides the finished lanes from the canvas, and says it is doing it', () => {
    const { frame } = mountCut({ fleet: landedFleet() })
    const shown = frame()

    act(() => {
      toggle()
    })
    const hidden = frame()

    expect(hidden.length).toBeLessThan(shown.length)
    // Not an empty canvas: the root-mass and the scene's own chrome are not lanes
    // and this hides finished lanes, not the picture.
    expect(hidden.length).toBeGreaterThan(200)
    expect(screen.getByTestId('scene-hide-finished').textContent).toMatch(/^show finished/i)
    expect(screen.getByTestId('scene-hide-finished')).toHaveAttribute('aria-pressed', 'true')
  })

  it('remembers the choice across a remount', () => {
    const fleet = landedFleet()
    mountCut({ fleet })
    act(() => {
      toggle()
    })
    cleanup()

    mountCut({ fleet })
    expect(screen.getByTestId('scene-hide-finished')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('scene-hide-finished').textContent).toMatch(/^show finished/i)
  })

  it('names the finished lanes for a reader who cannot see the canvas', () => {
    const fleet = landedFleet()
    mountCut({ fleet })
    // The words carry the topology, and under prd10 ruling 13 the topology is
    // that a finished lane is still threaded to the mass. A reader told "cut
    // loose" would be given a network the canvas no longer draws.
    expect(screen.getByTestId('scene-summary').textContent).toMatch(
      new RegExp(`^0 lanes threaded to main\\. ${fleet.lanes.length} finished, still threaded\\.`),
    )
  })
})


/**
 * jsdom implements neither `Path2D` nor a 2D context, and a browser has both. The
 * shim is a *shape* rather than an empty class because the painter now builds paths
 * imperatively as well as from SVG data (prd10 ruling 3's baked ring geometry), so a
 * stub with no methods would fail on a call a browser answers.
 */
const PATH2D = class {
  constructor(public d?: string) {}
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
}

/**
 * Records what was asked of it. Enough of a 2D context for `paint` to run.
 *
 * `journal` is the optional third recorder, and it is the one the pause suite
 * reads: it keeps the *arguments* of the calls that place light on the canvas,
 * so "the picture did not change" is a comparison of two frames rather than a
 * count of how many calls each of them made.
 */
function fakeContext(calls: string[], transforms: number[][] = [], journal: unknown[][] = []) {
  const noop = (name: string) => () => {
    calls.push(name)
  }
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(name)
      journal.push([name, ...args])
    }
  const gradient = { addColorStop: noop('addColorStop') }

  return {
    canvas: { width: 900, height: 260 },
    save: noop('save'),
    restore: noop('restore'),
    beginPath: noop('beginPath'),
    closePath: noop('closePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    arc: record('arc'),
    fill: noop('fill'),
    stroke: noop('stroke'),
    fillRect: noop('fillRect'),
    strokeRect: noop('strokeRect'),
    // The type layer is transparent and is wiped before each frame; the GL
    // canvas underneath is cleared by `glClear`. See `gl/overlay.ts`.
    clearRect: noop('clearRect'),
    fillText: record('fillText'),
    translate: noop('translate'),
    rotate: noop('rotate'),
    scale: noop('scale'),
    setTransform: (...args: number[]) => {
      calls.push('setTransform')
      transforms.push(args)
    },
    setLineDash: noop('setLineDash'),
    measureText: () => ({ width: 40 }),
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
    // prd10's sprite stamps and grain tile. Both are journalled: a mote's position
    // is exactly the sort of "light on the canvas" the pause suite compares, and a
    // drift that kept moving under a held clock would otherwise go unnoticed.
    drawImage: record('drawImage'),
    createPattern: () => null,
    // The grain tile rasterises into a scratch canvas, which under this mock is
    // this same context: a browser has both of these, so the shim does too.
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: noop('putImageData'),
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineCap: 'round',
    lineJoin: 'round',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'middle',
    fillStyle: '',
    strokeStyle: '',
  }
}

/**
 * THE TWO CLOCKS, WIRED (#157's audit).
 *
 * `marks.test.ts` owns the laws — which quantities read which clock, and why. What
 * it cannot see is whether the component actually *hands* the picture two numbers,
 * because it builds its own frames. This is the seam: one mounted scene, one hand-
 * driven loop, and the two clocks moved independently of each other.
 *
 * The picture is compared as the journal of what the painter was told to draw,
 * which is the same harness the pause suite uses and for the same reason: "did the
 * picture change?" is the whole question in both cases.
 */
describe("the scene's two clocks, wired (#157)", () => {
  afterEach(restoreAfterMount)

  it('ages the fleet on the state clock while the wall clock stands still', () => {
    // Nothing moves the wall: no frame advances, no animation runs. The only thing
    // that changes is the instant the picture is being judged as of — and the
    // layout follows it, because every use of it in `layoutScene` is an age.
    const { frame, asOf } = mountMotion({ asOf: NOW })
    const young = frame()

    asOf(NOW + RECENCY_SPAN_MS)
    const old = frame()

    expect(old).not.toBe(young)
  })

  it('runs the animations on the wall clock while the state clock stands still', () => {
    // The mirror image: the scrub is pinned, so nothing in the fleet is any older,
    // and the picture still changes — because the grain, the shimmer and the breath
    // are durations a person watches rather than facts about the fleet.
    const { frame, at } = mountMotion({ asOf: NOW })
    const before = frame()

    at(4_000)
    const after = frame()

    expect(after).not.toBe(before)
  })

  it('holds both of them when the operator pauses', () => {
    // Pause is the one control that stops the picture, and it has to stop all of
    // it: a frozen scene whose lanes went on drifting outward would be a still
    // image quietly telling a different story every second.
    const { frame, at, asOf } = mountMotion({ asOf: NOW })
    frame()
    act(() => {
      pause()
    })
    const held = frame()

    at(6_000)
    asOf(NOW + RECENCY_SPAN_MS)
    expect(frame()).toBe(held)
  })

  it('falls back to one clock when nothing supplies a second — which is live', () => {
    // The property that makes the split safe to land: with no `asOf` prop the
    // component uses its own real clock for both, so the live scene is byte-for-
    // byte the scene it was before the split existed.
    const pinned = mountMotion({ asOf: NOW })
    const withProp = pinned.frame()
    restoreAfterMount()

    const live = mountMotion()
    expect(live.frame()).toBe(withProp)
  })
})

/**
 * THE GUARD ADR-0047 MANDATES (#389, prd-30 w4).
 *
 * Driven against `MotionControl` directly rather than through `SceneView`, and
 * that is the whole point of the exception. `SceneView` passes
 * `paused={paused || stilled}`, so while `stilled` holds, the toggle this guard
 * blocks changes NOTHING observable — a test mounted on the scene would stay
 * green with the guard deleted, which is the "test that cannot fail for the
 * reason it claims" this repo keeps paying for. With a spy in hand, removing
 * `if (stilled) return` turns the first case below red.
 *
 * **Why `fireEvent.click` is the keyboard assertion.** An `aria-disabled`
 * button is a real button: the browser synthesises a click from Enter and from
 * Space, and jsdom does not. So the click IS the keyboard path — guarding
 * `onMouseDown` or leaning on `pointer-events` would leave both keys live,
 * which is precisely the defect the ruling names. The `keyDown` cases below
 * assert the other half: that no separate key handler smuggles the act through.
 */
describe('the motion control refuses to act while it says it is unavailable (#389, ADR-0047)', () => {
  // These render the control directly rather than through `mountMotion`, so
  // they carry their own teardown — the suites above tear down a mounted scene.
  afterEach(cleanup)

  it('does not run the toggle when stilled — by pointer or by key', () => {
    const onToggle = vi.fn()
    render(<MotionControl paused stilled onToggle={onToggle} />)
    const button = screen.getByTestId('scene-motion-pause')

    expect(button).toHaveAttribute('aria-disabled', 'true')

    fireEvent.click(button)
    fireEvent.keyDown(button, { key: 'Enter' })
    fireEvent.keyDown(button, { key: ' ' })

    expect(onToggle).not.toHaveBeenCalled()
  })

  it('still runs the toggle when it is available — the guard is not a stuck door', () => {
    // The sibling half. A guard that never lets anything through would satisfy
    // the case above and break the control; both directions have to be pinned.
    const onToggle = vi.fn()
    render(<MotionControl paused={false} stilled={false} onToggle={onToggle} />)

    fireEvent.click(screen.getByTestId('scene-motion-pause'))

    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('stays focusable while unavailable, and discloses why on focus as well as hover', () => {
    render(<MotionControl paused stilled onToggle={() => {}} />)

    const card = discloseText(screen.getByTestId('scene-motion-pause'))

    expect(card).toContain('Motion is stilled in settings — the control lives there')
    expect(card).toContain('change the motion level in Settings')
  })

  it('discloses what it would do when it IS available', () => {
    render(<MotionControl paused={false} stilled={false} onToggle={() => {}} />)

    const card = discloseText(screen.getByTestId('scene-motion-pause'))

    expect(card).toContain('Freeze the scene’s own motion')
  })
})
