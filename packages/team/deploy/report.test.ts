import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ENV_DATABASE_URL,
  ENV_GITHUB_APP_ID,
  ENV_GITHUB_APP_PRIVATE_KEY,
  ENV_GITHUB_APP_PRIVATE_KEY_FILE,
  ENV_GITHUB_CLIENT_SECRET,
  ENV_GITHUB_ORG,
  resolveTeamConfig,
} from '../src/config/config.js'
import {
  ENV_GITHUB_APP_PRIVATE_KEY_PATH,
  formatBootReport,
  formatConfigReport,
  formatKeyFaultAdvice,
} from './report.js'

describe('formatBootReport', () => {
  it('happy path (first boot): names what applied, and never claims nothing to do', () => {
    const line = formatBootReport({ applied: ['0001_events'], alreadyApplied: [] })
    expect(line).toContain('1 applied (0001_events)')
    expect(line).not.toContain('nothing to do')
  })

  it("the DoD's actual claim (second boot): a no-op run says so, by name", () => {
    const line = formatBootReport({
      applied: [],
      alreadyApplied: ['0001_events', '0002_projections', '0003_roles_rls', '0004_events_dedup'],
    })
    expect(line).toContain('0 applied')
    expect(line).toContain('nothing to do')
    expect(line).toContain('0001_events')
    expect(line).toContain('0002_projections')
    expect(line).toContain('0003_roles_rls')
    expect(line).toContain('0004_events_dedup')
  })

  it('failure/edge path: zero migrations either way still renders a sane line', () => {
    const line = formatBootReport({ applied: [], alreadyApplied: [] })
    expect(line).toBe('migrations: 0 applied, 0 already applied — nothing to do')
  })

  it('repetition: calling it twice with the same input returns the identical string', () => {
    const report = { applied: [], alreadyApplied: ['0001_events'] }
    expect(formatBootReport(report)).toBe(formatBootReport(report))
  })
})

describe('formatConfigReport', () => {
  it('every field gets a row, derived from the config and not from a list here', () => {
    const config = resolveTeamConfig({})
    const report = formatConfigReport(config)
    const lines = report.split('\n')
    expect(lines.length).toBe(Object.keys(config).length + 1)
    for (const name of Object.keys(config)) {
      expect(report).toContain(`  ${name} = `)
    }
  })

  it('the header is not vacuous', () => {
    const config = resolveTeamConfig({})
    const report = formatConfigReport(config)
    expect(report).toContain('8 effective values')
    expect(report.split('\n')[0]).toBe(`config: ${Object.keys(config).length} effective values`)
  })

  it('THE SECRET-LEAK LAW — asserted against the actual secret strings', () => {
    const SECRET_PASSWORD = 'hunter2'
    const FAKE_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nFAKE-REPORT\n-----END RSA PRIVATE KEY-----'
    const FAKE_CLIENT_SECRET = 'shhh-report-client-secret'

    const config = resolveTeamConfig({
      [ENV_DATABASE_URL]: `postgres://rz:${SECRET_PASSWORD}@db.invalid:5432/rhizomorph`,
      [ENV_GITHUB_APP_PRIVATE_KEY]: FAKE_PRIVATE_KEY,
      [ENV_GITHUB_CLIENT_SECRET]: FAKE_CLIENT_SECRET,
    })
    const report = formatConfigReport(config)

    expect(report).not.toContain(FAKE_PRIVATE_KEY)
    expect(report).not.toContain(FAKE_CLIENT_SECRET)
    expect(report).not.toContain(SECRET_PASSWORD)
    expect(report).not.toContain(FAKE_PRIVATE_KEY.slice(0, 40))
    expect(report).not.toContain(FAKE_CLIENT_SECRET.slice(0, 10))
    expect(report).toContain('githubAppPrivateKey = <redacted>')
    expect(report).toContain('githubClientSecret = <redacted>')
  })

  it('not vacuous — the report really does print the non-secrets', () => {
    const config = resolveTeamConfig({
      [ENV_DATABASE_URL]: 'postgres://rz:hunter2@db.invalid:5432/rhizomorph',
      [ENV_GITHUB_ORG]: 'rhizomorph-team',
      [ENV_GITHUB_APP_ID]: '123456',
    })
    const report = formatConfigReport(config)
    expect(report).toContain('githubOrgLogin = rhizomorph-team')
    expect(report).toContain('123456')
    expect(report).toContain('db.invalid:5432')
    expect(report).toContain(ENV_GITHUB_ORG)
  })

  it('a key-file fault reaches the report by name', () => {
    const config = resolveTeamConfig(
      { [ENV_GITHUB_APP_PRIVATE_KEY_FILE]: '/run/secrets/github-app-private-key.pem' },
      () => {
        throw new Error('ENOENT: no such file or directory')
      },
    )
    const report = formatConfigReport(config)
    expect(report).toContain('githubAppPrivateKey = <key file unreadable:')
    expect(report).toContain('ENOENT')
  })

  it('an unconfigured deployment still renders a complete report', () => {
    const config = resolveTeamConfig({})
    const report = formatConfigReport(config)
    const unsetCount = (report.match(/<unset>/g) ?? []).length
    expect(unsetCount).toBe(6)
    expect(report).not.toContain('undefined')
    expect(report).not.toContain(' = \n')
  })

  it('repetition', () => {
    const config = resolveTeamConfig({})
    expect(formatConfigReport(config)).toBe(formatConfigReport(config))
  })
})

