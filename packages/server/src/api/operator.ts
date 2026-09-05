import {
  createEvent,
  createIdFactory,
  operatorAckPayloadSchema,
  operatorNotePayloadSchema,
  operatorVerdictPayloadSchema,
} from '@rhizomorph/core'
import type { FastifyInstance } from 'fastify'
import type { ServerContext } from '../server/context.js'
import { requireCapabilityToken } from './security.js'

/**
 * `POST /api/operator/:act` — one door, three acts (prd17 ruling 1, #219's
 * contracts made reachable). `act` is `ack`, `verdict` or `note`; each is
 * appended as the matching event, `operator.ack` / `operator.verdict` /
 * `operator.note`, with the same posture `POST /api/rotate` already holds — a
 * mutation of the instrument's OWN log, never of the watched repo, so
 * ruling 2's read-only law is untouched.
 *
 * **No approval workflow, per the PRD's own non-goal.** This route never
 * gates, queues or notifies anything — it appends the event the operator's
 * act already produced, exactly as `/api/label` writes a rename that already
 * happened. The three payload schemas (`@rhizomorph/core`'s `events/
 * operator.ts`) already carry the coordinate that makes an act reconstructible
 * — `sessionId` + `offset`, a whole line index into that session's record —
 * and this route does not compute or default either: they arrive in the
 * body, from the client that was looking at that line when the operator
 * decided. Hard-coding or defaulting `offset` here would be exactly the
 * mutation this issue's own "what mutation would this test survive" names.
 *
 * **Validated per act, not as one shared shape** (this issue's sibling
 * case): `ack`, `verdict` and `note` carry different required fields
 * (`verdict`/`text` respectively), so each is parsed against its own zod
 * schema and rejected on its own terms — a route that only checked the
 * fields the three share would accept a `verdict` post with no `verdict`
 * string.
 */
export function registerOperatorRoute(app: FastifyInstance, ctx: ServerContext): void {
  const nextId = createIdFactory('operator')

  app.post<{ Params: { act: string } }>(
    '/api/operator/:act',
    { preHandler: requireCapabilityToken(ctx.capabilityToken ?? '') },
    async (request, reply) => {
      if (ctx.readOnly === true) {
        return reply.code(409).send({
          error:
            'this server is replaying a session record, not watching a repo — there is no live recording to append an operator act to',
        })
      }

      const now = ctx.now ?? Date.now
      const { act } = request.params

      switch (act) {
        case 'ack': {
          const parsed = operatorAckPayloadSchema.safeParse(request.body)
          if (!parsed.success) {
            return reply.code(400).send({ error: 'invalid operator.ack payload', issues: parsed.error.issues })
          }
          const event = createEvent('operator.ack', parsed.data, { id: nextId(), ts: now() })
          await ctx.recorder.record(event)
          return reply.code(200).send({ event })
        }
        case 'verdict': {
          const parsed = operatorVerdictPayloadSchema.safeParse(request.body)
          if (!parsed.success) {
            return reply.code(400).send({ error: 'invalid operator.verdict payload', issues: parsed.error.issues })
          }
          const event = createEvent('operator.verdict', parsed.data, { id: nextId(), ts: now() })
          await ctx.recorder.record(event)
          return reply.code(200).send({ event })
        }
        case 'note': {
          const parsed = operatorNotePayloadSchema.safeParse(request.body)
          if (!parsed.success) {
            return reply.code(400).send({ error: 'invalid operator.note payload', issues: parsed.error.issues })
          }
          const event = createEvent('operator.note', parsed.data, { id: nextId(), ts: now() })
          await ctx.recorder.record(event)
          return reply.code(200).send({ event })
        }
        default:
          return reply.code(404).send({ error: `no such operator act "${act}" — expected one of ack, verdict, note` })
      }
    },
  )
}
