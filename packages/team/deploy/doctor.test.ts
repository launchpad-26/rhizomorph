import { chmodSync, mkdtempSync, readFileSync, rmSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ENV_DATABASE_URL,
  ENV_GITHUB_APP_ID,
  ENV_GITHUB_APP_PRIVATE_KEY_FILE,
  ENV_GITHUB_CLIENT_ID,
  ENV_GITHUB_CLIENT_SECRET,
  ENV_GITHUB_INSTALLATION_ID,
  ENV_GITHUB_ORG,
  resolveTeamConfig,
} from '../src/config/config.js'
import { writeCursor } from '../src/fold/cursor.js'
import { encodeFrame } from '../src/journal/format.js'
import { ENV_INGEST_KEY_SHA256, ENV_PROJECT } from '../src/keys/seed.js'
import type { AppliedMigration, IngestKeyRow } from '../src/storage/contract.js'
import { readMigrationDir } from '../src/migrations/runner.js'
import {
  type DoctorCheck,
  type DoctorReport,
  type DoctorStorage,
  FOLD_LAG_WARN_RECORDS,
  renderDoctorReport,
  runDoctor,
} from './doctor.js'
import { ENV_FOLD_TICK_MS, ENV_GITHUB_APP_PRIVATE_KEY_PATH, ENV_JOURNAL_DIR } from './report.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const COMPOSE = readFileSync(path.join(HERE, 'compose.yml'), 'utf8')
const APP_SERVICE = COMPOSE.slice(COMPOSE.indexOf('\n  app:'), COMPOSE.indexOf('\n  caddy:'))
const RUNBOOK = readFileSync(path.join(HERE, '..', '..', '..', 'docs', 'team-server-runbook.md'), 'utf8')
const SERVE_SRC = readFileSync(path.join(HERE, 'serve.ts'), 'utf8')

const KEY_HASH = 'a'.repeat(64)
const NOW = Date.UTC(2026, 8, 17, 9, 0, 0)
const PROJECT = 'rhizomorph'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'rz-doctor-'))
})

afterEach(() => {
  // The chmod cases leave the directory unwritable, which would defeat the rm.
  try {
    chmodSync(dir, 0o700)
  } catch {
    // Already writable, or already gone.
  }
  rmSync(dir, { recursive: true, force: true })
})

/** Every tracked migration, applied, as the happy path's `_migrations` contents. */
function appliedRows(): AppliedMigration[] {
  const discovered = readMigrationDir()
  if (!Array.isArray(discovered)) throw new Error(discovered.error)
  return discovered.map((f) => ({ id: f.id, checksum: f.checksum, appliedAt: '2026-09-01T00:00:00.000Z' }))
}

interface FakeOptions {
  readonly applied?: AppliedMigration[]
  readonly key?: IngestKeyRow | null
  readonly settingThrows?: boolean
  readonly listThrows?: boolean
  readonly partitionThrows?: boolean
  readonly findThrows?: boolean
}

function fakeStorage(options: FakeOptions = {}): DoctorStorage & { months: string[] } {
  const months: string[] = []
  return {
    months,
    async readSetting(): Promise<string> {
      if (options.settingThrows === true) throw new Error('connect ECONNREFUSED 10.0.0.1:5432')
      return '18.4'
    },
    async listAppliedMigrations(): Promise<AppliedMigration[]> {
      if (options.listThrows === true) throw new Error('relation "_migrations" does not exist')
      return options.applied ?? appliedRows()
    },
    async ensureMonthlyPartition(month: string): Promise<void> {
      if (options.partitionThrows === true) throw new Error('permission denied for schema public')
      months.push(month)
    },
    async findIngestKey(): Promise<IngestKeyRow | null> {
      if (options.findThrows === true) throw new Error('relation "ingest_keys" does not exist')
      if (options.key === undefined) {
        return { keyHash: KEY_HASH, projectId: PROJECT, createdAtMs: Date.UTC(2026, 8, 1), revokedAtMs: null }
      }
      return options.key
    },
  }
}

/** A configured-enough environment: the six GitHub values filled in, so `github-app` is `ok`. */
function fullEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    [ENV_DATABASE_URL]: 'postgres://rz:hunter2@postgres:5432/rhizomorph',
    [ENV_PROJECT]: PROJECT,
    [ENV_INGEST_KEY_SHA256]: KEY_HASH,
    [ENV_JOURNAL_DIR]: dir,
    [ENV_GITHUB_ORG]: 'rhizomorph-team',
    [ENV_GITHUB_APP_ID]: '123456',
    [ENV_GITHUB_INSTALLATION_ID]: '87654321',
    [ENV_GITHUB_CLIENT_ID]: 'Iv1.0000000000000000',
    [ENV_GITHUB_CLIENT_SECRET]: 'shhh',
    [ENV_GITHUB_APP_PRIVATE_KEY_FILE]: path.join(dir, 'key.pem'),
    ...overrides,
  }
}

