import type { Exec, ExecOptions } from '@rhizomorph/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  checkCliVersionDrift,
  checkClaudeProjects,
  checkEnrichmentLadder,
  checkLaneManifest,
  checkNodeVersion,
  checkOptionalTool,
  checkSessionBoundary,
  checkTelemetryEnv,
  type DoctorCheck,
} from '../cli/doctor.js'
import type { ServerContext } from '../server/context.js'
import { exec as realExec } from '../server/exec.js'
import { isLoopbackHost } from '../server/mutation-guard.js'

/**
 * The seams `runServerDoctor` needs, mirroring the CLI's own `DoctorOptions`
 * minus the three fields that back the checks this route never runs
 * (`path`/`port` for `target-path`/`port`, `webDistDir` for `web-build` —
 * prd-19 ruling 5). Defaults to the real process/exec when omitted, exactly
 * like the CLI does; tests supply fixtures for every field instead.
 */
export interface ServerDoctorOptions {
  exec?: Exec
  claudeProjectsRoot?: string
  dataRoot?: string
  now?: () => number
  nodeVersion?: string
  rootPackageJsonPath?: string
  env?: NodeJS.ProcessEnv
  platform?: string
  /**
   * True when this server is replaying a finished session record rather
   * than watching a live repo (`rhizomorph replay` sets `ServerContext.readOnly`
   * — prd11 ruling 4). `repoPath` is then a synthetic `record:<slug>` string,
   * never a real filesystem path, and the real session data lives at
   * `ctx.sessionDir` (a temp dir), unrelated to the `sessionDirFor(repoPath,
   * dataRoot)` convention `session-boundary` and `lane-manifest` assume.
   * Probing them against the fictitious path would silently report facts
   * about a directory that has nothing to do with the replayed record, and
   * the ladder's git contributor would be assuming a live repo that was
   * never watched at all. Adversarial review item 5: those three checks are
   * replaced with an honest "not applicable" entry instead.
   */
  replay?: boolean
}

/** A `DoctorCheck` this call skipped outright because it assumes a live repo/recorder a replay session doesn't have — see `ServerDoctorOptions.replay`'s own doc. */
function notApplicableDuringReplay(id: string): DoctorCheck {
  return {
    id,
    status: 'ok',
    message:
      'not applicable — this server is replaying a finished session record, not watching a live repo, ' +
      'so this check would otherwise probe a path that has nothing to do with the record',
  }
}

/**
 * `GET /api/doctor`'s check set (prd-19 ruling 5) — built from the SAME
 * exported check functions `rhizomorph doctor` calls in `cli/doctor.ts`;
 * this file never re-implements a check, only recombines the ones that are
 * still meaningful once a server is already up and answering the request:
 *
 * - `target-path`, `web-build`, `port` are dropped outright. Each answers a
 *   question this very request already answers by existing: the repo is
 *   obviously a usable git repo (this server is watching it), the web build
 *   is obviously present or this handler couldn't have been reached through
 *   it, and the port is obviously not "in use by something else" — it's in
 *   use by this.
 * - `telemetry` is kept, but marked `'server'`: this process's env is not
 *   the agent's, so the check is honest about what it cannot see rather than
 *   silently answering the wrong question (and, per `checkTelemetryEnv`'s own
 *   doc, this arm never reports `ok` — adversarial review item 4).
 *
 * `checkEnrichmentLadder` still wants to know whether `target-path` read
 * `ok` (it feeds the ladder's git contributor) even though this route never
 * runs that check — the synthetic entry below supplies it, flagged `assumed:
 * true` so `checkEnrichmentLadder` propagates that flag onto the ladder
 * entries it derives from it (adversarial review item 3: visible in the
 * payload, not only in a code comment).
 *
 * This function itself is never rate-limited or timed out — that is
 * deliberately the route's own concern (`createRouteDoctorProbe` below), not
 * this reusable core's, so a direct caller (this file's own tests, and any
 * future CLI-side consumer of a running server per this issue's own DoD)
 * gets the real answer on its own terms.
 */
export async function runServerDoctor(repoPath: string, options: ServerDoctorOptions = {}): Promise<DoctorCheck[]> {
  const exec = options.exec ?? realExec
  const replay = options.replay ?? false

  const baseChecks: DoctorCheck[] = [
    await checkNodeVersion({ nodeVersion: options.nodeVersion, rootPackageJsonPath: options.rootPackageJsonPath }),
    checkClaudeProjects(options.claudeProjectsRoot),
    replay ? notApplicableDuringReplay('session-boundary') : await checkSessionBoundary(repoPath, options.dataRoot, options.now ?? Date.now),
    await checkOptionalTool('tmux', 'tmux', ['-V'], exec),
    await checkOptionalTool('workmux', 'workmux', ['status'], exec),
    checkTelemetryEnv(options.env ?? process.env, options.platform ?? process.platform, 'server'),
    replay ? notApplicableDuringReplay('lane-manifest') : await checkLaneManifest(repoPath),
    await checkCliVersionDrift(exec),
  ]

  if (replay) {
    // The whole ladder is a live-repo enrichment story (git + sessionlog +
    // tmux/workmux + telemetry rungs) — nonsensical for a finished record
    // this server never watched. Labeled the same honest way as the other
    // two replay-skipped checks above, rather than assuming a git contributor
    // that was never true.
    return [...baseChecks, notApplicableDuringReplay('ladder')]
  }

  const impliedTargetPath: DoctorCheck = {
    id: 'target-path',
    status: 'ok',
    message: 'implied: this server is already running against this repository',
    assumed: true,
  }
  const ladder = await checkEnrichmentLadder([impliedTargetPath, ...baseChecks], repoPath)

  return [...baseChecks, ...ladder]
}

