import type { Exec } from '@rhizomorph/core'
import type { FastifyInstance } from 'fastify'
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
 *   silently answering the wrong question.
 *
 * `checkEnrichmentLadder` still wants to know whether `target-path` read
 * `ok` (it feeds the ladder's git contributor) even though this route never
 * runs that check — see the synthetic entry below, and `checkEnrichmentLadder`'s
 * own doc, for why supplying the already-known-true fact directly is not the
 * same thing as duplicating the check's logic.
 */
export async function runServerDoctor(repoPath: string, options: ServerDoctorOptions = {}): Promise<DoctorCheck[]> {
  const exec = options.exec ?? realExec

  const baseChecks: DoctorCheck[] = [
    await checkNodeVersion({ nodeVersion: options.nodeVersion, rootPackageJsonPath: options.rootPackageJsonPath }),
    checkClaudeProjects(options.claudeProjectsRoot),
    await checkSessionBoundary(repoPath, options.dataRoot, options.now ?? Date.now),
    await checkOptionalTool('tmux', 'tmux', ['-V'], exec),
    await checkOptionalTool('workmux', 'workmux', ['status'], exec),
    checkTelemetryEnv(options.env ?? process.env, options.platform ?? process.platform, 'server'),
    await checkLaneManifest(repoPath),
    await checkCliVersionDrift(exec),
  ]

  // Feeds the ladder's git contributor without exposing a `target-path`
  // check the client never asked for and this route never ran — see this
  // function's own doc above.
  const impliedTargetPath: DoctorCheck = {
    id: 'target-path',
    status: 'ok',
    message: 'implied: this server is already running against this repository',
  }
  const ladder = await checkEnrichmentLadder([impliedTargetPath, ...baseChecks], repoPath)

  return [...baseChecks, ...ladder]
}

/**
 * Read-only `GET /api/doctor` (prd-19 ruling 5): no body, no token, no
 * writes — every check it calls is one of `cli/doctor.ts`'s own read-only
 * seams (filesystem facts, an injected `exec`). Serves the server-relevant
 * subset of the CLI's report for the repo/port this very server is already
 * running, so a stranger looking at `/connect` can see facts the page's own
 * GETs and stream cannot know (the slug dir, version drift, the lane
 * manifest) without needing a terminal at all.
 */
export function registerDoctorRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/doctor', async () => runServerDoctor(ctx.repoPath))
}
