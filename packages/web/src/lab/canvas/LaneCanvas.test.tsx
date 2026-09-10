import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DARK_PALETTE, LIGHT_PALETTE, type ScenePalette } from '../../scene/palette.js'
import { NOT_MEASURED_VOICE } from '../adapters.js'
import {
  CHECKPOINT_AT_38,
  cellOf,
  checkpointAt,
  LIVE_TWO_BY_THREE,
  NO_DISPATCH_RECORDS,
  STOPPED_LAUNCH,
  STOPPED_LAUNCH_FAILED_ARMS,
  UNMEASURED_ARM,
} from './fixtures.js'
import { LABELS_ALL_MAX, LaneCanvas } from './LaneCanvas.js'
import type { Paintable } from './paint.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset['theme']
})

/**
 * A 2D context that keeps its calls. jsdom answers `null` for `getContext('2d')`,
 * so the canvas is observed the way the observatory's own mounted suite observed
 * its 2D painter: through the journal of what was asked of the context.
 */
class Recorder implements Paintable {
  paints = 0
  colours: string[] = []
  ops: string[] = []
  // `fillColour`, not `fill` — a field of that name shadows the `fill()` method on the instance.
  private fillColour: string | CanvasGradient | CanvasPattern = ''
  private strokeColour: string | CanvasGradient | CanvasPattern = ''
  lineWidth = 1
  lineCap: CanvasLineCap = 'butt'
  lineJoin: CanvasLineJoin = 'miter'
  get fillStyle() {
    return this.fillColour
  }
  set fillStyle(value: string | CanvasGradient | CanvasPattern) {
    this.fillColour = value
    this.colours.push(String(value))
  }
  get strokeStyle() {
    return this.strokeColour
  }
  set strokeStyle(value: string | CanvasGradient | CanvasPattern) {
    this.strokeColour = value
    this.colours.push(String(value))
  }
  setTransform() {
    this.paints += 1
    this.ops.push('setTransform')
  }
  setLineDash() {
    this.ops.push('setLineDash')
  }
  clearRect() {
    this.ops.push('clearRect')
  }
  beginPath() {
    this.ops.push('beginPath')
  }
  moveTo(x: number, y: number) {
    this.ops.push(`moveTo ${x.toFixed(3)} ${y.toFixed(3)}`)
  }
  lineTo(x: number, y: number) {
    this.ops.push(`lineTo ${x.toFixed(3)} ${y.toFixed(3)}`)
  }
  closePath() {
    this.ops.push('closePath')
  }
  arc(x: number, y: number, r: number) {
    this.ops.push(`arc ${x.toFixed(3)} ${y.toFixed(3)} ${r.toFixed(3)}`)
  }
  rect() {
    this.ops.push('rect')
  }
  fill(rule?: CanvasFillRule) {
    this.ops.push(`fill ${rule ?? ''}`)
  }
  stroke() {
    this.ops.push('stroke')
  }
}

/** One recorder per canvas element: the record layer is the one the pointer reaches; the highlight layer is `pointer-events-none`. */
function recordContexts(): { base: () => Recorder; over: () => Recorder } {
  const recorders = new WeakMap<HTMLCanvasElement, Recorder>()
  const found: { base: Recorder | null; over: Recorder | null } = { base: null, over: null }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    let recorder = recorders.get(this)
    if (recorder === undefined) {
      recorder = new Recorder()
      recorders.set(this, recorder)
      if (this.className.includes('pointer-events-none')) found.over = recorder
      else found.base = recorder
    }
    return recorder as unknown as RenderingContext
  } as HTMLCanvasElement['getContext'])
  const must = (which: 'base' | 'over') => () => {
    const recorder = found[which]
    if (recorder === null) throw new Error(`no ${which} canvas asked for a context`)
    return recorder
  }
  return { base: must('base'), over: must('over') }
}

function paletteConstants(palette: ScenePalette): Set<string> {
  return new Set(
    [...Object.values(palette.status), ...Object.values(palette.register), ...palette.tissue, ...palette.fruit, palette.necrotic, palette.ground].map((rgb) => rgb.join(', ')),
  )
}

