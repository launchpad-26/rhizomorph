import { useState } from 'react'
import { copyToClipboard, type CopyText } from '../drawer/AttachButton.js'
import { requestInstrument, type InstrumentFetchLike, type InstrumentOutcome, type MigrationFact } from './instrument.js'

/**
 * "INSTRUMENT THIS SESSION" (prd-20 rulings 3 and 6) — the operator's explicit
 * act of relaunching their own conductor, wired, on the conversation they
 * already have.
 *
 * **It never reaches the server itself.** Every byte this component sends goes
 * through `./instrument.js`, the app's fourth mutating call and the one module
 * that documents why that call is allowed to exist; there is no url and no
 * request in this file at all. `replay/mutating-calls-law.test.ts` polices
 * that across the whole app, and `explicit-invocation-law.test.ts` polices
 * this directory in particular.
 *
 * **One confirmation, and it is the whole gate** (prd-14 ruling 4). This
 * spawns a real process that spends real money, so the first click only arms
 * the act: it shows what is about to happen and what it costs, and the button
 * on THAT panel is the single call site the law pins. There is no second
 * dialog after it, and — the part the law actually proves — there is no timer
 * and no effect in this directory that could reach the act without a human.
 *
 * **What it says afterwards is the honest account, not the happy one**
 * (ruling 6, ADR-0020). Three facts travel with every success and none of
 * them is optional copy: the conversation resumes under the SAME sessionId;
 * the original transcript was never touched; and the OLD process keeps running
 * until the operator ends it, so anything typed there from now on is a fork
 * this instrument sees only through a transcript tail. Telemetry never
 * back-fills either — the relaunched process is measured from its first turn
 * and no earlier.
 */

export interface InstrumentButtonProps {
  /** The conversation to resume — a session id the event log already recorded. */
  sessionId: string
  /**
   * What the operator should run themselves when the instrument cannot reach a
   * transcript. Supplied by the page, which is what knows this server's port
   * and env recipe; this component invents no command of its own, and says so
   * plainly when it has none to show.
   */
  manualCommand?: string
  /** Called after a successful relaunch — the page refreshes whatever it shows about the conductor. */
  onInstrumented?: (outcome: InstrumentOutcome) => void
  /** Test-only escape hatch for the one write this component makes. */
  fetchImpl?: InstrumentFetchLike
  /** Test seam for the clipboard — the same shape `drawer/AttachButton.tsx` uses. */
  onCopy?: CopyText
  /** The page owns the test ids; every element below derives its own from this one. */
  'data-testid'?: string
}

type Phase =
  | { status: 'idle' }
  | { status: 'confirming' }
  | { status: 'working' }
  | { status: 'done'; outcome: InstrumentOutcome }
  | { status: 'failed'; message: string }

type CopyState = 'idle' | 'copied' | 'failed'

/** What the copy actually did, said in the operator's terms rather than the flag's. */
const MIGRATION_SENTENCE: Record<MigrationFact, string> = {
  migrated: 'the transcript was copied into this repo’s harness state directory — the original was left exactly as it was',
  'already-present': 'the transcript was already in this repo’s harness state directory — nothing was copied or overwritten',
  'not-needed': 'no copy was needed — this conversation already lives where the harness looks for it',
}

const BUTTON_CLASS =
  'rounded border px-2 py-1 normal-case tracking-normal disabled:opacity-50 border-ice-700 text-ice-200 hover:border-ice-400 hover:text-ice-050'
const CONFIRM_CLASS =
  'rounded border px-2 py-1 normal-case tracking-normal disabled:opacity-50 border-ice-400 text-ice-050'

