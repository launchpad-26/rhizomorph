import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AnyCollector, Exec, RhizomorphEvent } from '@rhizomorph/core'
import { createEvent, createIdFactory, eventsToJsonl, lineToEvent, reduceAll, selectBranches, selectWorktreeViews } from '@rhizomorph/core'
import { parseRecord, verifyRecord } from '@rhizomorph/core/src/record/index.js'
import type { FastifyInstance } from 'fastify'
import { createSessionlogCollector } from '../collectors/sessionlog/index.js'
// The one importer the lab namespace law (prd12 ruling 1) allows: this is
// the explicit CLI wiring point, never a collector or background loop.
import { captureCheckpoint } from '../lab/checkpoint.js'
import { compareFork, renderComparison } from '../lab/compare.js'
import { dispatchFork } from '../lab/fork.js'
import { recordSessionBootMeta } from '../api/meta.js'
import { defaultDataRoot, sessionDirFor, sessionFileName, snapshotDirFor } from '../log/paths.js'
import {
  decideSessionBoot,
  formatBootDuration,
  recordResume,
  type SessionBootDecision,
} from '../log/session-log.js'
import { LOCK_HEARTBEAT_INTERVAL_MS, removeSessionLock, writeSessionLock } from '../log/session-lock.js'
import { buildApp } from '../server/build-app.js'
import { loadCollectors } from '../server/collector-loader.js'
import { exec as realExec } from '../server/exec.js'
import { createPollLoop, type PollLoop } from '../server/poll-loop.js'
import { SessionRecorder } from '../server/recorder.js'
import { createFileSnapshotStore } from '../server/snapshot-store.js'
import {
  doctorHelpText,
  envHelpText,
  exportRecordHelpText,
  helpText,
  labCheckpointHelpText,
  labCompareHelpText,
  labelHelpText,
  labForkHelpText,
  labHelpText,
  parseArgs,
  parseDoctorArgs,
  parseEnvArgs,
  parseExportRecordArgs,
  parseLabCheckpointArgs,
  parseLabCompareArgs,
  parseLabelArgs,
  parseLabForkArgs,
  parseReplayArgs,
  parseRotateArgs,
  parseSessionsArgs,
  replayHelpText,
  rotateHelpText,
  sessionsHelpText,
  type CliArgs,
} from './args.js'
import { renderDoctorReport, runDoctor } from './doctor.js'
import { runExportRecord } from './export-record.js'
import { runLabel } from './label.js'
import { renderRotation, requestRotation } from './rotate.js'
import { renderSessionsReport, runSessions } from './sessions.js'
import { fetchInstanceId, renderTelemetryEnv } from './telemetry-env.js'
import { readPackageVersion } from './version.js'

export interface RunCliOptions {
  /** Injectable clock, so tests get deterministic session ids and ticks. */
  now?: () => number
  /** Overrides `~/.local/share/rhizomorph` — tests point this at a temp dir. */
  dataRoot?: string
  /** Overrides the web dist dir this server would otherwise serve statically. */
  webDistDir?: string
  /** Overrides collector discovery — tests inject fakes instead of the real loader. */
  collectors?: readonly AnyCollector[]
  /** Overrides the sessionlog collector's Claude project-logs root; tests point this at a fixture dir instead of the real `~/.claude/projects`. */
  claudeProjectsRoot?: string
  /** Overrides the root `package.json` path `--version` reads from; tests point this at a fixture file. */
  rootPackageJsonPath?: string
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
 * *resumes* the recent session by default (see `decideSessionBoot`; `--fresh`
 * or `--resume-window 0` opts out), so a restart continues one run rather
 * than recording a second copy of it. Pure bootstrap otherwise: no signal handlers — that belongs to whichever entrypoint
 * actually owns the process (see `src/index.ts`), so this stays callable
 * from tests. The exceptions are `--help` and `--version`, which print to
 * stdout and exit 0, and a bad argv (unknown flag or invalid value), which
 * prints the message plus usage to stderr and exits 1 — all same as any CLI
 * tool, and none should surface as a thrown-Error stack trace.
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

  if (argv[0] === 'export-record') {
    return runExportRecordCommand(argv.slice(1), log, exit, options)
  }

  if (argv[0] === 'replay') {
    return runReplayCommand(argv.slice(1), log, exit, options)
  }

  if (argv[0] === 'sessions') {
    return runSessionsCommand(argv.slice(1), log, exit, options)
  }

