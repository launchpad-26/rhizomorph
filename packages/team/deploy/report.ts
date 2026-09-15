import type { TeamConfig } from '../src/config/config.js'

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

/**
 * EVERY EFFECTIVE VALUE, AND NEVER A SECRET (prd-51 ruling 9).
 *
 * The walk is STRUCTURAL — `Object.values(config)` — not a roster of the eight
 * fields that exist today, for the same reason `names-its-setter-law.test.ts`
 * walks rather than lists: a roster is satisfied by the fields someone
 * remembered to add to it, and a configured credential the boot report is
 * silent about is exactly the honest-gap failure this repo names first.
 *
 * It prints `display` and NEVER `value`. That single line is the whole
 * redaction: `config.ts` decides what a field may show, and this function has
 * no opinion and no exception.
 */
export function formatConfigReport(config: TeamConfig): string {
  const values = Object.values(config)
  const rows = values.map((v) => `  ${v.name} = ${v.display} (set by ${v.setBy}, ${v.source})`)
  return [`config: ${values.length} effective values`, ...rows].join('\n')
}
