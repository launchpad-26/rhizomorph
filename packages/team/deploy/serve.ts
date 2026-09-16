import { mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  bootstrapTeamStorage,
  createPostgresStorage,
  openSql,
  resolveTeamConfig,
  startTeamServer,
} from '../src/index.js'
import { keyFileFault } from '../src/config/config.js'
import { type FoldResult, startFoldWorker } from '../src/fold/worker.js'
import { ENV_INGEST_KEY_SHA256, ENV_PROJECT, seedProjectIngestKey } from '../src/keys/seed.js'
import {
  formatBootReport,
  formatConfigReport,
  formatKeyFaultAdvice,
  resolveFoldTickMs,
  resolveJournalDir,
} from './report.js'

const JOURNAL_DIR = resolveJournalDir(process.env)
/**
 * The fold's safety tick. Read off `process.env` beside the two values below rather than through
 * `resolveTeamConfig`, and that is deliberate: `deploy/report.test.ts` pins the config's
 * `unsetCount` at an exact number, so a new `TeamConfig` value would redden a file this lane does
 * not own. `0` disables the tick — wake and boot drain only.
 *
 * Resolved by `report.ts` rather than inline, so `deploy/doctor.ts` can print the value THIS
 * process actually runs at instead of keeping a second copy of the same arithmetic. Two copies
 * drift in silence: every test on both sides stays green while the doctor's "effective" stops
 * being effective. `deploy/doctor.test.ts` greps this file for that import.
 */
const FOLD_TICK_MS = resolveFoldTickMs(process.env).effectiveMs
const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '0.0.0.0'

async function main(): Promise<void> {
  const config = resolveTeamConfig(process.env)
  console.log(formatConfigReport(config))

  // LOUD, AND NOT A REFUSAL TO BOOT. An unconfigured app is a valid state
  // (#169) and so is a misconfigured one: sign-in answers 503 and says so,
  // while the ingest plane — which never touches GitHub (ADR-0050) — is
  // unaffected. What must not happen is the operator not being told.
  const keyFault = keyFileFault(config.githubAppPrivateKey)
  if (keyFault !== null) {
    console.error(formatKeyFaultAdvice(keyFault))
  }

  const sql = openSql(config.databaseUrl.value)
  const storage = createPostgresStorage(sql)

  // Run + report the migration step ourselves first, so a second boot's "nothing to
  // do" is visible in the log rather than silent. startTeamServer(...) below repeats
  // this same preflight+migrate call internally (it's the only entrypoint ruling 14
  // exposes) — a second, idempotent pass, not a second apply. See #433's plan for why
  // that duplication is accepted rather than reimplemented around it.
  const bootstrapped = await bootstrapTeamStorage(storage, config)
  if (!bootstrapped.ok) {
    console.error(bootstrapped.error)
    process.exit(1)
  }
  console.log(formatBootReport(bootstrapped))

  // THE DEPLOYMENT'S KEY (prd-51 ruling 8). `init.sh` printed the plaintext once
  // and wrote only its digest; this stores that digest and revokes every OTHER
  // key the project held, which is what turns the runbook's rotation procedure
  // into revocation rather than housekeeping.
  //
  // Read from `process.env` here rather than through `resolveTeamConfig`,
  // alongside the three variables this file already reads that way. A digest is
  // not a secret, but it is also not a value a boot report should print, so the
  // log line below names the project and the counts and never the digest.
  const seeded = await seedProjectIngestKey(storage, {
    projectId: process.env[ENV_PROJECT] ?? '',
    keyHash: process.env[ENV_INGEST_KEY_SHA256] ?? '',
    nowMs: Date.now(),
  })

  if (!seeded.ok) {
    // Loud, and NOT a refusal to boot. A server with no live key is a
    // fail-closed state rather than a lie about durability — every batch is
    // refused as an unknown key — and it is the same state a fully revoked
    // project is in, which must not prevent the server from running.
    console.error(
      `${seeded.error} Until then this server holds no live ingest key for any project and will refuse every batch.`,
    )
  } else {
    console.log(
      `ingest key: ${seeded.inserted ? 'seeded' : 'already held'} for project ${process.env[ENV_PROJECT]}` +
        `${seeded.revoked > 0 ? `, and ${seeded.revoked} older key(s) revoked` : ''}.`,
    )
  }

  mkdirSync(JOURNAL_DIR, { recursive: true })

  /**
   * THE FOLD (#564, ADR-0056). `runOnce` shipped in #373 and nothing called it, so every batch
   * this server accepted was journalled, acked and never folded — measured on the real host by
   * #514's drill, `events` empty with records on disk.
   *
   * The cursor sits in JOURNAL_DIR on purpose: `compose.yml` already mounts that as the named
   * volume `team_journal`, so a container restart resumes from the cursor rather than re-folding
   * the journal, and no new volume or variable is needed to get it.
   */
  const worker = startFoldWorker({
    journalPath: path.join(JOURNAL_DIR, 'ingest.log'),
    cursorPath: path.join(JOURNAL_DIR, 'ingest.cursor'),
    storage,
    tickMs: FOLD_TICK_MS,
    onResult: (fold: FoldResult) => {
      if (!fold.ok) {
        console.error(`fold failed: ${fold.error}`)
        return
      }
      // A pass that folded nothing and refused nothing says nothing: at one tick every few
      // seconds, logging the no-ops would be the whole log.
      if (fold.records > 0 || fold.refused.length > 0) {
        console.log(
          `fold: ${fold.records} record(s), ${fold.rows} row(s), ${fold.inserted} inserted, cursor ${fold.cursor}`,
        )
      }
      for (const refusal of fold.refused) {
        console.error(`fold refused ${refusal.actorInstance} at n=${refusal.n}: ${refusal.error}`)
      }
    },
  })

  const result = await startTeamServer({
    storage,
    config,
    journalPath: path.join(JOURNAL_DIR, 'ingest.log'),
    // The seam `api/main.ts` documents as "Wakes the fold worker". It fires once per accepted
    // batch on the ingest hot path, so it must never throw and never block — `wake()` is
    // fire-and-forget by construction.
    onBatch: () => worker.wake(),
    host: HOST,
    port: PORT,
    // A server-side failure the wire must not carry (the key check's storage
    // read throwing) lands here, beside the boot report, for the operator.
    onError: (message) => console.error(message),
  })

  if (!result.ok) {
    console.error(result.error)
    process.exit(1)
  }

  console.log(`listening on ${result.server.host}:${result.server.port}`)

  /**
   * THE BOOT DRAIN, AND IT RUNS HERE RATHER THAN EARLIER FOR A REASON.
   *
   * `startTeamServer` tops up the monthly partitions before it returns, and the fold NEVER
   * creates one (`fold/worker.ts`: `rz_ingest` holds no CREATE). A row whose `ts` falls outside
   * every existing partition fails its insert, the transaction rolls back and the cursor stays
   * put — so draining before the top-up would fail-closed on the first boot in a new month.
   *
   * Anything accepted between `listen` and this line is not lost: it wakes the worker, and the
   * wake coalesces into the drain that is already about to run.
   */
  await worker.drain()

  const shutdown = () => {
    void worker
      .stop()
      .then(() => result.server.close())
      .then(() => sql.end())
      .then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exit(1)
})
