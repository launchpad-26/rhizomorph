import { lazy, Suspense, useState } from 'react'
import { ErrorBoundary } from './ErrorBoundary.js'

const Scene = lazy(() => import('../scene/index.js'))

/**
 * The scene's slot in the curated order: directly beneath the fleet table,
 * because it keeps its screen only by answering the same questions faster
 * (ruling 4).
 *
 * It stays behind a lazy boundary *and* an error boundary: if three.js falls
 * over, the panels around it are unaffected and the demo survives
 * (architecture.md). The wordmark and connection badge that used to live in
 * this header moved to the top dock when the shell was reordered — the scene is
 * a panel now, not the page's masthead.
 *
 * **#81 owns what is drawn inside it** (the mycelium, in the ice-neon
 * register); this file owns only where it sits and how it fails.
 */
export function SceneSlot() {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <section className="rounded-lg border border-ice-850 bg-ice-950" data-panel="scene">
      <header className="flex items-center justify-between px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-ice-400">Scene</h2>
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="rounded border border-ice-850 px-2 py-1 text-[10px] uppercase tracking-wide text-ice-400 hover:border-ice-600 hover:text-ice-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ice-600"
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

function SceneFallback() {
  return (
    <div className="flex h-full items-center justify-center text-xs uppercase tracking-widest text-ice-600">
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
