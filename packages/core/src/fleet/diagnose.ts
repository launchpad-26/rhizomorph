import {
  FROZEN_AFTER_MS,
  LOOP_MAX_PERIOD,
  LOOP_MIN_PERIOD,
  LOOP_MIN_REPEATS,
  LOOP_WINDOW_MS,
  WAITING_PANE_FRESH_MS,
  WAITING_QUIET_MS,
} from './constants.js'
import { PATHOLOGY_RANK, type Pathology } from './pathology.js'
import { formatSpan } from './plumbing.js'
import { declarationStatus, lapsedForMs, lapsedVoice } from '../selectors/lapse.js'
import type { AgentStatusDissent } from '../state.js'
import type { Lane } from './types.js'

// ── the five detectors ──────────────────────────────────────────────────────

export interface DiagnoseContext {
  now: number
  medianOutputPerMin: number
  expensiveThreshold: number
  paneActivityTs: number | null
  agentStatusTs: number | null
  /** ADR-0037 — the witness's own evidence line, quoted when the organ inferred the WAITING. */
  agentStatusDetail: string | null
  /** prd-27 ruling 4 — the later word a standing declaration overruled, named beside the declaration. */
  agentStatusDissent: AgentStatusDissent | null
  commitTs: number | null
}

export function diagnose(lane: Lane, ctx: DiagnoseContext): Pathology[] {
  const found: Pathology[] = []

  const frozen = detectFrozen(lane)
  if (frozen !== null) found.push(frozen)

  const looping = detectLooping(lane, ctx)
  if (looping !== null) found.push(looping)

  // Silence means exactly one thing: a frozen lane is not also a raised hand.
  const waiting = frozen === null ? detectWaiting(lane, ctx) : null
  if (waiting !== null) found.push(waiting)

  const expensive = detectExpensive(lane, ctx)
  if (expensive !== null) found.push(expensive)

  const offFence = detectOffFence(lane)
  if (offFence !== null) found.push(offFence)

  return found
}

/**
 * LOOPING — a repeating tool-call cycle with nothing landing behind it. Derived
 * from `tool.activity` (the cycle) and `commit.landed` (the progress): a lane
 * running `Read→Edit→Bash` six times over and committing nothing is stuck,
 * while the same cycle punctuated by a commit is just work.
 */
function detectLooping(lane: Lane, ctx: DiagnoseContext): Pathology | null {
  if (ctx.commitTs !== null && ctx.commitTs >= ctx.now - LOOP_WINDOW_MS) return null

  const cycle = findCycle(lane.recentTools)
  if (cycle === null) return null

  return {
    kind: 'looping',
    rank: PATHOLOGY_RANK.looping,
    since: ctx.now - LOOP_WINDOW_MS,
    evidence: `${cycle.pattern.join('→')} ×${cycle.repeats}, no commit`,
    inferred: false,
  }
}

/** The smallest tool cycle the tail of the sequence repeats, if any. */
export function findCycle(
  seq: readonly string[],
): { pattern: string[]; repeats: number } | null {
  for (let period = LOOP_MIN_PERIOD; period <= LOOP_MAX_PERIOD; period += 1) {
    if (seq.length < period * LOOP_MIN_REPEATS) break
    const pattern = seq.slice(seq.length - period)
    // One tool repeated is not a cycle — exploring reads the same file twice.
    if (new Set(pattern).size < 2) continue

    let repeats = 1
    for (let start = seq.length - period * 2; start >= 0; start -= period) {
      const window = seq.slice(start, start + period)
      if (!window.every((tool, i) => tool === pattern[i])) break
      repeats += 1
    }
    if (repeats >= LOOP_MIN_REPEATS) return { pattern, repeats }
  }
  return null
}

/**
 * FROZEN — minutes of total silence. Four cases are exempt by construction,
 * and each exemption is the difference between an instrument and an alarm that
 * gets muted:
 *
 * - a lane whose agent said `done` has *finished*;
 * - a lane whose worktree was removed has landed;
 * - a telemetry-only lane has no git geography to say which of those it is, so
 *   we decline to guess rather than accuse it of dying;
 * - a lane the operator declared `parked` in the manifest (prd4 ruling 5) is
 *   silent on purpose. This is not the UI muting an alarm on its own say-so —
 *   the honesty guard above still holds for everything this detector reads
 *   off the log — it is the one exemption that comes from a fact *outside*
 *   the log: a declaration the operator made in `.swarm/lanes.json`, as real
 *   as `done` or a removed worktree, just written by a different hand.
 *
 * A fifth case is read off the git geography itself rather than declared:
 * {@link isTerminalDone}, checked only once the silence has already crossed
 * the threshold — a lane mid-work between two commits is not exempted just
 * because its tree happens to be momentarily clean.
 */
