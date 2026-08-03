import { lazy, Suspense, useState } from 'react'
import { ErrorBoundary } from './ErrorBoundary.js'
import { PanelFrame } from './PanelFrame.js'
import { useFocusRequest, usePanelFocus } from './panelPrefs.js'
import { SceneSlot } from './SceneSlot.js'

/**
 * The panel registry, in the curated order (ruling 6). This file is the whole
 * of it: a panel is on the page because it is registered here, and the order it
 * appears in is the hierarchy the conductor ruled.
 *
 * prd3's dissolutions, applied here by the keystone (#75):
 *
 * - `worktrees` → the fleet table (#78 owns the replacement and deletes the old
 *   directory);
 * - `ticker` → the activity feed (#79);
 * - `spend` → the burn strip in the top dock, plus the ledger (#80, ruling 13).
 *
 * Those directories still exist and their own tests still pass; what changed is
 * that the shell no longer mounts them. Deregistering is this issue's job, so
 * that wave 2 lands contents into slots already in the right place.
 *
 * prd3 ruling 6 also adds FOCUS: any one panel (or the scene) can expand to
 * fill the view, Esc or an explicit control restores the curated order. This
 * grid is the one place that knows about every panel at once, so it is the
 * coordinator — it tracks which single id is focused and tells every other
 * panel to get out of the way while that one fills the screen. Each
 * `PanelFrame` (and `FocusableScene` below) still *decides* its own focused
 * state; this only listens and keeps the "one at a time" invariant.
 *
 * prd4 ruling 2 reorders this registry: the scene is the centerpiece now, so
 * it renders first — hero-sized, directly beneath the attention/burn dock —
 * with the fleet table right after it as the legend/detail surface, then the
 * rest (ledger, collisions, feed).
 */

const FleetPanel = lazy(() => import('../panels/fleet/index.js'))
const LedgerPanel = lazy(() => import('../panels/ledger/index.js'))
const CollisionsPanel = lazy(() => import('../panels/collisions/index.js'))
const FeedPanel = lazy(() => import('../panels/feed/index.js'))
const Scene = lazy(() => import('../scene/index.js'))
const TraceFocusPanel = lazy(() => import('../trace/FocusPanel.js'))

/**
 * Panel ids, in curated order — what `panelPrefs` persists collapse state
 * for. `scene` persists through the same store as the rest (prd4 ruling 2's
 * reconciliation, `SceneSlot`'s own `usePanelCollapsed('scene')`) even though
 * it isn't wrapped in a `<PanelFrame>` — see `FocusableScene`'s comment above
 * for why.
 */
export const PANEL_IDS = ['scene', 'fleet', 'ledger', 'collisions', 'feed'] as const

/** The id `PanelGrid` uses to track the scene's own focus alongside the rest. */
const SCENE_ID = 'scene'

/**
 * prd9 B1a's FOCUS TRACE (prd3 #85's mechanism, one more panel). Not in
 * {@link PANEL_IDS}: that list is specifically the collapse-persistence ids
 * (`usePanelCollapsed`), and trace has no collapsed state to persist — it has
 * no inline presence in the curated order at all, only a focused one, opened
 * from the drawer's own `FOCUS ↗` rather than a button drawn here.
 */
const TRACE_ID = 'trace'

function PanelFallback() {
  return (
    <div className="h-full min-h-32 animate-pulse rounded-lg border border-ice-850 bg-ice-950" />
  )
}

export function PanelGrid() {
  const [focusedId, setFocusedId] = useState<string | null>(null)

  const hiddenFor = (id: string) => focusedId !== null && focusedId !== id
  const onFocusChangeFor = (id: string) => (focused: boolean) => setFocusedId(focused ? id : null)

  return (
    <div className="flex min-h-0 flex-col gap-4 overflow-auto p-4">
      {/* The centerpiece (prd4 ruling 2): "what is the fleet doing?" answered
          before anything else, hero-sized directly beneath the dock. */}
      <FocusableScene hidden={hiddenFor(SCENE_ID)} onFocusChange={onFocusChangeFor(SCENE_ID)} />

      {/* Who is doing what — the scene's own legend and the densest surface,
          right beneath the picture it explains. */}
      <PanelFrame
        id="fleet"
        title="Fleet"
        hidden={hiddenFor('fleet')}
        onFocusChange={onFocusChangeFor('fleet')}
      >
        <Suspense fallback={<PanelFallback />}>
          <FleetPanel />
        </Suspense>
      </PanelFrame>

      {/* The rest: read after the first-second question has been answered. */}
      <div className="grid auto-rows-fr gap-4 lg:grid-cols-3">
        <PanelFrame
          id="ledger"
          title="Ledger"
          hidden={hiddenFor('ledger')}
          onFocusChange={onFocusChangeFor('ledger')}
        >
          <Suspense fallback={<PanelFallback />}>
            <LedgerPanel />
          </Suspense>
        </PanelFrame>
        <PanelFrame
          id="collisions"
          title="Collisions"
          hidden={hiddenFor('collisions')}
          onFocusChange={onFocusChangeFor('collisions')}
        >
          <Suspense fallback={<PanelFallback />}>
            <CollisionsPanel />
          </Suspense>
        </PanelFrame>
        <PanelFrame
          id="feed"
          title="Activity"
          hidden={hiddenFor('feed')}
          onFocusChange={onFocusChangeFor('feed')}
        >
          <Suspense fallback={<PanelFallback />}>
            <FeedPanel />
          </Suspense>
        </PanelFrame>
      </div>

      {/* No inline slot: focused only, requested from the drawer's TRACE
          section rather than a button in this grid — see `FocusableTrace`. */}
      <FocusableTrace hidden={hiddenFor(TRACE_ID)} onFocusChange={onFocusChangeFor(TRACE_ID)} />
    </div>
  )
}

