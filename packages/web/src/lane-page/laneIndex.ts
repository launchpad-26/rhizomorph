import { useEffect, useState } from 'react'
import type { FetchLike } from '../fleet/manifest.js'
import { capabilityRead } from '../recordings/capabilityRead.js'

/**
 * THE LANE INDEX, client side (prd-31 ruling 5 · #556) — what makes
 * `/lane/:handle` open a week after the worktree is gone.
 *
 * **The wire shape is re-declared here and then CHECKED**, exactly as the lane
 * manifest's body is in `fleet/fences.ts`: the web bundle does not depend on
 * the server package (nothing in a browser may reach for a module that opens
 * files), so an API body is a contract this side restates. {@link parseLaneIndexEntry}
 * is that check — a body from a server older or newer than this bundle degrades
 * to fewer facts, never to a thrown render.
 *
 * **One request, on mount, no poll.** The index is history: it changes when a
 * session closes, not between two frames. The live half of the page is already
 * on the event stream, and adding a second poll for facts that cannot move
 * inside a reader's attention span would be cost with no reading behind it.
 */

export const LANE_INDEX_URL = '/api/lane-index'

/** One commit this lane landed — an outcome claim's evidence. */
export interface LaneIndexCommit {
  sha: string
  message: string
  landedAt: number
  branch: string | null
  fileCount: number
}

/** What capture got for this lane in one session. `captured: false` carries its own reason. */
export interface LaneIndexTranscript {
  captured: boolean
  bytes: number
  reason: string | null
}

/** One session's slice of a lane's life. Mirrors the server's `LaneSessionSlice`. */
export interface LaneIndexSlice {
  sessionId: string
  startedAt: number
  label: string | null
  /** False when the recording could not be read — every count below is then zero because nothing was read. */
  recordingPresent: boolean
  /** Law 12's sentence naming the absent recording; null when it read. */
  gap: string | null
  firstTs: number | null
  lastTs: number | null
  branch: string | null
  worktreePath: string | null
  /** `null` when this recording never saw a worktree for the lane at all — see the server's own note. */
  worktreeRemoved: boolean | null
  outputTokens: number
  costUsd: number
  /** Null when no dollars were counted at all — never rendered as `$0.00`. */
  costIsAuthoritative: boolean | null
  estimateSources: string[]
  toolCallCount: number
  /** Tool name → call count. The names are what the phase inference reads (ruling 7). */
  toolCounts: Record<string, number>
  models: string[]
  interactionCount: number
  files: string[]
  commits: LaneIndexCommit[]
  transcript: LaneIndexTranscript | null
}

export interface LaneIndexEntry {
  handle: string
  issue: string | null
  aliases: string[]
  branch: string | null
  worktreePath: string | null
  worktreeRemoved: boolean
  firstSeenAt: number | null
  lastSeenAt: number | null
  /** Oldest first — one continuous life across however many recordings it spanned. */
  sessions: LaneIndexSlice[]
  missingSessionIds: string[]
  partialVoice: string | null
}

export interface LaneIndexState {
  /** `loading` until the first answer; `absent` is every way of not having one, with its reason. */
  status: 'loading' | 'ready' | 'absent'
  entry: LaneIndexEntry | null
  /** The server's own sentence for a handle it could not find. Never composed here. */
  reason: string | null
  /** Recordings the index itself could not read — the reader is told its reading is partial. */
  unreadableSessionIds: string[]
}

