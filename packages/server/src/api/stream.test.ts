import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEvent, type RhizomorphEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'
import { flushBacklog, REPLAY_BATCH_SIZE, resumeBacklog, streamBacklogThenLive, type EventSink } from './stream.js'

function event(id: string, ts: number): RhizomorphEvent {
  return createEvent('collector.error', { collector: 'git', message: `evt ${id}` }, { id, ts })
}

/** Every id this sink was told to write, in the order it was told, read straight off the `id:` lines — the same shape a real SSE client sees. */
function idsWritten(written: readonly string[]): string[] {
  return written.filter((line) => line.startsWith('id: ')).map((line) => line.slice('id: '.length).trim())
}

/**
 * A fake {@link EventSink} whose backpressure and lifecycle are driven by the
 * test, not a real socket — lets the batching/backpressure/disconnect
 * behavior of {@link flushBacklog} and {@link streamBacklogThenLive} be
 * proven deterministically, with no real timers or sockets involved.
 */
function fakeSink() {
  const written: string[] = []
  const drainListeners: Array<() => void> = []
  let writableEnded = false
  let destroyed = false
  let nextWriteResult = true

  const sink: EventSink = {
    write(chunk: string): boolean {
      written.push(chunk)
      return nextWriteResult
    },
    once(eventName, listener) {
      if (eventName === 'drain') drainListeners.push(listener)
    },
    get writableEnded() {
      return writableEnded
    },
    get destroyed() {
      return destroyed
    },
  }

  return {
    sink,
    written,
    setNextWriteResult: (ok: boolean) => {
      nextWriteResult = ok
    },
    fireDrain: () => {
      for (const listener of drainListeners.splice(0, drainListeners.length)) listener()
    },
    end: () => {
      writableEnded = true
    },
  }
}

/** A minimal `subscribe` the test controls directly — one listener at a time, the same contract `SessionRecorder.subscribe` offers. */
function fakeSubscribe() {
  let listener: ((event: RhizomorphEvent) => void) | null = null
  return {
    subscribe: (onEvent: (event: RhizomorphEvent) => void): (() => void) => {
      listener = onEvent
      return () => {
        listener = null
      }
    },
    emit: (event: RhizomorphEvent) => {
      listener?.(event)
    },
  }
}

/** Yields to the event loop, up to `maxTicks` times, until `predicate` holds — a bounded poll, not a wall-clock sleep. */
async function waitUntil(predicate: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('condition never became true')
}

// ── flushBacklog: bounded chunks, backpressure, early stop ─────────────────

describe('flushBacklog', () => {
  it('eventually writes the whole backlog, in order', async () => {
    const { sink, written } = fakeSink()
    const backlog = [event('evt-1', 1), event('evt-2', 2), event('evt-3', 3)]

    await flushBacklog(sink, backlog, 1)

    expect(idsWritten(written)).toEqual(['evt-1', 'evt-2', 'evt-3'])
  })

  it('yields at each batch boundary rather than writing the whole backlog in one synchronous burst', () => {
    const { sink, written } = fakeSink()
    const backlog = [event('evt-1', 1), event('evt-2', 2), event('evt-3', 3), event('evt-4', 4), event('evt-5', 5)]

    void flushBacklog(sink, backlog, 2)

    // Only the first batch landed before the loop yielded control back here —
    // proof this doesn't block through the whole backlog synchronously.
    expect(idsWritten(written)).toEqual(['evt-1', 'evt-2'])
  })

  it('waits for drain before writing past a sink that signals its buffer is full', async () => {
    const { sink, written, setNextWriteResult, fireDrain } = fakeSink()
    const backlog = [event('evt-1', 1), event('evt-2', 2)]
    setNextWriteResult(false)

    const done = flushBacklog(sink, backlog, 10)
    expect(idsWritten(written)).toEqual(['evt-1']) // paused waiting for drain before evt-2

    setNextWriteResult(true)
    fireDrain()
    await done

    expect(idsWritten(written)).toEqual(['evt-1', 'evt-2'])
  })

  it('stops writing once the sink has already ended, before a single event goes out', async () => {
    const { sink, written, end } = fakeSink()
    end()

    await flushBacklog(sink, [event('evt-1', 1), event('evt-2', 2)], 10)

    expect(written).toEqual([])
  })

  it('stops mid-replay once the sink ends between batches, never writing what came after', async () => {
    const { sink, written, end } = fakeSink()
    const backlog = [event('evt-1', 1), event('evt-2', 2), event('evt-3', 3), event('evt-4', 4)]

    const done = flushBacklog(sink, backlog, 2)
    expect(idsWritten(written)).toEqual(['evt-1', 'evt-2']) // paused at the batch boundary

    end() // the client disconnects during the yield
    await done

    expect(idsWritten(written)).toEqual(['evt-1', 'evt-2'])
  })
})

