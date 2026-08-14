import type { FastifyInstance } from 'fastify'
import { snapshotDirFor } from '../log/paths.js'
import { RESUME_WINDOW_MS } from '../log/session-log.js'
import { rotateSession } from '../recorder/index.js'
import type { ServerContext } from '../server/context.js'
import { createFileSnapshotStore } from '../server/snapshot-store.js'
import { recordSessionBootMeta, sessionBootMetaFor } from './meta.js'
import { requireCapabilityToken } from './security.js'

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
 *
 * **Token-gated since #234.** The app-wide guard (`server/mutation-guard.ts`)
 * refuses a cross-origin `Origin` but deliberately permits a request carrying
 * none at all, which is every non-browser caller — so before #234 a bare
 * `curl` from any local process could end the operator's recording. This route
 * now carries the same `preHandler` `/api/label` has carried since the
 * 2026-08-06 audit: the per-process capability token (`api/security.ts`),
 * delivered in-band through the served page (ADR-0012). Both of its callers
 * were widened in the same commit rather than left to a follow-up — the
 * dashboard's button reads the token off the page it was served from
 * (`packages/web/src/replay/rotate.ts`) and `rhizomorph rotate`, a separate
 * process, reads it from the same page over its own loopback `GET /`
 * (`cli/rotate.ts`). Gating the route without them is exactly how #249
 * happened.
 */
export function registerRotateRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.post('/api/rotate', { preHandler: requireCapabilityToken(ctx.capabilityToken ?? '') }, async (_request, reply) => {
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

    // The session boundary just moved — every collector's warm snapshot must
    // reset (prd20 retarget spike, gap a): a collector only emits its
    // `*.discovered` event on a snapshot MISS, so leaving them warm across a
    // rotation means the new log opens with no `worktree.discovered`/
    // `pane.discovered`/`agent.status` for anything that already existed —
    // not self-contained, contrary to prd16 ruling 3's law. The fresh store
    // also re-points persistence at the NEW session's own snapshot dir (gap
    // b): left alone, the poll loop keeps writing into the session that just
    // closed, which nobody resuming the new one will ever look in again.
    await ctx.pollLoop?.reset({
      snapshotStore: createFileSnapshotStore(snapshotDirFor(ctx.sessionDir, rotation.opened.sessionId)),
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
