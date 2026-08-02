import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEvent, type RhizomorphEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSessionEvents } from '../log/session-log.js'
import { SessionRecorder } from './recorder.js'

function errorEvent(id: string, ts: number, message = 'boom') {
  return createEvent('collector.error', { collector: 'git', message }, { id, ts })
}

describe('SessionRecorder', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-recorder-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('buffers, emits and persists each recorded event', async () => {
    const filePath = path.join(dir, 'session-1.jsonl')
    const recorder = new SessionRecorder('1', filePath)
    const seen: RhizomorphEvent[] = []
    recorder.subscribe((event) => seen.push(event))

    const event = errorEvent('evt-1', 1)
    await recorder.record(event)

    expect(recorder.eventsSoFar()).toEqual([event])
    expect(seen).toEqual([event])
    expect(await readSessionEvents(filePath)).toEqual([event])
  })

  it('rebuilds its buffer from a resumed session and appends after it, without rewriting', async () => {
    const filePath = path.join(dir, 'session-1.jsonl')
    const already = [errorEvent('evt-1', 1), errorEvent('evt-2', 2)]
    const previous = new SessionRecorder('1', filePath)
    for (const event of already) await previous.record(event)

    const resumed = new SessionRecorder('1', filePath, { resumeFrom: await readSessionEvents(filePath) })
    expect(resumed.eventsSoFar()).toEqual(already)

    const next = errorEvent('evt-3', 3)
    await resumed.record(next)

    expect(resumed.eventsSoFar()).toEqual([...already, next])
    // The file gained exactly one line — the replayed history was not re-appended.
    expect(await readSessionEvents(filePath)).toEqual([...already, next])
  })

  it('replays the resumed history to nobody: subscribers only get events from now on', async () => {
    const filePath = path.join(dir, 'session-1.jsonl')
    const already = [errorEvent('evt-1', 1)]
    const resumed = new SessionRecorder('1', filePath, { resumeFrom: already })
    const seen: RhizomorphEvent[] = []
    resumed.subscribe((event) => seen.push(event))

    const next = errorEvent('evt-2', 2)
    await resumed.record(next)

    expect(seen).toEqual([next])
  })

  it('survives a crash-truncated final line: drops it, keeps the rest, appends cleanly', async () => {
    const filePath = path.join(dir, 'session-1.jsonl')
    const kept = errorEvent('evt-1', 1)
    // A process killed mid-append: a whole line, then half of the next one.
    await writeFile(filePath, `${JSON.stringify(kept)}\n{"id":"evt-2","ts":2,"type":"collect`)

    const resumed = new SessionRecorder('1', filePath, { resumeFrom: await readSessionEvents(filePath) })
    expect(resumed.eventsSoFar()).toEqual([kept])

    const next = errorEvent('evt-3', 3, 'after the crash')
    await resumed.record(next)

    expect(await readSessionEvents(filePath)).toEqual([kept, next])
    // Not merely skipped on read: the half line is gone, so the appended event is a whole line.
    const raw = await readFile(filePath, 'utf8')
    expect(raw).not.toContain('"type":"collect{')
    expect(raw.trimEnd().split('\n')).toHaveLength(2)
  })

  it('treats a resumed-but-empty file as resuming, not as a new session', async () => {
    const filePath = path.join(dir, 'session-1.jsonl')
    const resumed = new SessionRecorder('1', filePath, { resumeFrom: [] })

    expect(resumed.eventsSoFar()).toEqual([])
    const next = errorEvent('evt-1', 1)
    await resumed.record(next)
    expect(await readSessionEvents(filePath)).toEqual([next])
  })
})
