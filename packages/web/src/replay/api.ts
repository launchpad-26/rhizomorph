import { parseEvent, type RhizomorphEvent } from '@rhizomorph/core'

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
 * Fetches one session's full event log. Invalid entries are dropped rather
 * than failing the whole load — same tolerance as the server's own JSONL
 * reader for a half-written last line.
 */
export async function fetchSessionEvents(
  sessionId: string,
  fetchImpl: FetchLike = fetch,
): Promise<RhizomorphEvent[]> {
  const data = await fetchJson(fetchImpl, `/api/sessions/${encodeURIComponent(sessionId)}/events`)
  const raw = isRecord(data) && Array.isArray(data.events) ? data.events : []

  const events: RhizomorphEvent[] = []
  for (const candidate of raw) {
    const parsed = parseEvent(candidate)
    if (parsed.ok) events.push(parsed.event)
  }
  return events
}
