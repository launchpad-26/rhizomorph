import type { FetchLike } from '../replay/api.js'

export type { FetchLike }

/**
 * `GET /api/sessions` already computes everything the library needs
 * (`log/listing.ts`'s `SessionListing`, behind the same route the replay
 * picker reads) — this module only parses that response, never recomputes a
 * figure it carries. `transcriptCapture` is optional/nullable exactly as the
 * server's own type states: absent for a listing built before prd16 ruling 3
 * landed, `null` for a session capture never ran against (the still-open live
 * one, or an older recording), present once it has.
 */
export interface CapturedLaneTranscript {
  lane: string
  claudeSessionId: string
  captured: boolean
  bytes: number
  reason?: string
}

export interface TranscriptCaptureManifest {
  sessionId: string
  capturedAt: number
  complete: boolean
  totalBytes: number
  lanes: CapturedLaneTranscript[]
}

export interface RecordingListing {
  id: string
  fileName: string
  startedAt: number
  sizeBytes: number
  title: string
  label: string | null
  lanes: number
  landed: number
  durationMs: number
  outputTokens: number
  costUsd: number
  costIsAuthoritative: boolean | null
  transcriptCapture?: TranscriptCaptureManifest | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isRecordingListing(value: unknown): value is RecordingListing {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.fileName === 'string' &&
    typeof value.startedAt === 'number' &&
    typeof value.sizeBytes === 'number' &&
    typeof value.title === 'string' &&
    (typeof value.label === 'string' || value.label === null) &&
    typeof value.lanes === 'number' &&
    typeof value.landed === 'number' &&
    typeof value.durationMs === 'number' &&
    typeof value.outputTokens === 'number' &&
    typeof value.costUsd === 'number' &&
    (typeof value.costIsAuthoritative === 'boolean' || value.costIsAuthoritative === null)
  )
}

/** Every recording this repo has, oldest first — as the server returns them, never re-sorted or re-derived. */
export async function fetchRecordings(fetchImpl: FetchLike = fetch): Promise<RecordingListing[]> {
  const response = await fetchImpl('/api/sessions')
  if (!response.ok) throw new Error(`/api/sessions responded ${response.status}`)
  const data: unknown = await response.json()
  const sessions = isRecord(data) && Array.isArray(data.sessions) ? data.sessions : []
  return sessions.filter(isRecordingListing)
}
