import { accessSync, constants } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPostgresStorage, openSql, resolveTeamConfig } from '../src/index.js'
import { monthsToTopUp } from '../src/api/main.js'
import { type TeamConfig, keyFileFault } from '../src/config/config.js'
import { readCursor } from '../src/fold/cursor.js'
import { readJournal } from '../src/journal/read.js'
import { type ReadMigrationDirResult, readMigrationDir } from '../src/migrations/runner.js'
import { ENV_INGEST_KEY_SHA256, ENV_PROJECT } from '../src/keys/seed.js'
import { isIngestKeyHash } from '../src/keys/hash.js'
import type { TeamStorage } from '../src/storage/contract.js'
import {
  ENV_FOLD_TICK_MS,
  ENV_GITHUB_APP_PRIVATE_KEY_PATH,
  resolveFoldTickMs,
  resolveJournalDir,
} from './report.js'

/**
 * THE TEAM SERVER'S DOCTOR (prd-51 ruling 13).
 *
 * Ruling 13 names it in these words: *"the server has a `doctor` in the local
 * one's discipline, one line per check with its exact remedy"*. This is that,
 * and the discipline is copied rather than reinvented —
 * `packages/server/src/cli/doctor.ts`'s {@link DoctorCheck} shape and its
 * `[ok  ] / [warn] / [FAIL]` renderer, one line per check.
 *
 * ## IT IS A SCRIPT, NOT A ROUTE
 *
 * ```
 * docker compose exec app node_modules/.bin/tsx packages/team/deploy/doctor.ts
 * ```
 *
 * The same `tsx` the `Dockerfile`'s `CMD` uses, in the container that already
 * holds the environment. A doctor reachable only through `/auth/github/start`
 * would be unreachable exactly when sign-in is the broken thing, which is one
 * of the states it exists to diagnose.
 *
 * `main()` runs under an `import.meta.url` guard so `doctor.test.ts` can import
 * this module without connecting to anything.
 *
 * ## NO SQL LIVES HERE, AND NOT BECAUSE A LAW FORCED IT
 *
 * `no-sql-outside-storage-law.test.ts` sweeps `src/` only — its `sources()`
 * reads `SRC_DIR` — so catalog SQL written in this file would pass every gate in
 * the tree. Writing it here because the sweep cannot reach here is gaming ruling
 * 5 rather than obeying it, so everything below goes through four port methods
 * and nothing else. That is also why the `pg_roles` / `pg_policy` / membership
 * checks are NOT here: they need SQL, SQL needs a port, and the port files are
 * another lane's in this wave. They are #581's.
 *
 * ## EVERY FAILING LINE NAMES A KNOB THE OPERATOR CAN ACTUALLY TURN (#543)
 *
 * #543's finding was that a remedy naming a variable `compose` cannot read sends
 * an operator to `<unset>` instead of to a fix. Three variables in this
 * deployment have that shape, and only one of them had been noticed:
 *
 * - `RZ_TEAM_GITHUB_APP_PRIVATE_KEY_FILE` is DERIVED under compose, so the knob
 *   is `RZ_TEAM_GITHUB_APP_PRIVATE_KEY_PATH` (`formatKeyFaultAdvice` in `report.ts`).
 * - `RZ_TEAM_FOLD_TICK_MS` **was not forwarded to the container at all**, so a
 *   `.env` line changed nothing. #584 forwards it, and `init.sh` now writes the
 *   line — so this remedy is an ordinary `deploy/.env` edit, and the thing it
 *   still has to say is `up -d` rather than `restart`.
 * - `RZ_TEAM_JOURNAL_DIR` is **not forwarded**, so under compose the
 *   journal is always `/data/journal` and a remedy that offered the variable
 *   would be advice that cannot be followed.
 *
 * `doctor.test.ts` reads all three facts out of `compose.yml` rather than from
 * memory, and binds each variable name to ITS OWN clause rather than asserting a
 * set — #543's sibling case, where reordering two names left the suite green
 * while re-introducing the exact defect. That is what made the first bullet
 * change here rather than rot: forwarding the variable reddened this file.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface DoctorCheck {
  readonly id: string
  readonly status: CheckStatus
  /** One line: the finding, and — for warn/fail — the exact remedy. */
  readonly message: string
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[]
  /** Non-zero iff some check is `fail`. A `warn` is a thing to know, not a thing to block on. */
  readonly exitCode: 0 | 1
}

