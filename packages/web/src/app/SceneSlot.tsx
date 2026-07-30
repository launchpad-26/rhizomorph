import { lazy, Suspense, useState } from 'react'
import { ConnectionBadge } from './ConnectionBadge.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import { useStream } from './StreamContext.js'

const Scene = lazy(() => import('../scene/index.js'))

function SceneFallback() {
  return (
    <div className="flex h-full items-center justify-center text-xs uppercase tracking-widest text-slate-600">
      loading scene…
    </div>
  )
}

function SceneErrorFallback() {
  return (
    <div className="flex h-full items-center justify-center text-xs uppercase tracking-widest text-neon-magenta">
      scene unavailable — panels below are unaffected
    </div>
  )
}

export function SceneSlot() {
  const [collapsed, setCollapsed] = useState(false)
  const { status } = useStream()

  return (
    <section className="border-b border-void-line bg-void-raised">
      <header className="flex items-center justify-between px-4 py-2">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold tracking-widest text-neon-cyan text-glow-cyan">
            THE OBSERVATORY
          </h1>
          <ConnectionBadge status={status} />
        </div>
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="rounded border border-void-line px-2 py-1 text-xs uppercase tracking-wide text-slate-400 hover:border-neon-cyan hover:text-neon-cyan"
        >
          {collapsed ? 'Expand scene' : 'Collapse scene'}
        </button>
      </header>
      {!collapsed && (
        <div className="h-64">
          <ErrorBoundary fallback={<SceneErrorFallback />}>
            <Suspense fallback={<SceneFallback />}>
              <Scene />
            </Suspense>
          </ErrorBoundary>
        </div>
      )}
    </section>
  )
}
