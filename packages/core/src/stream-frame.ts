import { z } from 'zod'
import { parseEvent, type RhizomorphEvent } from './events/index.js'

/**
 * THE STREAM FRAME — prd-58 ruling 3.
 *
 * > An event says what happened; the frame says which colony it happened in.
 *
 * The colony rides here and **no event schema gains a field**, which is not a
 * stylistic preference. Two consequences hang off it, and both are load-bearing:
 *
 * 1. **There is no new era.** No event changes shape, so an old recording folds
 *    identically and `packages/core/src/eras/` gains nothing (ADR-0011).
 * 2. **A recording remains one colony's events**, so export, `mergeRecords` and
 *    the shipper are untouched. That one is not a choice at all:
 *    `docs/record-format.md` puts the repo slug inside the genesis hash and
 *    `mergeRecords` refuses across it, so a machine-wide recording cannot be
 *    expressed in this format. N repos means N recorders, period (Success 4).
 *
 * **It lives beside `events/`, not inside it.** `no-open-payload-law` forbids
 * `z.unknown()` anywhere under `events/`, and rightly: an event payload must
 * declare its keys. This is not an event payload — it is the transport around
 * one, and its `event` is deliberately unknown here because `parseEvent`
 * validates it one line later. The first draft of this file sat in `events/`
 * and that law caught it, which is the law working rather than an exception to
 * write.
 *
 * **Why the payload and not another SSE field.** A browser `EventSource`
 * exposes exactly four things — `data`, `event`, `id` and `retry`. `event` is
 * the event type, `id` is the resume contract the reconnect path depends on,
 * and a custom field name is simply invisible to the client. So the colony has
 * to travel inside `data`, which makes `data` an envelope.
 */
export const streamFrameSchema = z.object({
  /** The colony this event happened in — `repoSlug(repoPath)`, the recorder's own slug. */
  colony: z.string().min(1),
  event: z.unknown(),
})

export interface StreamFrame {
  readonly colony: string | null
  readonly event: RhizomorphEvent
}

/**
 * Read a frame's `data` payload, accepting **both** shapes.
 *
 * A bare event is what every server before this wave wrote, and it still folds
 * — with `colony: null`, which the caller reads as "the one colony I am
 * watching". That leniency is ADR-0011's posture applied to the transport
 * rather than to the record, and it is what lets this wave land without #614's
 * version handshake three waves early.
 *
 * `undefined` for anything that is neither, which is the same answer the client
 * already gives an unparseable frame: a frame that cannot be read reaches
 * nothing, and inventing a colony for it would be the exact guess this PRD's
 * join spent six review rounds learning not to make.
 */
export function parseStreamFrame(payload: unknown): StreamFrame | undefined {
  const enveloped = streamFrameSchema.safeParse(payload)
  if (enveloped.success) {
    const inner = parseEvent(enveloped.data.event)
    return inner.ok ? { colony: enveloped.data.colony, event: inner.event } : undefined
  }

  const bare = parseEvent(payload)
  return bare.ok ? { colony: null, event: bare.event } : undefined
}
