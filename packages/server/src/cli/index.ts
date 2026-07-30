import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AnyCollector, Exec } from '@observatory/core'
import { createEvent, createIdFactory } from '@observatory/core'
import type { FastifyInstance } from 'fastify'
import { defaultDataRoot, sessionDirFor, sessionFileName } from '../log/paths.js'
import { buildApp } from '../server/build-app.js'
import { loadCollectors } from '../server/collector-loader.js'
import { exec as realExec } from '../server/exec.js'
import { createPollLoop, type PollLoop } from '../server/poll-loop.js'
import { SessionRecorder } from '../server/recorder.js'
import { helpText, parseArgs } from './args.js'

export interface RunCliOptions {
  /** Injectable clock, so tests get deterministic session ids and ticks. */
  now?: () => number
  /** Overrides `~/.local/share/observatory` — tests point this at a temp dir. */
  dataRoot?: string
  /** Overrides the web dist dir this server would otherwise serve statically. */
  webDistDir?: string
  /** Overrides collector discovery — tests inject fakes instead of the real loader. */
  collectors?: readonly AnyCollector[]
  exec?: Exec
  intervalMs?: number
  log?: Pick<Console, 'log' | 'warn'>
}

export interface CliHandle {
  app: FastifyInstance
  recorder: SessionRecorder
  pollLoop: PollLoop
  /** The address the server ended up listening on, e.g. "http://127.0.0.1:4321". */
  url: string
  stop: () => Promise<void>
}

/**
 * Boots collectors + server for one repo and returns a handle to it. Pure
 * bootstrap: no signal handlers — that belongs to whichever entrypoint
 * actually owns the process (see `src/index.ts`), so this stays callable
 * from tests. The one exception is `--help`, which prints and exits 0
 * immediately, same as any CLI tool.
 */
export async function runCli(argv: readonly string[], options: RunCliOptions = {}): Promise<CliHandle> {
  const now = options.now ?? Date.now
  const log = options.log ?? console
  const args = parseArgs(argv)

  if (args.help) {
    log.log(helpText())
    process.exit(0)
  }

  const repoPath = path.resolve(args.path ?? process.cwd())
  const repoName = path.basename(repoPath)
  const sessionDir = sessionDirFor(repoPath, options.dataRoot ?? defaultDataRoot())
  const ts = now()
  const sessionId = String(ts)
  const filePath = path.join(sessionDir, sessionFileName(ts))

  const recorder = new SessionRecorder(sessionId, filePath)
  const nextId = createIdFactory('evt')

  await recorder.record(
    createEvent('session.started', { sessionId, repoPath, repoName }, { id: nextId(), ts: now() }),
  )

  const collectors = options.collectors ?? (await loadCollectors(log))
  const pollLoop = createPollLoop({
    repoPath,
    collectors,
    recorder,
    exec: options.exec ?? realExec,
    now,
    intervalMs: options.intervalMs ?? args.pollIntervalMs,
  })
  pollLoop.start()

  const webDistDir = options.webDistDir ?? defaultWebDistDir()
  const flatlineMs = args.flatlineMinutes * 60_000
  const app = buildApp({ repoPath, repoName, sessionDir, recorder, webDistDir, flatlineMs })

  const url = await app.listen({ port: args.port })
  log.log(`observatory running at ${url}`)

  const stop = async () => {
    pollLoop.stop()
    await app.close()
  }

  return { app, recorder, pollLoop, url, stop }
}

function defaultWebDistDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', '..', '..', 'web', 'dist')
}
