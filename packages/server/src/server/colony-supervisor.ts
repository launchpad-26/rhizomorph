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
  /**
   * Stops every loop, in parallel. Idempotent, and **final**: a `sync` that
   * arrives afterwards starts nothing.
   *
   * That last word is load-bearing. Discovery runs on a sweep whose promise the
   * boot does not track, and a sweep awaits `git` before it calls `sync`, so a
   * shutdown lands inside that window routinely. Without finality the late
   * `sync` reads an emptied set, rebuilds a loop for every colony — the pinned
   * one included, on the boot's own recorder — and none of them is ever
   * stopped.
   */
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
  /**
   * A colony that is ALREADY running, adopted rather than started.
   *
   * The boot path opens the pinned colony's recorder, collectors and loop
   * before discovery has run once — and discovery then reports that colony
   * every tick, because the pin is always in the watched set. Without this the
   * supervisor would start a SECOND loop against the same recorder: two writers
   * on one log, every event recorded twice.
   *
   * Measured, not reasoned: the Linux gate caught it as a rotated session whose
   * fresh log held three events instead of one.
   */
  readonly adopt?: RunningColony
}

export function createColonySupervisor(options: ColonySupervisorOptions): ColonySupervisor {
  const { recorders, startColony, onStartFailed } = options
  const running = new Map<string, RunningColony>()
  // Adopted before the first `sync`, so the pinned colony is never started a
  // second time. Its loop is the boot's own and this never stops it: shutdown
  // order is the boot's business, and stopping a loop this did not start would
  // make `stop()` mean two different things.
  const adopted = options.adopt?.colony.id
  if (options.adopt !== undefined) running.set(options.adopt.colony.id, options.adopt)
  /** In-flight starts, so two ticks cannot race into two loops for one colony. */
  const starting = new Map<string, Promise<void>>()
  /**
   * Shutdown is FINAL, and this is the flag that makes it so.
   *
   * `stop()` clears the running set, and without this a `sync` arriving one
   * moment later would find every colony absent and start it again. That is not
   * hypothetical: the boot's discovery sweep is a `setInterval` whose promise
   * nothing awaits, and `syncColonies` awaits `discovery.discover(...)` — which
   * execs `git` with a 5 s timeout — before it ever reaches `sync`. A `^C`
   * inside that window is the ordinary case, not the unlucky one.
   *
   * What it cost, precisely: a fresh poll loop for every colony including the
   * PINNED one, built on the boot's own recorder, while the boot was busy
   * closing the app and releasing the session lock. Two live writers on one
   * recording — the exact thing {@link ColonySupervisorOptions.adopt} exists to
   * prevent — reached through a different door, plus loops nothing will ever
   * stop.
   */
  let stopped = false

  return {
    async sync(colonies: readonly Colony[]): Promise<void> {
      // After `stop()` there is nothing to bring up to date. A sweep that was
      // already in flight when the operator quit must not resurrect the set.
      if (stopped) return
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
      stopped = true
      // Starts that are already in flight are awaited before their loops are
      // stopped, so a colony cannot finish starting into a set nobody will ever
      // stop. `sync` is closed above, so this set cannot grow again.
      await Promise.allSettled([...starting.values()])
      // In parallel: each `stop()` awaits its own in-flight tick, and stopping
      // N colonies one after another would take N tick budgets on a shutdown
      // path an operator is watching.
      // Everything this supervisor started — never the adopted loop, which the
      // boot owns and stops itself.
      const loops = [...running.values()]
        .filter((entry) => entry.colony.id !== adopted)
        .map((entry) => entry.pollLoop)
      running.clear()
      await Promise.all(loops.map((loop) => loop.stop()))
    },
  }
}