function rgbOf(css: string): string {
  const match = /^rgba\((\d+), (\d+), (\d+), /.exec(css)
  if (match === null) throw new Error(`not a palette colour string: ${css}`)
  return `${match[1]}, ${match[2]}, ${match[3]}`
}

const facts = () => screen.getByTestId('lane-canvas-facts-fork-1').textContent ?? ''

describe('LaneCanvas — the record, drawn with the scene\'s brushes (prd-55 ruling 11, #385)', () => {
  it('draws one ribbon per run and says so — the count in the picture is the count in the record', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    render(<LaneCanvas experiment={LIVE_TWO_BY_THREE} checkpoint={CHECKPOINT_AT_38} />)
    const group = screen.getByTestId('lane-canvas-fork-1')
    expect(group.dataset.ribbons).toBe('6')
    expect(group.dataset.stubs).toBe('0')
    expect(group.getAttribute('aria-label')).toBe('6 ribbons from 6 runs of experiment fork-1')
    expect(group.querySelectorAll('[data-testid^="lane-canvas-run-"]')).toHaveLength(6)
    expect(screen.getByTestId('lane-canvas-run-lane-b2').dataset.state).toBe('unmeasured')
  })

  it('paints the record onto a 2D canvas with the palette\'s colours and nothing else', () => {
    const { base } = recordContexts()
    render(<LaneCanvas experiment={LIVE_TWO_BY_THREE} checkpoint={CHECKPOINT_AT_38} />)
    expect(base().paints).toBe(1)
    const constants = paletteConstants(DARK_PALETTE)
    expect(base().colours.length).toBeGreaterThan(20)
    for (const colour of base().colours) expect(constants.has(rgbOf(colour)), colour).toBe(true)
    expect(screen.queryByTestId('lane-canvas-undrawn')).toBeNull()
  })

  it('follows the document\'s theme — on paper, every colour is the light palette\'s', () => {
    document.documentElement.dataset['theme'] = 'light'
    const { base } = recordContexts()
    render(<LaneCanvas experiment={LIVE_TWO_BY_THREE} checkpoint={CHECKPOINT_AT_38} />)
    const constants = paletteConstants(LIGHT_PALETTE)
    for (const colour of base().colours) expect(constants.has(rgbOf(colour)), colour).toBe(true)
  })

  it('where there is no 2D context the drawing says so, and the facts still read (law 12)', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    render(<LaneCanvas experiment={LIVE_TWO_BY_THREE} checkpoint={CHECKPOINT_AT_38} />)
    expect(screen.getByTestId('lane-canvas-undrawn').textContent).toMatch(/no 2D canvas/)
    fireEvent.focus(screen.getByTestId('lane-canvas-run-lane-a1'))
    expect(facts()).toBe('arm 1 · run 1 · passed · $2.10 · gate npm run lint (measure-route)')
  })
})

