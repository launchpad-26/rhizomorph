import { useCallback, useEffect, useMemo } from 'react'
import { Nav } from '../app/Nav.js'
import { laneUrl, navigate } from '../app/router.js'
import { ReplayBar } from '../app/ReplayBar.js'
import { useStream } from '../app/StreamContext.js'
import { ActivityView } from '../drawer/Activity.js'
import { Conversation } from '../drawer/Conversation.js'
import { foldActivity } from '../drawer/foldActivity.js'
import { useTranscript, type TranscriptEntry } from '../drawer/useTranscript.js'
import { MAIN_SELECTION, useFleet } from '../fleet/index.js'
import type { FetchLike } from '../fleet/manifest.js'
import { capabilityRead } from '../recordings/capabilityRead.js'
import { WhySurface } from '../why/index.js'
import { useLaneIndex, type LaneIndexEntry } from './laneIndex.js'
import { PageHeader } from './PageHeader.js'
import { outcomeOf, RunOutcomeRegion } from './RunOutcome.js'
import { RunSpine } from './RunSpine.js'
import { SpendDetail } from './SpendDetail.js'
import { buildSpine } from './spine.js'
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

/** One shared empty list, so "no transcript yet" is a stable identity to memoise against. */
const EMPTY_ENTRIES: readonly TranscriptEntry[] = []

/**
 * THE RUN VIEW (prd-31 rulings 5 and 6, S2 · #556) — `/lane/:handle`, grown
 * into the place a person answers *what did this piece of work actually do?*
 *
 * **There is no new top-level concept** (decision 5). The lane page was already
 * the deep-linkable page for one lane (prd9 B1b, #135); this widens what it
 * carries — the outcome with its evidence, the derived phase spine, the
 * interaction cards, conversation beside trace, spend and activity — rather
 * than opening a second address for the same work.
 *
 * **And it reads after the lane is gone.** That clause is the expensive one and
 * it is the whole ruling. `workmux merge` deletes a worktree the moment work
 * lands, which is precisely when a person most wants to read what happened, and
 * a lane that ran across three sessions has its life scattered across three
 * recordings. So this page has two feeds and one shape:
 *
 * 1. **The fold** (`useStream`) — the recording currently loaded, live or
 *    scrubbed. It gives interactions, trace, activity and the live spend.
 * 2. **The lane index** (`/api/lane-index/:handle`, prd-31 ruling 5) — every
 *    recording this lane ever appears in, read from the logs and the captured
 *    transcripts beside them, never from a worktree.
 *
 * A lane still in the fold gets both. A lane whose worktree is gone *and* whose
 * events are in an earlier recording gets the second alone — and every region
 * still renders, because no region reads anything a deleted worktree was
 * holding. That is asserted rather than asserted-about: `LanePage.test.tsx`
 * folds a session, watches the worktree be removed, and then folds a *different*
 * session entirely, so the page has nothing but the index to read from.
 *
 * **The conductor's own page (#138)** is unchanged. `/lane/main` —
 * {@link MAIN_SELECTION} — resolves through the exact identity the transcript
 * route already answers to, and `/lane/conductor` redirects here client-side
 * rather than growing a second page for one canonical name. It is not a lane in
 * any index and does not ask one.
 */
export interface LanePageProps {
  handle: string
  /** Test seam for the conversation's `fetch`, threaded straight to `Conversation`. */
  fetchTranscript?: FetchLike
  /** Test seam: `0` reads the conversation once and never polls. */
  transcriptPollMs?: number
  /** Test seam for the lane index's `fetch`. */
  fetchLaneIndex?: FetchLike
}

/**
 * The same request, scoped to one recording. `/api/transcript/:lane?session=N`
 * reads that recording's own events and prefers the capture beside it (the
 * route's own precedence rule: captured > live > honest gap), which is what
 * makes a conversation legible after its worktree is deleted. Composed as a
 * `fetch` wrapper rather than as a new option on `useTranscript`, so this lane
 * touches no file the drawer owns.
 */
