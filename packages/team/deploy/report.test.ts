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
import { formatBootReport, formatConfigReport } from './report.js'

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
