import { readdir } from 'node:fs/promises'
import path from 'node:path'
import {
  reduceAll,
  selectCommitsForBranch,
  selectLaneInteractions,
  selectLaneTouches,
  selectSpendForLane,
  type RhizomorphEvent,
  type SessionState,
  type TokenTotals,
} from '@rhizomorph/core'
import { readSessionLabel } from './label.js'
import { listSessions, readSessionLog, sessionFilePath, type SessionSummary } from './session-log.js'
import {
  readTranscriptCaptureManifest,
  type CapturedLaneTranscript,
  type TranscriptCaptureManifest,
} from './transcript-capture.js'

/**
 * THE LANE INDEX (prd-31 ruling 5 · #556) — lane handle (and issue number,
 * where one exists) → the sessions it appears in → its events and captured
 * transcripts.
 *
 * **This is part of the ruling, not an optimisation of it.** `workmux merge`
 * deletes a worktree the moment work lands, which is exactly when a person most
 * wants to read what happened; and a lane that ran across three sessions has
 * its life scattered across three recordings with nothing tying them together.
 * Without this file, `/lane/519-migrate` cannot be opened a week later, because
 * the reader would first have to know which recording to open — and the answer
 * is "some of them".
 *
 * **Nothing here touches a worktree.** That is the whole durability clause and
 * it is structural rather than remembered: the only things this module opens
 * are session logs and the capture sidecars beside them, both of which live in
 * the repo's session directory and outlive every worktree they describe. A
 * lane's worktree state is read from the log's own `worktree.removed` events
 * ({@link LaneSessionSlice.worktreeRemoved}), never from `fs.stat` on a path
 * that may no longer exist — a stat would be the one field that works while the
 * worktree lives and lies once it does not.
 *
 * **A missing recording is named, never silently skipped** (ADR-0011's posture,
 * and S2's *partial* state). A capture sidecar survives its session log, so a
 * session whose log is gone but whose `transcripts/<id>/manifest.json` names
 * this lane is *proof* the lane spanned a session this index cannot read. That
 * session appears in the lane's life with `recordingPresent: false` and a law-12
 * sentence saying which session is absent — a reader is told their reading is
 * partial rather than shown a shorter life and left to believe it.
 *
 * **Everything is derived through core's own selectors.** The per-session facts
 * below are `reduceAll` plus `selectSpendForLane` / `selectLaneTouches` /
 * `selectLaneInteractions` / `selectCommitsForBranch` — no arithmetic of this
 * module's own, so the index and the live page can never disagree about a
 * number (ADR-0002's one-reducer rule, applied to a second reader).
 */

/** One commit this lane landed, reduced to what an outcome claim needs as evidence. */
export interface LaneIndexCommit {
  sha: string
  message: string
  landedAt: number
  branch: string | null
  fileCount: number
}

/**
 * One session's slice of a lane's life. Always present for a session the lane
 * appears in — including a session whose recording is gone, which is the whole
 * reason this carries {@link recordingPresent} rather than being absent.
 */
