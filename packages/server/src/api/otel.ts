import { createEvent, createIdFactory } from '@rhizomorph/core'
import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify'
import { parseMetricsExport, validateLogsExport } from '../collectors/otel/index.js'
import type { ServerContext } from '../server/context.js'

/**
 * OTLP/HTTP JSON receiver — prd1's authority collector. Lanes are dispatched
 * with `OTEL_RESOURCE_ATTRIBUTES=lane=<handle>,role=<role>,instance=<id>`; this
 * accepts their export requests without ever taking the server down, and
 * refuses everyone else's. Registered in its own encapsulated context so
 * `setErrorHandler` (the net for genuinely invalid JSON, which Fastify rejects
 * before our handlers run) only covers these two routes.
 *
 * **Instance identity (prd2 wave B, #60).** The live baseline found another
 * repo's lanes inside this repo's dashboard: the receiver took any POST from
 * anyone, and `.workmux.yaml` hard-coded the default port, so whichever
 * Rhizomorph was listening swallowed every repo's exports. The operator's
 * ruling is one repo, one Rhizomorph — a foreign post is a misconfiguration,
 * surfaced as a setup gap, never silently merged and never silently dropped.
 *
 * So every accepted export must declare our instance id in its resource
 * attributes, and the instance id is the *session* id (`recorder.sessionId`):
 * minted when the session starts, persisted with it, and carried across a
 * restart by the resumed run (#58) — which is exactly the lifetime a lane's env
 * block needs. It is already published on `/api/meta`, where
 * `rhizomorph env <lane>` reads it.
 */
export function registerOtelRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  options: OtelRouteOptions = {},
): void {
  const nextId = createIdFactory('otel')
  const now = options.now ?? Date.now
  const refusals = createRefusalThrottle(now)

  app.register(async (instance) => {
    instance.setErrorHandler<FastifyError>(async (error, _request, reply) => {
      await ctx.recorder.record(
        createEvent(
          'collector.error',
          { collector: 'otel', message: 'malformed OTLP request body', detail: error.message },
          { id: nextId(), ts: now() },
        ),
      )
      await reply.code(400).send({ error: 'malformed OTLP request body' })
    })

    /**
     * Records the refusal (at most once per offender per minute) and answers
     * 403. Returns the reply so a route can `return refuse(...)`.
     */
    const refuse = async (reply: FastifyReply, declared: string | null) => {
      const expectedInstance = ctx.recorder.sessionId
      const count = refusals.register(declared)
      if (count !== null) {
        await ctx.recorder.record(
          createEvent(
            'telemetry.refused',
            { instance: declared, expectedInstance, count },
            { id: nextId(), ts: now() },
          ),
        )
      }
      return reply.code(403).send({ error: refusalMessage(declared, expectedInstance) })
    }

    instance.post('/v1/metrics', async (request, reply) => {
      // Parse first: `parseMetricsExport` is pure, and a malformed body is a
      // 400 whoever sent it — refusing it as foreign would report the wrong
      // fault. Nothing is recorded until identity checks out, so a refused
      // post contributes no events at all, not even its datapoint errors.
      const result = parseMetricsExport(request.body, {
        emit: (type, payload, source) => createEvent(type, payload, { id: nextId(), ts: now(), source }),
      })
      if (result.malformed) {
        for (const event of result.events) {
          await ctx.recorder.record(event)
        }
        return reply.code(400).send({ error: 'malformed OTLP metrics export request' })
      }

      const declared = foreignInstance(request.body, ctx.recorder.sessionId)
      if (declared !== ACCEPTED) return await refuse(reply, declared)

      for (const event of result.events) {
        await ctx.recorder.record(event)
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
            { id: nextId(), ts: now() },
          ),
        )
        return reply.code(400).send({ error: 'malformed OTLP logs export request' })
      }

      // Logs carry the same resource attributes as metrics, so a foreign
      // exporter is refused here too — otherwise the misconfiguration only
      // half-shows, and the 403 the exporter needs to see never arrives.
      const declared = foreignInstance(request.body, ctx.recorder.sessionId)
      if (declared !== ACCEPTED) return await refuse(reply, declared)

      // Log records themselves are the sessionlog collector's territory; this
      // route's whole job is accepting the exporter's traffic without a crash.
      return reply.code(200).send({})
    })
  })
}

