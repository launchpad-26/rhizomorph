import {
  parseEventLenient,
  type RhizomorphEvent,
  type UnknownEventLine,
} from '@rhizomorph/core'

/** Mirrors the server's `SessionSummary` shape (`GET /api/sessions`). */
export interface SessionSummary {
  id: string
  fileName: string
  startedAt: number
  sizeBytes: number
}

export type FetchLike = typeof fetch

async function fetchJson(fetchImpl: FetchLike, url: string): Promise<unknown> {
  const response = await fetchImpl(url)
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}`)
  }
  return response.json()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isSessionSummary(value: unknown): value is SessionSummary {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.fileName === 'string' &&
    typeof value.startedAt === 'number' &&
    typeof value.sizeBytes === 'number'
  )
}

/** Lists recorded sessions, oldest first (as the server returns them). */
export async function fetchSessions(fetchImpl: FetchLike = fetch): Promise<SessionSummary[]> {
  const data = await fetchJson(fetchImpl, '/api/sessions')
  const sessions = isRecord(data) && Array.isArray(data.sessions) ? data.sessions : []
  return sessions.filter(isSessionSummary)
}

/**
 * The session with the most recorded history — the one the one-click "replay
 * this session's birth" path should jump to. The API doesn't expose an event
 * count, so `sizeBytes` is the best proxy; restarts leave tiny 1-event stubs,
 * so "largest file" and "most events" agree in practice.
 */
export function pickRichestSession(sessions: readonly SessionSummary[]): SessionSummary | null {
  if (sessions.length === 0) return null
  return sessions.reduce((richest, candidate) =>
    candidate.sizeBytes > richest.sizeBytes ? candidate : richest,
  )
}

/**
 * One session's log as this bundle read it: what it folds, and what it counted
 * but could not.
 *
 * The second half exists because of prd17 ruling 3, item 1. This function used
 * to `parseEvent` each entry and drop the failures on the floor — so a dashboard
 * served by a NEWER instrument than the bundle in the browser (a cached page, a
 * long-lived tab across a deploy, a foreign actor's record replayed through
 * `rhizomorph replay`) folded a quietly shorter history and said nothing. The
 * events it cannot fold are now counted and preserved, and the banner and the
 * session listing say so.
 */
export interface SessionEventsRead {
  events: RhizomorphEvent[]
  /** Entries from an era this bundle does not understand. Preserved, never dropped. */
  unknown: UnknownEventLine[]
}

/**
 * Fetches one session's full event log, leniently. An entry that is not an
 * event at all is still dropped — same tolerance as the server's own JSONL
 * reader for a half-written last line — but one that is an event from an era
 * this bundle has not been taught is counted, not lost.
 *
 * The line preserved on an unknown is `JSON.stringify` of what the API served,
 * not the log's own bytes: the server parsed and re-serialised these on the way
 * out, so the original text is already gone by the time it reaches here. That is
 * honest about what this surface can promise — the byte-for-byte guarantee lives
 * where the bytes do, in `record/read.ts` and the log itself.
 */
export async function fetchSessionEvents(
  sessionId: string,
  fetchImpl: FetchLike = fetch,
): Promise<SessionEventsRead> {
  const data = await fetchJson(fetchImpl, `/api/sessions/${encodeURIComponent(sessionId)}/events`)
  const raw = isRecord(data) && Array.isArray(data.events) ? data.events : []

  const events: RhizomorphEvent[] = []
  const unknown: UnknownEventLine[] = []
  for (const candidate of raw) {
    const parsed = parseEventLenient(candidate)
    if (parsed.kind === 'event') events.push(parsed.event)
    else if (parsed.kind === 'unknown') unknown.push(parsed.unknown)
  }
  return { events, unknown }
}
