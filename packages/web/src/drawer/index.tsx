import { useMemo, type MouseEvent, type ReactNode } from 'react'
import { selectLaneCondition } from '@rhizomorph/core'
import { laneUrl, navigate } from '../app/router.js'
import { useStream } from '../app/StreamContext.js'
import { isMainSelected, MAIN_SELECTION, useFleet, useSelection, type Lane } from '../fleet/index.js'
import { MainVitals, Vitals } from './Vitals.js'
import { foldActivity, type ActivityEntry } from './foldActivity.js'

/**
 * THE PEEK (prd-36 ruling 2 and S2, #562) — formerly the lane drawer.
 *
 * Click a lane anywhere (strip chip, table row, scene node — they all write the
 * one selection) and it opens on the right. The fleet stays visible: this is a
 * drawer, not a page, because the reason you opened it was something you saw in
 * the fleet and you must be able to keep seeing it. Esc closes, via the same
 * global handler that clears the selection for every other surface — there is
 * one way out of a narrowed view (prd3 ruling 6).
 *
 * **Click to glance, click again to study.** Four things and one action:
 * vitals · the latest activity line · one line of why · *open the run view*.
 * That is the whole of it, and the shortness is the ruling rather than a
 * simplification of it.
 *
 * ## What was removed, and why it was not tidiness
 *
 * Until #562 this was a four-tab reader — ACTIVITY, CONVERSATION, WHY, TRACE —
 * and prd-31 ruling 5's run view carries all four, durably, at an address.
 * Two surfaces rendering the same four tabs is how they drift, and **this was
 * the weaker one by construction**: transient, no address, unlinkable in a
 * review, and it dies with the worktree. `/lane/:handle` is deep-linkable and
 * readable a week after `workmux merge` deleted the worktree. Keeping both
 * meant maintaining the worse one forever.
 *
 * The `trace/FocusPanel.tsx` panel went in the same motion and for the same
 * reason — it rendered a subset of the run view's trace column and could not be
 * linked to.
 *
 * **What that costs, stated rather than glossed.** The ATTACH command is no
 * longer a button here (S2 allows one action, and it is not this one). It has
 * not gone: the fleet table's `a` verb copies the same string over the same
 * `attachPlan` + `copyToClipboard` path this file used to call, with a lane row
 * selected or focused — which is where a hand already is when it wants one.
 *
 * ## The peek never fetches
 *
 * S2's *data source* is one line: **the fold**. The transcript request that
 * used to fire when the CONVERSATION tab opened moved to the run view with the
 * conversation, so this file issues no request at all — no `useTranscript`, no
 * `fetch` seam, no poll. `readonly.test.ts` holds the whole directory to GETs;
 * this component holds itself to none.
 *
 * **MAIN opens the same peek (prd6 ruling 5).** The root-mass was the one thing
 * on screen an operator could not click, and the conductor was the one agent
 * whose session they could not read. Clicking the mass selects
 * {@link MAIN_SELECTION} and this answers with the orchestrator's own vitals and
 * the same one action — `/lane/main`, the conductor's own run view.
 */

export interface LaneDrawerProps {
  /**
   * Nothing. Kept as an explicit empty shape rather than deleted, because the
   * props this used to take were all fetch seams (`fetchTranscript`,
   * `transcriptPollMs`) and a clipboard seam, and "the peek takes no seams
   * because the peek makes no calls" is the claim S2 actually makes.
   */
  readonly _never?: never
}

