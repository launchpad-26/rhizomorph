import type { ServerResponse } from 'node:http'
import type { RhizomorphEvent } from '@rhizomorph/core'
import type { FastifyInstance } from 'fastify'
import type { ServerContext } from '../server/context.js'

function writeEvent(res: ServerResponse, event: RhizomorphEvent): void {
  res.write(`id: ${event.id}\n`)
  res.write(`event: ${event.type}\n`)
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

/**
 * What a connecting client should be sent as backlog (#166).
 *
 * Every event this route writes carries an `id:` field, which is the SSE spec's
 * own resume contract: a browser `EventSource` remembers the last id it
 * received and, on any reconnect — including the one a suspended-then-resumed
 * tab performs automatically — resends it as the `Last-Event-ID` header with no
 * application code involved on either end.
 *
 * A client with no id (a fresh tab, or anything that predates this) gets the
 * full session, exactly as before. A client whose id this session's buffer
 * still holds gets only what it hasn't seen — one linear scan per *reconnect*,
 * not per event, so this doesn't reintroduce the cost this route exists to
 * avoid. A client whose id the buffer has never held (a different session, or
 * one that has since been evicted) falls back to the full replay rather than
 * silently resuming from the wrong place — the instrument would rather be slow
 * once than wrong.
 */
export function resumeBacklog(
  events: readonly RhizomorphEvent[],
  lastEventId: string | undefined,
): readonly RhizomorphEvent[] {
  if (lastEventId === undefined) return events
  const index = events.findIndex((event) => event.id === lastEventId)
  if (index === -1) return events
  return events.slice(index + 1)
}

/**
 * SSE stream: replays the session so far (or, for a client resuming with a
 * known `Last-Event-ID`, only what it missed — see {@link resumeBacklog}),
 * then live-tails. Fastify's own reply lifecycle is bypassed via `hijack()`
 * since the response body is an indefinitely-open stream, not one payload.
 */
export function registerStreamRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/stream', async (request, reply) => {
    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })

    const lastEventIdHeader = request.headers['last-event-id']
    const lastEventId = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader
    const backlog = resumeBacklog(ctx.recorder.eventsSoFar(), lastEventId)
    for (const event of backlog) {
      writeEvent(res, event)
    }

    const unsubscribe = ctx.recorder.subscribe((event) => writeEvent(res, event))
    request.raw.on('close', unsubscribe)
  })
}