// ── streamBacklogThenLive: no event lost or reordered across the seam ──────

describe('streamBacklogThenLive', () => {
  it('queues a live event recorded while the backlog is still flushing, then delivers it after — never dropped, never reordered ahead of older backlog', async () => {
    const { sink, written } = fakeSink()
    const backlog = [event('evt-1', 1), event('evt-2', 2), event('evt-3', 3), event('evt-4', 4)]
    const live = fakeSubscribe()

    streamBacklogThenLive(sink, backlog, live.subscribe, 2)
    expect(idsWritten(written)).toEqual(['evt-1', 'evt-2']) // paused at the first batch boundary

    live.emit(event('evt-live', 100)) // arrives mid-flush

    await waitUntil(() => idsWritten(written).length === 5)
    expect(idsWritten(written)).toEqual(['evt-1', 'evt-2', 'evt-3', 'evt-4', 'evt-live'])
  })

  it('writes a live event immediately once the backlog has already fully flushed', async () => {
    const { sink, written } = fakeSink()
    const live = fakeSubscribe()

    streamBacklogThenLive(sink, [event('evt-1', 1)], live.subscribe, 10)
    await waitUntil(() => idsWritten(written).length === 1)

    live.emit(event('evt-live', 100))

    expect(idsWritten(written)).toEqual(['evt-1', 'evt-live'])
  })

  it('never writes a live event queued behind the backlog if the sink ended before the backlog finished', async () => {
    const { sink, written, end } = fakeSink()
    const backlog = [event('evt-1', 1), event('evt-2', 2)]
    const live = fakeSubscribe()

    streamBacklogThenLive(sink, backlog, live.subscribe, 2)
    expect(idsWritten(written)).toEqual(['evt-1', 'evt-2']) // paused at the batch boundary

    live.emit(event('evt-live', 100)) // queues, since the backlog hasn't finished flushing
    end() // then the client disconnects before it drains

    // Let the flush's own paused yield resume, notice the sink has ended, and
    // run its post-flush continuation — no predicate to poll on here, since
    // the correct outcome is that nothing further is ever written.
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(idsWritten(written)).toEqual(['evt-1', 'evt-2'])
  })
})

// ── resumeBacklog: the pure decision, unit-tested directly ─────────────────

describe('resumeBacklog', () => {
  const events = [event('evt-1', 1000), event('evt-2', 2000), event('evt-3', 3000)]

  it('replays everything for a client with no Last-Event-ID, as before #166', () => {
    expect(resumeBacklog(events, undefined)).toEqual(events)
  })

  it('sends only what arrived after a known id, dropping neither the rest nor duplicating it', () => {
    expect(resumeBacklog(events, 'evt-1')).toEqual([event('evt-2', 2000), event('evt-3', 3000)])
  })

  it('sends nothing further when the client is already caught up to the last event', () => {
    expect(resumeBacklog(events, 'evt-3')).toEqual([])
  })

  it('falls back to a full replay for an id this buffer has never held, rather than guessing a position', () => {
    expect(resumeBacklog(events, 'evt-from-a-different-session')).toEqual(events)
  })

  it('falls back to a full replay for an empty buffer no matter what id is offered', () => {
    expect(resumeBacklog([], 'evt-1')).toEqual([])
  })
})

// ── the whole route, injected: real Fastify, a real recorder buffer ────────

