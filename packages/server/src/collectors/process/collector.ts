import type { ActorPlacement, Collector, CollectorContext, PollResult } from '@rhizomorph/core'
import { isInside } from '../../paths/containment.js'
import { type AgentSighting, matchedActors, sightingOf } from './census.js'
import { defaultProcessTableReader, type ProcessTableReader } from './read-table.js'

/**
 * Re-exported, not re-implemented. It moved to `census.ts` with the rest of the
 * signature matching when discovery needed the same reading (#645); the name
 * stays reachable here because this is where its own law and its mutation proof
 * live.
 */
export { signatureToken } from './census.js'

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
 * ## Filtered to the watched repo — and the repo is its WORKTREES too
 *
 * An actor placed outside the watched repo is **seen and then dropped** here,
 * because prd-58 ruling 2 says each colony records its own facts and an agent
 * in another repo belongs in that repo's recording.
 *
 * What that filter may never do is mistake a LANE for another repo. `git
 * worktree add` normally puts a linked worktree outside the repo directory, so
 * containment in `repoPath` alone called every real agent `unrooted` — a word
 * `actorPlacementSchema` reserves for *belongs to no repository* — and dropped
 * it. This repo's own lanes live under `~/.local/share/rhizomorph/lab/
 * worktrees/`, so the instrument was blind to every agent it existed to watch
 * (#645). The known worktree paths come from the fold the git collector already
 * fills, exactly as `beaconLineBelongsTo` routes the shared beacon door.
 *
 * ## The census is a different question, asked of the same reading
 *
 * Dropping a foreign actor from the RECORDING must not also hide it from
 * DISCOVERY, or a repo can only be found once it has already been watched.
 * Every matched row — placed here or not — is published through `onCensus`,
 * off the table this collector has already read, so ruling 1's machine-wide
 * reading costs no second read. See `census.ts`.
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
  /**
   * The watched repo's own worktrees, read fresh on every tick.
   *
   * A function rather than an array for the reason `BeaconCollectorConfig`
   * takes one: a lane is added and removed while the server runs, and a
   * boot-time copy would route by the fleet as it was at start-up forever. The
   * caller passes only worktrees the fold still calls PRESENT — a `git worktree
   * add` at a reused path would otherwise hand another repo's agents to this
   * one.
   */
  readonly worktreePaths?: () => readonly string[]
  /**
   * Every agent on the machine, published once per tick.
   *
   * Deliberately a callback rather than an event or a snapshot field. An event
   * would put another repo's actors into this colony's recording, which is the
   * half of ruling 2 the placement filter exists to protect; a snapshot field
   * would persist them to this session's snapshot directory. Discovery needs
   * the reading, not a record of it — so it is handed over and not written
   * down.
   *
   * Not called when the table could not be read: a census of `[]` would be
   * indistinguishable from an idle machine, and `null`-is-not-empty is this
   * collector's third law.
   */
  readonly onCensus?: (sightings: readonly AgentSighting[]) => void
}

/**
 * Whether this actor belongs to the watched repo, and where it is if so.
 *
 * `cwd` arrives canonical from {@link matchedActors} — prd-57 ruling 3:
 * `canonicalize` imports `node:fs` and ADR-0003 keeps it out of
 * `packages/core`, so the value must reach the fold already resolved. Core
 * compares; it never normalises.
 *
 * **A LANE IS THE REPO.** `worktreePaths` is what stops containment in
 * `repoPath` from calling a linked worktree a different repository. It is the
 * same fact, from the same fold, that `beaconLineBelongsTo` routes the shared
 * beacon door by — the git collector emits `worktree.discovered` for every
 * worktree of the watched repo — so this asks a question the instrument has
 * already answered rather than spawning `git` inside a collector.
 *
 * The two other answers both mean *not this colony's to record*, and stay
 * distinct because one is a fact and the other is a blindness: `unrooted` is an
 * actor working somewhere this instrument does not watch, and `unknown` is a
 * platform that will not say where anything is.
 *
 * **The cost, stated rather than hidden** (review of #645): an independent repo
 * nested inside a worktree — a submodule, a vendored checkout — is contained by
 * it, so its agent is recorded here as well as in its own colony once discovery
 * finds it. That is not new and not asymmetric: the same was already true of a
 * repo nested inside `repoPath`, and `beaconLineBelongsTo` routes hook lines by
 * the identical rule. Fixing it would mean asking git per actor per tick, which
 * is the exec ADR-0013's budget exists to avoid — and the failure it would buy
 * back is a fact recorded twice, not a fact lost.
 */
function placementOf(
  cwd: string | null,
  repoPath: string,
  worktreePaths: readonly string[],
): { worktreePath: string | null; placement: ActorPlacement } {
  // The platform would not say. Windows reaches this for every process:
  // `Get-CimInstance` yields a command line and not a working directory, and
  // the leg declares that gap rather than guessing at it.
  if (cwd === null) return { worktreePath: null, placement: 'unknown' }
  try {
    if (isInside(repoPath, cwd) || worktreePaths.some((worktree) => isInside(worktree, cwd))) {
      return { worktreePath: cwd, placement: 'rooted' }
    }
  } catch {
    // A root that cannot be canonicalised (ELOOP, EACCES) is a comparison this
    // cannot make. Refused, never guessed — the fail-closed posture `isInside`
    // itself takes, and the one `beaconLineBelongsTo` takes for the same reason.
    return { worktreePath: null, placement: 'unknown' }
  }
  return { worktreePath: null, placement: 'unrooted' }
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
      const reading = await readTable(context.exec)

      if (reading === null) {
        // This build cannot look. Not "nothing is running" — the probe's third
        // law, one layer up. Emit nothing, and remember that we could not see,
        // so the next successful read is treated as a first sighting rather
        // than as a fleet-wide resurrection.
        return { nextSnapshot: { ...prev, actors: {}, readable: false }, events: [] }
      }

      const events = []
      const actors: Record<string, ActorSnapshot> = {}
      /**
       * Every signature match, its cwd resolved once.
       *
       * One canonicalisation per matched row rather than two passes over the
       * table: it touches the filesystem, and the parent lookup below needs
       * every row's placement decided before any row's event is formed.
       */
      const sighted = matchedActors(reading.rows)

      /**
       * The machine-wide reading, handed to discovery BEFORE the repo filter
       * below throws most of it away (#645). Ruling 1's set of repos worth
       * recording is derived from exactly this, and deriving it from what
       * survives the filter made it circular.
       */
      options.onCensus?.(sighted.map(sightingOf))

      const worktreePaths = options.worktreePaths?.() ?? []
      const matched = sighted.map((actor) => ({
        row: actor.row,
        dialect: actor.dialect,
        ...placementOf(actor.cwd, context.repoPath, worktreePaths),
      }))

      /**
       * Parentage among ANNOUNCED actors only — rooted, not merely matched.
       *
       * Review of #555 (offered note): built from every match, this named a pid
       * that no `process.seen` ever mentioned, because an unrooted parent is
       * dropped below. Any consumer joining `parentPid` to a known actor got a
       * dangling reference, and wave 4 is where something will want that join.
       * `null` — "no known actor parent" — is a true statement; a pid nobody
       * announced is not.
       */
      const rootedPids = new Set(matched.filter(({ placement }) => placement === 'rooted').map(({ row }) => row.pid))

      for (const { row, dialect, worktreePath, placement } of matched) {
        const key = actorKeyOf(row.pid, row.startedAt)
        const before = prev.actors[key]

        /**
         * Not ours, and never was. Wave 2 watches one repo, and an agent
         * running somewhere else on this machine is recorded nowhere, counted
         * nowhere and emitted nowhere — ADR-0052's sharpest non-goal.
         *
         * The `before === undefined` half is what makes this safe to pair with
         * the carry-forward below: an actor we never announced can never
         * produce a `gone`, so nothing here can emit a death for a process this
         * collector never mentioned.
         */
        if (placement !== 'rooted' && before === undefined) continue

        const parentPid = rootedPids.has(row.parentPid) ? row.parentPid : null
        /**
         * The actor is remembered whatever its placement now is — review of
         * #555, finding 1, and the reason is this collector's own third law.
         *
         * It used to `continue` here on any non-rooted placement. The row never
         * reached `actors`, and the `gone` block below then reported the actor
         * `absent` **while its pid sat in the table this collector had just
         * read**. Two reachable triggers, and the second is the one that
         * matters: a process that genuinely leaves the repo, and a `cwd` the
         * reader could not resolve — which `read-table.ts` produces
         * deliberately, keeping the row with `cwd: null` because *"the process
         * is real and its placement is what is unknown"*. The reader preserved
         * the distinction and this loop collapsed it into death.
         *
         * "Unknown is never death" was enforced at the TABLE (via `readable`)
         * and not at the ROW. Now it is enforced at both.
         *
         * **Why this matters past wave 2:** wave 4's raiser derives `crashed`
         * from a `gone` following a `seen`. A `gone` for a living process is a
         * phantom `crashed` — the crash-as-success inversion ruling 5 exists to
         * remove, running the other way.
         */
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

        if (before === undefined) {
          events.push(
            context.emit('process.seen', { pid: row.pid, dialect, startedAt: row.startedAt, worktreePath, placement, parentPid }),
          )
        } else if (placement !== 'rooted') {
          /**
           * Carried, and silent. The actor is alive and this collector can no
           * longer place it in the watched repo, which is a fact wave 2 has
           * nowhere to publish: `process.seen` announces an arrival and there
           * is no event for a departure that is not a death.
           *
           * Deliberately NOT a `gone` with a third reason. prd-58 ruling 6
           * gives an actor with no lane a home, and an unrooted actor is not
           * ending — it is somewhere this instrument does not yet watch. A
           * `gone` emitted here would have to be un-emitted by prd-58.
           *
           * The cost, stated: the last published placement stays until the pid
           * really leaves the table, so a fleet can show an actor on a lane it
           * has walked out of. That is a stale fact rather than a false death,
           * and only one of those wakes a human at 3am.
           */
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

      /**
       * `gone` only when the previous tick could actually SEE — otherwise a
       * platform that lost its leg, or a denied read, would flatline the fleet.
       *
       * And now only when the actor is genuinely missing from the reading. The
       * carry-forward above is what makes `reason: 'absent'` true again by
       * construction: this block can no longer be reached by an actor whose pid
       * is sitting in the table, so the word means what the schema says it means
       * — *"a pid absent from the table"* — rather than "a pid this loop stopped
       * tracking".
       */
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