async function doctor(
  env: Record<string, string | undefined>,
  storage: DoctorStorage | null = fakeStorage(),
  openError = 'connect ECONNREFUSED 10.0.0.1:5432',
): Promise<DoctorReport> {
  return runDoctor({
    env,
    config: resolveTeamConfig(env, () => '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----'),
    nowMs: NOW,
    openStorage: async () => (storage === null ? { ok: false, error: openError } : { ok: true, storage }),
  })
}

function byId(report: DoctorReport, id: string): DoctorCheck {
  const found = report.checks.find((c) => c.id === id)
  if (found === undefined) throw new Error(`no check with id ${id}; saw ${report.checks.map((c) => c.id).join(', ')}`)
  return found
}

/** A journal holding `count` records, so `readJournal` reports `lastSeq === count`. */
function writeJournal(count: number): void {
  const frames = Array.from({ length: count }, (_, i) =>
    encodeFrame({
      seq: i + 1,
      receivedAtMs: NOW,
      project: PROJECT,
      actorInstance: 'lane-doctor',
      batch: [{ n: i + 1, line: '{"id":"evt_1","ts":1,"source":"otel","type":"llm.cost","payload":{}}' }],
    }),
  )
  writeFileSync(path.join(dir, 'ingest.log'), Buffer.concat(frames))
}

describe('runDoctor — the happy path', () => {
  it('eight checks, no FAIL, exit 0', async () => {
    writeJournal(3)
    writeCursor(path.join(dir, 'ingest.cursor'), { seq: 3, actors: {} })
    const report = await doctor(fullEnv())

    expect(report.checks.map((c) => c.id)).toEqual([
      'database',
      'migrations',
      'partitions',
      'ingest-key',
      'github-app',
      'journal-dir',
      'fold-cursor',
      'fold-tick',
    ])
    expect(report.checks.filter((c) => c.status === 'fail')).toEqual([])
    expect(report.exitCode).toBe(0)
    expect(renderDoctorReport(report)).not.toContain('[FAIL]')
    expect(renderDoctorReport(report)).toContain('All checks passed.')
  })

  it('names what it measured rather than saying "ok"', async () => {
    writeJournal(3)
    writeCursor(path.join(dir, 'ingest.cursor'), { seq: 3, actors: {} })
    const report = await doctor(fullEnv())

    expect(byId(report, 'database').message).toContain('PostgreSQL 18.4')
    // Derived from the tracked directory, never a literal count: adding 0007 must not redden this.
    const tracked = readMigrationDir()
    if (!Array.isArray(tracked)) throw new Error(tracked.error)
    expect(byId(report, 'migrations').message).toContain(`${tracked.length} tracked, ${tracked.length} applied`)
    for (const file of tracked) expect(byId(report, 'migrations').message).toContain(file.id)
    expect(byId(report, 'partitions').message).toContain('2026-09 and 2026-10')
    expect(byId(report, 'ingest-key').message).toContain(`one live key for project ${PROJECT}`)
    // WHICH directory, not just "writable" — an operator running this in a container needs to
    // know the path that was tested, and `RZ_TEAM_JOURNAL_DIR` may or may not have reached it.
    expect(byId(report, 'journal-dir').message).toContain(dir)
    expect(byId(report, 'fold-cursor').message).toContain('at seq 3 of 3')
    expect(byId(report, 'fold-tick').message).toContain('effective 5000ms, armed')
  })

  /**
   * THE SECRET-LEAK LAW, ASSERTED AGAINST THE ACTUAL SECRET STRINGS — the shape
   * `report.test.ts` already holds one layer over. This doctor prints a database URL and a
   * key digest, and an operator pastes its output into a chat window.
   */
  it('never prints the database password, the client secret or the PEM', async () => {
    writeJournal(3)
    writeCursor(path.join(dir, 'ingest.cursor'), { seq: 3, actors: {} })
    const env = fullEnv({ [ENV_DATABASE_URL]: 'postgres://rz:hunter2@postgres:5432/rhizomorph' })
    const rendered = renderDoctorReport(await doctor(env))

    expect(rendered).not.toContain('hunter2')
    expect(rendered).not.toContain('shhh')
    expect(rendered).not.toContain('BEGIN RSA PRIVATE KEY')
    // Not vacuous — it really does print the rest of the URL.
    expect(rendered).toContain('postgres://***@postgres:5432/rhizomorph')
  })

  it('repetition: two runs against the same state render the identical text', async () => {
    writeJournal(2)
    writeCursor(path.join(dir, 'ingest.cursor'), { seq: 2, actors: {} })
    const env = fullEnv()
    const storage = fakeStorage()
    const first = renderDoctorReport(await runDoctorWith(env, storage))
    const second = renderDoctorReport(await runDoctorWith(env, storage))
    expect(second).toBe(first)
    // And the partition top-up really did run twice, with the same two months both times —
    // idempotent by the port's contract, which is what lets this check write at all.
    expect(storage.months).toEqual(['2026-09', '2026-10', '2026-09', '2026-10'])
  })

  async function runDoctorWith(
    env: Record<string, string | undefined>,
    storage: DoctorStorage,
  ): Promise<DoctorReport> {
    return doctor(env, storage)
  }
})

