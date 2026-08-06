import { useEffect, useRef, useState } from 'react'
import type { Fleet } from '../fleet/index.js'
import { ZOOM_STEP } from './camera.js'
import { useScenePref } from '../app/panelPrefs.js'
import type { SceneGeometry } from './geometry.js'
import type { PulseField } from './pulses.js'
import { isRetired, type RetireRegistry } from './retire.js'
import type { SettleRegistry } from './settle.js'
import { useCamera } from './view/useCamera.js'
import { useFrameLoop, type SceneLatestState } from './view/useFrameLoop.js'
import { cursorOf, onSceneKeyDown } from './view/input.js'
import { pickAt } from './view/hitTest.js'

/**
 * THE CANVAS HOST — orchestration only.
 *
 * Everything that used to live here has a home under `scene/view/`: the
 * camera's navigational half (flights, fit, home, step) is `useCamera`, the
 * frame loop — device-pixel scaling, d3-zoom's gestures, the reduced-motion-
 * aware picture — is `useFrameLoop`, hit testing is `hitTest.ts`'s `pickAt`,
 * and the keyboard/cursor vocabulary is `input.ts`. This file's job is to hold
 * the state those modules read and write, wire them to the DOM, and lay out
 * the chrome around the canvas.
 *
 * **The pause control** (prd5 ruling 4) is wired here, and it is not a nicety:
 * WCAG 2.2.2 is Level A, it covers any moving content that starts on its own
 * and runs past five seconds, and a canvas that breathes for ever is exactly
 * that. `useFrameLoop` does the freezing; this file owns the one boolean that
 * tells it to.
 */

export interface SceneViewProps {
  fleet: Fleet
  field: PulseField
  settle: SettleRegistry
  /** Which lanes have left the network, and how far along their cut is. */
  retire: RetireRegistry
  selectedId: string | null
  onSelect: (laneId: string | null) => void
  /**
   * Test-only clock. Pinned, the loop draws exactly one frame and stops, so a
   * test asserts against a still image rather than racing an interval.
   */
  now?: number
  /**
   * THE STATE CLOCK (#157) — the instant the scene should judge the fleet's ages
   * against. Absent means "the same instant it is animating at", which is exactly
   * right live and exactly wrong in a replay; `scene/index.tsx` supplies the scrub
   * position for the replay case.
   */
  asOf?: number
  /**
   * Whether this frame is a performance of history rather than a live instrument.
   * The only thing it changes is `frame.vibrancy` — see `REPLAY_VIBRANCY`.
   */
  replaying?: boolean
}

