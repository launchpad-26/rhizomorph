import { lazy, Suspense } from 'react'

const ReplayControls = lazy(() => import('../replay/index.js'))

function ReplayBarFallback() {
  return <div className="h-10 border-t border-(--line-hair) bg-(--surface-panel)" />
}

export function ReplayBar() {
  return (
    <Suspense fallback={<ReplayBarFallback />}>
      <ReplayControls />
    </Suspense>
  )
}
