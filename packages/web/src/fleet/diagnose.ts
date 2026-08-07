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
import type { Lane } from './types.js'

// ── the five detectors ──────────────────────────────────────────────────────

export interface DiagnoseContext {
  now: number
  medianOutputPerMin: number
  expensiveThreshold: number
  paneActivityTs: number | null
  agentStatusTs: number | null
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
 * WAITING — stopped with its hand up. **Certain** when workmux declared it;
 * otherwise inferred from a quiet lane whose pane is still moving, and marked
 * as inferred, because a pane heartbeat is a weaker signal than a declaration
 * (ruling 18's detection-honesty clause).
 */
function detectWaiting(lane: Lane, ctx: DiagnoseContext): Pathology | null {
  // A declared WAITING outlives the agent record that made it: workmux's last
  // report stands forever once the handle goes quiet, but a worktree that has
  // been removed has landed — same honesty exemption FROZEN applies, so a
  // stale "waiting" does not stand in for a live raised hand.
  if (lane.agentStatus === 'waiting' && lane.present) {
    const since = ctx.agentStatusTs ?? lane.lastEventTs
    const forMs = since === null ? null : Math.max(0, ctx.now - since)
    return {
      kind: 'waiting',
      rank: PATHOLOGY_RANK.waiting,
      // How long the hand has been up is when workmux said so — not the lane's
      // last event, which a pane heartbeat keeps refreshing while it waits.
      since,
      evidence: forMs === null ? 'workmux reports waiting' : `workmux reports waiting ${formatSpan(forMs)}`,
      inferred: false,
    }
  }

  // Same four exemptions as FROZEN (parked included, prd4 ruling 5): this
  // branch is the *inference*, read off a quiet lane with a live pane, and a
  // parked lane going quiet is exactly what the operator declared, not a
  // raised hand to deduce. A workmux-declared WAITING above this is left
  // alone — that is workmux's own fact, not this detector's guess.
  if (lane.agentStatus === 'done' || !lane.present || lane.telemetryOnly || lane.parked) return null
  // Work-age, not liveness-age: the whole shape of this inference is "the agent
  // stopped working while its terminal kept moving", so a pane repaint must not
  // be allowed to refresh the very silence being measured.
  if (lane.workAgeMs === null || lane.workAgeMs < WAITING_QUIET_MS) return null
  if (ctx.paneActivityTs === null) return null
  if (ctx.now - ctx.paneActivityTs > WAITING_PANE_FRESH_MS) return null

  return {
    kind: 'waiting',
    rank: PATHOLOGY_RANK.waiting,
    since: lane.lastWorkTs,
    evidence: `quiet ${formatSpan(lane.workAgeMs)}, pane still alive`,
    inferred: true,
  }
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
 * OFF-FENCE — touching files outside the fence this lane was dispatched with.
 * Only ever from a real manifest: `lane.trespasses` is empty whenever there was
 * no fence to cross, so this detector cannot fire on an inference. Every
 * trespass names its own path (and its victim, when exactly one fence claims
 * it) — a bare count ("touching 1 other fence") tells the operator nothing
 * they can act on; the path is what lets them tell a real breach from noise
 * (issue #226).
 */
function detectOffFence(lane: Lane): Pathology | null {
  if (!lane.fenced || lane.trespasses.length === 0) return null

  const named = lane.trespasses
    .map((t) => (t.victim === null ? t.path : `${t.path} → ${t.victim}`))
    .join(' · ')

  return {
    kind: 'off-fence',
    rank: PATHOLOGY_RANK['off-fence'],
    since: null,
    evidence: `outside fence — ${named}`,
    inferred: false,
  }
}
