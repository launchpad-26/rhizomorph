import type { Exec, SessionState } from '@rhizomorph/core'
import type { FastifyInstance } from 'fastify'
import {
  checkCliVersionDrift,
  checkClaudeProjects,
  checkEnrichmentLadder,
  checkHarnessRoster,
  checkLaneManifest,
  checkNodeVersion,
  checkOptionalTool,
  checkSessionBoundary,
  checkTelemetryEnv,
  declaredAttentionChecks,
  type DoctorCheck,
} from '../cli/doctor.js'
import type { ServerContext } from '../server/context.js'
import { exec as realExec, withTimeout } from '../server/exec.js'
import { requireCapabilityToken } from './security.js'

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
  /**
   * The running recorder's fold, read live per call (`ctx.recorder` is
   * re-pointed on retarget — prd-20 ruling 5 — so this is a thunk, never a
   * captured object). Feeds the ladder's beacon contributor and the per-lane
   * `attention` readings (#307). Absent: the ladder reads the static beacon
   * manifest and no `attention` lines are emitted.
   */
  foldSoFar?: () => SessionState
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
 * **The fold is the input the ladder was missing (#307).** #218 gave
 * `checkEnrichmentLadder` its optional `declared` parameter so this route would
 * keep compiling, and this route passed nothing — so a beacon-only machine read
 * L4 here and L2 from `rhizomorph doctor`, two surfaces disagreeing about the
 * same repo. `ServerDoctorOptions.foldSoFar` closes it: the running recorder's
 * fold feeds both the ladder's beacon contributor and the per-lane `attention`
 * lines, which are phrased by `cli/doctor.ts`'s own `declaredAttentionChecks`
 * rather than restated here — this file still never re-implements a check.
 * `/api/meta`'s ladder already read `beaconCapabilitiesFor(folded.declared)`,
 * so all three readers now derive the rung from one fold.
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
    checkClaudeProjects(options.claudeProjectsRoot, repoPath),
    replay ? notApplicableDuringReplay('session-boundary') : await checkSessionBoundary(repoPath, options.dataRoot, options.now ?? Date.now),
    await checkOptionalTool('tmux', 'tmux', ['-V'], exec),
    await checkOptionalTool('workmux', 'workmux', ['status'], exec),
    checkTelemetryEnv(options.env ?? process.env, options.platform ?? process.platform, 'server'),
    replay ? notApplicableDuringReplay('lane-manifest') : await checkLaneManifest(repoPath),
    await checkCliVersionDrift(exec),
    checkHarnessRoster(),
  ]

  // Never read during a replay, and never read twice: a replay's `repoPath` is
  // a synthetic `record:<slug>` string and its recorder holds the replayed
  // record, not a live fleet, so the thunk must not be called at all.
  const fold = replay || options.foldSoFar === undefined ? null : options.foldSoFar()

  const attention: DoctorCheck[] = replay
    ? [notApplicableDuringReplay('attention')]
    : fold === null
      ? []
      : declaredAttentionChecks(fold, (options.now ?? Date.now)())

  if (replay) {
    // The whole ladder is a live-repo enrichment story (git + sessionlog +
    // tmux/workmux + telemetry rungs) — nonsensical for a finished record
    // this server never watched. Labeled the same honest way as the other
    // two replay-skipped checks above, rather than assuming a git contributor
    // that was never true.
    return [...baseChecks, ...attention, notApplicableDuringReplay('ladder')]
  }

  const impliedTargetPath: DoctorCheck = {
    id: 'target-path',
    status: 'ok',
    message: 'implied: this server is already running against this repository',
    assumed: true,
  }
  const ladder = await checkEnrichmentLadder([impliedTargetPath, ...baseChecks], repoPath, fold?.declared ?? {})

  // Attention before the ladder, the order `rhizomorph doctor` prints them in:
  // the per-lane readings are what the rung line below is derived from.
  return [...baseChecks, ...attention, ...ladder]
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

