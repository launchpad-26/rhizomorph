import { useCallback, useEffect, useState } from 'react'
import type { FetchLike } from '../../replay/api.js'
import { fetchLabCheckpoints } from '../api.js'
import type { LabCheckpoint } from '../types.js'
import { fetchLabEstimate, type LabEstimate } from './estimate.js'
import { requestLaunch, type LaunchArmInput, type LaunchFetchLike, type LaunchOutcome, type LaunchRequest } from './launch.js'

/**
 * THE ACT OF LAUNCHING AN EXPERIMENT (prd14 rulings 2 and 4).
 *
 * Three steps, and exactly one of them writes anything:
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
 *    job is to let the operator try three different things, freely.
 * 3. **Estimate and ONE confirmation** (ruling 4) — reviewing fetches
 *    `/api/lab/estimate` (a read) and shows its basis on screen; the single
 *    "launch" button on that same screen is the one write this component
 *    ever makes (`./launch.js`'s `requestLaunch`, the app's third mutating
 *    call). There is no second dialog after it.
 */

export interface LaunchPanelProps {
  /** Test-only escape hatch for every read this panel makes (checkpoints, estimate). */
  fetchImpl?: FetchLike
  /** Test-only escape hatch for the one write this panel makes. */
  launchFetchImpl?: LaunchFetchLike
}

interface ArmDraft {
  key: string
  model: string
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
  return { key: `arm-${armKeySeq}`, model: '', brief: '' }
}

const DEFAULT_ARM_COUNT = 3

function toLaunchArm(arm: ArmDraft): LaunchArmInput {
  const model = arm.model.trim()
  const brief = arm.brief.trim()
  return {
    ...(model.length > 0 ? { model } : {}),
    ...(brief.length > 0 ? { brief } : {}),
  }
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`
}

function formatWindow(windowMs: number): string {
  const hours = windowMs / 3_600_000
  return hours === 1 ? 'the last hour' : `the last ${hours}h`
}

export function LaunchPanel({ fetchImpl, launchFetchImpl }: LaunchPanelProps = {}) {
  const [checkpoints, setCheckpoints] = useState<CheckpointsState>({ status: 'loading' })
  const [checkpointId, setCheckpointId] = useState<string | null>(null)
  const [arms, setArms] = useState<ArmDraft[]>(() => Array.from({ length: DEFAULT_ARM_COUNT }, freshArm))
  const [phase, setPhase] = useState<Phase>({ status: 'configuring' })

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

  function addArm() {
    setArms((prev) => [...prev, freshArm()])
  }

  function removeArm(key: string) {
    setArms((prev) => (prev.length > 1 ? prev.filter((arm) => arm.key !== key) : prev))
  }

  function updateArm(key: string, field: 'model' | 'brief', value: string) {
    setArms((prev) => prev.map((arm) => (arm.key === key ? { ...arm, [field]: value } : arm)))
  }

  async function review() {
    if (selectedCheckpoint === null) return
    setPhase({ status: 'estimating' })
    try {
      const estimate = await fetchLabEstimate(selectedCheckpoint.lane, arms.length, fetchImpl)
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
    }
    try {
      const outcome = await requestLaunch(request, launchFetchImpl)
      setPhase({ status: 'done', outcome })
    } catch (err) {
      setPhase({ status: 'launch-failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  function startOver() {
    setArms(Array.from({ length: DEFAULT_ARM_COUNT }, freshArm))
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
          2. arms — each with its own model and its own brief (prd14 ruling 2)
        </legend>
        <div className="flex flex-col gap-2">
          {arms.map((arm, index) => (
            <div key={arm.key} data-testid={`launch-arm-${arm.key}`} className="flex items-start gap-2 text-[12px]">
              <span className="figures pt-1 text-ice-400">{index + 1}</span>
              <input
                data-testid={`launch-arm-model-${arm.key}`}
                placeholder="model (default if blank)"
                value={arm.model}
                onChange={(event) => updateArm(arm.key, 'model', event.target.value)}
                className="min-w-0 flex-1 rounded border border-ice-800 bg-ice-1000 px-2 py-1 text-ice-100"
              />
              <textarea
                data-testid={`launch-arm-brief-${arm.key}`}
                placeholder="brief (no brief if blank)"
                value={arm.brief}
                onChange={(event) => updateArm(arm.key, 'brief', event.target.value)}
                rows={1}
                className="min-w-0 flex-[2] resize-y rounded border border-ice-800 bg-ice-1000 px-2 py-1 text-ice-100"
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
          className="w-fit rounded border border-ice-800 px-2 py-1 text-[11px] text-ice-300 hover:border-ice-600 disabled:opacity-40"
        >
          + add arm
        </button>
      </fieldset>

      {configuring && (
        <button
          type="button"
          data-testid="launch-review"
          onClick={() => void review()}
          disabled={!canReview}
          className="w-fit rounded border border-ice-400 px-3 py-1.5 text-[12px] text-ice-050 disabled:opacity-40"
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
        <div data-testid="launch-confirm-dialog" className="flex flex-col gap-2 rounded border border-ice-700 p-3">
          <p className="text-[12px] text-ice-100">
            Launch {arms.length} arm(s) from lane &quot;{selectedCheckpoint.lane}&quot; at checkpoint{' '}
            {selectedCheckpoint.checkpointId}?
          </p>
          {phase.estimate.available ? (
            <p data-testid="launch-estimate-amount" className="text-[12px] text-ice-300">
              est. spend ~{formatUsd(phase.estimate.estimatedTotalUsd ?? 0)}
              <br />
              <span className="text-ice-400">
                (based on &quot;{selectedCheckpoint.lane}&quot;'s own rate over {formatWindow(phase.estimate.windowMs ?? 0)}:{' '}
                {formatUsd(phase.estimate.costUsdPerHour ?? 0)}/hr)
              </span>
            </p>
          ) : (
            <p data-testid="launch-estimate-unavailable" className="text-[12px] text-broken">
              the rate cannot be established — {phase.estimate.reason}
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
              className="rounded border border-ice-800 px-3 py-1.5 text-[12px] text-ice-300 hover:border-ice-600"
            >
              cancel
            </button>
            <button
              type="button"
              data-testid="launch-confirm"
              onClick={() => void confirmLaunch()}
              className="rounded border border-ice-400 px-3 py-1.5 text-[12px] text-ice-050"
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
        <div data-testid="launch-result" className="flex flex-col gap-2 rounded border border-ice-700 p-3">
          <p className="text-[12px] text-ice-100">
            {phase.outcome.arms.length} arm(s) dispatched from checkpoint {phase.outcome.checkpointId} — every dollar
            they spend is real and lands in the ledger as such.
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
            className="w-fit rounded border border-ice-800 px-3 py-1.5 text-[12px] text-ice-300 hover:border-ice-600"
          >
            launch another experiment
          </button>
        </div>
      )}
    </div>
  )
}
