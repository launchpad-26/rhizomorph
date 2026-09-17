import type { ColonyRecorders } from '../recorder/colony-recorders.js'
import type { SessionRecorder } from '../recorder/session-recorder.js'
import type { Colony } from './colonies.js'
import type { PollLoop } from './poll-loop.js'

/**
 * ONE POLL LOOP AND ONE RECORDER PER COLONY — prd-58 ruling 2's other half.
 *
 * **`createPollLoop` needed no edit, and that is the finding.** It already
 * closes over one `repoPath`, one collector set and one recorder, so N colonies
 * is N loops rather than one loop taught to count. A loop that had to know
 * about colonies would have put colony knowledge inside the per-tick path,
 * which is exactly where ADR-0013's budget lives and the last place a new
 * concept should go.
 *
 * So each loop stays the thing that is already correct for one repo — same
 * tick, same snapshots, same watchdog — and this owns the set.
 *
 * **Started, never restarted.** A colony that discovery reports again is one
 * already running; re-starting it would drop every collector back to
 * `initialSnapshot()` and re-emit the whole world as freshly discovered. The
 * idempotence is the point rather than an optimisation.
 */
export interface ColonySupervisor {
  /**
   * Bring the running set up to the discovered set.
   *
   * Additive only: a colony that has stopped appearing keeps its loop and its
   * recorder. Its agents went away; its repo did not, its recording is still a
   * recording, and stopping on absence would make the watched set flicker
   * against a process table that is re-read every two seconds.
   */
  sync(colonies: readonly Colony[]): Promise<void>
  /** Every colony with a loop, in colony-id order. */
  running(): RunningColony[]
  /** Stops every loop, in parallel. Idempotent. */
  stop(): Promise<void>
}

export interface RunningColony {
  readonly colony: Colony
  readonly recorder: SessionRecorder
  readonly pollLoop: PollLoop
}

export interface ColonySupervisorOptions {
  readonly recorders: ColonyRecorders
  /**
   * Builds and starts the loop for one colony.
   *
   * Injected rather than called directly so this is testable without spawning
   * real collectors against real repositories — and so the one thing that
   * varies per deployment (which collectors are loaded, with what roots) stays
   * where the boot path already decides it.
   */
  readonly startColony: (colony: Colony, recorder: SessionRecorder) => Promise<PollLoop>
  /**
   * Where a colony that fails to start is reported.
   *
   * A colony whose loop will not start must not take the others down with it:
   * the instrument watching two repos is strictly better than the instrument
   * watching none because a third had a bad `.git`. Reported, never swallowed
   * — silence here would be indistinguishable from a repo with no agents.
   */
  readonly onStartFailed: (colony: Colony, cause: unknown) => void
}

export function createColonySupervisor(options: ColonySupervisorOptions): ColonySupervisor {
  const { recorders, startColony, onStartFailed } = options
  const running = new Map<string, RunningColony>()
  /** In-flight starts, so two ticks cannot race into two loops for one colony. */
  const starting = new Map<string, Promise<void>>()

  return {
    async sync(colonies: readonly Colony[]): Promise<void> {
      await Promise.all(
        colonies.map(async (colony) => {
          if (running.has(colony.id)) return
          // A discovery tick can land while the previous one's start is still
          // awaiting. Without this, both would see "not running" and build two
          // loops and two recorders for one colony — two writers on one file.
          const inFlight = starting.get(colony.id)
          if (inFlight !== undefined) return inFlight

          const start = (async () => {
            try {
              const recorder = recorders.forColony(colony)
              const pollLoop = await startColony(colony, recorder)
              running.set(colony.id, { colony, recorder, pollLoop })
            } catch (cause) {
              onStartFailed(colony, cause)
            } finally {
              starting.delete(colony.id)
            }
          })()

          starting.set(colony.id, start)
          return start
        }),
      )
    },

    running(): RunningColony[] {
      return [...running.values()].sort((a, b) =>
        a.colony.id < b.colony.id ? -1 : a.colony.id > b.colony.id ? 1 : 0,
      )
    },

    async stop(): Promise<void> {
      // In parallel: each `stop()` awaits its own in-flight tick, and stopping
      // N colonies one after another would take N tick budgets on a shutdown
      // path an operator is watching.
      const loops = [...running.values()].map((entry) => entry.pollLoop)
      running.clear()
      await Promise.all(loops.map((loop) => loop.stop()))
    },
  }
}
