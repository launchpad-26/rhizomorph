import { isTerminalDone } from '../fleet/diagnose.js'
import { evidenceLine, joinVoice, PATHOLOGY_WORD, type Pathology, type PathologyKind, rankIndex } from '../fleet/pathology.js'
import { formatSpan } from '../fleet/plumbing.js'
import type { Lane, LaneActivity } from '../fleet/types.js'
import { declarationStatus, lapsedForMs, lapsedVoice } from './lapse.js'

/**
 * THE CONDITION SELECTOR (prd-30 ruling 2 · #560) — one place that decides
 * what condition a lane is in, so the STATE column can speak it instead of
 * re-deriving its own opinion from `lane.activity`/`lane.pathologies`/
 * `lane.parked` the way `panels/fleet/format.ts` used to.
 *
 * **Shape, not a shared import.** {@link LaneCondition} is structurally
 * identical to `web/src/disclosure/vocabulary.ts`'s `DisclosureContent` (same
 * field names, same nesting, same `Remedy` union) so a caller in `web` can
 * hand this straight to `disclosureLines`/`DisclosureCard` — but it is a
 * separate declaration, not an import, because `core` cannot depend on `web`
 * (the dependency runs the other way) and prd-30 ruling 1's vocabulary is not
 * to be restructured out of `web/src/disclosure/` for this (#554 just
 * landed; other waves consume it as-is). Two names for one shape, kept in
 * sync by the disclosure directory's own tests plus `condition.test.ts`'s own
 * checks below.
 *
 * **Total, not partial.** {@link selectLaneCondition} switches on
 * `lane.parked`, then the worst pathology's kind, then `lane.activity` —
 * three `_never`-exhaustive switches, so a sixth pathology or a sixth
 * activity fails typecheck here before it could ever render as a bare label.
 * There is deliberately no `unknown` arm: every {@link Lane} this package can
 * produce maps to a real condition, so the disclosure card's own `unknown`
 * state (`vocabulary.ts`'s `unknownDisclosure`) is for a caller with no
 * selector answer at all, never for this one.
 *
 * **Evidence, not a label.** Every arm answers "why, and how do you know":
 * `why.evidence.fact` is always a real recorded fact (the exact pathology
 * evidence string a detector produced, or a plain statement of what the fold
 * does and does not know), and `why.evidence.elapsedMs` is always measured
 * from the fact's own timestamp against the `now` the caller supplies — never
 * `Date.now()`, so a caller reading a replay at a scrub position gets elapsed
 * times relative to that position, the same law `vocabulary.ts` holds its own
 * callers to. A condition with no timestamp of its own (PARKED, EXPENSIVE,
 * OFF-FENCE — all continuously-true facts re-read on every fold, not
 * "since"-dated ones) reports `elapsedMs: 0`: "confirmed just now," which is
 * exactly what re-reading the fold on every tick means, and not a claim about
 * when the underlying condition began.
 */

export interface ConditionEvidence {
  fact: string
  elapsedMs: number
}

export interface ConditionWhy {
  reason: string
  evidence: ConditionEvidence
}

export type ConditionRemedy =
  | { kind: 'action'; action: string; command?: string }
  | { kind: 'none'; because: string }

export interface LaneCondition {
  label: string
  why: ConditionWhy
  remedy: ConditionRemedy
}

const ACTIVITY_WORD: Record<LaneActivity, string> = {
  working: 'working',
  waiting: 'waiting',
  done: 'done',
  idle: 'idle',
  unknown: 'unknown',
}

/** Worst rank first, then alphabetical by kind — same order `panels/fleet/format.ts`'s own `worstPathology` used before this landed. */
function sortedPathologies(lane: Lane): Pathology[] {
  return [...lane.pathologies].sort(
    (a, b) => rankIndex(b.rank) - rankIndex(a.rank) || a.kind.localeCompare(b.kind),
  )
}

/** The pathology the STATE column's glyph and this selector both take as the lane's worst, or null on a calm lane. */
export function selectWorstPathology(lane: Lane): Pathology | null {
  return sortedPathologies(lane)[0] ?? null
}

function elapsedSince(now: number, since: number | null): number {
  return since === null ? 0 : Math.max(0, now - since)
}

