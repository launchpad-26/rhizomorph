import type { Collector, CollectorContext, PollResult } from '@rhizomorph/core'
import { AGENT_COMMANDS, matchesAgentCommand } from '../sessionlog/process-probe.js'
import { canonicalize, isInside } from '../../paths/containment.js'
import { type ProcessRow, type ProcessTableReader, defaultProcessTableReader } from './read-table.js'

/**
 * THE PROCESS COLLECTOR — prd-57 ruling 1 and ruling 2, licensed by ADR-0052.
 *
 * The process table is the one witness that exists before any configuration and
 * regardless of how anything was launched. This turns it into three facts:
 * an actor appeared, an actor consumed something, an actor went.
 *
 * ## The signature list is the probe's, imported — not a second copy
 *
 * Ruling 2 says the collector owns its signature list and a law asserts every
 * entry is a roster id. The law exists (`process-law.test.ts`) and asserts
 * exactly that. The list itself is **imported from the probe rather than
 * duplicated**, which is a deliberate departure from that sentence and worth
 * the paragraph:
 *
 * Two lists that must agree forever are a drift the compiler cannot see, and
 * this repo already has one signature list that `harness-roster.ts` cites as
 * the thing this codebase records about which binaries are agents. A second
 * would make the roster's citation ambiguous. Importing a frozen constant is
 * not an edit to the probe — Success 3 says that file carries no edit, and it
 * does not — and it leaves exactly one place to change when a harness is added.
 *
 * ## Filtered to the watched repo, on purpose, for now
 *
 * An actor placed outside the watched repo is **seen and then dropped** here.
 * That is not a claim it does not matter: prd-58 ruling 6 gives an actor with
 * no lane a home, and prd-58 is where the instrument stops watching one repo.
 * Until then an event for a lane that cannot exist would be a fact no surface
 * could render, which is the shape prd-27 ruling 3 calls a false summons in a
 * new costume.
 */

/** One actor as the last tick left it. The snapshot is the diff's other half. */
interface ActorSnapshot {
  readonly pid: number
  readonly dialect: string
  readonly startedAt: number
  readonly worktreePath: string | null
  readonly placement: 'rooted' | 'unrooted' | 'unknown'
  readonly parentPid: number | null
  readonly cpuMs: number
  readonly rssBytes: number
}

export interface ProcessSnapshot {
  /** `withResilience` requires it: a wedged collector is disabled rather than retried forever. */
  readonly disabled: boolean
  /** Keyed `pid:startedAt` — an actor is a RUN, not a pid. */
  readonly actors: Readonly<Record<string, ActorSnapshot>>
  /**
   * Whether the previous tick could read the table at all.
   *
   * Load-bearing: without it, the first tick on a platform with no leg is
   * indistinguishable from a tick where every agent exited, and the collector
   * would emit `gone` for actors it had merely stopped being able to see.
   */
  readonly readable: boolean
}

export const PROCESS_COLLECTOR_NAME = 'process'

function actorKeyOf(pid: number, startedAt: number): string {
  return `${pid}:${startedAt}`
}

export interface ProcessCollectorOptions {
  /** Injectable so a test needs no live process table. Defaults by platform. */
  readonly readTable?: ProcessTableReader
}

/**
 * Which dialect this argv names — the first signature that matches, so the
 * event can say `claude` rather than merely "an agent".
 */
function dialectOf(argv: readonly string[]): string | null {
  for (const command of AGENT_COMMANDS) {
    if (matchesAgentCommand(argv, new Set([command]))) return command
  }
  return null
}

/**
 * Where this actor is, canonical, or why we cannot say.
 *
 * Canonicalising HERE is prd-57 ruling 3: `canonicalize` imports `node:fs` and
 * ADR-0003 keeps it out of `packages/core`, so the value must arrive at the fold
 * already resolved. Core compares; it never normalises.
 */
function placementOf(
  row: ProcessRow,
  repoPath: string,
): { worktreePath: string | null; placement: 'rooted' | 'unrooted' | 'unknown' } {
  // The platform would not say. Windows reaches this for every process:
  // `Get-CimInstance` yields a command line and not a working directory, and
  // the leg declares that gap rather than guessing at it.
  if (row.cwd === null) return { worktreePath: null, placement: 'unknown' }
  let canonicalCwd: string
  try {
    canonicalCwd = canonicalize(row.cwd)
  } catch {
    // A cwd that cannot be resolved (ELOOP, EACCES, a deleted directory) is a
    // placement we cannot state. Refused, never guessed.
    return { worktreePath: null, placement: 'unknown' }
  }
  return isInside(repoPath, canonicalCwd)
    ? { worktreePath: canonicalCwd, placement: 'rooted' }
    : { worktreePath: null, placement: 'unrooted' }
}

