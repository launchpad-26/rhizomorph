import type { DisclosureContent } from '../../disclosure/index.js'
import {
  isTerminalDone,
  selectLaneCondition,
  selectWorstPathology,
  TERMINAL_DONE_FACT,
  type Fleet,
  type Filament,
  type Gap,
  type Lane,
  type Pathology,
  type SigilKind,
} from '../../fleet/index.js'
import { formatSpan } from '../../fleet/index.js'
import { formatTokenBreakdown, formatTokens, formatUsd } from '../../lib/format.js'

/**
 * Cell logic for the fleet table (issue #78). Kept out of `index.tsx` so the
 * component stays about layout and this file stays about what a cell is
 * allowed to say — in particular the gap-honest rule that a missing feed reads
 * as an absence with a reason, never as a zero (law 12).
 *
 * The STATE cell's *words* — {@link stateTitle}, {@link terminalDoneTitle} —
 * come from `@rhizomorph/core`'s condition selector (prd-30 ruling 2, #560)
 * rather than being composed here: this file used to hold its own copy of
 * "worst pathology wins, then terminal-done, then the bare activity word" and
 * that is exactly the shape of the failure prd-30 exists against, just
 * between two files in this package instead of two components. What stays
 * here is presentation only — which glyph and which hue, not which words.
 */

/**
 * The lane-name cell's disclosure (#220) — where this lane actually lives.
 *
 * The cell shows the handle; the worktree path is what the column could not
 * fit, and it used to be a `title=`. It is a reading rather than a condition,
 * so the remedy is the stated `none` arm: `vocabulary.ts` throws on a `none`
 * with no `because`, which is what stops "nothing to do" from reading as an
 * unwritten remedy.
 */
export function laneIdentityDisclosure(lane: Lane): DisclosureContent {
  const path = lane.worktreePath
  return {
    label: lane.label,
    why: {
      reason: path === null ? 'git never named a worktree for this lane' : 'where this lane runs',
      evidence: {
        fact: path === null ? `the fleet knows it only by its handle, ${lane.id}` : `git reported the worktree ${path}`,
        elapsedMs: lane.ageMs ?? 0,
      },
    },
    remedy: {
      kind: 'none',
      because:
        path === null
          ? 'a lane with no worktree is usually one that has already folded — nothing here needs doing'
          : 'the path is where the lane lives, not something to act on',
    },
  }
}

/** The lane's branch, and the honest absence when git never saw a worktree for it. */
export function laneBranchDisclosure(lane: Lane): DisclosureContent {
  if (lane.branch === null) {
    return {
      label: 'branch',
      why: {
        reason: 'git never saw a worktree for this lane',
        evidence: { fact: 'no branch could be read, so none is shown rather than a guess', elapsedMs: 0 },
      },
      remedy: { kind: 'none', because: 'a lane with no worktree has no branch — usually one that has already folded' },
    }
  }
  return {
    label: 'branch',
    why: {
      reason: 'the branch this lane is working on',
      evidence: { fact: `git reported ${lane.branch}`, elapsedMs: lane.ageMs ?? 0 },
    },
    remedy: { kind: 'none', because: 'a branch name is a reading, not a condition' },
  }
}

/**
 * The `~` mark's disclosure (#220) — the provenance of a state, not the state.
 *
 * The plan folded this sentence into the STATE card's own evidence, and that is
 * where it belongs; it is not there because `selectLaneCondition` lives in
 * `packages/core`, which #220's fence does not reach. Rather than widen the
 * fence into core for one clause, the mark keeps its own card and says the one
 * thing it has always said, now on the keyboard path too. Whoever moves the
 * clause into the selector should delete this and the mark with it.
 */
export function inferredDisclosure(lane: Lane): DisclosureContent {
  const inferred = lane.pathologies.filter((p) => p.inferred)
  return {
    label: '~',
    why: {
      reason: 'this state was inferred from a weaker signal',
      evidence: {
        fact:
          inferred.length === 0
            ? 'no pathology on this lane names a direct observation'
            : `inferred: ${inferred.map((p) => p.kind).join(', ')}`,
        elapsedMs: lane.ageMs ?? 0,
      },
    },
    remedy: {
      kind: 'none',
      because: 'an inference is the strongest reading available for this lane — the mark is there so it is not mistaken for a direct one',
    },
  }
}

/** The worst pathology a lane carries, or null when it has none (a calm row). */
export function worstPathology(lane: Lane): Pathology | null {
  return selectWorstPathology(lane)
}

/** The STATE column's mark: the worst pathology's kind, or the calm activity. */
export function stateSigilKind(lane: Lane): SigilKind {
  return worstPathology(lane)?.kind ?? lane.activity
}

