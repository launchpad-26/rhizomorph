import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AnyCollector, Exec } from '@observatory/core'
import { createEvent, createIdFactory } from '@observatory/core'
import type { FastifyInstance } from 'fastify'
import { createSessionlogCollector } from '../collectors/sessionlog/index.js'
import { defaultDataRoot, sessionDirFor, sessionFileName, snapshotDirFor } from '../log/paths.js'
import { findResumableSession, RESUME_WINDOW_MS } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { loadCollectors } from '../server/collector-loader.js'
import { exec as realExec } from '../server/exec.js'
import { createPollLoop, type PollLoop } from '../server/poll-loop.js'
import { SessionRecorder } from '../server/recorder.js'
import { createFileSnapshotStore } from '../server/snapshot-store.js'
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
import { fetchInstanceId, renderTelemetryEnv } from './telemetry-env.js'

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
 * Boots collectors + server for one repo and returns a handle to it. A boot
 * *resumes* the recent session by default (see `findResumableSession`;
 * `--fresh` opts out), so a restart continues one run rather than recording a
 * second copy of it. Pure bootstrap otherwise: no signal handlers — that belongs to whichever entrypoint
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

  // Resume the run (prd2's ruling): unless --fresh, continue the most recent
  // session for this repo when it is younger than RESUME_WINDOW_MS. Same session
  // id, same file, same collector snapshots — so a restart appends where the
  // last process stopped instead of minting a new session file holding another
  // copy of history.
  const resumed = args.fresh ? null : await findResumableSession(sessionDir, ts, RESUME_WINDOW_MS)
  const sessionId = resumed?.sessionId ?? String(ts)
  const filePath = resumed?.filePath ?? path.join(sessionDir, sessionFileName(ts))

  const recorder = new SessionRecorder(sessionId, filePath, resumed ? { resumeFrom: resumed.events } : {})
  const nextId = createIdFactory('evt')

  if (resumed) {
    // No second `session.started`: one session, one start, however many
    // processes served it.
    log.log(`resuming session ${sessionId} (${resumed.events.length} events recorded)`)
  } else {
    await recorder.record(
      createEvent('session.started', { sessionId, repoPath, repoName }, { id: nextId(), ts: now() }),
    )
  }

  const collectors =
    options.collectors ??
    [
      ...(await loadCollectors(log)),
      createSessionlogCollector({
        claudeProjectsRoot: options.claudeProjectsRoot,
        extraSessionDirs: args.extraSessionDirs,
        // `backfill` is #57's field on SessionlogCollectorConfig. Spread rather
        // than named so this plumbing compiles both before and after that lands
        // (TypeScript excess-property-checks object literals, not spreads) and
        // starts taking effect the moment the field exists.
        ...(args.backfill ? { backfill: true } : {}),
      }),
    ]
  const pollLoop = createPollLoop({
    repoPath,
    collectors,
    recorder,
    exec: options.exec ?? realExec,
    now,
    intervalMs: options.intervalMs ?? args.pollIntervalMs,
    // Keyed by session id, so a resumed session rehydrates its own offsets and a
    // fresh one starts with none (safe: sessionlog starts at EOF, #57). The
    // snapshots of a session nobody resumes are simply never read again.
    snapshotStore: createFileSnapshotStore(snapshotDirFor(sessionDir, sessionId)),
  })

  const webDistDir = options.webDistDir ?? defaultWebDistDir()
  const flatlineMs = args.flatlineMinutes * 60_000
  const app = buildApp({ repoPath, repoName, sessionDir, recorder, webDistDir, flatlineMs })

  let url: string
  try {
    url = await app.listen({ port: args.port, host: '127.0.0.1' })
  } catch (err) {
    // pollLoop was never started: a listen failure means no in-flight tick can
    // leak past this catch and race a caller's cleanup (e.g. a test's rm of
    // its temp dataRoot) with an unawaited snapshot write.
    await app.close().catch(() => {})
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined
    const message =
      code === 'EADDRINUSE'
        ? `port ${args.port} is already in use — pass a different one with --port <n>`
        : `failed to start server: ${err instanceof Error ? err.message : String(err)}`
    process.stderr.write(`${message}\n`)
    exit(1)
  }
  pollLoop.start()
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
 * `observatory env <lane>` — a standalone subcommand, no server boot of its
 * own, but it does read the instance id off the server on `--port` (#60: the
 * block must declare which run this telemetry belongs to, and only the running
 * Observatory knows). Same clean-usage-error contract as the main command: a
 * bad argv — or an unreachable server — prints to stderr and exits 1, `--help`
 * prints to stdout and exits 0, no stack trace either way (#30/#32
 * conventions). `exit` always terminates in real usage; the `Promise<never>`
 * return type is honest about that and lets this slot into `runCli`'s
 * `Promise<CliHandle>` return without a dummy value.
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

  let instance: string
  try {
    instance = await fetchInstanceId(envArgs.port)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }

  log.log(renderTelemetryEnv({ ...envArgs, instance }))
  exit(0)
}
