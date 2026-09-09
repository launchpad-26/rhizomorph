import { useState } from 'react'
import { type MeasureFetchLike, type MeasureOutcome, requestMeasure } from '../measure.js'
import type { LabExperiment } from '../types.js'

/**
 * THE MEASURE CONTROL (prd-55 ruling 7 — measuring is a control). Until this
 * wave the lab's measure route existed and worked and nothing on the page
 * called it; the guide said so. Every experiment panel now carries one of
 * these: a gate command field, defaulting to the CLI's own `--verify` default,
 * and one *measure* button.
 *
 * Measuring is a write twice over (prd53 ruling 3): the gate really runs, in
 * every run's worktree — real minutes of CPU — and one `fork.measured` lands on
 * the record per run. So it wears the launch's shape of permission: an explicit
 * click, ONE confirmation that names how many worktrees the gate will run in,
 * and only then the app's sixth mutating call — `../measure.js`, the one module
 * that reaches the route and the one that names it; this file names neither
 * the verb nor the path, so `replay/mutating-calls-law.test.ts` reads it as
 * the caller it is. A refusal is printed verbatim. Success is reported here and
 * handed up, so the workspace re-reads its experiments and the verdicts reach
 * Compare and Metrics without a reload.
 */

/**
 * The CLI's own default for `lab compare --verify` (`packages/server/src/cli/
 * lab-compare.ts`, `DEFAULT_VERIFY`) — restated here because a web module may
 * not import the server, and pinned to it by the guide law so the two cannot
 * drift apart in silence.
 */
export const DEFAULT_GATE_COMMAND = 'npm test'

export interface MeasureControlProps {
  experiment: LabExperiment
  /** Told once a measurement has been recorded — the workspace re-reads its experiments. */
  onMeasured?: (outcome: MeasureOutcome) => void
  /** Test-only escape hatch for the one write this control makes. */
  measureFetchImpl?: MeasureFetchLike
}

type Phase =
  | { status: 'configuring' }
  | { status: 'confirming' }
  | { status: 'measuring' }
  | { status: 'done'; outcome: MeasureOutcome }
  | { status: 'failed'; message: string }

/** Every run of every arm is its own worktree (prd53 ruling 1) — the count the confirmation names, and the count of gates that will run. */
export function worktreeCount(experiment: LabExperiment): number {
  return experiment.arms.reduce((count, arm) => count + arm.runs.length, 0)
}

function verdictCounts(outcome: MeasureOutcome): { pass: number; fail: number; notRun: number } {
  let pass = 0
  let fail = 0
  let notRun = 0
  for (const run of outcome.measured) {
    if (run.verified === 'pass') pass += 1
    else if (run.verified === 'fail') fail += 1
    else notRun += 1
  }
  return { pass, fail, notRun }
}

export function MeasureControl({ experiment, onMeasured, measureFetchImpl }: MeasureControlProps) {
  const [command, setCommand] = useState(DEFAULT_GATE_COMMAND)
  const [phase, setPhase] = useState<Phase>({ status: 'configuring' })
  const id = experiment.forkId
  const worktrees = worktreeCount(experiment)
  const gate = command.trim()
  const busy = phase.status === 'confirming' || phase.status === 'measuring'

  // The ONE confirmation's confirm — the only place this component calls the
  // one write it has. Declared as an arrow-assigned const, deliberately, not
  // as a named function: this file's own grep suite (below) counts the exact
  // call-site text, and a named function's own head would match that same
  // text a second time, spuriously.
  const confirmMeasure = async (): Promise<void> => {
    setPhase({ status: 'measuring' })
    try {
      // The field's command travels as typed (trimmed). A blank field sends no
      // command at all, so the server's own default rules and is recorded as
      // the command that judged the runs.
      const outcome = await requestMeasure({ forkId: id, ...(gate.length > 0 ? { verifyCommand: gate } : {}) }, measureFetchImpl)
      setPhase({ status: 'done', outcome })
      onMeasured?.(outcome)
    } catch (err) {
      setPhase({ status: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div data-testid={`measure-control-${id}`} className="flex flex-col gap-2 border-(--line-hair) border-t pt-2 text-read-body">
      <div className="flex flex-wrap items-center gap-2">
        <span className="heading text-(--ink-dim)">measure</span>
        <label className="flex items-center gap-2 text-(--ink-dim)">
          gate command
          <input
            data-testid={`measure-command-${id}`}
            aria-label={`gate command for experiment ${id}`}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            disabled={busy}
            className="figures min-w-0 rounded-none border border-(--line-hair) bg-(--surface-panel) px-2 py-1 text-(--ink-body)"
          />
        </label>
        <button
          type="button"
          data-testid={`measure-${id}`}
          onClick={() => setPhase({ status: 'confirming' })}
          disabled={busy || worktrees === 0}
          className="focus-ring rounded-none border border-(--line-strong) px-2 py-1 text-(--ink-body) disabled:opacity-40"
        >
          measure
        </button>
        {worktrees === 0 ? (
          <span data-testid={`measure-nothing-${id}`} className="text-(--ink-dim)">
            nothing to measure — no run was dispatched under this experiment
          </span>
        ) : null}
      </div>

      {phase.status === 'confirming' ? (
        <div data-testid={`measure-confirm-dialog-${id}`} className="flex flex-col gap-2 rounded-none border border-(--line-strong) p-3">
          <p className="text-(--ink-body)">
            Run <span className="figures">{gate.length > 0 ? gate : DEFAULT_GATE_COMMAND}</span> in {worktrees} worktree
            {worktrees === 1 ? '' : 's'} — every run of every arm of {id} — and record a verdict for each? Real minutes of
            CPU, and each verdict lands on the record as a fork.measured (prd53 ruling 3).
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid={`measure-cancel-${id}`}
              onClick={() => setPhase({ status: 'configuring' })}
              className="rounded-none border border-(--line-hair) px-2 py-1 text-(--ink-dim) hover:text-(--ink-body)"
            >
              cancel
            </button>
            <button
              type="button"
              data-testid={`measure-confirm-${id}`}
              onClick={() => void confirmMeasure()}
              className="rounded-none border border-(--line-strong) px-2 py-1 text-(--ink-primary)"
            >
              measure {worktrees} worktree{worktrees === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      ) : null}

      {phase.status === 'measuring' ? (
        <p data-testid={`measure-in-flight-${id}`} className="text-(--ink-dim)">
          measuring — the gate is running in {worktrees} worktree{worktrees === 1 ? '' : 's'}…
        </p>
      ) : null}

      {phase.status === 'failed' ? (
        <div className="flex flex-col gap-1">
          <p role="status" data-testid={`measure-error-${id}`} className="text-broken">
            {phase.message}
          </p>
          <button type="button" onClick={() => setPhase({ status: 'configuring' })} className="w-fit text-(--ink-dim) underline">
            back
          </button>
        </div>
      ) : null}

      {phase.status === 'done'
        ? (() => {
            const { pass, fail, notRun } = verdictCounts(phase.outcome)
            return (
              <p data-testid={`measure-result-${id}`} className="text-(--ink-dim)">
                measured {phase.outcome.measured.length} run{phase.outcome.measured.length === 1 ? '' : 's'} with{' '}
                <span className="figures">{phase.outcome.verifyCommand}</span> — {pass} passed, {fail} failed, {notRun} not run.
                The verdicts are on the record; the comparison above reads them.
              </p>
            )
          })()
        : null}
    </div>
  )
}
