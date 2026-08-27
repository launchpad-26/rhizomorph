import { rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { RhizomorphEvent } from '@rhizomorph/core'
import { readLaneIndex, type LaneIndex } from './lane-index.js'
import { listSessions, type SessionSummary } from './session-log.js'

/**
 * How long a recording is kept, and by what act it goes — prd-44 wave 3 (#38),
 * implementing wave 0's operator answer of 2026-08-27.
 *
 * **There is no default age, and that is the ruling, not an omission.** The
 * operator names the age at the moment they ask, every time. Nothing in this
 * module reads a config file, nothing consults a clock on its own behalf, and a
 * caller that supplies no age gets a {@link RetentionAnswerRefused} rather than
 * a policy. A default age is a policy that reaps a lane nobody thought about,
 * which is exactly the consent this module cannot manufacture. (Newest-N-per-slug
 * was offered and rejected for the same shape plus a worse failure: a quiet
 * week's recording evicted by a busy day's.)
 *
 * **Deletion is an explicit act, and the plan is its ticket.** {@link planRetention}
 * is pure, {@link readRetentionPlan} only reads, and {@link applyRetentionPlan}
 * takes a plan it cannot invent — so "a dry-run reports exactly what would go,
 * and reports it before anything is removed" is structural rather than a habit.
 * There is no timer, no boot sweep, and no side effect of any other command.
 *
 * **What it deletes, and what it deliberately leaves.** Only the event log
 * (`session-<id>.jsonl`) — the bytes that are the disk cost. The label sidecar
 * and the captured transcripts beside it stay, and that is load-bearing for
 * honesty rather than caution: `readLaneIndex` already has a branch for "a
 * capture directory whose session log is gone", which renders the lane with
 * `recordingPresent: false`, a named `gap` and a `partialVoice`
 * (`lane-index.ts`'s `missingRecordingGap`). A pruned lane therefore reads as
 * *pruned* through code that already exists — never as a lane that never
 * existed, which is the dishonest failure prd-31 ruling 5 and ADR-0011 both
 * forbid. {@link LaneHistoryLoss.silent} names the case where even that does
 * not hold, so a plan can say so before an operator agrees to it.
 *
 * **Checked against ADR-0011 ("recordings never rot"), because the names
 * collide.** That ADR governs *parsing* an old recording — lenient parse, a
 * reserved `upcast()`, the golden-era corpus — not how long one is kept. And
 * the corpus it pins the reducer with is a committed repo file
 * (`packages/core/src/eras/era-1/recording.jsonl`) read by hermetic tests that
 * never touch the real data root, so no retention answer can reach it: this
 * module only ever considers files a session directory's own
 * `session-<ts>.jsonl` convention matches. Both halves are pinned by laws. No
 * conflict.
 */

/** The operator's answer, supplied per invocation. No field has a default. */
export interface RetentionAnswer {
  /**
   * How long since a recording was last appended to before it may be pruned.
   * Age is measured from the file's **mtime**, not from the session id: a
   * session started six weeks ago and written to yesterday is a recording of
   * yesterday's work, and pruning it by its start would delete the freshest
   * history the operator has. {@link RetentionCandidate.startedAt} is reported
   * beside it so a dry-run can show both.
   */
  maxAgeMs: number
}

/**
 * The refusal, as a type rather than a message (the shape `CloseNotDurableError`
 * already uses): a caller that named no age, or an unusable one, asked for a
 * policy this module does not have.
 */
export class RetentionAnswerRefused extends Error {
  constructor(readonly given: unknown) {
    super(
      `retention needs an age from the operator, and there is no default: maxAgeMs must be a finite number >= 0, got ${String(given)}. ` +
        'Wave 0 (2026-08-27) ruled that a default age is a policy that reaps a lane nobody thought about.',
    )
    this.name = 'RetentionAnswerRefused'
  }
}

/** One recording the answer would remove. */
export interface RetentionCandidate {
  sessionId: string
  fileName: string
  /** Epoch millis the session started, from its own id — reported, never the age basis. */
  startedAt: number
  /** Epoch millis the log was last appended to — the age basis. */
  lastAppendedAt: number
  ageMs: number
  sizeBytes: number
}

/** What one lane loses if the plan is applied. */
export interface LaneHistoryLoss {
  handle: string
  /** Session ids of this lane's recordings the plan removes, oldest first. */
  lost: string[]
  /** Session ids it keeps, oldest first. */
  kept: string[]
  /** True when every recording of this lane goes — the lane's whole life. */
  whole: boolean
  /**
   * True when at least one lost recording has no captured transcript beside it,
   * so that slice will NOT read as pruned: with no sidecar, `readLaneIndex` has
   * nothing to prove the recording existed and the lane simply thins. The one
   * thing in this module an operator cannot infer from a file count, and the
   * reason {@link voiceRetentionPlan} says it out loud.
   */
  silent: boolean
}

export interface RetentionPlan {
  answer: RetentionAnswer
  /** The clock the plan was measured against, so a report can be re-derived. */
  nowMs: number
  /** Never a candidate, whatever its age. `null` when nothing is being written. */
  liveSessionId: string | null
  /** Oldest first. */
  candidates: RetentionCandidate[]
  /** Session ids the plan keeps, oldest first — the other half of the census. */
  keptSessionIds: string[]
  /** Every lane that loses history, most lost first. */
  lanes: LaneHistoryLoss[]
  /** Total bytes the candidates hold. */
  bytes: number
}

/** One recording as the pure planner needs it — already read, so the planner does no IO. */
export interface RetentionRecording {
  summary: SessionSummary
  lastAppendedAt: number
}

export interface PlanRetentionInput {
  recordings: readonly RetentionRecording[]
  /** The lane index over the same directory, so the plan can name lanes rather than only files. */
  laneIndex: LaneIndex
  liveSessionId: string | null
  answer: RetentionAnswer
  nowMs: number
}

function assertAnswer(answer: RetentionAnswer | undefined): RetentionAnswer {
  const given = answer?.maxAgeMs
  if (typeof given !== 'number' || !Number.isFinite(given) || given < 0) {
    throw new RetentionAnswerRefused(given)
  }
  return { maxAgeMs: given }
}

/**
 * The policy: a pure function of the directory's contents, the operator's
 * answer, and a clock. Deletes nothing and cannot — it has no filesystem to
 * reach. {@link readRetentionPlan} is the thin IO wrapper, the same split
 * `buildLaneIndex`/`readLaneIndex` already uses.
 */
export function planRetention(input: PlanRetentionInput): RetentionPlan {
  const answer = assertAnswer(input.answer)
  const ordered = [...input.recordings].sort((a, b) => a.summary.startedAt - b.summary.startedAt)

  const candidates: RetentionCandidate[] = []
  const keptSessionIds: string[] = []
  for (const recording of ordered) {
    const { id, fileName, startedAt, sizeBytes } = recording.summary
    const ageMs = input.nowMs - recording.lastAppendedAt
    // The live session is never a candidate, whatever its age: it is being
    // appended to, and its age is a measurement of the last write rather than
    // of the operator's interest in it.
    const prunable = id !== input.liveSessionId && ageMs > answer.maxAgeMs
    if (prunable) {
      candidates.push({ sessionId: id, fileName, startedAt, lastAppendedAt: recording.lastAppendedAt, ageMs, sizeBytes })
    } else {
      keptSessionIds.push(id)
    }
  }

  const losing = new Set(candidates.map((candidate) => candidate.sessionId))
  const lanes: LaneHistoryLoss[] = []
  for (const lane of input.laneIndex.lanes) {
    const lost = lane.sessions.filter((slice) => losing.has(slice.sessionId))
    if (lost.length === 0) continue
    lanes.push({
      handle: lane.handle,
      lost: lost.map((slice) => slice.sessionId),
      kept: lane.sessions.filter((slice) => !losing.has(slice.sessionId)).map((slice) => slice.sessionId),
      whole: lost.length === lane.sessions.length,
      // A slice with a transcript is the one `readLaneIndex` can still show as
      // a named gap once the log is gone; a slice without one leaves nothing
      // behind to prove the lane was ever there.
      silent: lost.some((slice) => slice.transcript === null),
    })
  }
  lanes.sort((a, b) => b.lost.length - a.lost.length || a.handle.localeCompare(b.handle))

  return {
    answer,
    nowMs: input.nowMs,
    liveSessionId: input.liveSessionId,
    candidates,
    keptSessionIds,
    lanes,
    bytes: candidates.reduce((total, candidate) => total + candidate.sizeBytes, 0),
  }
}

export interface ReadRetentionPlanOptions {
  answer: RetentionAnswer
  nowMs: number
  /** The session being written right now, if any — never a candidate. */
  liveSessionId?: string | null
  /** The live session's in-memory events, handed straight to the lane index (never re-read from a file mid-append). */
  liveEvents?: readonly RhizomorphEvent[]
}

/**
 * Reads a session directory and returns what the answer would remove. **Removes
 * nothing** — that is {@link applyRetentionPlan}, and a law pins that this
 * function leaves every byte where it was.
 */
export async function readRetentionPlan(
  sessionDir: string,
  options: ReadRetentionPlanOptions,
): Promise<RetentionPlan> {
  const answer = assertAnswer(options.answer)
  const summaries = await listSessions(sessionDir)
  const recordings: RetentionRecording[] = []
  for (const summary of summaries) {
    const info = await stat(path.join(sessionDir, summary.fileName))
    recordings.push({ summary, lastAppendedAt: info.mtimeMs })
  }
  const liveSessionId = options.liveSessionId ?? null
  const laneIndex = await readLaneIndex(sessionDir, {
    ...(liveSessionId !== null ? { liveSessionId } : {}),
    ...(options.liveEvents !== undefined ? { liveEvents: options.liveEvents } : {}),
  })
  return planRetention({ recordings, laneIndex, liveSessionId, answer, nowMs: options.nowMs })
}

/**
 * The dry-run, in the operator's own terms. **Lanes, not only files**: a file
 * count is not something anyone can consent to, and "lane 519-migrate loses two
 * of its three recordings" is.
 */
export function voiceRetentionPlan(plan: RetentionPlan): string[] {
  if (plan.candidates.length === 0) {
    return [`nothing is older than the age you named (${plan.answer.maxAgeMs} ms) — no recording would be removed`]
  }
  const lines = [
    `${plan.candidates.length} recording${plan.candidates.length === 1 ? '' : 's'} older than ${plan.answer.maxAgeMs} ms ` +
      `would be removed, freeing ${plan.bytes} bytes; ${plan.keptSessionIds.length} would stay`,
  ]
  for (const lane of plan.lanes) {
    const total = lane.lost.length + lane.kept.length
    const whole = lane.whole ? ' — its WHOLE recorded life' : ''
    lines.push(
      `lane ${lane.handle} loses ${lane.lost.length} of its ${total} recording${total === 1 ? '' : 's'}${whole} (${lane.lost.join(', ')})`,
    )
    if (lane.silent) {
      lines.push(
        `  and ${lane.handle} has no captured transcript beside ${lane.lost.length === 1 ? 'it' : 'at least one of them'}, ` +
          'so that part of its life will not read as pruned — it will simply be absent',
      )
    }
  }
  return lines
}

/** What an application actually did, per recording. */
export interface RetentionApplied {
  removedSessionIds: string[]
  /** Named rather than silently skipped: already gone by the time we got there. */
  alreadyGoneSessionIds: string[]
  /** Refused at the last moment because it is the session being written now. */
  refusedLiveSessionIds: string[]
  bytesFreed: number
}

export interface ApplyRetentionPlanOptions {
  /**
   * The session being written *now*, re-checked at the moment of deletion
   * rather than trusted from the plan: a rotation between planning and applying
   * would otherwise let a stale plan delete the log a writer holds.
   */
  liveSessionId?: string | null
}

/**
 * Removes exactly the recordings in `plan`, and only those. The operator's
 * explicit act — there is no other caller, no timer and no default that reaches
 * this function, and it cannot build its own plan.
 */
export async function applyRetentionPlan(
  sessionDir: string,
  plan: RetentionPlan,
  options: ApplyRetentionPlanOptions = {},
): Promise<RetentionApplied> {
  const liveSessionId = options.liveSessionId ?? plan.liveSessionId
  const applied: RetentionApplied = {
    removedSessionIds: [],
    alreadyGoneSessionIds: [],
    refusedLiveSessionIds: [],
    bytesFreed: 0,
  }

  for (const candidate of plan.candidates) {
    if (candidate.sessionId === liveSessionId) {
      applied.refusedLiveSessionIds.push(candidate.sessionId)
      continue
    }
    const filePath = path.join(sessionDir, candidate.fileName)
    try {
      await stat(filePath)
    } catch {
      applied.alreadyGoneSessionIds.push(candidate.sessionId)
      continue
    }
    // The log only. The label and the captured transcripts stay, so the lane
    // index still has the sidecar it needs to render this session as a named
    // gap rather than nothing at all — see this module's own header.
    await rm(filePath, { force: true })
    applied.removedSessionIds.push(candidate.sessionId)
    applied.bytesFreed += candidate.sizeBytes
  }

  return applied
}
