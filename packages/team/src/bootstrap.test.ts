import { describe, expect, it } from 'vitest'
import { ACCEPTED_SYNCHRONOUS_COMMIT, assertDurableCommit, bootstrapTeamStorage } from './bootstrap.js'
import { resolveTeamConfig } from './config/config.js'
import { FakeTeamStorage } from './storage/fake.js'

/**
 * RULING 4'S REFUSAL.
 *
 * The load-bearing test here is not the one that reads the error message — a
 * warn-and-continue implementation names the setting too. It is case 28: with
 * `synchronous_commit = off`, the fake storage records **zero**
 * `applyMigration` calls and **zero** `ensureMigrationsTable` calls. That is
 * what "the install refuses to start" means, and it is what flipping the check
 * to a warning breaks.
 */

const config = resolveTeamConfig({})

function fakeWith(synchronousCommit: string): FakeTeamStorage {
  return new FakeTeamStorage({ settings: { synchronous_commit: synchronousCommit } })
}

describe('case 27 — the refusal names the setting, the value and the remedy', () => {
  it('refuses against off', async () => {
    const fake = fakeWith('off')
    const result = await bootstrapTeamStorage(fake, config)

    expect(result.ok).toBe(false)
    const error = result.ok ? '' : result.error
    expect(error).toContain('synchronous_commit')
    expect(error).toContain("'off'")
    expect(error).toContain('ALTER SYSTEM SET')
  })
})

describe('case 28 — the refusal is a refusal, not a warning', () => {
  it('touches nothing: no migrations table, no migration, no read of the applied list', async () => {
    const fake = fakeWith('off')

    await bootstrapTeamStorage(fake, config)

    expect(fake.calls).toEqual(['readSetting'])
    expect(fake.calls).not.toContain('ensureMigrationsTable')
    expect(fake.applyAttempts).toEqual([])
    expect(fake.committed).toEqual([])
    expect(fake.migrationsTableExists).toBe(false)
  })
})

describe('case 29 — an equal-or-stronger setting is accepted', () => {
  it.each(ACCEPTED_SYNCHRONOUS_COMMIT)('accepts %s and runs the migrations', async (value) => {
    const fake = fakeWith(value)

    const result = await bootstrapTeamStorage(fake, config)

    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.applied).toEqual([
      '0001_events',
      '0002_projections',
      '0003_roles_rls',
      '0004_events_dedup',
      '0005_ingest_keys',
    ])
    expect(fake.migrationsTableExists).toBe(true)
  })

  it('accepts them case- and whitespace-insensitively, the way Postgres reports them', async () => {
    expect(await assertDurableCommit(fakeWith('  On  '))).toEqual({ ok: true })
    expect(await assertDurableCommit(fakeWith('REMOTE_APPLY'))).toEqual({ ok: true })
  })

  it('the accepted set is exactly the four ruling 4 reasons about', () => {
    expect([...ACCEPTED_SYNCHRONOUS_COMMIT]).toEqual(['on', 'local', 'remote_write', 'remote_apply'])
  })
})

describe('case 30 — an unrecognised value fails closed', () => {
  it.each(['maybe', '', 'ON_SOMETIMES', 'true'])('refuses %o by name', async (value) => {
    const fake = fakeWith(value)
    const result = await bootstrapTeamStorage(fake, config)

    expect(result.ok).toBe(false)
    const error = result.ok ? '' : result.error
    expect(error).toContain('does not recognise')
    expect(error).toContain(value.toLowerCase())
    expect(fake.applyAttempts).toEqual([])
  })
})

describe('case 31 — the preflight is first', () => {
  it('reads the setting before anything else, on the happy path too', async () => {
    const fake = fakeWith('on')
    await bootstrapTeamStorage(fake, config)
    expect(fake.calls[0]).toBe('readSetting')
    expect(fake.calls.indexOf('readSetting')).toBeLessThan(fake.calls.indexOf('ensureMigrationsTable'))
  })
})

describe('the durability refusal has no exception clause (prd-51 ruling 4)', () => {
  /**
   * An opt-in override lived here during the build and was removed in review.
   * Ruling 4 states the refusal unconditionally, and `CONTRIBUTING.md` permits
   * a law to be restated at equal or greater strength and never weakened.
   *
   * This asserts the strengthened form: NO environment a caller can construct
   * gets past the refusal. It is deliberately not "the field is gone" — that
   * would pass the moment someone spelled the field differently.
   *
   * MUTATION: re-add the override and pass it here — red, because the bootstrap
   * returns ok:false regardless of what the environment says.
   */
  it('refuses under every environment a caller can hand it, not merely the default one', async () => {
    const environments = [
      {},
      { RZ_TEAM_REQUIRE_DURABLE_COMMIT: 'false' },
      { RZ_TEAM_REQUIRE_DURABLE_COMMIT: 'no' },
      { RZ_TEAM_REQUIRE_DURABLE_COMMIT: '0' },
      { RZ_TEAM_DURABLE: 'off' },
    ]
    for (const env of environments) {
      const fake = fakeWith('off')
      const result = await bootstrapTeamStorage(fake, resolveTeamConfig(env))
      expect(result).toMatchObject({ ok: false })
      expect(fake.calls).toEqual(['readSetting'])
    }
  })
})

describe('bootstrap surfaces a migration refusal rather than swallowing it', () => {
  it('reports the runner error when a migration fails', async () => {
    const fake = new FakeTeamStorage({
      settings: { synchronous_commit: 'on' },
      failApply: ['0002_projections'],
    })
    const result = await bootstrapTeamStorage(fake, config)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('0002_projections')
  })
})
