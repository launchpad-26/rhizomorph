import { useCallback, useEffect, useState } from 'react'
import { useReplay } from '../app/ModeContext.js'
import { navigate } from '../app/router.js'
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
import { RenameControl } from './RenameControl.js'

/**
 * THE RECORDINGS LIBRARY (prd16 ruling 4) — `/recordings`. The replay picker
 * is for CHOOSING a session to scrub through; this room is for MANAGING what
 * was recorded: rename in place, open in replay, export the portable record.
 *
 * A library, not a second overview (the ruling's own warning): this renders
 * nothing from the curated panel order, no scene, no live fleet state — the
 * one read it makes is `GET /api/sessions`, the same route the replay picker
 * already reads, and it recomputes none of the figures that route already
 * computed (`log/listing.ts`'s `SessionListing`). "Open in replay" reuses the
 * exact session-selection path the picker uses (`useReplay().selectAndPlay`)
 * rather than forking a second way to load a session.
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

function goBalcony(): void {
  navigate('/')
}

export function RecordingsPage({ fetchImpl, labelFetchImpl, downloadEnv }: RecordingsPageProps = {}) {
  const { selectAndPlay, refreshSessions } = useReplay()
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [exportingId, setExportingId] = useState<string | null>(null)
  const [exportError, setExportError] = useState<{ id: string; message: string } | null>(null)

  const load = useCallback(() => {
    setState({ status: 'loading' })
    fetchRecordings(fetchImpl)
      .then((recordings) => setState({ status: 'ready', recordings }))
      .catch((err) => setState({ status: 'error', message: err instanceof Error ? err.message : String(err) }))
  }, [fetchImpl])

  useEffect(() => {
    load()
  }, [load])

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

  return (
    <div data-testid="recordings-page" className="flex h-screen flex-col bg-ice-1000 font-sans text-ice-300">
      <header className="flex shrink-0 items-center gap-4 border-b border-ice-850 bg-ice-950 px-4 py-3">
        <button
          type="button"
          data-testid="recordings-back"
          onClick={goBalcony}
          className="shrink-0 rounded border border-ice-800 px-2 py-1 text-[10px] uppercase tracking-wider text-ice-400 hover:border-ice-600 hover:text-ice-100"
        >
          ← balcony
        </button>
        <h1 className="text-sm text-ice-100">Recordings</h1>
        <span className="text-[11px] normal-case tracking-normal text-ice-400">
          what this instrument recorded — rename it, open it in replay, or export the portable record
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {state.status === 'loading' && <p className="text-ice-400">loading recordings…</p>}

        {state.status === 'error' && (
          <p role="status" data-testid="recordings-error" className="text-broken">
            {state.message}
          </p>
        )}

        {state.status === 'ready' && state.recordings.length === 0 && (
          <p data-testid="recordings-empty" className="text-ice-400">
            no recordings yet
          </p>
        )}

        {state.status === 'ready' && state.recordings.length > 0 && (
          <table data-testid="recordings-table" className="w-full border-collapse text-left text-[12px]">
            <thead>
              <tr className="border-b border-ice-850 text-ice-400">
                <th className="p-2 font-normal">title</th>
                <th className="p-2 font-normal">lanes</th>
                <th className="p-2 font-normal">landed</th>
                <th className="p-2 font-normal">duration</th>
                <th className="p-2 font-normal">cost</th>
                <th className="p-2 font-normal">captured</th>
                <th className="p-2 font-normal">actions</th>
              </tr>
            </thead>
            <tbody>
              {state.recordings.map((recording) => (
                <tr
                  key={recording.id}
                  data-testid={`recording-row-${recording.id}`}
                  className="border-b border-ice-850 align-top"
                >
                  <td className="max-w-[16rem] p-2">
                    <RenameControl
                      sessionId={recording.id}
                      title={recording.title}
                      fetchImpl={labelFetchImpl}
                      onRenamed={(label) => renamed(recording.id, label)}
                    />
                  </td>
                  <td className="figures p-2">{recording.lanes}</td>
                  <td className="figures p-2">{recording.landed}</td>
                  <td className="figures p-2">{formatDuration(recording.durationMs)}</td>
                  <td className="figures p-2" title={costHoverTitle(recording)}>
                    {formatCost(recording)}
                    {costSuffix(recording) !== null && (
                      <span className="ml-1 text-ice-400">{costSuffix(recording)}</span>
                    )}
                    {isCostGap(recording) && (
                      <span data-testid={`recording-cost-gap-${recording.id}`} className="ml-1 text-ice-400">
                        (no cost feed)
                      </span>
                    )}
                  </td>
                  <td className="p-2" title={captureHoverTitle(recording)}>
                    {formatCapture(recording)}
                    {isCaptureGap(recording) && (
                      <span data-testid={`recording-capture-gap-${recording.id}`} className="ml-1 text-ice-400">
                        ⚠
                      </span>
                    )}
                  </td>
                  <td className="p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        data-testid={`recording-open-${recording.id}`}
                        onClick={() => openInReplay(recording.id)}
                        className="rounded border border-ice-700 px-2 py-1 normal-case tracking-normal text-ice-200 hover:border-ice-400 hover:text-ice-050"
                      >
                        open in replay
                      </button>
                      <button
                        type="button"
                        data-testid={`recording-export-${recording.id}`}
                        disabled={exportingId === recording.id}
                        onClick={() => void doExport(recording.id)}
                        title="download the portable record — manifest + hash-chained log, captured transcripts included when this recording has them"
                        className="rounded border border-ice-700 px-2 py-1 normal-case tracking-normal text-ice-200 hover:border-ice-400 hover:text-ice-050 disabled:opacity-50"
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
      </div>
    </div>
  )
}
