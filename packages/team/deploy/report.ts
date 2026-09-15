import {
  ENV_GITHUB_APP_PRIVATE_KEY,
  ENV_GITHUB_APP_PRIVATE_KEY_FILE,
  type TeamConfig,
} from '../src/config/config.js'

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

/**
 * THE KNOB THE OPERATOR CAN ACTUALLY TURN (review of #538).
 *
 * `RZ_TEAM_GITHUB_APP_PRIVATE_KEY_FILE` is what the APP reads, and under
 * `deploy/compose.yml` it is DERIVED —
 * `${RZ_TEAM_GITHUB_APP_PRIVATE_KEY_PATH:+/run/secrets/…}` — so an operator who
 * sets it in `.env` changes nothing: compose resolves it to `""`. And compose
 * never forwards the inline `RZ_TEAM_GITHUB_APP_PRIVATE_KEY` to the container
 * at all. So "unset the file variable and fall back to the inline one" is not a
 * move a docker deployment has, and following it turns a NAMED fault into
 * `<unset>` — the undiagnosable silence #515 exists to abolish, reached by
 * doing what the boot line said.
 *
 * The advice therefore leads with the `.env` name compose reads, and says
 * plainly that the other two are a non-docker host's knobs.
 */
export const ENV_GITHUB_APP_PRIVATE_KEY_PATH = 'RZ_TEAM_GITHUB_APP_PRIVATE_KEY_PATH'

export function formatKeyFaultAdvice(fault: string): string {
  return (
    `GitHub App private key: ${fault} — set ${ENV_GITHUB_APP_PRIVATE_KEY_PATH} in deploy/.env to the ` +
    'HOST path of a readable PEM, then `docker compose up -d` (compose mounts it read-only at ' +
    '/run/secrets/github-app-private-key.pem). Clearing it does NOT fall back to ' +
    `${ENV_GITHUB_APP_PRIVATE_KEY}: compose never passes that variable to this container, so the key ` +
    'becomes <unset> and sign-in stays refused with nothing on stderr. Outside docker, set ' +
    `${ENV_GITHUB_APP_PRIVATE_KEY_FILE} or ${ENV_GITHUB_APP_PRIVATE_KEY} directly. Sign-in stays ` +
    'refused with 503 until then; ingest is unaffected.'
  )
}