describe('GET /api/stream resume (#166)', () => {
  let dir: string
  let recorder: SessionRecorder

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-stream-test-'))
    recorder = new SessionRecorder('1000', sessionFilePath(dir, '1000'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function makeApp() {
    return buildApp({ repoPath: '/repo', repoName: 'repo', sessionDir: dir, recorder })
  }

  /** Reads an SSE response until `until` is true of the accumulated text, or the stream ends. */
  async function readUntil(stream: NodeJS.ReadableStream, until: (text: string) => boolean): Promise<string> {
    let text = ''
    await new Promise<void>((resolve) => {
      stream.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8')
        if (until(text)) resolve()
      })
      stream.on('end', resolve)
    })
    return text
  }

  it('replays the whole session for a client with no Last-Event-ID', async () => {
    await recorder.record(event('evt-1', 1000))
    await recorder.record(event('evt-2', 2000))

    const app = makeApp()
    await app.ready()
    const response = await app.inject({ method: 'GET', url: '/api/stream', payloadAsStream: true })
    const stream = response.stream()
    const text = await readUntil(stream, (t) => t.includes('evt-2'))

    expect(text).toContain('"id":"evt-1"')
    expect(text).toContain('"id":"evt-2"')

    stream.destroy()
    await app.close()
  })

  it('resumes from Last-Event-ID: sends only the events the client has not seen, then live-tails', async () => {
    await recorder.record(event('evt-1', 1000))
    await recorder.record(event('evt-2', 2000))
    await recorder.record(event('evt-3', 3000))

    const app = makeApp()
    await app.ready()
    const response = await app.inject({
      method: 'GET',
      url: '/api/stream',
      headers: { 'last-event-id': 'evt-1' },
      payloadAsStream: true,
    })
    const stream = response.stream()
    const text = await readUntil(stream, (t) => t.includes('evt-3'))

    // Neither dropped (evt-2, evt-3 both present) nor duplicated (evt-1 absent).
    expect(text).not.toContain('"id":"evt-1"')
    expect(text).toContain('"id":"evt-2"')
    expect(text).toContain('"id":"evt-3"')

    // …and still live-tails from there, same as the no-resume path.
    const gotLive = readUntil(stream, (t) => t.includes('evt-4'))
    await recorder.record(event('evt-4', 4000))
    expect(await gotLive).toContain('"id":"evt-4"')

    stream.destroy()
    await app.close()
  })

  it('falls back to a full replay for an id the buffer has never held, rather than showing a partial fold', async () => {
    await recorder.record(event('evt-1', 1000))
    await recorder.record(event('evt-2', 2000))

    const app = makeApp()
    await app.ready()
    const response = await app.inject({
      method: 'GET',
      url: '/api/stream',
      headers: { 'last-event-id': 'evt-from-a-restarted-session' },
      payloadAsStream: true,
    })
    const stream = response.stream()
    const text = await readUntil(stream, (t) => t.includes('evt-2'))

    expect(text).toContain('"id":"evt-1"')
    expect(text).toContain('"id":"evt-2"')

    stream.destroy()
    await app.close()
  })

  it('a resumed stream folds to the identical final state as a full replay, over the same events', async () => {
    const backlog = [event('evt-1', 1000), event('evt-2', 2000), event('evt-3', 3000)]
    for (const e of backlog) await recorder.record(e)

    // What a full replay hands the client, unconditionally.
    const full = resumeBacklog(recorder.eventsSoFar(), undefined)
    // What a client resuming after evt-1 is handed.
    const resumed = resumeBacklog(recorder.eventsSoFar(), 'evt-1')

    // The client already folded evt-1 itself before it disconnected, so its
    // final state is "what it already had" + `resumed` — which is exactly
    // `full`: neither a dropped nor a duplicated event between the two paths.
    expect([backlog[0], ...resumed]).toEqual(full)
  })

  it('replays a backlog spanning multiple batches in full and in order — batching must not drop or reorder', async () => {
    const total = REPLAY_BATCH_SIZE * 2 + 7
    for (let i = 1; i <= total; i++) {
      await recorder.record(event(`evt-${i}`, i * 1000))
    }

    const app = makeApp()
    await app.ready()
    const response = await app.inject({ method: 'GET', url: '/api/stream', payloadAsStream: true })
    const stream = response.stream()
    const text = await readUntil(stream, (t) => t.includes(`"id":"evt-${total}"`))

    let lastIndex = -1
    for (let i = 1; i <= total; i++) {
      const idx = text.indexOf(`"id":"evt-${i}"`)
      expect(idx).toBeGreaterThan(lastIndex) // present, and strictly after every earlier event
      lastIndex = idx
    }

    stream.destroy()
    await app.close()
  })

  it('resumes exactly across a multi-batch backlog — no dropped or duplicated event around a batch boundary', async () => {
    const total = REPLAY_BATCH_SIZE * 2 + 5
    for (let i = 1; i <= total; i++) {
      await recorder.record(event(`evt-${i}`, i * 1000))
    }
    const resumeAfter = REPLAY_BATCH_SIZE + 3 // deliberately inside the second batch

    const app = makeApp()
    await app.ready()
    const response = await app.inject({
      method: 'GET',
      url: '/api/stream',
      headers: { 'last-event-id': `evt-${resumeAfter}` },
      payloadAsStream: true,
    })
    const stream = response.stream()
    const text = await readUntil(stream, (t) => t.includes(`"id":"evt-${total}"`))

    for (let i = 1; i <= resumeAfter; i++) {
      expect(text).not.toContain(`"id":"evt-${i}"`)
    }
    for (let i = resumeAfter + 1; i <= total; i++) {
      expect(text).toContain(`"id":"evt-${i}"`)
    }

    stream.destroy()
    await app.close()
  })
})
