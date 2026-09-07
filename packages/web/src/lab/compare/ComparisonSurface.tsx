import { type KeyboardEvent, useState } from 'react'
import { MEASURE_BASIS, MEASURE_LABEL, MEASURES, type Measure, median, SCORING_UNAVAILABLE } from './fromExperiment.js'
import type { ArmSummary, Comparison, ComparisonClaim, FailedArm, Run } from './types.js'

/**
 * THE COMPARISON SURFACE (prd14 ruling 3; prd53 S2, #326). Renders
 * `compareArms`'s output with no adaptation — every run always shown, a
 * spread as min · median · max never a point, an arm below the floor speaks
 * its own reason instead of a dash, and nothing here sorts arms by value or
 * marks one as leading (law 4: no winner, no leading marker, no ranking, ever
 * — "a sorted table is a ranking whether or not it says so", so there is no
 * sort control to reach for).
 *
 * The measure switch (S2) is one radiogroup — cost, duration, commits,
 * verified, and Scoring as a DISABLED position, the honest gap where a score
 * would go (ruling 10). Switching re-reads the runs; nothing is stored per
 * measure. A confounded claim (ruling 2) gets core's own sentence in place of
 * any comparative statement. A failed arm (ruling 7) is present in the list
 * with its failure and excluded from every spread, and that is stated.
 *
 * No native `title=` anywhere on this surface (#220, prd-30 w1): what a dot
 * means is written beside it, for every reader, not hidden in a hover.
 */
export interface ComparisonSurfaceProps {
  comparison: Comparison
  /** The measure the runs were read for. When `onMeasureChange` is given too, the switch renders. */
  measure?: Measure
  onMeasureChange?: (measure: Measure) => void
  /** Arms the launch asked for that never dispatched (prd53 ruling 7). */
  failedArms?: readonly FailedArm[]
}