export interface LaneSessionSlice {
  sessionId: string
  /** Epoch millis the session started, from its own id. */
  startedAt: number
  /**
   * The operator's label for the recording, or `null` when it is unlabelled.
   * Deliberately not the listing's auto-title: that needs a second whole fold
   * per session ({@link computeSessionMeta}) to say something a reader of *this*
   * surface already has — the session's date, from {@link startedAt}.
   */
  label: string | null
  /**
   * False when this session's log could not be read at all and the lane's
   * presence in it is known only from a capture sidecar. Every count below is
   * then zero *because nothing was read*, which is what {@link gap} says out
   * loud — a reader must never take those zeroes for measurements.
   */
  recordingPresent: boolean
  /** WHAT → WHY (law 12) for a missing recording. `null` when the log read. */
  gap: string | null
  /** First and last event ts naming this lane in this session. Null when nothing was read. */
  firstTs: number | null
  lastTs: number | null
  /** Events in the whole recording — the reading's own size, not the lane's. */
  eventCount: number
  /** Lines this era could not fold. Counted rather than dropped (prd17 ruling 3). */
  unreadableLineCount: number
  branch: string | null
  worktreePath: string | null
  /**
   * True when this recording holds a `worktree.removed` for this lane's
   * worktree, false when it holds the worktree and no removal — and **`null`
   * when this recording never saw a worktree record at all**.
   *
   * Three values rather than two, because a lane can be torn down and
   * re-dispatched under the same handle. Folding "did not observe" into `false`
   * would let a telemetry-only recording quietly un-remove a worktree an
   * earlier one watched go; folding it into `true` would report a live lane as
   * folded. `null` is the only reading that lets {@link LaneIndexEntry.worktreeRemoved}
   * take the newest recording that actually knew.
   */
  worktreeRemoved: boolean | null
  tokens: TokenTotals
  costUsd: number
  /** `null` when no dollars were counted at all — the case a reader must not see as `$0.00`. */
  costIsAuthoritative: boolean | null
  /** Which vendored price tables contributed an estimate, e.g. `['langfuse-prices@cfac485']`. */
  estimateSources: string[]
  requestCount: number
  toolCallCount: number
  /**
   * Tool name → call count. The *names*, not just the total, because the run
   * view's phase inference is "reads-only reads as exploring, writes as
   * implementing, test commands as verifying" (ruling 7) — a count alone cannot
   * answer that, and a client that had to guess from a total would be inferring
   * a phase from nothing.
   */
  toolCounts: Record<string, number>
  models: string[]
  /** Interaction roots this lane produced in this session — the run view's spine length. */
  interactionCount: number
  /** Files this lane touched, most recently first. */
  files: string[]
  commits: LaneIndexCommit[]
  /**
   * What transcript capture got for this lane in this session, or `null` when
   * no capture ever ran (a still-open session, or a recording older than the
   * feature). `null` is never "captured nothing" — see
   * {@link CapturedLaneTranscript.captured} for that.
   */
  transcript: CapturedLaneTranscript | null
}

/** One lane's whole life, however many sessions it spanned. */
export interface LaneIndexEntry {
  /** The telemetry handle, or the branch for a lane only git ever saw. */
  handle: string
  /** The fenced-issue convention's number, when the handle carries one. */
  issue: string | null
  /** Every name this lane answers to — handle, branch, worktree basename. */
  aliases: string[]
  branch: string | null
  /** The last worktree path anything associated with this lane. Stays populated once it is gone. */
  worktreePath: string | null
  /**
   * The newest recording that actually observed a worktree for this lane, and
   * whether it had gone by the end of it — the landed-and-folded case. False
   * when no recording ever saw one, which is honestly "not observed folding"
   * rather than "still there".
   */
  worktreeRemoved: boolean
  firstSeenAt: number | null
  lastSeenAt: number | null
  /** Oldest session first, so the slices read as one continuous life. */
  sessions: LaneSessionSlice[]
  /** Ids of the sessions above whose recording could not be read. */
  missingSessionIds: string[]
  /** The one sentence a reader gets when part of the life is missing; `null` when it is whole. */
  partialVoice: string | null
}

export interface LaneIndex {
  /** Newest activity first — the order a history surface lists lanes in. */
  lanes: LaneIndexEntry[]
  /** Sessions whose recording could not be read, named and counted (ADR-0011). */
  unreadableSessionIds: string[]
}

/** The fenced-issue convention's number, e.g. `'556'` for `556-run-view`. */
function issueOf(handle: string): string | null {
  return /^\d+/.exec(handle)?.[0] ?? null
}

function zeroTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 }
}

/**
 * WHAT is missing → WHY → nothing to run (law 12). There is no command that
 * makes a deleted recording reappear, so this states the loss and names the
 * session rather than offering a remedy it cannot deliver.
 */