/**
 * The four port methods this doctor is allowed to reach. A `Pick`, not
 * {@link TeamStorage}, so the surface it can touch is visible in one line and a
 * fifth call cannot be added without editing this type.
 */
export type DoctorStorage = Pick<
  TeamStorage,
  'readSetting' | 'listAppliedMigrations' | 'ensureMonthlyPartition' | 'findIngestKey'
>

export type OpenStorageResult = { ok: true; storage: DoctorStorage } | { ok: false; error: string }

export interface DoctorDeps {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly config: TeamConfig
  /** Opening the connection IS the `database` check. Refuses rather than throws. */
  readonly openStorage: () => Promise<OpenStorageResult>
  readonly nowMs: number
}

/**
 * How far behind the journal's tail the cursor may sit before it is worth saying.
 *
 * The fold is woken by every accepted batch and re-ticked every five seconds by
 * default, so a healthy cursor sits at the tail and a handful of records
 * mid-burst is ordinary. A hundred standing is not. The state #514's drill
 * measured on the real host — records on disk and `events` empty — is lag equal
 * to the whole journal, and it is caught one arm earlier than this: a journal
 * holding records with no cursor file at all is a `fail`, not a `warn`, because
 * it means nothing has EVER been folded.
 */
export const FOLD_LAG_WARN_RECORDS = 100

const NOT_MEASURED = 'not measured — the database is unreachable (see the database line above).'

function check(id: string, status: CheckStatus, message: string): DoctorCheck {
  return { id, status, message }
}

/** Every check that needs a connection, when there is not one. Honest rather than red. */
function unmeasured(id: string, label: string): DoctorCheck {
  return check(id, 'warn', `${label}: ${NOT_MEASURED} Remedy: fix that line first, then re-run this doctor.`)
}

/**
 * AN `AggregateError` HAS AN EMPTY `.message`, AND IT IS THE DEFAULT PATH HERE.
 *
 * Node throws one for a refused connection whenever the host resolves to several addresses — and
 * `config.ts`'s `DEFAULT_DATABASE_URL` is `postgres://localhost:5432/rhizomorph`, which does
 * exactly that on any machine with IPv4 and IPv6 loopback. So the commonest failure this doctor
 * exists to report printed:
 *
 *     [FAIL] database: unreachable at postgres://localhost:5432/rhizomorph — . Remedy: …
 *
 * A blank reason, which is precisely what ruling 13 and #543 exist to prevent. Found in review of
 * #558; every test fixture injected a plain `Error`, so none of the 20 mutations could see it.
 *
 * The individual attempts carry the real text (`ECONNREFUSED ::1:5432` and the IPv4 twin), so they
 * are joined rather than summarised — an operator wants to know it was refused on BOTH, since one
 * of the two succeeding is a different problem entirely.
 */
function errorText(cause: unknown): string {
  if (cause instanceof AggregateError) {
    const inner = cause.errors.map((e) => errorText(e)).filter((text) => text !== '')
    if (inner.length > 0) return inner.join('; ')
  }
  if (cause instanceof Error && cause.message !== '') return cause.message
  // An Error with no message is still an Error; naming its constructor beats printing nothing.
  if (cause instanceof Error) return cause.constructor.name
  return String(cause)
}

/**
 * THE DATABASE IS REACHABLE.
 *
 * `server_version` rather than a bare connect: a pool that hands back a
 * connection without a round trip would make "reachable" a claim about the
 * driver rather than about the database. `readSetting` is the settings port's
 * only method and it does a real `SELECT`.
 */
function unreachableMessage(config: TeamConfig, why: string): string {
  return (
    `database: unreachable at ${config.databaseUrl.display} — ${why}. Remedy: docker compose ps (postgres must read ` +
    'healthy) then docker compose logs postgres; if the host or credentials are wrong, fix RZ_TEAM_DATABASE_URL in ' +
    'deploy/.env and run docker compose up -d — NOT docker compose restart, which does not re-read .env.'
  )
}

