import { useEffect, useRef } from 'react'
import type { FetchLike } from '../fleet/manifest.js'
import { useTranscript, type TranscriptEntry } from '../drawer/index.js'

/**
 * How many "load earlier" pages one jump will chase before giving up. A
 * backstop against a click on a very old tool call triggering an unbounded
 * walk back through a whole session log — bounded the same way #134's own
 * catch-up burst is (`useTranscript.ts`'s `MAX_CATCHUP_PAGES`), just smaller:
 * this is a manual, one-row action, not a live tail.
 */
export const MAX_LOOKBACK_PAGES = 20

export interface NearestEntryProps {
  lane: string
  /** Epoch millis — the tool call this is jumping toward. */
  targetTs: number
  fetchImpl?: FetchLike
}

/**
 * THE CONVERSATION DEEP-LINK (prd11 ruling 5) — "jump-to nearest entry is
 * enough; perfect alignment is future work", stated honestly in the title
 * attr below rather than implied by a confident-looking jump.
 *
 * The transcript route pages by byte offset, not by time (`transcript.ts` has
 * no ts-indexed read), so there is no single request that lands on "the turn
 * at time T". This pages backward from the tail with the exact `loadEarlier`
 * the drawer's own `Conversation` uses (#134), stopping once the oldest
 * loaded entry is at or before `targetTs`, the log's own start is reached, or
 * {@link MAX_LOOKBACK_PAGES} is spent — then picks whichever loaded entry's
 * own timestamp sits closest. `pollMs: 0` (a documented `useTranscript` test
 * seam, used here for its literal meaning) means this reads once and pages
 * deliberately, never tails.
 */
export function NearestEntry({ lane, targetTs, fetchImpl }: NearestEntryProps) {
  const tail = useTranscript(lane, { fetchImpl, pollMs: 0 })
  const pagesSpent = useRef(0)
  const { loadEarlier } = tail

  useEffect(() => {
    pagesSpent.current = 0
  }, [lane, targetTs])

  useEffect(() => {
    if (tail.status !== 'ready' || tail.earliestOffset <= 0) return
    if (pagesSpent.current >= MAX_LOOKBACK_PAGES) return
    const oldest = tail.entries[0]
    const oldestTs = oldest === undefined ? null : entryTs(oldest)
    if (oldestTs !== null && oldestTs <= targetTs) return
    pagesSpent.current += 1
    void loadEarlier()
  }, [tail.status, tail.entries, tail.earliestOffset, targetTs, loadEarlier])

  if (tail.status === 'absent' || tail.status === 'error') {
    return (
      <p role="status" data-testid="why-nearest-entry-gap" className="mt-1 pl-4 text-[10px] leading-snug text-ice-400">
        {tail.reason}
      </p>
    )
  }

  if (tail.status !== 'ready' || tail.entries.length === 0) {
    return (
      <p role="status" className="mt-1 pl-4 text-[10px] text-ice-400">
        reading the session log…
      </p>
    )
  }

  const nearest = nearestEntry(tail.entries, targetTs)
  const oldestLoaded = tail.entries[0]
  const oldestLoadedTs = oldestLoaded === undefined ? null : entryTs(oldestLoaded)
  const stillPaging =
    tail.earliestOffset > 0 &&
    pagesSpent.current < MAX_LOOKBACK_PAGES &&
    (oldestLoadedTs === null || oldestLoadedTs > targetTs)

  if (nearest === null) {
    return (
      <p role="status" className="mt-1 pl-4 text-[10px] text-ice-400">
        {stillPaging ? 'paging earlier for a timestamped turn…' : 'no timestamped turn loaded near this call'}
      </p>
    )
  }

  return (
    <div
      data-testid="why-nearest-entry"
      title="the transcript entry nearest this tool call's timestamp — jump-to-nearest, not exact tool-call alignment (future work)"
      className="mt-1 border-l border-ice-850 py-0.5 pl-3"
    >
      <p className="text-[9px] uppercase tracking-[0.18em] text-ice-400">
        {nearest.role}
        {stillPaging ? ' · paging earlier…' : ''}
      </p>
      <p className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-ice-300">
        {entryPreview(nearest)}
      </p>
    </div>
  )
}

function entryTs(entry: TranscriptEntry): number | null {
  if (entry.ts === undefined) return null
  const parsed = Date.parse(entry.ts)
  return Number.isNaN(parsed) ? null : parsed
}

/** Closest by absolute distance among loaded, timestamped entries. Null when none carry a ts at all. */
function nearestEntry(entries: readonly TranscriptEntry[], targetTs: number): TranscriptEntry | null {
  let best: TranscriptEntry | null = null
  let bestDelta = Number.POSITIVE_INFINITY
  for (const entry of entries) {
    const ts = entryTs(entry)
    if (ts === null) continue
    const delta = Math.abs(ts - targetTs)
    if (delta < bestDelta) {
      best = entry
      bestDelta = delta
    }
  }
  return best
}

const PREVIEW_MAX_CHARS = 240

function entryPreview(entry: TranscriptEntry): string {
  for (const block of entry.blocks) {
    if (block.kind === 'text') return truncate(block.text)
    if (block.kind === 'tool_use') return `${block.name}${block.hint === '' ? '' : ` — ${block.hint}`}`
    if (block.kind === 'tool_result') return truncate(block.text === '' ? '(no output)' : block.text)
  }
  return ''
}

function truncate(text: string): string {
  return text.length <= PREVIEW_MAX_CHARS ? text : `${text.slice(0, PREVIEW_MAX_CHARS)}…`
}
