import type { RhizomorphEvent } from '@rhizomorph/core'
import { readSessionLabel } from './label.js'
import {
  readSessionLog,
  sessionFilePath,
  listSessions,
  voiceLargeSession,
  voiceUnreadableLines,
  type SessionSummary,
} from './session-log.js'
import { autoTitle, computeSessionMeta } from './title.js'
import { readTranscriptCaptureManifest, type TranscriptCaptureManifest } from './transcript-capture.js'

/** The events a listing folds, plus how much of the log that took — see `session-log.ts`'s `SessionLogRead`, which this mirrors so a live session (no file to read) can supply the same shape from memory. */
export interface SessionListingLog {
  events: readonly RhizomorphEvent[]
  lineCount: number
  unreadableLineCount: number
}

/** One row for `GET /api/sessions` and `rhizomorph sessions` — everything a human (or the replay picker) needs to find a recording without opening it. */
export interface SessionListing extends SessionSummary {
  /** The label an operator set (`rhizomorph label`), or the auto-title when none exists — never both; the label always wins when present. */
  title: string
  /** The raw operator label, or `null` if unlabelled — `title` already folds this in; this is here so a consumer can tell "labelled" from "auto" (e.g. to style it differently). */
  label: string | null
  lanes: number
  landed: number
  /** Epoch ms between the earliest and latest event; 0 for a session with fewer than two events. */
  durationMs: number
  outputTokens: number
  costUsd: number
  costIsAuthoritative: boolean | null
  /**
   * What transcript capture (prd16 ruling 3) got for this session, or `null`
   * when none ever ran — the still-open live session, or a recording from
   * before this feature existed. `null` is never rendered as "0 bytes
   * captured": a reader must be able to tell "nothing to report yet" from
   * "captured nothing" (see `TranscriptCaptureManifest.complete` for the
   * latter, lane by honest lane). Optional, not just nullable: a listing
   * built by an older caller that never heard of capture is still a valid
   * `SessionListing` without restating this field as `null` everywhere.
   */
  transcriptCapture?: TranscriptCaptureManifest | null
  /**
   * Non-blank lines in this session's log file, how many of those the log's
   * own reader could not fold into an event (an era gap or corruption,
   * counted rather than dropped — prd17 ruling 3, item 1; this is the
   * listing's own accounting of it, previously the one place still silent),
   * and the two sentences an operator reads them as: "could not read N
   * lines" (`null` when every line folded), and "this recording is large (N
   * MB); replay may take a moment" (`null` under the threshold — purely
   * informational; prd16 ruling 1 keeps a session's boundary the operator's,
   * so this never triggers rotation itself). Optional for the same reason
   * `transcriptCapture` is: a listing built by an older caller that never
   * heard of this is still a valid `SessionListing`.
   */
  lineCount?: number
  unreadableLineCount?: number
  unreadableLinesVoice?: string | null
  largeSessionNotice?: string | null
}

/**
 * Builds one session's listing row from its already-loaded log plus its label
 * sidecar. Pulled out of {@link listSessionListings} so callers that already
 * have events in hand (the live session's recorder buffer) don't pay for a
 * redundant disk read.
 */
export function buildSessionListing(
  summary: SessionSummary,
  log: SessionListingLog,
  label: string | null,
  transcriptCapture: TranscriptCaptureManifest | null = null,
): SessionListing {
  const { events, lineCount, unreadableLineCount } = log
  const meta = computeSessionMeta(events)
  const autoTitleText = autoTitle(summary.startedAt, meta)

  let durationMs = 0
  if (events.length > 0) {
    let min = Infinity
    let max = -Infinity
    for (const event of events) {
      if (event.ts < min) min = event.ts
      if (event.ts > max) max = event.ts
    }
    durationMs = max - min
  }

  return {
    ...summary,
    title: label ?? autoTitleText,
    label,
    lanes: meta.lanes,
    landed: meta.landed,
    durationMs,
    outputTokens: meta.outputTokens,
    costUsd: meta.costUsd,
    costIsAuthoritative: meta.costIsAuthoritative,
    transcriptCapture,
    lineCount,
    unreadableLineCount,
    unreadableLinesVoice: voiceUnreadableLines(unreadableLineCount),
    largeSessionNotice: voiceLargeSession(summary.sizeBytes),
  }
}

export interface ListSessionListingsOptions {
  /** The live session's id and already-in-memory events (`recorder.eventsSoFar()`) — read from there instead of disk, so a listing request can never race the writer's append (same rule `/api/sessions/:id/events` already follows). */
  liveSessionId?: string
  liveEvents?: readonly RhizomorphEvent[]
}

/**
 * Every session recorded for a repo, each fully parsed. A full parse rather
 * than a bounded head/tail sample: this only runs once per page load (the
 * replay picker fetches it on mount, not on a poll) or once per CLI
 * invocation, and a lane's landing can occur anywhere in a session's
 * timeline — sampling the head or tail would silently miss a landing that
 * happened in the middle of a long session, which is exactly the fact this
 * listing exists to surface. Correctness wins here because nothing repeats
 * this call often enough for the cost to matter.
 */
export async function listSessionListings(
  dir: string,
  options: ListSessionListingsOptions = {},
): Promise<SessionListing[]> {
  const summaries = await listSessions(dir)
  const listings: SessionListing[] = []

  for (const summary of summaries) {
    // The live session's buffer only ever holds events that already passed
    // `createEvent`'s own validation, so it has nothing to count as unreadable —
    // one line per event, exactly, unlike a file that may hold a half-written
    // tail or an era-gap line.
    const log: SessionListingLog =
      options.liveSessionId === summary.id && options.liveEvents !== undefined
        ? { events: options.liveEvents, lineCount: options.liveEvents.length, unreadableLineCount: 0 }
        : await readSessionLog(sessionFilePath(dir, summary.id))
    const label = await readSessionLabel(dir, summary.id)
    const transcriptCapture = await readTranscriptCaptureManifest(dir, summary.id)
    listings.push(buildSessionListing(summary, log, label, transcriptCapture))
  }

  return listings
}