async function checkDatabase(storage: DoctorStorage, config: TeamConfig): Promise<DoctorCheck> {
  try {
    const version = await storage.readSetting('server_version')
    return check(
      'database',
      'ok',
      `database: reachable at ${config.databaseUrl.display} (PostgreSQL ${version === '' ? '<version unavailable>' : version})`,
    )
  } catch (cause) {
    return check(
      'database',
      'fail',
      unreachableMessage(config, errorText(cause)),
    )
  }
}

/**
 * EVERY TRACKED MIGRATION IS APPLIED — and every applied one still matches its file.
 *
 * Two findings rather than one, because they are two fixes. A tracked file the
 * database has not seen is a deploy that did not boot with this image; a
 * checksum that has drifted is an edited migration, which is append-only and
 * cannot be fixed by re-running anything.
 */
async function checkMigrations(storage: DoctorStorage, config: TeamConfig, tracked: TrackedMigrations): Promise<DoctorCheck> {
  if (!tracked.ok) {
    return check(
      'migrations',
      'fail',
      `migrations: ${tracked.error}. Remedy: this image's migration directory is ${config.migrationsDir.value}; ` +
        'rebuild the image from a checkout whose packages/team/src/migrations/ is intact (docker compose build ' +
        '&& docker compose up -d).',
    )
  }

  let applied
  try {
    applied = await storage.listAppliedMigrations()
  } catch (cause) {
    return check(
      'migrations',
      'fail',
      `migrations: the _migrations table could not be read — ${errorText(cause)}. Remedy: docker compose up -d app, ` +
        'which creates it and applies every tracked migration at boot; then docker compose logs app | grep "migrations:".',
    )
  }

  const appliedById = new Map(applied.map((row) => [row.id, row.checksum]))
  const missing = tracked.files.filter((file) => !appliedById.has(file.id)).map((file) => file.id)
  const drifted = tracked.files
    .filter((file) => appliedById.has(file.id) && appliedById.get(file.id) !== file.checksum)
    .map((file) => file.id)

  if (drifted.length > 0) {
    return check(
      'migrations',
      'fail',
      `migrations: ${drifted.join(', ')} ${drifted.length === 1 ? 'has' : 'have'} changed since being applied, so ` +
        'this image and this database disagree about what already ran. Remedy: migrations are append-only — restore ' +
        `the tracked file(s) to what was applied and put the change in a new NNNN_slug.sql under ${config.migrationsDir.value}.`,
    )
  }

  if (missing.length > 0) {
    return check(
      'migrations',
      'fail',
      `migrations: ${missing.length} of ${tracked.files.length} tracked migrations are NOT applied (${missing.join(', ')}). ` +
        'Remedy: docker compose up -d app — migrations run at boot from the tracked SQL files; then ' +
        'docker compose logs app | grep "migrations:" to see what applied.',
    )
  }

  return check(
    'migrations',
    'ok',
    `migrations: ${tracked.files.length} tracked, ${tracked.files.length} applied (${tracked.files.map((f) => f.id).join(', ')})`,
  )
}

const ENV_JOURNAL_DIR_ADVICE =
  'Note that compose does not pass RZ_TEAM_JOURNAL_DIR to this container at all, so setting it in deploy/.env ' +
  'moves nothing: under compose the journal is always the team_journal volume mounted at /data/journal.'

/**
 * THE JOURNAL DIRECTORY IS WRITABLE.
 *
 * `W_OK` rather than a probe write: a probe leaves a file behind on the volume
 * every deployment shares, and the two observations that matter here — a
 * read-only mount (`EROFS`) and the wrong owner (`EACCES`) — both reach
 * `access(2)`.
 *
 * The remedy does NOT offer `RZ_TEAM_JOURNAL_DIR`. Compose does not forward it,
 * so setting it in `.env` moves nothing and the operator would be chasing a knob
 * that is not connected — #543's exact failure, one variable over.
 */
