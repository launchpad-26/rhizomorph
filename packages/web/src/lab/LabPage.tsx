import { useCallback, useEffect, useState } from 'react'
import { navigate } from '../app/router.js'
import { fetchLabCheckpoints, fetchLabExperiments, type FetchLike } from './api.js'
import { computeExperimentDimensions, isCleanlyControlled, type LabCheckpoint, type LabExperiment } from './types.js'

/**
 * THE LAB TAB (prd14) — `/lab`. The instrument's second hand (prd12 ruling
 * 1): forked realities only, never live fleet state (the law this wave
 * lands, `no-live-fleet-law.test.ts`). Wave 1 is "the seam and the route" —
 * a reachable tab, read-only listings of what the laboratory has already
 * captured and dispatched, and an honest account of why a list is empty.
 *
 * Two DIFFERENT empty sentences, never conflated (the issue's own law): a
 * successful read of zero rows says "there are no experiments/checkpoints
 * yet"; a failed read says "the lab cannot see" its own data, with the
 * failure's own detail attached. Modeled on `recordings/RecordingsPage.tsx`'s
 * loading/ready/error shape.
 */
export interface LabPageProps {
  /** Test-only escape hatch for both reads. */
  fetchImpl?: FetchLike
}

type LoadState<T> =
  | { status: 'loading' }
  | { status: 'ready'; items: T[] }
  | { status: 'error'; message: string }

function goBalcony(): void {
  navigate('/')
}

/** `load` must be its own caller's `useCallback` — its identity is this hook's only dependency. */
function useLabLoad<T>(load: () => Promise<T[]>): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ status: 'loading' })

  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    load()
      .then((items) => {
        if (live) setState({ status: 'ready', items })
      })
      .catch((err) => {
        if (live) setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      live = false
    }
  }, [load])

  return state
}