export function ComparisonSurface({ comparison, measure = 'cost', onMeasureChange, failedArms = [] }: ComparisonSurfaceProps) {
  return (
    <section data-testid="comparison-surface" data-measure={measure} className="flex flex-col gap-3 text-read-body text-(--ink-body)">
      {onMeasureChange === undefined ? null : <MeasureSwitch measure={measure} onChange={onMeasureChange} />}
      <p data-testid="comparison-basis" className="text-(--ink-dim)">
        {MEASURE_LABEL[measure]} — {MEASURE_BASIS[measure]}
      </p>
      <ClaimBanner claim={comparison.claim} failedArms={failedArms} />
      <ol className="flex flex-col gap-3">
        {comparison.arms.map((arm) => (
          <li key={arm.armId}>
            <ArmPanel arm={arm} measure={measure} />
          </li>
        ))}
        {failedArms.map((failed) => (
          <li key={`failed-${failed.arm}`}>
            <div data-testid={`arm-failed-${failed.arm}`} className="border border-(--line-hair) border-dashed p-3 text-(--ink-dim)">
              <span className="figures text-(--ink-primary)">arm {failed.arm}</span> failed to dispatch — {failed.error}. Excluded from every
              spread above; its spend, if any, is real spend.
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

/**
 * One switch over the measures, keyboard-first: `Tab` reaches the selected
 * position, `↑`/`↓` (or `←`/`→`) move it, Scoring is disabled and skipped.
 * Roving tabindex, so the group is one tab stop, as a radiogroup is.
 */
function MeasureSwitch({ measure, onChange }: { measure: Measure; onChange: (measure: Measure) => void }) {
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const at = MEASURES.indexOf(measure)
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault()
      onChange(MEASURES[(at + 1) % MEASURES.length] ?? measure)
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault()
      onChange(MEASURES[(at - 1 + MEASURES.length) % MEASURES.length] ?? measure)
    }
  }
  return (
    <div role="radiogroup" aria-label="measure" data-testid="measure-switch" className="flex flex-wrap items-baseline gap-1" onKeyDown={onKeyDown}>
      <span className="heading mr-1 text-(--ink-dim)">measure</span>
      {MEASURES.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={option === measure}
          tabIndex={option === measure ? 0 : -1}
          data-testid={`measure-${option}`}
          onClick={() => onChange(option)}
          className={`focus-ring border px-1.5 py-0.5 ${
            option === measure ? 'border-(--ink-primary) bg-(--surface-raised) text-(--ink-primary)' : 'border-(--line-strong) text-(--ink-dim)'
          }`}
        >
          {MEASURE_LABEL[option]}
        </button>
      ))}
      <span
        role="radio"
        aria-checked={false}
        aria-disabled="true"
        data-testid="measure-scoring"
        className="border border-(--line-hair) border-dashed px-1.5 py-0.5 text-(--ink-dim)"
      >
        {SCORING_UNAVAILABLE}
      </span>
    </div>
  )
}

function ClaimBanner({ claim, failedArms }: { claim: ComparisonClaim; failedArms: readonly FailedArm[] }) {
  const detail = claimDetail(claim)
  return (
    <p role="status" data-testid="comparison-claim" className="leading-snug text-(--ink-dim)">
      <span className="heading text-(--ink-dim)">{claimLabel(claim)}</span>
      {detail === null ? null : <> — {detail}</>}
      {failedArms.length === 0 ? null : (
        <span data-testid="comparison-partial">
          {' '}· {failedArms.length} arm{failedArms.length === 1 ? '' : 's'} failed to dispatch and {failedArms.length === 1 ? 'is' : 'are'} excluded from
          every spread
        </span>
      )}
    </p>
  )
}

function claimLabel(claim: ComparisonClaim): string {
  switch (claim.kind) {
    case 'single-arm':
      return 'NOTHING TO COMPARE'
    case 'uniform':
      return 'NO COMPARISON'
    case 'comparable':
      return 'COMPARABLE'
    case 'confounded':
      return 'NO COMPARATIVE CLAIM'
  }
}

function claimDetail(claim: ComparisonClaim): string | null {
  switch (claim.kind) {
    case 'single-arm':
      return 'only one arm — there is nothing to compare it against.'
    case 'uniform':
      return 'no arm varies from the others — these are replicate runs, not a comparison.'
    case 'comparable':
      return `arms differ in ${claim.dimension} only.`
    case 'confounded':
      return claim.reason
  }
}

function ArmPanel({ arm, measure }: { arm: ArmSummary; measure: Measure }) {
  const [expanded, setExpanded] = useState(false)

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && expanded) {
      event.preventDefault()
      setExpanded(false)
    }
  }

  return (
    <div data-testid="arm-panel" data-arm-id={arm.armId} className="border border-(--line-hair) p-3" onKeyDown={onKeyDown}>
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          data-testid={`arm-toggle-${arm.armId}`}
          onClick={() => setExpanded((current) => !current)}
          className="focus-ring figures text-(--ink-primary)"
        >
          {arm.model}
        </button>
        <span className="max-w-[60%] truncate text-(--ink-dim)">brief {arm.brief}</span>
      </header>

      <RunPoints runs={arm.runs} />

      {measure === 'verified' ? (
        <p data-testid="arm-verified-counts" className="figures mt-1.5 text-(--ink-body)">
          {arm.completedValues.length} passed · {arm.failedCount} failed · {arm.pendingCount} not measured
        </p>
      ) : arm.spread !== null ? (
        <p data-testid="arm-spread" className="figures mt-1.5 text-(--ink-body)">
          min {formatValue(arm.spread.min)} · median {formatValue(median(arm.completedValues) ?? arm.spread.min)} · max{' '}
          {formatValue(arm.spread.max)} <span className="text-(--ink-dim)">(n={arm.completedValues.length})</span>
        </p>
      ) : (
        <p role="status" data-testid="arm-insufficient" className="mt-1.5 text-(--ink-dim)">
          {arm.insufficientReason}
        </p>
      )}

      {arm.incompleteNote === null ? null : (
        <p data-testid="arm-incomplete-note" className="mt-1 text-(--ink-dim)">
          {arm.incompleteNote}
        </p>
      )}

      {expanded ? (
        <ol data-testid={`arm-runs-${arm.armId}`} className="figures mt-2 flex flex-col gap-0.5 border-(--line-hair) border-t pt-2">
          {arm.runs.map((run) => (
            <li key={run.id} data-run-status={run.status} className="flex flex-wrap gap-2">
              <span className="text-(--ink-dim)">{run.id}</span>
              <span className={runInk(run)}>{runWords(run)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}

/** Every run, always, as a point — with its meaning written beside it for the reader who cannot hover. */
function RunPoints({ runs }: { runs: Run[] }) {
  return (
    <ol data-testid="run-dots" className="flex flex-wrap gap-2">
      {runs.map((run) => (
        <li key={run.id} data-run-status={run.status} className={`figures flex items-baseline gap-1 ${runInk(run)}`}>
          <span aria-hidden="true">●</span>
          <span className="sr-only">{run.id}: </span>
          <span>{runWords(run)}</span>
        </li>
      ))}
    </ol>
  )
}

function runInk(run: Run): string {
  if (run.status === 'complete') return 'text-done'
  if (run.status === 'pending') return 'text-(--ink-dim)'
  return 'text-broken'
}

function runWords(run: Run): string {
  if (run.status === 'complete') return formatValue(run.value)
  if (run.status === 'pending') return run.note ?? 'pending'
  return run.error === undefined ? 'failed' : `failed — ${run.error}`
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}
