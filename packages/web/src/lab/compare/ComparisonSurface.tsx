import type { ArmSummary, Comparison, ComparisonClaim, Run } from './types.js'

/**
 * THE COMPARISON SURFACE (prd14 ruling 3). Renders `compareArms`'s output
 * with no adaptation — every run always shown, spread shown as a range never
 * a point, an arm below n=3 completed runs speaks its own reason instead of
 * a dash, and nothing here sorts arms by value or marks one as leading
 * (law 4: no winner, no leading marker, no ranking, ever).
 *
 * A confounded claim (ruling 2 — arms differing in more than one dimension)
 * gets an explicit voice naming why, in place of any comparative statement —
 * the arms still render side by side beneath it, each honestly on its own.
 */
export interface ComparisonSurfaceProps {
  comparison: Comparison
}

export function ComparisonSurface({ comparison }: ComparisonSurfaceProps) {
  return (
    <section data-testid="comparison-surface" className="flex flex-col gap-3 text-[11px] text-ice-300">
      <ClaimBanner claim={comparison.claim} />
      <ol className="flex flex-col gap-3">
        {comparison.arms.map((arm) => (
          <li key={arm.armId}>
            <ArmPanel arm={arm} />
          </li>
        ))}
      </ol>
    </section>
  )
}

function ClaimBanner({ claim }: { claim: ComparisonClaim }) {
  return (
    <p role="status" data-testid="comparison-claim" className="text-[11px] leading-snug text-ice-400">
      <span className="text-[10px] uppercase tracking-[0.2em] text-ice-400">{claimLabel(claim)}</span>
      {claimDetail(claim) === null ? null : <> — {claimDetail(claim)}</>}
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
      return 'these arms share the same model and brief; these are replicate runs, not a comparison.'
    case 'comparable':
      return `these arms differ in ${claim.dimension} only.`
    case 'confounded':
      return claim.reason
  }
}

function ArmPanel({ arm }: { arm: ArmSummary }) {
  return (
    <div data-testid="arm-panel" className="rounded border border-ice-850 p-3">
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] text-ice-100">{arm.model}</span>
        <span className="max-w-[60%] truncate text-[10px] text-ice-400" title={arm.brief}>
          {arm.brief}
        </span>
      </header>

      <RunDots runs={arm.runs} />

      {arm.spread !== null ? (
        <p data-testid="arm-spread" className="figures mt-1.5 text-[11px] text-ice-200">
          spread {formatValue(arm.spread.min)}–{formatValue(arm.spread.max)}
        </p>
      ) : (
        <p role="status" data-testid="arm-insufficient" className="mt-1.5 text-[11px] text-ice-400">
          {arm.insufficientReason}
        </p>
      )}

      {arm.incompleteNote === null ? null : (
        <p data-testid="arm-incomplete-note" className="mt-1 text-[10px] text-ice-400">
          {arm.incompleteNote}
        </p>
      )}
    </div>
  )
}

function RunDots({ runs }: { runs: Run[] }) {
  return (
    <ol data-testid="run-dots" className="flex flex-wrap gap-1.5">
      {runs.map((run) => (
        <li key={run.id} title={runTitle(run)} className={runDotClass(run)}>
          ●
        </li>
      ))}
    </ol>
  )
}

function runDotClass(run: Run): string {
  const base = 'font-mono text-[13px] leading-none'
  if (run.status === 'complete') return `${base} text-done`
  if (run.status === 'pending') return `${base} text-working`
  return `${base} text-broken`
}

function runTitle(run: Run): string {
  if (run.status === 'complete') return `${run.id}: ${formatValue(run.value)}`
  if (run.status === 'pending') return `${run.id}: pending`
  return run.error === undefined ? `${run.id}: failed` : `${run.id}: failed — ${run.error}`
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}
