import { homedir } from 'node:os'
import path from 'node:path'
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
import {
  type MigrationOutcome,
  MigrationSourceNotFoundError,
  MigrationSourceNotResumableError,
  planMigration,
  runMigration,
  SessionUnknownError,
} from '../concierge/migrate.js'
import {
  applyEnlistment,
  EnlistmentRefusedError,
  EnlistmentStaleError,
  EnlistmentUnknownHarnessError,
  isKnownHarness,
  planEnlistment,
  type EnlistContext,
} from '../concierge/enlist.js'
import type { EnlistmentPlan, HarnessEnlistContext, HarnessId } from '../concierge/harness/types.js'
import { CloneFenceError, MigrationFenceError } from '../concierge/paths.js'
import { type DiscoverReposResult, discoverRepos } from '../concierge/repos.js'
import { defaultClaudeProjectsRoot } from '../log/paths.js'
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
export { MigrationFenceError, MigrationSourceNotFoundError, MigrationSourceNotResumableError, SessionUnknownError }

/**
 * The one thing this route can answer with when it should not run
 * `discoverRepos` at all — see `registerConciergeReposRoute`'s own doc for
 * when that is. Shaped like `KnownProjectsResult`'s own `available` field
 * (an established idiom in this module's family of types) but at the OUTER
 * level: `available: true` carries the real `known`/`scanned` payload,
 * `available: false` means discovery never ran, with a reason.
 *
 * Each resolved `known` entry carries `repoRoot` — the nearest `.git`
 * ancestor-or-self, or `null` for a path inside no repo. The split of labour
 * that field encodes: CLASSIFICATION is the server's (it has the filesystem),
 * PRESENTATION is the picker's (it decides that a `null` becomes a counted
 * "not offered" line and a subdir folds onto its repo). The field is additive
 * and optional on the wire, so an older client ignores it and an older
 * server's absence of it reads as the pre-classification behaviour.
 */
export type ConciergeReposResponse = ({ available: true } & DiscoverReposResult) | { available: false; reason: string }

/**
 * `GET /api/concierge/repos` — prd-20 ruling 5's read-only repo picker feed:
 * the repos the user's own Claude already knows (`~/.claude/projects`,
 * slug reversed honestly) plus a shallow, bounded scan of common roots. No
 * body, and gated (prd-29 ruling 7 / #58): carries `requireCapabilityToken`
 * as a route-local `preHandler`, the read-only half of the fourth hand,
 * the same posture as `GET /api/lanes`.
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
  app.get(
    '/api/concierge/repos',
    { preHandler: requireCapabilityToken(ctx.capabilityToken ?? '') },
    async (): Promise<ConciergeReposResponse> => {
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
    },
  )
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
 * `runLaunch`'s outcome rides in the 200 body rather than the status line, the
 * same split clone.ts makes for `runClone`'s own terminal event: planning
 * failures are HTTP-shaped, runtime ones are IN the response. Ruling 3 means a
 * 200 here is never a claim that telemetry is flowing — only that planning
 * succeeded and the OS was asked to start the process.
 *
 * **Four outcomes since #532, not two, and one of them is the point.** The
 * live wave-8 proof caught this route answering `{kind:'launched', pid}` for a
 * conductor that had already exited — a detached, TTY-less `claude --resume`
 * exits immediately, and the spawn's own success said nothing about it. So the
 * body now carries WHERE the process went (`via: 'tmux'` with the window to
 * attach to, or `via: 'detached'`) and, when the detached child was gone again
 * within `runLaunch`'s settle window, `kind: 'died'` with the reason — never
 * `launched` over a corpse. This route's contribution to that is the clock
 * itself ({@link waitForMs}), which the concierge may not own.
 *
 * `ctx.port` is required for this one route: it is what
 * tells the harness where to export TO, and a server booted without it (never
 * true for `cli/run.ts`/`cli/replay.ts`, only possible for a test ctx built by
 * hand) gets an honest 500 rather than a harness launched pointed at nowhere.
 *
 * **`mode: 'resume'` runs a migration first** — prd-20 ruling 6 / ADR-0020,
 * wired for real (#519). `claude --resume <id>` reads only the slug directory
 * of its own cwd, so a conversation that began in another checkout or on
 * another machine has to be brought home before the resume can mean anything
 * (`research/2026-08-14-cross-host-resume.md`, Q1's control). The order is
 * plan-migrate → run-migrate → `planLaunch` → `runLaunch`, and the split is the
 * same one clone and launch already make: `planMigration`'s failures are
 * HTTP-shaped, its runtime failure rides the 200 body as
 * `migration: {kind: 'copy-failed'}`.
 *
 * Four statuses `planMigration` adds, each distinguishable because the module
 * gives each its own class rather than one error with different prose:
 *
 * - **400** — {@link MigrationSourceNotResumableError}: the transcript is
 *   there and holds no conversation turn. Named as itself rather than folded
 *   into the 404s, because the spike found `--resume` gives a metadata-only
 *   stub the same "No conversation found" a MISSING file gets, so this is the
 *   one failure the operator could not otherwise tell apart.
 * - **403** — `MigrationFenceError`: the copy would breach ADR-0020's grant.
 *   The same status the clone fence gets, for the same kind of refusal.
 * - **404** — {@link SessionUnknownError} or
 *   {@link MigrationSourceNotFoundError}: the id is not one this event log
 *   knows, or its transcript is not on disk. Both are "what you named is not
 *   here", which is the cue a client needs to fall back to offering a command
 *   line instead of a button.
 * - **200 with `migration.kind === 'copy-failed'`** — the copy itself failed on
 *   the operator's own filesystem. The launch is then deliberately NOT
 *   attempted: `--resume` against a transcript that never arrived exits
 *   immediately with the same "No conversation found" error, so spawning it
 *   would be this instrument claiming an act it already knows cannot work. The
 *   body says so in `kind: 'error'`, and `migration` carries the reason.
 *
 * The response gains `migration` for every mode — `null` on `launch` and
 * `continue`, where there is nothing to migrate, for the same reason
 * `continuity` is an explicit `null` there: a fact worth a value rather than a
 * key the client has to remember to check for.
 *
 * `claudeProjectsRoot` is an option, not a `ServerContext` field, exactly as
 * `api/session-preview.ts` treats the same root: production always reads the
 * real `~/.claude/projects` and only a test ever names another, so the seam
 * lives in this route's own signature rather than widening the context every
 * other route shares.
 */
