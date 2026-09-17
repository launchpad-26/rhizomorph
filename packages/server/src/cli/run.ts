import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEvent, createIdFactory, selectBranches, selectWorktreeViews } from '@rhizomorph/core'
import { recordSessionBootMeta } from '../api/meta.js'
import { defaultDataRoot, repoSlug, sessionDirFor, sessionFileName, snapshotDirFor } from '../log/paths.js'
import { LOCK_HEARTBEAT_INTERVAL_MS, removeSessionLock, writeSessionLock } from '../log/session-lock.js'
import {
  decideSessionBoot,
  formatBootDuration,
  recordResume,
  type SessionBootDecision,
} from '../log/session-log.js'
import { createRepoRootResolver } from '../paths/repo-root.js'
import { createColonyRecorders } from '../recorder/colony-recorders.js'
import { buildApp } from '../server/build-app.js'
import { loadCollectors } from '../server/collector-loader.js'
import { type Colony, createColonyDiscovery } from '../server/colonies.js'
import { createColonySupervisor } from '../server/colony-supervisor.js'
import type { ServerContext } from '../server/context.js'
import { exec as realExec } from '../server/exec.js'
import { createPollLoop } from '../server/poll-loop.js'
import { SessionRecorder } from '../server/recorder.js'
import { createFileSnapshotStore } from '../server/snapshot-store.js'
import { type CliArgs, helpText, parseArgs } from './args.js'
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
  // `decision.eventCountAtBoot` is deliberately NOT passed on (#592): it is a
  // boot snapshot, and `/api/meta` used to serve it under the live-sounding
  // name `eventCount` — frozen forever, most visibly at 0 on a session the
  // operator had just rotated into. The route reports the live count off its
  // own fold now. The snapshot still has its honest readers: the boot line
  // below, and `rhizomorph doctor`.
  recordSessionBootMeta(recorder, {
    resumedCount,
    resumeWindowMs: decision.windowMs,
    lastBootReason: decision.reason,
  })

  const collectors =
    options.collectors ??
    (await loadCollectors(log, resumed?.events, {
      claudeProjectsRoot: options.claudeProjectsRoot,
      home: options.home,
      backfill: args.backfill,
    }))
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

  /**
   * THE WATCHED SET — prd-58 rulings 1 and 2.
   *
   * The pinned colony is the one this boot already opened: its recorder, its
   * collectors and its loop are the objects above, adopted rather than rebuilt,
   * which is what keeps the one-colony case byte-identical to what it was.
   * Everything discovered afterwards gets its own of each.
   *
   * Discovery runs off the PINNED loop's fold rather than on a timer of its
   * own. The process witness re-reads the machine's table every tick anyway, so
   * a second clock would be a second cost to answer a question the first one
   * has already answered — and ADR-0013's budget is per tick, not per feature.
   */
  const colonyRoots = createRepoRootResolver(options.exec ?? realExec)
  const discovery = createColonyDiscovery({ pinnedRepoPath: repoPath, resolver: colonyRoots })
  const pinnedColony: Colony = { id: repoSlug(repoPath), path: repoPath, pinned: true }
  const colonyRecorders = createColonyRecorders({
    dataRoot: options.dataRoot ?? defaultDataRoot(),
    pinned: { colony: pinnedColony, recorder },
    now,
  })
  const colonies = createColonySupervisor({
    recorders: colonyRecorders,
    // The pinned colony is already running: this boot opened its recorder, its
    // collectors and its loop above, and discovery reports it every tick.
    // Without this the supervisor starts a second loop on the same recorder and
    // every event is written twice.
    adopt: { colony: pinnedColony, recorder, pollLoop },
    startColony: async (colony, colonyRecorder) => {
      // One collector SET per colony, not one shared: a collector holds its own
      // snapshots, and two repos sharing one would make each look like the
      // other's discoveries had already happened.
      const colonyCollectors = await loadCollectors(log, undefined, {
        claudeProjectsRoot: options.claudeProjectsRoot,
        home: options.home,
        backfill: false,
      })
      const loop = createPollLoop({
        repoPath: colony.path,
        collectors: colonyCollectors,
        recorder: colonyRecorder,
        exec: options.exec ?? realExec,
        now,
        intervalMs: options.intervalMs ?? args.pollIntervalMs,
        snapshotStore: createFileSnapshotStore(
          snapshotDirFor(sessionDirFor(colony.path, options.dataRoot ?? defaultDataRoot()), colonyRecorder.sessionId),
        ),
      })
      loop.start()
      return loop
    },
    // Reported, never swallowed: silence here is indistinguishable from a repo
    // with no agents, which is the one reading that hides the gap.
    onStartFailed: (colony, cause) => {
      log.log(`colony ${colony.id} (${colony.path}) could not be watched: ${cause instanceof Error ? cause.message : String(cause)}`)
    },
  })

  const webDistDir = options.webDistDir ?? defaultWebDistDir()
  const flatlineMs = args.flatlineMinutes * 60_000
  // The one object every route AND this boot's own lock bookkeeping share
  // (prd20 ruling 5) — built once, mutated in place by a retarget, never
  // copied (`build-app.ts` no longer spreads it). `repoPath`/`repoName`/
  // `sessionDir` below are this boot's starting values; anything that reads
  // them after this point reads `ctx`'s copies, not these locals, so a later
  // re-point is visible everywhere at once.
  const ctx: ServerContext = {
    repoPath,
    repoName,
    sessionDir,
    recorder,
    webDistDir,
    flatlineMs,
    now,
    pollLoop,
    port: args.port,
  }

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
  //
  // `ctx.sessionDir`, not the `sessionDir` local, for the same reason the
  // heartbeat already used `recorder.sessionId` over the boot's own
  // `sessionId` (prd20 retarget spike, verified bug): a retarget re-points
  // `ctx.sessionDir` at the NEW repo's directory, and a heartbeat that kept
  // closing over the boot-time constant would write the new session's lock
  // into the OLD repo's directory forever — this is what stops that.
  await writeSessionLock(ctx.sessionDir, sessionId, process.pid, now())
  const lockHeartbeat = setInterval(() => {
    if (recorder.isSealed) return
    void writeSessionLock(ctx.sessionDir, recorder.sessionId, process.pid, now())
  }, LOCK_HEARTBEAT_INTERVAL_MS)
  lockHeartbeat.unref()

  // `now` is threaded through for the one route that writes (`POST /api/rotate`),
  // so a rotation asked of a test's server happens on the test's clock.
  const app = buildApp(ctx)

  let url: string
  try {
    url = await app.listen({ port: args.port, host: '127.0.0.1' })
  } catch (err) {
    // pollLoop was never started: a listen failure means no in-flight tick can
    // leak past this catch and race a caller's cleanup (e.g. a test's rm of
    // its temp dataRoot) with an unawaited snapshot write.
    clearInterval(lockHeartbeat)
    await removeSessionLock(ctx.sessionDir, sessionId).catch(() => {})
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

  /**
   * Discovery, off the pinned fold, on the pinned loop's cadence.
   *
   * `sync` is additive and idempotent, so running it every tick costs one
   * `Map` lookup per already-watched colony — the resolver caches per cwd, so
   * a steady machine spawns no `git` at all after the first sighting of each.
   */
  const syncColonies = async () => {
    try {
      const actors = Object.values(recorder.foldSoFar().processes)
      await colonies.sync(await discovery.discover(actors))
    } catch (cause) {
      // Discovery failing must never take the pinned colony down with it: the
      // instrument watching one repo beats the instrument watching none.
      log.log(`colony discovery failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  await syncColonies()
  const colonySweep = setInterval(() => void syncColonies(), options.intervalMs ?? args.pollIntervalMs)
  colonySweep.unref()

  log.log(`rhizomorph running at ${url}`)
  // The recorder's maintained fold, not a re-fold of its buffer (prd-40 ruling
  // 2, and prd-44 ruling 4 / #37 makes it load-bearing rather than merely
  // cheaper): the buffer is a window capped at `MAX_BUFFERED_EVENTS`, so on a
  // resumed session past that cap `reduceAll(eventsSoFar())` would describe the
  // last 75,000 events instead of the session, and the boot line would
  // under-report the worktrees and branches the operator is watching.
  const bootState = recorder.foldSoFar()
  const worktreeCount = selectWorktreeViews(bootState).length
  const branchCount = selectBranches(bootState).length
  log.log(
    `watching ${repoPath} — ${worktreeCount} worktree${worktreeCount === 1 ? '' : 's'}, ` +
      `${branchCount} branch${branchCount === 1 ? '' : 'es'} · recording to ${filePath}`,
  )

  const stop = async () => {
    clearInterval(lockHeartbeat)
    clearInterval(colonySweep)
    // Discovered colonies first: each awaits its own in-flight tick, and they
    // stop in parallel so a shutdown costs one tick budget rather than N.
    await colonies.stop()
    await pollLoop.stop()
    await app.close()
    try {
      // Releases the session log's held descriptor. Since prd44 ruling 2 the
      // writer holds one open across appends and lets it go only in `sync()`,
      // whose sole other caller is rotation (`closeWith`) — so without this,
      // the session open at shutdown was closed by garbage collection, which
      // Node deprecates (DEP0137) and will one day throw on. It also makes the
      // last session durable, which is prd17 ruling 3.5's promise applied to
      // the session nobody rotated as well as the ones somebody did.
      await recorder.sync()
    } finally {
      // A clean stop releases the lock immediately rather than waiting for the
    // pid to die and the next boot's staleness check to notice — the same
    // process may be the very next thing to boot this session (the resume
    // tests do exactly that), and it shouldn't have to wait itself out.
    // `ctx.sessionDir` and `recorder.sessionId` rather than the boot's, for
    // the same reason the heartbeat uses them: after a rotation OR a
    // retarget, the lock this process holds is the CURRENT session's, in the
    // CURRENT repo's directory, and leaving either boot-time value behind
    // would make the next boot refuse to resume a session nobody is writing,
    // or leave a stale lock in a repo this process no longer watches.
      //
      // `finally`, not a plain sequence: a failing fsync must still reach the
      // caller, and it must not be the reason a stale lock outlives the
      // process that held it. Those are two different promises and a
      // two-statement sequence breaks one of them whichever order it picks.
      await removeSessionLock(ctx.sessionDir, recorder.sessionId).catch(() => {})
    }
  }

  return { app, recorder, pollLoop, url, stop, ctx }
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