  if (argv[0] === 'label') {
    return runLabelCommand(argv.slice(1), log, exit, options)
  }

  if (argv[0] === 'rotate') {
    return runRotateCommand(argv.slice(1), log, exit)
  }

  if (argv[0] === 'lab') {
    return runLabCommand(argv.slice(1), log, exit, options)
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

  if (args.version) {
    log.log(await readPackageVersion(options.rootPackageJsonPath))
    exit(0)
  }

  const repoPath = path.resolve(args.path ?? process.cwd())
  const repoName = path.basename(repoPath)
  const sessionDir = sessionDirFor(repoPath, options.dataRoot ?? defaultDataRoot())
  const ts = now()

  // Resume the run (prd2's ruling): unless --fresh (or an explicit
  // --resume-window that says the same thing), continue the most recent
  // session for this repo when it is younger than the window. Same session
  // id, same file, same collector snapshots — so a restart appends where the
  // last process stopped instead of minting a new session file holding
  // another copy of history. `decideSessionBoot` states *why*, as data, so
  // the boot line below can be honest about the boundary instead of a bare
  // "resuming session X" (operator ruling 2026-08-05).
  const decision = await decideSessionBoot(sessionDir, ts, { fresh: args.fresh, windowMs: args.resumeWindowMs })
  const resumed = decision.resumed
  const sessionId = resumed?.sessionId ?? String(ts)
  const filePath = resumed?.filePath ?? path.join(sessionDir, sessionFileName(ts))

  const recorder = new SessionRecorder(sessionId, filePath, resumed ? { resumeFrom: resumed.events } : {})
  const nextId = createIdFactory('evt')

  let resumedCount = decision.resumedCount
  if (resumed) {
    // No second `session.started`: one session, one start, however many
    // processes served it. `resumedCount` is the one fact that can't be read
    // back off the log for that same reason — see `recordResume`'s doc.
    resumedCount = await recordResume(sessionDir, sessionId)
  } else {
    await recorder.record(
      createEvent('session.started', { sessionId, repoPath, repoName }, { id: nextId(), ts: now() }),
    )
  }
  log.log(renderBootLine(decision, sessionId, resumedCount))
  recordSessionBootMeta(recorder, {
    resumedCount,
    eventCount: decision.eventCountAtBoot,
    resumeWindowMs: decision.windowMs,
    lastBootReason: decision.reason,
  })

  // Claim the session's lock as this process — beside the log, in this
  // repo's own session dir, never anywhere else (the constitution's
  // observer-owns-its-data-dir law intact). A boot that resumed just proved
  // the previous lock (if any) was stale, so overwriting it with our own pid
  // is exactly the handoff; a fresh boot claims a lock that never existed.
  // The heartbeat keeps it fresh for as long as this process actually runs,
  // so the next boot's `decideSessionBoot` can tell "still writing" from
  // "crashed" without waiting out `LOCK_STALE_MS` in the common case —
  // `isPidAlive` (`session-lock.ts`) reports a crashed pid gone immediately.
  //
  // The heartbeat names `recorder.sessionId`, not the `sessionId` this boot
  // decided on: since prd16 ruling 2 the operator can rotate mid-run, and the
  // lock belongs to the session being written *now*. It also skips the sealed
  // instant of a rotation, when the closed session's lock has just been
  // released and the new one is not claimed yet — re-creating the old one
  // there would put a live writer's claim back over a log that has ended.
  await writeSessionLock(sessionDir, sessionId, process.pid, now())
  const lockHeartbeat = setInterval(() => {
    if (recorder.isSealed) return
    void writeSessionLock(sessionDir, recorder.sessionId, process.pid, now())
  }, LOCK_HEARTBEAT_INTERVAL_MS)
  lockHeartbeat.unref()

  const collectors =
    options.collectors ??
    [
      ...(await loadCollectors(log, resumed?.events)),
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
  // `now` is threaded through for the one route that writes (`POST /api/rotate`),
  // so a rotation asked of a test's server happens on the test's clock.
  const app = buildApp({ repoPath, repoName, sessionDir, recorder, webDistDir, flatlineMs, now })

  let url: string
  try {
    url = await app.listen({ port: args.port, host: '127.0.0.1' })
  } catch (err) {
    // pollLoop was never started: a listen failure means no in-flight tick can
    // leak past this catch and race a caller's cleanup (e.g. a test's rm of
    // its temp dataRoot) with an unawaited snapshot write.
    clearInterval(lockHeartbeat)
    await removeSessionLock(sessionDir, sessionId).catch(() => {})
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
  // pollLoop.start() already fired the first tick fire-and-forget; awaiting
  // tick() here dedupes onto that same in-flight promise (see poll-loop.ts)
  // rather than forcing a second one, so the boot line below reports real
  // counts from the first poll instead of an invented zero.
  await pollLoop.tick()

  log.log(`rhizomorph running at ${url}`)
  const bootState = reduceAll(recorder.eventsSoFar())
  const worktreeCount = selectWorktreeViews(bootState).length
  const branchCount = selectBranches(bootState).length
  log.log(
    `watching ${repoPath} — ${worktreeCount} worktree${worktreeCount === 1 ? '' : 's'}, ` +
      `${branchCount} branch${branchCount === 1 ? '' : 'es'} · recording to ${filePath}`,
  )

  const stop = async () => {
    clearInterval(lockHeartbeat)
    await pollLoop.stop()
    await app.close()
    // A clean stop releases the lock immediately rather than waiting for the
    // pid to die and the next boot's staleness check to notice — the same
    // process may be the very next thing to boot this session (the resume
    // tests do exactly that), and it shouldn't have to wait itself out.
    // `recorder.sessionId` rather than the boot's, for the same reason the
    // heartbeat uses it: after a rotation, the lock this process holds is the
    // new session's, and leaving *that* one behind would make the next boot
    // refuse to resume a session nobody is writing.
    await removeSessionLock(sessionDir, recorder.sessionId).catch(() => {})
  }

  return { app, recorder, pollLoop, url, stop }
}

/**
 * The boot line states the resume heuristic's decision *and* the reason, at
 * the moment it acts (operator ruling 2026-08-05) — a rendering of
 * `decideSessionBoot`'s reason-as-data, never a re-derivation of it. Two
 * shapes: continuing a session names the exact numbers that let it continue;
 * starting one names why it didn't.
 */
function renderBootLine(decision: SessionBootDecision, sessionId: string, resumedCount: number): string {
  const window = formatBootDuration(decision.windowMs)

  if (decision.reason === 'resumed') {
    const age = decision.previousAgeMs === null ? 'unknown age' : `${formatBootDuration(decision.previousAgeMs)} old`
    return (
      `resuming session ${sessionId} (newest event ${age} < ${window} window; ` +
      `resumed ${resumedCount} time${resumedCount === 1 ? '' : 's'}; ${decision.eventCountAtBoot.toLocaleString()} events)`
    )
  }
  if (decision.reason === 'stale') {
    const age = decision.previousAgeMs === null ? 'unreadable' : `${formatBootDuration(decision.previousAgeMs)} stale`
    return `starting session ${sessionId} (previous session ${age} > ${window} window)`
  }
  if (decision.reason === 'fresh-flag') {
    return `starting session ${sessionId} (--fresh, or --resume-window 0, forced a new session)`
  }
  if (decision.reason === 'writer-alive' && decision.liveWriter) {
    return (
      `session ${decision.liveWriter.sessionId} is being written by a live instance ` +
      `(pid ${decision.liveWriter.pid}) — starting a fresh session ${sessionId} instead; ` +
      `use --fresh to silence, or stop the other instance`
    )
  }
  // prd16 ruling 2: the previous session was ENDED, by a human, on purpose.
  // Say so — a boot that resumed nothing after an operator's rotation must not
  // read like the resume window quietly lapsed.
  if (decision.reason === 'closed') {
    return `starting session ${sessionId} (the previous session was closed by \`rhizomorph rotate\` — a closed log is never resumed)`
  }
  if (decision.reason === 'rotated') {
    return `starting session ${sessionId} (rotated)`
  }
  return `starting session ${sessionId} (no previous session recorded)`
}

function defaultWebDistDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', '..', '..', 'web', 'dist')
}

/**
 * `rhizomorph doctor [path]` — a standalone, read-only subcommand, no
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
    dataRoot: options.dataRoot,
    now: options.now,
  })

  log.log(renderDoctorReport(report))
  exit(report.exitCode)
}

/**
 * `rhizomorph env <lane>` — a standalone subcommand, no server boot of its
 * own, but it does read the instance id off the server on `--port` (#60: the
 * block must declare which run this telemetry belongs to, and only the running
 * Rhizomorph knows). Same clean-usage-error contract as the main command: a
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

/**
 * `rhizomorph export-record [path]` — a standalone, one-shot subcommand, no
 * server boot: reads a recorded session off disk and writes it out as a
 * portable session record (prd11 ruling 3). Same clean-usage-error contract
 * as every other subcommand here.
 */
async function runExportRecordCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
  options: RunCliOptions,
): Promise<never> {
  let args
  try {
    args = parseExportRecordArgs(rest)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${exportRecordHelpText()}`)
    exit(1)
  }

  if (args.help) {
    log.log(exportRecordHelpText())
    exit(0)
  }

  const repoPath = path.resolve(args.path ?? process.cwd())

  try {
    const { outPath, record } = await runExportRecord({
      repoPath,
      dataRoot: options.dataRoot,
      sessionId: args.sessionId,
      out: args.out,
      handle: args.handle,
    })
    const declared = record.manifest.actor.declared ? '' : ' (undeclared)'
    log.log(
      `wrote ${outPath} — ${record.manifest.eventCount} events, ` +
        `actor ${record.manifest.actor.handle}${declared}@${record.manifest.actor.instance}`,
    )
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }

  exit(0)
}

/**
 * `rhizomorph replay <record-file>` — verifies a portable session record's
 * hash chain (refusing a tampered file loudly, prd11 ruling 4) and then boots
 * the same server the live command does, pointed at a reconstructed copy of
 * the record's own event log instead of a watched repo. No collectors run and
 * nothing is written back into the record itself: the temp directory holding
 * the reconstructed session file exists only so the existing `/api/sessions`
 * machinery (which lists a directory of `session-*.jsonl` files) can find and
 * serve it exactly like a local recording.
 */
async function runReplayCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
  options: RunCliOptions,
): Promise<CliHandle> {
  let args
  try {
    args = parseReplayArgs(rest)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${replayHelpText()}`)
    exit(1)
  }

