import { useMemo } from 'react'
import { useStream } from '../app/StreamContext.js'
import { useFleet, useSelection } from '../fleet/index.js'
import type { FetchLike } from '../fleet/manifest.js'
import { ActivityView } from './Activity.js'
import { AttachButton, type CopyText } from './AttachButton.js'
import { TranscriptPanel } from './Transcript.js'
import { Vitals } from './Vitals.js'
import { foldActivity } from './activity.js'
import { attachPlan } from './attach.js'

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
 * Top to bottom it is the ruling's own ordering: **vitals** (the row you just
 * clicked, opened out), **activity** (what it has been doing — the default
 * reading), **transcript** (what it actually said, expandable, live-tailing),
 * **attach** (the command to go and talk to it in your own terminal).
 *
 * The read-only constitution holds absolutely and structurally: the only
 * network call anywhere in this directory is `GET /api/transcript/:lane`, and
 * the only way to interact with an agent is a string on your clipboard.
 */

export interface LaneDrawerProps {
  /** Test seam for the transcript's `fetch`. */
  fetchTranscript?: FetchLike
  /** Test seam: `0` reads the transcript once and never polls. */
  transcriptPollMs?: number
  /** Test seam: open the transcript immediately. */
  transcriptExpanded?: boolean
  /** Test seam for the clipboard. */
  onCopy?: CopyText
}

export default function LaneDrawer({
  fetchTranscript,
  transcriptPollMs,
  transcriptExpanded,
  onCopy,
}: LaneDrawerProps = {}) {
  const { selectedId, clear } = useSelection()
  const fleet = useFleet()
  const { state } = useStream()

  const lane = selectedId === null ? null : (fleet.lanes.find((l) => l.id === selectedId) ?? null)

  const entries = useMemo(
    () => (lane === null ? [] : foldActivity(state.events, lane)),
    [state.events, lane],
  )
  const plan = useMemo(() => (lane === null ? null : attachPlan(state.events, lane)), [state.events, lane])

  if (selectedId === null) return null

  return (
    <aside
      data-testid="lane-drawer"
      data-lane={selectedId}
      aria-label={`Lane ${selectedId}`}
      className="fixed inset-y-0 right-0 z-40 flex w-[min(34rem,100vw)] flex-col border-l border-ice-850 bg-ice-950 shadow-[-24px_0_48px_-24px_rgba(0,0,0,0.9)]"
    >
      <header className="flex items-center justify-between gap-2 border-b border-ice-850 px-4 py-2">
        <h2 className="min-w-0 truncate font-mono text-sm text-ice-100">{lane?.label ?? selectedId}</h2>
        <button
          type="button"
          data-testid="drawer-close"
          onClick={clear}
          aria-label="Close lane drawer"
          className="shrink-0 rounded border border-ice-800 px-2 py-0.5 text-[10px] uppercase tracking-wider text-ice-400 hover:border-ice-600 hover:text-ice-100"
        >
          Esc
        </button>
      </header>

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
          <ActivityView entries={entries} now={fleet.now} />
          <TranscriptPanel
            lane={lane.id}
            fetchImpl={fetchTranscript}
            pollMs={transcriptPollMs}
            initiallyExpanded={transcriptExpanded}
          />
          <AttachButton plan={plan} onCopy={onCopy} />
        </>
      )}
    </aside>
  )
}

export { LaneDrawer }
export { foldActivity, activityCounts } from './activity.js'
export type { ActivityEntry, ActivityKind } from './activity.js'
export { attachPlan, findTmuxIdentity, workmuxHandle } from './attach.js'
export type { AttachPlan, TmuxIdentity } from './attach.js'
export { useTranscript, transcriptUrl } from './useTranscript.js'
export type { TranscriptState } from './useTranscript.js'