describe('one facts panel per canvas — hover, focus or select a run (the design call)', () => {
  it('is aria-live, and reads arm · run · verdict · cost · gate for the focused run, the hovered run, and the selected run', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    render(<LaneCanvas experiment={LIVE_TWO_BY_THREE} checkpoint={CHECKPOINT_AT_38} />)
    const panel = screen.getByTestId('lane-canvas-facts-fork-1')
    expect(panel.getAttribute('aria-live')).toBe('polite')
    expect(screen.getAllByRole('status').length + document.querySelectorAll('[aria-live]').length).toBeGreaterThan(0)
    expect(facts()).toMatch(/hover, focus or select a run to read arm · run · verdict · cost · gate/)

    fireEvent.focus(screen.getByTestId('lane-canvas-run-lane-b1'))
    expect(facts()).toBe('arm 2 · run 1 · failed · $1.15 · gate npm run lint (measure-route) — 2 tests failed')
    fireEvent.blur(screen.getByTestId('lane-canvas-run-lane-b1'))

    fireEvent.mouseEnter(screen.getByTestId('lane-canvas-run-lane-b3'))
    expect(facts()).toBe('arm 2 · run 3 · not-run · nothing booked · gate npm run lint (measure-route) — npm: not found')

    fireEvent.click(screen.getByTestId('lane-canvas-run-lane-a2'))
    expect(screen.getByTestId('lane-canvas-run-lane-a2').getAttribute('aria-pressed')).toBe('true')
    fireEvent.mouseLeave(screen.getByTestId('lane-canvas-fork-1').closest('[data-testid="lane-canvas-fork-1"]')?.parentElement as HTMLElement)
    fireEvent.mouseLeave(screen.getByTestId('lane-canvas-run-lane-b3').parentElement?.parentElement as HTMLElement)
    expect(facts()).toBe('arm 1 · run 2 · passed · $3.02 · gate npm run lint (measure-route)')
  })

  it('every run is keyboard-reachable — a real button in the tab order, named with its facts — and the picture carries only one panel', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    render(<LaneCanvas experiment={LIVE_TWO_BY_THREE} checkpoint={CHECKPOINT_AT_38} />)
    const buttons = screen.getByTestId('lane-canvas-fork-1').querySelectorAll('button')
    expect(buttons).toHaveLength(6)
    for (const button of buttons) {
      expect(button.getAttribute('tabindex')).not.toBe('-1')
      expect(button.getAttribute('aria-label')).toMatch(/^arm \d · run \d · /)
    }
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1)
  })

  it('no label is ever a native title attribute — nothing in the canvas carries one', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const { container } = render(<LaneCanvas experiment={STOPPED_LAUNCH} checkpoint={CHECKPOINT_AT_38} failedArms={STOPPED_LAUNCH_FAILED_ARMS} />)
    expect(container.querySelectorAll('[title], title')).toHaveLength(0)
  })

  it('type is the theme\'s: every word the canvas sets goes through the tokens, never a face name or a hex in a style', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const { container } = render(<LaneCanvas experiment={LIVE_TWO_BY_THREE} checkpoint={CHECKPOINT_AT_38} />)
    for (const element of container.querySelectorAll<HTMLElement>('*')) {
      expect(element.style.fontFamily, element.outerHTML.slice(0, 80)).toBe('')
      expect(element.style.color).toBe('')
      expect(element.getAttribute('style') ?? '').not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i)
    }
    // The figures wear the mono token; the panel's default face is the page's sans.
    expect(screen.getByTestId('lane-canvas-facts-fork-1').className).toMatch(/\bfigures\b/)
    expect(screen.getByTestId('lane-canvas-name-lane-a1').className).toMatch(/\bfigures\b/)
  })
})

describe('the states, drawn before the live one (ruling 9)', () => {
  it('EMPTY — no dispatch records: no run buttons, the root still drawn, and the sentence says nothing is drawn from nothing', () => {
    const { base } = recordContexts()
    render(<LaneCanvas experiment={NO_DISPATCH_RECORDS} checkpoint={CHECKPOINT_AT_38} />)
    const group = screen.getByTestId('lane-canvas-fork-empty')
    expect(group.dataset.ribbons).toBe('0')
    expect(group.querySelectorAll('button')).toHaveLength(0)
    expect(screen.getByTestId('lane-canvas-facts-fork-empty').textContent).toMatch(/no run has been dispatched from this checkpoint yet; nothing is drawn from nothing/)
    expect(base().ops.filter((op) => op === 'fill evenodd').length).toBeGreaterThan(0)
  })

  it('PARTIAL — a stopped launch: the arm that never dispatched is a stub, drawn in necrotic ink and named with its error, outside the count', () => {
    const { base } = recordContexts()
    render(<LaneCanvas experiment={STOPPED_LAUNCH} checkpoint={checkpointAt(1)} failedArms={STOPPED_LAUNCH_FAILED_ARMS} />)
    const group = screen.getByTestId('lane-canvas-fork-7be2')
    expect(group.dataset.ribbons).toBe('4')
    expect(group.dataset.stubs).toBe('1')
    expect(group.getAttribute('aria-label')).toBe('4 ribbons from 4 runs of experiment fork-7be2 — and 1 arm that never dispatched')
    expect(screen.getByTestId('canvas-stub-3').textContent).toBe('arm 3 · failed to dispatch — workmux: tmux server not running · stub, not counted')
    expect(base().colours).toContain(`rgba(${DARK_PALETTE.necrotic.join(', ')}, 0.850)`)
    // Late fork: the fan opened leftward and the root kept its true x.
    expect(group.dataset.direction).toBe('left')
    expect(screen.getByTestId('lane-canvas-fork-fork-7be2').dataset.x).toBe('960')
    expect(screen.getByTestId('lane-canvas-fork-fork-7be2').textContent).toBe('fork · 100 %')
  })

  it('HELD BACK — an unmeasured arm: every tip hollow, every fact the not-measured voice, no verdict invented', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    render(<LaneCanvas experiment={UNMEASURED_ARM} checkpoint={CHECKPOINT_AT_38} />)
    const buttons = screen.getByTestId('lane-canvas-fork-a1d1').querySelectorAll<HTMLButtonElement>('button')
    expect(buttons).toHaveLength(3)
    for (const button of buttons) {
      expect(button.dataset.state).toBe('unmeasured')
      expect(button.getAttribute('aria-label')).toContain(NOT_MEASURED_VOICE)
      expect(button.getAttribute('aria-label')).toContain('nothing booked')
    }
    fireEvent.focus(buttons[0] as HTMLButtonElement)
    expect(screen.getByTestId('lane-canvas-facts-fork-a1d1').textContent).toBe(`arm 1 · run 1 · unmeasured · nothing booked · ${NOT_MEASURED_VOICE}`)
  })
})

