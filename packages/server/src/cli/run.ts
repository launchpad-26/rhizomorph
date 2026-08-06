import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEvent, createIdFactory, reduceAll, selectBranches, selectWorktreeViews } from '@rhizomorph/core'
import { createSessionlogCollector } from '../collectors/sessionlog/index.js'
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
import { createPollLoop } from '../server/poll-loop.js'
import { SessionRecorder } from '../server/recorder.js'
import { createFileSnapshotStore } from '../server/snapshot-store.js'
import { helpText, parseArgs, type CliArgs } from './args.js'
import type { CliHandle, RunCliOptions } from './types.js'
import { readPackageVersion } from './version.js'

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
export async function runServerCommand(
  argv: readonly string[],
  options: RunCliOptions,
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
): Promise<CliHandle> {
  const now = options.now ?? Date.now

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
    return `starting session ${sessionId} (the previous session was closed on purpose — \`rhizomorph rotate\`, or the dashboard's button — and a closed log is never resumed)`
  }
  if (decision.reason === 'rotated') {
    return `starting session ${sessionId} (rotated)`
  }
  return `starting session ${sessionId} (no previous session recorded)`
}

/**
 * Same dist dir the server would otherwise serve statically — duplicated in
 * `replay.ts` and `doctor.ts` rather than imported to avoid a circular
 * import between them and this module.
 */
function defaultWebDistDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', '..', '..', 'web', 'dist')
}