/**
 * Per-exec-call ceiling for the three real child processes this route can
 * spawn (`tmux -V`, `workmux status`, `claude --version`) — adversarial
 * review item 2a. The CLI's own invoker is a human at a terminal who can
 * Ctrl-C a hang; an unauthenticated GET's caller cannot, so a wedged
 * `claude`/`tmux`/`workmux` must not be able to hang the response (or pile up
 * hung child processes) forever. The CLI path is untouched — `runDoctor`
 * never wraps its `exec` this way.
 */
export const ROUTE_EXEC_TIMEOUT_MS = 5000

/** Wraps an `Exec` so every call it makes carries `timeoutMs`, without changing anything else about how it's invoked. */
function withTimeout(exec: Exec, timeoutMs: number): Exec {
  return (command: string, args: readonly string[], options?: ExecOptions) => exec(command, args, { ...options, timeoutMs })
}

/**
 * How long a served answer is reused before the next request triggers a
 * fresh probe (adversarial review item 2b). Named so the tradeoff is
 * reviewable in one place: long enough that a burst of concurrent,
 * unauthenticated GETs (no token, no rate limit elsewhere on this route)
 * single-flights onto one real probe run instead of one each; short enough
 * that `/connect`'s "watch a row flip live" promise (prd-19's own success
 * criterion) still reads as current a few seconds later.
 */
export const PROBE_CACHE_TTL_MS = 3000

/**
 * Builds a memoized prober scoped to one `registerDoctorRoute` call (one
 * running server) — never a bare module-level global, which would leak one
 * app/repo's cached answer into an unrelated app's request (this file's own
 * tests build many `buildApp` instances; a shared global would make test B
 * see test A's stale result). Caching the *promise* itself, not just its
 * resolved value, is what makes this single-flight: two concurrent callers
 * within the same tick get the exact same in-flight promise, so only one
 * underlying `runServerDoctor` call — and therefore only one set of real
 * child-process spawns — ever happens for both. A rejection clears the cache
 * immediately rather than serving the same failure for the rest of the TTL.
 */
export function createRouteDoctorProbe(
  repoPath: string,
  baseOptions: ServerDoctorOptions = {},
): () => Promise<DoctorCheck[]> {
  let cached: { at: number; result: Promise<DoctorCheck[]> } | null = null

  return () => {
    const now = baseOptions.now ?? Date.now
    const nowMs = now()

    if (cached && nowMs - cached.at < PROBE_CACHE_TTL_MS) {
      return cached.result
    }

    const exec = withTimeout(baseOptions.exec ?? realExec, ROUTE_EXEC_TIMEOUT_MS)
    const result = runServerDoctor(repoPath, { ...baseOptions, exec })
    cached = { at: nowMs, result }
    result.catch(() => {
      cached = null
    })
    return result
  }
}

/**
 * Fastify `preHandler`: refuses a request whose `Host` header is not
 * loopback, reusing `server/mutation-guard.ts`'s own predicate rather than
 * re-deriving it (adversarial review item 1). `GET /api/doctor` is a
 * recon-grade disclosure — repo/home paths, versions, tool presence, session
 * facts — that would otherwise sit behind #235's known gap: every `GET` is
 * exempt from the mutation guard's own Host/Origin check until that issue
 * widens `MUTATING_METHODS`. This opts THIS route into that same check
 * directly rather than waiting; the global `GET` exemption stays #235's own
 * work.
 */
function requireLoopbackHost() {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const host = request.headers.host
    if (!isLoopbackHost(host)) {
      await reply.code(400).send({
        error: `refused: Host "${host ?? ''}" is not loopback — GET /api/doctor only answers requests addressed to 127.0.0.1/localhost`,
      })
    }
  }
}

/**
 * Read-only `GET /api/doctor` (prd-19 ruling 5): no body, no token (GET-only
 * under the #216 posture), no writes — every check it calls is one of
 * `cli/doctor.ts`'s own read-only seams (filesystem facts, an injected
 * `exec`), and this route additionally bounds what an unauthenticated caller
 * can force: a loopback-only `Host` guard, a per-exec timeout, and a
 * single-flight/short-TTL cache over the whole answer (adversarial review
 * items 1–2). Serves the server-relevant subset of the CLI's report for the
 * repo this very server is already running, so a stranger looking at
 * `/connect` can see facts the page's own GETs and stream cannot know (the
 * slug dir, version drift, the lane manifest) without needing a terminal at
 * all — honestly labeled as not applicable when this server is a replay
 * (`ctx.readOnly`, item 5) rather than a live repo.
 */
export function registerDoctorRoute(app: FastifyInstance, ctx: ServerContext): void {
  const probe = createRouteDoctorProbe(ctx.repoPath, { replay: ctx.readOnly === true })
  app.get('/api/doctor', { preHandler: requireLoopbackHost() }, async () => probe())
}
