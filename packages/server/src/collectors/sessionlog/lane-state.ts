import type { AgentStatus } from '@rhizomorph/core'
import { isMidTurn, type TurnShape } from './turn-shape.js'

/**
 * **The transcript-tail state machine** — prd15 ruling 1's keystone organ.
 *
 * Lane liveness and attention, derived from the one artifact every agent CLI
 * must produce as it works: its own session transcript. No tmux, no workmux,
 * no hooks, no cooperation from the agent, no terminal of any particular kind,
 * no OS of any particular kind. Three inputs go in:
 *
 * - **(a) turn shape** — what the transcript's tail says the lane is in the
 *   middle of (`turn-shape.ts`, over a per-CLI grammar);
 * - **(b) recency** — when the transcript last advanced;
 * - **(c) process aliveness** — whether an agent is still running there
 *   (`process-probe.ts`), consulted only at a stall.
 *
 * Four states come out, and nothing else:
 *
 * | state | meaning | reached when |
 * |---|---|---|
 * | `working` | in motion | the turn is unfinished and moving, or just ended |
 * | `waiting` | **the needs-you signal** | the turn completed and stayed completed |
 * | `frozen`  | stalled mid-turn, still alive | mid-turn, silent past the stall, process alive-or-unknown |
 * | `gone`    | stalled, process confirmed absent | silent past the threshold, probe says `false` |
 *
 * `gone` deliberately does not distinguish *done* from *died*: prd15 ruling 1
 * puts that call downstream, where git state (did the branch land? is the
 * worktree gone?) can answer it. This organ reports what it can see and
 * refuses to guess the rest.
 *
 * ## The three laws in the branch structure
 *
 * 1. **WAITING requires a completed turn.** There is no path from a mid-turn
 *    shape to `waiting`, at any silence, for any duration. This is #133's
 *    false-summons law made structural rather than thresholded: a lane
 *    delegating to a subagent has an open `Task` call, so its tail is
 *    `pending-tool`, so it *cannot* summon the operator no matter how quiet it
 *    goes or how long its subagent runs.
 * 2. **FROZEN requires a mid-turn shape.** A lane that finished its turn has
 *    nothing to be frozen in the middle of; its hand is up, however long it
 *    has been up. Silence alone never means broken.
 * 3. **Unknown is never death.** Only an explicit `processAlive === false`
 *    reaches `gone`. A `null` probe — macOS, Windows-native, an unreadable
 *    procfs — degrades to `frozen`, the weaker claim.
 */

// ── thresholds (restated from the tmux collector's proven constants) ─────────

/**
 * How long a completed turn must stay completed before it is a raised hand.
 *
 * **Restated from `buildFleet.WAITING_QUIET_MS` (75s)** — the tmux era's
 * proven "silence this long smells like a raised hand" — and independently
 * corroborated against this organ's own corpus, which is the point of
 * restating rather than inheriting: of the 150 completed turns that later
 * resumed *without* the operator, 103 (69%) resumed inside 75 seconds
 * (autocompact, a queued prompt, a fast reply); median 11.2s. The 47 that took
 * longer are human replies — cases where the summons was *right*, and the
 * operator answered it.
 *
 * Stronger than the tmux original, not weaker: there the 75s bought confidence
 * in a *guess* about a quiet pane; here the shape is already certain
 * (`stop_reason: end_turn` is the model saying it returned control) and the
 * window buys only the settle time the loop needs to prove it is not
 * continuing on its own.
 */
export const TURN_SETTLE_MS = 75_000

/**
 * How long an *unfinished* turn may stay silent before the lane is stalled.
 *
 * **Restated from `buildFleet.FROZEN_AFTER_MS` (8 minutes)**, and validated
 * against real tool latency across 15,804 resolved calls in the pinned corpus:
 * p50 0.4s, p90 2.8s, p99 60.5s, p99.9 205s. Exactly **2 calls in 15,804
 * (0.013%) legitimately ran past 8 minutes** — so this threshold misreads a
 * working lane roughly once in eight thousand tool calls, while still catching
 * a real stall inside the window the tmux collector already proved an operator
 * tolerates. The longest legitimate call observed was 2h11m; nothing shorter
 * than 8 minutes would survive contact with a long test run.
 */
export const TRANSCRIPT_STALL_MS = 8 * 60_000

// ── the reading ─────────────────────────────────────────────────────────────

export type LaneState = 'working' | 'waiting' | 'frozen' | 'gone'

