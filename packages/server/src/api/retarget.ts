import path from 'node:path'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { repoSlug, sessionDirFor, snapshotDirFor } from '../log/paths.js'
import { RESUME_WINDOW_MS } from '../log/session-log.js'
import type { Rotation } from '../recorder/index.js'
import {
  beginRetargetBoundary,
  performRetarget,
  RETARGET_OR_ROTATION_IN_FLIGHT_MESSAGE,
} from '../recorder/rotate.js'
import { canonicalizeRepoPath } from '../paths/containment.js'
import type { ServerContext } from '../server/context.js'
import { exec as realExec, withTimeout } from '../server/exec.js'
import { describeTelemetryCost, lanesAtBoundary } from '../server/retarget-cost.js'
import { validateRetargetTarget } from '../server/retarget-validation.js'
import { createFileSnapshotStore } from '../server/snapshot-store.js'
import { recordSessionBootMeta, sessionBootMetaFor } from './meta.js'
import { RETARGET_IN_FLIGHT_CODE, type RetargetRefusalCode } from './refusals.js'
import { requireCapabilityToken } from './security.js'

/**
 * `POST /api/retarget` — prd20 ruling 5's repo switch, and the route the four
 * halves below it assemble into (#389).
 *
 * > "switching the watched repo rotates the session and retargets the
 * > collectors; it never spawns a second instance."
 *
 * The ruling was settled by the spike (#265,
 * `docs/research/2026-08-10-retarget-spike.md`) in favour of rotate-and-reinit
 * in process over supervised respawn, and this handler is that ruling in one
 * readable order:
 *
 * 1. **Validate** (#386, `server/retarget-validation.ts`) — the path exists,
 *    is a git work tree, and has no live writer. All three BEFORE anything
 *    closes. A failure is a 409 and nothing has happened: the operator still
 *    has the recording they had, still holds its lock, and can carry on.
 * 2. **Suspend** (#388) — the poll loop's timer stops, so no tick describing
 *    the repo being left can start while the recorder is mid-seal.
 * 3. **Close, then open** (#385, `recorder/rotate.ts`'s `retargetSession`) —
 *    one boundary, two directories. The closed log ends as `retargeted`
 *    naming the successor's slug; the opened one names the predecessor's slug
 *    and session id.
 * 4. **Re-point** (#387) — the three repo-shaped fields on the context every
 *    route already holds, mutated in place, so `/api/meta`, `/api/sessions`,
 *    `/api/doctor` and the rest answer for the adopted repo from the very
 *    next request. `buildApp` does not copy this object, which is what makes
 *    three assignments enough.
 * 5. **Resume** (#388) — `reset()` drops every collector's warm snapshot (a
 *    new session owes a full round of discovery events), re-points the one
 *    thing the loop itself closes over, and lands persistence in the NEW
 *    session's own snapshot dir. Then the timer comes back.
 *
 * …and then it says what that cost (#391, `server/retarget-cost.ts`): the
 * telemetry instance id is the session id, so every lane launched before the
 * boundary is now refused whole, and the answer names them and the
 * `rhizomorph env` re-issue that fixes them — before the first
 * `telemetry.refused` arrives ~60 s later. The lane list is read at the top of
 * the handler, BEFORE the boundary, because afterwards the recorder's buffer
 * is the new session's and holds none of them.
 *
 * Steps 2 and 5 are `stop()`/`start()` around the seal rather than `reset()`
 * alone the way `/api/rotate` does it. A rotation stays in one repo, so a tick
 * that lands mid-boundary is merely early; a retarget changes which repo the
 * collectors read, so the same tick would describe the repo being left and
 * record it into the log of the repo being adopted. `reset()` awaits the tick
 * already in flight but deliberately never touches the timer (its own doc says
 * so), which leaves exactly that window — so this route closes it itself.
 *
 * **Token-gated** under #234's guard, per prd-20 ruling 2 — the same
 * `preHandler` `/api/label`, `/api/rotate` and both concierge powers carry. It
 * is the app's tenth mutating route and its sixth gated one
 * (`api/index.ts`'s `ROUTE_CLASSES`).
 *
 * **And the gate is not the law.** ADR-0014 grant 3 — the hand has no clock —
 * is the condition the fourth hand's amendment was granted under, and #359's
 * review found the concierge's first draft of that law quietly switched the
 * clause off for its own declared route. So `retarget-law.test.ts` judges the
 * collectors and the poll loop against the RAW import graph, with nothing
 * excluded for sitting behind a token: a token gate does not make a poll a
 * human, it only means the poll would need a token.
 */