function checkJournalDir(journalDir: string): DoctorCheck {
  try {
    accessSync(journalDir, constants.W_OK)
    return check('journal-dir', 'ok', `journal directory: ${journalDir} is writable`)
  } catch (cause) {
    return check(
      'journal-dir',
      'fail',
      `journal directory: ${journalDir} is not writable — ${errorText(cause)}, so every batch will be refused rather ` +
        'than journalled. Remedy: docker compose exec -u root app sh -c ' +
        `'chown -R node:node ${journalDir} && chmod -R u+rwX ${journalDir}' — one command because the two causes look ` +
        'identical from here (the image runs as uid 1000, so a root-owned volume and a mode with no owner write bit ' +
        'both read as EACCES). If the path does not exist at all the team_journal volume is not mounted: check the ' +
        `app service's volumes: block in packages/team/deploy/compose.yml and run docker compose up -d. ${ENV_JOURNAL_DIR_ADVICE}`,
    )
  }
}

/**
 * THE PARTITION WINDOW COVERS THIS MONTH AND THE NEXT.
 *
 * **This is the one check that is not read-only, and the line says so.** There
 * is no port read for the catalog — the same wall that sent `pg_roles` and
 * `pg_policy` to #581 — so the only port-legal way to assert the window is
 * `ensureMonthlyPartition`, which is `CREATE TABLE IF NOT EXISTS` and is exactly
 * the call `startTeamServer` already makes at boot. On a healthy deployment it
 * changes nothing; on a broken one it fails with the reason, which is a real
 * finding: no `events` parent (migration `0001` never ran) or no CREATE
 * privilege for this role.
 *
 * Saying "topped up" rather than "covers" is the honest wording, and it is the
 * difference between a doctor and a doctor that lies about what it did.
 */
async function checkPartitions(storage: DoctorStorage, nowMs: number): Promise<DoctorCheck> {
  const months = monthsToTopUp(nowMs)
  try {
    for (const month of months) await storage.ensureMonthlyPartition(month)
    return check(
      'partitions',
      'ok',
      `partition window: events partitions for ${months.join(' and ')} are present (topped up by this run, ` +
        'the same idempotent call boot makes — this check is the one that writes)',
    )
  } catch (cause) {
    return check(
      'partitions',
      'fail',
      `partition window: the partitions for ${months.join(' and ')} could not be ensured — ${errorText(cause)}, so a ` +
        'row whose ts falls in an uncovered month will fail its insert and the fold cursor will not move. Remedy: ' +
        'check the migrations line above first (the events parent table is migration 0001_events), then ' +
        'docker compose up -d app, which tops the window up at boot.',
    )
  }
}

/**
 * THE GITHUB APP'S SIX VALUES.
 *
 * Three verdicts, because there are three states and only one of them is a
 * fault. **All six unset is a valid deployment** (#169): sign-in answers 503 and
 * ingest is untouched, so it warns and says so. **Some set and some not** is the
 * broken middle — `membership-unconfigured` at the callback — and fails. A
 * faulted key file fails too, carrying the fault verbatim.
 *
 * Each missing value is rendered beside ITS OWN environment variable, so the
 * test can bind the pairs one at a time. The key's pair names
 * {@link ENV_GITHUB_APP_PRIVATE_KEY_PATH}, never `_FILE`, for #543's reason.
 */
const GITHUB_APP_FIELDS: readonly { readonly field: keyof TeamConfig; readonly env: string }[] = [
  { field: 'githubOrgLogin', env: 'RZ_TEAM_GITHUB_ORG' },
  { field: 'githubAppId', env: 'RZ_TEAM_GITHUB_APP_ID' },
  { field: 'githubInstallationId', env: 'RZ_TEAM_GITHUB_INSTALLATION_ID' },
  { field: 'githubClientId', env: 'RZ_TEAM_GITHUB_CLIENT_ID' },
  { field: 'githubClientSecret', env: 'RZ_TEAM_GITHUB_CLIENT_SECRET' },
  { field: 'githubAppPrivateKey', env: ENV_GITHUB_APP_PRIVATE_KEY_PATH },
]

