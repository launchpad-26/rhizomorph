import type { AnyCollector, CollectorContext } from '@observatory/core'
import { describe, expect, it } from 'vitest'
import { loadCollectors } from './collector-loader.js'
import { createPollLoop } from './poll-loop.js'
import type { SessionRecorder } from './recorder.js'

describe('loadCollectors', () => {
  it('registers all three collectors', async () => {
    const collectors = await loadCollectors({ warn: () => {} })

    expect(collectors.map((c) => c.name).sort()).toEqual(['git', 'tmux', 'workmux'])
  })

  it('never warns for the real collectors, which are always present', async () => {
    const warnings: string[] = []
    await loadCollectors({ warn: (m) => warnings.push(m) })

    expect(warnings).toEqual([])
  })
})

function makeCollector(name: string, options: { throws?: boolean } = {}): AnyCollector {
  return {
    name,
    initialSnapshot: () => ({ polls: 0 }),
    poll: (prevSnapshot: { polls: number }, context: CollectorContext) => {
      if (options.throws) throw new Error(`${name} blew up`)
      return {
        nextSnapshot: { polls: prevSnapshot.polls + 1 },
        events: [context.emit('collector.error', { collector: name, message: 'ok' })],
      }
    },
  }
}

describe('a collector that throws on poll', () => {
  it('is isolated from the others', async () => {
    const events: unknown[] = []
    const recorder = {
      record: async (event: unknown) => {
        events.push(event)
      },
    } as unknown as SessionRecorder

    const healthy = makeCollector('healthy')
    const broken = makeCollector('broken', { throws: true })

    const pollLoop = createPollLoop({
      repoPath: '/tmp/repo',
      collectors: [broken, healthy],
      recorder,
      exec: async () => ({ stdout: '', stderr: '', code: 0, failed: false }),
      now: () => 0,
    })

    await pollLoop.tick()

    const collectorsHeardFrom = events.map(
      (event) => (event as { payload: { collector: string } }).payload.collector,
    )
    expect(collectorsHeardFrom).toEqual(['broken', 'healthy'])

    const brokenErrorEvent = events[0] as { type: string; payload: { message: string } }
    expect(brokenErrorEvent.type).toBe('collector.error')
    expect(brokenErrorEvent.payload.message).toBe('broken blew up')
  })
})
