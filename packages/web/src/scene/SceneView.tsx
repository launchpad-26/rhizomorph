import { useEffect, useRef, useState } from 'react'
import { Disclosure, type DisclosureContent } from '../disclosure/index.js'
import type { Fleet } from '../fleet/index.js'
import { ZOOM_STEP } from './camera.js'
import type { SceneQuality } from './marks/frame.js'
import { useScenePref } from '../app/panelPrefs.js'
import { readChoice, subscribeToPreferences } from '../settings/registry.js'
import { useResolvedMotion } from '../settings/apply.js'
import type { SceneGeometry } from './geometry.js'
import type { PulseField } from './pulses.js'
import { isRetired, type RetireRegistry } from './retire.js'
import type { SettleRegistry } from './settle.js'
import { useCamera } from './view/useCamera.js'
import { useDocumentTheme } from './view/useDocumentTheme.js'
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

/** The quality dial, straight off the preference registry (live per #574). */
function useSceneQuality(): SceneQuality {
  const [value, setValue] = useState<SceneQuality>(() => readChoice('appearance.sceneQuality') as SceneQuality)
  useEffect(
    () => subscribeToPreferences(() => setValue(readChoice('appearance.sceneQuality') as SceneQuality)),
    [],
  )
  return value
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
  /**
   * THE TYPE LAYER (ADR-0021) — a transparent 2D canvas over the WebGL2 one,
   * where `text`, `path` and `chip` are drawn because they have no cheap GPU
   * form. It is inert to the pointer: every gesture belongs to the canvas
   * underneath, which is the one d3-zoom is bound to and the one the hit test
   * measures against.
   */
  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const geometryRef = useRef<SceneGeometry | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  // The RESOLVED motion (settings/apply.ts): the stronger of the stored choice
  // and the system's request. Until loop 13 this component read only the raw
  // media query, so the settings control recorded a choice the picture ignored
  // — the gap the registry's own note confessed. `reduced` drops travel and
  // scale; `still` holds the whole picture the way the pause button does,
  // permanently, with the button disabled so the chrome tells the truth about
  // who is holding it.
  const motion = useResolvedMotion()
  const reducedMotion = motion !== 'full'
  const stilled = motion === 'still'
  const [paused, setPaused] = useState(false)
  const [hideFinished, setHideFinished] = useScenePref('hideFinished')
  const quality = useSceneQuality()
  const [failure, setFailure] = useState<string | null>(null)
  const [grabReady, setGrabReady] = useState(false)
  // The theme, off the document's own attribute — the seam `settings/apply.ts`
  // declares. This is how the picture follows the chrome onto paper (#551's
  // "pointing the marks at it" wave).
  const theme = useDocumentTheme()

  const latest = useRef<SceneLatestState>({
    fleet,
    field,
    settle,
    retire,
    selectedId,
    hoverId,
    reducedMotion,
    paused: paused || stilled,
    hideFinished,
    quality,
    theme,
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
    paused: paused || stilled,
    hideFinished,
    quality,
    theme,
    now,
    asOf,
    replaying,
  }

  const camera = useCamera(canvasRef, latest)
  const { lost, redraw, originRef } = useFrameLoop(
    hostRef,
    canvasRef,
    overlayRef,
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
   * makes the toggle testable against a still image. The theme is such a
   * preference too: a switch repaints the whole picture in the other palette.
   */
  useEffect(() => {
    redraw()
  }, [hideFinished, theme, motion, redraw])

  return (
    <div
      ref={hostRef}
      tabIndex={0}
      onKeyDown={(event) => onSceneKeyDown(event, { fit, home, step, setGrabReady })}
      onKeyUp={(event) => {
        if (event.key === ' ') setGrabReady(false)
      }}
      onBlur={() => setGrabReady(false)}
      className="relative h-full w-full overflow-hidden bg-(--surface-floor) focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-(--focus-ring)"
    >
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 h-full w-full ${cursorOf(grabReady, hoverId !== null)}`}
        onMouseMove={(event) =>
          setHoverId(
            pickAt(geometryRef.current, originRef.current, camera.cameraRef.current, event.clientX, event.clientY),
          )
        }
        onMouseLeave={() => setHoverId(null)}
        onClick={(event) =>
          onSelect(
            pickAt(geometryRef.current, originRef.current, camera.cameraRef.current, event.clientX, event.clientY),
          )
        }
      />
      <canvas ref={overlayRef} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />
      <MotionControl paused={paused || stilled} stilled={stilled} onToggle={() => setPaused((held) => !held)} />
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
          className="absolute inset-x-0 bottom-0 px-3 py-2 text-center text-inst-dense uppercase tracking-widest text-broken"
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
  /** The settings choice holds the picture; the button says so and yields. */
  stilled: boolean
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
/**
 * Exported for `SceneView.test.tsx` alone (#389).
 *
 * The `aria-disabled` guard ADR-0047 mandates lives in this handler, and at the
 * SceneView level it is **unobservable**: the call site passes
 * `paused={paused || stilled}`, so while `stilled` holds, toggling the
 * underlying `paused` changes nothing anyone can see. A test driven through
 * `SceneView` would therefore pass whether or not the guard exists — the
 * "test that cannot fail for the reason it claims" this repo keeps finding.
 * Rendering this component directly with a spy is what makes the guard's
 * absence go red.
 */
export function MotionControl({ paused, stilled, onToggle }: MotionControlProps) {
  return (
    <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-2">
      {/*
        ARIA-DISABLED, NOT DISABLED (#389, ADR-0047) — the stilled string exists
        precisely to explain why this control is unavailable, and a `disabled`
        button leaves the tab order, so that explanation is the one a keyboard
        could never reach. The guard is INSIDE the handler: an `aria-disabled`
        button still fires on Enter and Space, and guarding the pointer alone
        would let a keyboard invoke what the surface says is unavailable.
      */}
      <Disclosure trigger="inline" disclosure={motionDisclosure(stilled, paused)}>
      <button
        type="button"
        onClick={() => {
          if (stilled) return
          onToggle()
        }}
        aria-pressed={paused}
        aria-disabled={stilled}
        data-testid="scene-motion-pause"
        className={`pointer-events-auto rounded-none border px-2 py-1 text-inst-dense uppercase leading-none tracking-wide backdrop-blur-sm transition-[transform,color,border-color] duration-(--duration-touch) ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) active:scale-[0.97] ${
          paused
            ? 'border-(--ink-dim) bg-(--surface-raised)/90 text-(--ink-primary)'
            : 'border-(--line-hair) bg-(--surface-panel)/80 text-(--ink-dim) hover:border-(--ink-dim) hover:text-(--ink-primary)'
        }`}
      >
        {stilled ? 'Motion stilled' : paused ? 'Resume motion' : 'Pause motion'}
      </button>
      </Disclosure>
      {paused && (
        <span
          role="status"
          data-testid="scene-motion-state"
          className="text-inst-dense uppercase tracking-widest text-(--ink-body)"
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

  const button = (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={hidden}
      aria-hidden={!has}
      tabIndex={has ? 0 : -1}
      data-testid="scene-hide-finished"
      className={`pointer-events-auto rounded-none border px-2 py-1 text-inst-dense uppercase leading-none tracking-wide backdrop-blur-sm transition-[opacity,transform,color,border-color] duration-(--duration-touch) ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) active:scale-[0.97] ${
        has ? 'opacity-100' : 'pointer-events-none opacity-0'
      } ${
        hidden
          ? 'border-(--ink-dim) bg-(--surface-raised)/90 text-(--ink-primary)'
          : 'border-(--line-hair) bg-(--surface-panel)/80 text-(--ink-dim) hover:border-(--ink-dim) hover:text-(--ink-primary)'
      }`}
    >
      {`${hidden ? 'Show' : 'Hide'} finished · ${finished}`}
    </button>
  )

  return (
    <div className="pointer-events-none absolute right-2 top-2">
      {/*
        DISCLOSED ONLY WHILE THERE IS SOMETHING TO DISCLOSE (review of #419).
        This control fades rather than mounting — while nothing has finished it
        is `aria-hidden`, `tabIndex={-1}` and `opacity-0`, deliberately out of
        both the tab order and the accessibility tree. The inline trigger is a
        focusable `<span role="note" tabIndex={0}>` and carries no such
        condition, so wrapping unconditionally put a live tab stop around a
        control that is not there, opening a card whose every clause is false in
        that state. `replay/index.tsx`'s birth button gates the same way and for
        the same reason.
      */}
      {has ? (
        <Disclosure trigger="inline" disclosure={finishedDisclosure(hidden)}>
          {button}
        </Disclosure>
      ) : (
        button
      )}
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
        className={`pointer-events-auto rounded-none border border-(--line-strong) bg-(--surface-raised)/90 px-2 py-1 text-inst-dense uppercase tracking-wide text-(--ink-primary) backdrop-blur-sm transition-[opacity,transform] duration-200 ease-out hover:border-(--ink-dim) focus:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) active:scale-[0.97] ${
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
 *
 * **A shortcut hint is not a condition (#389).** This carried a native
 * `title=` reading `${label} (${hint})` — the accessible name it already had,
 * plus the keyboard key that performs it. It states nothing observed and
 * offers no remedy, so putting it through the disclosure vocabulary would have
 * meant manufacturing both, which is prd-30 S1's own "a card whose why has no
 * evidence in it". The hint is folded into the accessible name instead, where
 * a screen reader announces it and reaching it needs no hover at all.
 */
function CameraButton({ onClick, label, hint, children }: CameraButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label} (${hint})`}
      className="min-w-7 rounded-none border border-(--line-hair) bg-(--surface-panel)/80 px-1.5 py-1 text-inst-dense uppercase leading-none tracking-wide text-(--ink-dim) backdrop-blur-sm transition-[transform,color,border-color] duration-(--duration-touch) ease-out hover:border-(--ink-dim) hover:text-(--ink-primary) focus:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) active:scale-[0.97]"
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

/**
 * The scene's two chrome conditions (#389, prd-30 w4).
 *
 * Every `reason` below is the exact string of the native `title=` it retires —
 * ported, never reworded. The evidence and remedy the vocabulary requires are
 * written from what this surface already knows, in the register
 * `app/Nav.tsx`'s `disabledNavDisclosure` set: `elapsedMs: 0`, because each is
 * re-read from the settings registry or the render's own props every time the
 * control draws, and so is confirmed just now rather than dated.
 */
function motionDisclosure(stilled: boolean, paused: boolean): DisclosureContent {
  if (stilled) {
    return {
      label: 'motion stilled',
      why: {
        reason: 'Motion is stilled in settings — the control lives there',
        evidence: { fact: 'the stored motion level reads `still`, which holds the picture regardless of this control', elapsedMs: 0 },
      },
      remedy: { kind: 'action', action: 'change the motion level in Settings; this control follows it rather than overriding it' },
    }
  }

  return paused
    ? {
        label: 'resume motion',
        why: {
          reason: 'Let the scene move again',
          evidence: { fact: 'the scene is paused by this control, not by the settings choice', elapsedMs: 0 },
        },
        remedy: { kind: 'action', action: 'press it to let the picture move again' },
      }
    : {
        label: 'pause motion',
        why: {
          reason: 'Freeze the scene’s own motion',
          evidence: { fact: 'the scene is moving, and nothing in settings is holding it', elapsedMs: 0 },
        },
        remedy: { kind: 'action', action: 'press it to hold the picture still without changing your settings' },
      }
}

function finishedDisclosure(hidden: boolean): DisclosureContent {
  return hidden
    ? {
        label: 'show finished',
        why: {
          reason: 'Show the lanes that have finished — they are still in the fleet table either way',
          evidence: { fact: 'finished strands are hidden in the picture and present in the fold behind it', elapsedMs: 0 },
        },
        remedy: { kind: 'action', action: 'press it to draw the finished lanes back into the scene' },
      }
    : {
        label: 'hide finished',
        why: {
          reason: 'Hide the strands finished lanes leave behind',
          evidence: { fact: 'finished strands are drawn in the picture and can be cleared from it', elapsedMs: 0 },
        },
        remedy: { kind: 'action', action: 'press it to clear them from the picture; the fleet table still lists them' },
      }
}