export function SceneView({
  fleet,
  field,
  settle,
  retire,
  selectedId,
  onSelect,
  now,
  asOf,
  replaying = false,
}: SceneViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const geometryRef = useRef<SceneGeometry | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [reducedMotion, setReducedMotion] = useState(false)
  const [paused, setPaused] = useState(false)
  const [hideFinished, setHideFinished] = useScenePref('hideFinished')
  const [failure, setFailure] = useState<string | null>(null)
  const [grabReady, setGrabReady] = useState(false)

  const latest = useRef<SceneLatestState>({
    fleet,
    field,
    settle,
    retire,
    selectedId,
    hoverId,
    reducedMotion,
    paused,
    hideFinished,
    now,
    asOf,
    replaying,
  })
  latest.current = {
    fleet,
    field,
    settle,
    retire,
    selectedId,
    hoverId,
    reducedMotion,
    paused,
    hideFinished,
    now,
    asOf,
    replaying,
  }

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

  const camera = useCamera(canvasRef, latest)
  const { lost, panning, redraw } = useFrameLoop(
    hostRef,
    canvasRef,
    geometryRef,
    latest,
    camera,
    setFailure,
    now,
  )
  const { fit, home, step } = camera

  /**
   * A preference that changes the picture has to produce a frame. The running
   * loop would pick it up on its own within 16 ms; a *pinned* clock draws once
   * and stops, so under one this is the only thing that redraws — which is what
   * makes the toggle testable against a still image.
   */
  useEffect(() => {
    redraw()
  }, [hideFinished, redraw])

  return (
    <div
      ref={hostRef}
      tabIndex={0}
      onKeyDown={(event) => onSceneKeyDown(event, { fit, home, step, setGrabReady })}
      onKeyUp={(event) => {
        if (event.key === ' ') setGrabReady(false)
      }}
      onBlur={() => setGrabReady(false)}
      className="relative h-full w-full overflow-hidden bg-ice-1000 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ice-700"
    >
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 h-full w-full ${cursorOf(panning, grabReady, hoverId !== null)}`}
        onMouseMove={(event) =>
          setHoverId(
            pickAt(geometryRef.current, canvasRef.current, camera.cameraRef.current, event.clientX, event.clientY),
          )
        }
        onMouseLeave={() => setHoverId(null)}
        onClick={(event) =>
          onSelect(
            pickAt(geometryRef.current, canvasRef.current, camera.cameraRef.current, event.clientX, event.clientY),
          )
        }
      />
      <MotionControl paused={paused} onToggle={() => setPaused((held) => !held)} />
      <FinishedControl
        hidden={hideFinished}
        finished={fleet.lanes.filter(isRetired).length}
        onToggle={() => setHideFinished((hide) => !hide)}
      />
      <CameraControls
        lost={lost}
        reducedMotion={reducedMotion}
        onFit={fit}
        onHome={home}
        onIn={() => step(ZOOM_STEP)}
        onOut={() => step(1 / ZOOM_STEP)}
      />
      {failure !== null && (
        <p
          role="status"
          className="absolute inset-x-0 bottom-0 px-3 py-2 text-center text-[10px] uppercase tracking-widest text-broken"
        >
          {`scene stopped drawing — ${failure} — the panels are unaffected`}
        </p>
      )}
      <SceneSummary fleet={fleet} />
    </div>
  )
}

interface MotionControlProps {
  paused: boolean
  onToggle: () => void
}

/**
 * THE PAUSE CONTROL (prd5 ruling 4) — WCAG 2.2.2, Level A.
 *
 * Any content that moves on its own, runs longer than five seconds and sits
 * beside other content needs a way to stop it. The scene breathes for as long as
 * it is open, so without this button the whole instrument is a Level A failure
 * however careful the rest of the motion work is. It is a real `<button>` in the
 * document, so it is in the tab order and answers Enter and Space for free —
 * no key of its own, because the scene's keys are scoped to a focused canvas and
 * an accessibility control that only works once you have found the canvas is not
 * one.
 *
 * Paused, it *says so* rather than only looking different: the state is the
 * point, and a stopped scene with no words on it is indistinguishable from a
 * quiet fleet — which is the one confusion this instrument can least afford.
 * `aria-pressed` carries the same fact to a screen reader.
 *
 * It sits top-left, the one corner nothing else claims: the camera cluster owns
 * bottom-right and the gap voice is painted into the bottom-left gutter, and a
 * control that covered law 12's caveats would be buying accessibility with
 * honesty. Ice, never amber — amber means needs-you in this instrument.
 */
function MotionControl({ paused, onToggle }: MotionControlProps) {
  return (
    <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-2">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={paused}
        data-testid="scene-motion-pause"
        title={paused ? 'Let the scene move again' : 'Freeze the scene’s own motion'}
        className={`pointer-events-auto rounded border px-2 py-1 text-[10px] uppercase leading-none tracking-wide backdrop-blur-sm transition-[transform,color,border-color] duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-ice-600 active:scale-[0.97] ${
          paused
            ? 'border-ice-600 bg-ice-900/90 text-ice-100'
            : 'border-ice-850 bg-ice-950/80 text-ice-400 hover:border-ice-600 hover:text-ice-200'
        }`}
      >
        {paused ? 'Resume motion' : 'Pause motion'}
      </button>
      {paused && (
        <span
          role="status"
          data-testid="scene-motion-state"
          className="text-[10px] uppercase tracking-widest text-ice-300"
        >
          Motion paused
        </span>
      )}
    </div>
  )
}

interface FinishedControlProps {
  hidden: boolean
  /** How many lanes have left the network — what the toggle is a toggle over. */
  finished: number
  onToggle: () => void
}

/**
 * THE HIDE-FINISHED TOGGLE (prd10 ruling 16) — **load-bearing** since the network
 * started persisting.
 *
 * Finished lanes are visible by default and this button is the only thing that
 * changes that. It always was, but it used to share the work: prd5's cord-cut
 * shrank a landed lane to a stub and prd10 ruling 2 then erased even that, so the
 * field emptied itself and the toggle was a convenience. Ruling 13 took both away
 * and ruling 16 names the consequence in as many words — *"the existing HIDE
 * FINISHED control becomes load-bearing and must stay obvious"* — because it is
 * now the only thing standing between a long session and a full canvas. The
 * hierarchy (thin, still, behind) is what keeps the full canvas readable; this is
 * what the operator reaches for when they want it empty anyway.
 *
 * Three details it would be easy to get wrong:
 *
 * - **It carries its own count.** "Hidden ≠ gone" is only true if the operator can
 *   still see *that* something is hidden, so the number of finished lanes is on
 *   the button whichever way it is set. A filter that hides its own effect is a
 *   filter that silently makes the picture a lie, which is law 12's whole subject.
 * - **It looks pressed when it is on**, borrowing the pause control's exact
 *   emphasis rather than inventing a second vocabulary for "this control is
 *   currently changing what you see".
 * - **It fades rather than mounting.** On a fleet with nothing finished there is
 *   nothing to hide and the control has nothing to say, but a button that
 *   appears the instant a lane lands would pop into view at exactly the moment
 *   the operator's eye is on the cut. Same treatment, and the same reason, as
 *   `Recenter` below.
 *
 * Top-right: the one corner nothing else claims. Pause owns top-left, the camera
 * owns bottom-right, and the gap voice is painted into the bottom-left gutter.
 */
function FinishedControl({ hidden, finished, onToggle }: FinishedControlProps) {
  const has = finished > 0

  return (
    <div className="pointer-events-none absolute right-2 top-2">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={hidden}
        aria-hidden={!has}
        tabIndex={has ? 0 : -1}
        data-testid="scene-hide-finished"
        title={
          hidden
            ? 'Show the lanes that have finished — they are still in the fleet table either way'
            : 'Hide the strands finished lanes leave behind'
        }
        className={`pointer-events-auto rounded border px-2 py-1 text-[10px] uppercase leading-none tracking-wide backdrop-blur-sm transition-[opacity,transform,color,border-color] duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-ice-600 active:scale-[0.97] ${
          has ? 'opacity-100' : 'pointer-events-none opacity-0'
        } ${
          hidden
            ? 'border-ice-600 bg-ice-900/90 text-ice-100'
            : 'border-ice-850 bg-ice-950/80 text-ice-400 hover:border-ice-600 hover:text-ice-200'
        }`}
      >
        {`${hidden ? 'Show' : 'Hide'} finished · ${finished}`}
      </button>
    </div>
  )
}

interface CameraControlsProps {
  lost: boolean
  reducedMotion: boolean
  onFit: () => void
  onHome: () => void
  onIn: () => void
  onOut: () => void
}

/**
 * The camera's chrome: one cluster, bottom-right, opposite the gap voice.
 *
 * Recenter is always mounted and transitions its own opacity rather than being
 * added and removed — the state it reports flips as fast as a drag, and a
 * mount/unmount cycle at that rate cannot be interrupted mid-fade, while a
 * transition retargets from wherever it got to.
 *
 * It is also deliberately *not* amber. Amber means needs-you in this instrument
 * and means nothing else anywhere in it (theme.css); a viewport control that
 * borrows the alarm palette to get itself noticed is spending a colour the
 * fleet needs.
 */
function CameraControls({ lost, reducedMotion, onFit, onHome, onIn, onOut }: CameraControlsProps) {
  return (
    <div className="pointer-events-none absolute bottom-2 right-2 flex flex-col items-end gap-1.5">
      <button
        type="button"
        onClick={onFit}
        data-testid="scene-recenter"
        aria-hidden={!lost}
        tabIndex={lost ? 0 : -1}
        className={`pointer-events-auto rounded border border-ice-700 bg-ice-900/90 px-2 py-1 text-[10px] uppercase tracking-wide text-ice-100 backdrop-blur-sm transition-[opacity,transform] duration-200 ease-out hover:border-ice-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-ice-600 active:scale-[0.97] ${
          lost
            ? 'scale-100 opacity-100'
            : `pointer-events-none opacity-0 ${reducedMotion ? '' : 'scale-95'}`
        }`}
      >
        Recenter
      </button>
      <div className="pointer-events-auto flex items-center gap-1">
        <CameraButton onClick={onOut} label="Zoom out" hint="−">
          −
        </CameraButton>
        <CameraButton onClick={onIn} label="Zoom in" hint="+">
          +
        </CameraButton>
        <CameraButton onClick={onFit} label="Zoom to fit" hint="1">
          Fit
        </CameraButton>
        <CameraButton onClick={onHome} label="Reset the camera" hint="0">
          Reset
        </CameraButton>
      </div>
    </div>
  )
}

interface CameraButtonProps {
  onClick: () => void
  /** What it does, for a reader who cannot see the glyph. */
  label: string
  /** The key that does the same thing, named in the tooltip. */
  hint: string
  children: React.ReactNode
}

/**
 * Quiet by default and legible on hover: these sit over the picture, and the
 * picture is the point. The press scale is the only motion — 160ms of ease-out
 * on `transform` alone, so the button answers the finger before the camera has
 * finished moving.
 */
function CameraButton({ onClick, label, hint, children }: CameraButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={`${label} (${hint})`}
      className="min-w-7 rounded border border-ice-850 bg-ice-950/80 px-1.5 py-1 text-[10px] uppercase leading-none tracking-wide text-ice-400 backdrop-blur-sm transition-[transform,color,border-color] duration-150 ease-out hover:border-ice-600 hover:text-ice-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ice-600 active:scale-[0.97]"
    >
      {children}
    </button>
  )
}

/**
 * The scene in words, for anything that cannot read a canvas — a screen reader,
 * and every test that needs to know the picture was built rather than what it
 * looks like. Not a legend: the encoding is meant to be learnable without one
 * (ruling 21), and this is never shown to a sighted reader.
 *
 * Camera-independent by design: where the lens happens to be pointed is not a
 * fact about the fleet, and a summary that changed when somebody panned would
 * be reporting the operator rather than the work.
 */
function SceneSummary({ fleet }: { fleet: Fleet }) {
  const flagged = fleet.lanes.filter((lane) => lane.pathologies.length > 0)
  // The words carry the topology, and under ruling 13 the topology is that every
  // lane — working or finished — is still threaded to the mass. A reader who
  // cannot see the canvas used to be told that finished lanes had been "cut
  // loose"; they have not been, and the summary says what the picture says.
  const finished = fleet.lanes.filter(isRetired).length
  const living = fleet.lanes.length - finished

  return (
    <p className="sr-only" data-testid="scene-summary">
      {`${living} lanes threaded to ${fleet.root.mainBranch ?? 'main'}. `}
      {finished === 0 ? '' : `${finished} finished, still threaded. `}
      {flagged.length === 0
        ? 'None flagged.'
        : flagged
            .map((lane) => `${lane.label}: ${lane.pathologies.map((p) => p.kind).join(', ')}`)
            .join('; ')}
    </p>
  )
}