export interface OtelRouteOptions {
  /** Injectable clock, so the refusal throttle is testable without fake timers. */
  now?: () => number
}

/** The resource attribute an accepted export declares. See `cli/telemetry-env.ts`. */
export const INSTANCE_ATTRIBUTE = 'instance'

/**
 * How long one offender's refusals collapse into a single recorded event. A
 * misconfigured exporter posts every few seconds and will keep doing so until a
 * human fixes it; that is one standing fault, not hundreds of events.
 */
export const REFUSAL_THROTTLE_MS = 60_000

/** `foreignInstance`'s "this post is ours" answer — distinct from a declared `null`. */
const ACCEPTED = Symbol('accepted')

/**
 * The instance id an export declares that is *not* ours — `null` when it
 * declared none at all — or {@link ACCEPTED} when every resource block in the
 * body carries our id.
 *
 * All-or-nothing on purpose: a body mixing our instance with someone else's is
 * refused whole. Splitting it would be exactly the silent merge prd2 forbids.
 * A body with no resource blocks declares no identity either, so it is refused
 * as `null` rather than quietly answered 200.
 */
function foreignInstance(body: unknown, expected: string): string | null | typeof ACCEPTED {
  const declared = declaredInstances(body)
  if (declared.length === 0) return null
  for (const value of declared) {
    if (value !== expected) return value
  }
  return ACCEPTED
}

/**
 * The `instance` resource attribute of every resource block in an OTLP body,
 * metrics or logs — `null` for a block that declares none.
 *
 * Deliberately reads the raw body rather than a parsed OTLP shape: the logs
 * route models its resource blocks as `unknown` (prd1 never needed to look
 * inside them), and an identity check that only worked on the shapes we happen
 * to parse would be no check at all.
 */
function declaredInstances(body: unknown): Array<string | null> {
  if (!isRecord(body)) return []
  const blocks: unknown[] = []
  for (const key of ['resourceMetrics', 'resourceLogs'] as const) {
    const value = body[key]
    if (Array.isArray(value)) blocks.push(...value)
  }
  return blocks.map(blockInstance)
}

function blockInstance(block: unknown): string | null {
  const resource = isRecord(block) ? block.resource : undefined
  const attributes = isRecord(resource) ? resource.attributes : undefined
  if (!Array.isArray(attributes)) return null
  for (const attribute of attributes) {
    if (!isRecord(attribute) || attribute.key !== INSTANCE_ATTRIBUTE) continue
    const value = isRecord(attribute.value) ? attribute.value.stringValue : undefined
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function refusalMessage(declared: string | null, expected: string): string {
  const who = declared === null ? 'declared no instance' : `declared instance "${declared}"`
  return `refused: this Rhizomorph is instance ${expected}, and this export ${who} — one repo, one Rhizomorph. Re-generate the lane's env with \`rhizomorph env <lane> --port <port>\` against the server you meant to export to.`
}

interface RefusalThrottle {
  /**
   * Registers one refusal. Returns the count to record — every refusal from
   * this offender since the last recorded one, this one included — or `null`
   * when this offender already had an event within the window.
   */
  register(instance: string | null): number | null
}

/**
 * One entry per distinct offender (a fleet has as many offenders as it has
 * misconfigured instances, so this stays small), keyed by declared id with `''`
 * standing for "declared none" — safe, because a real instance id is a
 * non-empty string.
 */
function createRefusalThrottle(now: () => number): RefusalThrottle {
  const offenders = new Map<string, { lastRecordedAt: number; suppressed: number }>()

  return {
    register(instance) {
      const key = instance ?? ''
      const at = now()
      const entry = offenders.get(key)
      if (entry === undefined) {
        offenders.set(key, { lastRecordedAt: at, suppressed: 0 })
        return 1
      }
      if (at - entry.lastRecordedAt < REFUSAL_THROTTLE_MS) {
        entry.suppressed += 1
        return null
      }
      offenders.set(key, { lastRecordedAt: at, suppressed: 0 })
      return entry.suppressed + 1
    },
  }
}
