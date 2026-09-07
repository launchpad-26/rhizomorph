import type { LabExperiment, LabRun } from '../types.js'
import type { ComparisonInput, Run } from './types.js'

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
 * One run, read for one measure. An unmeasured run, and a run whose gate did
 * not run (`not-run`), are PENDING under every measure: no verdict exists, and
 * no number is invented in its place (ruling 3). A measured run whose value
 * for this measure is not booked (a pass with no cost yet) is pending too — a
 * fabricated `$0` would be a comparison against nothing.
 */
export function runForMeasure(run: LabRun, measure: Measure): Run {
  const outcome = run.outcome
  if (outcome === undefined || outcome.verified === 'not-run') return { id: run.eventId, status: 'pending', note: NOT_MEASURED }
  if (measure === 'verified') {
    if (outcome.verified === 'pass') return { id: run.eventId, status: 'complete', value: 1 }
    return outcome.verifiedDetail === null
      ? { id: run.eventId, status: 'failed' }
      : { id: run.eventId, status: 'failed', error: outcome.verifiedDetail }
  }
  if (outcome.verified === 'fail') {
    return outcome.verifiedDetail === null
      ? { id: run.eventId, status: 'failed' }
      : { id: run.eventId, status: 'failed', error: outcome.verifiedDetail }
  }
  const value = measure === 'cost' ? outcome.costUsd : measure === 'duration' ? outcome.durationMs : outcome.commits
  if (value === null) return { id: run.eventId, status: 'pending', note: `verified, but no ${MEASURE_LABEL[measure]} is booked to its lane yet` }
  return { id: run.eventId, status: 'complete', value }
}

function briefLabel(promptDigest: string | null): string {
  return promptDigest === null ? 'no-brief' : promptDigest.slice(0, 8)
}

/** The experiment's arms, in ARM ORDER — never re-sorted — each run read for `measure`. */
export function experimentToComparisonInput(experiment: LabExperiment, measure: Measure): ComparisonInput {
  return {
    arms: experiment.arms.map((arm) => ({
      id: `arm-${arm.arm}`,
      model: arm.treatment.model ?? 'default',
      brief: briefLabel(arm.treatment.promptDigest),
      runs: arm.runs.map((run) => runForMeasure(run, measure)),
    })),
  }
}

/** Sorted ascending; the middle value, or the lower middle of an even count — a value that was observed, never an average of two. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null
}