function missingRecordingGap(sessionId: string, handle: string): string {
  return (
    `RECORDING MISSING for session ${sessionId} — this lane's captured transcript is beside it but ` +
    `its event log is not, so the part of "${handle}"'s life that ran in that session cannot be read ` +
    'here — what is shown is the rest of it'
  )
}

/** The lane's own summary of how much of its life is unreadable. */
function partialVoice(missing: readonly string[], total: number): string | null {
  if (missing.length === 0) return null
  const subject = missing.length === 1 ? '1 session' : `${missing.length} sessions`
  return (
    `${subject} of this lane's ${total} could not be read (${missing.join(', ')}) — this reading is ` +
    'partial, and the gap is where those sessions were'
  )
}

/** One recording, already read, plus the sidecars beside it. */
export interface LaneIndexSession {
  summary: Pick<SessionSummary, 'id' | 'startedAt'>
  /**
   * The recording's events, or `null` when its log could not be read at all —
   * the missing-recording case, which is a named gap and not an empty list.
   */
  events: readonly RhizomorphEvent[] | null
  unreadableLineCount: number
  label: string | null
  capture: TranscriptCaptureManifest | null
}

/**
 * Every lane any of these recordings ever named, with its life assembled across
 * them. Pure over already-read input, so the whole index is testable without a
 * filesystem — {@link readLaneIndex} is the thin IO wrapper.
 *
 * Sessions arrive in whatever order the caller listed them and are sorted here
 * by start, so a lane's slices always read oldest first regardless.
 */
export function buildLaneIndex(sessions: readonly LaneIndexSession[]): LaneIndex {
  const ordered = [...sessions].sort((a, b) => a.summary.startedAt - b.summary.startedAt)
  const entries = new Map<string, LaneIndexEntry>()
  const unreadableSessionIds: string[] = []

  const entryFor = (handle: string): LaneIndexEntry => {
    const existing = entries.get(handle)
    if (existing !== undefined) return existing
    const created: LaneIndexEntry = {
      handle,
      issue: issueOf(handle),
      aliases: [handle],
      branch: null,
      worktreePath: null,
      worktreeRemoved: false,
      firstSeenAt: null,
      lastSeenAt: null,
      sessions: [],
      missingSessionIds: [],
      partialVoice: null,
    }
    entries.set(handle, created)
    return created
  }

  for (const session of ordered) {
    if (session.events === null) {
      unreadableSessionIds.push(session.summary.id)
      // A capture sidecar outlives the log beside it, so it is the one witness
      // left that this lane ran here at all. Every lane it names gets the gap.
      for (const lane of session.capture?.lanes ?? []) {
        const entry = entryFor(lane.lane)
        entry.sessions.push(missingSlice(session, lane, lane.lane))
        entry.missingSessionIds.push(session.summary.id)
      }
      continue
    }

    const state = reduceAll(session.events)

    for (const handle of laneHandlesOf(state)) {
      const entry = entryFor(handle)
      const slice = sliceFor(session, state, handle)
      entry.sessions.push(slice)
      absorb(entry, slice)
    }
  }

  for (const entry of entries.values()) {
    entry.sessions.sort((a, b) => a.startedAt - b.startedAt)
    entry.partialVoice = partialVoice(entry.missingSessionIds, entry.sessions.length)
    entry.aliases = [
      ...new Set(
        [entry.handle, entry.branch, entry.worktreePath === null ? null : basenameOf(entry.worktreePath)].filter(
          (alias): alias is string => alias !== null && alias.length > 0,
        ),
      ),
    ]
  }

  const lanes = [...entries.values()].sort(
    (a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) || compare(a.handle, b.handle),
  )
  return { lanes, unreadableSessionIds }
}