export function createProcessCollector(options: ProcessCollectorOptions = {}): Collector<ProcessSnapshot> {
  const readTable = options.readTable ?? defaultProcessTableReader()

  return {
    name: PROCESS_COLLECTOR_NAME,

    initialSnapshot(): ProcessSnapshot {
      // `readable: false` so the very first tick after a boot cannot emit
      // `gone` for anything. There is no previous reading to have lost.
      return { disabled: false, actors: {}, readable: false }
    },

    async poll(prev: ProcessSnapshot, context: CollectorContext): Promise<PollResult<ProcessSnapshot>> {
      const reading = await readTable()

      if (reading === null) {
        // This build cannot look. Not "nothing is running" — the probe's third
        // law, one layer up. Emit nothing, and remember that we could not see,
        // so the next successful read is treated as a first sighting rather
        // than as a fleet-wide resurrection.
        return { nextSnapshot: { ...prev, actors: {}, readable: false }, events: [] }
      }

      const events = []
      const actors: Record<string, ActorSnapshot> = {}
      const matchedPids = new Set<number>()

      for (const row of reading.rows) {
        const dialect = dialectOf(row.argv)
        if (dialect === null) continue // not an agent; recorded nowhere, counted nowhere
        matchedPids.add(row.pid)
      }

      for (const row of reading.rows) {
        const dialect = dialectOf(row.argv)
        if (dialect === null) continue
        const { worktreePath, placement } = placementOf(row, context.repoPath)
        // Wave 2 watches one repo. An actor elsewhere is prd-58's.
        if (placement !== 'rooted') continue

        // Parentage among ACTORS only. A shell, an editor or init is a fact
        // about the operator's machine that ADR-0052 does not license recording.
        const parentPid = matchedPids.has(row.parentPid) ? row.parentPid : null
        const key = actorKeyOf(row.pid, row.startedAt)
        actors[key] = {
          pid: row.pid,
          dialect,
          startedAt: row.startedAt,
          worktreePath,
          placement,
          parentPid,
          cpuMs: row.cpuMs,
          rssBytes: row.rssBytes,
        }

        const before = prev.actors[key]
        if (before === undefined) {
          events.push(
            context.emit('process.seen', { pid: row.pid, dialect, startedAt: row.startedAt, worktreePath, placement, parentPid }),
          )
        } else if (before.cpuMs !== row.cpuMs || before.rssBytes !== row.rssBytes) {
          // Only on change. Edge-triggered rather than per-tick, because
          // `buildFleet` folds events into the recency a stall is measured
          // against — a collector that re-announced every tick would refresh
          // the very silence the flatline detector is watching for.
          events.push(
            context.emit('process.activity', {
              pid: row.pid,
              startedAt: row.startedAt,
              cpuMsDelta: Math.max(0, row.cpuMs - before.cpuMs),
              rssBytes: row.rssBytes,
            }),
          )
        }
      }

      // `gone` only when the previous tick could actually SEE. Otherwise a
      // platform that lost its leg, or a denied read, would flatline the fleet.
      if (prev.readable) {
        const livePids = new Set(Object.values(actors).map((actor) => actor.pid))
        for (const [key, before] of Object.entries(prev.actors)) {
          if (actors[key] !== undefined) continue
          // A pid still present under a different start time is a RECYCLED pid:
          // the old run is gone and a new one was reported `seen` above. Saying
          // which lets a reader tell a death from an operating system reusing a
          // number.
          const reason = livePids.has(before.pid) ? 'recycled' : 'absent'
          events.push(context.emit('process.gone', { pid: before.pid, startedAt: before.startedAt, reason }))
        }
      }

      return { nextSnapshot: { disabled: prev.disabled, actors, readable: true }, events }
    },

    // What this collector can actually speak to, in ADR-0010's vocabulary —
    // named, never ranked. `liveness` is the whole point of it; the rest it
    // genuinely cannot see, and a `partial` or `absent` here is compiler-required
    // to carry its reason, which is prd-15 ruling 5's honesty layer as a type.
    capabilities: {
      identity: { level: 'provided' },
      liveness: { level: 'provided' },
      activity: {
        level: 'partial',
        reason:
          'CPU and RSS say a process is BURNING something, never that it is making progress — a wedged agent spinning ' +
          'and a working one look identical here. The transcript organ is what tells those apart.',
      },
      attention: {
        level: 'absent',
        reason: 'a process table says a process exists; it never says the process wants a human',
      },
      telemetry: {
        level: 'absent',
        reason: 'nothing here is exported by the agent — this witness reads the machine, and the agent is not told it is watched',
      },
      cost: {
        level: 'absent',
        reason: 'CPU milliseconds and resident bytes are machine cost, not tokens and not dollars',
      },
    },
  }
}
