import type { AnyCollector, CollectorContext, Exec } from '@observatory/core'
import { createEvent, createIdFactory } from '@observatory/core'
import type { SessionRecorder } from './recorder.js'

export interface PollLoopOptions {
  repoPath: string
  collectors: readonly AnyCollector[]
  recorder: SessionRecorder
  exec: Exec
  /** Defaults to 2000ms per architecture. */
  intervalMs?: number
  /** Injectable clock so tests are deterministic. */
  now?: () => number
}

export interface PollLoop {
  start(): void
  stop(): void
  /** Runs one tick immediately. Exposed for tests; start() also fires one on boot. */
  tick(): Promise<void>
}

/**
 * Runs every registered collector every `intervalMs`, recording whatever
 * events they emit. A collector throwing (bad parser, missing binary that
 * still isn't handled internally, whatever) becomes a `collector.error`
 * event instead of taking the loop down — one bad collector never stops the
 * others.
 */
export function createPollLoop(options: PollLoopOptions): PollLoop {
  const { repoPath, collectors, recorder, exec } = options
  const intervalMs = options.intervalMs ?? 2000
  const now = options.now ?? Date.now
  const nextId = createIdFactory('evt')
  const snapshots = new Map<string, unknown>(collectors.map((c) => [c.name, c.initialSnapshot()]))

  let timer: ReturnType<typeof setInterval> | null = null
  let ticking = false

  async function tick(): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      for (const collector of collectors) {
        const tickNow = now()
        const context: CollectorContext = {
          repoPath,
          now: tickNow,
          exec,
          nextId,
          emit: (type, payload) => createEvent(type, payload, { id: nextId(), ts: tickNow }),
        }
        try {
          const result = await collector.poll(snapshots.get(collector.name), context)
          snapshots.set(collector.name, result.nextSnapshot)
          for (const event of result.events) {
            await recorder.record(event)
          }
        } catch (error) {
          await recorder.record(
            createEvent(
              'collector.error',
              {
                collector: collector.name,
                message: error instanceof Error ? error.message : String(error),
              },
              { id: nextId(), ts: now() },
            ),
          )
        }
      }
    } finally {
      ticking = false
    }
  }

  function start(): void {
    if (timer) return
    void tick()
    timer = setInterval(() => {
      void tick()
    }, intervalMs)
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return { start, stop, tick }
}
