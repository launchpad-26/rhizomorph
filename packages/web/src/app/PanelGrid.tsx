import { lazy, Suspense } from 'react'
import { PanelFrame } from './PanelFrame.js'
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
 */

const FleetPanel = lazy(() => import('../panels/fleet/index.js'))
const LedgerPanel = lazy(() => import('../panels/ledger/index.js'))
const CollisionsPanel = lazy(() => import('../panels/collisions/index.js'))
const FeedPanel = lazy(() => import('../panels/feed/index.js'))

/** Panel ids, in curated order — what `panelPrefs` persists collapse state for. */
export const PANEL_IDS = ['fleet', 'ledger', 'collisions', 'feed'] as const

function PanelFallback() {
  return (
    <div className="h-full min-h-32 animate-pulse rounded-lg border border-ice-850 bg-ice-950" />
  )
}

export function PanelGrid() {
  return (
    <div className="flex min-h-0 flex-col gap-4 overflow-auto p-4">
      {/* Who is doing what — the densest surface, and the one the strip jumps into. */}
      <PanelFrame id="fleet" title="Fleet">
        <Suspense fallback={<PanelFallback />}>
          <FleetPanel />
        </Suspense>
      </PanelFrame>

      {/* The scene keeps its screen only by answering faster than the table
          above it (ruling 4), which is why it sits directly beneath it. */}
      <SceneSlot />

      {/* The rest: read after the first-second question has been answered. */}
      <div className="grid auto-rows-fr gap-4 lg:grid-cols-3">
        <PanelFrame id="ledger" title="Ledger">
          <Suspense fallback={<PanelFallback />}>
            <LedgerPanel />
          </Suspense>
        </PanelFrame>
        <PanelFrame id="collisions" title="Collisions">
          <Suspense fallback={<PanelFallback />}>
            <CollisionsPanel />
          </Suspense>
        </PanelFrame>
        <PanelFrame id="feed" title="Activity">
          <Suspense fallback={<PanelFallback />}>
            <FeedPanel />
          </Suspense>
        </PanelFrame>
      </div>
    </div>
  )
}
