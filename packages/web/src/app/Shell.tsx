import { lazy, Suspense } from 'react'
import { ReplayBanner } from '../replay/Banner.js'
import { Welcome } from './Welcome.js'
import { ConnectionBadge } from './ConnectionBadge.js'
import { useIdleWorkerJump } from './keyboard.js'
import { useMode } from './ModeContext.js'
import { Nav } from './Nav.js'
import { PanelGrid } from './PanelGrid.js'
import { ReplayBar } from './ReplayBar.js'
import { StatusBar } from './StatusBar.js'
import { useStream } from './StreamContext.js'

const AttentionStrip = lazy(() => import('../panels/attention/index.js'))
const BurnStrip = lazy(() => import('../panels/burn/index.js'))
const LaneDrawer = lazy(() => import('../drawer/index.js'))

/**
 * The curated order — prd3 ruling 6, amended by prd4 ruling 2, again by prd-36
 * ruling 1 and prd-32 ruling 5, and **amended a fourth time on 2026-08-17 by
 * the walkthrough** (`docs/prds/done/prd-04-human-facing.md`, ruling 2's own
 * amendment). One conductor-curated hierarchy, no drag and no custom layouts —
 * the sequence itself is the ruling:
 *
 *   attention strip + burn strip (docked top)
 *     → fleet surface (the hero — organism or list, one keystroke apart)
 *       → the dock (spend · collisions · feed · trace, one at a time)
 *         → time dock + provenance bar (docked bottom)
 *
 * It reads top-to-bottom as the question and its answers: *does anything need
 * me* (attention), *what is it costing* (burn), *who is alive* (the fleet
 * surface, in whichever representation suits the moment), *what happened* (the
 * dock), *when* (the time dock), *where did this come from* (provenance).
 *
 * ## THE ROW TRACK IS `minmax(0, 1fr)`, AND THAT IS A REPAIR
 *
 * A human walked the running instrument at 164 lanes and found the fleet
 * showing three rows. The cause was here and in the scene's own slot: a grid row of
 * `1fr` has an implicit `min-height: auto`, so it never shrinks below its
 * content — but it also never *grows* to claim what the `auto` rows around it
 * leave. The scene carried a `min-h-[55vh]` floor nothing else had; every
 * sibling was freely shrinkable; and the two `auto` rows below (the time dock
 * and the provenance bar) took as much as they liked. All the shrinkage landed
 * on the roster, whose `overflow-auto` clipped it **silently** rather than
 * pushing back.
 *
 * `minmax(0, 1fr)` makes the middle row a real share of the viewport rather
 * than a floor: `PanelGrid` then divides that share between its two panels,
 * each of which scrolls inside itself. Nothing below the fold is a surprise,
 * because there is no fold — the page does not scroll, the panels do.
 *
 * ## The same bug, on the other axis
 *
 * "The page does not scroll" was only ever half-true here. The rows were
 * bounded by `minmax(0, 1fr)`; the single implicit COLUMN was not declared at
 * all, so it sized to `auto` — and a grid item's `min-width: auto` means one
 * over-wide descendant grows the track, the grid and the document past the
 * viewport. Measured in the running instrument at a 1225px viewport: a
 * `scrollWidth` of 1758px, 533px of horizontal PAGE scroll, which carries the
 * nav off the left edge. That is the paragraph above's own failure rotated
 * ninety degrees, in the same declaration, and it outlived the fix for the
 * vertical case because the vertical case was the one a human had noticed.
 *
 * `grid-cols-[minmax(0,1fr)]` bounds the column the way `minmax(0, 1fr)`
 * bounds the middle row. Content that cannot fit now has to yield or clip
 * inside a panel, which is the whole point: whitespace lives between panels,
 * never inside them (ruling 7), and overflow lives inside one, never in the
 * document.
 *
 * The lane peek (prd-36 ruling 2) sits outside that sequence on purpose: it is
 * not a rung of the hierarchy but a layer over it, opened by the one selection
 * and closed by Esc. It renders `null` whenever nothing is selected and is
 * `position: fixed` when it does render, so it is out of flow and adds no row
 * to the grid above — the curated order is unchanged whether it is open or not,
 * which is what "the fleet stays visible" means structurally.
 *
 * ## The replay banner is the real one now
 *
 * `replay/Banner.tsx` had existed, tested and fully token-lawful, since #83 —
 * and nothing imported it, because this file defined a duplicate inline stub
 * that said "#83" and offered no way out of replay. The walkthrough found the
 * duplication; the resolution is to mount the component that was already
 * finished and delete the stub, rather than the other way round. Deleting the
 * real one would have kept a placeholder with no timestamp, no session
 * identity, no unknown-era voice and no *exit to live* control.
 */
export function Shell() {
  // prd5 ruling 1+6: the idle-worker jump is page-global (see `keyboard.ts`'s
  // own comment on the split with #100's scene-scoped camera keys), so it is
  // mounted once here rather than by any one panel.
  useIdleWorkerJump()

  return (
    // `min-h-screen`, not `h-screen`, and `auto` rather than `minmax(0,1fr)`
    // on PanelGrid's own row (retuned live, 2026-08-24, at an operator's
    // explicit request): the page now grows to whatever the dock's content
    // needs and the DOCUMENT scrolls, rather than clamping every panel to a
    // fixed viewport share and scrolling each one internally. See
    // `PanelGrid.tsx`'s own comment for what this trades away — the
    // page-never-scrolls invariant existed to fix a real silent-clipping bug,
    // and this reverses it on purpose, not by accident.
    <div className="grid min-h-screen grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_auto_auto] bg-(--surface-floor) font-sans text-(--ink-body)">
      <TopDock />
      <PanelGrid />
      <ReplayBar />
      <StatusBar />
      <Suspense fallback={null}>
        <LaneDrawer />
      </Suspense>
      <Welcome />
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
    <header className="sticky top-0 z-(--z-header) flex flex-col gap-3 border-b border-(--line-hair) bg-(--surface-floor) px-3 pb-3">
      <Nav />
      <div className="panel-card flex items-stretch gap-4">
        <div className="flex shrink-0 items-center gap-3 px-4 py-2">
          <h1 className="font-display text-read-body font-semibold tracking-[0.25em] text-(--ink-primary) text-glow-calm">
            THE OBSERVATORY
          </h1>
          <ConnectionBadge status={status} />
        </div>
        <div className="min-w-0 flex-1 border-l border-(--line-hair)">
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

function StripFallback() {
  return <div className="h-9" />
}
