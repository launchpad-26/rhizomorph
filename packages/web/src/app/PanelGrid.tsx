import { lazy, Suspense, useState, type MouseEvent } from 'react'
import { FleetSurface } from '../fleet/FleetSurface.js'
import { useFleet } from '../fleet/index.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import { PanelFrame } from './PanelFrame.js'
import { useFocusRequest, usePanelCollapsed, usePanelFocus } from './panelPrefs.js'
import { navigate } from './router.js'
import { useStream } from './StreamContext.js'

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
 * prd3 ruling 6 also adds FOCUS: any one panel can expand to fill the view,
 * Esc or an explicit control restores the curated order. This
 * grid is the one place that knows about every panel at once, so it is the
 * coordinator — it tracks which single id is focused and tells every other
 * panel to get out of the way while that one fills the screen. Each
 * `PanelFrame` (and `FocusableTrace` below) still *decides* its own focused
 * state; this only listens and keeps the "one at a time" invariant.
 *
 * prd4 ruling 2 reordered this registry so the scene rendered first, with the
 * fleet table right after it as the legend/detail surface. prd-36 ruling 1
 * (#555) finishes that thought by merging them: they are no longer two rows in
 * this registry but ONE — `fleet`, the surface that owns both representations
 * (`fleet/FleetSurface.tsx`) and the toggle between them. The scene therefore
 * has no registry row of its own any more, no `FocusableScene` here and no
 * `SceneSlot` mount; `app/SceneSlot.tsx` is left in place unmounted, since
 * retiring it belongs to whoever owns this directory's chrome rather than to a
 * commit fenced to the merge.
 *
 * The curated order is one row shorter and otherwise unchanged: fleet (the
 * hero, either representation) → ledger, collisions, feed.
 */

const LedgerPanel = lazy(() => import('../panels/ledger/index.js'))
const CollisionsPanel = lazy(() => import('../panels/collisions/index.js'))
const FeedPanel = lazy(() => import('../panels/feed/index.js'))
const TraceFocusPanel = lazy(() => import('../trace/FocusPanel.js'))

/**
 * Panel ids, in curated order — what `panelPrefs` persists collapse state for.
 * `scene` is gone from this list because the scene is no longer a panel: it is
 * one of the fleet surface's two representations, and `fleet` is the row that
 * collapses, focuses and persists for both of them.
 */
export const PANEL_IDS = ['fleet', 'ledger', 'collisions', 'feed'] as const

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
  // Lifted here, not left to PanelFrame's own internal store, so the same
  // flag can also tell FeedPanel to draw its collapsed peek rather than
  // disappear (PanelFrame's controlled-collapse mode).
  const [feedCollapsed, setFeedCollapsed] = usePanelCollapsed('feed')
  const { state } = useStream()
  const fleet = useFleet()
  const foldIsEmpty = Object.keys(state.session.worktrees).length === 0 && fleet.lanes.length === 0

  const hiddenFor = (id: string) => focusedId !== null && focusedId !== id
  const onFocusChangeFor = (id: string) => (focused: boolean) => setFocusedId(focused ? id : null)

  return (
    <div className="flex min-h-0 flex-col gap-4 overflow-auto p-4 [scrollbar-gutter:stable]">
      {/* prd19 ruling 1's "one quiet pointer from the empty balcony": a
          pointer, not an interstitial — every panel below still renders (and
          draws its own existing empty state) exactly as it does once a
          worktree turns up. */}
      {foldIsEmpty ? <BalconyConnectPointer /> : null}

      {/* The centerpiece (prd4 ruling 2, merged by prd-36 ruling 1): "what is
          the fleet doing?" answered before anything else, hero-sized directly
          beneath the dock — as the organism or as the list, one keystroke
          apart. The frame's own collapse and focus chrome wraps the whole
          surface, so focusing it fills the view with whichever representation
          is up rather than with one of the two. */}
      <PanelFrame
        id="fleet"
        title="Fleet"
        hidden={hiddenFor('fleet')}
        onFocusChange={onFocusChangeFor('fleet')}
      >
        <FleetSurface />
      </PanelFrame>

      {/*
        The rest: read after the first-second question has been answered.
        Two-up rather than three below ~1400px (prd9 legibility): three dense
        panels squeezed into a laptop-width column was the "crowded" half of
        the operator's complaint, so the third column waits for room instead
        of shrinking to fit.
      */}
      <div className="grid auto-rows-fr gap-4 md:grid-cols-2 min-[1400px]:grid-cols-3">
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
          collapsed={feedCollapsed}
          onCollapsedChange={setFeedCollapsed}
        >
          <Suspense fallback={<PanelFallback />}>
            {/* Focusing a collapsed feed expands it for the duration, same as
                every other panel's own focus/collapse interaction. */}
            <FeedPanel collapsed={feedCollapsed && focusedId !== 'feed'} />
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
 * THE BALCONY POINTER (prd19 ruling 1, wave 3, #257) — "one quiet pointer from
 * the empty balcony", the one sentence ruling 1 grants an otherwise
 * panels-only grid. A real `<a href>`, modifier-aware like the drawer's own
 * open-page link (`drawer/index.tsx`'s `OpenPageLink`), so ctrl/cmd/shift/
 * middle-click still open `/connect` in a new tab and a plain click routes
 * through the same `navigate` the nav strip uses rather than a full reload.
 */
function BalconyConnectPointer() {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate('/connect')
  }

  return (
    <p className="px-1 text-xs text-ice-400">
      nothing is flowing yet — see{' '}
      <a href="/connect" onClick={onClick} className="text-ice-300 underline hover:text-ice-100">
        Connect
      </a>
    </p>
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
      <div className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]">
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
