import type { DisclosureContent } from '../disclosure/index.js'
import { formatTokens, formatUsd } from '../lib/format.js'
import type { RecordingListing, TranscriptCaptureManifest } from './api.js'

export { formatDuration } from '../lib/format.js'

/**
 * THE HONEST-GAP VOICES (prd16 ruling 4) — `SessionListing` already carries
 * `costIsAuthoritative: boolean | null` and an optional/nullable
 * `transcriptCapture`, precisely so a reader can tell "no data" from "zero".
 * This module only speaks those three states; it never turns a `null` into a
 * `0` or a missing capture into a quiet blank.
 */

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
/** A finished recording's cost provenance (#220). Settled history — see `laneFormat.ts` on the age. */
export function costHoverDisclosure(
  recording: Pick<RecordingListing, 'costIsAuthoritative'>,
): DisclosureContent {
  if (recording.costIsAuthoritative === null) {
    return {
      label: '$',
      why: {
        reason: 'no cost telemetry was recorded for this session',
        evidence: { fact: 'not one cost event was folded while it ran', elapsedMs: 0 },
      },
      remedy: { kind: 'none', because: 'the session is over — a cost never captured cannot be recovered from the record' },
    }
  }
  if (recording.costIsAuthoritative === false) {
    return {
      label: '$',
      why: {
        reason: 'estimated — not fully authoritative',
        evidence: { fact: 'part of this figure was priced from a vendored table rather than reported', elapsedMs: 0 },
      },
      remedy: { kind: 'none', because: 'this is the best figure the recording holds' },
    }
  }
  return {
    label: '$',
    why: {
      reason: 'authoritative dollar cost',
      evidence: { fact: 'the agent CLI reported every figure itself (OTel)', elapsedMs: 0 },
    },
    remedy: { kind: 'none', because: 'the figure comes from the CLI itself' },
  }
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

/**
 * Whether capture never ran at all — the pre-instrument NORM, as distinct from
 * a partial capture (which is a fault in a session that was being watched).
 * The list page uses this to let absence recede to dim ink while "some
 * missing" keeps full volume: eleven identical warnings are quieter than one
 * (loop 16), but the gap mark itself stays on every gap row — the honesty law
 * in RecordingsPage.test.tsx pins it.
 */
export function isCaptureAbsent(recording: Pick<RecordingListing, 'transcriptCapture'>): boolean {
  const capture = recording.transcriptCapture
  return capture === undefined || capture === null || capture.lanes.length === 0
}

function captureReasons(capture: TranscriptCaptureManifest): string {
  return capture.lanes
    .filter((lane) => !lane.captured)
    .map((lane) => lane.reason ?? `"${lane.lane}" was not captured`)
    .join(' · ')
}

/** The capture cell's hover: the size actually captured, and every gap's own reason — never just "incomplete". */
export function captureHoverDisclosure(
  recording: Pick<RecordingListing, 'transcriptCapture'>,
): DisclosureContent {
  const capture = recording.transcriptCapture
  if (capture === undefined) {
    return {
      label: 'capture',
      why: {
        reason: 'this recording predates transcript capture (prd16 ruling 3)',
        evidence: { fact: 'its conversations are not in this recording', elapsedMs: 0 },
      },
      remedy: { kind: 'none', because: 'nothing can be captured retrospectively — later recordings carry their transcripts' },
    }
  }
  if (capture === null) {
    return {
      label: 'capture',
      why: {
        reason: 'no capture ever ran for this session',
        evidence: { fact: 'the still-open live session, or a recording from before this feature existed', elapsedMs: 0 },
      },
      remedy: { kind: 'none', because: 'a live session captures when it closes; an old one cannot be made to' },
    }
  }
  if (capture.complete) {
    return {
      label: 'capture',
      why: {
        reason: 'every attributed lane was captured',
        evidence: { fact: `${capture.totalBytes.toLocaleString()} bytes captured`, elapsedMs: 0 },
      },
      remedy: { kind: 'none', because: 'a complete capture is the wanted state' },
    }
  }
  return {
    label: 'capture',
    why: {
      reason: 'the capture is incomplete',
      evidence: {
        fact: `${capture.totalBytes.toLocaleString()} bytes captured — ${captureReasons(capture)}`,
        elapsedMs: 0,
      },
    },
    remedy: {
      kind: 'action',
      action: 'the reasons above name what was missed; a lane whose transcript was unreadable at capture time cannot be recovered from this record',
    },
  }
}
