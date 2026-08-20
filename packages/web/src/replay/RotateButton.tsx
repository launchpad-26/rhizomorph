import { BUTTON, BUTTON_PRIMARY } from '../ui/controls.js'
import { useState } from 'react'
import { bootExplanation } from '../app/StatusBar.js'
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
 *
 * **The acknowledgement reaches the surface the operator is looking at
 * (#592).** The `rotated` boot-reason voice already existed and is well
 * written — but it renders in the provenance bar at the foot of the page, and
 * only as the session line's `title`, so the operator who pressed this button
 * never encountered it. {@link rotatedVoice} is that same sentence,
 * `bootExplanation`'s own, rendered beside the button. It is IMPORTED rather
 * than restated on purpose: prd-30's whole point is that two surfaces must not
 * phrase one condition differently, so there is exactly one place the wording
 * lives and both surfaces read it.
 */

/**
 * The `rotated` sentence, from the one voice that owns it.
 *
 * The two numbers are placeholders for a switch arm that reads neither: the
 * `rotated` case of `bootExplanation` names no window and no resume count.
 * `resumedCount: 0` is true of a rotation regardless (the rotate route records
 * exactly that as the new session's boot facts — spelled without its path, so
 * this file keeps naming no route at all, which is the mutating-calls law's
 * own rule for the buttons), and `resumeWindowMs` is a fact this surface has
 * not fetched and the arm never asks for. Anything else would be inventing a
 * figure to satisfy a shape, which is what `bootExplanation`'s own header
 * refuses to do.
 *
 * Called at render rather than evaluated at module scope, so this module's
 * import of a sibling *page* module can never be an initialisation-order
 * hazard — the string is one `switch` over a literal, so there is nothing to
 * save.
 */
function rotatedVoice(): string {
  return bootExplanation({ lastBootReason: 'rotated', resumedCount: 0, resumeWindowMs: 0 })
}

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
        className={armed ? BUTTON_PRIMARY : BUTTON}
      >
        {working ? 'ending session…' : armed ? 'confirm: end session' : 'end session · start fresh'}
      </button>

      {armed && (
        <button
          type="button"
          onClick={() => setPhase({ status: 'idle' })}
          className="normal-case tracking-normal text-(--ink-dim) underline decoration-dotted hover:text-(--ink-primary)"
        >
          cancel
        </button>
      )}

      {phase.status === 'done' && (
        <span role="status" className="inline-flex flex-col gap-0.5 normal-case tracking-normal">
          <span data-testid="rotate-result" className="text-(--ink-dim)">
            closed session {phase.rotation.closed.sessionId} ({phase.rotation.closed.eventCount.toLocaleString()}{' '}
            events) · now recording {phase.rotation.opened.sessionId}
          </span>
          {/* `--ink-dim` is the dimmest ink text may legally wear — prd9's
              legibility floor (`theme/contrast.ts`), and the role is what
              carries it into light, where the floor is a different hex
              entirely; anything below it is structure, never a sentence. */}
          <span data-testid="rotate-acknowledgement" className="text-(--ink-dim)">
            {rotatedVoice()}
          </span>
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
