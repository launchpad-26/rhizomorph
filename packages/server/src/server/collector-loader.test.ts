import type { AnyCollector, CollectorContext, Exec, ExecResult } from '@observatory/core'
import { createEvent, createIdFactory, reduceAll } from '@observatory/core'
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

describe('loadCollectors — resume reconciliation (#111)', () => {
  it('clears a stale collector.disabled left in the resumed session once a fresh poll succeeds', async () => {
    // The exact shape of the bug: this session's log already folds tmux to
    // "disabled" — from a run that ended before this process ever polled —
    // and this process's own resilience snapshot has no memory of that
    // failure (a fresh boot, or a snapshot from before #110's envelope
    // existed). tmux itself is fine right now.
    const nextId = createIdFactory('evt')
    const priorEvents = [
      createEvent(
        'collector.disabled',
        { collector: 'tmux', reason: 'tmux exited with code 1', consecutiveFailures: 3 },
        { id: nextId(), ts: 1000 },
      ),
    ]
    const foldedBefore = reduceAll(priorEvents)
    expect(foldedBefore.collectors.tmux?.status).toBe('disabled')

    const collectors = await loadCollectors({ warn: () => {} }, priorEvents)
    const tmux = collectors.find((c) => c.name === 'tmux')
    if (!tmux) throw new Error('tmux collector missing')

    const ok: ExecResult = { stdout: '', stderr: '', code: 0, failed: false }
    const exec: Exec = async () => ok
    const recorded: unknown[] = []
    const context: CollectorContext = {
      repoPath: '/repo',
      now: 2000,
      exec,
      nextId,
      emit: (type, payload) => {
        const event = createEvent(type, payload, { id: nextId(), ts: 2000 })
        recorded.push(event)
        return event
      },
    }

    const result = await tmux.poll(tmux.initialSnapshot(), context)

    expect(result.events.some((event) => event.type === 'collector.recovered')).toBe(true)

    const foldedAfter = reduceAll([...priorEvents, ...result.events])
    expect(foldedAfter.collectors.tmux?.status).toBe('healthy')
  })
})
