import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FetchLike } from '../fleet/manifest.js'
import { useTranscript } from './useTranscript.js'

/**
 * THE FULL TRANSCRIPT (ruling 17) — below the activity view, collapsed by
 * default, live-tailing when open.
 *
 * Collapsed by default is the ruling's ordering made structural: the activity
 * view is what tells you whether a transcript is worth reading, so the
 * transcript does not get to be the first thing in front of you — and while it
 * is shut it does not poll, so an open drawer costs one request only when
 * somebody is actually reading.
 *
 * Standard tail UX, and the standard is standard because it is right: it
 * follows the tail until you scroll up, and the moment you do it stops and says
 * so, because a pane that yanks you back to the bottom mid-read is unusable.
 * Scrolling back down resumes following.
 */

/** How near the bottom counts as "at the tail", in px. Roughly one line of slack. */
export const TAIL_SLACK_PX = 24

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** Pure, so the follow rule is tested without a layout engine (jsdom has none). */
export function isAtTail(metrics: ScrollMetrics, slack: number = TAIL_SLACK_PX): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= slack
}

export interface TranscriptPanelProps {
  lane: string
  /** Test seam, threaded down from the drawer. */
  fetchImpl?: FetchLike
  /** Test seam: `0` reads once and never polls, so no test races an interval. */
  pollMs?: number
  /** Test seam: start expanded. Production opens collapsed (see above). */
  initiallyExpanded?: boolean
}

export function TranscriptPanel({ lane, fetchImpl, pollMs, initiallyExpanded = false }: TranscriptPanelProps) {
  const [expanded, setExpanded] = useState(initiallyExpanded)
  const [following, setFollowing] = useState(true)
  const bodyRef = useRef<HTMLPreElement | null>(null)

  const tail = useTranscript(lane, { fetchImpl, pollMs, enabled: expanded })

  // A new lane is a new transcript: re-collapse rather than leaving the
  // previous lane's reading position pointing at somebody else's session.
  useEffect(() => {
    setExpanded(initiallyExpanded)
    setFollowing(true)
  }, [lane, initiallyExpanded])

  // Layout effect, not an effect: the jump to the tail must happen in the same
  // frame the new text paints, or the reader sees the old bottom flash first.
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (body === null || !following) return
    body.scrollTop = body.scrollHeight
  }, [tail.text, following, expanded])

  return (
    <section data-testid="drawer-transcript" className="flex min-h-0 flex-col border-t border-ice-850">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
        className="flex items-center justify-between px-4 py-2 text-left hover:bg-ice-900"
      >
        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-ice-400">
          Transcript
        </span>
        <span className="figures text-[10px] text-ice-500">
          {expanded ? (following ? 'tailing ▾' : 'paused ▴') : 'expand ▸'}
        </span>
      </button>

      {!expanded ? null : (
        <div className="flex min-h-0 flex-col">
          {tail.status === 'absent' || tail.status === 'error' ? (
            <p role="status" className="px-4 pb-3 font-mono text-[11px] leading-snug text-ice-400">
              {tail.reason}
            </p>
          ) : (
            <>
              <pre
                ref={bodyRef}
                data-testid="transcript-body"
                onScroll={(event) => setFollowing(isAtTail(event.currentTarget))}
                className="min-h-32 flex-1 overflow-auto whitespace-pre-wrap break-words bg-ice-1000 px-4 py-2 font-mono text-[11px] leading-relaxed text-ice-300"
              >
                {tail.status === 'loading' && tail.text === '' ? 'reading the session log…' : tail.text}
              </pre>
              {following ? null : (
                <button
                  type="button"
                  onClick={() => setFollowing(true)}
                  className="border-t border-ice-850 px-4 py-1 text-left text-[10px] uppercase tracking-wider text-notice hover:bg-ice-900"
                >
                  paused — jump to the tail
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
