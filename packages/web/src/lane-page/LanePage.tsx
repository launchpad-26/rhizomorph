import { useCallback, useEffect, useMemo } from 'react'
import { navigate } from '../app/router.js'
import { ReplayBar } from '../app/ReplayBar.js'
import { useStream } from '../app/StreamContext.js'
import { ActivityView } from '../drawer/Activity.js'
import { Conversation } from '../drawer/Conversation.js'
import { foldActivity } from '../drawer/activity.js'
import { useFleet } from '../fleet/index.js'
import type { FetchLike } from '../fleet/manifest.js'
import { PageHeader } from './PageHeader.js'
import { SpendDetail } from './SpendDetail.js'
import { TraceColumn } from './TraceColumn.js'

/**
 * THE LANE PAGE (prd9 B1b, issue #135) — the deep-linkable page for one lane:
 * a shareable URL that gives one lane real room, conversation beside trace,
 * spend and activity beneath. The balcony (`Shell`) stays the product's
 * home; this is where an operator goes DEEPER on one lane already found
 * there — so it reuses, never forks: `Conversation` is the drawer's own
 * component, `TraceTree`/`TraceGantt` are #132's (via `TraceColumn`), and
 * the header/spend both read the one derived fleet object (`buildFleet`)
 * through the fleet table's own cell code.
 *
 * Renders inside the app's existing `StreamProvider`/`FleetProvider` — no
 * second read of the log, no second derivation — so live and replay behave
 * identically to the balcony: `ReplayBar` is the same component `Shell`
 * mounts, and the mode context above both is one context, not two.
 */
export interface LanePageProps {
  handle: string
  /** Test seam for the conversation's `fetch`, threaded straight to `Conversation`. */
  fetchTranscript?: FetchLike
  /** Test seam: `0` reads the conversation once and never polls. */
  transcriptPollMs?: number
}

export function LanePage({ handle, fetchTranscript, transcriptPollMs }: LanePageProps) {
  const fleet = useFleet()
  const { state } = useStream()
  const lane = fleet.lanes.find((candidate) => candidate.id === handle) ?? null

  const goBalcony = useCallback(() => navigate('/'), [])

  // Esc returns to the balcony — the one way out of this page, the same way
  // Esc is the one way out of every other narrowed view in the instrument.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') goBalcony()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [goBalcony])

  const entries = useMemo(
    () => (lane === null ? [] : foldActivity(state.events, lane)),
    [state.events, lane],
  )

  if (lane === null) {
    return (
      <div
        data-testid="lane-page"
        className="flex h-screen flex-col items-center justify-center gap-4 bg-ice-1000 px-4 text-center font-sans text-ice-300"
      >
        <p role="status" data-testid="lane-page-unknown" className="max-w-lg font-mono text-[12px] leading-snug text-ice-400">
          NO LANE “{handle}” IN THIS SESSION — it may have landed, been renamed, or never existed
          in this session's log.
        </p>
        <button
          type="button"
          data-testid="lane-page-back"
          onClick={goBalcony}
          className="shrink-0 rounded border border-ice-800 px-3 py-1 text-[10px] uppercase tracking-wider text-ice-400 hover:border-ice-600 hover:text-ice-100"
        >
          ← balcony
        </button>
      </div>
    )
  }

  return (
    <div data-testid="lane-page" className="flex h-screen flex-col bg-ice-1000 font-sans text-ice-300">
      <PageHeader lane={lane} onClose={goBalcony} />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden p-3 md:grid-cols-2">
        <section
          data-testid="lane-page-conversation"
          className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-ice-850 bg-ice-950"
        >
          <Conversation lane={lane.id} fetchImpl={fetchTranscript} pollMs={transcriptPollMs} />
        </section>
        <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-ice-850 bg-ice-950 p-2">
          <TraceColumn state={state.session} lane={lane.id} />
        </section>
      </div>

      <div className="grid shrink-0 grid-cols-1 gap-3 border-t border-ice-850 p-3 md:grid-cols-2">
        <SpendDetail lane={lane} fleet={fleet} state={state.session} />
        <ActivityView entries={entries} now={fleet.now} />
      </div>

      <ReplayBar />
    </div>
  )
}
