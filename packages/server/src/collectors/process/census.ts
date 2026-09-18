import type { Exec } from '@rhizomorph/core'
import { canonicalize } from '../../paths/containment.js'
import { AGENT_COMMANDS, matchesAgentCommand } from '../sessionlog/process-probe.js'
import { defaultProcessTableReader, type ProcessRow, type ProcessTableReader } from './read-table.js'

/**
 * THE CENSUS — every roster-matched agent on this machine, and where it is.
 *
 * ## Why this is not the collector
 *
 * The collector answers a question about ONE repo: which actors belong in this
 * colony's recording. That narrowing is right and prd-58 ruling 2 depends on it
 * — an agent in another repo belongs in that repo's recording, not in this one.
 *
 * Discovery asks the opposite question. Ruling 1 turns "the machine-wide
 * reading the process witness already performs" into the set of repos worth
 * recording, so its input must be the whole table. Feeding it one colony's fold
 * made the answer circular: a repo could only be discovered if an actor in it
 * had already been recorded, and an actor was only recorded if its repo had
 * already been discovered. The instrument found the pin and nothing else,
 * whatever was running (#645).
 *
 * So there are two questions and one reading. This module is the reading, and
 * it classifies nothing: a sighting is a pid, a dialect and a canonical cwd.
 * **Which repo that cwd belongs to is `createRepoRootResolver`'s to answer**,
 * because that is the component that knows `--git-common-dir` is the grouping
 * key and that caches the answer per directory, negatives included.
 *
 * ## Assembled once
 *
 * `cli/run.ts`'s sweep and `cli/doctor`'s colony check both read it. `doctor`
 * reporting a different set of colonies from the server it is diagnosing is the
 * disagreement prd-27's "the condition is assembled once" exists to prevent,
 * and `checkWatchedColonies`'s own docblock already names it as the risk.
 */

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
export function dialectOf(argv: readonly string[]): string | null {
  const normalised = argv.map(signatureToken)
  for (const command of AGENT_COMMANDS) {
    if (matchesAgentCommand(normalised, new Set([command]))) return command
  }
  return null
}

/**
 * A matched row, its dialect, and its cwd resolved once.
 *
 * The collector and the census both need all three, and canonicalising touches
 * the filesystem — doing it once per matched row is the reason this shape
 * exists rather than each caller deriving its own.
 */
export interface MatchedActor {
  readonly row: ProcessRow
  readonly dialect: string
  /** Canonical cwd, or null where the platform will not say or it cannot be resolved. */
  readonly cwd: string | null
}

/**
 * The process's working directory, canonical, or why we cannot say.
 *
 * Canonicalising HERE is prd-57 ruling 3: `canonicalize` imports `node:fs` and
 * ADR-0003 keeps it out of `packages/core`, so the value must arrive at the fold
 * already resolved. Core compares; it never normalises.
 */
export function canonicalCwdOf(row: ProcessRow): string | null {
  // The platform would not say. Windows reaches this for every process:
  // `Get-CimInstance` yields a command line and not a working directory, and
  // the leg declares that gap rather than guessing at it.
  if (row.cwd === null) return null
  try {
    return canonicalize(row.cwd)
  } catch {
    // A cwd that cannot be resolved (ELOOP, EACCES, a deleted directory) is a
    // placement we cannot state. Refused, never guessed.
    return null
  }
}

/** Every row whose argv names an agent, with its dialect and its cwd resolved. */
export function matchedActors(rows: readonly ProcessRow[]): MatchedActor[] {
  const matched: MatchedActor[] = []
  for (const row of rows) {
    const dialect = dialectOf(row.argv)
    if (dialect === null) continue // not an agent; recorded nowhere, counted nowhere
    matched.push({ row, dialect, cwd: canonicalCwdOf(row) })
  }
  return matched
}

/**
 * One agent, as the machine reports it. No placement, no repo, no judgement.
 *
 * `worktreePath` is the name the rest of the instrument already uses for "the
 * canonical directory this actor is working in" (`AgentProcess.worktreePath`),
 * so a sighting drops straight into `ColonyDiscovery.discover` without a
 * translation layer that could disagree with the collector's own word.
 */
export interface AgentSighting {
  readonly pid: number
  readonly dialect: string
  /** Canonical cwd, or null where the platform will not say. Never guessed. */
  readonly worktreePath: string | null
}

export function sightingOf(actor: MatchedActor): AgentSighting {
  return { pid: actor.row.pid, dialect: actor.dialect, worktreePath: actor.cwd }
}

export interface ProcessCensusOptions {
  /** Injectable so a test needs no live process table. Defaults by platform. */
  readonly readTable?: ProcessTableReader
}

/**
 * Read the table and report every agent on it, or `null` when this build cannot
 * look at all.
 *
 * **`null` is not an empty machine**, and the distinction is the process leg's
 * third law wearing a different hat: a platform with no leg built, or a denied
 * read, must not be reported as "no agents anywhere". A caller that collapsed
 * the two would retire every colony on one unreadable tick.
 *
 * Callers inside a poll loop should NOT use this — the collector already reads
 * the table every tick and publishes the same census through `onCensus`, and
 * ADR-0013's budget is per tick. This exists for `doctor`, which runs no loop.
 */
export async function takeCensus(exec: Exec, options: ProcessCensusOptions = {}): Promise<AgentSighting[] | null> {
  const readTable = options.readTable ?? defaultProcessTableReader()
  const reading = await readTable(exec)
  if (reading === null) return null
  return matchedActors(reading.rows).map(sightingOf)
}