export class RetargetRequestError extends Error {}

export interface RetargetRequestBody {
  /** The repo to adopt. Absolute, or relative to this process's cwd. */
  path: string
}

/**
 * Which of the two things this route did — prd-58 ruling 4.
 *
 * `selected` is the narrowed meaning: the target was already watched, so the
 * rendered colony moved and nothing else did. `adopted` is what the route has
 * always done, kept for a path this instrument has never seen an agent in.
 *
 * Ruling 4 says the honest long-term answer for an unwatched path is a distinct
 * act rather than a stretched retarget, and wave 0 ruled there is no pinning
 * act — the concierge clones and launches, and the colony appears when the
 * agent does. Refusing the `adopted` branch outright is therefore owed, and is
 * deliberately NOT taken here: it would remove today's only way to point the
 * instrument somewhere new before that path exists, which is a regression
 * wearing a ruling's clothes.
 */
export type RetargetMode = 'selected' | 'adopted'

export function parseRetargetRequestBody(body: unknown): RetargetRequestBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new RetargetRequestError('body must be a JSON object with a `path`, e.g. {"path":"/home/you/code/other-repo"}')
  }
  const candidate = (body as Record<string, unknown>).path
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw new RetargetRequestError('`path` is required and must be a non-empty string naming a repo on this machine')
  }
  return { path: candidate.trim() }
}

/**
 * Per-call ceiling on the one child process this route can spawn — the
 * `git rev-parse` of validation's second check. Same value and same reason as
 * the doctor route's: the caller of an HTTP request cannot Ctrl-C a wedged
 * `git` on a network filesystem, so the refusal has to be able to arrive.
 */
export const RETARGET_EXEC_TIMEOUT_MS = 5000

/**
 * The data root the adopted repo's session directory is built under, derived
 * from the one being watched now.
 *
 * `sessionDirFor` is `join(dataRoot, repoSlug(repoPath))`, so its parent IS the
 * data root — exactly, by construction, and it moves correctly with every
 * retarget because it is read off the live context each time. Preferred over
 * carrying a `dataRoot` field on `ServerContext` for the reason #387 preferred
 * a probe key over an invalidation hook: a second field to keep in sync is a
 * thing someone has to remember, and forgetting is silent.
 */
function dataRootOf(ctx: ServerContext): string {
  return path.dirname(ctx.sessionDir)
}

