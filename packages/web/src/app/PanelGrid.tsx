import {
  lazy,
  Suspense,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { FleetSurface } from '../fleet/FleetSurface.js'
import { useFleet } from '../fleet/index.js'
import { SearchField } from '../panels/search/SearchField.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import { PanelFrame } from './PanelFrame.js'
import { useDockTab } from './panelPrefs.js'
import { navigate } from './router.js'
import { useStream } from './StreamContext.js'

/**
 * The panel registry, in the curated order (ruling 6). This file is the whole
 * of it: a panel is on the page because it is registered here, and the order it
 * appears in is the hierarchy the conductor ruled.
 *
 * prd3's dissolutions, applied here by the keystone (#75):
 *
 * - `worktrees` → the fleet table (#78 owns the replacement and deletes the old
 *   directory);
 * - `ticker` → the activity feed (#79);
 * - `spend` → the burn strip in the top dock, plus the ledger (#80, ruling 13).
 *
 * prd3 ruling 6 also adds FOCUS: any one panel can expand to fill the view,
 * Esc or an explicit control restores the curated order. This grid is the one
 * place that knows about every panel at once, so it is the coordinator — it
 * tracks which single id is focused and tells the other to get out of the way.
 * Each `PanelFrame` still *decides* its own focused state; this only listens
 * and keeps the "one at a time" invariant.
 *
 * ## TWO ROWS (prd-36 ruling 1, #555 · prd-32 ruling 5, #552)
 *
 * prd4 ruling 2 promoted the scene above the table it used to sit beneath.
 * prd-36 ruling 1 finished that by merging them into ONE row — `fleet`, the
 * surface that owns both representations (`fleet/FleetSurface.tsx`) and the
 * toggle between them.
 *
 * prd-32 ruling 5 does the same thing to what was left. The ledger, collisions
 * and the feed were three panels in a responsive grid **competing for vertical
 * space**: two-up below 1400px, three across above it, each one squeezed to
 * roughly a third of whatever the fleet did not take. They now consolidate into
 * one tabbable dock, full width, one thing at a time — an IA change and not a
 * restyle, which is why it is its own wave.
 *
 * So the curated order is two rows and reads top to bottom as the question and
 * its answers:
 *
 *   attention strip + burn strip (docked top)
 *     → the fleet surface (the hero — organism or list, one keystroke apart)
 *       → the dock (spend · collisions · feed · trace, one at a time)
 *         → replay bar + provenance bar (docked bottom)
 *
 * **The TIDE is not one of the tabs and never becomes one.** prd-13 ruling 1 is
 * respected in full and restated here because this is the file where breaking
 * it would be easy: the TIDE is the replay bar's body, mounted by
 * `replay/index.tsx` under `Shell`, and the moment it became a tab it would be
 * competing with the scene for the same reading. `PanelGrid.test.tsx` asserts
 * it — a law rather than a paragraph.
 *
 * **The fleet is not a tab either**, for the opposite reason: it merged into
 * the scene (prd-36), so it is the hero above this dock rather than one of the
 * things you switch between. prd-36's own non-goals say so.
 *
 * The lane peek (prd-36 ruling 2) sits outside the sequence on purpose: it is
 * not a rung of the hierarchy but a layer over it, opened by the one selection
 * and closed by Esc, `position: fixed` and out of flow — so the curated order is
 * unchanged whether it is open or not.
 */

const LedgerPanel = lazy(() => import('../panels/ledger/index.js'))
const CollisionsPanel = lazy(() => import('../panels/collisions/index.js'))
const FeedPanel = lazy(() => import('../panels/feed/index.js'))
const TracePanel = lazy(() => import('../panels/trace/index.js'))

/**
 * Panel ids, in curated order — what `panelPrefs` persists collapse state for,
 * and what a `PanelFrame` exists for.
 *
 * Two, since #552. `scene` left when the scene became a representation of
 * `fleet` rather than a panel (#555); `ledger`, `collisions` and `feed` left
 * when they became tabs of `dock` — a tab is never hidden (S3 forbids a hidden
 * empty tab outright), so they have no collapse state of their own to persist.
 * `trace` was never here at all: prd9 B1a's FOCUS TRACE was a panel with no
 * address, cut by prd-36 ruling 2 (#562), and the trace is a dock tab now.
 */
export const PANEL_IDS = ['fleet', 'dock'] as const

/**
 * THE DOCK'S TABS, in prd-32 S3's order: **spend · collisions · feed · trace**.
 *
 * The order is the ruling's, not a preference, and it is the same
 * question-and-answers shape the curated order above has: what is it costing
 * (spend) → what is about to hurt (collisions) → what happened (feed) → what
 * exactly did one lane do (trace). It narrows from the fleet to a single lane
 * as you move right.
 *
 * `id` is stored per repo (`appearance.dockTab`), so it is a stable identity
 * rather than a label: renaming what a tab is *called* must never move which
 * one a person had open.
 */
interface DockTab {
  readonly id: string
  readonly label: string
  readonly render: () => ReactNode
}

export const DOCK_TABS: readonly DockTab[] = [
  { id: 'spend', label: 'Spend', render: () => <LedgerPanel /> },
  { id: 'collisions', label: 'Collisions', render: () => <CollisionsPanel /> },
  { id: 'feed', label: 'Activity', render: () => <FeedPanel /> },
  { id: 'trace', label: 'Trace', render: () => <TracePanel /> },
]

function PanelFallback() {
  return (
    <div className="min-h-32 animate-pulse rounded-none border border-(--line-hair) bg-(--surface-panel)" />
  )
}

const FocusAttentionStrip = lazy(() => import('../panels/attention/index.js'))
const FocusBurnStrip = lazy(() => import('../panels/burn/index.js'))

export function PanelGrid() {
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const { state } = useStream()
  const fleet = useFleet()
  const foldIsEmpty = Object.keys(state.session.worktrees).length === 0 && fleet.lanes.length === 0

  const hiddenFor = (id: string) => focusedId !== null && focusedId !== id
  const onFocusChangeFor = (id: string) => (focused: boolean) => setFocusedId(focused ? id : null)

  /*
   * THE HERO KEEPS A FLOOR, THE DOCK GROWS WITH THE PAGE (retuned live,
   * 2026-08-24, at an operator's explicit request — reversing the walkthrough
   * fix below on purpose, not by accident).
   *
   * History, so the reversal is legible later: this was once `flex flex-col
   * gap-4 overflow-auto`, and at 164 lanes the fleet showed three rows. A flex
   * column of freely-shrinkable children hands every pixel of pressure to
   * whichever child has no floor, and that child's own `overflow-auto` then
   * clips it **silently** instead of pushing back — nothing on screen said a
   * single row was missing, let alone 161 of them. The fix was a bounded,
   * symmetric two-share GRID (`minmax(0, 7fr)` / `minmax(0, 3fr)`, later
   * retuned to 3:2) with `overflow-hidden` on the page, so neither side could
   * silently starve the other and every panel scrolled inside its own fixed
   * share instead.
   *
   * This asks for the opposite trade: the dock (spend/collisions/activity/
   * trace) should show its whole table without an internal scrollbar, and the
   * PAGE should grow and scroll instead. That is safe against the ORIGINAL
   * bug specifically because nothing is silently clipped any more — every row
   * is in the DOM and reachable by scrolling the document, which is the one
   * property the walkthrough's fix was actually protecting. What changes is
   * only the *mechanism*: document scroll instead of per-panel scroll.
   *
   * So: the hero keeps a bounded height (`minmax(420px, 55vh)` — 420px is the
   * same floor `prd-04`'s own comment names as the scene's zero-size
   * fallback, so the organism is never rasterised at a size CSS then
   * squashes), and the dock's row is `auto` — sized to its content, uncapped.
   * `PanelFrame`'s `h-full` on each still resolves correctly here: a
   * percentage height inside a CSS Grid row resolves against that row's own
   * computed size once the grid algorithm settles it, `auto` included, so
   * nothing needs to change there.
   *
   * Collapsing either panel is unaffected: a collapsed `PanelFrame` is
   * `self-start`, so it takes its header's height and its share goes to the
   * other track.
   */
  return (
    <div className="flex flex-col gap-2 p-4">
      {/* prd19 ruling 1's "one quiet pointer from the empty balcony": a
          pointer, not an interstitial — every panel below still renders (and
          draws its own existing empty state) exactly as it does once a
          worktree turns up.

          It sits OUTSIDE the two-share grid on purpose: it is one sentence, and
          giving it a track of its own would take a share of the viewport away
          from the fleet in order to say it. */}
      {foldIsEmpty ? <BalconyConnectPointer /> : null}

      <div className="grid grid-rows-[minmax(420px,55vh)_auto] gap-(--space-gutter)">
        {/* The centerpiece (prd4 ruling 2, merged by prd-36 ruling 1): "what is
            the fleet doing?" answered before anything else, hero-sized above
            the dock — as the organism or as the list, one keystroke apart. The
            frame's own collapse and focus chrome wraps the whole surface, so
            focusing it fills the view with whichever representation is up
            rather than with one of the two. */}
        <PanelFrame
          id="fleet"
          title="Fleet"
          hidden={hiddenFor('fleet')}
          onFocusChange={onFocusChangeFor('fleet')}
          focusHud={
            /* The deck keeps the interrupting facts (exhibition V): the SAME
               attention and burn strips the shell's header runs — re-hosted,
               never re-derived — so a summons or a spend spike is exactly as
               visible with the organism filling the glass as without. */
            <Suspense fallback={null}>
              <FocusAttentionStrip />
              <FocusBurnStrip />
            </Suspense>
          }
        >
          <FleetSurface />
        </PanelFrame>

        {/* The dock: read after the first-second question has been answered.
            One surface, full width, one thing at a time — where three panels
            used to be squeezed two-up or three-up into whatever the fleet
            left. */}
        <PanelFrame
          id="dock"
          title="Dock"
          hidden={hiddenFor('dock')}
          onFocusChange={onFocusChangeFor('dock')}
        >
          <Dock />
        </PanelFrame>
      </div>
    </div>
  )
}

/**
 * THE TABBABLE DOCK (prd-32 ruling 5 / S3, #552).
 *
 * Standard ARIA tabs with a **roving tabindex**: exactly one tab is in the
 * page's Tab order and Left/Right (plus Home/End) move focus and selection
 * together. Activation is automatic on arrow keys, which is the right choice
 * *here* specifically because every tab reads the fold — arrowing through costs
 * nothing, unlike a network-backed tab widget where it would fire four requests.
 *
 * **`Escape` is not handled and must not be.** S3 says so and the reason is
 * structural rather than stylistic: the dock is not a dialog, so it has no
 * dismissed state to return to, and Escape already means something specific
 * here — it clears the lane selection (closing the peek) and then leaves panel
 * focus. A dock that swallowed it would put a third meaning on one key and
 * break the one-way-out rule (prd3 ruling 6). This component adds no
 * `keydown` handling beyond the arrow and Home/End keys it actually consumes,
 * so Escape keeps bubbling untouched.
 *
 * **Every tab renders in every state, and none of them is hidden.** S3's first
 * "what would make it wrong" is *a tab hiding an empty state instead of voicing
 * it*, so the tab strip is fixed: four tabs, always, whatever the fold holds.
 * Each panel already speaks its own zero-with-evidence (the ledger's, the
 * collisions panel's, the feed's) and each is reached here unchanged — this
 * component adds a *fifth* state none of them could have had before, which is
 * the one below.
 */
export function Dock() {
  const [activeId, setActiveId] = useDockTab()
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>())

  // A stored id no tab answers to reads as the first tab rather than as a blank
  // dock — the same posture `settings/registry.ts`'s own `accept` takes. A
  // retired tab must not make the surface unopenable.
  const active = DOCK_TABS.find((tab) => tab.id === activeId) ?? (DOCK_TABS[0] as DockTab)

  const moveTo = (id: string) => {
    setActiveId(id)
    buttonRefs.current.get(id)?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = DOCK_TABS.findIndex((tab) => tab.id === active.id)
    if (index === -1) return

    if (event.key === 'ArrowRight') {
      event.preventDefault()
      moveTo((DOCK_TABS[(index + 1) % DOCK_TABS.length] as DockTab).id)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      moveTo((DOCK_TABS[(index - 1 + DOCK_TABS.length) % DOCK_TABS.length] as DockTab).id)
    } else if (event.key === 'Home') {
      event.preventDefault()
      moveTo((DOCK_TABS[0] as DockTab).id)
    } else if (event.key === 'End') {
      event.preventDefault()
      moveTo((DOCK_TABS[DOCK_TABS.length - 1] as DockTab).id)
    }
  }

  return (
    <section
      data-panel="dock"
      className="flex h-full flex-col rounded-none border border-(--line-hair) bg-(--surface-panel)"
    >
      <div
        role="tablist"
        aria-label="Dock"
        data-testid="dock-tabs"
        onKeyDown={onKeyDown}
        className="flex shrink-0 border-b border-(--line-hair) px-2"
      >
        {DOCK_TABS.map((tab) => {
          const selected = tab.id === active.id
          return (
            <button
              key={tab.id}
              ref={(el) => {
                if (el) buttonRefs.current.set(tab.id, el)
                else buttonRefs.current.delete(tab.id)
              }}
              type="button"
              role="tab"
              id={`dock-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={dockPanelId(tab.id)}
              tabIndex={selected ? 0 : -1}
              data-testid={`dock-tab-${tab.id}`}
              onClick={() => setActiveId(tab.id)}
              className={`focus-ring border-b-2 px-3 py-2 heading tracking-[0.16em] transition-colors duration-(--duration-touch) ease-out ${
                selected
                  ? 'border-(--ink-primary) text-(--ink-primary)'
                  : 'border-transparent text-(--ink-dim) hover:text-(--ink-body)'
              }`}
            >
              {tab.label}
            </button>
          )
        })}

        {/*
          THE ONE SEARCH (prd-31 ruling 4 / S3, #559) — chrome on the dock's own
          strip, never a panel (prd-13 ruling 1's standing refusal). It filters
          the feed and the trace beneath it and the conversation at
          `/lane/:handle`, all off one module store, so a query typed here is
          already in force when a person opens a run view.
        */}
        <div className="ml-auto flex items-center py-1 pl-2">
          <SearchField surface="dock" />
        </div>
      </div>

      <div
        role="tabpanel"
        id={dockPanelId(active.id)}
        aria-labelledby={`dock-tab-${active.id}`}
        data-dock-tab={active.id}
        className="flex flex-col p-3"
      >
        {/*
          S3's *error* state, and it is the one thing the dock adds that none of
          the four panels could have on its own: "the tab renders its honest-gap
          line and **the dock stays usable**". Keyed by tab id so a boundary that
          caught one tab's throw does not stay tripped over the next one — the
          failure being reported is that tab's, and a person must be able to
          arrow away from it to a working surface.
        */}
        <ErrorBoundary key={active.id} fallback={<TabErrorFallback label={active.label} />}>
          <Suspense fallback={<PanelFallback />}>{active.render()}</Suspense>
        </ErrorBoundary>
      </div>
    </section>
  )
}

/** `id` → the DOM id the active tab's panel carries, so `aria-controls`/`aria-labelledby` point at each other. */
export function dockPanelId(id: string): string {
  return `dock-tabpanel-${id}`
}

/** Law 12's voice: what is missing, what is unaffected, and what a person can still do. */
function TabErrorFallback({ label }: { label: string }) {
  return (
    <p
      role="status"
      data-testid="dock-tab-error"
      className="px-1 py-2 text-read-floor leading-snug text-broken"
    >
      {label.toUpperCase()} FAILED TO RENDER — this tab could not draw itself, so what it was going
      to say is unknown rather than empty. The other three tabs are unaffected: arrow or click to
      one of them, or reload to try this one again.
    </p>
  )
}

/**
 * THE BALCONY POINTER (prd19 ruling 1, wave 3, #257) — "one quiet pointer from
 * the empty balcony", the one sentence ruling 1 grants an otherwise
 * panels-only grid. A real `<a href>`, modifier-aware like the peek's own
 * open-run-view link (`drawer/index.tsx`'s `OpenRunView`), so ctrl/cmd/shift/
 * middle-click still open `/connect` in a new tab and a plain click routes
 * through the same `navigate` the nav strip uses rather than a full reload.
 */
function BalconyConnectPointer() {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate('/connect')
  }

  return (
    <p className="px-1 text-read-floor text-(--ink-dim)">
      nothing is flowing yet — see{' '}
      <a
        href="/connect"
        onClick={onClick}
        className="focus-ring rounded-none text-(--ink-body) underline hover:text-(--ink-primary)"
      >
        Connect
      </a>
    </p>
  )
}
