import { lazy, Suspense } from 'react'

const ReplayControls = lazy(() => import('../replay/index.js'))

function ReplayBarFallback() {
  return <div className="h-10 border-t border-void-line bg-void-raised" />
}

export function ReplayBar() {
  return (
    <Suspense fallback={<ReplayBarFallback />}>
      <ReplayControls />
    </Suspense>
  )
}