export interface LaneStateInputs {
  /** Tick clock, injected — the derivation never reads a clock itself. */
  now: number
  /** Input (a): what `turn-shape.ts` folded out of the transcript's tail. */
  shape: TurnShape
  /**
   * Input (b), the **work** witness: source time of the last conversational
   * entry. This, and only this, gates the thresholds.
   */
  lastEntryTs: number | null
  /**
   * Input (b), the **heartbeat** witness: the transcript file's last write.
   *
   * Carried as evidence and never as a reprieve — see
   * {@link LaneStateReading.writeQuietMs}. Claude Code appends `last-prompt`,
   * `ai-title` and `mode` bookkeeping *after* a turn ends (213 of 253
   * transcripts in the pinned corpus end on one of them), so a moving mtime is
   * routinely a file that is growing with nobody working. Letting it gate the
   * thresholds would reintroduce the prd3 keystone bug the adapters spike
   * warns every adapter author about — a repaint keeping a stalled lane alive
   * forever — through a new door.
   */
  lastWriteTs: number | null
  /** Input (c). `null` means unprobed or unprobeable — never death. */
  processAlive: boolean | null
  /** Source time of the last subagent entry, when the dialect records them. */
  lastSidechainTs?: number | null
}

export interface LaneStateReading {
  state: LaneState
  /** Every witness that spoke, kept whole — ruling 2: no silent winner. */
  shape: TurnShape
  /** Silence on the work witness, ms. Null when the transcript never timed itself. */
  quietMs: number | null
  /** Silence on the heartbeat witness, ms. Reported, never decisive. */
  writeQuietMs: number | null
  processAlive: boolean | null
  /**
   * The derivation in one line, deterministic to the byte: same inputs, same
   * string. It is what a provenance strip or a `doctor` rung would print, and
   * what makes a disagreement between this organ and workmux legible rather
   * than resolved.
   */
  evidence: string
}

/**
 * Derives one lane's state. Pure and total: no clock, no I/O, no randomness,
 * no `Date.now()` — the same inputs produce the same reading byte for byte,
 * which is what lets a replay of a recorded log reproduce liveness exactly.
 *
 * Returns `null` when the transcript carries no conversational entry at all.
 * That is the honest gap, not a fifth state: a file of pure bookkeeping (or an
 * empty one) has told us nothing, and fabricating a state from nothing is the
 * one thing the adapter contract forbids outright.
 */
export function deriveLaneState(inputs: LaneStateInputs): LaneStateReading | null {
  if (inputs.shape === 'empty') return null

  const quietMs = quietMsOf(inputs.now, inputs.lastEntryTs, inputs.lastWriteTs)
  const writeQuietMs = elapsed(inputs.now, inputs.lastWriteTs)
  const midTurn = isMidTurn(inputs.shape)
  const threshold = midTurn ? TRANSCRIPT_STALL_MS : TURN_SETTLE_MS
  const stalled = quietMs !== null && quietMs >= threshold

  const state: LaneState = !stalled
    ? 'working'
    : inputs.processAlive === false
      ? 'gone'
      : midTurn
        ? 'frozen'
        : 'waiting'

  return {
    state,
    shape: inputs.shape,
    quietMs,
    writeQuietMs,
    processAlive: inputs.processAlive,
    evidence: describe(state, inputs.shape, quietMs, writeQuietMs, inputs.processAlive, threshold),
  }
}

/**
 * Silence on the work witness: how long since the transcript last advanced.
 *
 * The file clock is a fallback for a transcript that never timed itself, never
 * a competitor to the entry clock — see {@link LaneStateInputs.lastWriteTs}.
 * Exported so the collector's probe gate computes it exactly one way; if it
 * had its own copy, the gate and the derivation could drift apart and a lane
 * would be probed pointlessly or a GONE missed.
 */
export function quietMsOf(now: number, lastEntryTs: number | null, lastWriteTs: number | null): number | null {
  return elapsed(now, lastEntryTs ?? lastWriteTs)
}

/**
 * Whether a lane at this shape and silence still needs the process probe.
 *
 * Below the threshold the answer is `working` whatever the process table says,
 * so the probe is not consulted — the observer's footprint on a healthy fleet
 * is then exactly zero reads outside the transcripts it was already tailing.
 * Exposed (rather than buried in the collector) because it is a property of
 * the derivation, and its test belongs beside the derivation's.
 */
export function needsProcessProbe(shape: TurnShape, quietMs: number | null): boolean {
  if (shape === 'empty' || quietMs === null) return false
  return quietMs >= (isMidTurn(shape) ? TRANSCRIPT_STALL_MS : TURN_SETTLE_MS)
}

// ── publication (BLOCKED on core; see the note below) ───────────────────────

