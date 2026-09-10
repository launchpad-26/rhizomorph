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
  // ONE SCALE FOR EVERY ARM (prd-55 ruling 8, the Design calls): the widest
  // value any arm booked under this measure. Arms are drawn against it rather
  // than each against its own, so two lanes side by side are two lanes a
  // reader may actually compare — and an arm that refuses still occupies its
  // own lane ON it (`ArmLane`), rather than being lifted off the scale into a
  // sentence beside it.
  const scaleMax = Math.max(0, ...comparison.arms.flatMap((arm) => arm.values))
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
            <ArmPanel arm={arm} measure={measure} scaleMax={scaleMax} />
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
      {scaleMax > 0 && measure !== 'verified' ? (
        <p data-testid="comparison-scale-ticks" className="figures flex flex-wrap justify-between gap-2 text-(--ink-dim)">
          <span>0</span>
          <span>
            {formatValue(scaleMax)} · one shared {MEASURE_LABEL[measure]} scale — a refusal is drawn <span className="text-(--ink-primary)">on</span>{' '}
            it, not beside it
          </span>
        </p>
      ) : null}
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

function ArmPanel({ arm, measure, scaleMax }: { arm: ArmSummary; measure: Measure; scaleMax: number }) {
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

      <ArmLane arm={arm} measure={measure} scaleMax={scaleMax} />

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

/**
 * ONE LANE ON THE SHARED SCALE, PER ARM (prd-55 ruling 8; the Design calls:
 * *the refusal is drawn on the shared scale, not beside it*). Every arm gets
 * this lane, whatever it has to say in it: an arm with a spread draws its
 * range and its median against `scaleMax`; an arm BELOW THE FLOOR, or one
 * judged with nothing booked under this measure, draws its refusal sentence in
 * the same place the range would have been.
 *
 * That placement is the whole point. A refusal lifted out of the scale and set
 * beside it reads as an arm that is not in the comparison; a refusal drawn on
 * the scale reads as what it is — an arm that is in the comparison and has
 * nothing summarisable to put there yet. Metrics has drawn its refusals on its
 * own track since prd53 S4; this brings Compare into agreement with it.
 */
function ArmLane({ arm, measure, scaleMax }: { arm: ArmSummary; measure: Measure; scaleMax: number }) {
  // One floor, whatever the measure: below it every measure refuses the same
  // way (ruling 2, amended).
  const refusal =
    arm.insufficientReason !== null
      ? { testId: 'arm-insufficient', text: arm.insufficientReason }
      : measure !== 'verified' && arm.spread === null
        ? { testId: 'arm-unbooked', text: arm.unbookedNote ?? '' }
        : null
  const spread = refusal === null && measure !== 'verified' ? arm.spread : null
  const state = refusal !== null ? 'refused' : spread !== null ? 'spread' : 'counts'
  const bar =
    spread === null || scaleMax <= 0
      ? null
      : {
          left: (spread.min / scaleMax) * 100,
          width: Math.max(1.5, ((spread.max - spread.min) / scaleMax) * 100),
          median: ((median(arm.values) ?? spread.min) / scaleMax) * 100,
        }

  return (
    <div data-testid={`arm-scale-${arm.armId}`} data-scale-lane={arm.armId} data-scale-state={state} className="mt-1.5 flex flex-col gap-1">
      {spread === null ? null : (
        <p data-testid="arm-spread" className="figures text-(--ink-body)">
          min {formatValue(spread.min)} · median {formatValue(median(arm.values) ?? spread.min)} · max {formatValue(spread.max)}{' '}
          <span className="text-(--ink-dim)">
            (n={arm.values.length} of {arm.completedCount} completed)
          </span>
        </p>
      )}
      {refusal === null && measure === 'verified' ? (
        <p data-testid="arm-verified-counts" className="figures text-(--ink-body)">
          {arm.passCount} passed · {arm.failCount} failed <span className="text-(--ink-dim)">(n={arm.completedCount} completed)</span>
        </p>
      ) : null}
      <div data-testid={`arm-track-${arm.armId}`} className="relative flex min-h-6 w-full items-center border-(--line-hair) border-t pt-1">
        {refusal === null ? (
          bar === null ? null : (
            <>
              <span aria-hidden="true" className="absolute top-1/2 h-px bg-(--ink-primary)" style={{ left: `${bar.left}%`, width: `${bar.width}%` }} />
              <span
                aria-hidden="true"
                className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 h-2 w-2 border border-(--ink-primary) bg-(--surface-panel)"
                style={{ left: `${bar.median}%` }}
              />
            </>
          )
        ) : (
          <p role="status" data-testid={refusal.testId} className="border border-(--line-hair) border-dashed bg-(--surface-panel) px-2 py-0.5 text-(--ink-dim)">
            {refusal.text}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * A run's words, in their parts, so a COLLAPSED line can say "all passed"
 * where a single line says "passed" — the same facts, pluralised, never a
 * second sentence for the same thing.
 */
interface RunWordParts {
  verdict: 'passed' | 'failed' | null
  /** The value under this measure, or the honest reason there is none. Null under `verified`, where the verdict IS the value. */
  value: string | null
  /** The gate's own words after a fail, with its leading separator, or ''. */
  detail: string
}

function runWordParts(run: Run, measure: Measure): RunWordParts {
  if (run.status === 'pending') return { verdict: null, value: run.note ?? 'pending', detail: '' }
  const verdict = run.verdict === 'pass' ? 'passed' : 'failed'
  const detail = run.detail === undefined ? '' : ` — ${run.detail}`
  if (measure === 'verified') return { verdict, value: null, detail }
  if (run.value === null) return { verdict, value: run.note ?? 'no value booked under this measure', detail }
  return { verdict, value: formatValue(run.value), detail }
}

/**
 * IDENTICAL NOTES COLLAPSE TO ONE LINE PER ARM (prd-55 ruling 8): *"3 runs ·
 * all passed · nothing booked under cost"*. Six runs of one arm that all say
 * the same thing said it six times, and six copies of one sentence read as six
 * facts — the reader counts sentences, not runs, and the arm looked busier
 * than its record.
 *
 * This collapses the SUMMARY line only. prd53 ruling 1's "n runs of one arm,
 * shown individually, never collapsed" is untouched: every run is still its
 * own row, by its own id, in the list the arm's toggle expands. What is gone
 * is the repetition of one note, not the runs.
 *
 * Runs group by the words they would have printed — verdict, value, the gate's
 * own detail, and the ink that carries them — so a pass and a fail never share
 * a line however alike their values, and the groups keep the order the runs
 * arrived in (a `Map` preserves insertion order).
 */
interface RunGroup {
  key: string
  runs: Run[]
  words: string
  ink: string
}

export function collapseRuns(runs: readonly Run[], measure: Measure): RunGroup[] {
  const groups = new Map<string, { runs: Run[]; parts: RunWordParts }>()
  for (const run of runs) {
    const parts = runWordParts(run, measure)
    const key = `${runInk(run)}|${run.status}|${parts.verdict ?? ''}|${parts.value ?? ''}|${parts.detail}`
    const existing = groups.get(key)
    if (existing === undefined) groups.set(key, { runs: [run], parts })
    else existing.runs.push(run)
  }
  return [...groups].map(([key, group]) => {
    const first = group.runs[0] as Run
    return {
      key,
      runs: group.runs,
      words: group.runs.length === 1 ? runWords(first, measure) : collapsedWords(group.runs.length, group.parts),
      ink: runInk(first),
    }
  })
}

function collapsedWords(count: number, parts: RunWordParts): string {
  const said = [parts.verdict === null ? '' : `all ${parts.verdict}`, parts.value ?? ''].filter((piece) => piece.length > 0).join(' · ')
  return `${count} runs · ${said}${parts.detail}`
}

/**
 * Every run, always — with its meaning written beside it for the reader who
 * cannot hover, and one line per distinct note rather than one per run
 * (ruling 8).
 */
function RunPoints({ runs, measure }: { runs: Run[]; measure: Measure }) {
  return (
    <ol data-testid="run-dots" className="flex flex-wrap gap-2">
      {collapseRuns(runs, measure).map((group) => {
        const first = group.runs[0] as Run
        return (
          <li
            key={group.key}
            data-run-status={first.status}
            data-run-verdict={first.status === 'complete' ? first.verdict : undefined}
            data-run-count={group.runs.length}
            className={`figures flex items-baseline gap-1 ${group.ink}`}
          >
            <span aria-hidden="true">●</span>
            <span className="sr-only">{group.runs.map((run) => run.id).join(', ')}: </span>
            <span>{group.words}</span>
          </li>
        )
      })}
    </ol>
  )
}

function runInk(run: Run): string {
  if (run.status === 'pending') return 'text-(--ink-dim)'
  return run.verdict === 'pass' ? 'text-done' : 'text-broken'
}

/** A judged run says its verdict first, then its value under this measure (or why it has none); the gate's own words follow a fail. */
function runWords(run: Run, measure: Measure): string {
  const parts = runWordParts(run, measure)
  const said = [parts.verdict ?? '', parts.value ?? ''].filter((piece) => piece.length > 0).join(' · ')
  return `${said}${parts.detail}`
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}