/** The slice for a session whose log is gone: a named gap, and no invented numbers. */
function missingSlice(
  session: LaneIndexSession,
  lane: CapturedLaneTranscript,
  handle: string,
): LaneSessionSlice {
  return {
    sessionId: session.summary.id,
    startedAt: session.summary.startedAt,
    label: session.label,
    recordingPresent: false,
    gap: missingRecordingGap(session.summary.id, handle),
    firstTs: null,
    lastTs: null,
    eventCount: 0,
    unreadableLineCount: 0,
    branch: null,
    worktreePath: null,
    worktreeRemoved: null,
    tokens: zeroTokens(),
    costUsd: 0,
    costIsAuthoritative: null,
    estimateSources: [],
    requestCount: 0,
    toolCallCount: 0,
    toolCounts: {},
    models: [],
    interactionCount: 0,
    files: [],
    commits: [],
    transcript: lane,
  }
}

/**
 * Every lane a recording names: telemetry's own handles, plus the branch of any
 * non-main worktree git saw. The second half matters — a lane whose agent was
 * never instrumented still has a worktree, commits and a branch, and a run view
 * that could not open it would be reporting emptiness for work that happened.
 */
function laneHandlesOf(state: SessionState): string[] {
  const handles = new Set(Object.keys(state.telemetry.lanes))
  for (const worktree of Object.values(state.worktrees)) {
    if (worktree.isMain || worktree.branch === null) continue
    handles.add(worktree.branch)
  }
  return [...handles].sort(compare)
}

function sliceFor(session: LaneIndexSession, state: SessionState, handle: string): LaneSessionSlice {
  const attribution = state.telemetry.lanes[handle] ?? null
  const spend = selectSpendForLane(state, handle)
  const capturedLane = session.capture?.lanes.find((entry) => entry.lane === handle) ?? null

  // The branch: what telemetry attributed, else the handle itself when git saw
  // a worktree on a branch of that name (the uninstrumented-lane case above).
  const worktreeByBranch = Object.values(state.worktrees).find(
    (worktree) => !worktree.isMain && worktree.branch === handle,
  )
  const branch = attribution?.branch ?? worktreeByBranch?.branch ?? null
  const worktreePath = attribution?.worktreePath ?? worktreeByBranch?.path ?? null
  const worktree = worktreePath === null ? undefined : state.worktrees[worktreePath]

  const commits =
    branch === null
      ? []
      : selectCommitsForBranch(state, branch).map((commit) => ({
          sha: commit.sha,
          message: commit.message,
          landedAt: commit.landedAt,
          branch,
          fileCount: commit.files.length,
        }))

  const firstTs = attribution?.firstSeenAt ?? worktree?.discoveredAt ?? null
  const lastTs = attribution?.lastSeenAt ?? worktree?.removedAt ?? worktree?.discoveredAt ?? null

  return {
    sessionId: session.summary.id,
    startedAt: session.summary.startedAt,
    label: session.label,
    recordingPresent: true,
    gap: null,
    firstTs,
    lastTs,
    eventCount: session.events?.length ?? 0,
    unreadableLineCount: session.unreadableLineCount,
    branch,
    worktreePath,
    // `present: false` is the log's own record of `worktree.removed` — the
    // landed-and-folded fact, learned from the event and never from the disk.
    // `undefined` is a recording that never saw a worktree for this lane at
    // all, which is a third answer, not a `false`.
    worktreeRemoved: worktree === undefined ? null : !worktree.present,
    tokens: spend?.tokens ?? zeroTokens(),
    costUsd: spend?.costUsd ?? 0,
    costIsAuthoritative: spend?.costIsAuthoritative ?? null,
    estimateSources: spend?.estimateSources ?? [],
    requestCount: spend?.requestCount ?? 0,
    toolCallCount: spend?.toolCallCount ?? 0,
    toolCounts: spend?.toolCounts ?? {},
    models: spend?.models ?? [],
    interactionCount: selectLaneInteractions(state, handle).length,
    files: selectLaneTouches(state, handle).map((touch) => touch.path),
    commits,
    transcript: capturedLane,
  }
}

