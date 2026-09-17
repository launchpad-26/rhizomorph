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
  DEFAULT_FOLD_TICK_MS,
  DEFAULT_JOURNAL_DIR,
  ENV_FOLD_TICK_MS,
  ENV_GITHUB_APP_PRIVATE_KEY_PATH,
  ENV_JOURNAL_DIR,
  formatBootReport,
  formatConfigReport,
  formatKeyFaultAdvice,
  resolveFoldTickMs,
  resolveJournalDir,
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
    // The title says EVERY variable it names, so assert the whole set rather than
    // one membership. Found by the second-eyes pass on f707c463 (mutation M-H):
    // appending a bogus RZ_TEAM_NONEXISTENT_KNOB left this test green, because only
    // presence and position were checked — the title overclaimed its own assertion,
    // which is the shape AGENTS.md ranks second-worst. These three are the knobs a
    // reader can actually act on: _PATH under compose, the other two outside docker.
    expect(new Set(named)).toEqual(
      new Set([ENV_GITHUB_APP_PRIVATE_KEY_PATH, ENV_GITHUB_APP_PRIVATE_KEY_FILE, ENV_GITHUB_APP_PRIVATE_KEY]),
    )
  })
})

/**
 * THE DEPLOYMENT'S OWN KNOBS — one resolution, two readers.
 *
 * `deploy/serve.ts` runs the fold at whatever this returns and `deploy/doctor.ts` PRINTS it as
 * the effective value. A second copy of the arithmetic in either file drifts silently, which is
 * why the resolution lives here; `deploy/doctor.test.ts` greps `serve.ts` to keep it that way.
 *
 * Neither variable is a `TeamConfig` value, so neither moves the `unsetCount` pinned above.
 */
describe('resolveFoldTickMs', () => {
  it('unset: the built-in default, armed', () => {
    expect(resolveFoldTickMs({})).toEqual({
      raw: undefined,
      effectiveMs: DEFAULT_FOLD_TICK_MS,
      armed: true,
      notANumber: false,
    })
  })

  it('a number: that number, armed', () => {
    expect(resolveFoldTickMs({ [ENV_FOLD_TICK_MS]: '250' })).toEqual({
      raw: '250',
      effectiveMs: 250,
      armed: true,
      notANumber: false,
    })
  })

  it('an explicit 0 disables the tick, and is not a typo', () => {
    const tick = resolveFoldTickMs({ [ENV_FOLD_TICK_MS]: '0' })
    expect(tick.effectiveMs).toBe(0)
    expect(tick.armed).toBe(false)
    expect(tick.notANumber).toBe(false)
  })

  it('"5s" is NaN — the runbook\'s documented typo — and reads as DISABLED, not as five seconds', () => {
    const tick = resolveFoldTickMs({ [ENV_FOLD_TICK_MS]: '5s' })
    expect(tick.effectiveMs).toBe(0)
    expect(tick.armed).toBe(false)
    expect(tick.notANumber).toBe(true)
    // The whole point: it is NOT 5000, and it is NOT 5.
    expect(tick.effectiveMs).not.toBe(DEFAULT_FOLD_TICK_MS)
    expect(tick.effectiveMs).not.toBe(5)
  })

  it('a negative value disables the tick but is not called a typo', () => {
    const tick = resolveFoldTickMs({ [ENV_FOLD_TICK_MS]: '-1' })
    expect(tick.effectiveMs).toBe(0)
    expect(tick.notANumber).toBe(false)
  })

  it('an empty string — what compose\'s `${VAR:-}` yields — disables rather than defaults', () => {
    const tick = resolveFoldTickMs({ [ENV_FOLD_TICK_MS]: '' })
    expect(tick.effectiveMs).toBe(0)
    expect(tick.notANumber).toBe(false)
  })

  it('repetition', () => {
    const env = { [ENV_FOLD_TICK_MS]: '750' }
    expect(resolveFoldTickMs(env)).toEqual(resolveFoldTickMs(env))
  })
})

describe('resolveJournalDir', () => {
  it('unset: the volume compose mounts', () => {
    expect(resolveJournalDir({})).toBe(DEFAULT_JOURNAL_DIR)
    expect(DEFAULT_JOURNAL_DIR).toBe('/data/journal')
  })

  it('set: exactly what was set, with no normalisation', () => {
    expect(resolveJournalDir({ [ENV_JOURNAL_DIR]: '/srv/journal/' })).toBe('/srv/journal/')
  })

  it('repetition', () => {
    expect(resolveJournalDir({})).toBe(resolveJournalDir({}))
  })
})
