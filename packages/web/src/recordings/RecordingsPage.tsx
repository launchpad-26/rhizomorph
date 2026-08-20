import { useCallback, useEffect, useState } from 'react'
import { useReplay } from '../app/ModeContext.js'
import { Nav } from '../app/Nav.js'
import { navigate } from '../app/router.js'
import { TwoRepresentations } from '../fleet/TwoRepresentations.js'
import type { FetchLike } from '../replay/api.js'
import { fetchRecordings, type RecordingListing } from './api.js'
import { exportRecording, type DownloadEnv } from './export.js'
import {
  captureHoverTitle,
  costHoverTitle,
  costSuffix,
  formatCapture,
  formatCost,
  formatDuration,
  isCaptureGap,
  isCostGap,
} from './format.js'
import type { LabelFetchLike } from './label.js'
import { LaneAxis } from './LaneAxis.js'
import { EMPTY_LANE_INDEX, fetchLaneIndex, type LaneIndexPage } from './laneIndex.js'
import { RenameControl } from './RenameControl.js'

/**
 * THE HISTORY SURFACE (prd-31 ruling 8 / S4, #558) — `/recordings`, one surface
 * with two axes.
 *
 * ## What changed, and why it is a reading change
 *
 * Recordings (a library of sessions) and the run view (the life of one lane)
 * answered the same question — *show me the past* — and splitting them was an
 * artifact of how the data arrived, not a distinction a reader has. They become
 * one surface with two axes: browse **by session** (what happened that night)
 * or **by lane** (what that piece of work did).
 *
 * The lane axis is what ruling 5's index made possible. Before it, a lane that
 * ran across three sessions had its life in three files with nothing tying them
 * together, so "what did this work do" was a question the library could not
 * answer at any price.
 *
 * **The replay machinery beneath is untouched.** One reducer for live and
 * replay (ADR-0002), records read-only, nothing enriched
 * (`docs/record-format.md`). Both axes read routes that already existed —
 * `GET /api/sessions` and `GET /api/lane-index`, the latter built for this axis
 * and saying so in its own doc — and neither recomputes a figure the server
 * already computed. This is a reading change, not a data change.
 *
 * ## The toggle is prd-36's component, not a third implementation
 *
 * S4 says "the same idiom as organism⇄list", and ruling 3 of prd-36 says a
 * fourth instance is *a row in the registry, not a new pattern*. So `history`
 * joins {@link REPRESENTATION_INSTANCES} and this page renders
 * `TwoRepresentations` — which is also what makes
 * `fleet/two-representations-law.test.ts` start holding this surface to the
 * keyboard behaviour, the persistence shape and the "state survives the switch"
 * guarantee the fleet already answers to.
 *
 * ## A library, not a second overview
 *
 * prd16 ruling 4's own warning, still in force: nothing here renders the
 * curated panel order, no scene, no live fleet state. What it does is manage
 * what was recorded — rename in place, open in replay, export the portable
 * record — and now also *browse what was done*.
 *
 * ## An unreadable record is named and counted, never silently skipped
 *
 * ADR-0011's posture, and S4 asks for it by name. Two different unreadable
 * things exist and both are said out loud ({@link UnreadableRecords}): a whole
 * recording the lane index could not open, and lines inside a recording that
 * did open but could not be folded (`SessionListing.unreadableLinesVoice`,
 * which the library has carried since prd17 ruling 3 and never showed).
 */
export interface RecordingsPageProps {
  /** Test-only escape hatch for the listing/export reads. */
  fetchImpl?: FetchLike
  /** Test-only escape hatch for the rename control's mutating call. */
  labelFetchImpl?: LabelFetchLike
  /** Test-only escape hatch for the export's download side effect. */
  downloadEnv?: DownloadEnv
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; recordings: RecordingListing[] }
  | { status: 'error'; message: string }

type LaneState =
  | { status: 'loading' }
  | { status: 'ready'; page: LaneIndexPage }
  | { status: 'error'; message: string }

function goBalcony(): void {
  navigate('/')
}

/** Both axes say the same thing about a fresh repo — one recording is what creates either of them. */
const EMPTY_LINE =
  'no recordings yet — a recording is created when this instrument watches a session, so run a lane and one appears here'