/**
 * Roll one slice's facts up into the lane's own identity. Slices arrive oldest
 * first, so later sessions win a non-null — which is what makes a lane torn
 * down and re-dispatched under the same handle read as working again rather
 * than staying folded forever on the strength of one old recording.
 */
function absorb(entry: LaneIndexEntry, slice: LaneSessionSlice): void {
  if (slice.branch !== null) entry.branch = slice.branch
  if (slice.worktreePath !== null) entry.worktreePath = slice.worktreePath
  if (slice.worktreeRemoved !== null) entry.worktreeRemoved = slice.worktreeRemoved
  if (slice.firstTs !== null) {
    entry.firstSeenAt = entry.firstSeenAt === null ? slice.firstTs : Math.min(entry.firstSeenAt, slice.firstTs)
  }
  if (slice.lastTs !== null) {
    entry.lastSeenAt = entry.lastSeenAt === null ? slice.lastTs : Math.max(entry.lastSeenAt, slice.lastTs)
  }
}

function basenameOf(filePath: string): string {
  return path.basename(filePath)
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The one lane an index answers a `/lane/:handle` request with, or `null`.
 *
 * Matching is by any name the lane answers to — handle, branch, worktree
 * basename — and then by issue number, because the ruling says a lane opens
 * "by handle or issue" and `519` is what a person reading a PR actually has. An
 * exact alias always beats an issue match, so a handle that is itself a number
 * can never be shadowed by a different lane's issue.
 */
export function findLaneInIndex(index: LaneIndex, handle: string): LaneIndexEntry | null {
  const exact = index.lanes.find((entry) => entry.aliases.includes(handle))
  if (exact !== undefined) return exact
  return index.lanes.find((entry) => entry.issue !== null && entry.issue === handle) ?? null
}

/** Session ids that have a capture directory — the witnesses that outlive a log. */
async function listCapturedSessionIds(sessionDir: string): Promise<string[]> {
  try {
    return await readdir(path.join(sessionDir, 'transcripts'))
  } catch {
    return []
  }
}

export interface ReadLaneIndexOptions {
  /** The live session's id and in-memory events, read from there rather than from a file mid-append. */
  liveSessionId?: string
  liveEvents?: readonly RhizomorphEvent[]
}

/**
 * The index for a repo's whole session directory.
 *
 * A full parse of every recording, for {@link listSessionListings}' own reason:
 * a lane's life can start anywhere in a session's timeline, so a head/tail
 * sample would silently drop the middle of it — and this runs once per run-view
 * open, not on a poll.
 */
export async function readLaneIndex(
  sessionDir: string,
  options: ReadLaneIndexOptions = {},
): Promise<LaneIndex> {
  const summaries = await listSessions(sessionDir)
  const known = new Set(summaries.map((summary) => summary.id))
  const sessions: LaneIndexSession[] = []

  for (const summary of summaries) {
    const live = options.liveSessionId === summary.id && options.liveEvents !== undefined
    const read = live
      ? { events: options.liveEvents as readonly RhizomorphEvent[], unreadableLineCount: 0 }
      : await readSessionLog(sessionFilePath(sessionDir, summary.id))
    sessions.push({
      summary,
      events: read.events,
      unreadableLineCount: read.unreadableLineCount,
      label: await readSessionLabel(sessionDir, summary.id),
      capture: await readTranscriptCaptureManifest(sessionDir, summary.id),
    })
  }

  // A capture directory whose session log is gone is the proof a recording is
  // missing rather than a lane simply never having existed. `events: null` is
  // what carries that distinction into the fold.
  for (const sessionId of await listCapturedSessionIds(sessionDir)) {
    if (known.has(sessionId)) continue
    const capture = await readTranscriptCaptureManifest(sessionDir, sessionId)
    if (capture === null) continue
    sessions.push({
      summary: { id: sessionId, startedAt: Number(sessionId) },
      events: null,
      unreadableLineCount: 0,
      label: await readSessionLabel(sessionDir, sessionId),
      capture,
    })
  }

  return buildLaneIndex(sessions)
}
