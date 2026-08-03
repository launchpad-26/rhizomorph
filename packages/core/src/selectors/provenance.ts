import type { SpanKind } from '../events/index.js'
import type { CommitRecord, SessionState, ToolActivityRecord } from '../state.js'
import { selectCommitsForBranch } from './commits.js'
import { compareStrings } from './touches.js'

/**
 * prd11 ruling 5 — THE WHY SURFACE's data layer: for one file, the causal
 * chain a lane can actually prove today.
 *
 * prd11 ruling 1 is the whole shape of this file: **provenance joins at FILE
 * granularity only.** The chain we can prove is a lane's tool call
 * (`toolUseId`) → the file it touched (`filePath`, ruling 2) → the commit
 * that landed that file (`commit.landed.files`). A hunk inside that commit is
 * never attributed to a particular tool call — no patch capture backs that
 * claim — so nothing here infers it from timestamp proximity or file order.
 * Hunk-level attribution is named future work, never faked.
 *
 * Both selectors read `state.telemetry.tools`/`state.commits` only; neither
 * accumulates anything of its own, same rule as every other selector in this
 * directory.
 */

// --- the drawer's entry list --------------------------------------------------

export interface LaneFileTouch {
  path: string
  /** `tool.activity` records naming this lane whose `filePath` is this path. */
  toolCallCount: number
  /** Commits on this lane's own branch (see below) whose `files` include this path. */
  commitCount: number
  /** Latest ts contributing to either count — the list's own sort key. */
  lastTouchedAt: number
}

/**
 * The files a lane touched, dearest (most recently touched) first — the
 * drawer/page's own "pick a file" list. Two sources of a touch, exactly
 * `selectTouchesByBranch`'s pair but scoped to one lane rather than "vs
 * main": this lane's own tool activity that carries a `filePath`, and
 * commits on this lane's attributed branch (`state.telemetry.lanes[lane]`)
 * whose `files` include the path. A lane with no attributed branch yet still
 * shows whatever its tool activity alone has proven — commits simply add
 * nothing until the branch is known.
 */
export function selectLaneTouches(state: SessionState, lane: string): LaneFileTouch[] {
  const byPath = new Map<string, { toolCallCount: number; commitCount: number; lastTouchedAt: number }>()

  const touch = (path: string, ts: number, kind: 'tool' | 'commit'): void => {
    const entry = byPath.get(path) ?? { toolCallCount: 0, commitCount: 0, lastTouchedAt: ts }
    if (kind === 'tool') entry.toolCallCount += 1
    else entry.commitCount += 1
    entry.lastTouchedAt = Math.max(entry.lastTouchedAt, ts)
    byPath.set(path, entry)
  }

  for (const record of state.telemetry.tools) {
    if (record.lane !== lane || record.filePath === null) continue
    touch(record.filePath, record.ts, 'tool')
  }

  const branch = state.telemetry.lanes[lane]?.branch ?? null
  if (branch !== null) {
    for (const commit of selectCommitsForBranch(state, branch)) {
      for (const file of commit.files) touch(file.path, commit.landedAt, 'commit')
    }
  }

  return [...byPath.entries()]
    .map(([path, entry]) => ({ path, ...entry }))
    .sort((a, b) => b.lastTouchedAt - a.lastTouchedAt || compareStrings(a.path, b.path))
}

// --- one file's chain ---------------------------------------------------------

export interface FileProvenanceFilter {
  path: string
  /**
   * Restrict tool calls to this lane's own causal chain. Omitted, every
   * lane's tool activity against this path is shown — a file's whole history
   * rather than one lane's slice of it. Commits are never lane-filtered
   * (see {@link selectFileProvenance}): the chain follows the file to
   * WHATEVER commit landed it, which is how ruling 1's "branch/prd that
   * ordered it" step reaches a branch other than the lane's own.
   */
  lane?: string
}

/** What `toolUseId` joins to in `trace.span` — the waterfall, for free (ruling 2). */
export interface ProvenanceSpanLink {
  traceId: string
  spanId: string
  kind: SpanKind
  startTs: number
  endTs: number
}

export interface FileProvenanceToolCall {
  eventId: string
  ts: number
  lane: string
  tool: string
  toolUseId: string | null
  /** Null when `toolUseId` is null (no join key) or no span with it has exported yet. */
  span: ProvenanceSpanLink | null
}

export interface FileProvenanceCommit {
  sha: string
  message: string
  branches: string[]
  authoredAt: number
  landedAt: number
}

