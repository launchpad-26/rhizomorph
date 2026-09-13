import { mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  bootstrapTeamStorage,
  createPostgresStorage,
  openSql,
  resolveTeamConfig,
  startTeamServer,
} from '../src/index.js'
import { formatBootReport } from './report.js'

const JOURNAL_DIR = process.env.RZ_TEAM_JOURNAL_DIR ?? '/data/journal'
const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '0.0.0.0'

async function main(): Promise<void> {
  const config = resolveTeamConfig(process.env)
  console.log(
    `config: databaseUrl=${config.databaseUrl.display} (set by ${config.databaseUrl.setBy}, ${config.databaseUrl.source}); ` +
      `migrationsDir=${config.migrationsDir.value} (set by ${config.migrationsDir.setBy}, ${config.migrationsDir.source})`,
  )

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

  mkdirSync(JOURNAL_DIR, { recursive: true })

  const result = await startTeamServer({
    storage,
    config,
    journalPath: path.join(JOURNAL_DIR, 'ingest.log'),
    host: HOST,
    port: PORT,
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
