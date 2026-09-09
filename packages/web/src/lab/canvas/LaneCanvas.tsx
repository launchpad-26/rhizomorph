import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import { paletteFor, type ThemeName } from '../../scene/palette.js'
import { NOT_MEASURED_VOICE } from '../adapters.js'
import type { FailedArm } from '../compare/types.js'
import type { LabCheckpoint, LabExperiment, LabRun } from '../types.js'
import { type CanvasPicture, labelAnchor, layoutCanvas, pickRibbon, type Ribbon } from './organism.js'
import { paintHighlight, paintPicture } from './paint.js'

/**
 * THE LANE CANVAS (prd-55 ruling 11, #385): a Canvas 2D drawing of the lab's
 * record, painted with the scene's brushes — `organism.ts` is the picture,
 * `paint.ts` the hand, and this file the host that puts them in a document.
 *
 * Three things a document has to add to a picture, and each is here for a
 * reason a canvas cannot supply on its own:
 *
 * - **ONE FACTS PANEL PER CANVAS**, `aria-live` (the design call): hover, focus
 *   or select a run and it reads arm · run · verdict · cost · gate. Not a
 *   label on every cord, and never a native tooltip attribute — a tooltip is
 *   unreachable from a keyboard and unreadable by a screen reader mid-hover.
 * - **EVERY RUN IS KEYBOARD-REACHABLE.** Each node has a real `<button>` over
 *   it, in the tab order arm-major then run, carrying its facts as its name;
 *   Enter or Space selects it as a click does.
 * - **TYPE IS THE THEME'S.** Every word the canvas sets is DOM text in the
 *   theme's own faces through its tokens — `figures` for the mono figures,
 *   the page's sans face for the rest — never a literal face name, never a
 *   glyph painted onto the canvas. `laws.test.ts` greps for both.
 *
 * Two canvases, so a hover paints only what changed: the record on one, the
 * highlight on the other. No loop — a static drawing is painted when its
 * inputs change and not otherwise, so `prefers-reduced-motion` has nothing to
 * ask of it; the geometry is the same either way.
 *
 * Where there is no 2D context (jsdom, a browser that refused one) the
 * drawing SAYS so and the facts still read — law 12's gap honesty, kept.
 */
export interface LaneCanvasProps {
  experiment: LabExperiment
  checkpoint?: LabCheckpoint | null
  failedArms?: readonly FailedArm[]
  /**
   * The picture's width in axis units — the same `width` the frame's own axis
   * is drawn in, so the root's x is the playhead's x to the last digit
   * (`same-x-law`). The host scales it to whatever width it is given.
   */
  width?: number
  /** Override the height the run count would choose. */
  height?: number
}

/** Past this many runs, only the hovered and selected runs are named (the observatory's own `labelPolicy`). */
export const LABELS_ALL_MAX = 12

/** How close to a node a pointer must be to have picked it, in picture units. */
const HIT_RADIUS = 14

const NO_FAILED_ARMS: readonly FailedArm[] = []

export function describeCanvas(picture: CanvasPicture, forkId: string): string {
  const n = picture.ribbons.length
  const stubs = picture.stubs.length
  return `${n} ribbon${n === 1 ? '' : 's'} from ${n} run${n === 1 ? '' : 's'} of experiment ${forkId}${stubs === 0 ? '' : ` — and ${stubs} arm${stubs === 1 ? '' : 's'} that never dispatched`}`
}

function money(costUsd: number | null): string {
  return costUsd === null ? 'nothing booked' : `$${costUsd.toFixed(2)}`
}

/** arm · run · verdict · cost · gate — the facts panel's sentence for one run. */
export function runFacts(ribbon: Ribbon, run: LabRun): string {
  const outcome = run.outcome
  const gate =
    outcome === undefined
      ? NOT_MEASURED_VOICE
      : `gate ${outcome.provenance.verifyCommand} (${outcome.provenance.source})${outcome.verifiedDetail === null ? '' : ` — ${outcome.verifiedDetail}`}`
  return `arm ${ribbon.arm} · run ${ribbon.run} · ${ribbon.state} · ${money(ribbon.costUsd)} · ${gate}`
}

/**
 * The theme, read the one way a surface is allowed to learn it: the document's
 * own attribute (`settings/apply.ts` is its only writer). The same shape as
 * the observatory's `scene/view/useDocumentTheme`, restated here because
 * `scene/view/` reads the fold and is forbidden to the lab by name — the
 * branching glyph reads it through this export.
 */
