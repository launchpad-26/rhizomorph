import { useEffect, useState } from 'react'
import type { FetchLike } from '../../replay/api.js'
import type { FailedArm } from '../compare/types.js'
import { fetchLabEstimate, type LabEstimate } from '../launch/estimate.js'
import type { LabExperiment } from '../types.js'
import { armFloor, dispatchedLine, experimentSpend, provenanceRows } from './spend.js'

/**
 * METRICS (prd53 S4, #328): every number with its basis line — a KPI cannot be
 * read without the sentence that says where it came from — distributions on
 * one shared scale across experiments, and the verification and provenance
 * table. Below the floor an arm is drawn REFUSING, on the same scale as its
 * neighbours, not omitted. No control here changes a number.
 *
 * The DOM law (`Metrics.test.tsx`): every `[data-figure]` has a `[data-basis]`
 * beside it. A figure without a basis is a mutation this surface cannot ship.
 */
export interface MetricsProps {
  experiments: readonly LabExperiment[]
  /** Arms a launch asked for that never dispatched, by forkId — a launch-time fact (ruling 7). */
  failedArmsByFork?: Readonly<Record<string, readonly FailedArm[]>>
  /** Enter on a row opens its Compare — the Workspace owns where that is. */
  onOpenCompare?: (forkId: string) => void
  /** Test-only escape hatch for the estimate reads this surface makes. */
  fetchImpl?: FetchLike
}

type RateState = { status: 'loading' } | { status: 'ready'; estimate: LabEstimate } | { status: 'error'; message: string }

export const EMPTY_COPY = 'there are no experiments yet — fork a checkpoint with `rhizomorph lab fork <lane>`'
export const NO_RATE_COPY = "the lane's recent rate cannot be established — no cost has been booked to it in the last hour"

function usd(value: number): string {
  return `$${value.toFixed(2)}`
}

