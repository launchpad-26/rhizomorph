export interface BootstrapReport {
  readonly applied: readonly string[]
  readonly alreadyApplied: readonly string[]
}

/** Renders `bootstrapTeamStorage`'s success shape as one operator-readable line. */
export function formatBootReport(report: BootstrapReport): string {
  const appliedList = report.applied.length > 0 ? ` (${report.applied.join(', ')})` : ''
  const alreadyList = report.alreadyApplied.length > 0 ? ` (${report.alreadyApplied.join(', ')})` : ''
  const tail = report.applied.length === 0 ? ' — nothing to do' : ''
  return `migrations: ${report.applied.length} applied${appliedList}, ${report.alreadyApplied.length} already applied${alreadyList}${tail}`
}
