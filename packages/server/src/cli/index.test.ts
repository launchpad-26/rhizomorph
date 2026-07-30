import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Collector, CollectorContext, PollResult } from '@observatory/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCli, type CliHandle } from './index.js'

/** A fake collector so the boot test needs no real git/tmux/workmux. */
const fakeCollector: Collector<{ ticks: number }> = {
  name: 'fake',
  initialSnapshot: () => ({ ticks: 0 }),
  poll: (prev, context: CollectorContext): PollResult<{ ticks: number }> => ({
    nextSnapshot: { ticks: prev.ticks + 1 },
    events: [context.emit('agent.status', { handle: 'fake', status: 'working' })],
  }),
}

describe('runCli', () => {
  let dataRoot: string
  let handle: CliHandle | undefined

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), 'observatory-cli-test-'))
  })

  afterEach(async () => {
    await handle?.stop()
    await rm(dataRoot, { recursive: true, force: true })
  })

  it('boots collectors + server, emits session.started, and serves them over the API', async () => {
    const repoPath = path.join(tmpdir(), 'my-repo')

    handle = await runCli([repoPath, '--port', '0'], {
      dataRoot,
      collectors: [fakeCollector],
      log: { log: () => {}, warn: () => {} },
    })

    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const metaResponse = await fetch(`${handle.url}/api/meta`)
    expect(await metaResponse.json()).toMatchObject({ repoPath, repoName: 'my-repo' })

    // start() already fires one tick immediately; wait for it, then force one more.
    await handle.pollLoop.tick()
    await handle.pollLoop.tick()

    const eventsResponse = await fetch(`${handle.url}/api/sessions/${handle.recorder.sessionId}/events`)
    const { events } = (await eventsResponse.json()) as { events: Array<{ type: string }> }
    expect(events[0]?.type).toBe('session.started')
    expect(events.slice(1).every((e) => e.type === 'agent.status')).toBe(true)
    expect(events.length).toBeGreaterThanOrEqual(2)
  })

  it('survives a collector that throws by recording collector.error and moving on', async () => {
    const throwingCollector: Collector<undefined> = {
      name: 'broken',
      initialSnapshot: () => undefined,
      poll: () => {
        throw new Error('boom')
      },
    }

    handle = await runCli([path.join(tmpdir(), 'other-repo'), '--port', '0'], {
      dataRoot,
      collectors: [throwingCollector],
      log: { log: () => {}, warn: () => {} },
    })

    await handle.pollLoop.tick()
    await handle.pollLoop.tick()

    const events = handle.recorder.eventsSoFar()
    expect(events[0]?.type).toBe('session.started')
    expect(events.slice(1).every((e) => e.type === 'collector.error')).toBe(true)
    expect(events.length).toBeGreaterThanOrEqual(2)
  })
})