export default function LaneDrawer(_props: LaneDrawerProps = {}) {
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

  if (selectedId === null) return null

  if (main) {
    return (
      <DrawerFrame
        selectedId={selectedId}
        label="Main — the conductor"
        onClose={clear}
        title={
          <h2 className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 heading text-(--ink-primary)">Main</span>
            <span
              data-testid="drawer-main-branch"
              className={`min-w-0 truncate font-mono text-inst text-(--ink-dim) ${
                fleet.root.mainBranch === null ? 'italic' : ''
              }`}
            >
              {fleet.root.mainBranch ?? 'no main branch on record'}
            </span>
          </h2>
        }
      >
        <MainVitals fleet={fleet} />
        <OpenRunView handle={MAIN_SELECTION} what="the conductor's run view" />
      </DrawerFrame>
    )
  }

  return (
    <DrawerFrame
      selectedId={selectedId}
      label={`Lane ${selectedId}`}
      onClose={clear}
      title={<h2 className="min-w-0 truncate font-mono text-read-body text-(--ink-primary)">{lane?.label ?? selectedId}</h2>}
    >
      {lane === null ? (
        /*
         * Selected, but no longer in the fleet — a lane can be removed from the
         * derived object while its peek is open (its worktree went away and
         * nothing else names it). Saying so beats an empty panel that looks
         * like a rendering bug (law 12) — and the action still stands, because
         * the run view is exactly the surface that survives the worktree.
         */
        <>
          <p
            role="status"
            data-testid="drawer-unknown-lane"
            className="px-4 py-3 text-inst leading-snug text-(--ink-dim)"
          >
            LANE GONE — “{selectedId}” is no longer in the fleet, so there are no vitals to show —
            press Esc to close, or read its run view, which outlives the worktree.
          </p>
          <OpenRunView handle={selectedId} what="the run view" />
        </>
      ) : (
        <>
          <Vitals lane={lane} fleet={fleet} />
          <LatestActivity entry={entries[0] ?? null} now={fleet.now} />
          <WhyLine lane={lane} now={fleet.now} />
          <OpenRunView handle={lane.id} what="the run view" finished={!lane.present} />
        </>
      )}
    </DrawerFrame>
  )
}

/**
 * THE LATEST ACTIVITY LINE (S2) — one line, not the ledger.
 *
 * The ledger itself is the run view's; what a glance wants is the single most
 * recent thing this lane did to the repo, because that is what tells you
 * whether the vitals above are describing a lane that is working or a lane
 * that stopped. Derived from the same {@link foldActivity} fold the run view's
 * own ACTIVITY region reads, so the top line here and the top line there cannot
 * be different events.
 *
 * An empty fold says so (law 12): "nothing recorded" is a fact about the lane,
 * and a blank row is a fact about the renderer.
 */
export function LatestActivity({ entry, now }: { entry: ActivityEntry | null; now: number }) {
  return (
    <p
      data-testid="peek-latest-activity"
      className="border-b border-(--line-hair) px-4 py-2 font-mono text-inst leading-snug text-(--ink-body)"
    >
      <span className="mr-2 heading text-(--ink-dim)">latest</span>
      {entry === null ? (
        <span className="text-(--ink-dim)">
          nothing recorded — no tool call, file change or commit from this lane in the session so far
        </span>
      ) : (
        <>
          <span className="figures mr-2 text-(--ink-dim)">{ageOf(entry.ts, now)}</span>
          {activityLine(entry)}
        </>
      )}
    </p>
  )
}

/** One entry as one line — the same three shapes `ActivityView` renders, flattened to a sentence. */
export function activityLine(entry: ActivityEntry): string {
  if (entry.kind === 'tool') return `${entry.tool}${entry.count > 1 ? ` ×${entry.count}` : ''}`
  if (entry.kind === 'file') return `${entry.status} ${entry.path}`
  return `${entry.sha.slice(0, 7)} ${entry.subject}`
}

