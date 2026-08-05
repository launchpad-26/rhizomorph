import { useCallback, useEffect, useMemo } from 'react'
import { laneUrl, navigate } from '../app/router.js'
import { ReplayBar } from '../app/ReplayBar.js'
import { useStream } from '../app/StreamContext.js'
import { ActivityView } from '../drawer/Activity.js'
import { Conversation } from '../drawer/Conversation.js'
import { foldActivity } from '../drawer/foldActivity.js'
import { MAIN_SELECTION, useFleet } from '../fleet/index.js'
import type { FetchLike } from '../fleet/manifest.js'
import { WhySurface } from '../why/index.js'
import { PageHeader } from './PageHeader.js'
import { SpendDetail } from './SpendDetail.js'
import { TraceColumn } from './TraceColumn.js'

/**
 * The telemetry lane string the conductor's own usage/cost/trace events
 * carry (`fleet/fixtures.ts`'s `conductorBurn`) — distinct from
 * {@link MAIN_SELECTION}, the identity its transcript and this page's own
 * URL answer to. `/lane/conductor` is the honest URL for "the telemetry lane
 * named conductor", but `/lane/main` is the ONE canonical page (matching the
 * drawer's MAIN pseudo-lane and the transcript route's `:lane = main`), so a
 * request for the telemetry name redirects rather than growing a second page.
 */
const CONDUCTOR_TELEMETRY_LANE = 'conductor'

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
 *
 * **The conductor's own page (#138).** `/lane/main` — {@link MAIN_SELECTION}
 * — is the canonical URL for the deepest lane in the fleet: the one running
 * every worker, reachable everywhere else (the drawer's MAIN pseudo-lane, the
 * transcript route's `:lane = main`) but nowhere as a page, before this. It
 * resolves through the exact identity the transcript route already answers
 * to ({@link MAIN_SELECTION}) and the conductor's own telemetry lane
 * ({@link CONDUCTOR_TELEMETRY_LANE}) for spend and trace — never a
 * fabricated `Lane`. `/lane/conductor` names the same telemetry lane the
 * ledger already knows the conductor by, so it redirects here client-side
 * rather than growing a second page for one canonical name.
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
  const isConductorRedirect = handle === CONDUCTOR_TELEMETRY_LANE
  const isConductor = handle === MAIN_SELECTION
  const lane = isConductor ? null : (fleet.lanes.find((candidate) => candidate.id === handle) ?? null)

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

  // The telemetry lane name finds the same page, not a gap: no new route
  // machinery, just the existing history-API `navigate` this page's own Esc
  // already uses.
  useEffect(() => {
    if (isConductorRedirect) navigate(laneUrl(MAIN_SELECTION))
  }, [isConductorRedirect])

  const entries = useMemo(
    () => (lane === null ? [] : foldActivity(state.events, lane)),
    [state.events, lane],
  )

  if (isConductorRedirect) return null

  if (isConductor) {
    return (
      <div data-testid="lane-page" className="flex h-screen flex-col bg-ice-1000 font-sans text-ice-300">
        <PageHeader subject={{ kind: 'conductor' }} onClose={goBalcony} />

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden p-3 md:grid-cols-2">
          <section
            data-testid="lane-page-conversation"
            className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-ice-850 bg-ice-950"
          >
            <Conversation lane={MAIN_SELECTION} fetchImpl={fetchTranscript} pollMs={transcriptPollMs} />
          </section>
          <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-ice-850 bg-ice-950 p-2">
            <TraceColumn state={state.session} lane={CONDUCTOR_TELEMETRY_LANE} />
          </section>
        </div>

        <div className="grid shrink-0 grid-cols-1 gap-3 border-t border-ice-850 p-3">
          <SpendDetail subject={{ kind: 'conductor' }} fleet={fleet} state={state.session} />
        </div>

        <WhySurface
          state={state.session}
          laneLabel="the conductor"
          laneHandle={CONDUCTOR_TELEMETRY_LANE}
          now={fleet.now}
          fetchTranscript={fetchTranscript}
        />

        <ReplayBar />
      </div>
    )
  }

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
      <PageHeader subject={{ kind: 'lane', lane }} onClose={goBalcony} />

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
        <SpendDetail subject={{ kind: 'lane', lane }} fleet={fleet} state={state.session} />
        <ActivityView entries={entries} now={fleet.now} />
      </div>

      <WhySurface
        state={state.session}
        laneLabel={lane.label}
        laneHandle={lane.handles.length === 1 ? lane.handles[0]! : null}
        now={fleet.now}
        fetchTranscript={fetchTranscript}
      />

      <ReplayBar />
    </div>
  )
}
