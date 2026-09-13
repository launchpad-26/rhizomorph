import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DATABASE_URL,
  ENV_DATABASE_URL,
  ENV_GITHUB_APP_ID,
  ENV_GITHUB_APP_PRIVATE_KEY,
  ENV_GITHUB_CLIENT_SECRET,
  ENV_GITHUB_ORG,
  ENV_MIGRATIONS_DIR,
  redactDatabaseUrl,
  resolveTeamConfig,
} from './config.js'

/** The literal used everywhere a fixture needs a password. Synthetic, and greppable. */
const PASSWORD = 'hunter2'

describe('case 33 — an override names the variable, a default names the file', () => {
  it('the overridden field says environment and names the variable', () => {
    const url = `postgres://rz:${PASSWORD}@db.invalid:5432/rhizomorph`
    const config = resolveTeamConfig({ [ENV_DATABASE_URL]: url })

    expect(config.databaseUrl.value).toBe(url)
    expect(config.databaseUrl.setBy).toBe('environment')
    expect(config.databaseUrl.source).toBe(ENV_DATABASE_URL)
  })

  it('the others stay default and keep naming the module that set them', () => {
    const config = resolveTeamConfig({ [ENV_DATABASE_URL]: 'postgres://db.invalid/rz' })
    expect(config.migrationsDir.setBy).toBe('default')
    expect(config.migrationsDir.source).toBe('packages/team/src/config/config.ts')
  })

  it('every environment variable this package reads is actually read', () => {
    const config = resolveTeamConfig({
      [ENV_DATABASE_URL]: 'postgres://db.invalid/one',
      [ENV_MIGRATIONS_DIR]: '/opt/rhizomorph/migrations',
    })
    expect(config.databaseUrl.value).toBe('postgres://db.invalid/one')
    expect(config.migrationsDir.value).toBe('/opt/rhizomorph/migrations')
    expect([config.databaseUrl.source, config.migrationsDir.source]).toEqual([ENV_DATABASE_URL, ENV_MIGRATIONS_DIR])
  })

  it('an empty environment variable is not an override — it is an unset variable spelled badly', () => {
    const config = resolveTeamConfig({ [ENV_DATABASE_URL]: '' })
    expect(config.databaseUrl.value).toBe(DEFAULT_DATABASE_URL)
    expect(config.databaseUrl.setBy).toBe('default')
  })

})

describe('case 34 — display never carries the password', () => {
  it('a URL with userinfo', () => {
    const url = `postgres://rz:${PASSWORD}@db.invalid:5432/rhizomorph`
    const display = resolveTeamConfig({ [ENV_DATABASE_URL]: url }).databaseUrl.display
    expect(display).not.toContain(PASSWORD)
    expect(display).toBe('postgres://***@db.invalid:5432/rhizomorph')
  })

  it('a URL with a username and no password still redacts the username', () => {
    const display = redactDatabaseUrl('postgres://rz@db.invalid:5432/rhizomorph')
    expect(display).toBe('postgres://***@db.invalid:5432/rhizomorph')
  })

  it('a URL with no userinfo passes through unchanged', () => {
    expect(redactDatabaseUrl(DEFAULT_DATABASE_URL)).toBe(DEFAULT_DATABASE_URL)
    expect(resolveTeamConfig({}).databaseUrl.display).toBe(DEFAULT_DATABASE_URL)
  })

  it('a malformed URL is redacted whole, because we cannot say where its parts are', () => {
    for (const malformed of [
      `postgres://rz:${PASSWORD}@`,
      `postgres://rz:${PASSWORD}`,
      `://rz:${PASSWORD}@db.invalid`,
      PASSWORD,
    ]) {
      const display = redactDatabaseUrl(malformed)
      expect(display).not.toContain(PASSWORD)
    }
  })

  it('the redaction is not vacuous — it really parsed a real URL and kept the host', () => {
    const display = redactDatabaseUrl(`postgres://rz:${PASSWORD}@db.invalid:5432/rhizomorph?sslmode=require`)
    expect(display).toContain('db.invalid:5432')
    expect(display).toContain('sslmode=require')
    expect(display).not.toContain(PASSWORD)
  })

  it('the value itself is NOT redacted — a redacted connection string would not connect', () => {
    const url = `postgres://rz:${PASSWORD}@db.invalid:5432/rhizomorph`
    expect(resolveTeamConfig({ [ENV_DATABASE_URL]: url }).databaseUrl.value).toBe(url)
  })

  /**
   * The ratchet. prd-51 ruling 4 states the `synchronous_commit=off` refusal
   * with no exception clause, and an escape hatch (`requireDurableCommit`,
   * `RZ_TEAM_REQUIRE_DURABLE_COMMIT`) was written during the build and removed
   * in review. Deleting it is not enough on its own: the next lane to want a
   * throwaway database will reach for exactly the same field, and a deletion
   * leaves no trace saying why it must not come back.
   *
   * So this asserts the SHAPE, not the absence of one identifier: no config
   * key, and no environment variable this module reads, may be named for
   * durability or commit behaviour. Re-adding the field under any spelling
   * reddens here, and the reader is sent to ruling 4.
   *
   * MUTATION: restore `requireDurableCommit` to `resolveTeamConfig` — red.
   */
  it('carries no key that could switch the durability refusal off — ruling 4 has no exception clause', () => {
    const forbidden = /durabl|synchronous|commit|fsync/i
    const keys = Object.keys(resolveTeamConfig({}))
    expect(keys).not.toHaveLength(0)
    expect(keys.filter((k) => forbidden.test(k))).toEqual([])

    const sources = Object.values(resolveTeamConfig({})).map((v) => v.source)
    expect(sources.filter((sourceName) => forbidden.test(sourceName))).toEqual([])
  })
})