export function useCanvasTheme(): ThemeName {
  const [theme, setTheme] = useState<ThemeName>(() => readTheme())
  useEffect(() => {
    if (typeof MutationObserver !== 'function') return
    const observer = new MutationObserver(() => setTheme(readTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    setTheme(readTheme())
    return () => observer.disconnect()
  }, [])
  return theme
}

function readTheme(): ThemeName {
  return document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark'
}

interface HostSize {
  /** The host's CSS width, in CSS pixels. */
  css: number
  dpr: number
}

export function LaneCanvas({ experiment, checkpoint = null, failedArms = NO_FAILED_ARMS, width = 1000, height }: LaneCanvasProps) {
  const theme = useCanvasTheme()
  const palette = paletteFor(theme)
  const picture = useMemo(
    () => layoutCanvas({ experiment, checkpoint, failedArms, width, palette, ...(height === undefined ? {} : { height }) }),
    [experiment, checkpoint, failedArms, width, height, palette],
  )
  const runsById = useMemo(() => {
    const map = new Map<string, LabRun>()
    for (const arm of experiment.arms) for (const run of arm.runs) map.set(run.laneHandle, run)
    return map
  }, [experiment])

  const hostRef = useRef<HTMLDivElement | null>(null)
  const baseRef = useRef<HTMLCanvasElement | null>(null)
  const overRef = useRef<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState<HostSize>({ css: width, dpr: 1 })
  const [undrawn, setUndrawn] = useState(false)
  const [hover, setHover] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  // The host's width, measured once and on resize. A zero measurement (jsdom, mid-mount) falls back to the picture's own width: scale 1.
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const measure = () => {
      const css = Math.floor(host.getBoundingClientRect().width) || width
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      setSize((current) => (current.css === css && current.dpr === dpr ? current : { css, dpr }))
    }
    measure()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [width])

  // THE RECORD — painted when the picture, the size or the theme changes, and not otherwise.
  useEffect(() => {
    const canvas = baseRef.current
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) {
      setUndrawn(true)
      return
    }
    setUndrawn(false)
    canvas.width = Math.round(size.css * size.dpr)
    canvas.height = Math.round((picture.height / picture.width) * size.css * size.dpr)
    paintPicture(ctx, picture, { scale: size.css / picture.width, dpr: size.dpr })
  }, [picture, size])

  // THE HIGHLIGHT — painted when the hover or the selection changes, on its own canvas.
  useEffect(() => {
    const canvas = overRef.current
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    canvas.width = Math.round(size.css * size.dpr)
    canvas.height = Math.round((picture.height / picture.width) * size.css * size.dpr)
    paintHighlight(ctx, picture, { hover, selected }, { scale: size.css / picture.width, dpr: size.dpr })
  }, [picture, size, hover, selected])

  function onMove(event: MouseEvent<HTMLDivElement>) {
    const host = hostRef.current
    if (host === null) return
    const rect = host.getBoundingClientRect()
    const k = rect.width > 0 ? picture.width / rect.width : 1
    const picked = pickRibbon(picture, { x: (event.clientX - rect.left) * k, y: (event.clientY - rect.top) * k }, HIT_RADIUS)
    setHover(picked === null ? null : picked.id)
  }

  const pct = (value: number, of: number) => `${((value / of) * 100).toFixed(3)}%`
  const shown = hover ?? selected
  const shownRibbon = shown === null ? null : (picture.ribbons.find((ribbon) => ribbon.id === shown) ?? null)
  const shownRun = shownRibbon === null ? undefined : runsById.get(shownRibbon.id)
  const facts =
    shownRibbon !== null && shownRun !== undefined
      ? runFacts(shownRibbon, shownRun)
      : picture.ribbons.length === 0
        ? `${describeCanvas(picture, experiment.forkId)} — no run has been dispatched from this checkpoint yet; nothing is drawn from nothing`
        : `${describeCanvas(picture, experiment.forkId)} — hover, focus or select a run to read arm · run · verdict · cost · gate`
  const nameAll = picture.ribbons.length <= LABELS_ALL_MAX
  const dirClass = picture.direction === 'right' ? '' : '-translate-x-full text-right'
  const forkLabel = picture.fraction === null ? 'fork · session file moved · drawn at the inset' : `fork · ${Math.round(picture.fraction * 100)} %`

  return (
    <div
      data-testid={`lane-canvas-${experiment.forkId}`}
      data-ribbons={picture.ribbons.length}
      data-stubs={picture.stubs.length}
      data-direction={picture.direction}
      /* the picture's height in its own units — what a host must give the ribbons room for, readable by whoever mounts it */
      data-height={picture.height}
      role="group"
      aria-label={describeCanvas(picture, experiment.forkId)}
      className="flex flex-col border border-(--line-hair) bg-(--surface-panel)"
    >
      <div ref={hostRef} className="relative w-full select-none" style={{ aspectRatio: `${picture.width} / ${picture.height}` }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <canvas ref={baseRef} aria-hidden className="absolute inset-0 h-full w-full" />
        <canvas ref={overRef} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />
        {undrawn ? (
          <p role="status" data-testid="lane-canvas-undrawn" className="absolute top-10 left-2 text-(--ink-dim) text-inst">
            this environment gave no 2D canvas — nothing is painted; the record still reads below
          </p>
        ) : null}

        {/* the axis, in words: its ends ABOVE the line, the fork's position below it — so a fork at 100 % and the far end never share a line */}
        <span aria-hidden className="figures -translate-y-full absolute text-(--ink-dim) text-inst-dense leading-none" style={{ left: pct(picture.axis.from, picture.width), top: pct(picture.axis.y - 4, picture.height) }}>
          0 %
        </span>
        <span aria-hidden className="figures -translate-x-full -translate-y-full absolute text-(--ink-dim) text-inst-dense leading-none" style={{ left: pct(picture.axis.to, picture.width), top: pct(picture.axis.y - 4, picture.height) }}>
          100 % of session
        </span>
        <span
          data-testid={`lane-canvas-fork-${experiment.forkId}`}
          data-x={String(picture.root.at.x)}
          className={`figures absolute text-(--ink-body) text-inst leading-none ${picture.direction === 'right' ? 'translate-x-2' : '-translate-x-full -ml-2'}`}
          style={{ left: pct(picture.root.at.x, picture.width), top: pct(picture.axis.y + 4, picture.height) }}
        >
          {forkLabel}
        </span>
        <span aria-hidden className="figures -translate-x-1/2 absolute text-(--ink-dim) text-inst-dense leading-none" style={{ left: pct(picture.root.at.x, picture.width), top: pct(picture.root.at.y + picture.root.radius + 6, picture.height) }}>
          {experiment.checkpointId}
        </span>

        {/* one reachable node per run, and its name on the free side */}
        {picture.ribbons.map((ribbon) => {
          const run = runsById.get(ribbon.id)
          const name = run === undefined ? `arm ${ribbon.arm} · run ${ribbon.run} · ${ribbon.state}` : runFacts(ribbon, run)
          const anchor = labelAnchor(picture, ribbon)
          const named = nameAll || ribbon.id === hover || ribbon.id === selected
          return (
            <span key={ribbon.id}>
              <button
                type="button"
                data-testid={`lane-canvas-run-${ribbon.id}`}
                data-state={ribbon.state}
                data-arm={ribbon.arm}
                data-run={ribbon.run}
                aria-label={name}
                aria-pressed={selected === ribbon.id}
                onFocus={() => setHover(ribbon.id)}
                onBlur={() => setHover((current) => (current === ribbon.id ? null : current))}
                onMouseEnter={() => setHover(ribbon.id)}
                onClick={() => setSelected((current) => (current === ribbon.id ? null : ribbon.id))}
                className="focus-ring -translate-x-1/2 -translate-y-1/2 absolute h-6 w-6 cursor-pointer rounded-full border-0 bg-transparent p-0"
                style={{ left: pct(ribbon.node.x, picture.width), top: pct(ribbon.node.y, picture.height) }}
              />
              {named ? (
                <span
                  aria-hidden
                  data-testid={`lane-canvas-name-${ribbon.id}`}
                  className={`figures -translate-y-1/2 pointer-events-none absolute whitespace-nowrap text-inst leading-none ${dirClass} ${ribbon.id === shown ? 'text-(--ink-primary)' : 'text-(--ink-dim)'}`}
                  style={{ left: pct(anchor.x, picture.width), top: pct(anchor.y, picture.height) }}
                >
                  a{ribbon.arm} / r{ribbon.run} · {ribbon.state} · {money(ribbon.costUsd)}
                </span>
              ) : null}
            </span>
          )
        })}

        {/* the stubs, named with their error on their own row — drawn, never counted */}
        {picture.stubs.map((stub) => (
          <span
            key={`stub-${stub.arm}`}
            data-testid={`canvas-stub-${stub.arm}`}
            className={`figures -translate-y-1/2 pointer-events-none absolute whitespace-nowrap text-(--ink-dim) text-inst leading-none ${dirClass}`}
            style={{ left: pct(stub.at.x, picture.width), top: pct(stub.at.y, picture.height) }}
          >
            arm {stub.arm} · failed to dispatch — {stub.error} · stub, not counted
          </span>
        ))}
      </div>

      <p data-testid={`lane-canvas-facts-${experiment.forkId}`} aria-live="polite" className="figures border-(--line-hair) border-t px-2 py-1 text-(--ink-body) text-inst">
        {facts}
      </p>
    </div>
  )
}
