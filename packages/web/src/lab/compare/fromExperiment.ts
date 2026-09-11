import { isCompletedVerdict } from '@rhizomorph/core'
import type { LabExperiment } from '../types.js'
import type { ComparisonInput, ComparisonProvenance, Run } from './types.js'

/**
 * THE MEASURE SWITCH (prd53 S2): the same arms, read for one measure at a time.
 * Every spread is recomputed when the measure changes because the runs are
 * re-read, not because anything is stored per measure. `scoring` is not here on
 * purpose — it has no source (ruling 10), and the surface shows it as one
 * disabled position rather than a number nothing measured.
 */
export type Measure = 'cost' | 'duration' | 'commits' | 'verified'

export const MEASURES: readonly Measure[] = ['cost', 'duration', 'commits', 'verified']

export const MEASURE_LABEL: Readonly<Record<Measure, string>> = {
  cost: 'cost',
  duration: 'duration',
  commits: 'commits',
  verified: 'verified',
}

/** Ruling 3's sentence for a run nobody has measured. Spelled once, here; `adapters.ts` carries the same words for its own readers. */
export const NOT_MEASURED = 'not measured yet — no outcome is invented in its place'

/** The one sentence for the switch's disabled position — the honest gap where a score would go. */
export const SCORING_UNAVAILABLE = 'Scoring — no source yet'

/** What each measure's number IS — the basis a surface must print beside it (S4's rule, honoured here too). */
export const MEASURE_BASIS: Readonly<Record<Measure, string>> = {
  cost: "booked to each run's own lane, in dollars",
  duration: 'dispatch to the newest event recorded for the run, in ms',
  commits: "commits the run made on top of its restored snapshot, counted in the run's own worktree",
  verified: "the gate's verdict on the run — pass or fail — with who ran it",
}

/**
 * The narrowest shape `runForMeasure` needs — the outcome facts alone, none of
 * `LabRun`'s dispatch metadata. A real `LabRun` always satisfies this
 * structurally; so does a run reconstructed from a saved v2 artifact's stored
 * facts (`recordings/RecordingsPage.tsx`) — which is the whole point (prd14
 * ruling 6): the reopened surface re-derives through this SAME function,
 * never a second path that merely agrees with it.
 */
export interface MeasurableOutcome {
  verified: 'pass' | 'fail' | 'not-run'
  verifiedDetail: string | null
  costUsd: number | null
  durationMs: number | null
  commits: number | null
}

export interface MeasurableRun {
  eventId: string
  outcome?: MeasurableOutcome
}

/**
 * One run, read for one measure. Whether the run is COMPLETE is core's call
 * and measure-independent (`isCompletedVerdict`: a gate judged it, pass or
 * fail — ruling 2's amendment) — so the floor Compare applies is the floor
 * Metrics and the CLI apply. An unmeasured run, and a run whose gate did not
 * run (`not-run`), are PENDING under every measure: no verdict exists, and no
 * number is invented in its place (ruling 3). A judged run whose value for
 * THIS measure is not booked (a pass with no cost yet) is complete with a null
 * value and a note — it counts toward the floor, not toward the spread; a
 * fabricated `$0` would be a comparison against nothing. Under `verified` the
 * value is the verdict itself: 1 for pass, 0 for fail.
 *
 * Every complete run also carries `cost`/`duration`/`commits` — the three raw
 * facts, independent of which `measure` was asked for — so a save can persist
 * all of them at once (prd14 ruling 6) rather than only the one `value` this
 * call happened to resolve.
 */
export function runForMeasure(run: MeasurableRun, measure: Measure): Run {
  const outcome = run.outcome
  if (outcome === undefined || !isCompletedVerdict(outcome.verified)) return { id: run.eventId, status: 'pending', note: NOT_MEASURED }
  const verdict = outcome.verified
  const detail = outcome.verifiedDetail === null ? {} : { detail: outcome.verifiedDetail }
  const facts = { cost: outcome.costUsd, duration: outcome.durationMs, commits: outcome.commits }
  if (measure === 'verified') return { id: run.eventId, status: 'complete', verdict, value: verdict === 'pass' ? 1 : 0, ...detail, ...facts }
  const value = measure === 'cost' ? outcome.costUsd : measure === 'duration' ? outcome.durationMs : outcome.commits
  if (value === null) {
    return { id: run.eventId, status: 'complete', verdict, value: null, note: `judged, but no ${MEASURE_LABEL[measure]} is booked to its lane yet`, ...detail, ...facts }
  }
  return { id: run.eventId, status: 'complete', verdict, value, ...detail, ...facts }
}

function briefLabel(promptDigest: string | null): string {
  return promptDigest === null ? 'no-brief' : promptDigest.slice(0, 8)
}

/**
 * The provenance of the most recently judged run across the whole experiment
 * — representative of "how this was judged", not an attempt to reconcile
 * per-run differences (prd14 ruling 6 stores one provenance per artifact, not
 * one per run; every run in one experiment is ordinarily gated the same way).
 * `null` when nothing has been judged yet — never invented.
 */
function latestProvenance(experiment: LabExperiment): ComparisonProvenance | null {
  let latest: ComparisonProvenance | null = null
  for (const arm of experiment.arms) {
    for (const run of arm.runs) {
      const outcome = run.outcome
      if (outcome === undefined || !isCompletedVerdict(outcome.verified)) continue
      if (latest === null || outcome.provenance.measuredAt > latest.measuredAt) latest = outcome.provenance
    }
  }
  return latest
}

/** The experiment's arms, in ARM ORDER — never re-sorted — each run read for `measure`. Carries `measure` and the gate's `provenance` at the top level too (prd14 ruling 6), so a save downstream of this has everything it needs without a second walk of the experiment. */
export function experimentToComparisonInput(experiment: LabExperiment, measure: Measure): ComparisonInput {
  return {
    arms: experiment.arms.map((arm) => ({
      id: `arm-${arm.arm}`,
      model: arm.treatment.model ?? 'default',
      brief: briefLabel(arm.treatment.promptDigest),
      runs: arm.runs.map((run) => runForMeasure(run, measure)),
    })),
    measure,
    provenance: latestProvenance(experiment),
  }
}

/** Sorted ascending; the middle value, or the lower middle of an even count — a value that was observed, never an average of two. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null
}