/** The terminal-done clause (issue #226) — exported so `panels/fleet/format.ts`'s `terminalDoneTitle()` and every condition that can co-occur with it say it identically, rather than each carrying its own copy. */
export const TERMINAL_DONE_FACT =
  'the worktree is clean and ahead of main, but nothing ever declared done: the pane likely died right after its last commit landed'

const PATHOLOGY_REASON: Record<PathologyKind, string> = {
  looping: 'stuck in a repeating tool cycle with nothing landing behind it',
  frozen: 'gone silent — no events of any kind',
  waiting: 'stopped, waiting on a human to answer',
  expensive: "burning tokens far faster than the rest of the fleet",
  'off-fence': 'touching files outside its declared fence',
  // Not "it went quiet" — the distinction this whole ruling exists for. The
  // process witness recorded the run ending; nothing was inferred from silence.
  crashed: 'its agent process ended without ever declaring it was finished',
}

const PATHOLOGY_REMEDY: Record<PathologyKind, ConditionRemedy> = {
  looping: {
    kind: 'action',
    action: 'interrupt and redirect it — a repeating cycle with no commit behind it rarely resolves on its own',
  },
  frozen: {
    kind: 'action',
    action: 'check the pane — this long with no events of any kind usually means it is stuck or the process died',
  },
  waiting: {
    kind: 'action',
    action: "answer the lane's question — it cannot continue until a human responds",
  },
  expensive: {
    kind: 'none',
    because: 'a burn outlier alone is worth watching, not worth interrupting for — revisit if another pathology joins it',
  },
  'off-fence': {
    kind: 'action',
    action: 'review the trespassed files and either narrow the fence or move the work inside it',
  },
  crashed: {
    kind: 'action',
    // The worktree is named first on purpose: a crash leaves work on disk, and
    // the thing an operator most needs to know is whether any of it survived.
    // Restarting before looking is how a half-finished change gets overwritten.
    action:
      'check the worktree for uncommitted work, then restart the lane — the process died without finishing, so nothing downstream knows what it was mid-way through',
  },
}

function pathologyCondition(lane: Lane, worst: Pathology, extra: readonly Pathology[], now: number): LaneCondition {
  const factParts = [evidenceLine(worst)]
  if (extra.length > 0) factParts.push(`+${extra.length} more: ${extra.map(evidenceLine).join(' · ')}`)
  if (isTerminalDone(lane)) factParts.push(TERMINAL_DONE_FACT)

  return {
    label: PATHOLOGY_WORD[worst.kind],
    why: {
      reason: PATHOLOGY_REASON[worst.kind],
      evidence: { fact: factParts.join(' · '), elapsedMs: elapsedSince(now, worst.since) },
    },
    remedy: PATHOLOGY_REMEDY[worst.kind],
  }
}

function parkedCondition(): LaneCondition {
  return {
    label: 'PARKED',
    why: {
      reason: 'stood down by the operator, not silent by accident',
      evidence: {
        fact: 'the lane manifest declares it parked — alarm inferences suppressed, other evidence unaffected',
        elapsedMs: 0,
      },
    },
    remedy: {
      kind: 'none',
      because: 'declared in .swarm/lanes.json — unpark it there to resume watching this lane for alarms',
    },
  }
}

function doneCondition(lane: Lane, now: number): LaneCondition {
  if (isTerminalDone(lane)) {
    return {
      label: ACTIVITY_WORD.done,
      why: {
        reason: 'finished, but never said so',
        evidence: { fact: TERMINAL_DONE_FACT, elapsedMs: elapsedSince(now, lane.lastEventTs) },
      },
      remedy: {
        kind: 'none',
        because: 'nothing further to do — confirm the branch landed cleanly and let it go',
      },
    }
  }

  return {
    label: ACTIVITY_WORD.done,
    why: {
      reason: 'finished',
      evidence: {
        fact: lane.present ? 'the agent declared done' : 'the worktree landed and was removed',
        elapsedMs: elapsedSince(now, lane.lastEventTs),
      },
    },
    remedy: { kind: 'none', because: 'nothing further to do — this lane is finished' },
  }
}