function detectFrozen(lane: Lane): Pathology | null {
  if (lane.agentStatus === 'done' || !lane.present || lane.telemetryOnly || lane.parked) return null
  if (lane.ageMs === null || lane.ageMs < FROZEN_AFTER_MS) return null
  if (isTerminalDone(lane)) return null
  return {
    kind: 'frozen',
    rank: PATHOLOGY_RANK.frozen,
    since: lane.lastEventTs,
    evidence: `no events for ${formatSpan(lane.ageMs)}`,
    inferred: false,
  }
}

/**
 * TERMINAL-DONE (issue #226) — the known workmux worker-death shape: a pane
 * dies right after its lane commits everything, leaving a worktree that is
 * clean and ahead of main but never got to say `done`. FROZEN would otherwise
 * call this dead air; the git geography it left behind says it finished
 * instead. Only ever checked once FROZEN's own age gate has already opened
 * (see {@link detectFrozen}), so a lane that is merely between two commits —
 * tree momentarily clean, work very much ongoing — is never mistaken for one
 * whose pane went quiet for good.
 */
export function isTerminalDone(lane: Lane): boolean {
  if (lane.agentStatus === 'done' || !lane.present || lane.telemetryOnly || lane.parked) return false
  if (lane.ageMs === null || lane.ageMs < FROZEN_AFTER_MS) return false
  return lane.dirtyCount === 0 && lane.aheadOfMain > 0
}

// A WAITING lane can also read terminal-done (a pane dying right at a
// confirmation prompt, clean and ahead of main, is the same shape). The
// voice in `panels/fleet` already composes it the same way it composes with
// OFF-FENCE — `stateTitle` appends `terminalDoneTitle()` regardless of which
// pathology is worst — so nothing here special-cases it; left unaddressed
// only in the sense that no fixture yet exercises that specific pair, and no
// ruling has said whether WAITING should behave any differently once a human
// answer can no longer possibly land.

/**
 * WAITING — three witnesses, one asymmetry (prd-27 ruling 4, #283).
 *
 * A *declaration* is a harness or the rig saying so: a hook beacon
 * (`lane.declared`, ADR-0036) or workmux's roster (`agentStatusWitness ===
 * 'workmux'`). An *inference* is this instrument reading turn shape
 * (`agentStatusWitness === 'sessionlog'`) or pane stillness (below). Ruling 4:
 * a declaration may raise a summons; an inference alone may only withdraw an
 * inferred one — so a declared `working` newer than the last work quiets both
 * inferences, and an inferred `working` never quiets a declared `waiting`.
 * Between two declarations the newer word stands (the later moment is the
 * truer one), and the older is voiced.
 *
 * Disagreement renders, never resolves in silence: the evidence names every
 * witness that read otherwise, in a fixed order, byte-deterministic. The
 * visual form is the hover card — `selectLaneCondition` carries this string
 * into `why.evidence.fact`, which `DisclosureCard` shows — not a new chip;
 * ruling 4 leaves that choice to the implementer and this comment records it.
 *
 * **A lapsed declaration is not a declaration** (prd-27 ruling 6, #218). Before
 * any clause below reads `lane.declared`, {@link declarationStatus} decides
 * whether it still stands; a lapsed one is nulled out for every one of them, so
 * the asymmetry above applies to what the harness is *still* saying rather than
 * to a word it stopped repeating. The inference that then stands names the
 * lapse — ` · declared attention lapsed <span> ago; reading turn shape` — so
 * the fallback is voiced rather than silent.
 *
 * Two facts the older comments carried, kept because they are still the reason
 * these branches are shaped this way: a declared WAITING **outlives the agent
 * record that made it** — workmux's last report stands forever once the handle
 * goes quiet, but a removed worktree has landed, so `lane.present` is the same
 * honesty exemption FROZEN applies and a stale "waiting" never stands in for a
 * live raised hand; and the pane inference measures **work-age, not
 * liveness-age**, because its whole shape is "the agent stopped working while
 * its terminal kept moving" and a pane repaint must not refresh the very
 * silence being measured.
 */