export interface ConciergeLaunchOptions {
  /** Defaults to the real `~/.claude/projects`. A test names a temp dir here so no suite ever touches the operator's own. */
  claudeProjectsRoot?: string
}

/**
 * THE LAUNCH'S CLOCK, and the reason it lives in this file rather than in the
 * module that uses it (#532).
 *
 * `runLaunch` holds its answer open for a moment after a detached spawn to see
 * whether the child is still there, because a `claude` with no TTY exits at
 * once and the route used to report `launched` over the corpse. That needs a
 * timer, and the concierge namespace law's clause 3 says nothing under
 * `concierge/` may schedule work — a law worth keeping exactly as absolute as
 * it is, since it is what makes "never launches without a human's explicit
 * command" structural rather than a promise.
 *
 * `concierge/clone.ts`'s own header already named this file as where the
 * exception belongs: "a caller wanting a hard wall-clock cap on top of that
 * can add one in `api/concierge.ts`, which this law does not fence." This is
 * that caller. It is not unref'd: the request it belongs to is in flight for
 * the duration either way, and a server that exited mid-request would abandon
 * the response, not just the timer.
 */
function waitForMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function registerConciergeLaunchRoute(
  app: FastifyInstance,
  ctx: ServerContext,
  options: ConciergeLaunchOptions = {},
): void {
  const claudeProjectsRoot = options.claudeProjectsRoot ?? defaultClaudeProjectsRoot()

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

      let body: ReturnType<typeof parseConciergeLaunchRequestBody>
      let plan: Awaited<ReturnType<typeof planLaunch>>
      // `null` means "nothing to migrate" — every mode but `resume`.
      //
      // The migration runs BEFORE `planLaunch`, which has one visible cost
      // worth naming rather than discovering: a launch refused at 409 (a
      // harness with no resume-by-id story) leaves the copy behind, and the
      // error body has no `migration` field to mention it in. That is one
      // duplicate transcript under `~/.claude` — create-only, never a
      // clobber, and retryable: the next attempt reports `already-present`
      // and proceeds. ADR-0020's Consequences already accept a duplicate as
      // the price of the rollback, and nothing prunes it because a delete is
      // not in this grant.
      let migration: MigrationOutcome | null = null
      try {
        body = parseConciergeLaunchRequestBody(request.body)
        if (body.mode === 'resume') {
          migration = await runMigration(
            await planMigration(body.sessionId as string, {
              events: ctx.recorder.eventsSoFar(),
              claudeProjectsRoot,
              watchedRepoPath: ctx.repoPath,
            }),
          )
        }
        plan = await planLaunch(
          body.harness,
          body.mode,
          { watchedRepoPath: ctx.repoPath, port: ctx.port, instance: ctx.recorder.sessionId },
          body.sessionId,
        )
      } catch (err) {
        if (err instanceof ConciergeLaunchValidationError) return reply.code(400).send({ error: err.message })
        if (err instanceof MigrationSourceNotResumableError) return reply.code(400).send({ error: err.message })
        if (err instanceof MigrationFenceError) return reply.code(403).send({ error: err.message })
        if (err instanceof SessionUnknownError || err instanceof MigrationSourceNotFoundError) {
          return reply.code(404).send({ error: err.message })
        }
        if (err instanceof HarnessNotAvailableError || err instanceof LaunchContinuityUnavailableError) {
          return reply.code(409).send({ error: err.message })
        }
        throw err
      }

      // The transcript never arrived, so there is nothing for `--resume` to
      // find — see this route's own doc for why that is reported rather than
      // spawned. `runLaunch` is not called at all: no process, no pid.
      const outcome =
        migration?.kind === 'copy-failed'
          ? {
              kind: 'error' as const,
              message:
                `not launched: the transcript for session ${JSON.stringify(body.sessionId)} did not reach this ` +
                `repo's harness state directory, so \`resume\` would find nothing — ${migration.message}`,
            }
          : await runLaunch(plan, { wait: waitForMs })

      return reply.code(200).send({
        harness: body.harness,
        mode: body.mode,
        telemetry: plan.telemetry,
        // Explicit `null`, not an omitted key: `mode: 'launch'` has no
        // continuity to report, and that is a fact worth a value rather than
        // a key a caller has to remember to check for.
        continuity: plan.continuity ?? null,
        // The same posture for the migration: `null` on every mode but
        // `resume`, never an absent key.
        migration,
        ...outcome,
      })
    },
  )
}