  if (args.help) {
    log.log(replayHelpText())
    exit(0)
  }

  const filePath = path.resolve(args.file)

  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (err) {
    process.stderr.write(`could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    process.stderr.write(`${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }

  const parsed = parseRecord(json)
  if (!parsed.ok) {
    process.stderr.write(`${filePath} is not a valid session record: ${parsed.error}\n`)
    exit(1)
  }

  const verification = verifyRecord(parsed.record)
  if (!verification.ok) {
    process.stderr.write(
      `refusing to replay ${filePath}: verification failed (${verification.reason})\n` +
        `${verification.detail}\n`,
    )
    exit(1)
  }

  const { manifest, body } = parsed.record
  const events: RhizomorphEvent[] = []
  for (const link of body) {
    const lineParsed = lineToEvent(link.line)
    // Already-verified: every line parsed clean when `verifyRecord` walked it above.
    if (lineParsed.ok) events.push(lineParsed.event)
  }

  const now = options.now ?? Date.now
  const tempDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-replay-'))
  // A fresh synthetic id for this read-only serving process — distinct from
  // `manifest.actor.instance` (a foreign record's own identity, printed
  // below), which need not even be numeric for a record from a compatible
  // third-party emitter.
  const replaySessionTs = now()
  const sessionId = String(replaySessionTs)
  const replaySessionFilePath = path.join(tempDir, sessionFileName(replaySessionTs))
  await writeFile(replaySessionFilePath, eventsToJsonl(events), 'utf8')

  const recorder = new SessionRecorder(sessionId, replaySessionFilePath, { resumeFrom: events })
  const repoPath = `record:${manifest.repoSlug}`
  const pollLoop = createPollLoop({
    repoPath,
    collectors: [],
    recorder,
    exec: options.exec ?? realExec,
    now,
  })

  const webDistDir = options.webDistDir ?? defaultWebDistDir()
  const app = buildApp({
    repoPath,
    repoName: manifest.repoSlug,
    sessionDir: tempDir,
    recorder,
    webDistDir,
    // A record is a finished thing: `POST /api/rotate` refuses here (prd11
    // ruling 4's read-only replay, restated for the recorder's new hand).
    readOnly: true,
  })

  let url: string
  try {
    url = await app.listen({ port: args.port, host: '127.0.0.1' })
  } catch (err) {
    await app.close().catch(() => {})
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined
    const message =
      code === 'EADDRINUSE'
        ? `port ${args.port} is already in use — pass a different one with --port <n>`
        : `failed to start server: ${err instanceof Error ? err.message : String(err)}`
    process.stderr.write(`${message}\n`)
    exit(1)
  }

  const declared = manifest.actor.declared ? '' : ' (undeclared)'
  log.log(`rhizomorph replaying ${filePath} at ${url}`)
  log.log(
    `read-only session record — ${manifest.eventCount} events, ` +
      `actor ${manifest.actor.handle}${declared}@${manifest.actor.instance}, repo ${manifest.repoSlug}`,
  )

  const stop = async () => {
    await pollLoop.stop()
    await app.close()
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }

  return { app, recorder, pollLoop, url, stop }
}

/**
 * `rhizomorph sessions [path]` — a standalone, read-only listing, no server
 * boot: every session recorded for a repo, newest first, titled, timed and
 * costed. Same clean-usage-error contract as every other subcommand here.
 */
async function runSessionsCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
  options: RunCliOptions,
): Promise<never> {
  let args
  try {
    args = parseSessionsArgs(rest)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${sessionsHelpText()}`)
    exit(1)
  }

  if (args.help) {
    log.log(sessionsHelpText())
    exit(0)
  }

  const repoPath = path.resolve(args.path ?? process.cwd())
  const listings = await runSessions({ repoPath, dataRoot: options.dataRoot })
  log.log(renderSessionsReport(listings))

  exit(0)
}

/**
 * `rhizomorph label <sessionId> <text>` — a standalone, one-shot subcommand,
 * no server boot: writes an operator label sidecar for one recorded
 * session, never touching the session's own append-only log. Same
 * clean-usage-error contract as every other subcommand here.
 */
async function runLabelCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
  options: RunCliOptions,
): Promise<never> {
  let args
  try {
    args = parseLabelArgs(rest)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${labelHelpText()}`)
    exit(1)
  }