export function sessionScopedUrl(url: string, sessionId: string): string {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}session=${encodeURIComponent(sessionId)}`
}

// The scoped transcript read hits `/api/transcript/:lane?session=N`, a
// `gated-read` (prd-29 ruling 1), so the base fetch routes through the shared
// `capabilityRead`; `scopedFetch` below wraps it to append the session param.
function defaultFetch(): FetchLike | null {
  return typeof globalThis.fetch === 'function' ? (capabilityRead as FetchLike) : null
}

/** The recording whose captured transcript this lane's conversation should read. */
export function transcriptSessionFor(entry: LaneIndexEntry | null): string | null {
  if (entry === null) return null
  const captured = [...entry.sessions].reverse().find((slice) => slice.transcript?.captured === true)
  if (captured !== undefined) return captured.sessionId
  const read = [...entry.sessions].reverse().find((slice) => slice.recordingPresent)
  return read?.sessionId ?? null
}

export function LanePage({ handle, fetchTranscript, transcriptPollMs, fetchLaneIndex }: LanePageProps) {
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

  // The conductor is not a lane in any index and never asks one. Every other
  // handle does, whether or not the fold in front of us still knows it: the
  // index is what carries the sessions this page cannot see.
  const index = useLaneIndex(isConductor || isConductorRedirect ? null : handle, fetchLaneIndex)
  const entry = index.entry

  /**
   * The telemetry handle to derive interactions and the conversation for.
   * `lane.handles[0]` when the fold knows the lane (a lane's id is its branch,
   * which is not always the handle telemetry used); the index's own handle
   * otherwise.
   */
  const telemetryHandle = lane?.handles[0] ?? entry?.handle ?? handle

  // The conversation, hoisted so the interaction cards can quote from it. The
  // page reads it once more than `Conversation` does, which is the cost of not
  // reaching into `drawer/` to add an `entries` prop this lane's fence does not
  // cover; both reads are the same bounded GET the route was built for.
  const transcriptSession = transcriptSessionFor(entry)
  const scopedFetch = useMemo<FetchLike | undefined>(() => {
    const base = fetchTranscript ?? defaultFetch()
    if (base === null) return undefined
    if (transcriptSession === null) return fetchTranscript
    return (input: string) => base(sessionScopedUrl(input, transcriptSession))
  }, [fetchTranscript, transcriptSession])

  // The conductor's page renders no spine and needs no quotes, so it does not
  // ask: `null` is `useTranscript`'s own not-reading case, and it issues no
  // request at all.
  const tail = useTranscript(isConductorRedirect || isConductor ? null : telemetryHandle, {
    fetchImpl: scopedFetch,
    pollMs: transcriptPollMs,
  })
  // Stabilised, because `buildSpine` is memoised against it: a fresh `[]` per
  // render would re-derive every interaction card on every keystroke elsewhere
  // on the page.
  const quoteEntries = useMemo(
    () => (tail.status === 'ready' ? tail.entries : EMPTY_ENTRIES),
    [tail.status, tail.entries],
  )

  const entries = useMemo(
    () => (lane === null ? [] : foldActivity(state.events, lane)),
    [state.events, lane],
  )

  const spine = useMemo(
    () =>
      buildSpine({
        entry,
        state: state.session,
        lane: telemetryHandle,
        now: fleet.now,
        entries: quoteEntries,
      }),
    [entry, state.session, telemetryHandle, fleet.now, quoteEntries],
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

  // Neither the fold nor the index knows this handle. Two sentences, not one:
  // the first is what this page's own fold can say, the second is the SERVER's
  // own — which names what it searched (S2's *unknown handle* state) and is
  // carried verbatim, because reworded here, two surfaces would come to
  // disagree about one condition. While the index is still answering, the page
  // says it is looking rather than claiming the lane does not exist.
  if (lane === null && entry === null) {
    return (
      <div data-testid="lane-page" className="flex h-screen flex-col bg-ice-1000 font-sans text-ice-300">
        <Nav />
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
          {index.status === 'loading' ? (
            <p
              role="status"
              data-testid="lane-page-searching"
              className="max-w-lg font-mono text-read-floor leading-snug text-ice-400"
            >
              SEARCHING EVERY RECORDING for “{handle}” — the lane is not in the session loaded here, so
              its life is being looked for in the log.
            </p>
          ) : (
            <>
              <p
                role="status"
                data-testid="lane-page-unknown"
                className="max-w-lg font-mono text-[12px] leading-snug text-ice-400"
              >
                NO LANE “{handle}” IN THIS SESSION — it may have landed, been renamed, or never existed
                in this session's log.
              </p>
              {index.reason === null ? null : (
                <p
                  data-testid="lane-page-unknown-index"
                  className="max-w-lg font-mono text-read-floor leading-snug text-ice-400"
                >
                  {index.reason}
                </p>
              )}
            </>
          )}
          <button
            type="button"
            data-testid="lane-page-back"
            onClick={goBalcony}
            className="shrink-0 rounded border border-ice-800 px-3 py-1 text-[10px] uppercase tracking-wider text-ice-400 hover:border-ice-600 hover:text-ice-100"
          >
            ← balcony
          </button>
        </div>
      </div>
    )
  }

  // The fold outranks history here, deliberately: a lane torn down and
  // re-dispatched under the same handle is present NOW, whatever an older
  // recording watched happen to its predecessor. When the fold has never heard
  // of the lane, the index is the only witness and its answer stands.
  const worktreeGone = lane === null ? entry?.worktreeRemoved === true : !lane.present

  return (
    <div data-testid="lane-page" data-worktree-gone={worktreeGone} className="flex h-screen flex-col bg-ice-1000 font-sans text-ice-300">
      <PageHeader
        subject={
          lane === null
            ? {
                kind: 'run',
                handle: entry?.handle ?? handle,
                issue: entry?.issue ?? null,
                branch: entry?.branch ?? null,
                outcome: outcomeOf(entry),
              }
            : { kind: 'lane', lane }
        }
        onClose={goBalcony}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
        <RunOutcomeRegion
          handle={entry?.handle ?? handle}
          entry={entry}
          indexGap={index.status === 'absent' ? index.reason : null}
          now={fleet.now}
        />

        <RunSpine sessions={spine} />

        <div className="grid h-[26rem] shrink-0 grid-cols-1 gap-3 md:grid-cols-2">
          <section
            data-testid="lane-page-conversation"
            className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-ice-850 bg-ice-950"
          >
            <Conversation lane={telemetryHandle} fetchImpl={scopedFetch} pollMs={transcriptPollMs} />
          </section>
          <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-ice-850 bg-ice-950 p-2">
            <TraceColumn state={state.session} lane={telemetryHandle} />
          </section>
        </div>

        {lane === null ? null : (
          <div className="grid shrink-0 grid-cols-1 gap-3 md:grid-cols-2">
            <SpendDetail subject={{ kind: 'lane', lane }} fleet={fleet} state={state.session} />
            <ActivityView entries={entries} now={fleet.now} />
          </div>
        )}
      </div>

      {lane === null ? null : (
        <WhySurface
          state={state.session}
          laneLabel={lane.label}
          laneHandle={lane.handles.length === 1 ? lane.handles[0]! : null}
          now={fleet.now}
          fetchTranscript={scopedFetch}
        />
      )}

      <ReplayBar />
    </div>
  )
}