describe('case 36 — the GitHub App identity names its setter, same as every other field', () => {
  it('an empty environment leaves all six fields default, empty, and pointed at this file', () => {
    const config = resolveTeamConfig({})
    for (const field of [
      config.githubOrgLogin,
      config.githubAppId,
      config.githubInstallationId,
      config.githubAppPrivateKey,
      config.githubClientId,
      config.githubClientSecret,
    ]) {
      expect(field.setBy).toBe('default')
      expect(field.value).toBe('')
      expect(field.source).toBe('packages/team/src/config/config.ts')
    }
  })

  it('one override flips only that field to environment, and names the variable', () => {
    const config = resolveTeamConfig({ [ENV_GITHUB_ORG]: 'rhizomorph-team' })
    expect(config.githubOrgLogin.value).toBe('rhizomorph-team')
    expect(config.githubOrgLogin.setBy).toBe('environment')
    expect(config.githubOrgLogin.source).toBe(ENV_GITHUB_ORG)

    expect(config.githubAppId.setBy).toBe('default')
    expect(config.githubInstallationId.setBy).toBe('default')
    expect(config.githubAppPrivateKey.setBy).toBe('default')
    expect(config.githubClientId.setBy).toBe('default')
    expect(config.githubClientSecret.setBy).toBe('default')
  })

  it('an empty-string override is not an override, for the identity fields too', () => {
    const config = resolveTeamConfig({ [ENV_GITHUB_APP_ID]: '' })
    expect(config.githubAppId.value).toBe('')
    expect(config.githubAppId.setBy).toBe('default')
  })
})

describe('case 37 — secrets redact in display, identity does not', () => {
  /** Synthetic fixtures only — never a real key or secret. */
  const FAKE_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----'
  const FAKE_CLIENT_SECRET = 'shhh-client-secret'

  it('an unset secret displays as unset, not empty and not the value', () => {
    const config = resolveTeamConfig({})
    expect(config.githubAppPrivateKey.display).toBe('<unset>')
    expect(config.githubClientSecret.display).toBe('<unset>')
  })

  it('an unset identity field also displays as unset, never as an empty string', () => {
    const config = resolveTeamConfig({})
    expect(config.githubOrgLogin.display).toBe('<unset>')
    expect(config.githubAppId.display).toBe('<unset>')
    expect(config.githubInstallationId.display).toBe('<unset>')
    expect(config.githubClientId.display).toBe('<unset>')
  })

  it('a set secret displays as redacted, and the literal never survives into display', () => {
    const config = resolveTeamConfig({
      [ENV_GITHUB_APP_PRIVATE_KEY]: FAKE_PRIVATE_KEY,
      [ENV_GITHUB_CLIENT_SECRET]: FAKE_CLIENT_SECRET,
    })
    expect(config.githubAppPrivateKey.display).toBe('<redacted>')
    expect(config.githubClientSecret.display).toBe('<redacted>')

    const allDisplays = JSON.stringify(Object.values(config).map((v) => v.display))
    expect(allDisplays).not.toContain(FAKE_PRIVATE_KEY)
    expect(allDisplays).not.toContain(FAKE_CLIENT_SECRET)

    // The value itself is NOT redacted — a redacted key could not sign anything.
    expect(config.githubAppPrivateKey.value).toBe(FAKE_PRIVATE_KEY)
    expect(config.githubClientSecret.value).toBe(FAKE_CLIENT_SECRET)
  })

  it('identity fields are not secrets and display their real value', () => {
    const config = resolveTeamConfig({
      [ENV_GITHUB_ORG]: 'rhizomorph-team',
      [ENV_GITHUB_APP_ID]: '123456',
    })
    expect(config.githubOrgLogin.display).toBe('rhizomorph-team')
    expect(config.githubAppId.display).toBe('123456')
  })
})