function checkGithubApp(config: TeamConfig): DoctorCheck {
  const unset = GITHUB_APP_FIELDS.filter(({ field }) => config[field].value === '')
  const pairs = unset.map(({ field, env }) => `${field} (set ${env} in deploy/.env)`).join(', ')
  const fault = keyFileFault(config.githubAppPrivateKey)

  if (fault !== null) {
    return check(
      'github-app',
      'fail',
      `GitHub App: the private key is configured and ${fault} — sign-in answers 503 until it reads. Remedy: set ` +
        `${ENV_GITHUB_APP_PRIVATE_KEY_PATH} in deploy/.env to the HOST path of a readable PEM owned by uid 1000, ` +
        'then docker compose up -d (compose mounts it read-only at /run/secrets/github-app-private-key.pem).',
    )
  }

  if (unset.length === GITHUB_APP_FIELDS.length) {
    return check(
      'github-app',
      'warn',
      'GitHub App: no sign-in configured — all six values are empty. This is a valid deployment, not a fault: ' +
        'ingest is unaffected and /auth/github/start answers 503. To enable sign-in, fill in ' +
        `${pairs}, then docker compose up -d — NOT docker compose restart, which does not re-read .env.`,
    )
  }

  if (unset.length > 0) {
    return check(
      'github-app',
      'fail',
      `GitHub App: ${unset.length} of ${GITHUB_APP_FIELDS.length} values are empty, so sign-in refuses every callback ` +
        `with "membership-unconfigured" rather than answering 503 up front. Remedy: fill in ${pairs}, then ` +
        'docker compose up -d — NOT docker compose restart, which does not re-read .env.',
    )
  }

  return check('github-app', 'ok', `GitHub App: all ${GITHUB_APP_FIELDS.length} values configured for org ${config.githubOrgLogin.display}`)
}

/**
 * THIS DEPLOYMENT'S OWN INGEST KEY HAS A LIVE ROW.
 *
 * Deliberately stronger than "at least one row exists in `ingest_keys`". A
 * server whose own digest was retired — a rotation followed by
 * `docker compose restart`, which the runbook already warns about — has rows and
 * refuses every batch, and "some row somewhere" reads green on exactly that.
 */
async function checkIngestKey(storage: DoctorStorage, env: DoctorDeps['env']): Promise<DoctorCheck> {
  const projectId = (env[ENV_PROJECT] ?? '').trim()
  const keyHash = (env[ENV_INGEST_KEY_SHA256] ?? '').trim().toLowerCase()
  const reseed =
    'Remedy: cd packages/team/deploy && rm .env && RZ_TEAM_PROJECT=<project-id> ./init.sh (it mints a key and ' +
    'prints it once), then docker compose up -d — NOT docker compose restart, which does not re-read .env.'

  if (projectId === '') {
    return check(
      'ingest-key',
      'fail',
      `ingest key: ${ENV_PROJECT} is empty, so there is no project to scope a key to and every batch is refused. ${reseed}`,
    )
  }
  if (!isIngestKeyHash(keyHash)) {
    return check(
      'ingest-key',
      'fail',
      `ingest key: ${ENV_INGEST_KEY_SHA256} is not a sha-256 digest (64 lowercase hex characters), so this server ` +
        `holds no key for project ${projectId} and refuses every batch. ${reseed}`,
    )
  }

  let row
  try {
    row = await storage.findIngestKey(keyHash)
  } catch (cause) {
    return check(
      'ingest-key',
      'fail',
      `ingest key: ingest_keys could not be read — ${errorText(cause)}. Remedy: check the migrations line above ` +
        '(the table is migration 0005_ingest_keys), then docker compose up -d app.',
    )
  }

  if (row === null) {
    return check(
      'ingest-key',
      'fail',
      `ingest key: the digest in ${ENV_INGEST_KEY_SHA256} has no row in ingest_keys, so this server holds no live key ` +
        'and refuses every batch as an unknown key. Remedy: docker compose up -d app — the boot seeds the digest from ' +
        'the environment; docker compose restart will not, because it does not re-read .env.',
    )
  }
  if (row.projectId !== projectId) {
    return check(
      'ingest-key',
      'fail',
      `ingest key: the digest in ${ENV_INGEST_KEY_SHA256} is held for project ${row.projectId}, not ${projectId} — a key ` +
        `is scoped to exactly one project, so every batch shipped to ${projectId} is refused with "wrong project". ${reseed}`,
    )
  }
  if (row.revokedAtMs !== null) {
    return check(
      'ingest-key',
      'fail',
      `ingest key: the digest in ${ENV_INGEST_KEY_SHA256} was revoked at ${new Date(row.revokedAtMs).toISOString()}, so ` +
        'every batch is refused with "revoked key". Usually a rotation followed by docker compose restart, which re-runs ' +
        `the container with the OLD environment. ${reseed}`,
    )
  }

  return check(
    'ingest-key',
    'ok',
    `ingest key: one live key for project ${projectId}, seeded ${new Date(row.createdAtMs).toISOString()}`,
  )
}