export type FileProvenanceGapReason = 'no-tool-detail'

export interface FileProvenanceGap {
  reason: FileProvenanceGapReason
  /**
   * The earliest ts, anywhere in the whole log, that any `tool.activity`
   * record carried a non-null `filePath` — evidence of when file-level detail
   * capture began (prd11 #145). Null when the log has never seen one at all,
   * which means the gap is not this file's alone: nothing in this session
   * carries the field yet.
   */
  detailAvailableFromTs: number | null
}

export interface FileProvenanceChain {
  path: string
  /** Echoes the filter — null when the chain was asked for across every lane. */
  lane: string | null
  /** Oldest first: a causal chain reads cause-before-effect, the one list in
   *  this codebase that does not lead with the newest record. */
  toolCalls: FileProvenanceToolCall[]
  /** Oldest first, same reasoning as {@link FileProvenanceChain.toolCalls}. */
  commits: FileProvenanceCommit[]
  /**
   * Non-null when commits prove this file landed but no tool call joins to
   * it by `filePath` — pre-#145 history, or a lane whose sessionlog never
   * emitted the field for this call. Never inferred, only flagged: an absent
   * tool call is never rendered as if it simply never happened.
   */
  gap: FileProvenanceGap | null
}

/**
 * The causal chain for one file (ruling 1): the tool calls that touched it —
 * `toolUseId`-joined to a trace span where one has exported — and the commits
 * whose `files` include it.
 */
export function selectFileProvenance(
  state: SessionState,
  filter: FileProvenanceFilter,
): FileProvenanceChain {
  const { path, lane } = filter
  const spanByToolUseId = indexSpansByToolUseId(state)

  const toolCalls = state.telemetry.tools
    .filter((record) => record.filePath === path && (lane === undefined || record.lane === lane))
    .sort((a, b) => a.ts - b.ts || compareStrings(a.eventId, b.eventId))
    .map((record) => toFileProvenanceToolCall(record, spanByToolUseId))

  const commits = commitsTouching(state, path).map(toFileProvenanceCommit)

  const gap: FileProvenanceGap | null =
    toolCalls.length === 0 && commits.length > 0
      ? { reason: 'no-tool-detail', detailAvailableFromTs: earliestFilePathTs(state) }
      : null

  return { path, lane: lane ?? null, toolCalls, commits, gap }
}

/**
 * `landedAt` ascending — true chronology, unlike `selectCommits`'s own
 * observation order (right for a live ticker, wrong for a chain that has to
 * read cause before effect). `sha` is only the deterministic tiebreak.
 */
function commitsTouching(state: SessionState, path: string): CommitRecord[] {
  const commits: CommitRecord[] = []
  for (const sha of state.commitOrder) {
    const commit = state.commits[sha]
    if (commit === undefined) continue
    if (commit.files.some((file) => file.path === path)) commits.push(commit)
  }
  return commits.sort((a, b) => a.landedAt - b.landedAt || compareStrings(a.sha, b.sha))
}

function toFileProvenanceCommit(commit: CommitRecord): FileProvenanceCommit {
  return {
    sha: commit.sha,
    message: commit.message,
    branches: commit.branches,
    authoredAt: commit.authoredAt,
    landedAt: commit.landedAt,
  }
}

function toFileProvenanceToolCall(
  record: ToolActivityRecord,
  spans: ReadonlyMap<string, ProvenanceSpanLink>,
): FileProvenanceToolCall {
  return {
    eventId: record.eventId,
    ts: record.ts,
    lane: record.lane,
    tool: record.tool,
    toolUseId: record.toolUseId,
    span: record.toolUseId === null ? null : (spans.get(record.toolUseId) ?? null),
  }
}

/** `toolUseId` → the first span that named it. A toolUseId exports once, so first-seen is the only sighting in practice. */
function indexSpansByToolUseId(state: SessionState): Map<string, ProvenanceSpanLink> {
  const index = new Map<string, ProvenanceSpanLink>()
  for (const span of state.traces.spans) {
    if (span.toolUseId === null || index.has(span.toolUseId)) continue
    index.set(span.toolUseId, {
      traceId: span.traceId,
      spanId: span.spanId,
      kind: span.kind,
      startTs: span.startTs,
      endTs: span.endTs,
    })
  }
  return index
}

function earliestFilePathTs(state: SessionState): number | null {
  let earliest: number | null = null
  for (const record of state.telemetry.tools) {
    if (record.filePath === null) continue
    if (earliest === null || record.ts < earliest) earliest = record.ts
  }
  return earliest
}