export function InstrumentButton({
  sessionId,
  manualCommand,
  onInstrumented,
  fetchImpl,
  onCopy = copyToClipboard,
  'data-testid': testId = 'instrument-button',
}: InstrumentButtonProps) {
  const [phase, setPhase] = useState<Phase>({ status: 'idle' })
  const [copied, setCopied] = useState<CopyState>('idle')

  /** The ONE confirmation ruling 4 asks for — the only place this component calls the one write it has. */
  async function confirmInstrument() {
    setPhase({ status: 'working' })
    try {
      const outcome = await requestInstrument({ sessionId }, fetchImpl)
      setPhase({ status: 'done', outcome })
      onInstrumented?.(outcome)
    } catch (err) {
      setPhase({ status: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div data-testid={testId} className="flex flex-col gap-2">
      {phase.status === 'idle' && (
        <button
          type="button"
          data-testid={`${testId}-start`}
          onClick={() => setPhase({ status: 'confirming' })}
          title="Relaunch this repo’s conductor, instrumented, on this same conversation."
          className={BUTTON_CLASS}
        >
          instrument this session
        </button>
      )}

      {phase.status === 'confirming' && (
        <div data-testid={`${testId}-confirm-dialog`} className="flex flex-col gap-2 rounded border border-ice-700 p-3">
          <p className="text-[12px] text-ice-100">
            Relaunch the conductor on session {sessionId}, instrumented?
          </p>
          <p className="text-[11px] text-ice-400">
            The conversation resumes under this same id, and the transcript it resumes from is only ever copied —
            never moved, never edited. The process you are using now is not stopped: it keeps running until you end
            it, and anything typed there after this point belongs to a fork this instrument can see only through a
            transcript tail. Measurement starts at the relaunch and never back-fills.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid={`${testId}-cancel`}
              onClick={() => setPhase({ status: 'idle' })}
              className={BUTTON_CLASS}
            >
              cancel
            </button>
            <button
              type="button"
              data-testid={`${testId}-confirm`}
              onClick={() => void confirmInstrument()}
              className={CONFIRM_CLASS}
            >
              instrument
            </button>
          </div>
        </div>
      )}

      {phase.status === 'working' && (
        <p data-testid={`${testId}-in-flight`} className="text-[12px] text-ice-400">
          relaunching…
        </p>
      )}

      {phase.status === 'done' && phase.outcome.kind === 'instrumented' && (
        <div data-testid={`${testId}-result`} className="flex flex-col gap-1 rounded border border-ice-700 p-3">
          <p className="text-[12px] text-ice-100">
            {phase.outcome.spawn.launched
              ? `the conductor was started (pid ${phase.outcome.spawn.pid}) on session ${phase.outcome.sessionId} — the same id, not a new one`
              : `session ${phase.outcome.sessionId} was prepared, but the process could not be started`}
          </p>
          <p data-testid={`${testId}-migration`} className="text-[12px] text-ice-300">
            {MIGRATION_SENTENCE[phase.outcome.migration]}
          </p>
          {phase.outcome.spawn.launched === false && (
            <p role="status" data-testid={`${testId}-spawn-error`} className="text-[12px] text-broken">
              {phase.outcome.spawn.message}
            </p>
          )}
          <p className="text-[11px] text-ice-400">
            The process you were using is still running — this started a second one and stopped nothing. End the old
            one yourself, or the two conversations diverge from here with nothing in either file marking the fork.
            Nothing the old process already spent reaches this instrument’s record: measurement starts now.
          </p>
        </div>
      )}

      {phase.status === 'done' && phase.outcome.kind === 'no-transcript-reachable' && (
        <div data-testid={`${testId}-no-transcript`} className="flex flex-col gap-1 rounded border border-ice-700 p-3">
          <p role="status" className="text-[12px] text-ice-100">
            there is no transcript this instrument can reach for session {sessionId}, so nothing was copied and
            nothing was started — {phase.outcome.reason}
          </p>
          {manualCommand === undefined ? (
            <p className="text-[11px] text-ice-400">
              Start the harness yourself in this repo; this page has no command to hand you for it.
            </p>
          ) : (
            <>
              <p className="text-[11px] text-ice-400">Run this yourself, in the repo, and the instrument will pick it up:</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid={`${testId}-copy`}
                  onClick={() => {
                    void onCopy(manualCommand).then(
                      () => setCopied('copied'),
                      () => setCopied('failed'),
                    )
                  }}
                  className={BUTTON_CLASS}
                >
                  copy
                </button>
                {copied !== 'idle' && (
                  <span role="status" className="text-[10px] text-ice-400">
                    {copied === 'copied' ? 'copied to clipboard' : 'clipboard unavailable — copy it by hand'}
                  </span>
                )}
              </div>
              {/* Always visible, always the exact string — the fallback that works when the clipboard does not. */}
              <code
                data-testid={`${testId}-command`}
                className="mt-1 block overflow-x-auto whitespace-pre rounded bg-ice-1000 px-2 py-1 font-mono text-[11px] text-ice-200"
              >
                {manualCommand}
              </code>
            </>
          )}
        </div>
      )}

      {phase.status === 'failed' && (
        <div className="flex flex-col gap-2">
          <p role="status" data-testid={`${testId}-error`} className="text-[12px] text-broken">
            {phase.message}
          </p>
          <button
            type="button"
            data-testid={`${testId}-back`}
            onClick={() => setPhase({ status: 'idle' })}
            className={BUTTON_CLASS}
          >
            back
          </button>
        </div>
      )}
    </div>
  )
}
