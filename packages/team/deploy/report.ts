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

/**
 * THE DEPLOYMENT'S OWN KNOBS, RESOLVED ONCE (#543's finding, one layer over).
 *
 * `deploy/serve.ts` reads these two off `process.env` rather than through
 * `resolveTeamConfig`, because `deploy/report.test.ts` pins the config's
 * `unsetCount` at an exact number and a new `TeamConfig` value would move it.
 * That reasoning stands — but it left the DEFAULTS written down in exactly one
 * place, and the doctor has to print the value the SERVER is actually using.
 *
 * A second copy of `Number(process.env.RZ_TEAM_FOLD_TICK_MS ?? 5000)` in
 * `doctor.ts` is a doctor that drifts from the server it diagnoses, and it
 * drifts silently: every test on both sides stays green while the printed
 * "effective" value stops being effective. So the resolution lives here, once,
 * and both files import it. `doctor.test.ts` greps `serve.ts` for that import,
 * because nothing else would notice the day someone inlines it back.
 *
 * ## NEITHER OF THESE IS FORWARDED BY `compose.yml`, AND THAT IS THE POINT
 *
 * `compose.yml`'s `app` service passes `RZ_TEAM_DATABASE_URL`, `RZ_TEAM_PROJECT`,
 * `RZ_TEAM_INGEST_KEY_SHA256`, the GitHub six, `PORT` and `HOST` — and nothing
 * else. So an operator who sets `RZ_TEAM_FOLD_TICK_MS` or `RZ_TEAM_JOURNAL_DIR`
 * in `deploy/.env` changes nothing at all: compose never hands either to the
 * container. That is the same shape {@link formatKeyFaultAdvice} exists to
 * refuse one variable over, and the doctor's remedies name the edit that works
 * (the `environment:` block in `compose.yml`) rather than the `.env` line that
 * does not. `doctor.test.ts` reads both facts out of `compose.yml`, so if
 * compose ever starts forwarding them the advice reddens instead of rotting.
 */
export const ENV_FOLD_TICK_MS = 'RZ_TEAM_FOLD_TICK_MS'

/** What `serve.ts` uses when the variable is absent. Milliseconds. */
export const DEFAULT_FOLD_TICK_MS = 5000

export const ENV_JOURNAL_DIR = 'RZ_TEAM_JOURNAL_DIR'

/** Where `compose.yml` mounts the `team_journal` volume. */
export const DEFAULT_JOURNAL_DIR = '/data/journal'

export interface FoldTick {
  /** Exactly what the environment carried, or `undefined` when it carried nothing. */
  readonly raw: string | undefined
  /** What `startFoldWorker` will actually be given. `0` disables the tick. */
  readonly effectiveMs: number
  /** Whether the periodic tick runs at all. `false` means wake-and-boot-drain only. */
  readonly armed: boolean
  /** True when a value WAS set and is not a number — the `5s` typo, which reads as `0`. */
  readonly notANumber: boolean
}

/**
 * The tick the fold worker will really run at.
 *
 * `Number('5s')` is `NaN`, and `startFoldWorker` treats a non-positive or
 * non-finite tick as "no tick" — so `RZ_TEAM_FOLD_TICK_MS=5s` **disables** the
 * tick rather than setting five seconds. The runbook says so; nothing until now
 * could tell an operator it had happened to them.
 */
export function resolveFoldTickMs(env: Readonly<Record<string, string | undefined>>): FoldTick {
  const raw = env[ENV_FOLD_TICK_MS]
  const parsed = Number(raw ?? DEFAULT_FOLD_TICK_MS)
  const notANumber = raw !== undefined && !Number.isFinite(parsed)
  const effectiveMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  return { raw, effectiveMs, armed: effectiveMs > 0, notANumber }
}

/** Where the journal and its cursor live. */
export function resolveJournalDir(env: Readonly<Record<string, string | undefined>>): string {
  return env[ENV_JOURNAL_DIR] ?? DEFAULT_JOURNAL_DIR
}