export function Metrics({ experiments, failedArmsByFork = {}, onOpenCompare, fetchImpl }: MetricsProps) {
  const lanes = [...new Set(experiments.map((experiment) => experiment.parentLane))]
  const [rates, setRates] = useState<Readonly<Record<string, RateState>>>({})

  useEffect(() => {
    let live = true
    setRates(Object.fromEntries(lanes.map((lane) => [lane, { status: 'loading' as const }])))
    for (const lane of lanes) {
      const arms = Math.max(1, ...experiments.filter((experiment) => experiment.parentLane === lane).map((experiment) => experiment.arms.length))
      void (fetchImpl === undefined ? fetchLabEstimate(lane, arms) : fetchLabEstimate(lane, arms, fetchImpl))
        .then((estimate) => {
          if (live) setRates((current) => ({ ...current, [lane]: { status: 'ready', estimate } }))
        })
        .catch((err: unknown) => {
          if (live) setRates((current) => ({ ...current, [lane]: { status: 'error', message: err instanceof Error ? err.message : String(err) } }))
        })
    }
    return () => {
      live = false
    }
    // Re-read when the set of lanes changes, not on every render of the same set.
  }, [lanes.join(' '), fetchImpl]) // eslint-disable-line react-hooks/exhaustive-deps

  if (experiments.length === 0) {
    return (
      <section data-testid="metrics" data-state="empty" className="text-read-body text-(--ink-dim)">
        <p data-testid="metrics-empty">{EMPTY_COPY}</p>
      </section>
    )
  }

  const spends = experiments.map(experimentSpend)
  const scaleMax = Math.max(0, ...spends.map((spend) => spend.bookedUsd ?? 0))

  return (
    <section data-testid="metrics" data-state="ready" className="flex flex-col gap-4 text-read-body text-(--ink-body)">
      <p className="text-(--ink-dim)">
        one shared scale across experiments — a refusal is drawn <span className="text-(--ink-primary)">on</span> it, not omitted from it
      </p>
      <ol className="flex flex-col gap-4">
        {experiments.map((experiment, index) => {
          const spend = spends[index]
          const failed = failedArmsByFork[experiment.forkId] ?? []
          const partial = dispatchedLine(experiment, failed.length)
          const rate = rates[experiment.parentLane]
          const width = spend !== undefined && spend.bookedUsd !== null && scaleMax > 0 ? Math.max(2, (spend.bookedUsd / scaleMax) * 100) : 0
          return (
            <li key={experiment.forkId} data-testid={`metrics-row-${experiment.forkId}`} className="flex flex-col gap-2 border border-(--line-hair) p-3">
              <header className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="figures text-(--ink-primary)">{experiment.forkId}</span>
                <span className="text-(--ink-dim)">
                  lane {experiment.parentLane} · {experiment.arms.length} arm{experiment.arms.length === 1 ? '' : 's'}
                </span>
                {onOpenCompare === undefined ? null : (
                  <button
                    type="button"
                    data-testid={`metrics-open-${experiment.forkId}`}
                    onClick={() => onOpenCompare(experiment.forkId)}
                    className="focus-ring heading border border-(--line-strong) px-1.5 py-0.5 text-(--ink-dim)"
                  >
                    open Compare
                  </button>
                )}
              </header>

              {partial === null ? null : (
                <p data-testid={`metrics-partial-${experiment.forkId}`} className="text-(--ink-dim)">
                  {partial} — {failed.map((arm) => `arm ${arm.arm}: ${arm.error}`).join('; ')}
                </p>
              )}

              {/* spend: the figure, and the sentence beside it */}
              <div data-testid={`metrics-spend-${experiment.forkId}`} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  {spend?.bookedUsd === null || spend === undefined ? (
                    <span className="text-(--ink-dim)">nothing booked yet</span>
                  ) : (
                    <span data-figure="spend" className="figures text-(--ink-primary)">
                      {usd(spend.bookedUsd)}
                    </span>
                  )}
                  <span data-basis="spend" className="text-(--ink-dim)">
                    {spend?.basis}
                  </span>
                </div>
                {spend?.exclusionNote === null || spend === undefined ? null : (
                  <p data-testid={`metrics-exclusion-${experiment.forkId}`} className="text-(--ink-dim)">
                    {spend.exclusionNote}
                  </p>
                )}
                <div data-testid={`metrics-track-${experiment.forkId}`} className="h-1.5 w-full bg-(--surface-raised)">
                  <div className="h-full bg-(--ink-dim)" style={{ width: `${width}%` }} />
                </div>
              </div>

              {/* per-arm floor, on the same scale: a refusal is a rendered track */}
              <ol className="flex flex-col gap-1">
                {experiment.arms.map((arm) => {
                  const floor = armFloor(arm)
                  return (
                    <li key={arm.arm} data-testid={`metrics-arm-${experiment.forkId}-${arm.arm}`} className="flex flex-wrap items-baseline gap-2">
                      <span className="figures text-(--ink-dim)">arm {arm.arm}</span>
                      {floor.canSummarise ? (
                        <span className="text-(--ink-body)">
                          {floor.measuredRuns} of {floor.totalRuns} measured — a summary may be stated
                        </span>
                      ) : (
                        <span data-testid={`metrics-refusal-${experiment.forkId}-${arm.arm}`} className="flex flex-1 items-baseline gap-2">
                          <span className="h-1.5 flex-1 border border-(--line-hair) border-dashed" aria-hidden="true" />
                          <span className="text-(--ink-dim)">{floor.refusal}</span>
                        </span>
                      )}
                    </li>
                  )
                })}
              </ol>

              {/* rate: the lane's own, with its basis, or the honest reason there is none */}
              <div data-testid={`metrics-rate-${experiment.forkId}`} className="flex flex-wrap items-baseline gap-2">
                {rate === undefined || rate.status === 'loading' ? (
                  <span className="text-(--ink-dim)">reading the lane&apos;s rate…</span>
                ) : rate.status === 'error' ? (
                  <span className="text-(--ink-dim)">the rate cannot be read — {rate.message}</span>
                ) : rate.estimate.available && rate.estimate.costUsdPerHour !== undefined ? (
                  <>
                    <span data-figure="rate" className="figures text-(--ink-primary)">
                      {usd(rate.estimate.costUsdPerHour)}/h
                    </span>
                    <span data-basis="rate" className="text-(--ink-dim)">
                      the lane&apos;s own booked spend over the last hour, per hour
                    </span>
                  </>
                ) : (
                  <span data-testid={`metrics-no-rate-${experiment.forkId}`} className="text-(--ink-dim)">
                    {NO_RATE_COPY}
                  </span>
                )}
              </div>

              {/* provenance: who judged which run, with what — and no number where no verdict exists */}
              <table data-testid={`metrics-provenance-${experiment.forkId}`} className="figures w-full border-collapse text-left">
                <thead>
                  <tr className="border-(--line-strong) border-b text-(--ink-dim)">
                    <th className="py-1 pr-2 font-normal">arm</th>
                    <th className="py-1 pr-2 font-normal">run</th>
                    <th className="py-1 pr-2 font-normal">verified</th>
                    <th className="py-1 pr-2 font-normal">by</th>
                    <th className="py-1 pr-2 font-normal">cost</th>
                  </tr>
                </thead>
                <tbody>
                  {provenanceRows(experiment).map((row) => (
                    <tr key={row.laneHandle} data-testid={`metrics-run-${row.laneHandle}`} data-verified={row.verified} className="border-(--line-hair) border-b">
                      <td className="py-1 pr-2 text-(--ink-dim)">{row.arm}</td>
                      <td className="py-1 pr-2 text-(--ink-dim)">{row.run}</td>
                      <td className={`py-1 pr-2 ${row.verified === 'pass' ? 'text-done' : row.verified === 'fail' ? 'text-broken' : 'text-(--ink-dim)'}`}>
                        {row.verified}
                      </td>
                      <td className="py-1 pr-2 text-(--ink-dim)">
                        {row.verifyCommand === null ? '—' : `${row.verifyCommand} (${row.source ?? '?'})`}
                      </td>
                      {row.costUsd === null ? (
                        <td className="py-1 pr-2 text-(--ink-dim)">—</td>
                      ) : (
                        <td data-numeric="cost" className="py-1 pr-2 text-(--ink-body)">
                          {usd(row.costUsd)}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