/**
 * How long a served answer is reused before the next request triggers a
 * fresh probe (adversarial review item 2b). Named so the tradeoff is
 * reviewable in one place: long enough that a burst of concurrent,
 * unauthenticated GETs (no token, no rate limit elsewhere on this route)
 * single-flights onto one real probe run instead of one each; short enough
 * that `/connect`'s "watch a row flip live" promise (prd-19's own success
 * criterion) still reads as current a few seconds later — six of the
 * checklist's seven rows flip off the live SSE fold and never wait on this
 * route at all, so "a few seconds" has room to mean several.
 *
 * The seventh is the exception worth stating rather than glossing:
 * `connect/links.ts`'s `transcripts-slug` takes its *status* from this
 * route's `session-logs` check, so this TTL is its flip latency: creating
 * the missing slug directory now shows up in up to 15s, where the old 3s TTL
 * (every poll a cold probe) showed it within one poll. Its VERIFIED reading
 * is dated "as of <render>" while standing on a probe that can be 10s old
 * when this page's own poll created the entry — and, since the cache is one
 * per server shared by every caller, up to the full TTL when something else
 * did (a second tab, a `curl`, the CLI). Worst case for the flip is then
 * TTL + one poll interval, not TTL. That is the price of the single-flight,
 * paid by one row; #223's staleness voice is where a fact that carries its
 * own probe age belongs.
 *
 * **#344:** a cache hit never pushes out `cached.at` (`createRouteDoctorProbe`
 * below) — an entry expires on the clock of the probe that created it,
 * regardless of how many hits land in between. That makes this TTL, not the
 * connect page's own poll interval, the thing that has to be deliberately
 * sized: `connect/index.tsx`'s default `refreshMs` (5000) must stay strictly
 * below this value for any of its polls to ever land inside the window —
 * three times under it, here, so a page whose own poll opened the window
 * reuses the last probe twice (no new `tmux`/`workmux`/`claude --version`
 * spawns) and pays for a fresh one on the third. That ratio is a property of
 * one client polling alone, not of this route: the cache is one per server,
 * shared by every caller, so an entry opened by someone else leaves this
 * page hitting on some other cadence entirely. What the TTL *does*
 * guarantee, whoever asks, is the probe rate — at most one real probe per
 * TTL across all callers, which is what the single-flight is for. Raising
 * `refreshMs` without raising this in step, or lowering this without
 * checking `refreshMs`, silently puts the two back at odds — see
 * `connect/index.tsx`'s own comment on `refreshMs`. The comparison above is
 * strict on purpose and `(#344)` in this file's tests pins it: at `<=` a
 * poll landing exactly on the boundary hits, and the sequence documented
 * here becomes one probe in four.
 */
export const PROBE_CACHE_TTL_MS = 15_000

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
 * Read-only `GET /api/doctor` (prd-19 ruling 5): no body, no writes, and —
 * since prd-29 ruling 7 (#59) — gated by the capability token like every
 * other `gated-read`, `requireCapabilityToken` as a route-local `preHandler`.
 * It used to be exempted from that gate under the #216 GET-only posture
 * (unauthenticated GETs were considered safe because they could not mutate
 * anything); prd-29 wave 2 closes that exemption for this route and
 * `/api/meta` both, so an unauthenticated local process can no longer read
 * the repo/version/lane facts this route serves. Every check it calls is one of
 * `cli/doctor.ts`'s own read-only seams (filesystem facts, an injected
 * `exec`), and this route additionally bounds what an unauthenticated caller
 * can force: a per-exec timeout and a single-flight/short-TTL cache over the
 * whole answer (adversarial review item 2). This route used to also carry
 * its own route-local loopback-`Host` guard (adversarial review item 1), back
 * when every `GET` was exempt from the app-wide mutation guard's Host check;
 * #235 closed that gap globally and prd-23 ruling 5 retired the now-redundant
 * copy — every request this server answers, this one included, is refused
 * before reaching any handler if its `Host` is not loopback
 * (`server/mutation-guard.ts`). Serves the server-relevant subset of the
 * CLI's report for the repo this very server is already running, so a
 * stranger looking at `/connect` can see facts the page's own GETs and
 * stream cannot know (the slug dir, version drift, the lane manifest)
 * without needing a terminal at all — honestly labeled as not applicable
 * when this server is a replay (`ctx.readOnly`, item 5) rather than a live
 * repo.
 *
 * THE ONE ROUTE THAT BINDS `repoPath` AT REGISTRATION (prd20 retarget spike
 * Q1, gap d): every other route reads `ctx.repoPath` live inside its handler,
 * but the prober above is built once, closing over the string it was handed,
 * and memoizes its answer for `PROBE_CACHE_TTL_MS`. Left alone, a retarget
 * would leave this route probing the OLD repo — worse, silently, for a whole
 * `PROBE_CACHE_TTL_MS` after the switch, and forever if a request never lands
 * outside that window to notice the drift. The invalidation hook is
 * deliberately reactive rather than requiring a retarget route to remember to
 * call something here: every request compares `ctx.repoPath` against what the
 * current prober was built for, and rebuilds (a fresh prober, a cold cache)
 * the instant they disagree — so this route self-heals on its very next
 * request, with no dependency on #389 (or anything else) calling back into it.
 *
 * The fold seam (#307) is deliberately NOT bound the same way: `foldSoFar`
 * below reads `ctx.recorder` inside the thunk, so a retarget that re-points the
 * recorder is picked up by the next probe whether or not the prober itself was
 * rebuilt. Capturing `ctx.recorder` here instead would have re-created exactly
 * the staleness the paragraph above exists to describe, one field over.
 */
export function registerDoctorRoute(app: FastifyInstance, ctx: ServerContext): void {
  let proberRepoPath = ctx.repoPath
  let probe = createRouteDoctorProbe(proberRepoPath, {
    replay: ctx.readOnly === true,
    foldSoFar: () => ctx.recorder.foldSoFar(),
  })

  app.get('/api/doctor', { preHandler: requireCapabilityToken(ctx.capabilityToken ?? '') }, async () => {
    if (ctx.repoPath !== proberRepoPath) {
      proberRepoPath = ctx.repoPath
      probe = createRouteDoctorProbe(proberRepoPath, {
        replay: ctx.readOnly === true,
        foldSoFar: () => ctx.recorder.foldSoFar(),
      })
    }
    return probe()
  })
}
