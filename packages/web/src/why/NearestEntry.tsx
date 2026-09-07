import { Disclosure, type DisclosureContent } from '../disclosure/index.js'
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
      <p role="status" data-testid="why-nearest-entry-gap" className="mt-1 pl-4 text-read-floor leading-snug text-(--ink-dim)">
        {tail.reason}
      </p>
    )
  }

  if (tail.status !== 'ready' || tail.entries.length === 0) {
    return (
      <p role="status" className="mt-1 pl-4 text-read-floor text-(--ink-dim)">
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
      <p role="status" className="mt-1 pl-4 text-read-floor text-(--ink-dim)">
        {stillPaging ? 'paging earlier for a timestamped turn…' : 'no timestamped turn loaded near this call'}
      </p>
    )
  }

  return (
    <div data-testid="why-nearest-entry" className="mt-1 border-l border-(--line-hair) py-0.5 pl-3">
      <p className="heading text-(--ink-dim)">
        {/*
          The caveat is a disclosure and not an `aria-label` (#220): this is a
          `<div>`, and an aria-label on a non-interactive, non-landmark element
          is ignored by assistive technology — which is how the sentence came
          to be pointer-only in the first place. The card puts it on the
          keyboard path, from the one constant `WhySurface` also names itself
          with.
        */}
        <Disclosure disclosure={NEAREST_ENTRY_DISCLOSURE} triggerLabel="nearest entry">
          {nearest.role}
          {stillPaging ? ' · paging earlier…' : ''}
        </Disclosure>
      </p>
      <p className="whitespace-pre-wrap break-words font-mono text-read-floor leading-snug text-(--ink-body)">
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

/**
 * The jump's caveat, in one place (#220).
 *
 * It was written out twice — here and in `WhySurface.tsx` — as two native
 * `title=` strings kept in step by hand. One constant, two readers: the
 * control that performs the jump names itself with it, and this panel
 * discloses it. It lives HERE rather than in `WhySurface.tsx` because that
 * file already imports this one; the other direction would be an import cycle,
 * and a cycle around a module-level constant is how it ends up `undefined` at
 * evaluation time.
 */
export const JUMP_TO_NEAREST =
  "the transcript entry nearest this tool call's timestamp — jump-to-nearest, not exact tool-call alignment (future work)"

/**
 * What this panel is showing, and what it is not (#220) — the jump is to the
 * *nearest* transcript entry, not to an exactly-aligned one.
 *
 * The sentence itself is {@link JUMP_TO_NEAREST}, shared with the control in
 * `WhySurface.tsx` that performs the jump, so the promise a reader is given
 * before the jump and the caveat they meet after it cannot drift apart.
 */
const NEAREST_ENTRY_DISCLOSURE: DisclosureContent = {
  label: 'nearest',
  why: {
    reason: JUMP_TO_NEAREST,
    evidence: { fact: 'the entry shown is the closest one by timestamp, chosen from what has been paged in', elapsedMs: 0 },
  },
  remedy: {
    kind: 'none',
    because: 'exact tool-call alignment is future work — the caveat is here so the entry is not read as an exact match',
  },
}
