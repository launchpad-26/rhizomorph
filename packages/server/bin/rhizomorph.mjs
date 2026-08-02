#!/usr/bin/env node
// The published package ships only the built `dist/cli/index.js` bundle (no
// `src/`, no `tsx`) — see `build` in package.json. In this repo, before a
// build has run, fall back to executing the TS source directly via tsx's
// programmatic API so `.workmux.yaml` and friends keep working unbuilt.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const distEntry = path.resolve(here, '../dist/cli/index.js')

const { runCli } = existsSync(distEntry)
  ? await import(distEntry)
  : await (await import('tsx/esm/api')).tsImport('../src/cli/index.ts', import.meta.url)

const handle = await runCli(process.argv.slice(2))

const shutdown = () => {
  void handle.stop().then(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
