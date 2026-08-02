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
 * SSE stream: replays the session so far, then live-tails. Fastify's own
 * reply lifecycle is bypassed via `hijack()` since the response body is an
 * indefinitely-open stream, not one payload.
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

    for (const event of ctx.recorder.eventsSoFar()) {
      writeEvent(res, event)
    }

    const unsubscribe = ctx.recorder.subscribe((event) => writeEvent(res, event))
    request.raw.on('close', unsubscribe)
  })
}
