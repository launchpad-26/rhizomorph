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
 * measure. The FLOOR does not move with the switch (ruling 2's amendment: a
 * run is completed when a gate judged it, whatever the measure) — under
 * `verified` the same floor gates the pass/fail counts as gates a spread. A
 * confounded claim (ruling 2) gets core's own sentence in place of any
 * comparative statement. A failed arm (ruling 7) is present in the list with
 * its failure and excluded from every spread, and that is stated.
 *
 * No native `title=` anywhere on this surface (#220, prd-30 w1): what a dot
 * means is written beside it, for every reader, not hidden in a hover.
 *
 * `measure` is `null` for exactly one caller (prd-14 ruling 5, #214's
 * reopened-comparison view): a saved artifact's `Run.value` is a resolved
 * number with no record of which measure produced it — `compare/types.ts`'s
 * shape carries no such field — so a reopened comparison cannot know whether
 * it is looking at cost, duration or commits, or even whether the number is a
 * unit at all (`verified`'s own `Run.value` is `1`/`0` for pass/fail, never
 * meant to be spread over).
 *
 * NO NUMBER THIS SURFACE CANNOT NAME THE UNIT OF IS EVER PRINTED when
 * `measure` is `null` — not a spread, not a per-run value, review round 3's
 * own correction of round 2's own fix: defaulting to `cost` printed a false
 * LABEL on a real number (round 2); falling through to the numeric branches
 * with no label printed a false STATISTIC instead — a `verified` comparison's
 * 1s and 0s summarised as if they were a real spread, formally
 * indistinguishable from one. Ruling 3 already has the vocabulary for "no
 * summary the data does not support": below the floor an arm shows its runs
 * and an explicit reason instead of a number. `measure === null` takes that
 * same path unconditionally — every run is still shown (law 1), by its
 * verdict alone, and the arm says in words why no summary follows.
 */
export interface ComparisonSurfaceProps {
  comparison: Comparison
  /** The measure the runs were read for, or `null` when the artifact does not record one (see above). When `onMeasureChange` is given too, the switch renders — never offered when `measure` is `null`. */
  measure?: Measure | null
  onMeasureChange?: (measure: Measure) => void
  /** Arms the launch asked for that never dispatched (prd53 ruling 7). */
  failedArms?: readonly FailedArm[]
}

export function ComparisonSurface({ comparison, measure = 'cost', onMeasureChange, failedArms = [] }: ComparisonSurfaceProps) {
  return (
    <section
      data-testid="comparison-surface"
      data-measure={measure ?? undefined}
      className="flex flex-col gap-3 text-read-body text-(--ink-body)"
    >
      {onMeasureChange === undefined || measure === null ? null : <MeasureSwitch measure={measure} onChange={onMeasureChange} />}
      <p data-testid="comparison-basis" className="text-(--ink-dim)">
        {measure === null
          ? 'measure not recorded — this artifact does not carry which measure produced these values, so no summary is shown for any arm; each run below still shows its own verdict'
          : `${MEASURE_LABEL[measure]} — ${MEASURE_BASIS[measure]}`}
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

function ArmPanel({ arm, measure }: { arm: ArmSummary; measure: Measure | null }) {
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

      <RunPoints runs={arm.runs} measure={measure} />

      {/* One floor, whatever the measure: below it every measure refuses the same way (ruling 2, amended). */}
      {arm.insufficientReason !== null ? (
        <p role="status" data-testid="arm-insufficient" className="mt-1.5 text-(--ink-dim)">
          {arm.insufficientReason}
        </p>
      ) : measure === null ? (
        // Review round 3: a `verified` comparison's `Run.value` is `1`/`0`,
        // not a quantity — reopened with no known measure, `arm.spread` over
        // those numbers is a real min/median/max that is formally
        // indistinguishable from a genuine cost or duration spread and just
        // as wrong. Ruling 3's own "below the floor" vocabulary — every run
        // shown, no summary, an explicit reason instead — applies here
        // unconditionally, not only when the run count is low.
        <p role="status" data-testid="arm-basis-unknown" className="mt-1.5 text-(--ink-dim)">
          {arm.completedCount} completed — no summary: the measure this was saved under is not recorded, so a spread or a count here would claim a unit this artifact does not carry
        </p>
      ) : measure === 'verified' ? (
        <p data-testid="arm-verified-counts" className="figures mt-1.5 text-(--ink-body)">
          {arm.passCount} passed · {arm.failCount} failed <span className="text-(--ink-dim)">(n={arm.completedCount} completed)</span>
        </p>
      ) : arm.spread !== null ? (
        <p data-testid="arm-spread" className="figures mt-1.5 text-(--ink-body)">
          min {formatValue(arm.spread.min)} · median {formatValue(median(arm.values) ?? arm.spread.min)} · max {formatValue(arm.spread.max)}{' '}
          <span className="text-(--ink-dim)">
            (n={arm.values.length} of {arm.completedCount} completed)
          </span>
        </p>
      ) : (
        <p role="status" data-testid="arm-unbooked" className="mt-1.5 text-(--ink-dim)">
          {arm.unbookedNote}
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
            <li key={run.id} data-run-status={run.status} data-run-verdict={run.status === 'complete' ? run.verdict : undefined} className="flex flex-wrap gap-2">
              <span className="text-(--ink-dim)">{run.id}</span>
              <span className={runInk(run)}>{runWords(run, measure)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}

/** Every run, always, as a point — with its meaning written beside it for the reader who cannot hover. */
function RunPoints({ runs, measure }: { runs: Run[]; measure: Measure | null }) {
  return (
    <ol data-testid="run-dots" className="flex flex-wrap gap-2">
      {runs.map((run) => (
        <li
          key={run.id}
          data-run-status={run.status}
          data-run-verdict={run.status === 'complete' ? run.verdict : undefined}
          className={`figures flex items-baseline gap-1 ${runInk(run)}`}
        >
          <span aria-hidden="true">●</span>
          <span className="sr-only">{run.id}: </span>
          <span>{runWords(run, measure)}</span>
        </li>
      ))}
    </ol>
  )
}

function runInk(run: Run): string {
  if (run.status === 'pending') return 'text-(--ink-dim)'
  return run.verdict === 'pass' ? 'text-done' : 'text-broken'
}

/**
 * A judged run says its verdict first, then its value under this measure (or
 * why it has none); the gate's own words follow a fail.
 *
 * `measure === null` takes the SAME early return as `'verified'` — verdict
 * only, never `run.value`. A `verified`-saved run's `value` is `1`/`0`, and
 * printing it beside any OTHER unknown-basis run would be exactly the false
 * statistic {@link ArmPanel}'s own `arm-basis-unknown` branch refuses to
 * print in aggregate, just at the per-run point instead (review round 3).
 */
function runWords(run: Run, measure: Measure | null): string {
  if (run.status === 'pending') return run.note ?? 'pending'
  const verdict = run.verdict === 'pass' ? 'passed' : 'failed'
  const detail = run.detail === undefined ? '' : ` — ${run.detail}`
  if (measure === 'verified' || measure === null) return `${verdict}${detail}`
  if (run.value === null) {
    return `${verdict} · ${run.note ?? 'no value booked under this measure'}${detail}`
  }
  return `${verdict} · ${formatValue(run.value)}${detail}`
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}
