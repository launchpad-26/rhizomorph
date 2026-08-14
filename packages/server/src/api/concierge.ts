import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  CloneDestinationExistsError,
  CloneValidationError,
  parseCloneRequestBody,
  planClone,
  runClone,
} from '../concierge/clone.js'
import {
  HarnessNotAvailableError,
  LaunchContinuityUnavailableError,
  ConciergeLaunchValidationError,
  parseConciergeLaunchRequestBody,
  planLaunch,
  runLaunch,
} from '../concierge/launch.js'
import { CloneFenceError } from '../concierge/paths.js'
import { type DiscoverReposResult, discoverRepos } from '../concierge/repos.js'
import type { ServerContext } from '../server/context.js'
import { requireCapabilityToken } from './security.js'

/**
 * Re-exported so `concierge.test.ts` can assert on these without importing
 * `../concierge/*` directly — this file is the namespace law's one declared
 * importer (a TERMINUS, per ADR-0019's own Consequences: "chains stop there,
 * and what lies above it inherits its grant"), and a test file reaching
 * `concierge/clone.js` or `concierge/paths.js` on its own would be a second,
 * undeclared route in — exactly what `namespace-law.test.ts`'s clause 1 sweep
 * exists to catch (it does not exempt test files; the original `repos.test.ts`
 * comment already flags this for a type-only import of `concierge/repos.js`).
 */
export { CloneDestinationExistsError, CloneValidationError, CloneFenceError }
export { HarnessNotAvailableError, LaunchContinuityUnavailableError, ConciergeLaunchValidationError }

/**
 * The one thing this route can answer with when it should not run
 * `discoverRepos` at all — see `registerConciergeReposRoute`'s own doc for
 * when that is. Shaped like `KnownProjectsResult`'s own `available` field
 * (an established idiom in this module's family of types) but at the OUTER
 * level: `available: true` carries the real `known`/`scanned` payload,
 * `available: false` means discovery never ran, with a reason.
 */
export type ConciergeReposResponse = ({ available: true } & DiscoverReposResult) | { available: false; reason: string }

/**
 * `GET /api/concierge/repos` — prd-20 ruling 5's read-only repo picker feed:
 * the repos the user's own Claude already knows (`~/.claude/projects`,
 * slug reversed honestly) plus a shallow, bounded scan of common roots. No
 * body, no token — the read-only half of the fourth hand, the same posture
 * as `GET /api/lanes` and `GET /api/doctor`.
 *
 * `discoverRepos` reads the real machine by default; nothing here threads a
 * fixture through, because this route is the ONLY declared importer the
 * concierge namespace law allows (prd-20 ruling 1 / ADR-0019) and
 * `ServerContext` is not this fence's to extend with a test seam.
 *
 * A replay server (`ctx.readOnly`, `rhizomorph replay`) never runs the scan
 * at all — labeled not-applicable, the same posture `api/doctor.ts` takes
 * for its own replay-meaningless checks, not `api/label.ts`'s outright
 * refusal. The two sibling shapes answer different questions: `label.ts`
 * refuses because the write it was asked for has nowhere durable to land in
 * that mode — a real failure. This route asks for nothing durable; the
 * *read* would still succeed and would still be true, since discovery never
 * touches `ctx.repoPath`/`ctx.sessionDir` (the two fields replay repoints) at
 * all — it reads the REAL machine's home directory regardless. The reason to
 * skip it anyway is what it would mean, not whether it would work: replaying
 * a finished, possibly-shared session record is not "set up a new
 * conductor" — the setup wizard this feeds is not shown during a replay —
 * and a replay server quietly fingerprinting whoever's machine happens to be
 * running it, in answer to an unauthenticated GET nothing in that mode ever
 * asked for, is not this route's business to do just because it technically
 * could.
 */
export function registerConciergeReposRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/concierge/repos', async (): Promise<ConciergeReposResponse> => {
    if (ctx.readOnly === true) {
      return {
        available: false,
        reason:
          'not applicable — this server is replaying a finished session record, not watching a live repo, ' +
          'and the setup wizard this feeds is never shown during a replay',
      }
    }
    const result = await discoverRepos()
    return { available: true, ...result }
  })
}

/**
 * `POST /api/concierge/clone` — prd-20 ruling 1 / ADR-0019's second power,
 * wired for real (#262): `git clone` a URL the operator typed, into the
 * concierge's own namespace (`concierge/paths.ts#defaultClonesRoot`), never
 * inside the currently watched repo. Token-gated per ruling 2 — the ONE
 * mutating route this file adds, sitting behind `requireCapabilityToken`
 * exactly as `/api/label` does.
 *
 * `planClone` (`concierge/clone.ts`) does every check that can be answered
 * before a byte of `git` output exists — URL grammar, the namespace fence,
 * "does the destination already exist" — and maps to a precise status before
 * this route commits to anything: 400 for a malformed URL
 * ({@link CloneValidationError}), 403 for a fence refusal
 * ({@link CloneFenceError}), 409 for a destination that already exists
 * ({@link CloneDestinationExistsError}) or for a replay server (nothing live
 * to clone into, same posture as `/api/lab/launch`/`/api/label`).
 *
 * Only once planning succeeds does this hijack the reply and stream
 * `runClone`'s progress as newline-delimited JSON — the long-running half of
 * "progress surfaced to the caller" the issue asks for. Deliberately no
 * `request.raw.on('close', ...)` handler killing the child: a disconnected
 * caller must not abort a clone that might be most of the way through a large
 * repo, so `runClone` is always drained to its own natural end regardless of
 * whether the response socket is still open (`concierge/clone.ts`'s own doc
 * has the full reasoning). Writes are guarded on `writableEnded`/`destroyed`
 * so a dead socket is skipped rather than thrown on.
 */
