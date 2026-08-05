import type { FastifyInstance } from 'fastify'
import { writeSessionLabel } from '../log/label.js'
import { listSessions } from '../log/session-log.js'
import type { ServerContext } from '../server/context.js'

interface LabelRequestBody {
  sessionId?: unknown
  label?: unknown
}

/**
 * `POST /api/label` — the app's SECOND mutating route (prd16 ruling 4). The
 * recordings library's rename-in-place: writes the label sidecar
 * (`log/label.ts`) an operator already gets from `rhizomorph label`, never
 * the append-only event log itself. `GET /api/sessions` already prefers this
 * label over the auto-title (`log/listing.ts`), so this route surfaces
 * existing machinery rather than growing a new concept.
 *
 * A record being replayed (`ctx.readOnly`) refuses here for the same reason
 * `/api/rotate` does: `ctx.sessionDir` in that mode is a throwaway temp
 * directory holding one reconstructed session, not the repo's real recording
 * directory, so a label written there would look saved and vanish with the
 * process — an honest refusal beats a silent no-op.
 */
export function registerLabelRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.post<{ Body: LabelRequestBody }>('/api/label', async (request, reply) => {
    if (ctx.readOnly === true) {
      return reply.code(409).send({
        error:
          'this server is replaying a session record, not watching a directory of recordings — there is nowhere durable to save a label here',
      })
    }

    const body = request.body ?? {}
    const { sessionId, label } = body

    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return reply.code(400).send({ error: 'sessionId must be a non-empty string' })
    }
    if (typeof label !== 'string' || label.trim().length === 0) {
      return reply.code(400).send({ error: 'label must be a non-empty string' })
    }

    const sessions = await listSessions(ctx.sessionDir)
    if (!sessions.some((session) => session.id === sessionId)) {
      return reply.code(404).send({ error: `no session with id "${sessionId}"` })
    }

    const now = ctx.now ?? Date.now
    const trimmed = label.trim()
    await writeSessionLabel(ctx.sessionDir, sessionId, trimmed, now())

    return { sessionId, label: trimmed }
  })
}