/**
 * THE ADVICE IS CHECKED AGAINST compose.yml, NOT AGAINST MEMORY (review of #538).
 *
 * The boot line this covers used to name `RZ_TEAM_GITHUB_APP_PRIVATE_KEY_FILE`
 * and the inline `RZ_TEAM_GITHUB_APP_PRIVATE_KEY`, and under compose an
 * operator can set neither: the first is derived from `_PATH` by `${...:+}` and
 * resolves to `""` when set in `.env`, and the second is never passed to the
 * app service at all. Both facts live in `compose.yml`, so both are read from
 * it here — if compose ever starts forwarding the inline variable, the second
 * test reddens and the advice may be relaxed rather than silently rotting.
 */
describe('formatKeyFaultAdvice', () => {
  const COMPOSE = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'compose.yml'),
    'utf8',
  )
  const APP_SERVICE = COMPOSE.slice(COMPOSE.indexOf('\n  app:'), COMPOSE.indexOf('\n  caddy:'))

  it('the app service block really is what was sliced out', () => {
    expect(APP_SERVICE).toContain('RZ_TEAM_GITHUB_APP_PRIVATE_KEY_FILE:')
    expect(APP_SERVICE).not.toContain('caddy')
  })

  it('carries the fault verbatim, and names the knob compose reads', () => {
    const fault = '<key file unreadable: /run/secrets/github-app-private-key.pem: EACCES>'
    const advice = formatKeyFaultAdvice(fault)
    expect(advice).toContain(fault)
    expect(advice).toContain(ENV_GITHUB_APP_PRIVATE_KEY_PATH)
    expect(APP_SERVICE).toContain(`\${${ENV_GITHUB_APP_PRIVATE_KEY_PATH}`)
  })

  it('does not offer the inline variable as a docker remedy, because compose does not forward it', () => {
    expect(APP_SERVICE).not.toMatch(/^\s+RZ_TEAM_GITHUB_APP_PRIVATE_KEY:/m)
    const advice = formatKeyFaultAdvice('<key file empty: /run/secrets/github-app-private-key.pem>')
    expect(advice).toContain('does NOT fall back')
  })

  it('every variable it names is one the operator can act on', () => {
    const advice = formatKeyFaultAdvice('<key file empty: /x>')
    const named = [...advice.matchAll(/RZ_TEAM_[A-Z_]+/g)].map((m) => m[0])
    expect(named).toContain(ENV_GITHUB_APP_PRIVATE_KEY_PATH)
    expect(named.indexOf(ENV_GITHUB_APP_PRIVATE_KEY_PATH)).toBe(0)
  })
})
