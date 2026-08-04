import type { RhizomorphEvent } from '@rhizomorph/core'
import { readSessionLabel } from './label.js'
import { readSessionEvents, sessionFilePath, listSessions, type SessionSummary } from './session-log.js'
import { autoTitle, computeSessionMeta } from './title.js'

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
}

/**
 * Builds one session's listing row from its already-loaded events plus its
 * label sidecar. Pulled out of {@link listSessionListings} so callers that
 * already have events in hand (the live session's recorder buffer) don't pay
 * for a redundant disk read.
 */
export function buildSessionListing(
  summary: SessionSummary,
  events: readonly RhizomorphEvent[],
  label: string | null,
): SessionListing {
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
    const events =
      options.liveSessionId === summary.id && options.liveEvents !== undefined
        ? options.liveEvents
        : await readSessionEvents(sessionFilePath(dir, summary.id))
    const label = await readSessionLabel(dir, summary.id)
    listings.push(buildSessionListing(summary, events, label))
  }

  return listings
}