/**
 * FOCUS TRACE's own chrome (prd3 #85, applied to prd9's gantt). Unlike every
 * other panel here it draws nothing when unfocused — the compact tree already
 * lives in the drawer, so the curated order gains no new row for it — and it
 * is never focused by a button of its own: `useFocusRequest` is what the
 * drawer's `FOCUS ↗` reaches, the same `usePanelFocus` every other panel
 * already answers Esc and "one at a time" through.
 */
function FocusableTrace({
  hidden,
  onFocusChange,
}: {
  hidden: boolean
  onFocusChange: (focused: boolean) => void
}) {
  const { focused, focus, restore } = usePanelFocus(onFocusChange)
  useFocusRequest(TRACE_ID, focus)

  if (hidden || !focused) return null

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-ice-1000 p-4">
      <div className="mb-1 flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-ice-400">Trace</h2>
        <button
          type="button"
          aria-pressed={true}
          onClick={restore}
          className="rounded border border-ice-850 px-2 py-0.5 text-[10px] uppercase tracking-wide text-ice-400 hover:border-ice-600 hover:text-ice-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ice-600"
        >
          Restore Trace
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ErrorBoundary fallback={<TraceErrorFallback />}>
          <Suspense fallback={<PanelFallback />}>
            <TraceFocusPanel />
          </Suspense>
        </ErrorBoundary>
      </div>
    </div>
  )
}

/** Law 12's voice even here: what is missing, and what is unaffected by it. */
function TraceErrorFallback() {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-xs uppercase tracking-widest text-broken">
      trace unavailable — other panels are unaffected
    </div>
  )
}

/**
 * The scene's own focus affordance. It cannot simply be a `<PanelFrame>`
 * wrapping `<SceneSlot>`: `SceneSlot` carries its own header and collapse
 * chrome (a `<PanelFrame>` would double it up), and even hero-sized (prd4
 * ruling 2's `min-h-[55vh]`) it is still one embedded panel among others, not
 * the full viewport focus needs to break out to. So the focused view mounts
 * the scene directly (the same lazy `../scene/index.js` `SceneSlot` itself
 * loads) inside a full-viewport host instead of reusing that chrome. The
 * canvas already resizes to whatever host it is given (`SceneView`'s own
 * `ResizeObserver`) and lays out from the host's measured width/height rather
 * than a fixed aspect ratio, so handing it a taller box does not distort it —
 * it draws more network, not a stretched one.
 */
function FocusableScene({
  hidden,
  onFocusChange,
}: {
  hidden: boolean
  onFocusChange: (focused: boolean) => void
}) {
  const { focused, focus, restore } = usePanelFocus(onFocusChange)

  if (hidden) return null

  if (!focused) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex justify-end px-1">
          <button
            type="button"
            aria-pressed={false}
            onClick={focus}
            className="rounded border border-ice-850 px-2 py-0.5 text-[10px] uppercase tracking-wide text-ice-400 hover:border-ice-600 hover:text-ice-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ice-600"
          >
            Focus Scene
          </button>
        </div>
        <SceneSlot />
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-ice-1000 p-4">
      <div className="mb-1 flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-ice-400">Scene</h2>
        <button
          type="button"
          aria-pressed={true}
          onClick={restore}
          className="rounded border border-ice-850 px-2 py-0.5 text-[10px] uppercase tracking-wide text-ice-400 hover:border-ice-600 hover:text-ice-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ice-600"
        >
          Restore Scene
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <ErrorBoundary fallback={<SceneErrorFallback />}>
          <Suspense fallback={<SceneFallback />}>
            <Scene />
          </Suspense>
        </ErrorBoundary>
      </div>
    </div>
  )
}

function SceneFallback() {
  return (
    <div className="flex h-full items-center justify-center text-xs uppercase tracking-widest text-ice-400">
      loading scene…
    </div>
  )
}

/** Law 12's voice even here: what is missing, and what is unaffected by it. */
function SceneErrorFallback() {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-xs uppercase tracking-widest text-broken">
      scene unavailable — panels are unaffected
    </div>
  )
}