/**
 * The class the STATE column wears for an operator-parked lane (prd4 ruling
 * 5). Same floor ink as idle (`--ink-dim` — prd9's legibility floor forbids a
 * dimmer one), so "more stood-down than a lane that merely went quiet" is now
 * carried by style, not luminance: italic reads as an aside the way it does in
 * prose, the way idle's own plain ink does not.
 */
export const PARKED_TEXT_CLASS = 'text-(--ink-dim) italic'

/**
 * TERMINAL-DONE's own title (issue #226) — distinct from a lane that declared
 * `done` or whose worktree was removed: this one is inferred from git
 * geography (clean, ahead of main, silent past FROZEN's own threshold) after
 * a pane died mid-run. Read where DONE would otherwise be a bare, unexplained
 * word — the whole point is telling the operator *which* kind of finish this
 * was. The sentence itself is `@rhizomorph/core`'s own ({@link TERMINAL_DONE_FACT}),
 * so this mark and {@link stateTitle} can never phrase the same finish two ways.
 */
export function terminalDoneDisclosure(lane: Lane): DisclosureContent {
  return {
    label: 'done',
    why: {
      reason: 'this lane finished, and the alarm beside it is also true',
      // TERMINAL_DONE_FACT is core's own sentence — the same one
      // `stateDisclosure` would use for a lane whose finish IS its condition,
      // so the two marks in this cell can never phrase one finish two ways.
      evidence: { fact: TERMINAL_DONE_FACT, elapsedMs: lane.ageMs ?? 0 },
    },
    remedy: {
      kind: 'none',
      because: 'the finish is a fact about the lane, not something to act on — the alarm beside it is what wants attention',
    },
  }
}

/**
 * The STATE cell's disclosure — the condition selector's own triple, handed to
 * the card unflattened (#220).
 *
 * This was `stateTitle`, which called `disclosureLines` and then glued the
 * result back into one string for a native `title=`. That flattening was the
 * adoption gap prd-30 named: the selector had already assembled label, why and
 * remedy, and the surface threw two thirds of the structure away to fit an
 * attribute that no keyboard could reach. Now the card gets what the selector
 * returns.
 *
 * `now` is the fold's own reading position — the fleet table passes
 * `fleet.now`, the lane page passes its clock. There is no wall-clock default
 * any more: the wrapper that had one is gone, and a caller with no position to
 * hand in has no business rendering an elapsed time.
 */
export function stateDisclosure(lane: Lane, now: number): DisclosureContent {
  return selectLaneCondition(lane, now)
}

/**
 * The STATE cell's DONE suffix mark (issue #226) — sits beside the existing
 * `~` (inferred) and `+N` (more faults) marks for the same reason `stateTitle`
 * above appends its clause: a lane can be mid-alarm (OFF-FENCE, say) and
 * terminal-done at the same time, and the sigil must keep showing the alarm
 * (`stateSigilKind` is untouched by this — the pathology always wins). This
 * mark is how the finish still gets said instead of silently vanishing behind
 * the louder word.
 */
export function showsTerminalDoneMark(lane: Lane): boolean {
  return !lane.parked && worstPathology(lane) !== null && isTerminalDone(lane)
}

/**
 * The STATE cell's GIT STATUS mark (#606) — deliberately independent of
 * `selectLaneCondition`: it renders beside any condition, parked or not,
 * because `dirtyStatusFailedSince` is a recorded fact about the worktree, not
 * an inferred alarm (`Lane.parked`'s own docstring: parking suppresses
 * inferences, not facts). Never folded into `stateSigilKind`'s pathology, and
 * must not be — see the ADR-0022 note on `Lane.dirtyStatusFailedSince`.
 */
export function showsGitStatusIncidentMark(lane: Lane): boolean {
  return lane.dirtyStatusFailedSince !== null
}

/**
 * No message is retained for this incident (`reduce.ts`'s
 * `worktreeDirtyStatusFailed` keeps only the timestamp) — the title says so
 * rather than inventing detail, the same gap-honesty rule the cost/fence
 * cells above follow (law 12).
 */
export function gitStatusIncidentDisclosure(lane: Lane): DisclosureContent {
  return {
    label: 'git',
    why: {
      reason: `${lane.label}: git status --porcelain has failed repeatedly`,
      evidence: {
        fact: 'the collector retried and the command kept failing',
        // `dirtyStatusFailedForMs` is how long the incident has been open,
        // which IS the age of this observation — not the lane's event age.
        // `null` means the duration was not retained, and 0 says "read just
        // now" in core's own register rather than inventing a span.
        elapsedMs: lane.dirtyStatusFailedForMs ?? 0,
      },
    },
    remedy: {
      kind: 'action',
      action: "the underlying error is not retained in-app — read the server's own log",
      command: `git -C ${lane.worktreePath ?? '<worktree>'} status --porcelain`,
    },
  }
}