export function RecordingsPage({ fetchImpl, labelFetchImpl, downloadEnv }: RecordingsPageProps = {}) {
  const { selectAndPlay, refreshSessions } = useReplay()
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [lanes, setLanes] = useState<LaneState>({ status: 'loading' })
  const [exportingId, setExportingId] = useState<string | null>(null)
  const [exportError, setExportError] = useState<{ id: string; message: string } | null>(null)

  const load = useCallback(() => {
    setState({ status: 'loading' })
    fetchRecordings(fetchImpl)
      .then((recordings) => setState({ status: 'ready', recordings }))
      .catch((err) => setState({ status: 'error', message: err instanceof Error ? err.message : String(err) }))
  }, [fetchImpl])

  /**
   * The lane index is fetched **once, on mount, alongside the listing** rather
   * than when the lane axis is first shown. S4's third guarantee is that
   * switching representations is instant and lossless and "the switch costs a
   * re-fetch" is named as what would make it wrong (prd-36 S1, the same
   * component's contract). A lazy read would make the first toggle a spinner.
   */
  const loadLanes = useCallback(() => {
    setLanes({ status: 'loading' })
    fetchLaneIndex(fetchImpl)
      .then((page) => setLanes({ status: 'ready', page }))
      .catch((err) => setLanes({ status: 'error', message: err instanceof Error ? err.message : String(err) }))
  }, [fetchImpl])

  useEffect(() => {
    load()
    loadLanes()
  }, [load, loadLanes])

  function openInReplay(id: string): void {
    selectAndPlay(id)
    goBalcony()
  }

  function renamed(id: string, label: string): void {
    setState((prev) =>
      prev.status !== 'ready'
        ? prev
        : { status: 'ready', recordings: prev.recordings.map((r) => (r.id === id ? { ...r, title: label, label } : r)) },
    )
    // The balcony's own session picker (`replay/index.tsx`) fetched the listing
    // separately and caches it — without this it would keep showing the old
    // auto-title after a rename until something else happened to refetch it.
    refreshSessions()
  }

  async function doExport(id: string): Promise<void> {
    setExportingId(id)
    setExportError(null)
    try {
      await exportRecording(id, fetchImpl, downloadEnv)
    } catch (err) {
      setExportError({ id, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setExportingId(null)
    }
  }

  const sessionAxis = () => (
    <>
      {state.status === 'loading' && <p className="text-(--ink-dim)">loading recordings…</p>}

      {state.status === 'error' && (
        <p role="status" data-testid="recordings-error" className="text-broken">
          {state.message}
        </p>
      )}

      {state.status === 'ready' && state.recordings.length === 0 && (
        <p data-testid="recordings-empty" className="text-(--ink-dim)">
          {EMPTY_LINE}
        </p>
      )}

      {state.status === 'ready' && state.recordings.length > 0 && (
        <table data-testid="recordings-table" className="w-full border-collapse text-left text-read-floor">
          <thead>
            <tr className="border-b border-(--line-hair) text-(--ink-dim)">
              <th className="p-(--space-cell) font-normal">title</th>
              <th className="p-(--space-cell) font-normal">lanes</th>
              <th className="p-(--space-cell) font-normal">landed</th>
              <th className="p-(--space-cell) font-normal">duration</th>
              <th className="p-(--space-cell) font-normal">cost</th>
              <th className="p-(--space-cell) font-normal">captured</th>
              <th className="p-(--space-cell) font-normal">actions</th>
            </tr>
          </thead>
          <tbody>
            {state.recordings.map((recording) => (
              <tr
                key={recording.id}
                data-testid={`recording-row-${recording.id}`}
                className="border-b border-(--line-hair) align-top"
              >
                <td className="max-w-[16rem] p-(--space-cell)">
                  <RenameControl
                    sessionId={recording.id}
                    title={recording.title}
                    fetchImpl={labelFetchImpl}
                    onRenamed={(label) => renamed(recording.id, label)}
                  />
                  {/*
                    prd17 ruling 3's own accounting, finally shown. The listing
                    has carried `unreadableLinesVoice` since it landed and no
                    surface rendered it, so a recording that lost lines looked
                    exactly like one that did not — the silent skip S4 forbids,
                    one level down from a whole missing file.
                  */}
                  {recording.unreadableLinesVoice ? (
                    <p
                      data-testid={`recording-unreadable-lines-${recording.id}`}
                      className="mt-1 text-inst leading-snug text-broken"
                    >
                      {recording.unreadableLinesVoice}
                    </p>
                  ) : null}
                </td>
                <td className="figures p-(--space-cell)">{recording.lanes}</td>
                <td className="figures p-(--space-cell)">{recording.landed}</td>
                <td className="figures p-(--space-cell)">{formatDuration(recording.durationMs)}</td>
                <td className="figures p-(--space-cell)" title={costHoverTitle(recording)}>
                  {formatCost(recording)}
                  {costSuffix(recording) !== null && (
                    <span className="ml-1 text-(--ink-dim)">{costSuffix(recording)}</span>
                  )}
                  {isCostGap(recording) && (
                    <span data-testid={`recording-cost-gap-${recording.id}`} className="ml-1 text-(--ink-dim)">
                      (no cost feed)
                    </span>
                  )}
                </td>
                <td className="p-(--space-cell)" title={captureHoverTitle(recording)}>
                  {formatCapture(recording)}
                  {isCaptureGap(recording) && (
                    <span data-testid={`recording-capture-gap-${recording.id}`} className="ml-1 text-(--ink-dim)">
                      ⚠
                    </span>
                  )}
                </td>
                <td className="p-(--space-cell)">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      data-testid={`recording-open-${recording.id}`}
                      onClick={() => openInReplay(recording.id)}
                      className="focus-ring rounded border border-(--line-strong) px-2 py-1 normal-case tracking-normal text-(--ink-body) hover:border-(--ink-dim) hover:text-(--ink-primary)"
                    >
                      open in replay
                    </button>
                    <button
                      type="button"
                      data-testid={`recording-export-${recording.id}`}
                      disabled={exportingId === recording.id}
                      onClick={() => void doExport(recording.id)}
                      title="download the portable record — manifest + hash-chained log, captured transcripts included when this recording has them"
                      className="focus-ring rounded border border-(--line-strong) px-2 py-1 normal-case tracking-normal text-(--ink-body) hover:border-(--ink-dim) hover:text-(--ink-primary) disabled:opacity-50"
                    >
                      {exportingId === recording.id ? 'exporting…' : 'export'}
                    </button>
                  </div>
                  {exportError !== null && exportError.id === recording.id && (
                    <p
                      role="status"
                      data-testid={`recording-export-error-${recording.id}`}
                      className="mt-1 normal-case tracking-normal text-broken"
                    >
                      {exportError.message}
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )

  const laneAxis = () => (
    <>
      {lanes.status === 'loading' && <p className="text-(--ink-dim)">reading every recording for its lanes…</p>}

      {lanes.status === 'error' && (
        <p role="status" data-testid="history-lanes-error" className="text-broken">
          NO LANE INDEX — {lanes.message} — a server older than this page has no `/api/lane-index`; the
          session axis above is unaffected — run: `rhizomorph doctor`
        </p>
      )}

      {lanes.status === 'ready' && <LaneAxis page={lanes.page} emptyLine={EMPTY_LINE} />}
    </>
  )

  return (
    <div data-testid="recordings-page" className="flex h-screen flex-col bg-(--surface-floor) font-sans text-(--ink-body)">
      <Nav />
      <header className="flex shrink-0 items-center gap-4 border-b border-(--line-hair) bg-(--surface-panel) px-4 py-3">
        <button
          type="button"
          data-testid="recordings-back"
          onClick={goBalcony}
          className="focus-ring shrink-0 rounded border border-(--line-strong) px-2 py-1 text-inst uppercase tracking-wider text-(--ink-dim) hover:border-(--ink-dim) hover:text-(--ink-primary)"
        >
          ← balcony
        </button>
        <h1 className="text-read-body text-(--ink-primary)">History</h1>
        <span className="text-read-floor normal-case tracking-normal text-(--ink-dim)">
          the past, two ways — what happened that night, or what a piece of work did
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col p-4">
        <TwoRepresentations
          surface="history"
          heading={<h2 className="heading text-(--ink-dim)">Browse</h2>}
          views={[
            { id: 'session', label: 'By session', render: sessionAxis },
            { id: 'lane', label: 'By lane', render: laneAxis },
          ]}
        />
      </div>

      <UnreadableRecords lanes={lanes} />
    </div>
  )
}

/**
 * S4's *unreadable record* state — **named and counted, never silently
 * skipped** (ADR-0011).
 *
 * Docked below both axes rather than inside either, because it is a fact about
 * the reading itself: a recording the index could not open is missing from the
 * lane axis AND is a lane's life the session axis cannot account for, and
 * putting it inside one of the two would leave the other quietly complete.
 *
 * It renders nothing when there is nothing to say, for the same reason the
 * search's hidden line does: a permanent "0 unreadable" is a line a reader
 * learns to stop seeing.
 */
function UnreadableRecords({ lanes }: { lanes: LaneState }) {
  if (lanes.status !== 'ready' || lanes.page.unreadableSessionIds.length === 0) return null
  const ids = lanes.page.unreadableSessionIds

  return (
    <p
      role="status"
      data-testid="history-unreadable"
      data-count={ids.length}
      className="shrink-0 border-t border-(--line-hair) px-4 py-2 text-read-floor leading-snug text-broken"
    >
      {ids.length} RECORDING{ids.length === 1 ? '' : 'S'} COULD NOT BE READ — {ids.join(', ')} — so any
      lane that ran only in {ids.length === 1 ? 'it' : 'those'} is missing from the lane axis, and both
      axes below are incomplete by that much. There is no command that makes a deleted or corrupt
      recording readable; this says so rather than showing you a shorter history.
    </p>
  )
}

export { EMPTY_LANE_INDEX }
