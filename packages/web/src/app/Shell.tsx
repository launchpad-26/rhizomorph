import { lazy, Suspense, type MouseEvent } from 'react'
import { ConnectionBadge } from './ConnectionBadge.js'
import { useIdleWorkerJump } from './keyboard.js'
import { useMode } from './ModeContext.js'
import { PanelGrid } from './PanelGrid.js'
import { navigate } from './router.js'
import { ReplayBar } from './ReplayBar.js'
import { StatusBar } from './StatusBar.js'
import { useStream } from './StreamContext.js'

const AttentionStrip = lazy(() => import('../panels/attention/index.js'))
const BurnStrip = lazy(() => import('../panels/burn/index.js'))
const LaneDrawer = lazy(() => import('../drawer/index.js'))

/**
 * The curated order — prd3 ruling 6, amended by prd4 ruling 2. One
 * conductor-curated hierarchy, no drag and no custom layouts — the sequence
 * itself is the ruling:
 *
 *   attention strip + burn strip (docked top)
 *     → scene (the hero — ruling 2's centerpiece)
 *       → fleet table (legend/detail beneath it)
 *         → the rest (ledger, collisions, feed)
 *           → provenance bar (docked bottom)
 *
 * prd4 ruling 2 answers "what is the fleet doing?" before anything else: the
 * scene is big, bright and self-explanatory on the #92 palette, so it now
 * outranks the table it used to sit beneath — the table and the detail panels
 * are reference instruments once that first question is answered. It reads
 * top-to-bottom as that question and its answers: *does anything need me*
 * (attention), *what is it costing* (burn), *what does it look like* (scene),
 * *who is doing what* (fleet, the legend), *what happened* (the rest),
 * *where did this come from* (provenance).
 *
 * Whitespace lives between panels, never inside them (ruling 7).
 *
 * The lane drawer (ruling 17, #84) sits outside that sequence on purpose: it is
 * not a rung of the hierarchy but a layer over it, opened by the one selection
 * and closed by Esc. It renders `null` whenever nothing is selected and is
 * `position: fixed` when it does render, so it is out of flow and adds no row
 * to the grid above — the curated order is unchanged whether it is open or not,
 * which is what "the fleet stays visible" means structurally.
 */
export function Shell() {
  // prd5 ruling 1+6: the idle-worker jump is page-global (see `keyboard.ts`'s
  // own comment on the split with #100's scene-scoped camera keys), so it is
  // mounted once here rather than by any one panel.
  useIdleWorkerJump()

  return (
    <div className="grid h-screen grid-rows-[auto_1fr_auto_auto] bg-ice-1000 font-sans text-ice-300">
      <TopDock />
      <PanelGrid />
      <ReplayBar />
      <StatusBar />
      <Suspense fallback={null}>
        <LaneDrawer />
      </Suspense>
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
      <NavStrip />
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
 * THE PRIMARY NAV (#229) — one link per constitutional hand (observer /
 * recorder / laboratory, prd12+prd16 ruling 2+prd14), so the trust model is
 * visible rather than a documentation claim. `/lab` and `/recordings` were
 * routable but had no anchor anywhere in the UI — a stranger could not find
 * them without being told the URL. This is that anchor: real `<a href>`s,
 * modifier-aware like the drawer's own open-page link (`drawer/index.tsx`'s
 * `OpenPageLink`), routed through the hand-rolled router's `pushState` on a
 * plain click rather than a full reload.
 *
 * The balcony only ever mounts for the `balcony` route (see `App.tsx`'s route
 * switch), so within `Shell` "Observatory" is always the active link — no
 * `useRoute()` needed here to know that.
 */
const HANDS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/', label: 'Observatory' },
  { href: '/recordings', label: 'Recordings' },
  { href: '/lab', label: 'Lab' },
]

function NavStrip() {
  return (
    <nav aria-label="Primary" className="flex shrink-0 gap-1 border-b border-ice-850 px-4">
      {HANDS.map((hand) => (
        <NavLink key={hand.href} href={hand.href} label={hand.label} active={hand.href === '/'} />
      ))}
    </nav>
  )
}

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(href)
  }

  return (
    <a
      href={href}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      data-testid={`nav-${label.toLowerCase()}`}
      className={`border-b-2 px-2.5 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] transition-colors duration-150 ease-out ${
        active ? 'border-ice-200 text-ice-100' : 'border-transparent text-ice-400 hover:text-ice-200'
      }`}
    >
      {label}
    </a>
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
      <span className="figures text-[11px] normal-case tracking-normal text-ice-400">#83</span>
      <span className="normal-case tracking-normal text-ice-400">
        this is the past — exit to live below
      </span>
    </div>
  )
}

function StripFallback() {
  return <div className="h-9" />
}
