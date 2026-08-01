import { useMemo, type ReactNode } from 'react'
import { useStream } from '../app/StreamContext.js'
import { isMainSelected, MAIN_SELECTION, useFleet, useSelection } from '../fleet/index.js'
import type { FetchLike } from '../fleet/manifest.js'
import { ActivityView } from './Activity.js'
import { AttachButton, type CopyText } from './AttachButton.js'
import { Conversation } from './Conversation.js'
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
 * Top to bottom (prd4 ruling 4 re-orders prd3's): **vitals** (the row you just
 * clicked, opened out), **conversation** (what you would see at that agent's
 * terminal — the main view, live-tailing, the largest thing here), **activity**
 * (the compact git/file/commit audit trail the conversation cannot prove),
 * **attach** (the command to go and talk to it in your own terminal).
 *
 * The conversation leads because it is what an operator came for; the ledger
 * follows because it is corroboration. prd3 had them the other way round and
 * the operator's review found the fold in front of the transcript to be the
 * drawer's worst moment.
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
              className={`min-w-0 truncate font-mono text-[11px] ${
                fleet.root.mainBranch === null ? 'text-ice-600' : 'text-ice-400'
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
        <h2 className="min-w-0 truncate font-mono text-sm text-ice-100">{lane?.label ?? selectedId}</h2>
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
          <Conversation lane={lane.id} fetchImpl={fetchTranscript} pollMs={transcriptPollMs} />
          <ActivityView entries={entries} now={fleet.now} />
          <AttachButton plan={plan} onCopy={onCopy} />
        </>
      )}
    </DrawerFrame>
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
      className="fixed inset-y-0 right-0 z-40 flex w-[min(34rem,100vw)] flex-col border-l border-ice-850 bg-ice-950 shadow-[-24px_0_48px_-24px_rgba(0,0,0,0.9)]"
    >
      <header className="flex items-center justify-between gap-2 border-b border-ice-850 px-4 py-2">
        {title}
        <button
          type="button"
          data-testid="drawer-close"
          onClick={onClose}
          aria-label="Close lane drawer"
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
export { useTranscript, transcriptUrl, parseEntries } from './useTranscript.js'
export type { TranscriptState, TranscriptEntry, TranscriptBlock, TranscriptRole } from './useTranscript.js'
