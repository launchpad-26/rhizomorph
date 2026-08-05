import { useState } from 'react'
import { requestRotation, type RotateFetchLike, type RotationSummary } from './rotate.js'

/**
 * "END SESSION · START FRESH" (prd16 ruling 2) — the operator's explicit
 * session boundary, and the only button in this app that changes anything.
 *
 * **One confirm, not a ceremony.** The button arms itself on the first click
 * and does the thing on the second, in place: no modal, no typed
 * confirmation, no dialog to dismiss. Arming in place rather than through
 * `window.confirm` keeps the decision inside the surface that shows what is
 * about to end, and keeps it testable without stubbing a browser dialog.
 *
 * What it says afterwards is what an operator needs to find the recording
 * again: the id of the session that just closed, and how many events it holds.
 * The provenance line names the new session on its own (`app/StatusBar.tsx`
 * re-reads the meta route when the live session's identity changes), and
 * `onRotated` is how the picker learns to list the freshly-closed one.
 */

export interface RotateButtonProps {
  /** Called after a successful rotation — the replay picker refreshes its listing. */
  onRotated?: (rotation: RotationSummary) => void
  /** Test-only escape hatch for injecting the mutating fetch. */
  fetchImpl?: RotateFetchLike
}

type Phase =
  | { status: 'idle' }
  | { status: 'armed' }
  | { status: 'working' }
  | { status: 'done'; rotation: RotationSummary }
  | { status: 'failed'; message: string }

const BUTTON_CLASS =
  'rounded border px-2 py-1 normal-case tracking-normal disabled:opacity-50 border-ice-700 text-ice-200 hover:border-ice-400 hover:text-ice-050'
const ARMED_CLASS =
  'rounded border px-2 py-1 normal-case tracking-normal disabled:opacity-50 border-ice-400 text-ice-050'

export function RotateButton({ onRotated, fetchImpl }: RotateButtonProps = {}) {
  const [phase, setPhase] = useState<Phase>({ status: 'idle' })
  const armed = phase.status === 'armed'
  const working = phase.status === 'working'

  async function rotate() {
    setPhase({ status: 'working' })
    try {
      const rotation = await requestRotation(fetchImpl)
      setPhase({ status: 'done', rotation })
      onRotated?.(rotation)
    } catch (err) {
      setPhase({ status: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        data-testid="rotate-button"
        data-armed={armed ? 'true' : 'false'}
        disabled={working}
        onClick={() => {
          if (armed) void rotate()
          else setPhase({ status: 'armed' })
        }}
        title={
          armed
            ? 'Click again to close this session and start a new one — the closed recording stays, and stays replayable'
            : 'Close the current session log and start a fresh one. Nothing outside the instrument’s own data directory is touched.'
        }
        className={armed ? ARMED_CLASS : BUTTON_CLASS}
      >
        {working ? 'ending session…' : armed ? 'confirm: end session' : 'end session · start fresh'}
      </button>

      {armed && (
        <button
          type="button"
          onClick={() => setPhase({ status: 'idle' })}
          className="normal-case tracking-normal text-ice-400 underline decoration-dotted hover:text-ice-200"
        >
          cancel
        </button>
      )}

      {phase.status === 'done' && (
        <span data-testid="rotate-result" role="status" className="normal-case tracking-normal text-ice-400">
          closed session {phase.rotation.closed.sessionId} ({phase.rotation.closed.eventCount.toLocaleString()}{' '}
          events) · now recording {phase.rotation.opened.sessionId}
        </span>
      )}

      {phase.status === 'failed' && (
        <span data-testid="rotate-error" role="status" className="normal-case tracking-normal text-broken">
          {phase.message}
        </span>
      )}
    </span>
  )
}
