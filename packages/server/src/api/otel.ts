import { createEvent, createIdFactory } from '@observatory/core'
import type { FastifyError, FastifyInstance } from 'fastify'
import { parseMetricsExport, validateLogsExport } from '../collectors/otel/index.js'
import type { ServerContext } from '../server/context.js'

/**
 * OTLP/HTTP JSON receiver — prd1's authority collector. Lanes are dispatched
 * with `OTEL_RESOURCE_ATTRIBUTES=lane=<handle>`; this just needs to accept
 * their export requests without ever taking the server down. Registered in
 * its own encapsulated context so `setErrorHandler` (the net for genuinely
 * invalid JSON, which Fastify rejects before our handlers run) only covers
 * these two routes.
 */
export function registerOtelRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const nextId = createIdFactory('otel')

  app.register(async (instance) => {
    instance.setErrorHandler<FastifyError>(async (error, _request, reply) => {
      await ctx.recorder.record(
        createEvent(
          'collector.error',
          { collector: 'otel', message: 'malformed OTLP request body', detail: error.message },
          { id: nextId(), ts: Date.now() },
        ),
      )
      await reply.code(400).send({ error: 'malformed OTLP request body' })
    })

    instance.post('/v1/metrics', async (request, reply) => {
      const result = parseMetricsExport(request.body, {
        emit: (type, payload, source) => createEvent(type, payload, { id: nextId(), ts: Date.now(), source }),
      })
      for (const event of result.events) {
        await ctx.recorder.record(event)
      }
      if (result.malformed) {
        return reply.code(400).send({ error: 'malformed OTLP metrics export request' })
      }
      return reply.code(200).send({})
    })

    instance.post('/v1/logs', async (request, reply) => {
      const result = validateLogsExport(request.body)
      if (result.malformed) {
        await ctx.recorder.record(
          createEvent(
            'collector.error',
            { collector: 'otel', message: 'malformed OTLP logs export request', detail: result.detail },
            { id: nextId(), ts: Date.now() },
          ),
        )
        return reply.code(400).send({ error: 'malformed OTLP logs export request' })
      }
      // Log records themselves are the sessionlog collector's territory; this
      // route's whole job is accepting the exporter's traffic without a crash.
      return reply.code(200).send({})
    })
  })
}
