import { useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { selectLaneTouches } from '@rhizomorph/core'
import { useFocusRequest } from '../app/panelPrefs.js'
import { laneUrl, navigate } from '../app/router.js'
import { useStream } from '../app/StreamContext.js'
import { isMainSelected, MAIN_SELECTION, useFleet, useSelection } from '../fleet/index.js'
import type { FetchLike } from '../fleet/manifest.js'
import { selectLaneInteractionViews } from '../trace/model.js'
import { WhySurface } from '../why/index.js'
import { ActivityView } from './Activity.js'
import { AttachButton, type CopyText } from './AttachButton.js'
import { Conversation } from './Conversation.js'
import { TabBar, tabPanelId, type DrawerTab, type TabId } from './Tabs.js'
import { TraceSection } from './Trace.js'
import { MainVitals, Vitals } from './Vitals.js'
import { foldActivity } from './activity.js'
import { attachPlan, conductorAttachPlan } from './attach.js'

/**
 * THE LANE DRAWER (prd3 ruling 17) — chat at a click.
 *
 * Click a lane anywhere (strip chip, table row, scene node — they all write the
 * one selection) and it opens on the right. The fleet stays visible: this is a
 * drawer, not a page, because the reason you opened it was something you saw in
 * the fleet and you must be able to keep seeing it. Esc closes, via the same
 * global handler that clears the selection for every other surface — there is
 * one way out of a narrowed view (ruling 6).
 *
 * Top to bottom: **vitals** (the row you just clicked, opened out — never
 * hides, ruling 17), **tabs** — CONVERSATION, ACTIVITY, WHY, TRACE, one body
 * at a time, each getting the whole drawer's remaining height — and
 * **attach** (the command to go and talk to it in your own terminal).
 *
 * **Tabs, not four boxes with their own caps (#163).** prd4 ruling 4 stacked
 * conversation/activity/why/trace as independently-scrolling, height-capped
 * sections; the operator's 2026-08-04 review of the live drawer ruled that
 * structure itself cramped and occluded — four fixed caps claimed more than a
 * 1080p viewport before conversation got anything. One tab at a time, full
 * height, is the fix. Losing the ability to see a commit and its WHY chain
 * side by side is the named cost of that move; `WhySurface`'s own
 * `onJumpToActivity` and this file's `useFocusRequest('trace', …)` (the same
 * channel #159's ledger exemplar jump already calls) are how causality still
 * reaches across a tab boundary in one click instead of vanishing behind one.
 *
 * The read-only constitution holds absolutely and structurally: the only
 * network call anywhere in this directory is `GET /api/transcript/:lane`, and
 * the only way to interact with an agent is a string on your clipboard.
 *
 * **MAIN opens the same drawer (prd6 ruling 5).** The root-mass was the one
 * thing on screen an operator could not click, and the conductor was the one
 * agent whose conversation they could not read. Clicking the mass selects
 * `MAIN_SELECTION` and this drawer answers with the orchestrator's own session
 * — the same frame, the same vitals grid, the same `Conversation`, the same
 * copies-never-executes ATTACH. It is deliberately not a second panel: the
 * conductor is another agent working in this repo, and the operator has already
 * learned where to read one.
 */

export interface LaneDrawerProps {
  /** Test seam for the conversation's `fetch`. */
  fetchTranscript?: FetchLike
  /** Test seam: `0` reads the conversation once and never polls. */
  transcriptPollMs?: number
  /** Test seam for the clipboard. */
  onCopy?: CopyText
}

export default function LaneDrawer({ fetchTranscript, transcriptPollMs, onCopy }: LaneDrawerProps = {}) {
  const { selectedId, clear } = useSelection()
  const fleet = useFleet()
  const { state } = useStream()

  const main = isMainSelected(selectedId)
  const lane =
    selectedId === null || main ? null : (fleet.lanes.find((l) => l.id === selectedId) ?? null)

  const entries = useMemo(
    () => (lane === null ? [] : foldActivity(state.events, lane)),
    [state.events, lane],
  )
  const plan = useMemo(() => (lane === null ? null : attachPlan(state.events, lane)), [state.events, lane])
  const mainPlan = useMemo(
    () => (main ? conductorAttachPlan(state.events, fleet.root) : null),
    [main, state.events, fleet.root],
  )

  // The one telemetry handle this lane answers to (or null, spanning more than
  // one) — computed here, not just inside `WhySurface`, because the WHY tab's
  // own count needs it too and the two must never disagree.
  const laneHandle = lane === null ? null : lane.handles.length === 1 ? lane.handles[0]! : null
  const touches = useMemo(
    () => (laneHandle === null ? [] : selectLaneTouches(state.session, laneHandle)),
    [state.session, laneHandle],
  )
  const traceViews = useMemo(
    () => (lane === null ? [] : selectLaneInteractionViews(state.session, lane.id)),
    [state.session, lane],
  )

  const [activeTab, setActiveTab] = useState<TabId>('conversation')
  const [activityHighlight, setActivityHighlight] = useState<string | null>(null)

  /**
   * A new lane defaults to CONVERSATION — but not when the reason the drawer
   * is opening on it is #159's own exemplar jump, which asks for TRACE by name
   * (`select(laneId)` then `requestPanelFocus('trace')`, fired back to back in
   * the same handler). Both land in the same React batch, so this is decided
   * here, in render, rather than in an effect: an effect keyed on `selectedId`
   * would run after `useFocusRequest`'s listener has already asked for TRACE
   * and clobber it back to CONVERSATION. `traceFocusPendingRef` is the flag
   * that lets this render see "a trace focus request landed with this very
   * selection change" — read and cleared every render, not just when the
   * lane-change branch below fires, so a request against a lane already open
   * never leaks into the *next*, unrelated lane change.
   */
  const prevSelectedIdRef = useRef(selectedId)
  const traceFocusPendingRef = useRef(false)
  if (prevSelectedIdRef.current !== selectedId) {
    prevSelectedIdRef.current = selectedId
    if (!traceFocusPendingRef.current) {
      setActiveTab('conversation')
      setActivityHighlight(null)
    }
  }
  traceFocusPendingRef.current = false

  useFocusRequest('trace', () => {
    traceFocusPendingRef.current = true
    setActiveTab('trace')
  })

  const selectTab = (id: TabId) => {
    setActiveTab(id)
    if (id !== 'activity') setActivityHighlight(null)
  }

  /** WHY's own navigation across the tab boundary (#163) — the file stays on screen, just in ACTIVITY's own reading of it. */
  const jumpToActivity = (path: string) => {
    setActivityHighlight(path)
    setActiveTab('activity')
  }

  const tabs: DrawerTab[] = [
    { id: 'conversation', label: 'Conversation', count: null },
    { id: 'activity', label: 'Activity', count: entries.length === 0 ? '—' : String(entries.length) },
    {
      id: 'why',
      label: 'Why',
      count:
        laneHandle === null || touches.length === 0
          ? '—'
          : `${touches.length} file${touches.length === 1 ? '' : 's'}`,
    },
    { id: 'trace', label: 'Trace', count: traceViews.length === 0 ? '—' : String(traceViews.length) },
  ]

  if (selectedId === null) return null

  if (main && mainPlan !== null) {
    return (
      <DrawerFrame
        selectedId={selectedId}
        label="Main — the conductor"
        onClose={clear}
        title={
          <h2 className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-xs font-semibold uppercase tracking-[0.2em] text-ice-100">
              Main
            </span>
            <span
              data-testid="drawer-main-branch"
              className={`min-w-0 truncate font-mono text-[11px] text-ice-400 ${
                fleet.root.mainBranch === null ? 'italic' : ''
              }`}
            >
              {fleet.root.mainBranch ?? 'no main branch on record'}
            </span>
          </h2>
        }
      >
        <MainVitals fleet={fleet} />
        {/*
          The conductor's own session, in the same component a lane's turns are
          read in — forked prose would be a second answer to "what does a turn
          look like", and the drawer only gets to have one. `main` is the
          identifier the transcript route answers to for the orchestrator; an
          uninstrumented one arrives here as the server's gap line, which
          `Conversation` already knows how to say out loud.
        */}
        <Conversation lane={MAIN_SELECTION} fetchImpl={fetchTranscript} pollMs={transcriptPollMs} />
        <AttachButton plan={mainPlan} onCopy={onCopy} />
      </DrawerFrame>
    )
  }

  return (
    <DrawerFrame
      selectedId={selectedId}
      label={`Lane ${selectedId}`}
      onClose={clear}
      title={
        <span className="flex min-w-0 items-baseline gap-2">
          <h2 className="min-w-0 truncate font-mono text-sm text-ice-100">{lane?.label ?? selectedId}</h2>
          {lane === null ? null : <OpenPageLink handle={lane.id} />}
        </span>
      }
    >
      {lane === null || plan === null ? (
        /*
         * Selected, but no longer in the fleet — a lane can be removed from the
         * derived object while its drawer is open (its worktree went away and
         * nothing else names it). Saying so beats an empty panel that looks
         * like a rendering bug (law 12).
         */
        <p role="status" data-testid="drawer-unknown-lane" className="px-4 py-3 text-[11px] leading-snug text-ice-400">
          LANE GONE — “{selectedId}” is no longer in the fleet, so there are no vitals to show — press
          Esc to close, or click another lane.
        </p>
      ) : (
        <>
          <Vitals lane={lane} fleet={fleet} />
          <TabBar tabs={tabs} active={activeTab} onSelect={selectTab} />
          <div
            role="tabpanel"
            id={tabPanelId(activeTab)}
            aria-labelledby={`drawer-tab-${activeTab}`}
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            {activeTab === 'conversation' ? (
              <Conversation lane={lane.id} fetchImpl={fetchTranscript} pollMs={transcriptPollMs} />
            ) : activeTab === 'activity' ? (
              <ActivityView entries={entries} now={fleet.now} fill highlightPath={activityHighlight} />
            ) : activeTab === 'why' ? (
              <WhySurface
                state={state.session}
                laneLabel={lane.label}
                laneHandle={laneHandle}
                now={fleet.now}
                fetchTranscript={fetchTranscript}
                fill
                onJumpToActivity={jumpToActivity}
              />
            ) : (
              <TraceSection state={state.session} lane={lane.id} />
            )}
          </div>
          <AttachButton plan={plan} onCopy={onCopy} />
        </>
      )}
    </DrawerFrame>
  )
}

/**
 * THE OPEN-PAGE AFFORDANCE (prd9 B1b, #135) — the drawer's own entry point to
 * the deep-linkable lane page. A real `<a href>`, not a bare button, so the
 * usual modifier-click/middle-click ways of opening a link in a new tab keep
 * working; a plain click instead swaps the SPA to the page in place, over
 * the same `navigate` the page's own Esc/back uses, rather than a full
 * reload the browser's default navigation would cost.
 */
function OpenPageLink({ handle }: { handle: string }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(laneUrl(handle))
  }

  return (
    <a
      href={laneUrl(handle)}
      onClick={onClick}
      data-testid="drawer-open-page"
      className="shrink-0 rounded border border-ice-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ice-400 transition-[color,border-color] duration-150 ease-out hover:border-ice-600 hover:text-ice-100"
    >
      open page ↗
    </a>
  )
}