function detectWaiting(lane: Lane, ctx: DiagnoseContext): Pathology | null {
  const status = declarationStatus(lane.declared, ctx.now, lane.lastWorkTs)
  // prd-27 ruling 6 (#218): a lapsed declaration has no precedence — every
  // clause below sees `null` — and the inference that then stands says why.
  const declared = status === 'lapsed' ? null : lane.declared
  const lapsed =
    status === 'lapsed' && lane.declared !== null ? ` · ${lapsedVoice(lapsedForMs(lane.declared, ctx.now))}` : ''
  const declaredIsNewerThanRoster =
    declared !== null &&
    (ctx.agentStatusTs === null || lane.agentStatusWitness !== 'workmux' || declared.at >= ctx.agentStatusTs)

  // (a) the harness said so — and nothing declared has said otherwise since.
  if (declared !== null && declared.kind === 'waiting' && lane.present && declaredIsNewerThanRoster) {
    const parts = [`beacon (${declared.writer}) declares waiting ${formatSpan(Math.max(0, ctx.now - declared.at))} ago`]
    for (const reading of otherReadings(lane, ctx)) if (reading.word !== 'waiting') parts.push(reading.voice)
    return {
      kind: 'waiting',
      rank: PATHOLOGY_RANK.waiting,
      since: declared.at,
      evidence: parts.join(' · '),
      inferred: false,
    }
  }

  // (b) a declared `working` newer than the last work quiets every inference below;
  // a stale one quiets nothing and is named on whatever inference stands.
  const declaredWorkingIsFresh =
    declared !== null && declared.kind === 'working' && declared.at > (lane.lastWorkTs ?? Number.NEGATIVE_INFINITY)
  const staleDeclaredWorking =
    declared !== null && declared.kind === 'working' && !declaredWorkingIsFresh
      ? ` · beacon (${declared.writer}) declared working ${formatSpan(Math.max(0, ctx.now - declared.at))} ago, before the last work`
      : ''

  if (lane.agentStatus === 'waiting' && lane.present) {
    const since = ctx.agentStatusTs ?? lane.lastEventTs
    const forMs = since === null ? null : Math.max(0, ctx.now - since)
    if (lane.agentStatusWitness === 'sessionlog') {
      if (declaredWorkingIsFresh) return null // (b): the harness says it is working, newer than the organ's reading
      return {
        kind: 'waiting',
        rank: PATHOLOGY_RANK.waiting,
        since,
        evidence: `transcript shape: ${ctx.agentStatusDetail ?? 'no reading recorded'}${staleDeclaredWorking}${lapsed}`,
        inferred: true,
      }
    }
    // workmux declared it. A newer beacon `working` is the newer declaration and stands instead.
    if (declared !== null && declared.kind === 'working' && ctx.agentStatusTs !== null && declared.at > ctx.agentStatusTs)
      return null
    const word = forMs === null ? 'workmux reports waiting' : `workmux reports waiting ${formatSpan(forMs)}`
    const dissent = ctx.agentStatusDissent === null ? '' : `; transcript shape reads ${ctx.agentStatusDissent.status}`
    const olderBeacon =
      lapsed !== ''
        ? lapsed
        : declared !== null && declared.kind === 'waiting'
          ? ''
          : declared === null
            ? ''
            : ` · beacon (${declared.writer}) declared ${declared.kind} ${formatSpan(Math.max(0, ctx.now - declared.at))} ago`
    return {
      kind: 'waiting',
      rank: PATHOLOGY_RANK.waiting,
      // How long the hand has been up is when workmux said so — not the lane's
      // last event, which a pane heartbeat keeps refreshing while it waits.
      since,
      evidence: `${word}${dissent}${olderBeacon}`,
      inferred: false,
    }
  }

  // The pane-stillness inference — same four exemptions as FROZEN (parked
  // included, prd4 ruling 5): a parked lane going quiet is exactly what the
  // operator declared, not a raised hand to deduce. Plus (b).
  if (lane.agentStatus === 'done' || !lane.present || lane.telemetryOnly || lane.parked) return null
  if (lane.workAgeMs === null || lane.workAgeMs < WAITING_QUIET_MS) return null
  if (ctx.paneActivityTs === null) return null
  if (ctx.now - ctx.paneActivityTs > WAITING_PANE_FRESH_MS) return null
  if (declaredWorkingIsFresh) return null

  return {
    kind: 'waiting',
    rank: PATHOLOGY_RANK.waiting,
    since: lane.lastWorkTs,
    evidence: `quiet ${formatSpan(lane.workAgeMs)}, pane still alive${staleDeclaredWorking}${lapsed}`,
    inferred: true,
  }
}

