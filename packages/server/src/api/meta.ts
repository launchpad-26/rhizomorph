import type { FastifyInstance } from 'fastify'
import { RESUME_WINDOW_MS, type SessionBootReason } from '../log/session-log.js'
import type { SessionRecorder } from '../server/recorder.js'
import type { ServerContext } from '../server/context.js'

/** The boot facts `/api/meta` carries in addition to `startedAt` — #181 (the web half) reads these. */
export interface SessionBootMeta {
  /** How many earlier boots already continued this exact session, before this one. */
  resumedCount: number
  /** Events already in the session file the moment this boot decided — 0 for a fresh session. */
  eventCount: number
  /** The resume window this boot's decision was measured against. */
  resumeWindowMs: number
  lastBootReason: SessionBootReason
}

/**
 * `registerMetaRoute` only ever receives a `ServerContext`, which is built
 * and typed outside this fence (`server/context.ts`, `server/build-app.ts`)
 * — so the boot facts can't travel as a new context field without touching
 * files this issue doesn't own. A `WeakMap` keyed by the recorder instance
 * already threaded through `ServerContext` carries them instead: `cli/index.ts`
 * (also in this fence) calls this once, right after `decideSessionBoot`
 * resolves, and `/api/meta` reads it back for that same recorder. No
 * `context.ts` edit, no leak (a recorder that's garbage collected drops its
 * entry with it).
 */
export function recordSessionBootMeta(recorder: SessionRecorder, meta: SessionBootMeta): void {
  bootMetaByRecorder.set(recorder, meta)
}

const bootMetaByRecorder = new WeakMap<SessionRecorder, SessionBootMeta>()

/**
 * A recorder nobody called `recordSessionBootMeta` for — `rhizomorph replay`,
 * or a test that builds a bare `SessionRecorder` — reports the honest
 * default: never resumed, nothing recorded yet, the stock window, and
 * `first-run` (the closest true statement: this process didn't make a resume
 * decision for it either).
 */
function fallbackBootMeta(recorder: SessionRecorder): SessionBootMeta {
  return {
    resumedCount: 0,
    eventCount: recorder.eventsSoFar().length,
    resumeWindowMs: RESUME_WINDOW_MS,
    lastBootReason: 'first-run',
  }
}

export function registerMetaRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/meta', async () => {
    const bootMeta = bootMetaByRecorder.get(ctx.recorder) ?? fallbackBootMeta(ctx.recorder)
    return {
      repoPath: ctx.repoPath,
      repoName: ctx.repoName,
      sessionId: ctx.recorder.sessionId,
      startedAt: Number(ctx.recorder.sessionId),
      ...bootMeta,
    }
  })
}
