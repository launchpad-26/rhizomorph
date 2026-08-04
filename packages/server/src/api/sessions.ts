import type { FastifyInstance } from 'fastify'
import { listSessionListings } from '../log/listing.js'
import { listSessions, readSessionEvents, sessionFilePath } from '../log/session-log.js'
import type { ServerContext } from '../server/context.js'

export function registerSessionsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  // Full parse per session, not a bounded head/tail sample — see
  // `listSessionListings`'s own doc comment for why: this fetches once per
  // replay-picker mount rather than on a poll, and a lane's landing can land
  // anywhere in a long session's timeline, which a head/tail sample would
  // silently miss.
  app.get('/api/sessions', async () => {
    const sessions = await listSessionListings(ctx.sessionDir, {
      liveSessionId: ctx.recorder.sessionId,
      liveEvents: ctx.recorder.eventsSoFar(),
    })
    return { sessions }
  })

  app.get<{ Params: { id: string } }>('/api/sessions/:id/events', async (request, reply) => {
    const { id } = request.params

    // The live session's events are read straight from the recorder's buffer
    // rather than the file, so a request can never race the writer's append.
    if (id === ctx.recorder.sessionId) {
      return { events: ctx.recorder.eventsSoFar() }
    }

    const events = await readSessionEvents(sessionFilePath(ctx.sessionDir, id))
    if (events.length === 0) {
      const sessions = await listSessions(ctx.sessionDir)
      if (!sessions.some((s) => s.id === id)) {
        return reply.code(404).send({ error: `no session with id "${id}"` })
      }
    }
    return { events }
  })
}
