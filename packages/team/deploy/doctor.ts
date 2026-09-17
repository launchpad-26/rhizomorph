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
import type { RoleMembership, TeamStorage } from '../src/storage/contract.js'
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
 * The seven port methods this doctor is allowed to reach. A `Pick`, not
 * {@link TeamStorage}, so the surface it can touch is visible in one line and an
 * eighth call cannot be added without editing this type.
 */
export type DoctorStorage = Pick<
  TeamStorage,
  | 'readSetting'
  | 'listAppliedMigrations'
  | 'ensureMonthlyPartition'
  | 'findIngestKey'
  | 'listCatalogRoles'
  | 'listRlsTables'
  | 'readRoleMembership'
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
  // THE REMEDY IS IN-PLACE ROTATION, AND THE ONE IT REPLACES IS WHY (#591).
  //
  // This string used to open by deleting `.env` and re-running first boot. That
  // recreates the file: it mints a Postgres password the existing volume cannot
  // accept (the image applies POSTGRES_PASSWORD only at initdb) and writes the
  // six hand-entered RZ_TEAM_GITHUB_* values back empty, one of which GitHub
  // shows exactly once. Following it took the live deployment down on
  // 2026-09-17. A remedy is printed at the moment an operator is already in
  // trouble, which is the worst place to keep a destructive recipe.
  //
  // AND IT IS RUN FROM WHERE THE READER IS ALREADY STANDING — no `cd` (#623).
  //
  // This string used to open `cd packages/team/deploy && ./init.sh …`. Measured, that `cd` could
  // only ever fail. `compose.yml` exists at `packages/team/deploy/compose.yml` alone; Compose
  // searches the cwd and its ANCESTORS, never its descendants; and there is no `docker compose -f`
  // or COMPOSE_FILE anywhere in this repo. So `docker compose exec app … doctor.ts` — the
  // runbook's one invocation of this script — resolves from `packages/team/deploy` and nowhere
  // else, and from THERE `cd packages/team/deploy` exits 1 with "no such file or directory".
  // `&&` short-circuits, so the rotation would never have run.
  //
  // EXECUTED, Docker Compose v5.4.0: `docker compose config --services` prints "no configuration
  // file provided: not found" at the repo root, and `postgres app caddy` one directory in. The
  // operator who can READ this line is already standing where it has to be run.
  //
  // COUNT THE RENDERINGS, NOT THE LITERALS. The agreement law compares SIX remedies — three shared
  // states across two surfaces — but they come from FIVE literals, because this one serves two of
  // the doctor's arms. It is printed by a third, the revoked-key arm below, which the law does not
  // compare because the seed cannot reach that state. So the `cd` strip moved SEVEN renderings, not
  // six. Same literal and correct either way; worth knowing before editing this string, since the
  // arm the law does not watch changes with it.
  const reseed =
    'Remedy: ./init.sh --rotate-ingest-key (it mints a key and prints it once, ' +
    'rewriting only RZ_TEAM_INGEST_KEY_SHA256 — the Postgres password and the GitHub App values are untouched), ' +
    'then docker compose up -d — NOT docker compose restart, which does not re-read .env.'

  if (projectId === '') {
    // Not `reseed`: rotation reads the project OUT OF `.env` and refuses when it
    // names none, so pointing at it from here would be a remedy that cannot run.
    // A wrong pointer to a real command is worse than no pointer.
    //
    // THIS ARM WAS THE ONLY ONE ALREADY RIGHT ABOUT THE `cd`, AND #623 NEARLY "FIXED" IT.
    //
    // It is the one remedy in this file written by hand rather than by reusing `reseed`, and it
    // was alone among all six across this file and `seed.ts` in naming NO `cd`. #623's first pass
    // read that as the defect and added one, which would have turned the single runnable remedy
    // into an unrunnable one. The measurement is in `reseed`'s comment above; the other five moved
    // to match THIS one instead. `../src/keys/agreement-law.test.ts` is what compares them, and it
    // now also holds all six to naming no `cd` at all.
    return check(
      'ingest-key',
      'fail',
      `ingest key: ${ENV_PROJECT} is empty, so there is no project to scope a key to and every batch is refused. ` +
        `Remedy: set ${ENV_PROJECT} in packages/team/deploy/.env to this deployment's project id, then ` +
        './init.sh --rotate-ingest-key to mint a key scoped to it, then docker compose up -d — NOT docker compose ' +
        'restart, which does not re-read .env.',
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

/**
 * The tracked migrations, carrying their **text** as well as their identity.
 *
 * The text is what the three catalog checks derive their expectations from —
 * which `rz_` roles must exist, which role the owner must be a member of — so a
 * fourth role added by a later migration is covered without editing this file.
 * `checkMigrations` uses only `id` and `checksum` and is unchanged by it.
 */
type TrackedMigrations =
  | { ok: true; files: { id: string; checksum: string; sql: string }[] }
  | { ok: false; error: string }

function trackedMigrations(dir: string): TrackedMigrations {
  const discovered = readMigrationDirSafe(dir)
  if (!Array.isArray(discovered)) return { ok: false, error: discovered.error }
  return { ok: true, files: discovered.map((f) => ({ id: f.id, checksum: f.checksum, sql: f.sql })) }
}

/** `readMigrationDir` refuses with `{ error }` rather than throwing, but a bad path can still throw. */
function readMigrationDirSafe(dir: string): ReadMigrationDirResult {
  try {
    return readMigrationDir(dir)
  } catch (cause) {
    return { error: `migration directory could not be read: ${dir} (${errorText(cause)})` }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE LIVE CATALOG (#581) — three checks nothing else in this tree can make.
 *
 * `migrations/schema-law.test.ts` proves properties of the DDL this package
 * WILL RUN; it reads the tracked `.sql`. #514 measured a host where that was the
 * wrong question — correct files, diverged database:
 *
 *     rz_ roles present : (NONE)     policies on events : 0
 *     rls enabled/forced: true/true  migrations recorded: 5
 *
 * `_migrations` recorded `0003_roles_rls` as applied while every role and policy
 * it creates was absent, so the migration will never re-run to recreate them.
 * Every check an operator would think to run reports healthy, and nothing is
 * restricting anything. A restore is this deployment's own documented recovery
 * path, so it is not an exotic state.
 *
 * ## EXPECTATIONS ARE DERIVED FROM THE MIGRATIONS, NEVER LISTED HERE
 *
 * A fourth `rz_` role added by a later migration is covered without editing this
 * file — that is the issue's requirement and it is also what keeps the check
 * honest: a hand-written list drifts silently the first time the schema moves.
 * The cost is that a derivation which finds NOTHING would make its check pass on
 * any database at all, which is this repo's named worst test shape. So every
 * derivation below has an explicit empty arm that FAILS rather than passes.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `--` and block comments removed before any pattern is matched.
 *
 * Not optional: `0003_roles_rls.sql`'s header contains the literal words
 * *"CREATE ROLE has no IF NOT EXISTS before PG 16"*, and `0006`'s header quotes
 * `0003`'s own prose back at it. A derivation that read comments would be
 * deriving the schema from an argument about the schema.
 */
function strippedSql(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

/** One expectation the migrations state, and the file that states it. */
interface DerivedFact {
  readonly name: string
  readonly migrationId: string
}

function derive(files: readonly { id: string; sql: string }[], pattern: RegExp): DerivedFact[] {
  const found: DerivedFact[] = []
  const seen = new Set<string>()
  for (const file of files) {
    for (const match of strippedSql(file.sql).matchAll(pattern)) {
      const name = (match[1] as string).toLowerCase()
      if (seen.has(name)) continue
      seen.add(name)
      found.push({ name, migrationId: file.id })
    }
  }
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** `CREATE ROLE rz_<name>` — every role the migrations create, with the file that creates it. */
export function rolesCreatedByMigrations(files: readonly { id: string; sql: string }[]): DerivedFact[] {
  return derive(files, /CREATE\s+ROLE\s+(rz_[a-z0-9_]+)/gi)
}

/**
 * `GRANT rz_<name> TO CURRENT_USER` — the membership `0006` grants the owner.
 *
 * Derived rather than spelled `rz_viewer`, for the same reason the roles are:
 * the check then follows the schema instead of a literal that can drift. It is
 * also why this file never imports `ports/questions/sql.ts` for its
 * `VIEWER_ROLE` constant — a composition root is the only module that may reach
 * a port's SQL, and `deploy/` being outside that law's sweep is not a licence.
 */
export function ownerMembershipsGranted(files: readonly { id: string; sql: string }[]): DerivedFact[] {
  return derive(files, /GRANT\s+(rz_[a-z0-9_]+)\s+TO\s+CURRENT_USER/gi)
}

/**
 * The remedy every catalog failure ends with, and the one sentence an operator
 * most needs: **`docker compose up -d app` will not fix this.**
 *
 * `_migrations` records the file as applied, so the runner skips it forever. The
 * fix is to re-apply that one tracked file by hand, which is safe because each
 * of them is written to be: `0003` wraps every `CREATE ROLE` in a DO block that
 * swallows `duplicate_object` and precedes every `CREATE POLICY` with a
 * `DROP POLICY IF EXISTS`; `0006`'s `GRANT` is idempotent. Re-applying is a
 * no-op wherever the object survived.
 *
 * It pipes the tracked file rather than naming a statement to type. That keeps
 * the ledger row and its checksum true — the alternative advice, deleting the
 * `_migrations` row so boot re-runs it, edits the record of what happened — and
 * it keeps this module free of the SQL that has no business being here. The
 * variables are expanded INSIDE the postgres container, the same idiom
 * `deploy/compose.yml`'s own healthcheck uses, never on the operator's host.
 */
export function reapplyRemedy(config: TeamConfig, ids: readonly string[]): string {
  const unique = [...new Set(ids)].sort()
  /**
   * NO CALLER MAY REACH HERE WITH NOTHING, AND THIS IS THE BELT RATHER THAN THE BRACES.
   *
   * Every caller has its own empty arm that fails before reaching this function,
   * because an empty derivation is a finding in its own right and deserves its
   * own sentence. This exists because the cost of the gap was not a vague
   * message: `cat` with no file argument READS STDIN, so an operator pasting the
   * remedy got a pipeline that hangs. A remedy that hangs is worse than one that
   * is merely unhelpful, so the shape is made unreachable here too.
   */
  if (unique.length === 0) {
    return (
      'Remedy: this image could not name the migration that creates what is missing, which is a fault in the image ' +
      `rather than in your deployment — rebuild it from a checkout whose ${config.migrationsDir.value} is intact ` +
      '(docker compose build && docker compose up -d).'
    )
  }
  const files = unique.map((id) => `${config.migrationsDir.value}/${id}.sql`)
  return (
    `Remedy: ${unique.join(' and ')} ${unique.length === 1 ? 'is' : 'are'} recorded in _migrations as applied, so ` +
    'the runner will NOT re-run ' +
    `${unique.length === 1 ? 'it' : 'them'} and docker compose up -d app changes nothing here. Re-apply ` +
    `${unique.length === 1 ? 'that file' : 'those files'} by hand — every statement in ` +
    `${unique.length === 1 ? 'it' : 'them'} is guarded, so re-applying is a no-op wherever the object survived: ` +
    `docker compose exec -T app cat ${files.join(' ')} | docker compose exec -T postgres sh -c ` +
    '\'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"\' — then re-run this doctor.'
  )
}

/** The migration directory is broken, so every derived check has nothing to derive from. */
function noMigrations(id: string, label: string, config: TeamConfig, error: string): DoctorCheck {
  return check(
    id,
    'fail',
    `${label}: the tracked migrations could not be read, so there is nothing to check this database against — ` +
      `${error}. Remedy: this image's migration directory is ${config.migrationsDir.value}; rebuild the image from ` +
      'a checkout whose packages/team/src/migrations/ is intact (docker compose build && docker compose up -d).',
  )
}

/**
 * THE CATALOG IS UNREADABLE — which is NOT the same finding as "the thing is missing".
 *
 * The falsifier this check was required to answer. Measured on PostgreSQL 18.4:
 * `pg_roles`, `pg_policy`, `pg_class` and `pg_auth_members` all carry `=r/` in
 * their `relacl` — a SELECT grant to PUBLIC — and a plain non-superuser holding
 * nothing but CONNECT read all four. So an absent role comes back as a
 * successful query whose result does not name it. A deployment that has revoked
 * PUBLIC hits this arm instead: the statement THROWS
 * (`permission denied for view pg_roles`, EXECUTED), which is a different
 * observation and is reported as a different finding with a different remedy.
 */
function unreadableCatalog(id: string, label: string, what: string, why: string): DoctorCheck {
  return check(
    id,
    'fail',
    `${label}: ${what} is UNREADABLE by this connection — ${why}. That is NOT the same finding as a missing object ` +
      'and this doctor will not report it as one: on a stock PostgreSQL these catalogs carry a SELECT grant to ' +
      'PUBLIC, so an absent object comes back as a successful query that does not name it, while a revoked grant ' +
      'comes back as this error. Remedy: restore PUBLIC\'s read on pg_roles, pg_policy, pg_class and ' +
      'pg_auth_members as a superuser, or point RZ_TEAM_DATABASE_URL in deploy/.env at a role that still holds it ' +
      'and run docker compose up -d — NOT docker compose restart, which does not re-read .env. Until then nothing ' +
      'here is known, and nothing is guessed.',
  )
}

/**
 * `pg_roles`, read ONCE per run and handed to both checks that need it.
 *
 * Not a tidy-up. `checkViewerMembership` has to know whether the role EXISTS
 * before it may interpret a `false` membership, and reading the catalog twice
 * would let the two lines disagree about the same instant — the shape
 * `runDoctor`'s own database gate already exists to prevent one layer up.
 */
type CatalogRoles = { ok: true; roles: string[] } | { ok: false; error: string }

async function readCatalogRoles(storage: DoctorStorage): Promise<CatalogRoles> {
  try {
    return { ok: true, roles: await storage.listCatalogRoles() }
  } catch (cause) {
    return { ok: false, error: errorText(cause) }
  }
}

/**
 * EVERY `rz_` ROLE THE MIGRATIONS CREATE EXISTS IN `pg_roles`.
 *
 * This is #514's headline (`rz_ roles present : (NONE)`) and the check no static
 * law can make. Five verdicts, and the three that are not the obvious two are
 * the ones that stop it passing vacuously: an unreadable catalog, an EMPTY
 * catalog, and a derivation that found no roles at all.
 */
function checkCatalogRoles(config: TeamConfig, tracked: TrackedMigrations, catalog: CatalogRoles): DoctorCheck {
  if (!tracked.ok) return noMigrations('catalog-roles', 'role catalog', config, tracked.error)

  const expected = rolesCreatedByMigrations(tracked.files)
  if (expected.length === 0) {
    return check(
      'catalog-roles',
      'fail',
      'role catalog: no CREATE ROLE rz_* statement was found in the tracked migrations under ' +
        `${config.migrationsDir.value}, so this check has nothing to assert and would pass against any database at ` +
        'all. That is a fault in this image, not in your deployment. Remedy: the roles migration is ' +
        'packages/team/src/migrations/0003_roles_rls.sql; rebuild the image from an intact checkout ' +
        '(docker compose build && docker compose up -d).',
    )
  }

  if (!catalog.ok) return unreadableCatalog('catalog-roles', 'role catalog', 'pg_roles', catalog.error)
  const present = catalog.roles

  if (present.length === 0) {
    return check(
      'catalog-roles',
      'fail',
      'role catalog: pg_roles returned no rows at all. No live cluster is in that state — initdb creates sixteen ' +
        'predefined pg_* roles before anything else exists — so this reading cannot be trusted and NO conclusion ' +
        `about ${expected.map((r) => r.name).join(', ')} is drawn from it. Remedy: fix the database line above ` +
        'first, then read the roles by hand with docker compose exec -T postgres sh -c ' +
        '\'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \\du\' and re-run this doctor.',
    )
  }

  const have = new Set(present)
  const missing = expected.filter((role) => !have.has(role.name))
  if (missing.length > 0) {
    return check(
      'catalog-roles',
      'fail',
      `role catalog: ${missing.length} of ${expected.length} rz_ roles the migrations create ` +
        `${missing.length === 1 ? 'is' : 'are'} ABSENT from pg_roles (${missing.map((r) => r.name).join(', ')}) ` +
        `while ${[...new Set(missing.map((r) => r.migrationId))].sort().join(' and ')} ` +
        `${new Set(missing.map((r) => r.migrationId)).size === 1 ? 'is' : 'are'} recorded as applied. That is a ` +
        'dump restored without its globals, which is this deployment\'s own documented recovery path — and every ' +
        'other check an operator would run still reads healthy: row level security is enabled, the migration is ' +
        'recorded, boot reports nothing to do. Nothing is restricting anything. ' +
        `${reapplyRemedy(config, missing.map((r) => r.migrationId))}`,
    )
  }

  return check(
    'catalog-roles',
    'ok',
    `role catalog: all ${expected.length} rz_ roles the migrations create exist in pg_roles ` +
      `(${expected.map((r) => r.name).join(', ')}), out of ${present.length} roles in the cluster`,
  )
}

/**
 * EVERY TABLE THAT ENABLES ROW LEVEL SECURITY IS ACTUALLY PROTECTED BY IT — the
 * runtime twin of the law #565 shipped.
 *
 * **The obvious law is red on the healthy schema**, and that is the whole shape
 * of this check. Measured with every tracked migration applied: `ingest_keys`
 * and `retention_ceilings` enable RLS and carry ZERO policies, deliberately —
 * enabled-and-unFORCEd with no policy is a deny-all declaration for anyone who
 * is neither the owner nor BYPASSRLS. `schema-law.test.ts` found the same thing
 * statically and narrowed its law rather than exempt two tables by name, so this
 * carries the same two clauses:
 *
 * - **A — FORCED with no policy.** Nobody reads it, the owner included, and this
 *   server connects as the owner.
 * - **B — enabled, no policy, and SELECT-granted to a role that does not
 *   BYPASSRLS.** That grant reads nothing, forever.
 *
 * Neither subsumes the other, measured against the live catalog: dropping
 * `events`' policy trips both; a FORCEd table with no grants trips only A;
 * granting `rz_viewer` SELECT on `ingest_keys` trips only B.
 *
 * **The floor matters as much as the clauses.** Both are vacuously satisfied by
 * a database where RLS is enabled nowhere, which is one step past the state
 * #514 measured — so zero enabled tables is itself a failure. No count is ever
 * asserted: the claim is "at least one policy", never "exactly four".
 */
async function checkRlsPolicies(
  storage: DoctorStorage,
  config: TeamConfig,
  tracked: TrackedMigrations,
): Promise<DoctorCheck> {
  if (!tracked.ok) return noMigrations('rls-policies', 'row level security', config, tracked.error)

  /**
   * The migrations that CREATE A POLICY, not the ones that merely enable RLS —
   * and the distinction is not cosmetic.
   *
   * Caught by running this against the live #514 state: deriving from
   * `ENABLE ROW LEVEL SECURITY` named `0005_ingest_keys` and
   * `0007_retention_ceilings` beside `0003_roles_rls`, because those two enable
   * RLS on their own table and deliberately declare no policy. Re-applying them
   * is harmless and recreates nothing that was missing, so an operator following
   * that line would run two files for no reason and be left wondering which one
   * mattered. What went missing is the POLICIES, and one file creates them.
   */
  const policyMigrations = tracked.files
    .filter((f) => /CREATE\s+POLICY/i.test(strippedSql(f.sql)))
    .map((f) => f.id)

  /**
   * THE EMPTY ARM THIS DERIVATION WAS MISSING, and the one concrete harm it did.
   *
   * The two derivations above have had an explicit empty arm from the start and
   * this one did not, which made the module header's own claim — *"every
   * derivation below has an explicit empty arm that FAILS"* — false of exactly
   * one derivation. It was not only a documentation defect: with no tracked file
   * containing `CREATE POLICY`, {@link reapplyRemedy} was handed `[]` and emitted
   * an empty subject and a bare `cat` with NO FILE ARGUMENT — which reads stdin,
   * so an operator pasting the remedy gets a pipeline that HANGS rather than a
   * fix. Found in verification of this issue, EXECUTED.
   */
  if (policyMigrations.length === 0) {
    return check(
      'rls-policies',
      'fail',
      'row level security: no CREATE POLICY statement was found in the tracked migrations under ' +
        `${config.migrationsDir.value}, so this check has no policy to expect and could not name a file to re-apply ` +
        'if it found one missing. That is a fault in this image, not in your deployment. Remedy: the policies are ' +
        'defined in packages/team/src/migrations/0003_roles_rls.sql; rebuild the image from an intact checkout ' +
        '(docker compose build && docker compose up -d).',
    )
  }

  let tables
  try {
    tables = await storage.listRlsTables()
  } catch (cause) {
    return unreadableCatalog('rls-policies', 'row level security', 'pg_class/pg_policy', errorText(cause))
  }

  if (tables.length === 0) {
    /**
     * Nothing has RLS enabled, so what is gone is the ENABLE as well as the
     * policies — which is why this arm's remedy is the union and not
     * {@link policyMigrations} alone.
     */
    const rlsMigrations = tracked.files
      .filter((f) => /(?:ENABLE\s+ROW\s+LEVEL\s+SECURITY|CREATE\s+POLICY)/i.test(strippedSql(f.sql)))
      .map((f) => f.id)
    return check(
      'rls-policies',
      'fail',
      'row level security: NO table in this database has it enabled. The roles/RLS migration enables it on four and ' +
        'is recorded as applied, so either its effect is gone — a restore without globals drops the policies along ' +
        `with the roles — or this connection cannot see pg_class. ${reapplyRemedy(config, rlsMigrations)}`,
    )
  }

  /**
   * CLAUSE A — FORCED with no policy. CLAUSE B — no policy while a role that
   * does not BYPASSRLS holds SELECT. A table can be in both (dropping `events`'
   * policy puts it there — EXECUTED), so B lists only what A has not already
   * named and A carries the dead-grant note itself. Naming a table twice under
   * two remedies is the four-identical-lines failure #558 fixed one layer up.
   */
  const clauseA = tables.filter((t) => t.forced && t.policies === 0)
  const clauseB = tables.filter((t) => t.policies === 0 && t.readers.length > 0)
  const bOnly = clauseB.filter((t) => !clauseA.includes(t))
  const deadGrants = clauseA.filter((t) => t.readers.length > 0)

  if (clauseA.length > 0 || bOnly.length > 0) {
    /**
     * EACH ARM CARRIES ITS OWN REMEDY, BECAUSE ONE REMEDY IS FALSE OF THE OTHER ARM.
     *
     * This shipped as a single string for every arm, and verification measured
     * what that cost: `GRANT SELECT ON ingest_keys TO rz_viewer` printed
     * *"0003_roles_rls … re-apply that file by hand"*, and `0003_roles_rls.sql`
     * contains no REVOKE — so the operator runs a file that cannot undo a stray
     * grant and changes nothing. The same line also asserted *"this is #514's
     * state exactly"*, which a stray grant is not.
     *
     * That is the sibling-case shape twice over: the same defect this check's
     * own remedy derivation had one step earlier (`ENABLE` vs `CREATE POLICY`),
     * and the one #558 fixed one layer up (four identical ECONNREFUSED lines
     * under four remedies, three wrong for the fault). A remedy true of the arm
     * its author had in mind and false of a structurally identical sibling.
     */
    const findings: string[] = []

    if (clauseA.length > 0) {
      const one = clauseA.length === 1
      /**
       * A table is NAMED ONCE. When the dead-grant note covers exactly the same
       * tables it says "them" rather than listing them again — a second
       * occurrence of a table name in one line reads as a second finding.
       */
      const sameSet = deadGrants.length === clauseA.length
      findings.push(
        `${clauseA.length} table${one ? '' : 's'} ${one ? 'FORCEs' : 'FORCE'} row level security and ` +
          `${one ? 'carries' : 'carry'} NO policy in pg_policy, so nothing reads ${one ? 'it' : 'them'} at all — ` +
          `not even the owner this server connects as (${clauseA.map((t) => t.table).join(', ')})` +
          (deadGrants.length === 0
            ? ''
            : `, and the SELECT ${[...new Set(deadGrants.flatMap((t) => t.readers))].sort().join(', ')} ` +
              `${deadGrants.length === 1 ? 'holds' : 'hold'} on ` +
              `${sameSet ? (one ? 'it' : 'them') : deadGrants.map((t) => t.table).join(', ')} ` +
              'returns nothing, forever') +
          `. This is #514's state exactly: the tables still report RLS enabled, so \\d+ and the boot report both ` +
          `read healthy. ${reapplyRemedy(config, policyMigrations)}`,
      )
    }

    if (bOnly.length > 0) {
      const one = bOnly.length === 1
      const roles = [...new Set(bOnly.flatMap((t) => t.readers))].sort()
      /**
       * CLAUSE B ALONE IS NOT #514's STATE AND NO MIGRATION FIXES IT.
       *
       * A table with RLS enabled, unFORCEd, no policy, and a SELECT granted to a
       * role that does not bypass RLS. Nothing went missing here — something was
       * ADDED, by hand, that no tracked file grants. Re-applying a migration
       * cannot take a grant away: `0003_roles_rls.sql` carries GRANTs and no
       * REVOKE, so an operator following the clause-A remedy would run a file
       * that changes nothing and be left where they started.
       *
       * So this remedy names the two DECISIONS instead, and the exact shell to
       * make either in. It deliberately carries no SQL statement to paste: this
       * module holds none, and a statement printed for a human is still a
       * statement written here (ruling 5, and the reason this work is its own
       * lane rather than living in #558).
       */
      findings.push(
        `${bOnly.length} table${one ? '' : 's'} ${one ? 'has' : 'have'} it enabled with no policy while a role that ` +
          'does not bypass RLS holds SELECT, so that grant reads nothing, forever (' +
          `${bOnly.map((t) => `${t.table} SELECT-able by ${t.readers.join(', ')}`).join('; ')}). This is NOT ` +
          `#514's state and no migration fixes it: nothing under ${config.migrationsDir.value} grants that read, so ` +
          'there is no tracked file to re-apply and re-applying one would change nothing. Remedy: decide which was ' +
          `intended. If ${roles.join(' and ')} ${roles.length === 1 ? 'was' : 'were'} never meant to read ` +
          `${bOnly.map((t) => t.table).join(' and ')}, take that SELECT back where it was granted — open a prompt ` +
          'with docker compose exec -T postgres sh -c \'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"\'. If the read WAS ' +
          'intended, the grant is not the defect and the missing policy is: add one in a NEW ' +
          `${config.migrationsDir.value}/NNNN_slug.sql, because migrations are append-only and editing an applied ` +
          'file is what the migrations line above refuses.',
      )
    }

    return check('rls-policies', 'fail', `row level security: ${findings.join(' ')}`)
  }

  const protectedTables = tables.filter((t) => t.policies > 0)
  const denyAll = tables.filter((t) => t.policies === 0)
  const denyAllNote =
    denyAll.length === 0
      ? ''
      : `; ${denyAll.map((t) => t.table).join(' and ')} carry no policy, which is the deny-all their migrations ` +
        'declare rather than a gap — nothing outside the owner and a BYPASSRLS role may read them'
  return check(
    'rls-policies',
    'ok',
    `row level security: ${tables.length} tables enable it; ${protectedTables.length} carry a policy in pg_policy ` +
      `(${protectedTables.map((t) => t.table).join(', ')})${denyAllNote}`,
  )
}

/**
 * THE OWNER MAY BECOME THE VIEWER ROLE.
 *
 * `0006_viewer_role_membership.sql` is what makes the viewer's
 * `SET LOCAL ROLE rz_viewer` legal, and a restore drops memberships along with
 * the roles. Every signed-in read goes through that statement
 * (`ports/questions/sql.ts`), so this check is the difference between three view
 * routes that work and three that throw.
 *
 * **A superuser makes it a WARN, and that is measured rather than conceded.**
 * EXECUTED: revoking the membership from a superuser owner and then running
 * `SET LOCAL ROLE rz_viewer` still succeeded — a superuser may SET ROLE to
 * anything — while the same statement as a non-superuser non-member gave
 * `permission denied to set role "rz_viewer"`. `0006`'s own header names that as
 * the thing it exists to fix: the grant *"removes the app's accidental
 * dependence on BEING a superuser to reach `rz_viewer`"*. So on a superuser the
 * finding is latent, not live, and reporting it as broken would be posting a
 * line an operator can disprove in thirty seconds and then stop trusting.
 */
async function checkViewerMembership(
  storage: DoctorStorage,
  config: TeamConfig,
  tracked: TrackedMigrations,
  catalog: CatalogRoles,
): Promise<DoctorCheck> {
  if (!tracked.ok) return noMigrations('viewer-membership', 'viewer membership', config, tracked.error)

  const granted = ownerMembershipsGranted(tracked.files)
  if (granted.length === 0) {
    return check(
      'viewer-membership',
      'fail',
      'viewer membership: no GRANT rz_* TO CURRENT_USER was found in the tracked migrations under ' +
        `${config.migrationsDir.value}, so this check has nothing to assert and would pass against any database at ` +
        'all. That is a fault in this image, not in your deployment. Remedy: the membership migration is ' +
        'packages/team/src/migrations/0006_viewer_role_membership.sql; rebuild the image from an intact checkout ' +
        '(docker compose build && docker compose up -d).',
    )
  }

  /**
   * EVERY DERIVED MEMBERSHIP IS CHECKED, NOT THE FIRST ONE.
   *
   * This read `granted[0]` and stopped. `ownerMembershipsGranted` sorts by role
   * NAME, so a second migration granting `rz_auditor` would have pushed
   * `rz_viewer` out of the only slot that was ever examined — and the line would
   * have reported honestly on `rz_auditor` under the label "viewer membership"
   * while the viewer's own membership went unchecked. Found in verification, and
   * it was an asymmetry with `checkCatalogRoles` one screen up, which has always
   * checked every derived role. The two derivations are the same shape and are
   * now consumed the same way.
   */
  const results: { grant: DerivedFact; membership: RoleMembership }[] = []
  for (const grant of granted) {
    /**
     * THE ROLE IS GONE, WHICH IS A DIFFERENT AND HARDER FAILURE THAN A MISSING GRANT —
     * and it must be decided BEFORE the superuser arm below, not after.
     *
     * Found by running this against the real #514 state rather than by reading
     * it: with the `rz_` roles dropped, the membership arm reached the superuser
     * branch and reported *"reads still work TODAY"*. They do not. EXECUTED:
     * `SET LOCAL ROLE` on a role that does not exist raises
     * `role "…" does not exist` for a SUPERUSER too — being allowed to become
     * anybody is not being allowed to become nobody. A `warn` there is a false
     * reassurance on the exact state this whole issue exists to catch.
     *
     * Gated on a non-empty catalog read, because an empty one is a reading the
     * `role catalog` line above has already refused to draw conclusions from.
     */
    if (catalog.ok && catalog.roles.length > 0 && !catalog.roles.includes(grant.name)) {
      return check(
        'viewer-membership',
        'fail',
        `viewer membership: ${grant.name} does not exist in pg_roles at all, so SET LOCAL ROLE ${grant.name} raises ` +
          `role "${grant.name}" does not exist and every signed in read fails — all three view routes begin with ` +
          'that statement, and a superuser is no exception: it may become any role that EXISTS. Remedy: see the ' +
          'role catalog line above — the role has to exist before a membership of it can, and re-applying the ' +
          `roles migration is what creates it. ${grant.migrationId} then needs re-applying too.`,
      )
    }

    try {
      results.push({ grant, membership: await storage.readRoleMembership(grant.name) })
    } catch (cause) {
      return unreadableCatalog('viewer-membership', 'viewer membership', 'pg_auth_members', errorText(cause))
    }
  }

  const missing = results.filter((r) => !r.membership.isMember)
  const currentUser = results[0]?.membership.currentUser ?? ''
  const names = (rows: typeof results): string => rows.map((r) => r.grant.name).join(' and ')
  const held = (rows: typeof results): string =>
    rows.map((r) => `${r.grant.name} (granted by ${r.grant.migrationId})`).join(', ')

  if (missing.length === 0) {
    return check(
      'viewer-membership',
      'ok',
      `viewer membership: ${currentUser} is a member of ${held(results)}, so a read may SET LOCAL ROLE ` +
        `${names(results)} and the per project policies apply to it`,
    )
  }

  const remedy = reapplyRemedy(config, missing.map((r) => r.grant.migrationId))
  const one = missing.length === 1

  /**
   * A SUPERUSER MAY SET ROLE WITHOUT MEMBERSHIP, so the finding is latent rather
   * than live — measured, not conceded. EXECUTED: revoking the membership from a
   * superuser owner and then running `SET LOCAL ROLE rz_viewer` STILL SUCCEEDED,
   * while the same statement as a non-superuser non-member gave
   * `permission denied to set role "rz_viewer"`. `0006`'s own header names that
   * as the dependence it exists to remove. A `fail` here would be a line an
   * operator can disprove by using the product, and then stop trusting the rest.
   */
  if (results.every((r) => r.membership.isSuperuser)) {
    return check(
      'viewer-membership',
      'warn',
      `viewer membership: ${currentUser} is NOT a member of ${names(missing)}. Reads still work TODAY only because ` +
        'this connection is a superuser, which may SET ROLE to anything whatever its memberships — and that is ' +
        `exactly the accidental dependence ${[...new Set(missing.map((r) => r.grant.migrationId))].sort().join(' and ')} ` +
        'exists to remove. So this is latent rather than broken: the day this deployment narrows the app to a ' +
        `non-superuser role, every signed in read fails at once with permission denied to set role ` +
        `"${missing[0]?.grant.name}". ${remedy}`,
    )
  }

  return check(
    'viewer-membership',
    'fail',
    `viewer membership: ${currentUser} is NOT a member of ${names(missing)} and is not a superuser, so ` +
      `SET LOCAL ROLE ${names(missing)} raises permission denied to set role "${missing[0]?.grant.name}" and every ` +
      `signed in read fails — all three view routes begin with that statement. ${one ? '' : 'Every missing ' +
      'membership is named because each is a separate grant that has to be restored. '}${remedy}`,
  )
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
  /**
   * The gated checks, listed once. Every arm below either measures all of them
   * or says `not measured` for all of them — a list written out twice is how a
   * ninth check ends up measured on a healthy database and silently missing from
   * the report of a broken one, which is the report that matters.
   */
  const gated: readonly (readonly [string, string])[] = [
    ['migrations', 'migrations'],
    ['catalog-roles', 'role catalog'],
    ['rls-policies', 'row level security'],
    ['viewer-membership', 'viewer membership'],
    ['partitions', 'partition window'],
    ['ingest-key', 'ingest key'],
  ]
  const allUnmeasured = (): DoctorCheck[] => gated.map(([id, label]) => unmeasured(id, label))

  const database: DoctorCheck[] = []
  if (!opened.ok) {
    database.push(check('database', 'fail', unreachableMessage(deps.config, opened.error)), ...allUnmeasured())
  } else {
    const storage = opened.storage
    const reachable = await checkDatabase(storage, deps.config)
    database.push(reachable)
    if (reachable.status === 'fail') {
      database.push(...allUnmeasured())
    } else {
      const tracked = trackedMigrations(deps.config.migrationsDir.value)
      // One read of `pg_roles`, shared: the membership line has to know whether
      // the role EXISTS before it may interpret a `false` membership.
      const catalog = await readCatalogRoles(storage)
      database.push(
        await checkMigrations(storage, deps.config, tracked),
        checkCatalogRoles(deps.config, tracked, catalog),
        await checkRlsPolicies(storage, deps.config, tracked),
        await checkViewerMembership(storage, deps.config, tracked, catalog),
        await checkPartitions(storage, deps.nowMs),
        await checkIngestKey(storage, deps.env),
      )
    }
  }

  const checks: DoctorCheck[] = [...database, checkGithubApp(deps.config), ...local]
  return { checks, exitCode: checks.some((c) => c.status === 'fail') ? 1 : 0 }
}

const STATUS_LABEL: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' }

/**
 * THE LAST LINE SPEAKS FOR EVERY CHECK, SO IT COUNTS EVERY CHECK THAT WAS FLAGGED (#592).
 *
 * It used to count `fail` alone, which made `All checks passed.` the closing line of a
 * run that had just reported six missing GitHub App values and a sign-in plane
 * answering 503. EXECUTED on the team host, 2026-09-17, immediately after a rotation
 * wiped that configuration: seven `ok`, one `warn`, and a summary an operator would
 * quote into a handover as *healthy*. The eight lines scroll; this one gets carried.
 *
 * The complaint is not that the sentence was false — it is that it read IDENTICALLY
 * for a clean deployment and for that one. So the fix is the count rather than a
 * reword: a hedge (`nothing failed`) is true and still cannot tell the two apart.
 *
 * WHAT IS DELIBERATELY NOT CHANGED: the `warn` stays a `warn` and the exit code stays
 * 0. An unconfigured App is a valid deployment, not a fault (#169) — ingest is
 * unaffected and `/auth/github/start` answers 503 and says why. `exitCode` is
 * {@link runDoctor}'s, is `fail`-only, and this function has no part in it.
 */
export function renderDoctorReport(report: DoctorReport): string {
  const lines = report.checks.map((c) => `[${STATUS_LABEL[c.status]}] ${c.message}`)
  const failing = report.checks.filter((c) => c.status === 'fail').length
  const warning = report.checks.filter((c) => c.status === 'warn').length
  return [...lines, '', summarise(failing, warning)].join('\n')
}

/**
 * Three arms, and each is a report shape this tree actually produces.
 *
 * The `fail` arm keeps its wording to the letter and gains the warn clause, because
 * the commonest failing report — an unreachable database — is a `fail` beside SIX
 * `not measured` warns, and naming only the failure there is the same silence one
 * size smaller.
 */
function summarise(failing: number, warning: number): string {
  const checks = (n: number): string => `${n} check${n === 1 ? '' : 's'}`
  if (failing > 0) {
    const also = warning > 0 ? ` and ${checks(warning)} warned` : ''
    return `${checks(failing)} failed${also} — this deployment is not healthy. Each FAIL line above carries its remedy.`
  }
  if (warning > 0) {
    return (
      `No check failed, but ${checks(warning)} warned — that is not the same as all checks passing. ` +
      'Each [warn] line above says what was flagged and whether it needs action.'
    )
  }
  return 'All checks passed.'
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
