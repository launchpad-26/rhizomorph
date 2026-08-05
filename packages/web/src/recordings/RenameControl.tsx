import { useState } from 'react'
import { requestLabel, type LabelFetchLike } from './label.js'

/**
 * RENAME IN PLACE (prd16 ruling 4, item 2) — the recordings library's own
 * front door onto the label sidecar (`log/label.ts`). The title shown is
 * exactly `SessionListing.title` (a label if one exists, else the
 * auto-title); clicking it opens an editable draft, and saving is this
 * app's second mutating call (`label.ts`, `mutating-calls-law.test.ts`).
 *
 * Same "arm, then act" discipline `RotateButton` (the app's first mutating
 * control) already keeps: nothing is sent until the operator explicitly
 * confirms, and a failed save says so instead of silently reverting the
 * title as if nothing had been typed.
 */
export interface RenameControlProps {
  sessionId: string
  /** The row's current title — a label if the operator set one, else the auto-title. */
  title: string
  /** Called with the newly-saved label once the server confirms it. */
  onRenamed?: (label: string) => void
  /** Test-only escape hatch for injecting the mutating fetch. */
  fetchImpl?: LabelFetchLike
}

type Phase =
  | { status: 'idle' }
  | { status: 'editing'; draft: string }
  | { status: 'saving'; draft: string }
  | { status: 'failed'; draft: string; message: string }

export function RenameControl({ sessionId, title, onRenamed, fetchImpl }: RenameControlProps) {
  const [phase, setPhase] = useState<Phase>({ status: 'idle' })

  if (phase.status === 'idle') {
    return (
      <button
        type="button"
        data-testid={`rename-start-${sessionId}`}
        onClick={() => setPhase({ status: 'editing', draft: title })}
        title="rename this recording"
        className="max-w-full truncate text-left font-mono text-ice-100 underline decoration-dotted hover:text-ice-050"
      >
        {title}
      </button>
    )
  }

  const saving = phase.status === 'saving'
  const draft = phase.draft

  async function save() {
    const trimmed = draft.trim()
    if (trimmed.length === 0) {
      setPhase({ status: 'failed', draft, message: 'label must not be empty' })
      return
    }
    setPhase({ status: 'saving', draft: trimmed })
    try {
      const outcome = await requestLabel(sessionId, trimmed, fetchImpl)
      setPhase({ status: 'idle' })
      onRenamed?.(outcome.label)
    } catch (err) {
      setPhase({ status: 'failed', draft: trimmed, message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <span className="inline-flex items-center gap-2">
        <input
          data-testid={`rename-input-${sessionId}`}
          value={draft}
          disabled={saving}
          onChange={(event) => setPhase({ status: 'editing', draft: event.target.value })}
          className="min-w-0 rounded border border-ice-700 bg-ice-1000 px-2 py-1 font-mono text-ice-100"
        />
        <button
          type="button"
          data-testid={`rename-save-${sessionId}`}
          disabled={saving}
          onClick={() => void save()}
          className="shrink-0 rounded border border-ice-400 px-2 py-1 normal-case tracking-normal text-ice-050 disabled:opacity-50"
        >
          {saving ? 'saving…' : 'save'}
        </button>
        <button
          type="button"
          data-testid={`rename-cancel-${sessionId}`}
          disabled={saving}
          onClick={() => setPhase({ status: 'idle' })}
          className="shrink-0 normal-case tracking-normal text-ice-400 underline decoration-dotted hover:text-ice-200 disabled:opacity-50"
        >
          cancel
        </button>
      </span>
      {phase.status === 'failed' && (
        <span
          data-testid={`rename-error-${sessionId}`}
          role="status"
          className="normal-case tracking-normal text-broken"
        >
          {phase.message}
        </span>
      )}
    </span>
  )
}