  if (args.help) {
    log.log(labelHelpText())
    exit(0)
  }

  const repoPath = path.resolve(args.path ?? process.cwd())

  try {
    const result = await runLabel({
      repoPath,
      sessionId: args.sessionId,
      label: args.label,
      dataRoot: options.dataRoot,
      now: options.now,
    })
    log.log(`labelled session ${result.sessionId}: "${result.label}"`)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }

  exit(0)
}

/**
 * `rhizomorph rotate` — the operator's explicit session boundary (prd16
 * ruling 2), asked of the running instrument rather than performed on its
 * files (see `cli/rotate.ts` for why that distinction is the whole design).
 * Same clean-usage-error contract as every other subcommand here: a bad argv,
 * or a server that isn't there, prints to stderr and exits 1.
 */
async function runRotateCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
): Promise<never> {
  let args
  try {
    args = parseRotateArgs(rest)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${rotateHelpText()}`)
    exit(1)
  }

  if (args.help) {
    log.log(rotateHelpText())
    exit(0)
  }

  try {
    log.log(renderRotation(await requestRotation(args.port)))
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }

  exit(0)
}

/**
 * `rhizomorph lab <subcommand>` — the laboratory's namespace (prd12 ruling
 * 1): `checkpoint` (capture, #148), `fork` (restore + dispatch) and `compare`
 * (the table). An unknown subcommand, or a bare `rhizomorph lab`, prints the
 * namespace's own usage table.
 *
 * This function is the ONLY way into `server/src/lab/` — the namespace law
 * test asserts no other source file in the package imports it, so there is no
 * background caller and nothing runs without the operator typing it.
 */
async function runLabCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
  options: RunCliOptions,
): Promise<never> {
  if (rest[0] === 'checkpoint') {
    return runLabCheckpointCommand(rest.slice(1), log, exit, options)
  }

  if (rest[0] === 'fork') {
    return runLabForkCommand(rest.slice(1), log, exit, options)
  }

  if (rest[0] === 'compare') {
    return runLabCompareCommand(rest.slice(1), log, exit, options)
  }

  if (rest.length === 0 || rest.includes('--help') || rest.includes('-h')) {
    log.log(labHelpText())
    exit(0)
  }

  process.stderr.write(`unknown lab subcommand: "${rest[0]}"\n\n${labHelpText()}`)
  exit(1)
}

/**
 * `rhizomorph lab checkpoint <lane>` — the explicit hand prd12 ruling 1
 * requires: a one-shot, standalone subcommand (no server boot) that captures
 * a live workspace + session snapshot and emits it as a `fork.checkpoint`
 * event. Same clean-usage-error contract as every other subcommand here.
 */
async function runLabCheckpointCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
  options: RunCliOptions,
): Promise<never> {
  let args
  try {
    args = parseLabCheckpointArgs(rest)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${labCheckpointHelpText()}`)
    exit(1)
  }

  if (args.help) {
    log.log(labCheckpointHelpText())
    exit(0)
  }

  const worktreePath = path.resolve(args.path ?? process.cwd())

  try {
    const { event } = await captureCheckpoint({
      lane: args.lane,
      worktreePath,
      capturedBy: args.capturedBy,
      exec: options.exec,
      now: options.now,
      dataRoot: options.dataRoot,
      claudeProjectsRoot: options.claudeProjectsRoot,
    })
    log.log(
      `checkpoint ${event.payload.checkpointId} captured for lane "${event.payload.lane}" — ` +
        `${event.payload.snapshotRef} @ ${event.payload.snapshotSha.slice(0, 12)}, ` +
        `session cut at byte ${event.payload.sessionCutByte}`,
    )
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }

  exit(0)
}

