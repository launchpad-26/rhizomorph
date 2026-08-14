#!/usr/bin/env node
// The published package ships only the built `dist/cli/index.js` bundle (no
// `src/`, no `tsx`) — see `build` in package.json. In this repo, before a
// build has run, fall back to executing the TS source directly via tsx's
// programmatic API so `.workmux.yaml` and friends keep working unbuilt.
//
// #453: a dev tree can have a `dist/` that is older than the `src/` someone
// is actively editing — this bin used to prefer dist unconditionally, so a
// stale build ran silently with no tell. Two fixes, both cheap: (1) a
// stderr-only one-line note on every boot naming which entry point ran and
// why, so a stale run is never silent again; (2) when both `dist/` and
// `src/` exist in the same tree (never true for the published package,
// which ships no `src/`), compare mtimes and prefer source if it is newer
// than the dist it would otherwise run.
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const distEntry = path.resolve(here, '../dist/cli/index.js')
const srcRoot = path.resolve(here, '../src')
const srcEntryRelative = '../src/cli/index.ts'

function newestMtimeMs(dir) {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const mtime = statSync(path.join(entry.parentPath, entry.name)).mtimeMs
    if (mtime > newest) newest = mtime
  }
  return newest
}

const distExists = existsSync(distEntry)
let useDist = distExists
let reason = distExists ? 'dist is built' : 'dist/cli/index.js not built'

if (distExists && existsSync(srcRoot)) {
  const srcMtime = newestMtimeMs(srcRoot)
  const distMtime = statSync(distEntry).mtimeMs
  if (srcMtime > distMtime) {
    useDist = false
    reason = 'src is newer than dist — dist is stale'
  }
}

process.stderr.write(
  `rhizomorph: running ${useDist ? distEntry : path.resolve(here, srcEntryRelative)} (${reason})\n`
)

const { runCli } = useDist
  ? await import(pathToFileURL(distEntry).href)
  : await (await import('tsx/esm/api')).tsImport(srcEntryRelative, import.meta.url)

const handle = await runCli(process.argv.slice(2))

const shutdown = () => {
  void handle.stop().then(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