/**
 * `POST /api/concierge/enlist` — prd-57 ruling 4 / ADR-0053's THIRD power:
 * enlist or unenlist a detected harness's user-level configuration.
 *
 * ## The two-step is the ROUTE, not a client convention
 *
 * Ruling 4 says *diff first, then write*, and this makes that unskippable
 * rather than polite. `apply: false` — the default — reads the file and returns
 * the exact diff, writing nothing. `apply: true` **requires** `sourceDigest`,
 * the value the diff came back with, and the hand refuses if the file has moved
 * since.
 *
 * A caller cannot reach the write without having asked for the diff, because
 * the digest exists nowhere else. That is prd-14 ruling 4's confirmation bar
 * expressed as a protocol rather than as a button: the SERVER holds the
 * invariant, so a client that forgets to confirm gets a 409 instead of an
 * unreviewed write to somebody's home directory.
 *
 * ## Why the statuses are what they are
 *
 * - **400** — a malformed body, or a harness name this registry has never heard
 *   of. The caller fixes both by sending something different.
 * - **409** — a real harness that cannot be enlisted (codex: implemented, and
 *   no captured config file), a plan that cannot proceed, a stale digest, or a
 *   replay server. No different request fixes these; the state has to change.
 *   The same posture `/api/concierge/clone` takes.
 * - **200 with `kind: 'already-settled'`** — idempotence is a SUCCESS. Asking
 *   to enlist an enlisted machine is the normal outcome of running it twice,
 *   and a 409 there would make every caller special-case it.
 *
 * Never hijacks the reply. This is a read, a copy and a write of one small
 * file; it settles in milliseconds, so there is no progress to stream and the
 * whole thing is one JSON response — unlike `clone`.
 */
export class ConciergeEnlistValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConciergeEnlistValidationError'
  }
}

interface EnlistRequestBody {
  readonly harness: HarnessId
  readonly intent: 'enlist' | 'unenlist'
  readonly apply: boolean
  readonly sourceDigest: string | null
}

/**
 * Parsed by hand and refused loudly, the shape `parseCloneRequestBody` uses.
 *
 * The clause worth reading is the last: `apply: true` with no digest is a
 * caller trying to skip the diff, and it is refused as a validation error
 * rather than quietly treated as a fresh plan-and-write.
 */
