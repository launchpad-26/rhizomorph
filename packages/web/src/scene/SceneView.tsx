import { useEffect, useRef, useState } from 'react'
import type { Fleet } from '../fleet/index.js'
import { layoutScene, type SceneGeometry } from './geometry.js'
import { breathOf, sceneMarks, type SceneFrame } from './marks/index.js'
import { paint } from './paint.js'
import type { PulseField } from './pulses.js'
import { salienceOf } from './salience.js'
import type { SettleRegistry } from './settle.js'

/**
 * The canvas host: the frame loop, device-pixel scaling, hit testing, and the
 * reduced-motion query. Nothing visual is decided here — the picture is
 * `sceneMarks(frame)` and the drawing is `paint`.
 *
 * The loop runs continuously because two things are genuinely continuous: a
 * node's drift outward as its lane goes quiet, and the root-mass's breath. With
 * nothing happening, both are imperceptible and the network is still — which is
 * the point. Stillness is information.
 *
 * Everything the loop reads is taken from a ref rather than from the closure, so
 * a fleet rebuild once a second never tears down and rebuilds the animation.
 */

export interface SceneViewProps {
  fleet: Fleet
  field: PulseField
  settle: SettleRegistry
  selectedId: string | null
  onSelect: (laneId: string | null) => void
  /**
   * Test-only clock. Pinned, the loop draws exactly one frame and stops, so a
   * test asserts against a still image rather than racing an interval.
   */
  now?: number
}

/** How close to a node a pointer must be to have picked it, in CSS pixels. */
const HIT_RADIUS = 30

export function SceneView({ fleet, field, settle, selectedId, onSelect, now }: SceneViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const geometryRef = useRef<SceneGeometry | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [reducedMotion, setReducedMotion] = useState(false)

  const latest = useRef({ fleet, field, settle, selectedId, hoverId, reducedMotion, now })
  latest.current = { fleet, field, settle, selectedId, hoverId, reducedMotion, now }

  useEffect(() => {
    // `matchMedia` is absent in some test environments; its absence means "no
    // stated preference", which is the same as not reducing motion.
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReducedMotion(query.matches)
    const onChange = () => setReducedMotion(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const host = hostRef.current
    if (canvas === null || host === null) return

    let frame = 0
    let width = 0
    let height = 0

    const resize = () => {
      const rect = host.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      // A floor rather than the measured size, so a zero-height host during
      // mount still lays out a coherent scene instead of dividing by nothing.
      width = Math.max(320, Math.floor(rect.width))
      height = Math.max(180, Math.floor(rect.height))
      // The backing store only. The element's *size* is CSS (absolutely
      // positioned), so it can never feed back into the panel that contains it —
      // a canvas with a pixel width inside a flexible column will happily push
      // that column wider than the viewport, one resize at a time.
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      const ctx = canvas.getContext('2d')
      if (ctx !== null) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null
    observer?.observe(host)
    resize()

    const drawFrame = () => {
      const current = latest.current
      const clock = current.now ?? Date.now()
      const ctx = canvas.getContext('2d')
      // jsdom has no 2D context. The scene is then simply not drawn — the DOM
      // it lives in still renders, and so does everything around it.
      if (ctx === null) return

      current.field.step(clock)

      const geometry = layoutScene(current.fleet, {
        width,
        height,
        now: clock,
        growth: current.settle.progress(clock),
      })
      geometryRef.current = geometry

      const sceneFrame: SceneFrame = {
        fleet: current.fleet,
        geometry,
        field: current.field,
        salience: salienceOf({
          fleet: current.fleet,
          hoverId: current.hoverId,
          selectedId: current.selectedId,
        }),
        now: clock,
        reducedMotion: current.reducedMotion,
        breath: breathOf(clock, current.reducedMotion),
      }

      paint({ ctx, marks: sceneMarks(sceneFrame), width, height })
    }

    // A pinned clock is a test asking for a still image; running a loop under it
    // would redraw the same frame forever and race every assertion.
    if (latest.current.now !== undefined) {
      drawFrame()
      return () => observer?.disconnect()
    }

    const tick = () => {
      frame = requestAnimationFrame(tick)
      drawFrame()
    }
    frame = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [now])

  /** The nearest node within {@link HIT_RADIUS}, in CSS pixels. */
  const laneAt = (clientX: number, clientY: number): string | null => {
    const geometry = geometryRef.current
    const canvas = canvasRef.current
    if (geometry === null || canvas === null) return null

    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top

    let best: string | null = null
    let bestDistance = HIT_RADIUS
    for (const thread of geometry.threads) {
      const distance = Math.hypot(thread.node.x - x, thread.node.y - y)
      if (distance < bestDistance) {
        bestDistance = distance
        best = thread.laneId
      }
    }
    return best
  }

  return (
    <div ref={hostRef} className="relative h-full w-full overflow-hidden bg-ice-1000">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        onMouseMove={(event) => setHoverId(laneAt(event.clientX, event.clientY))}
        onMouseLeave={() => setHoverId(null)}
        onClick={(event) => onSelect(laneAt(event.clientX, event.clientY))}
      />
      <SceneSummary fleet={fleet} />
    </div>
  )
}

/**
 * The scene in words, for anything that cannot read a canvas — a screen reader,
 * and every test that needs to know the picture was built rather than what it
 * looks like. Not a legend: the encoding is meant to be learnable without one
 * (ruling 21), and this is never shown to a sighted reader.
 */
function SceneSummary({ fleet }: { fleet: Fleet }) {
  const flagged = fleet.lanes.filter((lane) => lane.pathologies.length > 0)

  return (
    <p className="sr-only" data-testid="scene-summary">
      {`${fleet.lanes.length} lanes threaded to ${fleet.root.mainBranch ?? 'main'}. `}
      {flagged.length === 0
        ? 'None flagged.'
        : flagged
            .map((lane) => `${lane.label}: ${lane.pathologies.map((p) => p.kind).join(', ')}`)
            .join('; ')}
    </p>
  )
}
