import { lazy, Suspense } from 'react'
import { PanelFrame } from './PanelFrame.js'

const WorktreesPanel = lazy(() => import('../panels/worktrees/index.js'))
const CollisionsPanel = lazy(() => import('../panels/collisions/index.js'))
const TickerPanel = lazy(() => import('../panels/ticker/index.js'))
const SpendPanel = lazy(() => import('../panels/spend/index.js'))
const LedgerPanel = lazy(() => import('../panels/ledger/index.js'))

function PanelFallback() {
  return (
    <div className="h-full min-h-32 animate-pulse rounded-lg border border-void-line bg-void-raised" />
  )
}

export function PanelGrid() {
  return (
    <div className="grid flex-1 auto-rows-fr grid-cols-1 gap-4 overflow-auto p-4 lg:grid-cols-3">
      <PanelFrame id="worktrees" title="Worktrees">
        <Suspense fallback={<PanelFallback />}>
          <WorktreesPanel />
        </Suspense>
      </PanelFrame>
      <PanelFrame id="collisions" title="Collisions">
        <Suspense fallback={<PanelFallback />}>
          <CollisionsPanel />
        </Suspense>
      </PanelFrame>
      <PanelFrame id="ticker" title="Commit ticker">
        <Suspense fallback={<PanelFallback />}>
          <TickerPanel />
        </Suspense>
      </PanelFrame>
      <PanelFrame id="spend" title="Spend ticker">
        <Suspense fallback={<PanelFallback />}>
          <SpendPanel />
        </Suspense>
      </PanelFrame>
      <PanelFrame id="ledger" title="Ledger">
        <Suspense fallback={<PanelFallback />}>
          <LedgerPanel />
        </Suspense>
      </PanelFrame>
    </div>
  )
}
