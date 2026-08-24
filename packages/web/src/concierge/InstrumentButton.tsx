import { BUTTON, BUTTON_PRIMARY } from '../ui/controls.js'
import { useState } from 'react'
import { copyToClipboard, type CopyText } from '../drawer/AttachButton.js'
import { requestInstrument, type InstrumentFetchLike, type InstrumentOutcome, type MigrationKind } from './instrument.js'

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
 * on THAT panel is the call site the law pins for this file. There is no second
 * dialog after it, and — the part the law actually proves — there is no timer
 * and no effect in this directory that could reach the act without a human.
 * `../connect/wizard.tsx` is the relaunch's other caller since #266 and holds
 * the same bar; the law pins the caller SET and both arming shapes, so neither
 * file's claim rests on this paragraph.
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
const MIGRATION_SENTENCE: Record<MigrationKind, string> = {
  migrated: 'the transcript was copied into this repo’s harness state directory — the original was left exactly as it was',
  'already-present': 'the transcript was already in this repo’s harness state directory — nothing was copied or overwritten',
  'not-needed': 'no copy was needed — this conversation already lives where the harness looks for it',
  'copy-failed': 'the transcript could not be copied — the relaunch went ahead against whatever the harness already had',
}


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
      // Both fields spelled out rather than left to the module's defaults: this
      // button asks for exactly one thing — claude, resuming this one named
      // conversation — and #266 gave that request two other shapes it must
      // never silently drift into.
      const outcome = await requestInstrument({ harness: 'claude', mode: 'resume', sessionId }, fetchImpl)
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
          className={BUTTON}
        >
          instrument this session
        </button>
      )}

      {phase.status === 'confirming' && (
        <div data-testid={`${testId}-confirm-dialog`} className="flex flex-col gap-2 rounded-none border border-(--line-strong) p-3">
          <p className="text-read-body text-(--ink-primary)">
            Relaunch the conductor on session {sessionId}, instrumented?
          </p>
          <p className="text-read-floor text-(--ink-dim)">
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
              className={BUTTON}
            >
              cancel
            </button>
            <button
              type="button"
              data-testid={`${testId}-confirm`}
              onClick={() => void confirmInstrument()}
              className={BUTTON_PRIMARY}
            >
              instrument
            </button>
          </div>
        </div>
      )}

      {phase.status === 'working' && (
        <p data-testid={`${testId}-in-flight`} className="text-read-body text-(--ink-dim)">
          relaunching…
        </p>
      )}

      {phase.status === 'done' && phase.outcome.kind === 'instrumented' && (
        <div data-testid={`${testId}-result`} className="flex flex-col gap-1 rounded-none border border-(--line-strong) p-3">
          <p className="text-read-body text-(--ink-primary)">
            {phase.outcome.spawn.launched
              ? `the conductor was started (pid ${phase.outcome.spawn.pid}) on session ${sessionId} — the same id, not a new one`
              : `session ${sessionId} was prepared, but the process could not be started`}
          </p>
          {/* WHERE IT WENT, when the server said (#532). A tmux window is a
              surface the operator can attach to and type into; a detached
              process is not, and an interactive harness with no terminal is
              exactly what #532 found exiting on its own. Saying which is the
              difference between "go here" and "watch and see". */}
          {phase.outcome.spawn.launched && (
            <p data-testid={`${testId}-where`} className="text-read-floor text-(--ink-body)">
              {phase.outcome.spawn.via === 'tmux'
                ? `it is running in the tmux window ${phase.outcome.spawn.window} — attach with \`tmux attach -t ${phase.outcome.spawn.window}\` to type in it`
                : 'it was started detached, with no terminal attached — nothing here can type in it, and an interactive harness with nobody attached may exit on its own (#532). If it does, run the harness yourself in a terminal.'}
            </p>
          )}
          {/* This button only ever asks for a resume, so a `null` migration —
              the route's "nothing to migrate", true on `launch` and `continue`
              — is a shape it cannot produce. Rendered as nothing rather than
              as a fabricated sentence: an answer this component did not ask
              for is not one it should narrate. */}
          {phase.outcome.migration !== null && (
            <p data-testid={`${testId}-migration`} className="text-read-body text-(--ink-body)">
              {MIGRATION_SENTENCE[phase.outcome.migration.kind]}
            </p>
          )}
          {phase.outcome.spawn.launched === false && (
            <p role="status" data-testid={`${testId}-spawn-error`} className="text-read-body text-broken">
              {phase.outcome.spawn.message}
            </p>
          )}
          <p className="text-read-floor text-(--ink-dim)">
            The process you were using is still running — this started a second one and stopped nothing. End the old
            one yourself, or the two conversations diverge from here with nothing in either file marking the fork.
            Nothing the old process already spent reaches this instrument’s record: measurement starts now.
          </p>
        </div>
      )}

      {phase.status === 'done' && phase.outcome.kind === 'no-transcript-reachable' && (
        <div data-testid={`${testId}-no-transcript`} className="flex flex-col gap-1 rounded-none border border-(--line-strong) p-3">
          <p role="status" className="text-read-body text-(--ink-primary)">
            there is no transcript this instrument can reach for session {sessionId}, so nothing was copied and
            nothing was started — {phase.outcome.reason}
          </p>
          {manualCommand === undefined ? (
            <p className="text-read-floor text-(--ink-dim)">
              Start the harness yourself in this repo; this page has no command to hand you for it.
            </p>
          ) : (
            <>
              <p className="text-read-floor text-(--ink-dim)">Run this yourself, in the repo, and the instrument will pick it up:</p>
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
                  className={BUTTON}
                >
                  copy
                </button>
                {copied !== 'idle' && (
                  <span role="status" className="text-read-floor text-(--ink-dim)">
                    {copied === 'copied' ? 'copied to clipboard' : 'clipboard unavailable — copy it by hand'}
                  </span>
                )}
              </div>
              {/* Always visible, always the exact string — the fallback that works when the clipboard does not. */}
              <code
                data-testid={`${testId}-command`}
                className="mt-1 block overflow-x-auto whitespace-pre rounded-none bg-(--surface-floor) px-2 py-1 font-mono text-inst text-(--ink-primary)"
              >
                {manualCommand}
              </code>
            </>
          )}
        </div>
      )}

      {phase.status === 'failed' && (
        <div className="flex flex-col gap-2">
          <p role="status" data-testid={`${testId}-error`} className="text-read-body text-broken">
            {phase.message}
          </p>
          <button
            type="button"
            data-testid={`${testId}-back`}
            onClick={() => setPhase({ status: 'idle' })}
            className={BUTTON}
          >
            back
          </button>
        </div>
      )}
    </div>
  )
}
