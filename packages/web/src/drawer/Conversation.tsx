import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FetchLike } from '../fleet/manifest.js'
import { formatTokens } from '../lib/format.js'
import type { TranscriptBlock, TranscriptEntry, TranscriptRole } from './useTranscript.js'
import { useTranscript } from './useTranscript.js'

/**
 * THE CONVERSATION (prd4 ruling 4) — the drawer's main view.
 *
 * Clicking a lane shows what you would see sitting at that agent's terminal:
 * the session, chronological, tail-following. So this reads like an agent CLI
 * rather than like a log viewer — user turns prompt-like, assistant prose in
 * the page's own face, tool calls as quiet one-liners between them.
 *
 * **Supersedes prd3 #84's collapsed-by-default ruling.** That ruling put the
 * activity ledger first, on the argument that it tells you whether the
 * transcript is worth reading; the operator's review found the opposite in
 * practice — the conversation *is* the reading, and a fold in front of it is a
 * click between an operator and the only thing on the screen that says what is
 * actually happening. It is now default-on, `flex-1`, and polls the whole time
 * the drawer is open. Nothing polls when no lane is selected, because then no
 * drawer is mounted at all.
 *
 * Not a `<pre>` (law 11): prose is prose and gets the sans face, while figures
 * — tool names, hints, results — stay monospace. A wall of monospace was the
 * loudest "this is for machines" signal in the panel this replaces.
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

export interface ConversationProps {
  lane: string
  /** Test seam, threaded down from the drawer. */
  fetchImpl?: FetchLike
  /** Test seam: `0` reads once and never polls, so no test races an interval. */
  pollMs?: number
}

export function Conversation({ lane, fetchImpl, pollMs }: ConversationProps) {
  const [following, setFollowing] = useState(true)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const tail = useTranscript(lane, { fetchImpl, pollMs })

  // A new lane is a new conversation: follow its tail rather than inheriting the
  // previous lane's paused reading position, which pointed into somebody else's
  // session and would leave this one apparently stuck.
  useEffect(() => {
    setFollowing(true)
  }, [lane])

  // Layout effect, not an effect: the jump to the tail must happen in the same
  // frame the new turns paint, or the reader sees the old bottom flash first.
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (body === null || !following) return
    body.scrollTop = body.scrollHeight
  }, [tail.entries, following])

  const unreadable = tail.status === 'absent' || tail.status === 'error'

  // No top hairline on the section: the vitals above already draw one, and two
  // rules stacked read as a gap where there is none.
  return (
    <section data-testid="drawer-conversation" className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-baseline justify-between px-4 pb-1 pt-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-ice-400">
          Conversation
        </h3>
        {unreadable ? null : (
          <span data-testid="conversation-tail-state" className="figures text-[10px] text-ice-500">
            {following ? 'tailing ▾' : 'paused ▴'}
          </span>
        )}
      </header>

      {unreadable ? (
        <p role="status" className="px-4 pb-3 font-mono text-[11px] leading-snug text-ice-400">
          {tail.reason}
        </p>
      ) : (
        <>
          <div
            ref={bodyRef}
            data-testid="conversation-body"
            onScroll={(event) => setFollowing(isAtTail(event.currentTarget))}
            className="min-h-32 flex-1 overflow-auto bg-ice-1000 px-4 py-2"
          >
            {tail.entries.length === 0 ? (
              <p role="status" className="text-[11px] leading-snug text-ice-500">
                {tail.status === 'loading'
                  ? 'reading the session log…'
                  : 'NOTHING SAID YET — the session log for this lane carries no turn so far, so ' +
                    'there is nothing to show — turns appear here as the agent speaks.'}
              </p>
            ) : (
              <ol>
                {tail.entries.map((entry, index) => (
                  // The index is the key on purpose: a turn's identity *is* its
                  // position in an append-only log, and the log carries no id.
                  // Nothing is ever inserted above or reordered.
                  <Turn key={index} entry={entry} />
                ))}
              </ol>
            )}
          </div>
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
    </section>
  )
}

/**
 * One turn. The role styles the *prose*; a tool call and its result look the
 * same whoever made it — which matters because a session log records tool
 * results on `user` lines, so styling purely by role would dress every result
 * up as something a human typed.
 */
function Turn({ entry }: { entry: TranscriptEntry }) {
  return (
    <li
      data-testid="turn"
      data-role={entry.role}
      title={entry.ts}
      className={`mt-2 first:mt-0 ${entry.role === 'subagent' ? 'border-l border-ice-850 pl-2' : ''}`}
    >
      {entry.role === 'subagent' ? (
        <p className="text-[9px] uppercase tracking-[0.18em] text-ice-600">subagent</p>
      ) : null}
      {entry.blocks.map((block, index) => (
        <Block key={index} block={block} role={entry.role} />
      ))}
    </li>
  )
}

function Block({ block, role }: { block: TranscriptBlock; role: TranscriptRole }) {
  if (block.kind === 'tool_use') {
    return (
      <p
        data-testid="tool-call"
        className="flex items-baseline gap-1.5 py-0.5 font-mono text-[10px] leading-snug text-ice-500"
      >
        <span aria-hidden className="text-ice-600">
          ●
        </span>
        <span className="shrink-0 text-ice-300">{block.name}</span>
        {block.hint === '' ? null : (
          <span className="truncate">
            <span aria-hidden>— </span>
            {block.hint}
          </span>
        )}
      </p>
    )
  }

  if (block.kind === 'tool_result') {
    return (
      <p
        data-testid="tool-result"
        className="whitespace-pre-wrap break-words pl-3.5 font-mono text-[10px] leading-snug text-ice-600"
      >
        <span aria-hidden className="text-ice-700">
          ⎿{' '}
        </span>
        {block.text === '' ? '(no output)' : block.text}
        {block.dropped > 0 ? (
          // The cut is stated, never hidden: the server capped the result, and a
          // reader who cannot see that it was capped is being told the tool said
          // less than it did. Abbreviated through the one shared count formatter
          // (law 11) — it is spelled `formatTokens` because tokens were its
          // first caller, but it is an SI count.
          <span className="text-ice-700"> … +{formatTokens(block.dropped)} more</span>
        ) : null}
      </p>
    )
  }

  if (role === 'user') {
    return (
      <p data-testid="turn-prose" className="flex gap-2 py-1">
        <span aria-hidden className="figures shrink-0 text-notice">
          ›
        </span>
        <span className="min-w-0 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ice-100">
          {block.text}
        </span>
      </p>
    )
  }

  if (role === 'system') {
    // Not a voice from the log — the parser reporting a line it could not read.
    return (
      <p data-testid="turn-prose" className="py-0.5 font-mono text-[10px] leading-snug text-ice-600">
        {block.text}
      </p>
    )
  }

  return (
    <p
      data-testid="turn-prose"
      className={`whitespace-pre-wrap break-words py-0.5 text-[12px] leading-relaxed ${
        role === 'subagent' ? 'text-ice-400' : 'text-ice-200'
      }`}
    >
      {block.text}
    </p>
  )
}
