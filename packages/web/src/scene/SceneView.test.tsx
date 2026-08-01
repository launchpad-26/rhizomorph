import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModeProvider } from '../app/ModeContext.js'
import { StreamProvider } from '../app/StreamContext.js'
import { FleetProvider, SelectionProvider } from '../fleet/index.js'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import Scene from './index.js'

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
  cleanup()
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
  it('starts on the live stream and says so honestly when it is empty', async () => {
    await mountScene()
    // Connected but idle is not the same as not connected, and neither is a
    // fleet: an empty live log threads nothing, and claims nothing either.
    expect(summary()).toContain('0 lanes threaded')
  })

  it('threads all twenty lanes of the scale fixture on key 2', async () => {
    await mountScene()
    await pressKey('2')
    expect(summary()).toContain('20 lanes threaded to main')
    expect(summary()).toContain('None flagged')
  })

  it('finds all five pathologies in the staged fixture on key 3', async () => {
    await mountScene()
    await pressKey('3')

    const text = summary()
    expect(text).toContain('9 lanes threaded to main')
    for (const kind of ['looping', 'frozen', 'waiting', 'expensive']) {
      expect(text, `the staged fixture lost its ${kind} lane`).toContain(kind)
    }
    // OFF-FENCE needs a manifest, and a fixture carries the one it dispatched
    // with — so this fixture can produce it while the live stream cannot.
    expect(text).toContain('off-fence')
  })

  it('goes back to the live stream on key 1', async () => {
    await mountScene()
    await pressKey('3')
    expect(summary()).toContain('9 lanes')
    await pressKey('1')
    expect(summary()).toContain('0 lanes')
  })
})

describe('the canvas host', () => {
  it('renders without a 2D context rather than taking the panel down', async () => {
    // jsdom returns null from getContext. The scene must be un-drawn, not
    // undefined: the DOM around it is what keeps the demo alive.
    const { container } = await mountScene()
    expect(container.querySelector('canvas')).not.toBeNull()
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
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform() {
        throw new Error('canvas is gone')
      },
    } as unknown as CanvasRenderingContext2D)

    await mountWithCanvas()
    expect(screen.getByRole('status').textContent).toContain('canvas is gone')
    expect(screen.getByRole('status').textContent).toContain('panels are unaffected')
  })

  it('paints the whole picture when a context exists', async () => {
    // The real executor, against a real-shaped context: proof that the display
    // list survives the trip to canvas calls, in an environment that has one.
    // jsdom implements neither `Path2D` nor a 2D context; a browser has both.
    vi.stubGlobal('Path2D', class {})
    const calls: string[] = []
    const context = fakeContext(calls)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    )

    await mountWithCanvas()
    await pressKey('3')

    // The whole vocabulary reached the canvas: filled ribbons and glyphs,
    // stroked cuts and fences, and the names over the top of them.
    expect(calls).toContain('fill')
    expect(calls).toContain('stroke')
    expect(calls).toContain('fillText')
    expect(screen.queryByRole('status')).toBeNull()
  })
})

/** Records what was asked of it. Enough of a 2D context for `paint` to run. */
function fakeContext(calls: string[]) {
  const noop = (name: string) => () => {
    calls.push(name)
  }
  const gradient = { addColorStop: noop('addColorStop') }

  return {
    canvas: { width: 900, height: 260 },
    save: noop('save'),
    restore: noop('restore'),
    beginPath: noop('beginPath'),
    closePath: noop('closePath'),
    moveTo: noop('moveTo'),
    lineTo: noop('lineTo'),
    arc: noop('arc'),
    fill: noop('fill'),
    stroke: noop('stroke'),
    fillRect: noop('fillRect'),
    strokeRect: noop('strokeRect'),
    fillText: noop('fillText'),
    translate: noop('translate'),
    rotate: noop('rotate'),
    scale: noop('scale'),
    setTransform: noop('setTransform'),
    setLineDash: noop('setLineDash'),
    measureText: () => ({ width: 40 }),
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
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
