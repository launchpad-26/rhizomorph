import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AnyCollector, Exec } from '@observatory/core'
import { createEvent, createIdFactory } from '@observatory/core'
import type { FastifyInstance } from 'fastify'
import { createSessionlogCollector } from '../collectors/sessionlog/index.js'
import { defaultDataRoot, sessionDirFor, sessionFileName } from '../log/paths.js'
import { buildApp } from '../server/build-app.js'
import { loadCollectors } from '../server/collector-loader.js'
import { exec as realExec } from '../server/exec.js'
import { createPollLoop, type PollLoop } from '../server/poll-loop.js'
import { SessionRecorder } from '../server/recorder.js'
import {
  doctorHelpText,
  envHelpText,
  helpText,
  parseArgs,
  parseDoctorArgs,
  parseEnvArgs,
  type CliArgs,
} from './args.js'
import { renderDoctorReport, runDoctor } from './doctor.js'
import { renderTelemetryEnv } from './telemetry-env.js'

export interface RunCliOptions {
  /** Injectable clock, so tests get deterministic session ids and ticks. */
  now?: () => number
  /** Overrides `~/.local/share/observatory` — tests point this at a temp dir. */
  dataRoot?: string
  /** Overrides the web dist dir this server would otherwise serve statically. */
  webDistDir?: string
  /** Overrides collector discovery — tests inject fakes instead of the real loader. */
  collectors?: readonly AnyCollector[]
  /** Overrides the sessionlog collector's Claude project-logs root; tests point this at a fixture dir instead of the real `~/.claude/projects`. */
  claudeProjectsRoot?: string
  exec?: Exec
  intervalMs?: number
  log?: Pick<Console, 'log' | 'warn'>
  /** Overrides `process.exit` — tests inject a stub that throws so a parse failure unwinds instead of killing the runner. */
  exit?: (code: number) => never
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
 * from tests. The exceptions are `--help`, which prints to stdout and exits
 * 0, and a bad argv (unknown flag or invalid value), which prints the
 * message plus usage to stderr and exits 1 — both same as any CLI tool, and
 * neither should surface as a thrown-Error stack trace.
 */
export async function runCli(argv: readonly string[], options: RunCliOptions = {}): Promise<CliHandle> {
  const now = options.now ?? Date.now
  const log = options.log ?? console
  const exit: (code: number) => never = options.exit ?? ((code) => process.exit(code))

  if (argv[0] === 'env') {
    return runEnvCommand(argv.slice(1), log, exit)
  }

  if (argv[0] === 'doctor') {
    return runDoctorCommand(argv.slice(1), log, exit, options)
  }

  let args: CliArgs
  try {
    args = parseArgs(argv)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${helpText()}`)
    exit(1)
  }

  if (args.help) {
    log.log(helpText())
    exit(0)
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

  const collectors =
    options.collectors ??
    [
      ...(await loadCollectors(log)),
      createSessionlogCollector({
        claudeProjectsRoot: options.claudeProjectsRoot,
        extraSessionDirs: args.extraSessionDirs,
      }),
    ]
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

  let url: string
  try {
    url = await app.listen({ port: args.port })
  } catch (err) {
    pollLoop.stop()
    await app.close().catch(() => {})
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined
    const message =
      code === 'EADDRINUSE'
        ? `port ${args.port} is already in use — pass a different one with --port <n>`
        : `failed to start server: ${err instanceof Error ? err.message : String(err)}`
    process.stderr.write(`${message}\n`)
    exit(1)
  }
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

/**
 * `observatory doctor [path]` — a standalone, read-only subcommand, no
 * server boot. Same clean-usage-error contract as the main command: a bad
 * argv prints to stderr and exits 1, `--help` prints to stdout and exits 0.
 * The report's own exit code (0 or 1) is what actually terminates the
 * process — it reflects whether the app can run, not an argv parse failure.
 */
async function runDoctorCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
  options: RunCliOptions,
): Promise<never> {
  let doctorArgs
  try {
    doctorArgs = parseDoctorArgs(rest)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${doctorHelpText()}`)
    exit(1)
  }

  if (doctorArgs.help) {
    log.log(doctorHelpText())
    exit(0)
  }

  const report = await runDoctor({
    path: doctorArgs.path,
    port: doctorArgs.port,
    exec: options.exec,
    webDistDir: options.webDistDir,
    claudeProjectsRoot: options.claudeProjectsRoot,
  })

  log.log(renderDoctorReport(report))
  exit(report.exitCode)
}

/**
 * `observatory env <lane>` — a standalone subcommand, no server boot. Same
 * clean-usage-error contract as the main command: a bad argv prints to
 * stderr and exits 1, `--help` prints to stdout and exits 0, no stack trace
 * either way (#30/#32 conventions). `exit` always terminates in real usage;
 * the `Promise<never>` return type is honest about that and lets this slot
 * into `runCli`'s `Promise<CliHandle>` return without a dummy value.
 */
async function runEnvCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
): Promise<never> {
  let envArgs
  try {
    envArgs = parseEnvArgs(rest)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${envHelpText()}`)
    exit(1)
  }

  if (envArgs.help) {
    log.log(envHelpText())
    exit(0)
  }

  log.log(renderTelemetryEnv(envArgs))
  exit(0)
}