function ageOf(ts: number, now: number): string {
  const ms = Math.max(0, now - ts)
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

/**
 * ONE LINE OF WHY (S2: "prd-30's condition, label and why only").
 *
 * The label and the reason, and deliberately **not** the remedy or the
 * evidence: those are the run view's, and a peek that carried the remedy would
 * be inviting a person to act on a glance. Read straight off
 * `selectLaneCondition` so this line and the run view's own condition region
 * cannot phrase one lane's state two ways — the failure prd-30 exists against.
 */
export function WhyLine({ lane, now }: { lane: Lane; now: number }) {
  const condition = selectLaneCondition(lane, now)
  return (
    <p data-testid="peek-why" className="px-4 py-2 text-inst leading-snug text-(--ink-body)">
      <span className="mr-2 heading text-(--ink-dim)">why</span>
      <span data-testid="peek-why-label" className="figures mr-2 uppercase tracking-wide text-(--ink-primary)">
        {condition.label}
      </span>
      <span className="text-(--ink-dim)">{condition.why.reason}</span>
    </p>
  )
}

/**
 * THE ONE ACTION (S2) — *open the run view*.
 *
 * A real `<a href>`, not a bare button, so the usual modifier-click and
 * middle-click ways of opening a link in a new tab keep working; a plain click
 * swaps the SPA to the page in place, over the same `navigate` the page's own
 * Esc/back uses, rather than the full reload the browser's default navigation
 * would cost. (This is prd9 B1b's `OpenPageLink`, promoted from a chip beside
 * the title to the peek's whole point.)
 *
 * `finished` is S2's *selected, finished* state: the peek says the lane is
 * finished and the action still opens its durable run view, because a finished
 * lane is precisely when the durable one is the only one there will be.
 */
function OpenRunView({
  handle,
  what,
  finished = false,
}: {
  handle: string
  what: string
  finished?: boolean
}) {
  const href = laneUrl(handle)
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(href)
  }

  return (
    <div className="mt-auto border-t border-(--line-hair) px-4 py-3">
      {finished ? (
        <p data-testid="peek-finished" className="mb-2 text-inst leading-snug text-(--ink-dim)">
          THIS LANE IS FINISHED — its worktree is gone. Its run view is not: the log and the captured
          transcript outlive the checkout.
        </p>
      ) : null}
      <a
        href={href}
        onClick={onClick}
        data-testid="drawer-open-page"
        className="focus-ring inline-flex items-center rounded-none border border-(--line-strong) px-3 py-1.5 heading tracking-wider text-(--ink-body) transition-[color,border-color] duration-(--duration-touch) ease-out hover:border-(--ink-dim) hover:text-(--ink-primary)"
      >
        open {what} ↗
      </a>
    </div>
  )
}

interface DrawerFrameProps {
  /** What is open, on the element, so a test asks the DOM rather than a mock. */
  selectedId: string
  /** The accessible name of the whole peek. */
  label: string
  /** The identity in the header — a lane's name, or MAIN and its branch. */
  title: ReactNode
  onClose: () => void
  children: ReactNode
}

/**
 * The peek's shell: one panel, one header, one way out.
 *
 * Shared by the lane reading and main's rather than duplicated, because the
 * frame is the part an operator learns once — the same width, the same hairline,
 * the same Esc in the same corner — and two copies of it are two chances for the
 * root-mass's peek to become subtly a different object from a lane's.
 *
 * Narrower than the four-tab drawer was (`min(28rem, 92vw)` rather than
 * `min(48rem, 92vw)`): the width existed to hold a conversation, and the
 * conversation is at an address now. A glance that covers half the fleet it was
 * opened from is not a glance.
 */
function DrawerFrame({ selectedId, label, title, onClose, children }: DrawerFrameProps) {
  return (
    <aside
      data-testid="lane-drawer"
      data-peek="true"
      data-lane={selectedId}
      aria-label={label}
      className="fixed inset-y-0 right-0 z-(--z-peek) flex w-[min(28rem,92vw)] flex-col border-l border-(--line-hair) bg-(--surface-panel) shadow-(--elev-sheet)"
    >
      <header className="flex items-center justify-between gap-2 border-b border-(--line-hair) px-4 py-2">
        {title}
        <button
          type="button"
          data-testid="drawer-close"
          onClick={onClose}
          aria-label="Close the peek"
          className="focus-ring shrink-0 rounded-none border border-(--line-strong) px-2 py-0.5 heading tracking-wider text-(--ink-dim) transition-[color,border-color] duration-(--duration-touch) ease-out hover:border-(--ink-dim) hover:text-(--ink-primary)"
        >
          Esc
        </button>
      </header>
      {children}
    </aside>
  )
}

export { LaneDrawer }
export { foldActivity, activityCounts } from './foldActivity.js'
export type { ActivityEntry, ActivityKind } from './foldActivity.js'
export { attachPlan, conductorAttachPlan, findTmuxIdentity, workmuxHandle } from './attach.js'
export type { AttachPlan, AttachRoot, TmuxIdentity } from './attach.js'
export { MainVitals, Vitals } from './Vitals.js'
export { Conversation, isAtTail } from './Conversation.js'
export { useTranscript, transcriptUrl, parseEntries } from './useTranscript.js'
export type { TranscriptState, TranscriptEntry, TranscriptBlock, TranscriptRole } from './useTranscript.js'
