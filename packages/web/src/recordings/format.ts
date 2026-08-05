import { formatElapsed } from '../replay/format.js'
import { formatTokens, formatUsd } from '../lib/format.js'
import type { RecordingListing, TranscriptCaptureManifest } from './api.js'

/**
 * THE HONEST-GAP VOICES (prd16 ruling 4) — `SessionListing` already carries
 * `costIsAuthoritative: boolean | null` and an optional/nullable
 * `transcriptCapture`, precisely so a reader can tell "no data" from "zero".
 * This module only speaks those three states; it never turns a `null` into a
 * `0` or a missing capture into a quiet blank.
 */

/** Duration, `h:mm:ss` for anything over an hour — a long recording's mm:ss would misread as under sixty minutes. */
export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  if (hours === 0) return formatElapsed(durationMs)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/**
 * The cost cell's headline: dollars whenever any cost event exists —
 * authoritative or estimated, both are real facts about the recording —
 * output tokens only when `costIsAuthoritative` is `null`, meaning no cost
 * telemetry ever arrived. Never a fabricated `$0.00`.
 */
export function formatCost(recording: Pick<RecordingListing, 'costUsd' | 'costIsAuthoritative' | 'outputTokens'>): string {
  if (recording.costIsAuthoritative === null) return `${formatTokens(recording.outputTokens)} tok out`
  return formatUsd(recording.costUsd)
}

/** Whether the cost cell is speaking a gap rather than a dollar figure — no cost telemetry recorded at all. */
export function isCostGap(recording: Pick<RecordingListing, 'costIsAuthoritative'>): boolean {
  return recording.costIsAuthoritative === null
}

/** The cost cell's hover: what "estimated" or "authoritative" means, or why there is no dollar figure at all. */
export function costHoverTitle(recording: Pick<RecordingListing, 'costIsAuthoritative'>): string {
  if (recording.costIsAuthoritative === null) return 'no cost telemetry recorded for this session'
  if (recording.costIsAuthoritative === false) return 'estimated — not fully authoritative'
  return 'authoritative dollar cost (OTel)'
}

/** `est.` suffix beside the dollar figure — the same convention the fleet table and ledger already use for this exact state. */
export function costSuffix(recording: Pick<RecordingListing, 'costIsAuthoritative'>): string | null {
  return recording.costIsAuthoritative === false ? 'est.' : null
}

/**
 * The capture cell's headline, honoring all three states `transcriptCapture`
 * can be: absent (a listing from before capture existed), `null` (capture
 * never ran — the still-open live session, or an older recording), and a
 * manifest (capture ran, complete or not).
 */
export function formatCapture(recording: Pick<RecordingListing, 'transcriptCapture'>): string {
  const capture = recording.transcriptCapture
  if (capture === undefined) return 'capture status unknown (pre-dates transcript capture)'
  if (capture === null) return 'no transcripts captured'
  if (capture.lanes.length === 0) return 'no transcripts captured'
  const capturedCount = capture.lanes.filter((lane) => lane.captured).length
  if (capture.complete) return `${capturedCount} of ${capturedCount} lanes' transcripts captured`
  return `${capturedCount} of ${capture.lanes.length} lanes' transcripts captured — some missing`
}

/** Whether the capture cell is speaking a gap — anything short of "every attributed lane made it in". */
export function isCaptureGap(recording: Pick<RecordingListing, 'transcriptCapture'>): boolean {
  const capture = recording.transcriptCapture
  return capture === undefined || capture === null || !capture.complete
}

function captureReasons(capture: TranscriptCaptureManifest): string {
  return capture.lanes
    .filter((lane) => !lane.captured)
    .map((lane) => lane.reason ?? `"${lane.lane}" was not captured`)
    .join(' · ')
}

/** The capture cell's hover: the size actually captured, and every gap's own reason — never just "incomplete". */
export function captureHoverTitle(recording: Pick<RecordingListing, 'transcriptCapture'>): string {
  const capture = recording.transcriptCapture
  if (capture === undefined) {
    return 'this recording was made before transcript capture (prd16 ruling 3) existed — its conversations are not in this recording'
  }
  if (capture === null) {
    return 'no capture ever ran for this session — the still-open live session, or a recording from before this feature existed'
  }
  if (capture.complete) return `${capture.totalBytes.toLocaleString()} bytes captured, every attributed lane`
  return `${capture.totalBytes.toLocaleString()} bytes captured — ${captureReasons(capture)}`
}