/**
 * The `agent.status` an organ reading would publish, if it could publish.
 *
 * ## BLOCKED — why nothing here is wired into `poll` yet
 *
 * prd15 ruling 4 and the adapter contract both say an adapter emits **only**
 * from the existing event union, and `agent.status` is the natural home. It is
 * not usable from this collector today, for one structural reason:
 *
 * `agentStatusEventSchema = envelope('workmux', 'agent.status', …)`
 * (`packages/core/src/events/workmux.ts:20`) pins `source` to the **literal**
 * `'workmux'`. `createEvent` fills `source` from `EVENT_SOURCE_BY_TYPE`, and
 * zod rejects any other value — so every `agent.status` this collector emitted
 * would be stamped as having come from workmux. That is a forged provenance
 * record on an append-only log that is hash-chained, exported as a portable
 * record, and merged with other instruments' records. It also makes prd15
 * ruling 2 unimplementable at the point it matters most: if both witnesses
 * sign their observations `workmux`, a disagreement between them cannot even
 * be *seen*, let alone voiced — the second witness becomes a silent winner by
 * construction, which is the exact failure the ruling forbids.
 *
 * The mechanism already exists in core for precisely this case:
 * `envelopeWithSources`, whose doc comment reads "for a type that more than
 * one collector can legitimately produce" — `llm.usage` uses it for the
 * sessionlog/otel pair today.
 *
 * **BLOCKED: `agent.status` must accept `source: 'sessionlog'` — change
 * `envelope('workmux', …)` to `envelopeWithSources(['workmux', 'sessionlog'], …)`
 * in `packages/core/src/events/workmux.ts` and widen
 * `EVENT_SOURCE_BY_TYPE['agent.status']`'s `SourceOf` accordingly. Outside
 * this issue's fence (`collectors/sessionlog/` only) and not #187's either.**
 *
 * Until that lands the organ derives in full — the states are computed every
 * poll and live in the snapshot, which is what `tmuxless-boot.test.ts` reads —
 * and this function stays the tested, ready-to-wire publication step.
 */
export interface AgentStatusEmission {
  handle: string
  status: AgentStatus
  worktreePath: string | null
  branch: string | null
  elapsedSeconds: number | null
  detail: string
}

export interface AgentStatusEmissionInputs {
  handle: string
  worktreePath: string | null
  branch: string | null
  /** The previous poll's state for this lane, or null when first seen. */
  previous: LaneState | null
  reading: LaneStateReading
}

/**
 * Maps a state *transition* to the one `agent.status` worth logging, or `null`.
 *
 * **Edge-triggered, never a heartbeat.** `buildFleet` folds `agent.status`
 * straight into `lastWorkTs` (`buildFleet.ts:581`), so an organ that
 * re-announced a lane's state every poll would refresh the very silence
 * FROZEN and WAITING are measured against — the prd3 keystone bug, restated by
 * the adapters spike as the mistake "an adapter author will reintroduce if the
 * work/noise split stays implicit". Only a change of state speaks.
 *
 * **`frozen` and `gone` publish nothing, on purpose.**
 *
 * - `frozen`: silence *is* the signal downstream — `detectFrozen` already
 *   fires on `ageMs`. An event announcing the freeze would postpone the very
 *   alarm it announces by a further eight minutes.
 * - `gone`: the union's only candidate is `done`, and `done` is a *claim of
 *   completion* that silences the flatline detector outright
 *   (`detectFrozen` returns null for it). Publishing `done` for a lane whose
 *   process died would convert a crash into a success. prd15 ruling 1 puts
 *   the done-vs-died call downstream where git can make it; this organ must
 *   not pre-empt it with the one word it is not allowed to be wrong about.
 *
 * Both states are still fully derived and readable in the snapshot — they are
 * withheld from *publication*, not from the operator.
 */
export function agentStatusEmissionFor(inputs: AgentStatusEmissionInputs): AgentStatusEmission | null {
  const { reading, previous } = inputs
  if (reading.state === previous) return null
  if (reading.state === 'frozen' || reading.state === 'gone') return null

  return {
    handle: inputs.handle,
    status: reading.state === 'waiting' ? 'waiting' : 'working',
    worktreePath: inputs.worktreePath,
    branch: inputs.branch,
    elapsedSeconds: reading.quietMs === null ? null : Math.floor(reading.quietMs / 1000),
    // Names the witness in the payload. Once the envelope can say
    // `source: 'sessionlog'` this is corroboration; today it is the only place
    // the second witness could sign its name at all.
    detail: `transcript-tail: ${reading.evidence}`,
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function elapsed(now: number, since: number | null): number | null {
  return since === null ? null : Math.max(0, now - since)
}

function describe(
  state: LaneState,
  shape: TurnShape,
  quietMs: number | null,
  writeQuietMs: number | null,
  processAlive: boolean | null,
  threshold: number,
): string {
  const quiet = quietMs === null ? 'quiet unknown' : `quiet ${formatSpan(quietMs)}`
  const write =
    writeQuietMs === null || writeQuietMs === quietMs
      ? null
      : `last write ${formatSpan(writeQuietMs)} ago`
  const process =
    processAlive === true ? 'process alive' : processAlive === false ? 'process gone' : null

  const parts = [
    `${state.toUpperCase()} — tail ${shape}`,
    quiet,
    ...(write === null ? [] : [write]),
    ...(process === null ? [] : [process]),
    `threshold ${formatSpan(threshold)}`,
  ]
  return parts.join(', ')
}

/** Whole seconds under a minute, whole minutes above — no locale, no clock. */
function formatSpan(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}
