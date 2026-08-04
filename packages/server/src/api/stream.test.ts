import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEvent, type RhizomorphEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'
import { resumeBacklog } from './stream.js'

function event(id: string, ts: number): RhizomorphEvent {
  return createEvent('collector.error', { collector: 'git', message: `evt ${id}` }, { id, ts })
}

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
})
