import type { FastifyInstance } from 'fastify'
import { RESUME_WINDOW_MS } from '../log/session-log.js'
import { rotateSession } from '../recorder/index.js'
import type { ServerContext } from '../server/context.js'
import { recordSessionBootMeta, sessionBootMetaFor } from './meta.js'

/**
 * `POST /api/rotate` — THE ONE MUTATING ROUTE (prd16 ruling 2).
 *
 * Everything else this server serves is a read. This route is the recorder's
 * hand exposed to the dashboard's "end session · start fresh" button and to
 * `rhizomorph rotate`: an explicit human invocation, the same logic prd12 used
 * to permit the laboratory's button, and the reason the web app's
 * mutating-calls law (`packages/web/src/replay/mutating-calls-law.test.ts`)
 * enumerates exactly one call. No background loop of the observer may reach it
 * — nothing on a timer holds a reference to `rotateSession` at all
 * (`recorder/namespace-law.test.ts`).
 *
 * The observer's read-only law over the WATCHED REPO is untouched: rotation
 * writes only inside this repo's own session directory. What changes here is
 * who decides when a recording ends, which is an existing authority made
 * operable rather than a new one.
 */
export function registerRotateRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.post('/api/rotate', async (_request, reply) => {
    if (ctx.readOnly === true) {
      return reply.code(409).send({
        error:
          'this server is replaying a session record, not watching a repo — there is no live recording to rotate',
      })
    }

    const rotation = await rotateSession({
      sessionDir: ctx.sessionDir,
      repoPath: ctx.repoPath,
      repoName: ctx.repoName,
      recorder: ctx.recorder,
      ...(ctx.now === undefined ? {} : { now: ctx.now }),
    })

    // The new session's boot facts, replacing the ones the boot recorded for
    // the session that just closed: nothing resumed it, nothing was in its
    // file when it opened, and the reason is the operator's own act — which is
    // what lets the provenance line explain a session seconds old instead of
    // implying the instrument restarted. The resume window is carried over,
    // because rotating did not change the boundary this run measures against.
    recordSessionBootMeta(ctx.recorder, {
      resumedCount: 0,
      eventCount: 0,
      resumeWindowMs: sessionBootMetaFor(ctx.recorder)?.resumeWindowMs ?? RESUME_WINDOW_MS,
      lastBootReason: 'rotated',
    })

    return { closed: rotation.closed, opened: rotation.opened }
  })
}