/**
 * THE FOLD CURSOR EXISTS AND IS NOT FAR BEHIND THE JOURNAL'S TAIL.
 *
 * Nothing outside the container can see this, and it is the layer above the
 * state #514's drill measured: records on disk, `events` empty, and every check
 * an operator would run reporting healthy. A journal holding records with NO
 * cursor file means nothing has ever been folded, which is that state exactly —
 * so it fails rather than warns.
 *
 * `readJournal` walks from byte 0 because `seq = previous + 1` is a property of
 * the chain; that is the reader's rule, not a choice made here, and it means
 * this check also surfaces a corrupt journal by byte offset.
 */
function checkFoldCursor(journalDir: string): DoctorCheck {
  const journalPath = path.join(journalDir, 'ingest.log')
  const cursorPath = path.join(journalDir, 'ingest.cursor')

  const journal = readJournal(journalPath)
  if (!journal.ok) {
    return check(
      'fold-cursor',
      'fail',
      `fold cursor: the journal cannot be read, so nothing can be folded — ${journal.error}. Remedy: docker compose logs ` +
        'app | grep "fold" for the failing position; the journal is append-only and the bytes before the corruption are ' +
        'intact, so recovery is a manual truncate at the named offset, not a delete.',
    )
  }

  const cursor = readCursor(cursorPath)
  const tail = journal.lastSeq
  const tornNote = journal.verdict === 'torn' ? ' (the tail record is torn, which reads as never-acked and is legal)' : ''

  /**
   * THE CURSOR IS AHEAD OF THE TAIL, WHICH MEANS THE JOURNAL SHRANK UNDER IT.
   *
   * This is the structural SIBLING of the `cursor.seq === 0` arm below — that one is a cursor
   * that never moved while the journal grew; this one is a journal that went backwards while the
   * cursor stayed. Found in review of #585, and it must be checked BEFORE the `tail === 0` arm,
   * because a deleted journal reads as `lastSeq === 0` (`readJournal` maps `ENOENT` to an empty
   * buffer) and would otherwise report the reassuring "nothing has been ingested yet".
   *
   * It is a `fail` rather than a `warn` because the fold is then WEDGED, silently and
   * indefinitely: `runOnce` reads `readJournal(journalPath, cursor.seq)`, which returns only
   * records with `seq > cursor.seq`, so a journal restarting at seq 1 under a cursor at 500 has
   * every new record filtered out. Batches are accepted, fsynced and acked 202 while `events`
   * never grows — #514's exact state, which is the state this check exists to catch.
   */
  if (cursor.seq > tail) {
    return check(
      'fold-cursor',
      'fail',
      `fold cursor: ${cursorPath} is at seq ${cursor.seq} but ${journalPath} only reaches ${tail}, so the journal has ` +
        'been truncated, deleted or replaced under a live cursor. The fold is WEDGED: it reads only records past the ' +
        'cursor, so every record this journal now holds — and every batch that arrives from here — is filtered out and ' +
        'events will never grow, however many 202s are returned. Remedy: docker compose exec app rm -f ' +
        `${cursorPath} && docker compose up -d app — a missing cursor is a cold start, so the boot drain re-folds the ` +
        'journal from byte 0 and the rows dedup (ON CONFLICT DO NOTHING), which makes a rewind cost time and not rows.',
    )
  }

  if (tail === 0) {
    return check('fold-cursor', 'ok', `fold cursor: nothing has been ingested yet — ${journalPath} holds no records${tornNote}`)
  }

  const lag = tail - cursor.seq
  if (cursor.seq === 0) {
    return check(
      'fold-cursor',
      'fail',
      `fold cursor: ${cursorPath} holds nothing while the journal is at seq ${tail}, so NOTHING has ever been folded and ` +
        'the events table is empty however many batches were accepted. Remedy: docker compose up -d app (the boot drain ' +
        'folds everything the journal holds), then docker compose logs app | grep "fold" — a "fold refused" line names ' +
        'the (actor, n) that stopped it.',
    )
  }
  if (lag > FOLD_LAG_WARN_RECORDS) {
    return check(
      'fold-cursor',
      'warn',
      `fold cursor: at seq ${cursor.seq} of ${tail} — ${lag} journal records unfolded, past the ${FOLD_LAG_WARN_RECORDS} ` +
        'this build calls a backlog. Remedy: docker compose logs app | grep "fold" — a "fold refused <actor> at n=<n>" ' +
        'line names the position holding it; the fold is per actor, so one stuck sender holds the low-water mark back ' +
        'while the others keep moving.',
    )
  }

  return check(
    'fold-cursor',
    'ok',
    `fold cursor: at seq ${cursor.seq} of ${tail}, ${lag} record(s) unfolded${tornNote}`,
  )
}

