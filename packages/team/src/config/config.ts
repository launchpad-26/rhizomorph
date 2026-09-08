import { MIGRATIONS_DIR } from '../migrations/runner.js'
import type { EffectiveValue } from '../storage/contract.js'

/**
 * EVERY VALUE NAMES ITS SETTER (prd-51 ruling 9).
 *
 * Ruling 9 asks that every value the server will later report as effective say
 * **who set it and where** — "even where the only setter today is a default".
 * That clause is the whole point, and it is the one an implementation quietly
 * drops: a default with no provenance is the value an operator cannot find,
 * because there is nothing to grep for and no file to open.
 *
 * So there are no bare fields on {@link TeamConfig}. Every one is an
 * {@link EffectiveValue}, a default carries the tracked path of the module that
 * set it, and an override carries the environment variable's own name.
 * `names-its-setter-law.test.ts` walks the resolved object structurally rather
 * than checking a hand-written roster, so a field added later without
 * provenance reddens the suite instead of shipping.
 *
 * `display` is what a report may print, and it is never a secret: a database
 * URL's userinfo is stripped before it can reach a log line, a health endpoint
 * or a support bundle.
 */

/** The module that sets every default here. A tracked path, so an operator can open it. */
const DEFAULTS_SOURCE = 'packages/team/src/config/config.ts'

/** No credentials, and a host that cannot resolve to somebody's machine by accident. */
export const DEFAULT_DATABASE_URL = 'postgres://localhost:5432/rhizomorph'

export const ENV_DATABASE_URL = 'RZ_TEAM_DATABASE_URL'
export const ENV_MIGRATIONS_DIR = 'RZ_TEAM_MIGRATIONS_DIR'

export interface TeamConfig {
  readonly databaseUrl: EffectiveValue<string>
  readonly migrationsDir: EffectiveValue<string>
}

/**
 * A database URL with its userinfo removed.
 *
 * The unparseable branch returns the scheme and nothing else. Returning the
 * input with a best-effort substitution would be the tempting choice and it is
 * the wrong one: the whole reason a URL is unparseable is that we do not know
 * where its parts are, and a redaction that only works on the shapes we thought
 * of is a redaction that leaks on the shape we did not.
 */
export function redactDatabaseUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.username === '' && url.password === '') return url.toString()
    url.password = ''
    url.username = '***'
    return url.toString()
  } catch {
    const scheme = /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.exec(raw)?.[0] ?? ''
    return `${scheme}<unparseable, redacted>`
  }
}

function stringValue(
  name: string,
  envName: string,
  fallback: string,
  env: Readonly<Record<string, string | undefined>>,
  display: (value: string) => string = (value) => value,
): EffectiveValue<string> {
  const override = env[envName]
  const value = override !== undefined && override !== '' ? override : fallback
  const setBy = override !== undefined && override !== '' ? 'environment' : 'default'
  return { name, value, setBy, source: setBy === 'environment' ? envName : DEFAULTS_SOURCE, display: display(value) }
}

export function resolveTeamConfig(env: Readonly<Record<string, string | undefined>>): TeamConfig {
  return {
    databaseUrl: stringValue('databaseUrl', ENV_DATABASE_URL, DEFAULT_DATABASE_URL, env, redactDatabaseUrl),
    migrationsDir: stringValue('migrationsDir', ENV_MIGRATIONS_DIR, MIGRATIONS_DIR, env),
  }
}