/**
 * prd-27 ruling 4 (#283): a declaration is always named on the card, even when
 * no alarm follows from it — and prd-27 ruling 6 (#218): once it has lapsed,
 * what the card names is the lapse, not the word the harness last said.
 */
function declaredClause(lane: Lane, now: number): string {
  if (lane.declared === null) return ''
  if (declarationStatus(lane.declared, now, lane.lastWorkTs) === 'lapsed') {
    return ` · ${lapsedVoice(lapsedForMs(lane.declared, now))}`
  }
  // prd-57 ruling 3: the same voice `diagnose.ts` uses, from the one place it
  // is spelled — a declaration rendered two ways on two surfaces is how "the
  // condition is assembled once" stops being true.
  return ` · beacon (${lane.declared.writer}) declares ${lane.declared.kind} ${formatSpan(Math.max(0, now - lane.declared.at))} ago${joinVoice(lane.declared.joinedBy)}`
}

function activityCondition(lane: Lane, now: number): LaneCondition {
  switch (lane.activity) {
    case 'working':
      return {
        label: ACTIVITY_WORD.working,
        why: {
          reason: 'active within the last window',
          evidence: {
            fact: `a tool call, model request or status update landed inside the working window${declaredClause(lane, now)}`,
            elapsedMs: elapsedSince(now, lane.lastWorkTs),
          },
        },
        remedy: { kind: 'none', because: 'nothing to do — this lane is getting on with it' },
      }

    case 'idle':
      return {
        label: ACTIVITY_WORD.idle,
        why: {
          reason: 'quiet, past the idle threshold',
          evidence: {
            fact: `no tool call, model request or status update has landed since the idle threshold passed${declaredClause(lane, now)}`,
            elapsedMs: elapsedSince(now, lane.lastWorkTs),
          },
        },
        remedy: {
          kind: 'none',
          because: "idle isn't broken — nudge it if you want it to continue, otherwise leave it",
        },
      }

    case 'unknown':
      return {
        label: ACTIVITY_WORD.unknown,
        why: {
          reason: 'no work signal yet',
          evidence: {
            fact: `no request, tool call or status update has reached this lane${declaredClause(lane, now)}`,
            elapsedMs: elapsedSince(now, lane.firstSeenAt),
          },
        },
        remedy: { kind: 'none', because: 'too early to say — check back once it reports something' },
      }

    case 'done':
      return doneCondition(lane, now)

    // Unreachable from `buildFleet` today — `activityOf` can only return
    // 'waiting' when `lane.agentStatus === 'waiting'`, and `diagnose` always
    // adds a WAITING pathology for a present, non-frozen lane whose agent
    // reports it (see `condition.test.ts`'s note on this arm), so this branch
    // never sees an empty `pathologies` array in practice. It stays a real,
    // honest arm rather than a `default: never` catch-all because
    // `LaneActivity` is a real type with this member, and an activity type
    // that gains a genuinely-reachable empty-pathologies WAITING case later
    // must not silently render the bare "stopped" this selector replaces.
    case 'waiting':
      return {
        label: ACTIVITY_WORD.waiting,
        why: {
          reason: 'reported waiting, with no pathology recorded behind it',
          evidence: {
            fact: `no WAITING pathology matched this reading${declaredClause(lane, now)}`,
            elapsedMs: elapsedSince(now, lane.lastEventTs),
          },
        },
        remedy: { kind: 'none', because: 'nothing to act on beyond the status flag itself' },
      }

    default: {
      const _never: never = lane.activity
      throw new Error(`unreachable lane activity: ${String(_never)}`)
    }
  }
}

/**
 * The one function that decides what condition a lane is in (prd-30 ruling
 * 2). Pure and total over the fold `buildFleet` already produced: parked
 * wins over everything (an operator's stand-down, same precedence
 * `panels/fleet/format.ts`'s `stateTitle` used before this landed), then the
 * worst pathology, then the calm activity. `now` is the reader's own
 * position — live's `Date.now()` reading or replay's scrub position — never
 * read from a clock in here.
 */
export function selectLaneCondition(lane: Lane, now: number): LaneCondition {
  if (lane.parked) return parkedCondition()

  const [worst, ...extra] = sortedPathologies(lane)
  if (worst !== undefined) return pathologyCondition(lane, worst, extra, now)

  return activityCondition(lane, now)
}
