import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENV_DATABASE_URL, resolveTeamConfig } from './config.js'

/**
 * THE NAMES-ITS-SETTER LAW (prd-51 ruling 9).
 *
 * Ruling 9: every value the server will later report as effective names who set
 * it and where, **even where the only setter today is a default**.
 *
 * The walk below is **structural**, not a hand-written roster of the eight
 * fields that exist today. That is the whole design of this law: a roster is
 * satisfied by the fields someone remembered to add to it, so the field added
 * next year without provenance would ship green. Walking every own enumerable
 * property means the law reddens for a field it has never heard of.
 *
 * **The mutation it exists to catch**, planted and observed red before this file
 * was committed: adding a bare `port: 5432` to the object `resolveTeamConfig`
 * returns.
 */

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

function isEffectiveValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

describe('case 32 — every field carries its provenance, structurally', () => {
  it('every own enumerable property of an empty-environment config is an EffectiveValue', () => {
    const config = resolveTeamConfig({}) as unknown as Record<string, unknown>
    const entries = Object.entries(config)

    // Not vacuous: a walk over an empty object would pass every assertion below.
    // The floor is the config's current field count. It moved 3 → 2 in the
    // review of #355 when the `requireDurableCommit` override was removed —
    // prd-51 ruling 4 states its refusal with no exception clause, so the field
    // should never have existed — and 2 → 8 in #169, which added the six
    // GitHub App identity fields ruling 9 requires (org login, app id,
    // installation id, private key, client id, client secret). Re-derive this
    // number when a field is added or removed; do not raise it speculatively,
    // and do not delete it, because a walk over an empty object is exactly
    // what it exists to catch.
    expect(entries.length).toBeGreaterThanOrEqual(8)

    for (const [key, value] of entries) {
      expect(isEffectiveValue(value), `${key} is a bare value, not an EffectiveValue`).toBe(true)
      const effective = value as Record<string, unknown>
      expect(typeof effective.name, `${key}.name`).toBe('string')
      expect(String(effective.name).length, `${key}.name is empty`).toBeGreaterThan(0)
      expect(['default', 'environment'], `${key}.setBy`).toContain(effective.setBy)
      expect(String(effective.source ?? '').length, `${key}.source is empty`).toBeGreaterThan(0)
      expect(String(effective.display ?? '').length, `${key}.display is empty`).toBeGreaterThan(0)
      expect('value' in effective, `${key} has no value`).toBe(true)
    }
  })

  it('each field names itself, so a report cannot mislabel a row', () => {
    const config = resolveTeamConfig({}) as unknown as Record<string, { name: string }>
    for (const [key, value] of Object.entries(config)) expect(value.name).toBe(key)
  })

  it('the detector catches the mutation it names — a bare field', () => {
    const mutated: Record<string, unknown> = { ...(resolveTeamConfig({}) as unknown as object), port: 5432 }
    const bare = Object.entries(mutated).filter(([, value]) => !isEffectiveValue(value))
    expect(bare.map(([key]) => key)).toEqual(['port'])
  })
})

describe('case 33 — a default names a tracked path that exists', () => {
  it('every default source resolves to a real file in this repository', () => {
    const config = resolveTeamConfig({}) as unknown as Record<string, { setBy: string; source: string }>
    const defaults = Object.values(config).filter((v) => v.setBy === 'default')
    expect(defaults.length).toBeGreaterThan(0)

    for (const value of defaults) {
      // A source that is prose rather than a locatable setter fails here.
      expect(value.source).not.toContain(' ')
      expect(existsSync(path.join(REPO_ROOT, value.source)), `${value.source} does not exist`).toBe(true)
    }
  })

  it('and an override names an environment variable, not a path', () => {
    const config = resolveTeamConfig({ [ENV_DATABASE_URL]: 'postgres://db.invalid/rz' })
    expect(config.databaseUrl.source).toBe(ENV_DATABASE_URL)
    expect(existsSync(path.join(REPO_ROOT, config.databaseUrl.source))).toBe(false)
  })
})