interface DrawerFrameProps {
  /** What is open, on the element, so a test asks the DOM rather than a mock. */
  selectedId: string
  /** The accessible name of the whole drawer. */
  label: string
  /** The identity in the header — a lane's name, or MAIN and its branch. */
  title: ReactNode
  onClose: () => void
  children: ReactNode
}

/**
 * The drawer's shell: one panel, one header, one way out.
 *
 * Shared by the lane reading and main's rather than duplicated, because the
 * frame is the part an operator learns once — the same width, the same hairline,
 * the same Esc in the same corner — and two copies of it are two chances for the
 * root-mass's drawer to become subtly a different object from a lane's.
 */
function DrawerFrame({ selectedId, label, title, onClose, children }: DrawerFrameProps) {
  return (
    <aside
      data-testid="lane-drawer"
      data-lane={selectedId}
      aria-label={label}
      className="fixed inset-y-0 right-0 z-40 flex w-[min(48rem,92vw)] flex-col border-l border-ice-850 bg-ice-950 shadow-[-24px_0_48px_-24px_rgba(0,0,0,0.9)]"
    >
      <header className="flex items-center justify-between gap-2 border-b border-ice-850 px-4 py-2">
        {title}
        <button
          type="button"
          data-testid="drawer-close"
          onClick={onClose}
          aria-label="Close the drawer"
          className="shrink-0 rounded border border-ice-800 px-2 py-0.5 text-[10px] uppercase tracking-wider text-ice-400 transition-[color,border-color] duration-150 ease-out hover:border-ice-600 hover:text-ice-100"
        >
          Esc
        </button>
      </header>
      {children}
    </aside>
  )
}

export { LaneDrawer }
export { foldActivity, activityCounts } from './activity.js'
export type { ActivityEntry, ActivityKind } from './activity.js'
export { attachPlan, conductorAttachPlan, findTmuxIdentity, workmuxHandle } from './attach.js'
export type { AttachPlan, AttachRoot, TmuxIdentity } from './attach.js'
export { MainVitals, Vitals } from './Vitals.js'
export { Conversation, isAtTail } from './Conversation.js'
export { TraceSection } from './Trace.js'
export { useTranscript, transcriptUrl, parseEntries } from './useTranscript.js'
export type { TranscriptState, TranscriptEntry, TranscriptBlock, TranscriptRole } from './useTranscript.js'
