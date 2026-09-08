import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DATABASE_URL,
  ENV_DATABASE_URL,
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
