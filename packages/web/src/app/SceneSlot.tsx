import { lazy, Suspense } from 'react'
import { ErrorBoundary } from './ErrorBoundary.js'
import { usePanelCollapsed } from './panelPrefs.js'

const Scene = lazy(() => import('../scene/index.js'))

/** The persisted-prefs id this slot's own collapse toggle reads and writes. */
const SCENE_ID = 'scene'

/**
 * The scene's slot in the curated order: prd4 ruling 2 makes it the
 * centerpiece, directly beneath the attention/burn dock and hero-sized — big
 * enough to answer "what is the fleet doing?" on its own, judged against a
 * real viewport rather than a fixed box (`min-h-[55vh]`-ish, not `h-64`). The
 * fleet table moves below it as the legend/detail surface.
 *
 * It stays behind a lazy boundary *and* an error boundary: if three.js falls
 * over, the panels around it are unaffected and the demo survives
 * (architecture.md). The wordmark and connection badge that used to live in
 * this header moved to the top dock when the shell was reordered — the scene is
 * a panel now, not the page's masthead.
 *
 * The collapse toggle reads and writes `usePanelCollapsed('scene')` — the same
 * persisted store every `<PanelFrame>` uses — rather than its own local state.
 * The two used to disagree (this slot forgot its collapsed state on reload,
 * every other panel remembered); prd4 ruling 2 reconciles them into the one
 * mechanism. Focus stays a mechanism of its own (`FocusableScene` in
 * `PanelGrid`, not this file) because it needs to break out to a full-viewport
 * host, which this slot's own chrome cannot offer.
 *
 * **#81 owns what is drawn inside it** (the mycelium, in the ice-neon
 * register); this file owns only where it sits, how big it is, and how it
 * fails.
 */
export function SceneSlot() {
  const [collapsed, setCollapsed] = usePanelCollapsed(SCENE_ID)

  return (
    <section className="flex flex-col rounded-lg border border-ice-850 bg-ice-950" data-panel="scene">
      <header className="flex shrink-0 items-center justify-between px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-ice-400">Scene</h2>
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          className="rounded border border-ice-850 px-2 py-1 text-[10px] uppercase tracking-wide text-ice-400 hover:border-ice-600 hover:text-ice-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ice-600"
        >
          {collapsed ? 'Expand scene' : 'Collapse scene'}
        </button>
      </header>
      {!collapsed && (
        <div className="min-h-[55vh] flex-1">
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
