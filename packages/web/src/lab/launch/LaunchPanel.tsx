import { useCallback, useEffect, useState } from 'react'
import type { FetchLike } from '../../replay/api.js'
import { fetchLabCheckpoints } from '../api.js'
import type { LabCheckpoint } from '../types.js'
import { fetchLabEstimate, type LabEstimate } from './estimate.js'
import { type LaunchArmInput, type LaunchFetchLike, type LaunchOutcome, type LaunchRequest, requestLaunch } from './launch.js'
import { OTHER_MODEL, offeredModels, offerModel, useOfferedModels } from './models.js'

/**
 * THE ACT OF LAUNCHING AN EXPERIMENT (prd14 rulings 2 and 4; prd-55 ruling 7 —
 * the launch tells the whole truth).
 *
 * Four steps, and exactly one of them writes anything to the laboratory:
 *
 * 1. **Checkpoint selection** — the checkpoints the engine actually holds
 *    (`../api.js`'s `fetchLabCheckpoints`, read-only, wave 1's route). Never
 *    a typed-in moment: the operator picks a row, or there is nothing to
 *    launch from.
 * 2. **Free-form arm configuration** (ruling 2) — each arm carries its OWN
 *    model and its OWN brief, edited independently. No shared "experiment
 *    knob", and no warning here about arms differing in more than one
 *    dimension — that guardrail belongs in the comparison surface, which
 *    reports what a confounded run can and cannot conclude. The launcher's
 *    job is to let the operator try three different things, freely. The model
 *    is a `<select>` over the list this repo keeps (`lab.models`, prd-55
 *    ruling 5 — `./models.js` reads it) plus *other…*, which takes a typed
 *    name and writes it into that list for the next launch. A list, never a
 *    gate: the server's grammar is the only thing that refuses a model, in
 *    its own words, printed here verbatim.
 * 3. **Runs per arm and the ceiling override** (prd53 rulings 1 and 6; prd-55
 *    ruling 7) — two fields that travel in the launch body ONLY when set. A
 *    blank field sends no key, so the server's own defaults rule and nothing
 *    here restates them.
 * 4. **Estimate and ONE confirmation** (ruling 4) — reviewing fetches
 *    `/api/lab/estimate` for arms × runs (a read) and shows its basis on
 *    screen; the single "launch" button on that same screen is the one write
 *    this component ever makes (`./launch.js`'s `requestLaunch`, the app's
 *    third mutating call). There is no second dialog after it. A lane whose
 *    rate cannot be established is not a fault, and the panel says so in the
 *    quiet ink, never the alarm's.
 */

export interface LaunchPanelProps {
  /** Test-only escape hatch for every read this panel makes (checkpoints, estimate). */
  fetchImpl?: FetchLike
  /** Test-only escape hatch for the one write this panel makes. */
  launchFetchImpl?: LaunchFetchLike
  /**
   * The checkpoint to start with selected — the Workspace's seated marker, whose
   * *fork from here* is the one place that action lives (prd53 S1). The operator
   * can still pick another row; this only seats the first.
   */
  initialCheckpointId?: string | null
  /**
   * Told once per launch, with the outcome — how the Workspace learns of a
   * PARTIAL launch (prd53 ruling 7): the arms that failed are known only to
   * the launch that saw them; the record holds no intent event. The outcome
   * carries how many arms were asked for, so the workspace never has to
   * rebuild that number from what came back.
   */
  onLaunched?: (outcome: LaunchOutcome) => void
}

interface ArmDraft {
  key: string
  /** The select's value: '' for the default model, an offered model, or {@link OTHER_MODEL} while a name is being typed. */
  choice: string
  /** What was typed under other… — the model that travels when `choice` is {@link OTHER_MODEL}. */
  typed: string
  brief: string
}

type CheckpointsState =
  | { status: 'loading' }
  | { status: 'ready'; items: LabCheckpoint[] }
  | { status: 'error'; message: string }

type Phase =
  | { status: 'configuring' }
  | { status: 'estimating' }
  | { status: 'confirming'; estimate: LabEstimate }
  | { status: 'estimate-failed'; message: string }
  | { status: 'launching' }
  | { status: 'done'; outcome: LaunchOutcome }
  | { status: 'launch-failed'; message: string }

let armKeySeq = 0
function freshArm(): ArmDraft {
  armKeySeq += 1
  return { key: `arm-${armKeySeq}`, choice: '', typed: '', brief: '' }
}