/** The witnesses that can disagree with a declaration, in the order they are voiced. */
function otherReadings(lane: Lane, ctx: DiagnoseContext): Array<{ word: string; voice: string }> {
  const readings: Array<{ word: string; voice: string }> = []
  if (lane.agentStatus !== null && lane.agentStatusWitness === 'sessionlog') {
    readings.push({ word: lane.agentStatus, voice: `transcript shape reads ${lane.agentStatus}` })
  } else if (lane.agentStatus !== null && lane.agentStatusWitness === 'workmux') {
    readings.push({ word: lane.agentStatus, voice: `workmux reports ${lane.agentStatus}` })
  }
  if (lane.workAgeMs !== null && lane.workAgeMs < WAITING_QUIET_MS) {
    readings.push({ word: 'working', voice: 'recent work reads working' })
  }
  return readings
}

/**
 * EXPENSIVE — a burn outlier against the fleet's own median, never against a
 * budget: the question an operator actually has is "is one of these unlike the
 * others", and a fixed dollar threshold answers a different one.
 */
function detectExpensive(lane: Lane, ctx: DiagnoseContext): Pathology | null {
  if (lane.outputPerMin < ctx.expensiveThreshold) return null
  const multiple = ctx.medianOutputPerMin > 0 ? lane.outputPerMin / ctx.medianOutputPerMin : null
  return {
    kind: 'expensive',
    rank: PATHOLOGY_RANK.expensive,
    since: null,
    evidence: `${Math.round(lane.outputPerMin)} out-tok/min, ${
      multiple === null ? 'no fleet median' : `${multiple.toFixed(1)}× fleet median`
    }`,
    inferred: false,
  }
}

/**
 * How many trespass paths the evidence clause names before it stops naming and
 * starts counting.
 *
 * One, and the reason it is one rather than three is that this string is
 * rendered in an 18rem chip on the attention strip. A named path is what makes
 * a breach actionable (#226) and the *first* one delivers all of that; the
 * second onward buy nothing a count does not, and they buy it at the cost of
 * the first being legible at all.
 */
export const NAMED_TRESPASSES = 1

/**
 * OFF-FENCE — touching files outside the fence this lane was dispatched with.
 *
 * Only ever from a real manifest: `lane.trespasses` is empty whenever there was
 * no fence to cross, so this detector cannot fire on an inference.
 *
 * **The evidence is bounded here, at the source** (walkthrough, 2026-08-17).
 * Until this commit it joined EVERY trespass path with ` · ` into one unbounded
 * string — a lane forty files off its fence produced a clause thousands of
 * characters long — and poured it into `AttentionStripView`'s 18rem chip, which
 * truncated it mid-path. The chip was doing the right thing with an impossible
 * input: what the reader got was `packages/web/src/panels/attent…`, which names
 * neither the breach nor its size.
 *
 * The fix belongs *here* rather than in the view, and that is the whole point of
 * the finding. This string is `Pathology.evidence`, read by the attention chip,
 * the fleet table's STATE title, the drawer's evidence line, `selectLaneCondition`
 * and the run view's outcome — five surfaces, one of which happened to have the
 * narrowest box. Clipping it in the view would have fixed one surface and left
 * the other four rendering a sentence nobody can finish reading, and it would
 * have put a presentation decision downstream of the fact rather than in it.
 *
 * **A count plus the first path; the rest on demand.** The rest are not lost and
 * were never in this clause's gift to keep: `lane.trespasses` carries every one
 * of them, and the fleet table's FENCE cell already renders the complete list in
 * its hover title (`panels/fleet/format.ts`'s `fenceCell`) — which is the
 * surface an operator is on when they want to audit rather than triage.
 */
function detectOffFence(lane: Lane): Pathology | null {
  if (!lane.fenced || lane.trespasses.length === 0) return null

  const total = lane.trespasses.length
  const named = lane.trespasses
    .slice(0, NAMED_TRESPASSES)
    .map((t) => (t.victim === null ? t.path : `${t.path} → ${t.victim}`))
    .join(' · ')
  const rest = total - NAMED_TRESPASSES

  // The count leads, because at forty paths the number IS the finding and the
  // path is the example. At one path the count would be noise, so there is not
  // one — a bare `1 file outside fence` beside the path it names reads as an
  // instrument that cannot count.
  const headline = total === 1 ? 'outside fence' : `${total} files outside fence`

  return {
    kind: 'off-fence',
    rank: PATHOLOGY_RANK['off-fence'],
    since: null,
    evidence: rest > 0 ? `${headline} — ${named} +${rest} more` : `${headline} — ${named}`,
    inferred: false,
  }
}
