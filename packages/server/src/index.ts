import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCli } from './cli/index.js'

export { parseArgs } from './cli/args.js'
export { runCli, type CliHandle, type RunCliOptions } from './cli/index.js'
export type { ServerContext } from './server/context.js'
export { buildApp } from './server/build-app.js'
export { SessionRecorder } from './server/recorder.js'

function isDirectlyExecuted(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)
}

/** Lets `tsx watch src/index.ts` (the `dev` script) boot the CLI directly. */
if (isDirectlyExecuted()) {
  const handle = await runCli(process.argv.slice(2))

  const shutdown = () => {
    void handle.stop().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