export const LOADING_LANE_INDEX: LaneIndexState = {
  status: 'loading',
  entry: null,
  reason: null,
  unreadableSessionIds: [],
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** A `Record<string, number>` from the wire, keeping only the entries that are one. */
function asCounts(value: unknown): Record<string, number> {
  const record = asRecord(value)
  if (record === null) return {}
  const counts: Record<string, number> = {}
  for (const [key, count] of Object.entries(record)) {
    if (typeof count === 'number' && Number.isFinite(count)) counts[key] = count
  }
  return counts
}

function parseCommit(value: unknown): LaneIndexCommit | null {
  const record = asRecord(value)
  const sha = record === null ? null : asString(record.sha)
  if (record === null || sha === null) return null
  return {
    sha,
    message: typeof record.message === 'string' ? record.message : '',
    landedAt: asNumber(record.landedAt, 0),
    branch: asString(record.branch),
    fileCount: Math.max(0, asNumber(record.fileCount, 0)),
  }
}

function parseTranscript(value: unknown): LaneIndexTranscript | null {
  const record = asRecord(value)
  if (record === null) return null
  return {
    captured: record.captured === true,
    bytes: Math.max(0, asNumber(record.bytes, 0)),
    reason: asString(record.reason),
  }
}

function parseSlice(value: unknown): LaneIndexSlice | null {
  const record = asRecord(value)
  const sessionId = record === null ? null : asString(record.sessionId)
  if (record === null || sessionId === null) return null

  // `recordingPresent` defaults to TRUE when a server never sent it, because a
  // slice a reader is shown as a gap when it is not one is the worse lie: it
  // would report a whole recording missing on the strength of a field that
  // simply predates this bundle.
  const recordingPresent = record.recordingPresent !== false
  const tokens = asRecord(record.tokens)

  return {
    sessionId,
    startedAt: asNumber(record.startedAt, Number(sessionId)),
    label: asString(record.label),
    recordingPresent,
    gap: asString(record.gap),
    firstTs: asNullableNumber(record.firstTs),
    lastTs: asNullableNumber(record.lastTs),
    branch: asString(record.branch),
    worktreePath: asString(record.worktreePath),
    worktreeRemoved: typeof record.worktreeRemoved === 'boolean' ? record.worktreeRemoved : null,
    outputTokens: Math.max(0, asNumber(tokens?.output, 0)),
    costUsd: Math.max(0, asNumber(record.costUsd, 0)),
    costIsAuthoritative: typeof record.costIsAuthoritative === 'boolean' ? record.costIsAuthoritative : null,
    estimateSources: asStrings(record.estimateSources),
    toolCallCount: Math.max(0, asNumber(record.toolCallCount, 0)),
    toolCounts: asCounts(record.toolCounts),
    models: asStrings(record.models),
    interactionCount: Math.max(0, asNumber(record.interactionCount, 0)),
    files: asStrings(record.files),
    commits: (Array.isArray(record.commits) ? record.commits : [])
      .map(parseCommit)
      .filter((commit): commit is LaneIndexCommit => commit !== null),
    transcript: parseTranscript(record.transcript),
  }
}

/** The body's lane, keeping only what this bundle knows how to show. `null` when it is not one. */
export function parseLaneIndexEntry(value: unknown): LaneIndexEntry | null {
  const record = asRecord(value)
  const handle = record === null ? null : asString(record.handle)
  if (record === null || handle === null) return null

  const sessions = (Array.isArray(record.sessions) ? record.sessions : [])
    .map(parseSlice)
    .filter((slice): slice is LaneIndexSlice => slice !== null)
    .sort((a, b) => a.startedAt - b.startedAt)

  return {
    handle,
    issue: asString(record.issue),
    aliases: asStrings(record.aliases),
    branch: asString(record.branch),
    worktreePath: asString(record.worktreePath),
    worktreeRemoved: record.worktreeRemoved === true,
    firstSeenAt: asNullableNumber(record.firstSeenAt),
    lastSeenAt: asNullableNumber(record.lastSeenAt),
    sessions,
    missingSessionIds: asStrings(record.missingSessionIds),
    partialVoice: asString(record.partialVoice),
  }
}

export function laneIndexUrl(handle: string): string {
  return `${LANE_INDEX_URL}/${encodeURIComponent(handle)}`
}

/**
 * `/api/lane-index/:handle` is a `gated-read` (prd-29 ruling 7, #58), so the
 * default routes through the shared `capabilityRead`, which carries the
 * capability token; an injected `fetchImpl` (tests) bypasses it.
 */
function defaultFetch(): FetchLike | null {
  return typeof globalThis.fetch === 'function' ? (capabilityRead as FetchLike) : null
}

/** WHAT is missing → WHY → what to run (law 12), for the two ways the index itself fails. */
function indexGap(detail: string): string {
  return (
    `NO LANE INDEX — ${detail}, so this lane's life cannot be assembled from the recordings — ` +
    'a server older than this page has no `/api/lane-index` — run: `rhizomorph doctor`'
  )
}

export async function loadLaneIndexEntry(handle: string, fetchImpl?: FetchLike): Promise<LaneIndexState> {
  const impl = fetchImpl ?? defaultFetch()
  if (impl === null) {
    return { status: 'absent', entry: null, reason: indexGap('this environment has no fetch at all'), unreadableSessionIds: [] }
  }

  let body: unknown
  let ok: boolean
  try {
    const response = await impl(laneIndexUrl(handle))
    ok = response.ok
    body = await response.json().catch(() => null)
  } catch (error) {
    return {
      status: 'absent',
      entry: null,
      reason: indexGap(`the request failed (${error instanceof Error ? error.message : String(error)})`),
      unreadableSessionIds: [],
    }
  }

  const record = asRecord(body)
  const unreadableSessionIds = asStrings(record?.unreadableSessionIds)

  if (!ok) {
    // The server's own sentence names what it searched (`unknownLaneReason`).
    // Repeating it here in different words is how two surfaces come to disagree
    // about one condition, so this carries it through verbatim.
    const reason = asString(record?.error)
    return {
      status: 'absent',
      entry: null,
      reason: reason ?? indexGap('the index answered without saying why'),
      unreadableSessionIds,
    }
  }

  const entry = parseLaneIndexEntry(record?.lane)
  if (entry === null) {
    return { status: 'absent', entry: null, reason: indexGap('the index answered with a body this page could not read'), unreadableSessionIds }
  }
  return { status: 'ready', entry, reason: null, unreadableSessionIds }
}

/**
 * One lane's index entry, fetched once on mount. `handle === null` is the
 * not-asking case — the conductor's page, which is not a lane in any index.
 */
export function useLaneIndex(handle: string | null, fetchImpl?: FetchLike): LaneIndexState {
  const [state, setState] = useState<LaneIndexState>(LOADING_LANE_INDEX)

  useEffect(() => {
    if (handle === null) {
      setState(LOADING_LANE_INDEX)
      return
    }
    let live = true
    setState(LOADING_LANE_INDEX)
    void loadLaneIndexEntry(handle, fetchImpl).then((next) => {
      if (live) setState(next)
    })
    return () => {
      live = false
    }
  }, [handle, fetchImpl])

  return state
}
