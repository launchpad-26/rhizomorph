import type { FetchLike } from '../replay/api.js'
import { capabilityRead } from './capabilityRead.js'

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
  /**
   * The server's own sentence for lines in this recording it could not fold
   * (prd17 ruling 3, item 1) — `null` or absent when every line read.
   *
   * The listing has carried it since it landed and no surface rendered it, so a
   * recording that lost lines looked exactly like one that did not. prd-31 S4
   * asks that an unreadable record be named and counted rather than silently
   * skipped; this is that requirement one level down from a whole missing file,
   * and #558 is where it starts being shown. Optional, like the two fields
   * above and for the same reason: a listing from an older server is still a
   * valid `RecordingListing` without it.
   */
  unreadableLinesVoice?: string | null
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

// `unreadableLinesVoice` is deliberately NOT in the guard above: a server that
// predates it must still produce a valid listing, and requiring the field would
// drop every one of its recordings from the library rather than showing them
// without one line of chrome. It is read where it is rendered, and `undefined`
// reads as "nothing to say" — which for a server that never counted is exactly
// the honest answer.

/** Every recording this repo has, oldest first — as the server returns them, never re-sorted or re-derived. */
export async function fetchRecordings(fetchImpl: FetchLike = capabilityRead): Promise<RecordingListing[]> {
  const response = await fetchImpl('/api/sessions')
  if (!response.ok) throw new Error(`/api/sessions responded ${response.status}`)
  const data: unknown = await response.json()
  const sessions = isRecord(data) && Array.isArray(data.sessions) ? data.sessions : []
  return sessions.filter(isRecordingListing)
}