export function outputCellDisclosure(lane: Lane): DisclosureContent {
  return {
    label: 'output',
    why: {
      reason: 'output tokens this lane has produced, by kind',
      evidence: { fact: formatTokenBreakdown(lane.tokens), elapsedMs: lane.ageMs ?? 0 },
    },
    remedy: {
      kind: 'none',
      because: 'a token count is a reading, not a condition — nothing here needs doing',
    },
  }
}

export function outputCellText(lane: Lane): string {
  return formatTokens(lane.outputTokens)
}

/** `$` — `—` plus the feed gap when no cost telemetry has arrived at all (law 12). */
export function costCellText(lane: Lane): string {
  if (lane.costEventCount === 0) return '—'
  return formatUsd(lane.costUsd)
}

export function costCellDisclosure(lane: Lane, gaps: readonly Gap[]): DisclosureContent {
  if (lane.costEventCount === 0) {
    return {
      label: '$',
      why: {
        reason: gaps.find((gap) => gap.id === 'no-cost-feed')?.line ?? 'no cost telemetry for this lane',
        evidence: {
          // The absence IS the observation, and it was made on this fold —
          // core's own rule for a continuously-true fact (`condition.ts`).
          // Never `NaN` from an age that was never measured.
          fact: 'no llm.usage event has carried a dollar figure for this lane',
          elapsedMs: 0,
        },
      },
      remedy: {
        kind: 'action',
        action: 'turn on the agent CLI\'s own cost telemetry, or read the token count beside this cell',
      },
    }
  }
  if (lane.costIsAuthoritative === false) {
    return {
      label: '$',
      why: {
        reason: 'estimated — not the agent CLI\'s own figure',
        evidence: { fact: `priced from ${formatTokenBreakdown(lane.tokens)}`, elapsedMs: lane.ageMs ?? 0 },
      },
      remedy: {
        kind: 'none',
        because: 'an estimate is the best this lane has reported; the est. mark beside the figure says so on the glance',
      },
    }
  }
  return {
    label: '$',
    why: {
      reason: 'authoritative dollar cost',
      evidence: { fact: 'the agent CLI reported this figure itself (OTel)', elapsedMs: lane.ageMs ?? 0 },
    },
    remedy: { kind: 'none', because: 'the figure comes from the CLI itself — there is nothing better to reach for' },
  }
}

export function ageCellText(lane: Lane): string {
  return lane.ageMs === null ? '—' : formatSpan(lane.ageMs)
}

export function ageCellDisclosure(lane: Lane): DisclosureContent {
  if (lane.ageMs === null) {
    return {
      label: 'age',
      why: {
        reason: 'no event has been recorded for this lane yet',
        evidence: { fact: 'the fold holds no event carrying this lane', elapsedMs: 0 },
      },
      remedy: { kind: 'none', because: 'a lane with no events has no age — this resolves itself the moment one arrives' },
    }
  }
  return {
    label: 'age',
    why: {
      reason: 'how long this lane has been alive',
      evidence: { fact: 'the collector last saw an event for it', elapsedMs: lane.ageMs },
    },
    remedy: { kind: 'none', because: 'an age is a reading, not a condition' },
  }
}

/**
 * #141 — the fleet table's AGE column reads AGE / ACTIVE: how old the lane is
 * beside how much of that age OTel actually measured as active
 * (`claude_code.active_time.total`). Gap-honest (law 12): a lane with no OTel
 * reading shows AGE alone, never an invented `/ 0s`.
 */
export function ageActiveCellText(lane: Lane): string {
  const age = ageCellText(lane)
  if (lane.activeSeconds === null) return age
  return `${age} / ${formatSpan(lane.activeSeconds * 1000)}`
}

export function ageActiveCellDisclosure(lane: Lane): DisclosureContent {
  const base = ageCellDisclosure(lane)
  if (lane.activeSeconds === null) {
    return {
      ...base,
      why: {
        ...base.why,
        evidence: {
          fact: `${base.why.evidence.fact} · no OTel active-time reading for this lane`,
          elapsedMs: base.why.evidence.elapsedMs,
        },
      },
      remedy: {
        kind: 'none',
        because: 'AGE is measured; ACTIVE is not, because no OTel reading arrived — the column shows AGE alone rather than an invented zero (law 12)',
      },
    }
  }
  return {
    ...base,
    why: {
      ...base.why,
      evidence: {
        fact: `${base.why.evidence.fact} · active ${formatSpan(lane.activeSeconds * 1000)} of that (claude_code.active_time.total, OTel)`,
        elapsedMs: base.why.evidence.elapsedMs,
      },
    },
  }
}