export function parseEnlistRequestBody(body: unknown): EnlistRequestBody {
  if (typeof body !== 'object' || body === null) {
    throw new ConciergeEnlistValidationError('request body must be a JSON object')
  }
  const raw = body as Record<string, unknown>

  const harness = raw.harness
  if (typeof harness !== 'string' || harness.length === 0) {
    throw new ConciergeEnlistValidationError('"harness" must be a non-empty string')
  }

  const intent = raw.intent ?? 'enlist'
  if (intent !== 'enlist' && intent !== 'unenlist') {
    throw new ConciergeEnlistValidationError('"intent" must be "enlist" or "unenlist"')
  }

  const apply = raw.apply ?? false
  if (typeof apply !== 'boolean') throw new ConciergeEnlistValidationError('"apply" must be a boolean')

  const sourceDigest = raw.sourceDigest ?? null
  if (sourceDigest !== null && typeof sourceDigest !== 'string') {
    throw new ConciergeEnlistValidationError('"sourceDigest" must be the string the diff returned, or absent')
  }
  if (apply && sourceDigest === null) {
    throw new ConciergeEnlistValidationError(
      '"apply" requires the "sourceDigest" the diff returned. Ruling 4 is diff-first: read the diff, then send it ' +
        'back with the digest it carried — a write this hand cannot tie to a diff somebody saw is a write nobody approved',
    )
  }

  return { harness: harness as HarnessId, intent, apply, sourceDigest }
}

/** The plan flattened for the wire — every arm, so a caller never guesses which keys exist. */
function describeEnlistmentPlan(plan: EnlistmentPlan): Record<string, unknown> {
  if (plan.kind === 'ready') {
    return {
      kind: plan.kind,
      changes: plan.changes,
      refusals: plan.refusals,
      next: plan.next,
      sourceDigest: plan.sourceDigest,
    }
  }
  // `refusals` rides on this arm too — see the type's own note (review of #573, N1).
  if (plan.kind === 'already-settled') return { kind: plan.kind, why: plan.why, refusals: plan.refusals }
  return { kind: plan.kind, why: plan.reason, remedy: plan.remedy }
}

export function registerConciergeEnlistRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.post(
    '/api/concierge/enlist',
    { preHandler: requireCapabilityToken(ctx.capabilityToken ?? '') },
    async (request: FastifyRequest, reply) => {
      if (ctx.readOnly === true) {
        return reply.code(409).send({
          error: 'this server is replaying a session record, not watching a repo — there is no machine to enlist',
        })
      }

      let body: EnlistRequestBody
      try {
        body = parseEnlistRequestBody(request.body)
      } catch (err) {
        if (err instanceof ConciergeEnlistValidationError) return reply.code(400).send({ error: err.message })
        throw err
      }

      // The cheapest, most actionable refusal first (review of #573, N3): an
      // unknown NAME is a 400 the caller fixes by sending a different one, and
      // it must not be masked by the runner refusal below, which is a 409 about
      // this server rather than about the request.
      if (!isKnownHarness(body.harness)) {
        return reply.code(400).send({ error: `no harness named ${body.harness} is in this registry` })
      }

      /**
       * Built before the context rather than inside a ternary, so the port
       * guard actually narrows — and so the reason for each field has somewhere
       * to live. Only an enlist needs one: an unenlist removes what enlist
       * declared and renders nothing.
       */
      let launch: HarnessEnlistContext | undefined
      if (body.intent === 'enlist') {
        if (ctx.port === undefined) {
          return reply.code(409).send({
            error:
              'this server does not know the port it is listening on, and the enlisted environment is what points a ' +
              'harness at it — there is nothing to write that would work',
          })
        }
        const runner = runnerPath()
        if (runner === null) {
          // Refused rather than written broken (review of #573, B1). A hook
          // command the shell cannot run collects nothing, is not recognised
          // as ours on the next enlist, and cannot be removed by unenlist —
          // so it would be a permanent fingerprint in the operator's home.
          return reply.code(409).send({
            error:
              'this server was not started through the installed `rhizomorph` command, so it cannot write a hook ' +
              'command that would run. Start the server through the installed CLI and enlist again — a hook ' +
              'pointing at a source file would collect nothing and could not be removed later',
          })
        }
        launch = {
                /**
                 * **The one thing a user-level enlistment cannot know, said
                 * plainly.** `envRecipe` renders a lane into
                 * `OTEL_RESOURCE_ATTRIBUTES`, and this file is read by EVERY
                 * session the operator runs — so one label is written once and
                 * every agent on the machine reports under it.
                 *
                 * The repo this server watches is the least wrong label
                 * available at write time, and it is not a guess dressed as an
                 * answer: ADR-0055 is what actually attributes, by routing each
                 * beacon line to a session by the `cwd` it carries. The env's
                 * lane is a telemetry label; the hook's `cwd` is the join.
                 *
                 * Ruling 4 asks for both `env` and `hooks`, so both are written.
                 * Whether a per-lane variable belongs in a user-level file at
                 * all is a question for prd-58, where the instrument stops
                 * watching one repo — recorded here rather than resolved by a
                 * lane this hand invented.
                 */
          lane: ctx.repoName,
          role: 'conductor',
          port: ctx.port,
          instance: ctx.recorder.sessionId,
          runnerPath: runner,
        }
      }

      const context: EnlistContext = {
        harness: body.harness,
        home: homedir(),
        watchedRepoPath: ctx.repoPath,
        launch,
      }

      let planned: Awaited<ReturnType<typeof planEnlistment>>
      try {
        planned = await planEnlistment(context, body.intent)
      } catch (err) {
        if (err instanceof EnlistmentUnknownHarnessError) return reply.code(400).send({ error: err.message })
        if (err instanceof EnlistmentRefusedError) return reply.code(409).send({ error: err.message })
        throw err
      }

      if (!body.apply) {
        // The diff, and nothing has happened. `sourceDigest` is what the caller
        // sends back in order to write, and there is no other way to obtain it.
        return reply.code(200).send({
          harness: body.harness,
          intent: body.intent,
          applied: false,
          target: planned.target,
          ...describeEnlistmentPlan(planned.plan),
        })
      }

      if (planned.plan.kind !== 'ready') {
        return reply.code(409).send({
          error: `nothing to apply: ${describeEnlistmentPlan(planned.plan).why as string}`,
          ...describeEnlistmentPlan(planned.plan),
        })
      }
      if (planned.plan.sourceDigest !== body.sourceDigest) {
        // The file moved between the diff and this call. Refused here as well
        // as in the hand: catching it at the route means the re-read below
        // never runs against bytes the caller has not seen.
        return reply.code(409).send({
          error: `${planned.target.display} changed since that diff was taken — read it again`,
          ...describeEnlistmentPlan(planned.plan),
        })
      }

      try {
        const outcome = await applyEnlistment(planned)
        return reply.code(200).send({
          harness: body.harness,
          intent: body.intent,
          applied: true,
          target: outcome.target,
          backupPath: outcome.backupPath,
          changedKeys: outcome.changedKeys,
        })
      } catch (err) {
        if (err instanceof EnlistmentStaleError || err instanceof EnlistmentRefusedError) {
          return reply.code(409).send({ error: err.message })
        }
        throw err
      }
    },
  )
}