describe('the database check gates the three that need it', () => {
  it('an unopenable connection fails once and marks the other three NOT MEASURED', async () => {
    const report = await doctor(fullEnv(), null, 'getaddrinfo ENOTFOUND postgres')

    expect(byId(report, 'database').status).toBe('fail')
    expect(byId(report, 'database').message).toContain('getaddrinfo ENOTFOUND postgres')
    for (const id of ['migrations', 'partitions', 'ingest-key']) {
      expect(byId(report, id).status).toBe('warn')
      expect(byId(report, id).message).toContain('not measured')
    }
    expect(report.exitCode).toBe(1)
  })

  it('a LAZY driver — the connection opens and the first query refuses — does the same', async () => {
    // `openSql` builds a pool without connecting, so a refused database reaches the first
    // QUERY, not `openStorage`. Ungated, that printed four failing lines carrying the same
    // ECONNREFUSED under four different remedies, three of them wrong for the actual fault.
    const report = await doctor(fullEnv(), fakeStorage({ settingThrows: true }))

    expect(byId(report, 'database').status).toBe('fail')
    /**
     * EACH LABEL BOUND TO ITS OWN ID, not merely to the shared phrase.
     *
     * These asserted `toContain('not measured')` alone, so swapping the `migrations` and
     * `partition window` labels between their two call sites left all 51 cases green — #543's
     * sibling case exactly, in the one spot this file otherwise applies it carefully. Found in
     * review of #558.
     */
    expect(byId(report, 'migrations').message).toMatch(/^migrations: not measured/)
    expect(byId(report, 'partitions').message).toMatch(/^partition window: not measured/)
    expect(byId(report, 'ingest-key').message).toMatch(/^ingest key: not measured/)
    expect(report.checks.filter((c) => c.status === 'fail')).toHaveLength(1)
  })

  it('the local checks still run, so a database-down doctor is still four real lines', async () => {
    writeJournal(1)
    writeCursor(path.join(dir, 'ingest.cursor'), { seq: 1, actors: {} })
    const report = await doctor(fullEnv(), null)

    expect(byId(report, 'journal-dir').status).toBe('ok')
    expect(byId(report, 'fold-cursor').status).toBe('ok')
    expect(byId(report, 'fold-tick').status).toBe('ok')
    expect(byId(report, 'github-app').status).toBe('ok')
  })
})

describe('migrations', () => {
  it('names each unapplied migration individually, and counts against the tracked set', async () => {
    const all = appliedRows()
    const report = await doctor(fullEnv(), fakeStorage({ applied: all.slice(0, all.length - 2) }))
    const message = byId(report, 'migrations').message

    expect(byId(report, 'migrations').status).toBe('fail')
    expect(message).toContain(`2 of ${all.length} tracked migrations are NOT applied`)
    for (const row of all.slice(all.length - 2)) expect(message).toContain(row.id)
    expect(message).toContain('docker compose up -d app')
  })

  it('a checksum that has drifted is a DIFFERENT finding with a different remedy', async () => {
    const all = appliedRows()
    const drifted = all.map((row, i) => (i === 0 ? { ...row, checksum: '0'.repeat(64) } : row))
    const report = await doctor(fullEnv(), fakeStorage({ applied: drifted }))
    const message = byId(report, 'migrations').message

    expect(byId(report, 'migrations').status).toBe('fail')
    expect(message).toContain(`${all[0]?.id} has changed since being applied`)
    expect(message).toContain('append-only')
    // NOT the re-boot remedy: a boot cannot fix an edited migration, it refuses on it.
    expect(message).not.toContain('docker compose up -d app —')
  })

  it('an unreadable _migrations table says what creates it', async () => {
    const report = await doctor(fullEnv(), fakeStorage({ listThrows: true }))
    expect(byId(report, 'migrations').status).toBe('fail')
    expect(byId(report, 'migrations').message).toContain('relation "_migrations" does not exist')
    expect(byId(report, 'migrations').message).toContain('docker compose up -d app')
  })
})