const THREAD_SHORT: Record<string, string> = {
  main: 'main',
  subagent: 'sub',
  auxiliary: 'aux',
}

/** Honest label for a thread source: the declared kind, or `unk` (prd2 law). */
export function threadShort(thread: Filament['thread']): string {
  return thread === null ? 'unk' : (THREAD_SHORT[thread] ?? 'unk')
}

/** Filaments other than the lane's own trunk — the second-generation growth (ruling 20). */
export function branchingFilaments(lane: Lane): Filament[] {
  return lane.filaments.filter((filament) => filament.thread !== 'main')
}

export function threadsCellDisclosure(lane: Lane): DisclosureContent {
  if (lane.filaments.length === 0) {
    return {
      label: 'threads',
      why: {
        reason: 'no source reported a thread for this lane',
        evidence: { fact: 'no filament has been folded for it', elapsedMs: 0 },
      },
      remedy: { kind: 'none', because: 'a lane with no reported threads has none to show — the dash says exactly that' },
    }
  }
  return {
    label: 'threads',
    why: {
      reason: 'the threads this lane has run, and what each produced',
      evidence: {
        fact: lane.filaments
          .map((f) => `${threadShort(f.thread)} ${formatTokens(f.outputTokens)} out · ${f.requestCount} req`)
          .join(' · '),
        elapsedMs: lane.ageMs ?? 0,
      },
    },
    remedy: { kind: 'none', because: 'a thread breakdown is a reading, not a condition' },
  }
}

export type FenceCell =
  | { kind: 'no-manifest'; text: string; disclosure: DisclosureContent }
  | { kind: 'unfenced'; text: string; disclosure: DisclosureContent }
  | { kind: 'clean'; text: string; disclosure: DisclosureContent }
  | { kind: 'breach'; text: string; disclosure: DisclosureContent }

/**
 * Gap-honest fence cell (ruling 19, law 12): `none` plus the gap voice when
 * there is no manifest at all; otherwise the lane's own fence compliance, read
 * straight off the trespasses the derived fleet already computed — nothing is
 * re-inferred here.
 */
export function fenceCell(lane: Lane, fleet: Pick<Fleet, 'hasLaneManifest' | 'gaps'>): FenceCell {
  if (!fleet.hasLaneManifest) {
    return {
      kind: 'no-manifest',
      text: 'none',
      disclosure: {
        label: 'fence',
        why: {
          reason:
            fleet.gaps.find((gap) => gap.id === 'no-lane-manifest')?.line ??
            'no lane manifest — off-fence detection unavailable',
          evidence: { fact: 'no lane manifest was found in the watched repo', elapsedMs: 0 },
        },
        remedy: {
          kind: 'action',
          action: 'declare the lanes and their fences in a lane manifest, and this column starts judging them',
        },
      },
    }
  }

  if (!lane.fenced) {
    return {
      kind: 'unfenced',
      text: '—',
      disclosure: {
        label: 'fence',
        why: {
          reason:
            fleet.gaps.find((gap) => gap.id === 'unfenced-lanes')?.line ??
            'no fence declared for this lane — it cannot be judged off-fence',
          evidence: { fact: 'the manifest names this lane but declares no fence for it', elapsedMs: 0 },
        },
        remedy: { kind: 'action', action: 'declare a fence for this lane in the manifest' },
      },
    }
  }

  if (lane.trespasses.length === 0) {
    return {
      kind: 'clean',
      text: 'ok',
      disclosure: {
        label: 'fence',
        why: {
          reason: 'inside its declared fence',
          evidence: { fact: 'every path this lane touched is one the manifest gave it', elapsedMs: lane.ageMs ?? 0 },
        },
        remedy: { kind: 'none', because: 'a lane inside its fence is the wanted state — there is nothing to do' },
      },
    }
  }

  const count = lane.trespasses.length
  return {
    kind: 'breach',
    text: `${count} out`,
    disclosure: {
      label: 'fence',
      why: {
        reason: `${count} path${count === 1 ? '' : 's'} outside this lane's declared fence`,
        evidence: {
          fact: lane.trespasses.map((t) => `${t.path}${t.victim === null ? '' : ` → ${t.victim}`}`).join(' · '),
          elapsedMs: lane.ageMs ?? 0,
        },
      },
      remedy: {
        kind: 'action',
        action: 'widen the fence on the issue before the change, or move the work to the lane that owns the path',
      },
    },
  }
}
