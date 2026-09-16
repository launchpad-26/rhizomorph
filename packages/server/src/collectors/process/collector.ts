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
 * Windows executable suffixes, stripped before a signature is matched.
 *
 * **Found by running the leg against a live table, not by the fixture test.**
 * On Windows an agent's argv[0] is `…\claude.exe`, whose basename is
 * `claude.exe` — and `AGENT_COMMANDS` holds `claude`. So the first live run on
 * a machine with three real agents matched **zero**, while every fixture test
 * passed, because those asserted the PARSE and not the MATCH.
 *
 * The probe half-anticipated this and it is worth naming: its
 * `AGENT_INTERPRETERS` already carries `node.exe` beside `node`, while its
 * `AGENT_COMMANDS` carries no `.exe` variant at all. Windows was handled for
 * the interpreter arm and not for the agent arm.
 *
 * Normalising here rather than widening the probe's list is deliberate:
 * `process-probe.ts` carries no edit in this PRD (Success 3), and a suffix is a
 * property of the PLATFORM rather than of the roster — a second list with
 * `claude.exe` in it would have to be kept in step with the first forever.
 */
const WINDOWS_EXECUTABLE_SUFFIXES = ['.exe', '.cmd', '.bat', '.com']

/**
 * `C:\bin\claude.exe` -> `claude` — on Linux as well as on Windows.
 *
 * The second half of that sentence is why this splits the path itself instead
 * of leaving it to `path.basename`. `path` is the RUNTIME's flavour, and a
 * Windows row does not only appear at runtime on Windows: the committed capture
 * is parsed by whichever machine runs the suite, and under a POSIX `path` a
 * backslash is an ordinary filename character — `basename('C:\bin\claude')` is
 * the whole string, and matches nothing. A leg whose matching worked only on
 * its own platform could not be tested from its own fixture, and being testable
 * from the fixture is the property ADR-0004 exists to buy.
 *
 * The cost, stated rather than hidden: a POSIX file genuinely named
 * `weird\claude` would now match. The two failure directions are not
 * comparable — that one is a false positive on a filename nobody has written,
 * and the other was total blindness on an entire platform.
 *
 * **Exported because the property is not observable through `poll` on Windows.**
 * There, `path.basename` splits backslashes itself, so a collector-level test of
 * a Windows argv passes whether or not this function splits — proven by
 * mutation: dropping the backslash arm leaves the whole collector suite green on
 * this machine, and would redden only on a POSIX runner. A claim that holds on
 * every platform needs an assertion that can FAIL on every platform, and that
 * means asserting the function rather than the fold around it.
 */
export function signatureToken(token: string): string {
  const basename = token.slice(Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\')) + 1)
  const lower = basename.toLowerCase()
  for (const suffix of WINDOWS_EXECUTABLE_SUFFIXES) {
    if (lower.endsWith(suffix)) return basename.slice(0, -suffix.length)
  }
  return basename
}

/**
 * Which dialect this argv names — the first signature that matches, so the
 * event can say `claude` rather than merely "an agent".
 */
function dialectOf(argv: readonly string[]): string | null {
  const normalised = argv.map(signatureToken)
  for (const command of AGENT_COMMANDS) {
    if (matchesAgentCommand(normalised, new Set([command]))) return command
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
       * Every signature match, placed once.
       *
       * One `placementOf` per matched row rather than two passes over the
       * table: it canonicalises, which touches the filesystem, and the parent
       * lookup below needs every row's placement decided before any row's
       * event is formed.
       */
      const matched = []
      for (const row of reading.rows) {
        const dialect = dialectOf(row.argv)
        if (dialect === null) continue // not an agent; recorded nowhere, counted nowhere
        matched.push({ row, dialect, ...placementOf(row, context.repoPath) })
      }

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