describe('the journal directory', () => {
  it('a directory with no owner write bit FAILS, and the remedy is one typeable command', async () => {
    chmodSync(dir, 0o500)
    const report = await doctor(fullEnv())
    const message = byId(report, 'journal-dir').message

    expect(byId(report, 'journal-dir').status).toBe('fail')
    expect(message).toContain(dir)
    expect(message).toContain(`chown -R node:node ${dir} && chmod -R u+rwX ${dir}`)
    expect(report.exitCode).toBe(1)
  })

  it('an absent directory names the volume rather than the owner', async () => {
    const report = await doctor(fullEnv({ [ENV_JOURNAL_DIR]: path.join(dir, 'never-created') }))
    expect(byId(report, 'journal-dir').status).toBe('fail')
    expect(byId(report, 'journal-dir').message).toContain('team_journal volume is not mounted')
  })

  /**
   * #543 ONE VARIABLE OVER, AND THE REASON THIS TEST READS `compose.yml`.
   *
   * `RZ_TEAM_JOURNAL_DIR` is not in the `app` service's `environment:` block, so an operator
   * who sets it in `deploy/.env` changes nothing — the same shape that made two refusal
   * strings in #543 name a knob compose cannot read. The advice is therefore held to compose
   * rather than to memory: if compose ever starts forwarding it, this reddens and the advice
   * may be relaxed instead of quietly rotting.
   */
  it('does not offer RZ_TEAM_JOURNAL_DIR as a docker knob, because compose does not forward it', async () => {
    expect(APP_SERVICE).not.toMatch(/^\s+RZ_TEAM_JOURNAL_DIR:/m)
    chmodSync(dir, 0o500)
    const message = byId(await doctor(fullEnv()), 'journal-dir').message
    expect(message).toContain(`compose does not pass ${ENV_JOURNAL_DIR} to this container at all`)
    expect(message).not.toMatch(new RegExp(`set ${ENV_JOURNAL_DIR}`))
  })
})

describe('the partition window', () => {
  it('tops up both months and says so rather than claiming it only looked', async () => {
    const storage = fakeStorage()
    const report = await doctor(fullEnv(), storage)
    expect(storage.months).toEqual(['2026-09', '2026-10'])
    expect(byId(report, 'partitions').message).toContain('topped up by this run')
  })

  it('rolls into the next year at December', async () => {
    const storage = fakeStorage()
    await runDoctor({
      env: fullEnv(),
      config: resolveTeamConfig(fullEnv(), () => 'pem'),
      nowMs: Date.UTC(2026, 11, 20),
      openStorage: async () => ({ ok: true, storage }),
    })
    expect(storage.months).toEqual(['2026-12', '2027-01'])
  })

  it('a refused top-up names the migration that provides the parent table', async () => {
    const report = await doctor(fullEnv(), fakeStorage({ partitionThrows: true }))
    expect(byId(report, 'partitions').status).toBe('fail')
    expect(byId(report, 'partitions').message).toContain('permission denied for schema public')
    expect(byId(report, 'partitions').message).toContain('0001_events')
  })
})

/**
 * THE PER-CLAUSE BINDING (#543's sibling case).
 *
 * Each pairing is asserted as ONE regex binding a field name to ITS OWN environment variable.
 * Asserting the set of names — `expect(new Set(named)).toEqual(...)` — is what let #543's own
 * defect back in: two names swapped between clauses leaves the set identical and the advice
 * wrong. Both forms are here, and the pairing form is the one that catches the swap.
 */
