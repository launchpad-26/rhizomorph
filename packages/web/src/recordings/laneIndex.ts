import type { FetchLike } from '../replay/api.js'
import { capabilityRead } from './capabilityRead.js'

/**
 * THE LANE AXIS'S DATA (prd-31 ruling 8 / S4, #558) — `GET /api/lane-index`,
 * the whole index rather than one handle's slice.
 *
 * **This is what ruling 5's index made possible.** A lane's life is scattered
 * across however many recordings it ran in, and until the index existed there
 * was no way to ask "what work has this repo done" without opening every
 * session and folding it. The route was built for exactly this axis and says so
 * in its own doc (`server/src/api/lane-index.ts`: "the lane axis of ruling 8's
 * history surface reads this").
 *
 * **The wire shape is re-declared here and then CHECKED**, the same posture
 * `lane-page/laneIndex.ts` and `fleet/fences.ts` take: the web bundle does not
 * depend on the server package, so an API body is a contract this side restates
 * and validates. A body from a server older or newer than this bundle degrades
 * to fewer facts, never to a thrown render.
 *
 * **This module deliberately re-declares rather than importing
 * `lane-page/laneIndex.ts`.** The two read the same route family and want
 * different things from it: the run view needs one lane's every session slice
 * in full (it renders a spine out of them), and this axis needs one row per
 * lane. Importing the run view's parser would drag its whole slice shape and
 * its `useLaneIndex` single-handle hook into a page that wants neither, and
 * sharing a parser between two consumers with different tolerances is how one
 * of them ends up dropping a lane the other would have kept. What they *do*
 * share is the contract, which is the server's.
 *
 * **One request, on mount, no poll.** The index is history: it changes when a
 * session closes, not between two frames.
 */

/** One lane, as the history surface's lane axis reads it. */
export interface LaneIndexRow {
  handle: string
  /** The fenced-issue convention's number, e.g. `556` for `556-run-view`. Null when the handle carries none. */
  issue: string | null
  branch: string | null
  /** Epoch ms of the first and last event any recording saw for this lane. */
  firstSeenAt: number | null
  lastSeenAt: number | null
  /** True once a recording watched its worktree go away — the outcome's strongest single fact. */
  worktreeRemoved: boolean
  /** The session ids this lane's life spans, oldest first. */
  sessionIds: string[]
  /** How many commits it landed, across every session it ran in. */
  commitCount: number
  outputTokens: number
  costUsd: number
  /**
   * `true` authoritative, `false` estimated, **`null` no cost telemetry at
   * all** — never collapsed to a number. This is the provenance S4 requires
   * beside the figure in both axes.
   */
  costIsAuthoritative: boolean | null
  /** Recordings this lane appears in that the index itself could not read. */
  missingSessionIds: string[]
}

export interface LaneIndexPage {
  lanes: LaneIndexRow[]
  /**
   * Recordings the index could not read at all — **named and counted, never
   * silently skipped** (S4, ADR-0011's posture). Carried out of the parser
   * rather than logged, because the surface has to say it out loud.
   */
  unreadableSessionIds: string[]
}

export const EMPTY_LANE_INDEX: LaneIndexPage = { lanes: [], unreadableSessionIds: [] }

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * One lane row, folded out of the server's per-session slices.
 *
 * The sums are taken here rather than asked of the server, and that is the
 * cheap half of a deliberate split: the *facts* are the server's (each slice's
 * own tokens, dollars and commits, read from the log), and adding them up is
 * presentation. What is NOT re-derived is the one that matters —
 * `costIsAuthoritative` is folded by the rule the rest of the instrument
 * already uses (null when nothing was ever counted; false the moment any slice
 * was an estimate), so a lane that spans an authoritative session and an
 * estimated one reads as estimated rather than quietly as authoritative.
 */
export function parseLaneRow(value: unknown): LaneIndexRow | null {
  const record = asRecord(value)
  const handle = record === null ? null : asString(record.handle)
  if (record === null || handle === null) return null

  const slices = (Array.isArray(record.sessions) ? record.sessions : [])
    .map(asRecord)
    .filter((slice): slice is Record<string, unknown> => slice !== null)

  let outputTokens = 0
  let costUsd = 0
  let commitCount = 0
  let anyCost = false
  let anyEstimate = false
  const sessionIds: string[] = []

  for (const slice of slices) {
    const id = asString(slice.sessionId)
    if (id !== null) sessionIds.push(id)
    const tokens = asRecord(slice.tokens)
    outputTokens += Math.max(0, asNullableNumber(tokens?.output) ?? 0)
    costUsd += Math.max(0, asNullableNumber(slice.costUsd) ?? 0)
    commitCount += Array.isArray(slice.commits) ? slice.commits.length : 0
    if (typeof slice.costIsAuthoritative === 'boolean') {
      anyCost = true
      if (slice.costIsAuthoritative === false) anyEstimate = true
    }
  }

  return {
    handle,
    issue: asString(record.issue),
    branch: asString(record.branch),
    firstSeenAt: asNullableNumber(record.firstSeenAt),
    lastSeenAt: asNullableNumber(record.lastSeenAt),
    worktreeRemoved: record.worktreeRemoved === true,
    sessionIds,
    commitCount,
    outputTokens,
    costUsd,
    costIsAuthoritative: anyCost ? !anyEstimate : null,
    missingSessionIds: asStrings(record.missingSessionIds),
  }
}

export function parseLaneIndexPage(body: unknown): LaneIndexPage {
  const record = asRecord(body)
  const lanes = (Array.isArray(record?.lanes) ? record.lanes : [])
    .map(parseLaneRow)
    .filter((lane): lane is LaneIndexRow => lane !== null)
  return { lanes, unreadableSessionIds: asStrings(record?.unreadableSessionIds) }
}

export const LANE_INDEX_URL = '/api/lane-index'

/**
 * The whole index, oldest activity last — as the server orders it, never
 * re-sorted here. `/api/lane-index` is a `gated-read` (prd-29 ruling 7, #58),
 * so the default routes through the shared `capabilityRead`, which carries
 * the capability token.
 */
export async function fetchLaneIndex(fetchImpl: FetchLike = capabilityRead): Promise<LaneIndexPage> {
  const response = await fetchImpl(LANE_INDEX_URL)
  if (!response.ok) throw new Error(`${LANE_INDEX_URL} responded ${response.status}`)
  return parseLaneIndexPage(await response.json())
}
