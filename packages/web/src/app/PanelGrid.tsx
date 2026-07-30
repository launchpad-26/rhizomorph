import { lazy, Suspense } from 'react'

const WorktreesPanel = lazy(() => import('../panels/worktrees/index.js'))
const CollisionsPanel = lazy(() => import('../panels/collisions/index.js'))
const TickerPanel = lazy(() => import('../panels/ticker/index.js'))

function PanelFallback() {
  return (
    <div className="h-full min-h-32 animate-pulse rounded-lg border border-void-line bg-void-raised" />
  )
}

export function PanelGrid() {
  return (
    <div className="grid flex-1 auto-rows-fr grid-cols-1 gap-4 overflow-auto p-4 lg:grid-cols-3">
      <Suspense fallback={<PanelFallback />}>
        <WorktreesPanel />
      </Suspense>
      <Suspense fallback={<PanelFallback />}>
        <CollisionsPanel />
      </Suspense>
      <Suspense fallback={<PanelFallback />}>
        <TickerPanel />
      </Suspense>
    </div>
  )
}
