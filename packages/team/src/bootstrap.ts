import type { TeamConfig } from './config/config.js'
import { runMigrations } from './migrations/runner.js'
import type { TeamStorage } from './storage/contract.js'

/**
 * THE PREFLIGHT, THEN THE MIGRATIONS (prd-51 ruling 4).
 *
 * Ruling 4's durability chain — the shipper's 202 means the batch is in a
 * durable journal, and the fold worker commits before it moves its cursor —
 * rests on the database actually flushing a commit before it reports one. With
 * `synchronous_commit = off` Postgres reports a commit up to `wal_writer_delay`
 * before the WAL reaches disk, so every acknowledgement the chain makes becomes
 * a claim about durability the installation cannot keep. The install refuses to
 * start rather than lie about it.
 *
 * **The refusal is a refusal, not a warning.** `bootstrap.test.ts` proves that
 * by counting calls: against `off`, the fake storage records **no**
 * `ensureMigrationsTable` and **no** `applyMigration` at all. A warn-and-continue
 * implementation still names the setting in its message and still passes a test
 * that only reads the message — so the message is not what is asserted.
 *
 * This module is a function, not an entrypoint: no listener, no `process.exit`,
 * no Fastify. Ruling 14 keeps the team server's HTTP surface in wave 3, and a
 * package with no entrypoint cannot grow one by accident.
 */

/**
 * Values of `synchronous_commit` this install accepts.
 *
 * The accepted set is exactly PostgreSQL's own enum for this setting minus
 * `off` — EXECUTED on 18.4, `SELECT enumvals FROM pg_settings WHERE name =
 * 'synchronous_commit'` returns `{local,remote_write,remote_apply,on,off}`. The
 * unrecognised-value refusal is what guards a future release adding a member.
 *
 * All three non-`on` members are accepted deliberately, and they are not
 * accepted for the same reason, which the earlier wording here blurred:
 *
 * - `local` waits for the local WAL flush and skips only the synchronous
 *   standby; `remote_apply` waits for strictly more than `on`. Both are
 *   equal-or-stronger than `on` for ruling 4's guarantee, and refusing them
 *   would refuse a *safer* install — the failure mode a fail-closed check most
 *   easily acquires.
 * - `remote_write` is the member that phrase does not fit. It is **equal** to
 *   `on` in the dimension ruling 4 depends on (the local WAL flush, which is
 *   what a process death loses a batch to) and **weaker** in the standby
 *   dimension, where it waits for the standby's OS rather than its disk. It is
 *   accepted because ruling 4 is a statement about durability against process
 *   death, not about standby topology — but it is accepted knowing the cost,
 *   not by being lumped in with the two above.
 */
export const ACCEPTED_SYNCHRONOUS_COMMIT: readonly string[] = ['on', 'local', 'remote_write', 'remote_apply']

export const SYNCHRONOUS_COMMIT = 'synchronous_commit'

export type PreflightResult = { ok: true } | { ok: false; error: string }

export type BootstrapResult =
  | { ok: true; applied: string[]; alreadyApplied: string[] }
  | { ok: false; error: string }

/**
 * Reads `synchronous_commit` and judges it. Anything unrecognised is a refusal:
 * a value this build has not been reasoned about is not evidence of durability,
 * and defaulting to allow would make every future Postgres release a silent
 * widening of what this check accepts.
 */
export async function assertDurableCommit(storage: TeamStorage): Promise<PreflightResult> {
  const observed = (await storage.readSetting(SYNCHRONOUS_COMMIT)).trim().toLowerCase()

  if (ACCEPTED_SYNCHRONOUS_COMMIT.includes(observed)) return { ok: true }

  if (observed === 'off') {
    return {
      ok: false,
      error: `${SYNCHRONOUS_COMMIT} is '${observed}', so this database reports commits it has not yet flushed and every durability acknowledgement above it would be a lie. Refusing to start. Remedy: ALTER SYSTEM SET ${SYNCHRONOUS_COMMIT} = 'on'; then reload the configuration (pg_reload_conf).`,
    }
  }

  return {
    ok: false,
    error: `${SYNCHRONOUS_COMMIT} is '${observed}', which this build does not recognise, so it cannot be judged durable. Refusing to start. Accepted values: ${ACCEPTED_SYNCHRONOUS_COMMIT.join(', ')}. Remedy: ALTER SYSTEM SET ${SYNCHRONOUS_COMMIT} = 'on'; then reload the configuration (pg_reload_conf).`,
  }
}

/**
 * Preflight, THEN migrations. Never the other way round, and never migrations
 * after a refusal.
 *
 * The refusal is **not configurable**, and that is prd-51 ruling 4 rather than
 * caution: *"Postgres runs `synchronous_commit=on`. Turning it off is the
 * mutated ordering arriving without the mutation, and the install refuses to
 * start against it."* The ruling states the refusal with no exception clause,
 * and `CONTRIBUTING.md` allows a law to be restated at equal or greater
 * strength, never weakened.
 *
 * An escape hatch was written here during the build and removed in review. The
 * argument for it — a throwaway database, a restore rehearsal — is a real
 * argument, and it is the kind that gets set once and never unset on a server
 * the whole team shares. If it is ever wanted it is a ruling with a reason and
 * an amendment to ruling 4, not a config field: the ordering this guards is the
 * one whose executed mutation loses exactly one batch per process death.
 */
export async function bootstrapTeamStorage(storage: TeamStorage, config: TeamConfig): Promise<BootstrapResult> {
  const preflight = await assertDurableCommit(storage)
  if (!preflight.ok) {
    return { ok: false, error: preflight.error }
  }

  const result = await runMigrations(storage, config.migrationsDir.value)
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, applied: result.applied, alreadyApplied: result.alreadyApplied }
}