export function registerConciergeCloneRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.post(
    '/api/concierge/clone',
    { preHandler: requireCapabilityToken(ctx.capabilityToken ?? '') },
    async (request: FastifyRequest, reply) => {
      if (ctx.readOnly === true) {
        return reply.code(409).send({
          error: 'this server is replaying a session record, not watching a repo — there is nowhere to clone into',
        })
      }

      let url: string
      try {
        url = parseCloneRequestBody(request.body).url
      } catch (err) {
        if (err instanceof CloneValidationError) return reply.code(400).send({ error: err.message })
        throw err
      }

      let plan: Awaited<ReturnType<typeof planClone>>
      try {
        plan = await planClone(url, { watchedRepoPath: ctx.repoPath })
      } catch (err) {
        if (err instanceof CloneValidationError) return reply.code(400).send({ error: err.message })
        if (err instanceof CloneFenceError) return reply.code(403).send({ error: err.message })
        if (err instanceof CloneDestinationExistsError) return reply.code(409).send({ error: err.message })
        throw err
      }

      reply.hijack()
      const res = reply.raw
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' })

      for await (const event of runClone(url, plan)) {
        if (res.writableEnded || res.destroyed) continue
        res.write(`${JSON.stringify(event)}\n`)
      }
      if (!res.writableEnded && !res.destroyed) res.end()
    },
  )
}

/**
 * `POST /api/concierge/launch` — prd-20 ruling 1 / ADR-0019's SECOND power,
 * wired for real (#264): spawn (or relaunch-with-continuity) the conductor
 * watching this server's repo, instrumented. Token-gated per ruling 2, the
 * same posture as `/api/concierge/clone`.
 *
 * Unlike clone, this never hijacks the reply: a spawn settles in milliseconds
 * (one `spawn`/`error` event), so there is no progress to stream and the
 * whole thing is one JSON response. `planLaunch` (`concierge/launch.ts`) does
 * every check answerable before a process exists and maps to a precise status
 * before this route commits to anything: 400 for a malformed body or an
 * unknown harness id ({@link ConciergeLaunchValidationError}), 409 for a real harness
 * this machine cannot launch right now or that has no continuity story
 * ({@link HarnessNotAvailableError}, {@link LaunchContinuityUnavailableError}),
 * or for a replay server (nothing live to launch into, same posture as
 * `/api/concierge/clone`/`/api/lab/launch`).
 *
 * `runLaunch`'s outcome — launched, or the spawn itself failed — rides in the
 * 200 body rather than the status line, the same split clone.ts makes for
 * `runClone`'s own terminal event: planning failures are HTTP-shaped, runtime
 * ones are IN the response. Ruling 3 means a 200 here is never a claim that
 * telemetry is flowing — only that planning succeeded and the OS was asked to
 * start the process. `ctx.port` is required for this one route: it is what
 * tells the harness where to export TO, and a server booted without it (never
 * true for `cli/run.ts`/`cli/replay.ts`, only possible for a test ctx built by
 * hand) gets an honest 500 rather than a harness launched pointed at nowhere.
 */
export function registerConciergeLaunchRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.post(
    '/api/concierge/launch',
    { preHandler: requireCapabilityToken(ctx.capabilityToken ?? '') },
    async (request: FastifyRequest, reply) => {
      if (ctx.readOnly === true) {
        return reply.code(409).send({
          error: 'this server is replaying a session record, not watching a repo — there is no conductor to launch',
        })
      }
      if (!ctx.port) {
        // Falsy, not `=== undefined`: `--port 0` ("let the OS pick a free
        // port", cli/args.ts) is a real, documented value, and `ServerContext.
        // port` (see its own doc) is the port the CLI ASKED for, not the real
        // bound one whenever the OS picked. `0` is therefore just as unknown
        // as `undefined` here — refusing both is the honest choice over
        // launching a harness wired to an endpoint nothing is listening on.
        return reply.code(500).send({
          error: 'this server has no known listening port (ServerContext.port) — cannot tell a harness where to export to',
        })
      }

      let body: { harness: string; mode: 'launch' | 'continue' }
      let plan: Awaited<ReturnType<typeof planLaunch>>
      try {
        body = parseConciergeLaunchRequestBody(request.body)
        plan = await planLaunch(body.harness, body.mode, {
          watchedRepoPath: ctx.repoPath,
          port: ctx.port,
          instance: ctx.recorder.sessionId,
        })
      } catch (err) {
        if (err instanceof ConciergeLaunchValidationError) return reply.code(400).send({ error: err.message })
        if (err instanceof HarnessNotAvailableError || err instanceof LaunchContinuityUnavailableError) {
          return reply.code(409).send({ error: err.message })
        }
        throw err
      }

      const outcome = await runLaunch(plan)
      return reply.code(200).send({
        harness: body.harness,
        mode: body.mode,
        telemetry: plan.telemetry,
        // Explicit `null`, not an omitted key: `mode: 'launch'` has no
        // continuity to report, and that is a fact worth a value rather than
        // a key a caller has to remember to check for.
        continuity: plan.continuity ?? null,
        ...outcome,
      })
    },
  )
}
