import { createEvent, createIdFactory } from '@rhizomorph/core'
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { parseMetricsExport, parseTracesExport, validateLogsExport } from '../collectors/otel/index.js'
import type { ServerContext } from '../server/context.js'

/**
 * OTLP/HTTP JSON receiver — prd1's authority collector. Lanes are dispatched
 * with `OTEL_RESOURCE_ATTRIBUTES=lane=<handle>,role=<role>,instance=<id>`; this
 * accepts their export requests without ever taking the server down, and
 * refuses everyone else's. Registered in its own encapsulated context so
 * `setErrorHandler` (the net for genuinely invalid JSON, which Fastify rejects
 * before our handlers run) only covers these four routes.
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
  const refusals = createFaultThrottle(now)
  const collectorFaults = createFaultThrottle(now)

  app.register(async (instance) => {
    /**
     * Records a `collector.error` for a route-level fault — invalid JSON, a
     * malformed body, or an unroutable bare-path body — throttled per fault
     * signature (at most one recorded event per `message` per window) so a
     * misconfigured exporter posting the same fault every few seconds
     * collapses to one event carrying a count, not one per POST. The first
     * occurrence's payload is unchanged (`collector`, `message`, `detail`
     * verbatim) plus `count`; suppressed occurrences record nothing until the
     * window closes, same as `refuse` below.
     *
     * EVERY route sends its `collector.error` through here, on the success path
     * as well as the malformed one. Only the malformed branches did originally,
     * which was adequate while the sole route-level fault WAS a malformed body.
     * Two faults arrive on otherwise-valid posts: #323's unread-records report
     * (metrics) and the pre-existing per-span malformed case (traces,
     * `parse-traces.ts:97`).
     *
     * The verify pass on #323 measured the metrics consequence: a real claude
     * capture carries `claude_code.session.count`, so EVERY ordinary export
     * tripped it — one per 5s per this repo's own `OTEL_METRIC_EXPORT_INTERVAL`,
     * unthrottled, into the operator feed. Executed downstream: 20 posts flipped
     * `collectors.otel` to `error`; 205 reached `MAX_ERRORS` and began evicting
     * real faults.
     *
     * The traces case was already present and no review seat reported it.
     * Fixing metrics alone would have been a fix that handles the case its
     * author considered and misses the structurally identical sibling one screen
     * down — the defect shape AGENTS.md names first.
     *
     * The throttle keys on `message`, so a message must not embed a varying
     * count or each distinct count opens its own window. `parse-metrics.ts`
     * carries that constraint in its own comment.
     */
    const recordFault = async (message: string, detail?: string) => {
      const count = collectorFaults.register(message)
      if (count === null) return
      await ctx.recorder.record(
        createEvent(
          'collector.error',
          detail === undefined
            ? { collector: 'otel', message, count }
            : { collector: 'otel', message, detail, count },
          { id: nextId(), ts: now() },
        ),
      )
    }

    instance.setErrorHandler<FastifyError>(async (error, _request, reply) => {
      await recordFault('malformed OTLP request body', error.message)
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

    // Parse first: `parseMetricsExport` is pure, and a malformed body is a
    // 400 whoever sent it — refusing it as foreign would report the wrong
    // fault. Nothing is recorded until identity checks out, so a refused
    // post contributes no events at all, not even its datapoint errors.
    const handleMetrics = async (request: FastifyRequest, reply: FastifyReply) => {
      const result = parseMetricsExport(request.body, {
        emit: (type, payload, source) => createEvent(type, payload, { id: nextId(), ts: now(), source }),
      })
      if (result.malformed) {
        for (const event of result.events) {
          if (event.type === 'collector.error') {
            await recordFault(event.payload.message, event.payload.detail)
          } else {
            await ctx.recorder.record(event)
          }
        }
        return reply.code(400).send({ error: 'malformed OTLP metrics export request' })
      }

      const declared = foreignInstance(request.body, ctx.recorder.sessionId)
      if (declared !== ACCEPTED) return await refuse(reply, declared)

      for (const event of result.events) {
        if (event.type === 'collector.error') {
          await recordFault(event.payload.message, event.payload.detail)
        } else {
          await ctx.recorder.record(event)
        }
      }
      return reply.code(200).send({})
    }

    const handleLogs = async (request: FastifyRequest, reply: FastifyReply) => {
      const result = validateLogsExport(request.body)
      if (result.malformed) {
        await recordFault('malformed OTLP logs export request', result.detail)
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
    }

    const handleTraces = async (request: FastifyRequest, reply: FastifyReply) => {
      // Same parse-first, refuse-second order as metrics: a malformed body
      // is a 400 whoever sent it, so identity is only checked once the body
      // is known to be OTLP-shaped.
      const result = parseTracesExport(request.body, {
        emit: (type, payload, source) => createEvent(type, payload, { id: nextId(), ts: now(), source }),
      })
      if (result.malformed) {
        for (const event of result.events) {
          if (event.type === 'collector.error') {
            await recordFault(event.payload.message, event.payload.detail)
          } else {
            await ctx.recorder.record(event)
          }
        }
        return reply.code(400).send({ error: 'malformed OTLP traces export request' })
      }

      const declared = foreignInstance(request.body, ctx.recorder.sessionId)
      if (declared !== ACCEPTED) return await refuse(reply, declared)

      for (const event of result.events) {
        if (event.type === 'collector.error') {
          await recordFault(event.payload.message, event.payload.detail)
        } else {
          await ctx.recorder.record(event)
        }
      }
      return reply.code(200).send({})
    }

    // The three native, signal-specific routes — unconditional, and tried
    // first by any spec-compliant exporter (OTLP/HTTP appends `/v1/<signal>`
    // to the configured base endpoint itself, per the OTLP spec; this is what
    // `rhizomorph env` is built against, and claude's beta OTLP export
    // reaches these three unaided).
    instance.post('/v1/metrics', handleMetrics)
    instance.post('/v1/logs', handleLogs)
    instance.post('/v1/traces', handleTraces)

    /**
     * The **fallback** the native routes above are not: some exporters (codex,
     * per the spike, [Ran — repo capture]) post every signal to the bare
     * configured endpoint verbatim — no `/v1/<signal>` suffix appended at all
     * — because `OTEL_EXPORTER_OTLP_ENDPOINT` is exactly `http://127.0.0.1:
     * <port>` with no path (`cli/telemetry-env.ts`'s `otlpEndpoint`), and not
     * every SDK follows the spec's own append rule. ADR-0018 records why this
     * is the one route that exists to catch that, rather than a guessed
     * per-harness path.
     *
     * Body-shape routing, never a new dialect: which of `resourceMetrics` /
     * `resourceLogs` / `resourceSpans` is present decides which of the three
     * handlers above runs, unchanged — no codex-specific parsing lives here
     * or anywhere else this issue touches (that's wave 4, #322). A shape this
     * can't name (none of the three keys, or more than one at once) is
     * refused by name by {@link classifyBareBody}, not half-parsed.
     */
    instance.post('/', async (request, reply) => {
      const shape = classifyBareBody(request.body)
      switch (shape.signal) {
        case 'metrics':
          return handleMetrics(request, reply)
        case 'logs':
          return handleLogs(request, reply)
        case 'traces':
          return handleTraces(request, reply)
        case 'unrecognized': {
          await recordFault('unrecognized OTLP body at the bare endpoint', shape.detail)
          return reply.code(400).send({ error: shape.detail })
        }
      }
    })
  })
}