function CheckpointsSection({ checkpoints }: { checkpoints: LoadState<LabCheckpoint> }) {
  if (checkpoints.status === 'loading') {
    return <p className="text-ice-400">loading checkpoints…</p>
  }
  if (checkpoints.status === 'error') {
    return (
      <p role="status" data-testid="lab-checkpoints-error" className="text-broken">
        the lab cannot see its checkpoints — {checkpoints.message}
      </p>
    )
  }
  if (checkpoints.items.length === 0) {
    return (
      <p data-testid="lab-checkpoints-empty" className="text-ice-400">
        there are no checkpoints yet — capture one with `rhizomorph lab checkpoint &lt;lane&gt;`
      </p>
    )
  }
  return (
    <table data-testid="lab-checkpoints-table" className="w-full border-collapse text-left text-[12px]">
      <thead>
        <tr className="border-b border-ice-850 text-ice-400">
          <th className="p-2 font-normal">lane</th>
          <th className="p-2 font-normal">checkpoint</th>
          <th className="p-2 font-normal">captured</th>
          <th className="p-2 font-normal">by</th>
        </tr>
      </thead>
      <tbody>
        {checkpoints.items.map((checkpoint) => (
          <tr
            key={checkpoint.eventId}
            data-testid={`lab-checkpoint-row-${checkpoint.checkpointId}`}
            className="border-b border-ice-850 align-top"
          >
            <td className="p-2">{checkpoint.lane}</td>
            <td className="figures p-2">{checkpoint.checkpointId}</td>
            <td className="figures p-2">{new Date(checkpoint.capturedAt).toLocaleString()}</td>
            <td className="p-2">{checkpoint.capturedBy}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function experimentDimensionsText(experiment: LabExperiment): string {
  const dimensions = computeExperimentDimensions(experiment)
  if (!dimensions.modelVaries && !dimensions.promptVaries) return 'no arm varies from the others'
  if (isCleanlyControlled(dimensions)) {
    return dimensions.modelVaries ? 'arms differ in model only' : 'arms differ in brief only'
  }
  return 'arms differ in model and brief — a difference cannot be attributed to either'
}

function ExperimentsSection({ experiments }: { experiments: LoadState<LabExperiment> }) {
  if (experiments.status === 'loading') {
    return <p className="text-ice-400">loading experiments…</p>
  }
  if (experiments.status === 'error') {
    return (
      <p role="status" data-testid="lab-experiments-error" className="text-broken">
        the lab cannot see its experiments — {experiments.message}
      </p>
    )
  }
  if (experiments.items.length === 0) {
    return (
      <p data-testid="lab-experiments-empty" className="text-ice-400">
        there are no experiments yet — fork a checkpoint with `rhizomorph lab fork &lt;lane&gt;`
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      {experiments.items.map((experiment) => (
        <div
          key={experiment.forkId}
          data-testid={`lab-experiment-${experiment.forkId}`}
          className="rounded border border-ice-850 p-3"
        >
          <div className="mb-2 flex flex-wrap items-baseline gap-2 text-[12px]">
            <span className="text-ice-100">{experiment.forkId}</span>
            <span className="text-ice-400">
              — {experiment.arms.length} arm(s) of lane &quot;{experiment.parentLane}&quot; at checkpoint{' '}
              {experiment.checkpointId}
            </span>
          </div>
          <p data-testid={`lab-experiment-dimensions-${experiment.forkId}`} className="mb-2 text-[11px] text-ice-400">
            {experimentDimensionsText(experiment)}
          </p>
          <table className="w-full border-collapse text-left text-[12px]">
            <thead>
              <tr className="border-b border-ice-850 text-ice-400">
                <th className="p-2 font-normal">arm</th>
                <th className="p-2 font-normal">model</th>
                <th className="p-2 font-normal">brief</th>
                <th className="p-2 font-normal">runs</th>
              </tr>
            </thead>
            <tbody>
              {experiment.arms.map((arm) => (
                <tr key={arm.arm} data-testid={`lab-arm-${experiment.forkId}-${arm.arm}`} className="align-top">
                  <td className="figures p-2">{arm.arm}</td>
                  <td className="p-2">{arm.treatment.model ?? 'default'}</td>
                  <td className="p-2">
                    {arm.treatment.promptDigest === null ? 'no-brief' : arm.treatment.promptDigest.slice(0, 8)}
                  </td>
                  <td className="figures p-2">{arm.runs.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

export function LabPage({ fetchImpl }: LabPageProps = {}) {
  const loadCheckpoints = useCallback(() => fetchLabCheckpoints(fetchImpl), [fetchImpl])
  const loadExperiments = useCallback(() => fetchLabExperiments(fetchImpl), [fetchImpl])
  const checkpoints = useLabLoad(loadCheckpoints)
  const experiments = useLabLoad(loadExperiments)

  return (
    <div data-testid="lab-page" className="flex h-screen flex-col bg-ice-1000 font-sans text-ice-300">
      <header className="flex shrink-0 items-center gap-4 border-b border-ice-850 bg-ice-950 px-4 py-3">
        <button
          type="button"
          data-testid="lab-back"
          onClick={goBalcony}
          className="shrink-0 rounded border border-ice-800 px-2 py-1 text-[10px] uppercase tracking-wider text-ice-400 hover:border-ice-600 hover:text-ice-100"
        >
          ← balcony
        </button>
        <h1 className="text-sm text-ice-100">Lab</h1>
        <span className="text-[11px] normal-case tracking-normal text-ice-400">
          forked realities only — checkpoints you captured, and experiments forked from them. Never live fleet state.
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <section className="mb-6">
          <h2 className="mb-2 text-[11px] uppercase tracking-widest text-ice-400">Checkpoints</h2>
          <CheckpointsSection checkpoints={checkpoints} />
        </section>

        <section>
          <h2 className="mb-2 text-[11px] uppercase tracking-widest text-ice-400">Experiments</h2>
          <ExperimentsSection experiments={experiments} />
        </section>
      </div>
    </div>
  )
}