/**
 * THE EFFECTIVE TICK, PRINTED — because `5s` is `NaN` and silently disables it.
 *
 * `RZ_TEAM_FOLD_TICK_MS=5s` is `NaN`, which the worker treats as `0`, which
 * turns the tick off. The runbook documents that; nothing until now could tell
 * an operator it had happened to them, and a disabled tick is invisible while
 * batches keep arriving (each one wakes the fold anyway).
 *
 * The remedy names `deploy/.env` since #584, and that is a change of fact rather
 * than of wording: until then `compose.yml` did not forward the variable, so the
 * remedy had to send the operator into the compose file first. It forwards it
 * now and `init.sh` writes the line, so the edit is an ordinary `.env` one — and
 * the part that still has to be said is `up -d`, because `restart` does not
 * re-read `.env` and the operator would see their edit do nothing.
 */
function checkFoldTick(env: DoctorDeps['env']): DoctorCheck {
  const tick = resolveFoldTickMs(env)
  const wire =
    `Remedy: set ${ENV_FOLD_TICK_MS} to a whole number of MILLISECONDS in deploy/.env, then docker compose up -d — ` +
    'NOT docker compose restart, which does not re-read .env. The app service in packages/team/deploy/compose.yml ' +
    'forwards this variable to the container.'

  if (tick.notANumber) {
    return check(
      'fold-tick',
      'warn',
      `fold tick: ${ENV_FOLD_TICK_MS}=${JSON.stringify(tick.raw)} is not a number, so the effective tick is 0ms and the ` +
        `periodic fold is DISABLED — the fold still runs on each accepted batch and at boot, so this is quiet rather ` +
        `than visible. ${wire}`,
    )
  }
  if (!tick.armed) {
    return check(
      'fold-tick',
      'warn',
      `fold tick: effective 0ms — the periodic fold is DISABLED and the fold runs only on an accepted batch and at boot ` +
        `(${ENV_FOLD_TICK_MS} is ${tick.raw === undefined ? 'unset' : JSON.stringify(tick.raw)}). That is a supported ` +
        `setting, not a fault. ${wire}`,
    )
  }
  return check(
    'fold-tick',
    'ok',
    `fold tick: effective ${tick.effectiveMs}ms, armed (${ENV_FOLD_TICK_MS} is ${tick.raw === undefined ? 'unset, so the built-in default applies' : JSON.stringify(tick.raw)})`,
  )
}

type TrackedMigrations = { ok: true; files: { id: string; checksum: string }[] } | { ok: false; error: string }

function trackedMigrations(dir: string): TrackedMigrations {
  const discovered = readMigrationDirSafe(dir)
  if (!Array.isArray(discovered)) return { ok: false, error: discovered.error }
  return { ok: true, files: discovered.map((f) => ({ id: f.id, checksum: f.checksum })) }
}