describe('the GitHub App', () => {
  const PAIRS: readonly (readonly [string, string])[] = [
    ['githubOrgLogin', ENV_GITHUB_ORG],
    ['githubAppId', ENV_GITHUB_APP_ID],
    ['githubInstallationId', ENV_GITHUB_INSTALLATION_ID],
    ['githubClientId', ENV_GITHUB_CLIENT_ID],
    ['githubClientSecret', ENV_GITHUB_CLIENT_SECRET],
    ['githubAppPrivateKey', ENV_GITHUB_APP_PRIVATE_KEY_PATH],
  ]

  function unconfigured(): Record<string, string | undefined> {
    return {
      [ENV_DATABASE_URL]: 'postgres://rz:hunter2@postgres:5432/rhizomorph',
      [ENV_PROJECT]: PROJECT,
      [ENV_INGEST_KEY_SHA256]: KEY_HASH,
      [ENV_JOURNAL_DIR]: dir,
    }
  }

  for (const [field, env] of PAIRS) {
    it(`binds ${field} to ${env}, adjacent, so a swap cannot pass`, async () => {
      const message = byId(await doctor(unconfigured()), 'github-app').message
      expect(message).toMatch(new RegExp(`${field} \\(set ${env} in deploy/\\.env\\)`))
    })
  }

  it('all six unset is a WARN and is described as a valid deployment', async () => {
    const check = byId(await doctor(unconfigured()), 'github-app')
    expect(check.status).toBe('warn')
    expect(check.message).toContain('valid deployment, not a fault')
    expect(check.message).toContain('ingest is unaffected')
  })

  it('a partially configured App FAILS, because that is the broken middle', async () => {
    const env = unconfigured()
    env[ENV_GITHUB_ORG] = 'rhizomorph-team'
    env[ENV_GITHUB_APP_ID] = '123456'
    const check = byId(await doctor(env), 'github-app')

    expect(check.status).toBe('fail')
    expect(check.message).toContain('4 of 6 values are empty')
    expect(check.message).toContain('membership-unconfigured')
    // The two that ARE set must not be listed as things to fill in.
    expect(check.message).not.toContain(`githubOrgLogin (set ${ENV_GITHUB_ORG}`)
    expect(check.message).not.toContain(`githubAppId (set ${ENV_GITHUB_APP_ID}`)
  })

  it('a key file that cannot be read FAILS, carrying the fault verbatim', async () => {
    const env = fullEnv()
    const report = await runDoctor({
      env,
      config: resolveTeamConfig(env, () => {
        throw new Error('EACCES: permission denied')
      }),
      nowMs: NOW,
      openStorage: async () => ({ ok: true, storage: fakeStorage() }),
    })
    const check = byId(report, 'github-app')

    expect(check.status).toBe('fail')
    expect(check.message).toContain('<key file unreadable:')
    expect(check.message).toContain('EACCES: permission denied')
    expect(check.message).toContain(ENV_GITHUB_APP_PRIVATE_KEY_PATH)
  })

  /**
   * The whole-set form, kept BESIDE the pairings rather than instead of them. It is the
   * mutation `report.test.ts` records as M-H: appending a bogus RZ_TEAM_NONEXISTENT_KNOB
   * leaves every pairing above green, because each only checks its own pair.
   */
  it('names no variable an operator cannot act on', async () => {
    const message = byId(await doctor(unconfigured()), 'github-app').message
    const named = new Set([...message.matchAll(/RZ_TEAM_[A-Z0-9_]+/g)].map((m) => m[0]))
    expect(named).toEqual(new Set(PAIRS.map(([, env]) => env)))
  })
})

describe('the ingest key', () => {
  it('an empty project fails before it ever reads the table', async () => {
    const check = byId(await doctor(fullEnv({ [ENV_PROJECT]: '' })), 'ingest-key')
    expect(check.status).toBe('fail')
    expect(check.message).toContain(`${ENV_PROJECT} is empty`)
    expect(check.message).toContain('./init.sh')
  })

  it('a digest that is not 64 lowercase hex characters fails by name', async () => {
    const check = byId(await doctor(fullEnv({ [ENV_INGEST_KEY_SHA256]: 'not-a-digest' })), 'ingest-key')
    expect(check.status).toBe('fail')
    expect(check.message).toContain(`${ENV_INGEST_KEY_SHA256} is not a sha-256 digest`)
  })

  it('no row for this deployment\'s own digest fails, and the remedy is up -d, not restart', async () => {
    const check = byId(await doctor(fullEnv(), fakeStorage({ key: null })), 'ingest-key')
    expect(check.status).toBe('fail')
    expect(check.message).toContain('has no row in ingest_keys')
    expect(check.message).toContain('docker compose up -d app')
    expect(check.message).toContain('docker compose restart will not')
  })

  it('a REVOKED row fails — which "at least one row exists" would have called healthy', async () => {
    const revoked: IngestKeyRow = {
      keyHash: KEY_HASH,
      projectId: PROJECT,
      createdAtMs: Date.UTC(2026, 8, 1),
      revokedAtMs: Date.UTC(2026, 8, 10),
    }
    const check = byId(await doctor(fullEnv(), fakeStorage({ key: revoked })), 'ingest-key')
    expect(check.status).toBe('fail')
    expect(check.message).toContain('was revoked at 2026-09-10T00:00:00.000Z')
    expect(check.message).toContain('"revoked key"')
  })

  it('a row scoped to another project fails, naming both projects', async () => {
    const other: IngestKeyRow = {
      keyHash: KEY_HASH,
      projectId: 'some-other-project',
      createdAtMs: Date.UTC(2026, 8, 1),
      revokedAtMs: null,
    }
    const check = byId(await doctor(fullEnv(), fakeStorage({ key: other })), 'ingest-key')
    expect(check.status).toBe('fail')
    expect(check.message).toContain('is held for project some-other-project')
    expect(check.message).toContain(`not ${PROJECT}`)
  })

  it('an unreadable ingest_keys names the migration that provides it', async () => {
    const check = byId(await doctor(fullEnv(), fakeStorage({ findThrows: true })), 'ingest-key')
    expect(check.status).toBe('fail')
    expect(check.message).toContain('0005_ingest_keys')
  })
})