export interface OtelRouteOptions {
  /** Injectable clock, so the fault throttles are testable without fake timers. */
  now?: () => number
}

/** The resource attribute an accepted export declares. See `cli/telemetry-env.ts`. */
export const INSTANCE_ATTRIBUTE = 'instance'

/**
 * How long one fault collapses into a single recorded event — a repeated
 * refusal from the same offender, or a repeated `collector.error` for the
 * same route-level fault. A misconfigured exporter posts every few seconds
 * and will keep doing so until a human fixes it; that is one standing fault,
 * not hundreds of events.
 */
export const FAULT_THROTTLE_MS = 60_000

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
 * metrics, logs or traces — `null` for a block that declares none.
 *
 * Deliberately reads the raw body rather than a parsed OTLP shape: the logs
 * route models its resource blocks as `unknown` (prd1 never needed to look
 * inside them), and an identity check that only worked on the shapes we happen
 * to parse would be no check at all.
 *
 * `resourceSpans` (prd9) must be listed here or every correctly-tagged trace
 * POST is refused as foreign — the body declares no instance this check knows
 * to look for (research 2026-08-03-trace-era-captures.md "What to avoid").
 */
function declaredInstances(body: unknown): Array<string | null> {
  if (!isRecord(body)) return []
  const blocks: unknown[] = []
  for (const key of ['resourceMetrics', 'resourceLogs', 'resourceSpans'] as const) {
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

/** Which of the three native handlers a bare-path body routes to — see {@link classifyBareBody}. */
type BareBodySignal = 'metrics' | 'logs' | 'traces'

type BareBodyShape = { signal: BareBodySignal } | { signal: 'unrecognized'; detail: string }

/** The one top-level key naming each signal, in the same order the OTLP inbox has always classified them. */
const SIGNAL_KEYS = [
  ['resourceMetrics', 'metrics'],
  ['resourceLogs', 'logs'],
  ['resourceSpans', 'traces'],
] as const satisfies ReadonlyArray<readonly [string, BareBodySignal]>

/**
 * Decides which native handler a bare-path POST belongs to, from the body's
 * own shape alone — never a header, never a query param, never a per-harness
 * table. Exactly one of `resourceMetrics` / `resourceLogs` / `resourceSpans`
 * **named as a key** — present at all, whatever its value — routes to that
 * signal's handler unambiguously; zero or more than one named key is refused
 * **by name**, not guessed at — the same all-or-nothing posture
 * {@link foreignInstance} already takes for a body mixing two instances.
 *
 * Deliberately keys on presence (`!== undefined`; JSON has no `undefined`, so
 * this is unambiguous) rather than `Array.isArray`: a body naming a key with
 * the wrong-shaped value (`resourceLogs: "not-an-array"`) is a named claim
 * about which signal this is, not an absent one — routing it to the handler
 * that claim names, rather than filtering it out as if it were never there,
 * is what lets a single bad key still land as a 400 from its own native
 * schema instead of silently vanishing behind a sibling key that *is*
 * well-formed. The native handler's own schema then refuses the malformed
 * value exactly as `/v1/logs` would for the identical body — no new
 * refusal wording, no new leniency.
 */
function classifyBareBody(body: unknown): BareBodyShape {
  if (!isRecord(body)) {
    return { signal: 'unrecognized', detail: 'unrecognized OTLP body: not a JSON object' }
  }
  const present = SIGNAL_KEYS.filter(([key]) => body[key] !== undefined)
  if (present.length === 0) {
    return {
      signal: 'unrecognized',
      detail: 'unrecognized OTLP body: expected exactly one of resourceMetrics, resourceLogs, resourceSpans',
    }
  }
  if (present.length > 1) {
    return {
      signal: 'unrecognized',
      detail: `ambiguous OTLP body: carries more than one of resourceMetrics, resourceLogs, resourceSpans at once (${present.map(([key]) => key).join(', ')}) — the bare endpoint routes by shape and cannot split a body naming two`,
    }
  }
  const [, signal] = present[0] as readonly [string, BareBodySignal]
  return { signal }
}

function refusalMessage(declared: string | null, expected: string): string {
  const who = declared === null ? 'declared no instance' : `declared instance "${declared}"`
  return `refused: this Rhizomorph is instance ${expected}, and this export ${who} — one repo, one Rhizomorph. Re-generate the lane's env with \`rhizomorph env <lane> --port <port>\` against the server you meant to export to.`
}

interface FaultThrottle {
  /**
   * Registers one occurrence. Returns the count to record — every occurrence
   * of this key since the last recorded one, this one included — or `null`
   * when this key already had an event within the window.
   */
  register(key: string | null): number | null
}

/**
 * Generic over its key: `telemetry.refused` keys on the declared instance id
 * (a `null` faulter's key is `''`, safe because a real instance id is a
 * non-empty string), and `collector.error`'s route-level faults key on the
 * recorded `message` string instead — the fault, not the faulter, since a
 * malformed body declares no instance and every request here is 127.0.0.1
 * anyway (ADR-0008). Each caller gets its own instance, so the two key
 * spaces never merge into one map.
 */
function createFaultThrottle(now: () => number): FaultThrottle {
  const offenders = new Map<string, { lastRecordedAt: number; suppressed: number }>()

  return {
    register(key) {
      const mapKey = key ?? ''
      const at = now()
      const entry = offenders.get(mapKey)
      if (entry === undefined) {
        offenders.set(mapKey, { lastRecordedAt: at, suppressed: 0 })
        return 1
      }
      if (at - entry.lastRecordedAt < FAULT_THROTTLE_MS) {
        entry.suppressed += 1
        return null
      }
      offenders.set(mapKey, { lastRecordedAt: at, suppressed: 0 })
      return entry.suppressed + 1
    },
  }
}
