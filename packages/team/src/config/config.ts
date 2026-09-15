import { readFileSync } from 'node:fs'
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

/**
 * The GitHub App's identity (ruling 9, ruling 8 as amended 2026-09-08 — "the
 * human plane is a GitHub App"). All six default to the empty string: absent
 * credentials are a valid configuration, not a boot failure — the real
 * deployment has none of this set today.
 */
export const ENV_GITHUB_ORG = 'RZ_TEAM_GITHUB_ORG'
export const ENV_GITHUB_APP_ID = 'RZ_TEAM_GITHUB_APP_ID'
export const ENV_GITHUB_INSTALLATION_ID = 'RZ_TEAM_GITHUB_INSTALLATION_ID'
export const ENV_GITHUB_APP_PRIVATE_KEY = 'RZ_TEAM_GITHUB_APP_PRIVATE_KEY'
export const ENV_GITHUB_CLIENT_ID = 'RZ_TEAM_GITHUB_CLIENT_ID'
export const ENV_GITHUB_CLIENT_SECRET = 'RZ_TEAM_GITHUB_CLIENT_SECRET'

/** The file the PEM is read from, preferred over the inline value when both are set. */
export const ENV_GITHUB_APP_PRIVATE_KEY_FILE = 'RZ_TEAM_GITHUB_APP_PRIVATE_KEY_FILE'

/**
 * The seam that lets a test resolve a key file without one existing. Never
 * injected in production — `resolveTeamConfig`'s default reads the real file.
 */
export type ReadTextFileSync = (filePath: string) => string

/**
 * Every key-file fault display starts with this, so `keyFileFault` can
 * recognise one without parsing prose and a report can print it verbatim.
 */
export const KEY_FILE_FAULT_PREFIX = '<key file '

/**
 * The fault this deployment's key file has, or `null` when it has none —
 * including when no key file was configured at all, which is not a fault.
 * `deploy/serve.ts` uses it to say so on stderr at boot.
 */
export function keyFileFault(key: EffectiveValue<string>): string | null {
  return key.display.startsWith(KEY_FILE_FAULT_PREFIX) ? key.display : null
}

export interface TeamConfig {
  readonly databaseUrl: EffectiveValue<string>
  readonly migrationsDir: EffectiveValue<string>
  readonly githubOrgLogin: EffectiveValue<string>
  readonly githubAppId: EffectiveValue<string>
  readonly githubInstallationId: EffectiveValue<string>
  readonly githubAppPrivateKey: EffectiveValue<string>
  readonly githubClientId: EffectiveValue<string>
  readonly githubClientSecret: EffectiveValue<string>
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

/**
 * A secret's display value: never the secret, and distinguishable from unset.
 * Unlike `redactDatabaseUrl` there is no shape to partially preserve — a
 * private key or a client secret is opaque end to end, so redaction is total.
 */
function redactSecret(value: string): string {
  return value === '' ? '<unset>' : '<redacted>'
}

/**
 * Identity fields (org login, app id, installation id, client id) are not
 * secrets and display their real value — but `display` may never be empty
 * (`names-its-setter-law.test.ts` holds that structurally), so an unset one
 * says so rather than printing nothing.
 */
function displayIdentity(value: string): string {
  return value === '' ? '<unset>' : value
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

const defaultReadTextFile: ReadTextFileSync = (filePath) => readFileSync(filePath, 'utf8')

/**
 * THE PRIVATE KEY IS A FILE (ruled on #515).
 *
 * A docker compose `.env` cannot carry a multi-line value: it truncates at the
 * first newline, and the damage surfaces much later as an unreadable JWT rather
 * than as a config error. So the file wins when both are set, and the inline
 * variable stays supported unchanged for a host running outside docker.
 *
 * AN ABSENT OR UNREADABLE FILE IS A NAMED FAULT, NEVER A SILENT EMPTY STRING.
 * `<unset>` (nothing configured), `<key file empty: …>` and
 * `<key file unreadable: …>` are three different observations, because "you
 * forgot to mount it" and "your key is wrong" are two different fixes. The
 * VALUE is still `''` in every fault case — an unconfigured deployment boots
 * and answers 503 (#169), and a faulty one must not do anything different.
 */
function privateKeyValue(
  env: Readonly<Record<string, string | undefined>>,
  readTextFile: ReadTextFileSync,
): EffectiveValue<string> {
  const filePath = env[ENV_GITHUB_APP_PRIVATE_KEY_FILE]
  if (filePath === undefined || filePath === '') {
    return stringValue('githubAppPrivateKey', ENV_GITHUB_APP_PRIVATE_KEY, '', env, redactSecret)
  }

  const faulted = (display: string): EffectiveValue<string> => ({
    name: 'githubAppPrivateKey',
    value: '',
    setBy: 'environment',
    source: ENV_GITHUB_APP_PRIVATE_KEY_FILE,
    display,
  })

  let contents: string
  try {
    contents = readTextFile(filePath)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return faulted(`${KEY_FILE_FAULT_PREFIX}unreadable: ${filePath}: ${message}>`)
  }

  if (contents.trim() === '') return faulted(`${KEY_FILE_FAULT_PREFIX}empty: ${filePath}>`)

  return {
    name: 'githubAppPrivateKey',
    value: contents,
    setBy: 'environment',
    source: ENV_GITHUB_APP_PRIVATE_KEY_FILE,
    display: redactSecret(contents),
  }
}

export function resolveTeamConfig(
  env: Readonly<Record<string, string | undefined>>,
  readTextFile: ReadTextFileSync = defaultReadTextFile,
): TeamConfig {
  return {
    databaseUrl: stringValue('databaseUrl', ENV_DATABASE_URL, DEFAULT_DATABASE_URL, env, redactDatabaseUrl),
    migrationsDir: stringValue('migrationsDir', ENV_MIGRATIONS_DIR, MIGRATIONS_DIR, env),
    githubOrgLogin: stringValue('githubOrgLogin', ENV_GITHUB_ORG, '', env, displayIdentity),
    githubAppId: stringValue('githubAppId', ENV_GITHUB_APP_ID, '', env, displayIdentity),
    githubInstallationId: stringValue('githubInstallationId', ENV_GITHUB_INSTALLATION_ID, '', env, displayIdentity),
    githubAppPrivateKey: privateKeyValue(env, readTextFile),
    githubClientId: stringValue('githubClientId', ENV_GITHUB_CLIENT_ID, '', env, displayIdentity),
    githubClientSecret: stringValue('githubClientSecret', ENV_GITHUB_CLIENT_SECRET, '', env, redactSecret),
  }
}
