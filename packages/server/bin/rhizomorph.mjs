#!/usr/bin/env node
// Runs the TS CLI source directly via tsx's programmatic API — this repo has
// no build step, so the published bin has to execute TypeScript in place.
import { tsImport } from 'tsx/esm/api'

const { runCli } = await tsImport('../src/cli/index.ts', import.meta.url)

const handle = await runCli(process.argv.slice(2))

const shutdown = () => {
  void handle.stop().then(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
