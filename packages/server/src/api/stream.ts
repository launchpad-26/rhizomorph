import type { RhizomorphEvent } from '@rhizomorph/core'
import type { FastifyInstance } from 'fastify'
import type { ServerContext } from '../server/context.js'

/**
 * The minimal surface {@link flushBacklog} needs from the response — a real
 * `ServerResponse` satisfies this structurally, so a test can swap in a fake
 * sink without a real socket.
 */
export interface EventSink {
  write(chunk: string): boolean
  once(event: 'drain', listener: () => void): void
  readonly writableEnded: boolean
  readonly destroyed: boolean
}

/** Writes one event's three SSE lines. Returns the last write's own result — `false` means the sink's internal buffer is now full (Node's own backpressure signal). */
function writeEvent(sink: EventSink, event: RhizomorphEvent): boolean {
  sink.write(`id: ${event.id}\n`)
  sink.write(`event: ${event.type}\n`)
  return sink.write(`data: ${JSON.stringify(event)}\n\n`)
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
 * How many events {@link flushBacklog} writes before yielding to the event
 * loop. A large session's backlog used to be one synchronous burst — every
 * event serialized and written in the same tick, which for a busy session (the
 * #166-era fix was chasing a ~46k-event log) blocked the process for the whole
 * scan and, for a slow client, grew the socket's own write buffer without
 * bound. Bounded chunks, each followed by a yield — or a wait for the socket to
 * drain, sooner, if it's already behind — keep both bounded.
 */
export const REPLAY_BATCH_SIZE = 200

function onceDrained(sink: EventSink): Promise<void> {
  return new Promise((resolve) => sink.once('drain', resolve))
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Writes `backlog` to `sink` in order, in bounded chunks of
 * {@link REPLAY_BATCH_SIZE} (or `batchSize`, for a test that wants a smaller
 * one), yielding to the event loop at each chunk boundary — or waiting for
 * `drain` sooner, if the sink's own write buffer is already full. Stops early,
 * writing nothing further, once the sink has ended or been destroyed (the
 * client disconnected mid-replay).
 */
export async function flushBacklog(
  sink: EventSink,
  backlog: readonly RhizomorphEvent[],
  batchSize: number = REPLAY_BATCH_SIZE,
): Promise<void> {
  for (let i = 0; i < backlog.length; i++) {
    if (sink.writableEnded || sink.destroyed) return
    const event = backlog[i]
    if (event === undefined) continue
    const ok = writeEvent(sink, event)
    if (!ok) {
      await onceDrained(sink)
    } else if ((i + 1) % batchSize === 0) {
      await yieldToEventLoop()
    }
  }
}

/**
 * Subscribes to the recorder BEFORE a single backlog byte is written, so an
 * event recorded while the (now batched, no longer instantaneous) backlog
 * flush is still in flight is queued rather than lost or interleaved out of
 * order ahead of older backlog events. Once the backlog has fully flushed,
 * whatever queued while it did is drained in the order it arrived, and every
 * event from then on is written directly. Returns the unsubscribe function,
 * for the caller to wire to the connection's own close.
 */
export function streamBacklogThenLive(
  sink: EventSink,
  backlog: readonly RhizomorphEvent[],
  subscribe: (onEvent: (event: RhizomorphEvent) => void) => () => void,
  batchSize: number = REPLAY_BATCH_SIZE,
): () => void {
  let replaying = true
  const queued: RhizomorphEvent[] = []

  const unsubscribe = subscribe((event) => {
    if (replaying) queued.push(event)
    else writeEvent(sink, event)
  })

  void flushBacklog(sink, backlog, batchSize).then(() => {
    replaying = false
    // The client may have disconnected while events were queuing behind the
    // backlog flush — writing to an already-ended sink here (rather than
    // `flushBacklog`'s own per-event guard) would be a write-after-end no
    // caller asked for.
    for (const event of queued) {
      if (sink.writableEnded || sink.destroyed) break
      writeEvent(sink, event)
    }
    queued.length = 0
  })

  return unsubscribe
}

/**
 * SSE stream: replays the session so far (or, for a client resuming with a
 * known `Last-Event-ID`, only what it missed — see {@link resumeBacklog}),
 * batched so a large session's replay never blocks the process or the socket
 * in one burst (see {@link flushBacklog}), then live-tails. Fastify's own
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

    const lastEventIdHeader = request.headers['last-event-id']
    const lastEventId = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader
    const backlog = resumeBacklog(ctx.recorder.eventsSoFar(), lastEventId)

    const unsubscribe = streamBacklogThenLive(res, backlog, (onEvent) => ctx.recorder.subscribe(onEvent))
    request.raw.on('close', unsubscribe)
  })
}
