import { lazy, Suspense } from 'react'

const ReplayControls = lazy(() => import('../replay/index.js'))

function ReplayBarFallback() {
  return <div className="h-10 border-t border-ice-850 bg-ice-950" />
}

export function ReplayBar() {
  return (
    <Suspense fallback={<ReplayBarFallback />}>
      <ReplayControls />
    </Suspense>
  )
}
