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
import { ENV_INGEST_KEY_SHA256, ENV_PROJECT, seedProjectIngestKey } from '../src/keys/seed.js'
import { formatBootReport, formatConfigReport, formatKeyFaultAdvice } from './report.js'

const JOURNAL_DIR = process.env.RZ_TEAM_JOURNAL_DIR ?? '/data/journal'
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

  const result = await startTeamServer({
    storage,
    config,
    journalPath: path.join(JOURNAL_DIR, 'ingest.log'),
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

  const shutdown = () => {
    void result.server
      .close()
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
