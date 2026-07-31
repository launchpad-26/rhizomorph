import { lazy, Suspense } from 'react'
import { ConnectionBadge } from './ConnectionBadge.js'
import { useMode } from './ModeContext.js'
import { PanelGrid } from './PanelGrid.js'
import { ReplayBar } from './ReplayBar.js'
import { StatusBar } from './StatusBar.js'
import { useStream } from './StreamContext.js'

const AttentionStrip = lazy(() => import('../panels/attention/index.js'))
const BurnStrip = lazy(() => import('../panels/burn/index.js'))

/**
 * The curated order (ruling 6). One conductor-curated hierarchy, no drag and no
 * custom layouts — the sequence itself is the ruling:
 *
 *   attention strip + burn strip (docked top)
 *     → fleet table
 *       → scene
 *         → the rest (ledger, collisions, feed)
 *           → provenance bar (docked bottom)
 *
 * It reads top-to-bottom as the first-second question and its answers: *does
 * anything need me* (attention), *what is it costing* (burn), *who is doing
 * what* (fleet), *what does it look like* (scene), *what happened* (the rest),
 * *where did this come from* (provenance).
 *
 * Whitespace lives between panels, never inside them (ruling 7).
 */
export function Shell() {
  return (
    <div className="grid h-screen grid-rows-[auto_1fr_auto_auto] bg-ice-1000 font-sans text-ice-300">
      <TopDock />
      <PanelGrid />
      <ReplayBar />
      <StatusBar />
    </div>
  )
}

/**
 * The always-present dock. In replay it is a different bar entirely (ruling 16:
 * replay is a full mode shift, not a tinted live view), which is why the
 * attention strip and the replay banner are mutually exclusive here rather than
 * stacked — an operator must never be able to read a live summons off a
 * recording.
 */
function TopDock() {
  const mode = useMode()
  const { status } = useStream()

  return (
    <header className="border-b border-ice-850 bg-ice-950">
      <div className="flex items-stretch gap-4 border-b border-ice-850">
        <div className="flex shrink-0 items-center gap-3 px-4">
          <h1 className="font-display text-sm font-semibold tracking-[0.25em] text-ice-100 text-glow-calm">
            THE OBSERVATORY
          </h1>
          <ConnectionBadge status={status} />
        </div>
        <div className="min-w-0 flex-1">
          {mode === 'replay' ? (
            <ReplayBanner />
          ) : (
            <Suspense fallback={<StripFallback />}>
              <AttentionStrip />
            </Suspense>
          )}
        </div>
      </div>
      <Suspense fallback={<StripFallback />}>
        <BurnStrip />
      </Suspense>
    </header>
  )
}

/**
 * The REPLAY banner slot (ruling 16). Stubbed here by the keystone so the mode
 * switch is structural from wave 1 — **#83 owns what it says, and the distinct
 * frame and tint around it.** The part that matters already holds: in replay
 * the attention strip is *replaced*, never decorated.
 *
 * Note for #83: a mode is not a status, so the banner may not reach for a
 * ladder hue (law 9). An amber REPLAY bar would make a recording of a calm
 * night read as a summons. The mode shift is carried by luminance, inversion
 * and frame instead — which is the whole point of the ice register.
 */
function ReplayBanner() {
  return (
    <div
      role="status"
      data-panel="replay-banner"
      className="flex h-9 items-center gap-3 bg-ice-900 px-4 text-xs uppercase tracking-[0.2em] text-ice-100"
    >
      <span className="font-semibold">Replay</span>
      <span className="figures text-[11px] normal-case tracking-normal text-ice-500">#83</span>
      <span className="normal-case tracking-normal text-ice-400">
        this is the past — exit to live below
      </span>
    </div>
  )
}

function StripFallback() {
  return <div className="h-9" />
}