/**
 * `rhizomorph lab fork <lane>` — restores n arms of one checkpoint and records
 * each as a `fork.dispatched`. Prints, per arm, the worktree it lives in, the
 * session synthesized for it, and the launcher command line — run for you only
 * when `--launch` says so (see `lab/fork.ts`'s module doc for why that write is
 * the operator's to authorise).
 */
async function runLabForkCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
  options: RunCliOptions,
): Promise<never> {
  let args
  try {
    args = parseLabForkArgs(rest)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${labForkHelpText()}`)
    exit(1)
  }

  if (args.help) {
    log.log(labForkHelpText())
    exit(0)
  }

  const parentWorktreePath = path.resolve(args.path ?? process.cwd())

  try {
    const result = await dispatchFork({
      parentLane: args.lane,
      parentWorktreePath,
      checkpointId: args.at,
      arms: args.arms,
      model: args.model,
      promptFile: args.promptFile,
      launch: args.launch,
      exec: options.exec,
      now: options.now,
      dataRoot: options.dataRoot,
      claudeProjectsRoot: options.claudeProjectsRoot,
    })

    log.log(
      `fork ${result.forkId} — ${result.arms.length} arm(s) of lane "${result.parentLane}" ` +
        `restored from checkpoint ${result.checkpointId}`,
    )
    for (const arm of result.arms) {
      log.log(
        `  arm ${arm.arm}  ${arm.laneHandle}\n` +
          `    worktree  ${arm.worktreePath}\n` +
          `    session   ${arm.session.filePath} (${arm.session.linesCopied} lines, ` +
          `${arm.session.rewrites[0]?.count ?? 0} paths rewritten to this tree)` +
          (arm.launcherSession === null
            ? ''
            : `\n    session   ${arm.launcherSession.filePath} (the launcher's own tree)`) +
          `\n    launch    ${arm.launched ? 'ran: ' : 'not run — run it yourself: '}${arm.launcherArgv.join(' ')}`,
      )
    }
    if (!args.launch) {
      log.log(
        '\nNo tmux window was opened and no branch was created: prd12 ruling 1 confines the\n' +
          "laboratory's writes to refs/rhizomorph/, its own worktrees and its data dir, and\n" +
          "'workmux add' writes outside all three. Pass --launch to authorise that yourself.",
      )
    }
    log.log(`\nCompare them with: rhizomorph lab compare ${result.forkId} --path ${parentWorktreePath}`)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }

  exit(0)
}

/**
 * `rhizomorph lab compare <fork-id>` — prd12 ruling 6's table, and ruling 4's
 * refusal to rank below three arms. Exits 0 whether or not the arms passed
 * their gate: the command's job is to report, and a failing arm is a result,
 * not a CLI error.
 */
async function runLabCompareCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
  options: RunCliOptions,
): Promise<never> {
  let args
  try {
    args = parseLabCompareArgs(rest)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${labCompareHelpText()}`)
    exit(1)
  }

  if (args.help) {
    log.log(labCompareHelpText())
    exit(0)
  }

  const parentWorktreePath = path.resolve(args.path ?? process.cwd())

  try {
    const comparison = await compareFork({
      forkId: args.forkId,
      parentWorktreePath,
      verifyCommand: args.verify,
      skipVerify: args.skipVerify,
      exec: options.exec,
      dataRoot: options.dataRoot,
    })
    log.log(renderComparison(comparison))
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }

  exit(0)
}