const DEFAULT_ARM_COUNT = 3

/** The model an arm names — the typed one under other…, else the chosen one. Blank is the default model and travels as no model at all. */
function armModel(arm: ArmDraft): string {
  return (arm.choice === OTHER_MODEL ? arm.typed : arm.choice).trim()
}

function toLaunchArm(arm: ArmDraft): LaunchArmInput {
  const model = armModel(arm)
  const brief = arm.brief.trim()
  return {
    ...(model.length > 0 ? { model } : {}),
    ...(brief.length > 0 ? { brief } : {}),
  }
}

/**
 * A count typed into *runs per arm* or *ceiling override*: ABSENT when the
 * field is blank — the server's own default rules, and the launch body carries
 * no key at all — and otherwise the number as typed, whatever it is. The panel
 * does not pre-judge it: `"runs" must be a positive integer when present` is
 * the server's sentence, and this panel prints refusals verbatim (prd53 ruling
 * 6's own refusal names the override to pass), so a bad value meets its
 * explanation rather than a disabled button with none.
 */
function typedCount(text: string): number | undefined {
  const trimmed = text.trim()
  return trimmed.length === 0 ? undefined : Number(trimmed)
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`
}

function formatWindow(windowMs: number): string {
  const hours = windowMs / 3_600_000
  return hours === 1 ? 'the last hour' : `the last ${hours}h`
}

/** What the estimate counted, in words — arms × runs when the server said so, the arm count alone from an older answer. Never a figure this panel derived itself. */
function lanesBasis(estimate: LabEstimate): string {
  if (estimate.lanes !== undefined && estimate.runs !== undefined) {
    return `${estimate.lanes} spending lane(s) — ${estimate.arms} arm(s) × ${estimate.runs} run(s)`
  }
  return `${estimate.arms} arm(s)`
}

export function LaunchPanel({ fetchImpl, launchFetchImpl, initialCheckpointId = null, onLaunched }: LaunchPanelProps = {}) {
  const [checkpoints, setCheckpoints] = useState<CheckpointsState>({ status: 'loading' })
  const [checkpointId, setCheckpointId] = useState<string | null>(initialCheckpointId)

  // The seated marker moved: follow it while still configuring — a launch in
  // flight keeps the checkpoint it was confirmed against.
  useEffect(() => {
    if (initialCheckpointId !== null) setCheckpointId(initialCheckpointId)
  }, [initialCheckpointId])
  const [arms, setArms] = useState<ArmDraft[]>(() => Array.from({ length: DEFAULT_ARM_COUNT }, freshArm))
  const [runsText, setRunsText] = useState('')
  const [ceilingText, setCeilingText] = useState('')
  const [phase, setPhase] = useState<Phase>({ status: 'configuring' })
  const models = useOfferedModels()

  const loadCheckpoints = useCallback(() => fetchLabCheckpoints(fetchImpl), [fetchImpl])

  useEffect(() => {
    let live = true
    setCheckpoints({ status: 'loading' })
    loadCheckpoints()
      .then((items) => {
        if (live) setCheckpoints({ status: 'ready', items })
      })
      .catch((err) => {
        if (live) setCheckpoints({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      live = false
    }
  }, [loadCheckpoints])

  const selectedCheckpoint: LabCheckpoint | null =
    checkpoints.status === 'ready' ? checkpoints.items.find((c) => c.checkpointId === checkpointId) ?? null : null

  const configuring = phase.status === 'configuring'
  const canReview = configuring && selectedCheckpoint !== null && arms.length >= 1
  const runs = typedCount(runsText)
  const ceilingOverride = typedCount(ceilingText)

  function addArm() {
    setArms((prev) => [...prev, freshArm()])
  }

  function removeArm(key: string) {
    setArms((prev) => (prev.length > 1 ? prev.filter((arm) => arm.key !== key) : prev))
  }

  function updateArm(key: string, field: 'choice' | 'typed' | 'brief', value: string) {
    setArms((prev) => prev.map((arm) => (arm.key === key ? { ...arm, [field]: value } : arm)))
  }

  /**
   * other…'s commit — on blur or Enter. The typed name is written into
   * `lab.models` as an offered key (ruling 5: the list is the operator's, and
   * a name typed here is on the list for the next launch). Once the registry
   * offers it, the select shows it selected; if storage refused the write the
   * arm keeps the typed name under other…, and it still travels in the body.
   */
  function commitTyped(key: string) {
    const arm = arms.find((candidate) => candidate.key === key)
    if (arm === undefined) return
    const stored = offerModel(arm.typed)
    if (stored === null || !offeredModels().includes(stored)) return
    setArms((prev) => prev.map((candidate) => (candidate.key === key ? { ...candidate, choice: stored, typed: '' } : candidate)))
  }

  async function review() {
    if (selectedCheckpoint === null) return
    setPhase({ status: 'estimating' })
    try {
      // Asked for arms × runs when runs is set (prd53 ruling 1: every run is a
      // spending lane); for the arm count alone when it is not, so the server's
      // default of one run is the server's to state.
      const estimate = await fetchLabEstimate(
        selectedCheckpoint.lane,
        runs === undefined ? arms.length : { arms: arms.length, runs },
        fetchImpl,
      )
      setPhase({ status: 'confirming', estimate })
    } catch (err) {
      setPhase({ status: 'estimate-failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  /** The ONE confirmation ruling 4 asks for — the only place this component calls the one write it has. */
  async function confirmLaunch() {
    if (selectedCheckpoint === null) return
    setPhase({ status: 'launching' })
    const request: LaunchRequest = {
      lane: selectedCheckpoint.lane,
      checkpointId: selectedCheckpoint.checkpointId,
      arms: arms.map(toLaunchArm),
      // Only when set (prd-55 ruling 7): a blank field sends no key, so the
      // server's own defaults — one run, the declared ceiling — rule.
      ...(runs === undefined ? {} : { runs }),
      ...(ceilingOverride === undefined ? {} : { ceilingOverride }),
    }
    try {
      const outcome = await requestLaunch(request, launchFetchImpl)
      setPhase({ status: 'done', outcome })
      onLaunched?.(outcome)
    } catch (err) {
      setPhase({ status: 'launch-failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  function startOver() {
    setArms(Array.from({ length: DEFAULT_ARM_COUNT }, freshArm))
    setRunsText('')
    setCeilingText('')
    setCheckpointId(null)
    setPhase({ status: 'configuring' })
  }

  return (
    <div data-testid="launch-panel" className="flex flex-col gap-4">
      {checkpoints.status === 'loading' && <p className="text-ice-400">loading checkpoints…</p>}
      {checkpoints.status === 'error' && (
        <p role="status" data-testid="launch-checkpoints-error" className="text-broken">
          the lab cannot see its checkpoints — {checkpoints.message}
        </p>
      )}
      {checkpoints.status === 'ready' && checkpoints.items.length === 0 && (
        <p data-testid="launch-checkpoints-empty" className="text-ice-400">
          there are no checkpoints yet — capture one with `rhizomorph lab checkpoint &lt;lane&gt;` before launching
        </p>
      )}

      {checkpoints.status === 'ready' && checkpoints.items.length > 0 && (
        <fieldset disabled={!configuring} className="flex flex-col gap-2">
          <legend className="mb-1 text-[11px] uppercase tracking-widest text-ice-400">
            1. checkpoint — a moment the lab actually captured, never one it interpolates
          </legend>
          <div className="flex flex-col gap-1">
            {checkpoints.items.map((checkpoint) => (
              <label
                key={checkpoint.eventId}
                data-testid={`launch-checkpoint-${checkpoint.checkpointId}`}
                className="flex items-center gap-2 text-[12px] text-ice-300"
              >
                <input
                  type="radio"
                  name="launch-checkpoint"
                  checked={checkpointId === checkpoint.checkpointId}
                  onChange={() => setCheckpointId(checkpoint.checkpointId)}
                />
                <span className="text-ice-100">{checkpoint.lane}</span>
                <span className="figures text-ice-400">{checkpoint.checkpointId}</span>
                <span className="figures text-ice-400">{new Date(checkpoint.capturedAt).toLocaleString()}</span>
                <span className="text-ice-400">({checkpoint.capturedBy})</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <fieldset disabled={!configuring} className="flex flex-col gap-2">
        <legend className="mb-1 text-[11px] uppercase tracking-widest text-ice-400">
          2. arms — each with its own model and its own brief (prd14 ruling 2); the models on offer are this repo&apos;s own
          list (prd-55 ruling 5)
        </legend>
        <div className="flex flex-col gap-2">
          {arms.map((arm, index) => (
            <div key={arm.key} data-testid={`launch-arm-${arm.key}`} className="flex items-start gap-2 text-[12px]">
              <span className="figures pt-1 text-ice-400">{index + 1}</span>
              <select
                data-testid={`launch-arm-model-${arm.key}`}
                aria-label={`arm ${index + 1} model`}
                value={arm.choice}
                onChange={(event) => updateArm(arm.key, 'choice', event.target.value)}
                className="min-w-0 flex-1 rounded-none border border-ice-800 bg-ice-1000 px-2 py-1 text-ice-100"
              >
                <option value="">default model</option>
                {models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
                <option value={OTHER_MODEL}>{OTHER_MODEL}</option>
              </select>
              {arm.choice === OTHER_MODEL ? (
                <input
                  data-testid={`launch-arm-model-other-${arm.key}`}
                  aria-label={`arm ${index + 1} model, typed`}
                  placeholder="a model name — added to this repo's list"
                  value={arm.typed}
                  onChange={(event) => updateArm(arm.key, 'typed', event.target.value)}
                  onBlur={() => commitTyped(arm.key)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitTyped(arm.key)
                    }
                  }}
                  className="min-w-0 flex-1 rounded-none border border-ice-800 bg-ice-1000 px-2 py-1 text-ice-100"
                />
              ) : null}
              <textarea
                data-testid={`launch-arm-brief-${arm.key}`}
                placeholder="brief (no brief if blank)"
                value={arm.brief}
                onChange={(event) => updateArm(arm.key, 'brief', event.target.value)}
                rows={1}
                className="min-w-0 flex-[2] resize-y rounded-none border border-ice-800 bg-ice-1000 px-2 py-1 text-ice-100"
              />
              <button
                type="button"
                data-testid={`launch-arm-remove-${arm.key}`}
                onClick={() => removeArm(arm.key)}
                disabled={!configuring || arms.length <= 1}
                className="shrink-0 px-1 text-ice-400 hover:text-ice-100 disabled:opacity-40"
              >
                remove
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          data-testid="launch-add-arm"
          onClick={addArm}
          disabled={!configuring}
          className="w-fit rounded-none border border-ice-800 px-2 py-1 text-[11px] text-ice-300 hover:border-ice-600 disabled:opacity-40"
        >
          + add arm
        </button>
      </fieldset>

      <fieldset disabled={!configuring} className="flex flex-col gap-2">
        <legend className="mb-1 text-[11px] uppercase tracking-widest text-ice-400">
          3. runs and the ceiling — a blank field travels as nothing, and the server&apos;s own default rules (prd-55 ruling 7)
        </legend>
        <div className="flex flex-wrap items-start gap-4 text-[12px]">
          <label className="flex items-center gap-2 text-ice-300">
            runs per arm
            <input
              data-testid="launch-runs"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              placeholder="1 if blank"
              value={runsText}
              onChange={(event) => setRunsText(event.target.value)}
              className="w-24 rounded-none border border-ice-800 bg-ice-1000 px-2 py-1 text-ice-100"
            />
            <span className="text-ice-400">every run is its own worktree and its own spending lane (prd53 ruling 1)</span>
          </label>
          <label className="flex items-center gap-2 text-ice-300">
            ceiling override
            <input
              data-testid="launch-ceiling-override"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              placeholder="the default if blank"
              value={ceilingText}
              onChange={(event) => setCeilingText(event.target.value)}
              className="w-24 rounded-none border border-ice-800 bg-ice-1000 px-2 py-1 text-ice-100"
            />
            <span className="text-ice-400">
              spending lanes — arms × runs — this launch may create; recorded on every fork.dispatched it produces (prd53
              ruling 6)
            </span>
          </label>
        </div>
      </fieldset>

      {configuring && (
        <button
          type="button"
          data-testid="launch-review"
          onClick={() => void review()}
          disabled={!canReview}
          className="w-fit rounded-none border border-ice-400 px-3 py-1.5 text-[12px] text-ice-050 disabled:opacity-40"
        >
          review &amp; launch
        </button>
      )}

      {phase.status === 'estimating' && <p className="text-ice-400">checking {selectedCheckpoint?.lane}'s recent rate…</p>}

      {phase.status === 'estimate-failed' && (
        <div className="flex flex-col gap-2">
          <p role="status" data-testid="launch-estimate-error" className="text-broken">
            could not estimate this launch — {phase.message}
          </p>
          <button type="button" onClick={() => setPhase({ status: 'configuring' })} className="w-fit text-ice-400 underline">
            back
          </button>
        </div>
      )}

      {phase.status === 'confirming' && selectedCheckpoint !== null && (
        <div data-testid="launch-confirm-dialog" className="flex flex-col gap-2 rounded-none border border-ice-700 p-3">
          <p className="text-[12px] text-ice-100">
            Launch {arms.length} arm(s){runs === undefined ? '' : ` × ${runs} run(s)`} from lane &quot;
            {selectedCheckpoint.lane}&quot; at checkpoint {selectedCheckpoint.checkpointId}?
          </p>
          {ceilingOverride === undefined ? null : (
            <p data-testid="launch-ceiling-declared" className="text-[12px] text-ice-300">
              declared ceiling: {ceilingOverride} spending lane(s) — travels as &quot;ceilingOverride&quot; and is recorded on
              every fork.dispatched this launch produces (prd53 ruling 6)
            </p>
          )}
          {phase.estimate.available ? (
            <p data-testid="launch-estimate-amount" className="text-[12px] text-ice-300">
              est. spend ~{formatUsd(phase.estimate.estimatedTotalUsd ?? 0)}
              <br />
              <span className="text-ice-400">
                (based on &quot;{selectedCheckpoint.lane}&quot;'s own rate over {formatWindow(phase.estimate.windowMs ?? 0)}:{' '}
                {formatUsd(phase.estimate.costUsdPerHour ?? 0)}/hr, across {lanesBasis(phase.estimate)})
              </span>
            </p>
          ) : (
            <p data-testid="launch-estimate-unavailable" className="text-[12px] text-(--ink-dim)">
              the rate cannot be established — {phase.estimate.reason}. A lane that has not spent yet is not a fault: there
              is no figure to show, and the launch is still yours to confirm.
            </p>
          )}
          <p className="text-[11px] text-ice-400">
            A fork's spend is real spend and reaches the ledger as such (prd12 ruling 3) — never hidden or discounted as
            &quot;just an experiment&quot;.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="launch-cancel"
              onClick={() => setPhase({ status: 'configuring' })}
              className="rounded-none border border-ice-800 px-3 py-1.5 text-[12px] text-ice-300 hover:border-ice-600"
            >
              cancel
            </button>
            <button
              type="button"
              data-testid="launch-confirm"
              onClick={() => void confirmLaunch()}
              className="rounded-none border border-ice-400 px-3 py-1.5 text-[12px] text-ice-050"
            >
              launch
            </button>
          </div>
        </div>
      )}

      {phase.status === 'launching' && <p data-testid="launch-in-flight" className="text-ice-400">launching…</p>}

      {phase.status === 'launch-failed' && (
        <div className="flex flex-col gap-2">
          <p role="status" data-testid="launch-error" className="text-broken">
            {phase.message}
          </p>
          <button type="button" onClick={() => setPhase({ status: 'configuring' })} className="w-fit text-ice-400 underline">
            back
          </button>
        </div>
      )}

      {phase.status === 'done' && (
        <div data-testid="launch-result" className="flex flex-col gap-2 rounded-none border border-ice-700 p-3">
          <p className="text-[12px] text-ice-100">
            {phase.outcome.arms.length} of {phase.outcome.requestedArms} requested arm(s) dispatched from checkpoint{' '}
            {phase.outcome.checkpointId} — every dollar they spend is real and lands in the ledger as such.
          </p>
          <ul className="flex flex-col gap-1 text-[12px]">
            {phase.outcome.arms.map((arm) => (
              <li key={arm.arm} data-testid={`launch-result-arm-${arm.arm}`} className="text-ice-300">
                arm {arm.arm} — {arm.model ?? 'default model'} — {arm.briefProvided ? 'own brief' : 'no brief'} —{' '}
                {arm.launched ? 'launched' : 'restored, not launched'} — {arm.forkId}
              </li>
            ))}
          </ul>
          {phase.outcome.failed !== null && (
            <p role="status" data-testid="launch-result-failed" className="text-broken">
              arm {phase.outcome.failed.arm} failed and dispatch stopped there — {phase.outcome.failed.error}. Arms
              before it already dispatched and already spent real money; that is reported above, never discarded.
            </p>
          )}
          <button
            type="button"
            data-testid="launch-again"
            onClick={startOver}
            className="w-fit rounded-none border border-ice-800 px-3 py-1.5 text-[12px] text-ice-300 hover:border-ice-600"
          >
            launch another experiment
          </button>
        </div>
      )}
    </div>
  )
}
