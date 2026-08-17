import { lazy, Suspense, useState, type MouseEvent } from 'react'
import { FleetSurface } from '../fleet/FleetSurface.js'
import { useFleet } from '../fleet/index.js'
import { PanelFrame } from './PanelFrame.js'
import { usePanelCollapsed } from './panelPrefs.js'
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

/**
 * Panel ids, in curated order — what `panelPrefs` persists collapse state for.
 * `scene` is gone from this list because the scene is no longer a panel: it is
 * one of the fleet surface's two representations, and `fleet` is the row that
 * collapses, focuses and persists for both of them.
 *
 * `trace` was never in it and is now gone from the file entirely: prd9 B1a's
 * FOCUS TRACE was a panel with no address, reachable only from the drawer's own
 * `FOCUS ↗`, rendering a subset of what prd-31's run view shows. prd-36 ruling 2
 * cut it (#562) — `trace/FocusPanel.tsx` is deleted and `/lane/:handle` is where
 * a trace is read.
 */
export const PANEL_IDS = ['fleet', 'ledger', 'collisions', 'feed'] as const

function PanelFallback() {
  return (
    <div className="h-full min-h-32 animate-pulse rounded-lg border border-(--line-hair) bg-(--surface-panel)" />
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
    </div>
  )
}

/**
 * THE BALCONY POINTER (prd19 ruling 1, wave 3, #257) — "one quiet pointer from
 * the empty balcony", the one sentence ruling 1 grants an otherwise
 * panels-only grid. A real `<a href>`, modifier-aware like the drawer's own
 * open-run-view link (`drawer/index.tsx`'s `OpenRunView`), so ctrl/cmd/shift/
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
    <p className="px-1 text-read-floor text-(--ink-dim)">
      nothing is flowing yet — see{' '}
      <a
        href="/connect"
        onClick={onClick}
        className="focus-ring rounded text-(--ink-body) underline hover:text-(--ink-primary)"
      >
        Connect
      </a>
    </p>
  )
}