/** What `packages/server/package.json` calls its `bin`. The one name a hook command may invoke. */
const RUNNER_BIN_NAME = 'rhizomorph'

/**
 * The installed CLI's own path, resolved at enlist time — ruling 6, and the
 * reason is a measurement rather than a preference: `npx`'s cold start would
 * eat the harness's hook timeout.
 *
 * **`null` when this process was not started through the CLI**, and that
 * refusal is the whole of the fix for the review of #573, B1.
 *
 * This returned `process.argv[1]` unconditionally. That is the installed shim
 * when the server was launched as `rhizomorph`, and it is `src/index.ts` under
 * the `tsx watch` launch this repo's own `package.json` declares as `dev`. In
 * that case the route wrote `…/src/index.ts hook` into the operator's REAL
 * settings file, and three things followed, none of them loud:
 *
 * 1. the command is not executable, so ruling 5's witness silently collects
 *    nothing;
 * 2. `isOurHookEntry` did not recognise it, so enlist stopped being idempotent
 *    and every re-enlist appended another entry to all five events;
 * 3. **unenlist could never remove it**, so the fingerprint stayed in the
 *    operator's home permanently — the reversibility promise failing in exactly
 *    the direction ruling 4 names.
 *
 * Refusing is the ADR-0010 posture: a hand that cannot write a working hook
 * command says so and writes nothing, rather than writing one that looks
 * installed and collects nothing. The route turns this into a 409 naming the
 * remedy.
 *
 * **What is NOT settled here, and is owed:** on Windows a global npm install
 * puts a `.cmd` shim on PATH while `argv[1]` is the `.mjs` inside the package,
 * and a bare `.mjs` is not a command `cmd.exe` can run. This accepts the stem
 * match either way, so a Windows enlist may still write a command that does not
 * execute. Unverified rather than handled — nobody has run an enlist on Windows,
 * and inventing the shim's path from `argv[1]` would be the guess ADR-0010
 * forbids. The macOS and Linux paths are the ones this wave can stand behind.
 */
function runnerPath(): string | null {
  const entry = process.argv[1]
  if (entry === undefined) return null
  // Extension stripped, then compared to the bin name `packages/server/package.json`
  // declares. `/usr/local/bin/rhizomorph`, `node_modules/.bin/rhizomorph`,
  // `…\npm\rhizomorph.cmd` and `bin/rhizomorph.mjs` all pass; `src/index.ts`
  // under `tsx watch` does not, and neither does anything else this process
  // might have been started from.
  return path.basename(entry).replace(/\.[^.]+$/, '') === RUNNER_BIN_NAME ? entry : null
}