export function registerRetargetRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.post(
    '/api/retarget',
    { preHandler: requireCapabilityToken(ctx.capabilityToken ?? '') },
    async (request: FastifyRequest, reply) => {
      if (ctx.readOnly === true) {
        return reply.code(409).send({
          error:
            'this server is replaying a session record, not watching a repo — there is no live recording to retarget',
        })
      }

      let requested: string
      try {
        requested = parseRetargetRequestBody(request.body).path
      } catch (err) {
        if (err instanceof RetargetRequestError) return reply.code(400).send({ error: err.message })
        throw err
      }

      // ACQUIRE THE BOUNDARY FIRST (#14) — before `from`/`to` are even
      // snapshotted, before validation, before the loop is touched. Two
      // defects lived in doing this later, around the close/open alone:
      //
      // 1. A refused request that had already stopped the loop restarted it
      //    unconditionally, re-arming the timer WHILE the winner was still
      //    between its own stop() and reset() — `poll-loop.ts`'s `start()`
      //    fires a tick immediately when the timer is down, and that tick
      //    read the stale `repoPath` this closure still held, then landed in
      //    whichever session was open by the time its `recorder.record` wait
      //    ended: the NEW one. Acquiring first means a refused request never
      //    calls `stop()` at all, so there is nothing of its own to restart.
      // 2. Validation is the slow part (`RETARGET_EXEC_TIMEOUT_MS` names a
      //    real subprocess). A guard held only around the close/open leaves
      //    the whole validate-and-snapshot window unguarded: a first retarget
      //    could run start-to-finish while a second was still inside ITS OWN
      //    validation, so by the time the second reached the (old) guard the
      //    map was already empty again — it would proceed on a `from` it
      //    snapshotted before either await, now stale. Acquiring before
      //    validation closes that window: whichever request wins the
      //    synchronous acquisition below holds it for validation AND the
      //    close/open, so the other is refused immediately, before it does
      //    anything — including reading `from`.
      /**
       * SELECTION FIRST — prd-58 ruling 4, and Success 3.
       *
       * > `POST /api/retarget` keeps its name, its `gated-mutation` class and
       * > its `ROUTE_CLASSES` row, and changes meaning: it selects the rendered
       * > colony from the watched set rather than re-pointing the instrument at
       * > a path.
       *
       * A repo this instrument is ALREADY watching needs none of what follows.
       * Its collectors are running, its recorder is open and its facts are
       * already folded — so switching to it is a view change, and Success 3 is
       * *not met while switching requires a boot, or while it loses a lane's
       * history*. No boundary is taken, no session closes, no snapshot resets.
       *
       * This returns before `beginRetargetBoundary` deliberately: taking the
       * boundary is what makes a retarget expensive, and a selection that took
       * it would pay the whole cost to do nothing.
       */
      const watched = ctx.colonies?.() ?? []
      // CANONICAL on both sides. A colony's path is `canonicalize`d by the root
      // resolver and `ctx.repoPath` by the boot, while the operator types
      // whatever spelling they have — so comparing a merely-resolved request
      // against a canonical colony misses the match on any path with a symlink
      // in it, and the request falls through to the boundary-taking branch.
      // That is Success 3's own falsifier: switching would rotate the session
      // and lose the lane's history for a colony already being watched.
      const requestedPath = canonicalizeRepoPath(path.resolve(requested))
      const selected = watched.find((entry) => entry.colony.path === requestedPath)
      if (selected !== undefined && requestedPath !== canonicalizeRepoPath(path.resolve(ctx.repoPath))) {
        return reply.code(200).send({
          mode: 'selected' satisfies RetargetMode,
          colony: { id: selected.colony.id, path: selected.colony.path, pinned: selected.colony.pinned },
          sessionId: selected.recorder.sessionId,
          // Said explicitly, because the whole point of the narrowing is that
          // none of it happened: an operator reading this reply should not have
          // to infer from a missing field that nothing was rotated.
          rotated: false,
        })
      }

      const boundary = beginRetargetBoundary(ctx.recorder)
      if (boundary === null) {
        return reply.code(409).send({
          code: RETARGET_IN_FLIGHT_CODE,
          error: RETARGET_OR_ROTATION_IN_FLIGHT_MESSAGE,
        })
      }

      try {
        const from = {
          repoPath: ctx.repoPath,
          repoName: ctx.repoName,
          repoSlug: repoSlug(ctx.repoPath),
          sessionDir: ctx.sessionDir,
        }
        const repoPath = path.resolve(requested)
        const to = {
          repoPath,
          repoName: path.basename(repoPath),
          repoSlug: repoSlug(repoPath),
          sessionDir: sessionDirFor(repoPath, dataRootOf(ctx)),
        }

        // (1) VALIDATE, BEFORE ANYTHING CLOSES. The 409 path is the feature
        // (#386): it is the whole of what rotate-and-reinit has over supervised
        // respawn, whose equivalent check runs inside the image it is about to
        // destroy and whose failure is an uncatchable SIGABRT.
        //
        // "Already watching this repo" is asked first and here rather than in
        // `validateRetargetTarget`, because the session lock cannot tell it from
        // the news the module reports. Our OWN live lock sits in the target's
        // session dir in exactly this case, so the honest-looking answer would
        // be "another rhizomorph (pid <ours>) is already watching it" — true,
        // and it sends the operator hunting for the process they are talking to.
        if (path.resolve(repoPath) === path.resolve(ctx.repoPath)) {
          boundary.reject(new Error('refused: already-watching'))
          return reply.code(409).send({
            code: 'already-watching' satisfies RetargetRefusalCode,
            error:
              `this rhizomorph is already watching ${repoPath} — there is nothing to retarget; ` +
              '`rhizomorph rotate` (or the dashboard\'s "end session · start fresh") is how a new recording begins here',
          })
        }

        const validation = await validateRetargetTarget(to.repoPath, to.sessionDir, {
          exec: withTimeout(realExec, RETARGET_EXEC_TIMEOUT_MS),
          ...(ctx.now === undefined ? {} : { now: ctx.now }),
        })
        if (!validation.ok) {
          boundary.reject(new Error(`refused: ${validation.failure.reason}`))
          return reply.code(409).send({
            code: validation.failure.reason satisfies RetargetRefusalCode,
            error: validation.failure.message,
          })
        }

        // Read BEFORE the boundary, and this ordering is the whole of #391 being
        // possible: after the close the recorder's buffer is the NEW session's
        // and holds none of the lanes whose telemetry is about to be refused.
        // Answering with an empty list would be the instrument reporting a cost
        // of zero for a cost it had just imposed.
        const lanes = lanesAtBoundary(ctx.recorder.eventsSoFar())

        // (2) SUSPEND. See this module's own doc for why a retarget stops the
        // timer where a rotation does not.
        await ctx.pollLoop?.stop()

        // (3) CLOSE OVER THERE, OPEN OVER HERE. The boundary is already ours —
        // this is the raw close/open, not a second acquisition.
        let retarget: Rotation
        try {
          retarget = await performRetarget({
            oldSessionDir: from.sessionDir,
            oldRepoPath: from.repoPath,
            newSessionDir: to.sessionDir,
            newRepoPath: to.repoPath,
            newRepoName: to.repoName,
            recorder: ctx.recorder,
            ...(ctx.now === undefined ? {} : { now: ctx.now }),
          })
        } catch (err) {
          // The boundary failed partway. Bring the loop back up against
          // whatever the context still names — a suspended instrument left
          // down is a worse outcome than the one that already went wrong, and
          // it is the one nobody would notice. This is the ONLY path that
          // restarts the loop on a non-success exit, because it is the only
          // one that ever stopped it in the first place (#14 defect 1).
          ctx.pollLoop?.start()
          throw err
        }

        // (4) RE-POINT, before anything resumes. The fresh snapshot dir below is
        // read off this context, so re-pointing after the resume would land the
        // new session's snapshots in the directory of the repo just left —
        // silently, since a loop polling a real repo looks entirely healthy.
        ctx.repoPath = to.repoPath
        ctx.repoName = to.repoName
        ctx.sessionDir = to.sessionDir

        // (5) RESUME, against the adopted repo. `repoPath` is the one thing the
        // loop itself closes over (the spike's Q1 headline: no collector holds
        // it); the fresh store is the spike's gap (b), so snapshots stop landing
        // in a session directory nobody resuming this one will ever read.
        await ctx.pollLoop?.reset({
          repoPath: ctx.repoPath,
          snapshotStore: createFileSnapshotStore(snapshotDirFor(ctx.sessionDir, retarget.opened.sessionId)),
        })
        ctx.pollLoop?.start()

        // RELEASE THE BOUNDARY — here, not at the end of the close/open. The
        // poll loop is ONE object shared by every request, so the guard has to
        // cover every moment this route is still driving it, not just the
        // seal. Releasing it above (right after `performRetarget`) left the
        // `await reset()` on the far side of the release: a second retarget
        // could acquire the boundary in that window, `stop()` the shared loop,
        // and interleave its own stop/reset pair with this request's still-
        // pending `start()` — defect 1's exact shape (a `start()` re-arming
        // the timer while another boundary is mid-flight, and `poll-loop.ts`'s
        // `start()` fires a tick immediately when the timer is down), moved
        // off the refusal path and onto the winner's own tail. Held until the
        // loop is back up, that window does not exist.
        boundary.resolve(retarget)

        // The new session's boot facts, replacing the closed session's — the same
        // move `/api/rotate` makes, with the one word that must differ. Recording
        // this as `rotated` would tell the provenance bar the predecessor is the
        // previous log in this repo's replay picker, and it is not: it is under
        // the old repo's slug, which is precisely what `retargeted` says instead.
        recordSessionBootMeta(ctx.recorder, {
          resumedCount: 0,
          resumeWindowMs: sessionBootMetaFor(ctx.recorder)?.resumeWindowMs ?? RESUME_WINDOW_MS,
          lastBootReason: 'retargeted',
        })

        // What it cost, in the answer to the act that caused it (#391). The
        // instance id is the session id, so a retarget changes it under any
        // design — the spike measured that respawn pays it identically. What is
        // available is saying so before the first `telemetry.refused` says it,
        // ~60 s later and once for the whole swarm rather than once per lane.
        const telemetry = describeTelemetryCost({
          lanes,
          previousInstance: retarget.closed.sessionId,
          instance: retarget.opened.sessionId,
          ...(ctx.port === undefined ? {} : { port: ctx.port }),
        })

        return { closed: retarget.closed, opened: retarget.opened, from, to, telemetry }
      } catch (err) {
        // Safety net: release the boundary on ANY throw between acquiring it
        // above and one of the explicit settlements above catching it first —
        // a leaked slot would refuse every retarget and rotation on this
        // recorder forever. Idempotent against a settlement that already ran
        // (a native promise's second resolve/reject is a no-op).
        boundary.reject(err)
        throw err
      }
    },
  )
}