describe('no per-frame work beyond the paint of what changed', () => {
  it('a hover repaints the highlight layer and never the record; a click the same', () => {
    const { base, over } = recordContexts()
    render(<LaneCanvas experiment={LIVE_TWO_BY_THREE} checkpoint={CHECKPOINT_AT_38} />)
    expect(base().paints).toBe(1)
    const idle = over().paints
    fireEvent.mouseEnter(screen.getByTestId('lane-canvas-run-lane-a1'))
    expect(over().paints).toBe(idle + 1)
    expect(base().paints).toBe(1)
    fireEvent.click(screen.getByTestId('lane-canvas-run-lane-a1'))
    expect(over().paints).toBe(idle + 2)
    expect(base().paints).toBe(1)
    // The highlight filled the picked ribbon's dashes in the emphasis ink, and nothing else.
    expect(over().colours.at(-1)).toBe(`rgba(${DARK_PALETTE.register.data.join(', ')}, 0.225)`)
  })

  it('prefers-reduced-motion yields the same geometry — the canvas reads no motion preference and runs no loop', () => {
    const { base: still } = recordContexts()
    vi.stubGlobal('matchMedia', () => ({ matches: true, media: '(prefers-reduced-motion: reduce)', addEventListener() {}, removeEventListener() {} }))
    render(<LaneCanvas experiment={LIVE_TWO_BY_THREE} checkpoint={CHECKPOINT_AT_38} />)
    const reduced = [...still().ops]
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    const { base: moving } = recordContexts()
    render(<LaneCanvas experiment={LIVE_TWO_BY_THREE} checkpoint={CHECKPOINT_AT_38} />)
    expect(moving().ops).toEqual(reduced)
    expect(reduced.length).toBeGreaterThan(100)
  })

  it(`names every run up to ${LABELS_ALL_MAX}, and past that only the run under the hand — the observatory's own label policy`, () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const { rerender } = render(<LaneCanvas experiment={LIVE_TWO_BY_THREE} checkpoint={CHECKPOINT_AT_38} />)
    expect(document.querySelectorAll('[data-testid^="lane-canvas-name-"]')).toHaveLength(6)
    rerender(<LaneCanvas experiment={cellOf(5, 3)} checkpoint={CHECKPOINT_AT_38} />)
    expect(document.querySelectorAll('[data-testid^="lane-canvas-name-"]')).toHaveLength(0)
    act(() => {
      fireEvent.focus(screen.getByTestId('lane-canvas-run-lane-2-1'))
    })
    expect(document.querySelectorAll('[data-testid^="lane-canvas-name-"]')).toHaveLength(1)
  })
})