describe('the fold cursor', () => {
  it('an empty journal is not a fault', async () => {
    const check = byId(await doctor(fullEnv()), 'fold-cursor')
    expect(check.status).toBe('ok')
    expect(check.message).toContain('nothing has been ingested yet')
  })

  it("#514's state — records on disk and no cursor — FAILS rather than warns", async () => {
    writeJournal(4)
    const check = byId(await doctor(fullEnv()), 'fold-cursor')
    expect(check.status).toBe('fail')
    expect(check.message).toContain('holds nothing while the journal is at seq 4')
    expect(check.message).toContain('NOTHING has ever been folded')
    expect(check.message).toContain('docker compose up -d app')
  })

  it('a cursor at the tail is ok, and says how far behind it is', async () => {
    writeJournal(5)
    writeCursor(path.join(dir, 'ingest.cursor'), { seq: 5, actors: {} })
    const check = byId(await doctor(fullEnv()), 'fold-cursor')
    expect(check.status).toBe('ok')
    expect(check.message).toContain('at seq 5 of 5, 0 record(s) unfolded')
  })

  /**
   * THE THRESHOLD IS PINNED AS A LITERAL, AND THE BOUNDARY CASES ARE DERIVED FROM THE
   * CONSTANT. Both, because either alone is vacuous: the boundary tests below import
   * `FOLD_LAG_WARN_RECORDS`, so they move with it and stay green at ANY value — measured,
   * widening the threshold to 1000 left all 79 tests passing. A literal here is what makes
   * changing the decision a deliberate act rather than a silent one.
   */
  it('the backlog threshold is a decision, pinned so it cannot drift unnoticed', () => {
    expect(FOLD_LAG_WARN_RECORDS).toBe(100)
  })

  it('a concrete 150-record backlog warns, whatever the constant happens to say', async () => {
    writeJournal(150)
    writeCursor(path.join(dir, 'ingest.cursor'), { seq: 1, actors: {} })
    const check = byId(await doctor(fullEnv()), 'fold-cursor')
    expect(check.status).toBe('warn')
    expect(check.message).toContain('149 journal records unfolded')
  })

  it(`a lag of exactly ${FOLD_LAG_WARN_RECORDS} is still ok; one more warns`, async () => {
    writeJournal(FOLD_LAG_WARN_RECORDS + 1)
    writeCursor(path.join(dir, 'ingest.cursor'), { seq: 1, actors: {} })
    expect(byId(await doctor(fullEnv()), 'fold-cursor').status).toBe('ok')

    writeJournal(FOLD_LAG_WARN_RECORDS + 2)
    const warned = byId(await doctor(fullEnv()), 'fold-cursor')
    expect(warned.status).toBe('warn')
    expect(warned.message).toContain(`${FOLD_LAG_WARN_RECORDS + 1} journal records unfolded`)
    expect(warned.message).toContain('fold refused')
  })

  /**
   * THE JOURNAL WENT BACKWARDS UNDER A LIVE CURSOR (review of #585).
   *
   * The sibling of the `#514` case above: that one is a cursor that never moved, this one a
   * journal that shrank. All three spellings reported `ok` and exit 0 before the fix — the first
   * two as "nothing has been ingested yet", because `readJournal` maps `ENOENT` to an empty
   * buffer, and the third as a NEGATIVE unfolded count. The remedy is executed in the case below.
   */
  it.each([
    ['deleted', (): void => unlinkSync(path.join(dir, 'ingest.log'))],
    ['truncated to zero', (): void => truncateSync(path.join(dir, 'ingest.log'), 0)],
    ['rewound to 3 records', (): void => writeJournal(3)],
  ])('a journal %s under a cursor at 500 FAILS rather than reading as untouched', async (_label, shrink) => {
    writeJournal(500)
    writeCursor(path.join(dir, 'ingest.cursor'), { seq: 500, actors: {} })
    shrink()

    const report = await doctor(fullEnv())
    const check = byId(report, 'fold-cursor')
    expect(check.status).toBe('fail')
    expect(check.message).toContain('is at seq 500')
    expect(check.message).toContain('WEDGED')
    expect(report.exitCode).toBe(1)
    // The reassuring line the three states used to print must not be what an operator sees.
    expect(check.message).not.toContain('nothing has been ingested yet')
    // …and no line may report a negative backlog.
    expect(check.message).not.toMatch(/-\d+ record/)
  })

  /**
   * THE REMEDY IS TYPED BACK IN, which is the issue's own standard for a printed remedy: it
   * names removing the cursor, so removing the cursor must turn the check green.
   */
  it('the remedy it prints is the one that fixes it', async () => {
    writeJournal(500)
    writeCursor(path.join(dir, 'ingest.cursor'), { seq: 500, actors: {} })
    writeJournal(3)
    const wedged = byId(await doctor(fullEnv()), 'fold-cursor')
    expect(wedged.status).toBe('fail')
    expect(wedged.message).toContain('rm -f')

    // What the printed remedy says to do: remove the cursor, then let the boot drain re-fold.
    unlinkSync(path.join(dir, 'ingest.cursor'))
    const afterRemedy = byId(await doctor(fullEnv()), 'fold-cursor')
    expect(afterRemedy.status).toBe('fail')
    // A cold start against a journal holding records is #514's state, which is the HONEST
    // next finding rather than a green line: the boot drain is what clears it.
    expect(afterRemedy.message).toContain('NOTHING has ever been folded')
  })

  it('a corrupt journal FAILS and carries the reader\'s own byte offset', async () => {
    writeJournal(3)
    const bytes = readFileSync(path.join(dir, 'ingest.log'))
    // Flip a byte inside the FIRST record's payload, so bytes follow it and the reader must
    // call it corrupt rather than torn.
    const at = bytes.indexOf(0x0a) + 5
    bytes[at] = bytes[at] === 0x41 ? 0x42 : 0x41
    writeFileSync(path.join(dir, 'ingest.log'), bytes)

    const check = byId(await doctor(fullEnv()), 'fold-cursor')
    expect(check.status).toBe('fail')
    expect(check.message).toContain('byte offset')
    expect(check.message).toContain('not a delete')
  })
})