/** `readMigrationDir` refuses with `{ error }` rather than throwing, but a bad path can still throw. */
function readMigrationDirSafe(dir: string): ReadMigrationDirResult {
  try {
    return readMigrationDir(dir)
  } catch (cause) {
    return { error: `migration directory could not be read: ${dir} (${errorText(cause)})` }
  }
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const journalDir = resolveJournalDir(deps.env)
  const opened = await deps.openStorage()

  const local: DoctorCheck[] = [checkJournalDir(journalDir), checkFoldCursor(journalDir), checkFoldTick(deps.env)]

  /**
   * THE DATABASE CHECK RUNS FIRST AND GATES THE OTHER THREE, AND THAT IS NOT TIDINESS.
   *
   * `openSql` is LAZY — `postgres()` builds a pool and connects on the first query — so a
   * refused connection reaches whichever check happens to query first, not `openStorage`.
   * Left ungated, an unreachable database printed FOUR failing lines carrying the same
   * `ECONNREFUSED` under four different remedies, three of which were wrong for the actual
   * fault. A check that was never measured says so instead.
   */
  const database: DoctorCheck[] = []
  if (!opened.ok) {
    database.push(
      check('database', 'fail', unreachableMessage(deps.config, opened.error)),
      unmeasured('migrations', 'migrations'),
      unmeasured('partitions', 'partition window'),
      unmeasured('ingest-key', 'ingest key'),
    )
  } else {
    const storage = opened.storage
    const reachable = await checkDatabase(storage, deps.config)
    database.push(reachable)
    if (reachable.status === 'fail') {
      database.push(
        unmeasured('migrations', 'migrations'),
        unmeasured('partitions', 'partition window'),
        unmeasured('ingest-key', 'ingest key'),
      )
    } else {
      database.push(
        await checkMigrations(storage, deps.config, trackedMigrations(deps.config.migrationsDir.value)),
        await checkPartitions(storage, deps.nowMs),
        await checkIngestKey(storage, deps.env),
      )
    }
  }

  const checks: DoctorCheck[] = [...database, checkGithubApp(deps.config), ...local]
  return { checks, exitCode: checks.some((c) => c.status === 'fail') ? 1 : 0 }
}

const STATUS_LABEL: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' }

/** Renders a {@link runDoctor} report as the lines the doctor prints. */
export function renderDoctorReport(report: DoctorReport): string {
  const lines = report.checks.map((c) => `[${STATUS_LABEL[c.status]}] ${c.message}`)
  const failing = report.checks.filter((c) => c.status === 'fail').length
  const summary =
    failing > 0
      ? `${failing} check${failing === 1 ? '' : 's'} failed — this deployment is not healthy. Each FAIL line above carries its remedy.`
      : 'All checks passed.'
  return [...lines, '', summary].join('\n')
}

/**
 * The real entrypoint. The connection is opened here and nowhere else, so
 * {@link runDoctor} stays a pure fold over its deps and the test needs no
 * database.
 */
export async function main(log: Pick<Console, 'log'> = console): Promise<0 | 1> {
  const config = resolveTeamConfig(process.env)
  const opened: { end: () => Promise<void> }[] = []

  const report = await runDoctor({
    env: process.env,
    config,
    nowMs: Date.now(),
    openStorage: async () => {
      try {
        const sql = openSql(config.databaseUrl.value)
        opened.push({ end: () => sql.end() })
        return { ok: true, storage: createPostgresStorage(sql) }
      } catch (cause) {
        return { ok: false, error: errorText(cause) }
      }
    },
  })

  log.log(renderDoctorReport(report))
  for (const handle of opened) await handle.end()
  return report.exitCode
}

// Imported by its test, executed by an operator. `pathToFileURL`, not a string
// compare: `packages/server/bin/rhizomorph.mjs` already carries that fix, and a
// bare `process.argv[1]` comparison is the form that breaks on native Windows.
const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main()
    .then((code) => process.exit(code))
    .catch((cause: unknown) => {
      console.error(cause instanceof Error ? cause.stack : String(cause))
      process.exit(1)
    })
}