/**
 * THE EFFECTIVE TICK — and `compose.yml` is why the remedy does not say `.env`.
 *
 * `RZ_TEAM_FOLD_TICK_MS` is not in the `app` service's `environment:` block, so a `.env` line
 * is a knob connected to nothing. That fact is read out of `compose.yml` here rather than
 * asserted from memory.
 */
describe('the fold tick', () => {
  it('compose does not forward the variable, which is what the remedy is allowed to say', () => {
    expect(APP_SERVICE).toContain('RZ_TEAM_DATABASE_URL:')
    expect(APP_SERVICE).not.toMatch(/^\s+RZ_TEAM_FOLD_TICK_MS:/m)
  })

  it('unset: the built-in default, armed', async () => {
    const check = byId(await doctor(fullEnv()), 'fold-tick')
    expect(check.status).toBe('ok')
    expect(check.message).toContain('effective 5000ms, armed')
    expect(check.message).toContain('unset, so the built-in default applies')
  })

  it('a number: that number, armed', async () => {
    const check = byId(await doctor(fullEnv({ [ENV_FOLD_TICK_MS]: '250' })), 'fold-tick')
    expect(check.status).toBe('ok')
    expect(check.message).toContain('effective 250ms, armed')
  })

  it('"5s" is NaN, reads as 0 and DISABLES the tick — and says so', async () => {
    const check = byId(await doctor(fullEnv({ [ENV_FOLD_TICK_MS]: '5s' })), 'fold-tick')
    expect(check.status).toBe('warn')
    expect(check.message).toContain('"5s" is not a number')
    expect(check.message).toContain('effective tick is 0ms')
    expect(check.message).toContain('DISABLED')
    expect(check.message).toContain('packages/team/deploy/compose.yml')
    expect(check.message).toContain('Setting it in deploy/.env ALONE does nothing')
  })

  it('an explicit 0 is a supported setting, distinguished from the typo', async () => {
    const check = byId(await doctor(fullEnv({ [ENV_FOLD_TICK_MS]: '0' })), 'fold-tick')
    expect(check.status).toBe('warn')
    expect(check.message).toContain('supported setting, not a fault')
    expect(check.message).not.toContain('is not a number')
  })

  /**
   * The assertion that keeps "effective" honest. `serve.ts` and `doctor.ts` must resolve the
   * tick through ONE function: two copies of `Number(process.env.RZ_TEAM_FOLD_TICK_MS ?? 5000)`
   * drift in silence, with every test on both sides staying green while the doctor's printed
   * "effective" stops being the value the server runs at.
   */
  it('serve.ts resolves the tick and the journal directory through report.ts, not inline', () => {
    expect(SERVE_SRC).toContain('resolveFoldTickMs(process.env).effectiveMs')
    expect(SERVE_SRC).toContain('resolveJournalDir(process.env)')
    expect(SERVE_SRC).not.toMatch(/Number\(process\.env\.RZ_TEAM_FOLD_TICK_MS/)
    expect(SERVE_SRC).not.toMatch(/process\.env\.RZ_TEAM_JOURNAL_DIR \?\?/)
  })
})

describe('renderDoctorReport', () => {
  it('one line per check, in order, with a padded status label', async () => {
    writeJournal(1)
    writeCursor(path.join(dir, 'ingest.cursor'), { seq: 1, actors: {} })
    const report = await doctor(fullEnv())
    const lines = renderDoctorReport(report).split('\n')

    expect(lines).toHaveLength(report.checks.length + 2)
    expect(lines[lines.length - 2]).toBe('')
    for (const [i, check] of report.checks.entries()) {
      expect(lines[i]).toBe(`[${{ ok: 'ok  ', warn: 'warn', fail: 'FAIL' }[check.status]}] ${check.message}`)
    }
  })

  it('the summary counts the failures rather than saying "some"', async () => {
    chmodSync(dir, 0o500)
    const report = await doctor(fullEnv(), null)
    expect(renderDoctorReport(report)).toContain('2 checks failed')
    expect(report.exitCode).toBe(1)
  })

  it('a warn alone does not set the exit code', async () => {
    writeJournal(1)
    writeCursor(path.join(dir, 'ingest.cursor'), { seq: 1, actors: {} })
    const report = await doctor(fullEnv({ [ENV_FOLD_TICK_MS]: '5s' }))
    expect(byId(report, 'fold-tick').status).toBe('warn')
    expect(report.exitCode).toBe(0)
  })
})

/**
 * THE RUNBOOK CARRIES A RUN, NOT A PARAPHRASE — and this is what holds the two together.
 *
 * `docs/team-server-runbook.md` gained the invocation and the output of a real run, with the
 * host, the database URL and the journal path substituted for the values a compose deployment
 * has. A pasted block rots the moment a message is reworded, and nothing else in the tree
 * would notice: the sweep laws check that cited PATHS exist, not that quoted OUTPUT is still
 * what the code prints.
 */
describe('the runbook block is the output this code produces', () => {
  it('carries the exact invocation, which is the CMD interpreter and this file\'s sibling', () => {
    expect(RUNBOOK).toContain('docker compose exec app node_modules/.bin/tsx packages/team/deploy/doctor.ts')
    expect(readFileSync(path.join(HERE, '..', 'Dockerfile'), 'utf8')).toContain('node_modules/.bin/tsx')
  })

  /**
   * The block's LABELS, in order, against the labels a real run emits — not its statuses,
   * which depend on the deployment. Equality both ways, so this catches a check the block
   * has invented AND a check that shipped after the block was pasted. Weakening it to a
   * one-way `toContain` per line is what would let a ninth check land unmentioned.
   */
  it('lists exactly the checks the doctor emits, in the order it emits them', async () => {
    writeJournal(1)
    writeCursor(path.join(dir, 'ingest.cursor'), { seq: 1, actors: {} })
    const emitted = renderDoctorReport(await doctor(fullEnv()))

    const labelsOf = (text: string): string[] =>
      [...text.matchAll(/^\[(?:ok {2}|warn|FAIL)\] ([a-zA-Z ]+):/gm)].map((m) => m[1] as string)

    const fenced = RUNBOOK.slice(RUNBOOK.indexOf('[ok  ] database:'))
    const block = fenced.slice(0, fenced.indexOf('```'))

    expect(labelsOf(block)).toEqual(labelsOf(emitted))
    expect(labelsOf(block)).toHaveLength(8)
  })

  it('carries no real host, home path or captured machine name', () => {
    const block = RUNBOOK.slice(RUNBOOK.indexOf('[ok  ] database:'))
    const doctorBlock = block.slice(0, block.indexOf('```'))
    expect(doctorBlock).toContain('postgres://***@postgres:5432/rhizomorph')
    expect(doctorBlock).toContain('/data/journal')
    expect(doctorBlock).not.toContain('/Users/')
    expect(doctorBlock).not.toContain('/home/')
    expect(doctorBlock).not.toContain('127.0.0.1')
    expect(doctorBlock).not.toContain('Homebrew')
  })
  /**
   * THE REAL DRIVER FAILURE, which no fixture produced (review of #558).
   *
   * Every test here injected a plain `Error`. Node throws an `AggregateError` for a refused
   * connection when the host resolves to several addresses, and `DEFAULT_DATABASE_URL` is
   * `postgres://localhost:5432/rhizomorph` — which does on any machine with both loopbacks. Its
   * `.message` is empty, so the commonest failure this doctor exists to report printed a blank
   * reason behind its remedy.
   */
  it('an AggregateError from the driver still names why, on every attempt it made', async () => {
    const refused = new AggregateError(
      [new Error('connect ECONNREFUSED ::1:5432'), new Error('connect ECONNREFUSED 127.0.0.1:5432')],
      '',
    )
    expect(refused.message, 'the premise: an AggregateError carries no message of its own').toBe('')

    const storage = { ...fakeStorage(), async readSetting(): Promise<string> { throw refused } }
    const report = await doctor(fullEnv(), storage)
    const line = byId(report, 'database').message
    expect(line).toContain('ECONNREFUSED ::1:5432')
    expect(line).toContain('ECONNREFUSED 127.0.0.1:5432')
    // …and the reason is not empty between the address and the remedy.
    expect(line).not.toMatch(/—\s*\.\s*Remedy/)
  })

  it('an Error with no message names its constructor rather than printing nothing', async () => {
    const storage = { ...fakeStorage(), async readSetting(): Promise<string> { throw new RangeError('') } }
    const report = await doctor(fullEnv(), storage)
    expect(byId(report, 'database').message).toContain('RangeError')
  })

})
