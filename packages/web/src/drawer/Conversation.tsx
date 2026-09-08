import { useModeClock } from '../app/ModeContext.js'
import { Disclosure, type DisclosureContent } from '../disclosure/index.js'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FetchLike } from '../fleet/manifest.js'
import { formatTokens } from '../lib/format.js'
import { KIND_APPEARANCE, kindEdgeClass, kindInkClass, type WorkKind } from '../theme/kind.js'
import { HiddenNotice } from '../panels/search/HiddenNotice.js'
import { filterByQuery, useSessionQuery } from '../panels/search/session.js'
import type { TranscriptBlock, TranscriptEntry, TranscriptRole } from './useTranscript.js'
import { transcriptEntryText, useTranscript } from './useTranscript.js'

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
 * practice — the conversation *is* the reading, not a fold in front of it.
 * It reads at the tail and polls the whole time its own tab is mounted.
 * (ACTIVITY is the drawer's default tab as of operator ruling 2026-08-05,
 * #164 — CONVERSATION is a click away rather than the first thing shown, but
 * this component's own behavior once selected is unchanged.) Nothing polls
 * when no lane is selected, because then no drawer is mounted at all.
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

  /**
   * THE SESSION SEARCH (prd-31 ruling 4 / S3, #559) — the same one query the
   * feed and the trace read, over the turns already loaded.
   *
   * **Over the loaded slice, and it says so.** This is the tail plus whatever
   * "load earlier" has pulled in; the rest of the log is on disk and this
   * feature adds no route to go and get it (S3: no index, no server route —
   * prd-29 would have to gate a new read seam). So `load earlier` stays exactly
   * where it is *while filtering*, because it is the honest answer to "is that
   * everything?" — the reader can widen the slice the search runs over.
   */
  const query = useSessionQuery()
  const search = filterByQuery(tail.entries, query, transcriptEntryText)

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

  // A transient `absent`/`error` poll over entries already loaded is staleness,
  // not absence (the operator's 2026-08-05 report: "flips back to not
  // displaying as it updates"). `foldChunk`/`fail` both keep `entries` on these
  // statuses on purpose — only a status with nothing behind it is unreadable;
  // the gap voice is reserved for that, and held entries keep rendering with a
  // quiet staleness note instead (the honesty law still applies to the note).
  const gap = tail.status === 'absent' || tail.status === 'error'
  const hasEntries = tail.entries.length > 0
  const unreadable = gap && !hasEntries
  const stale = gap && hasEntries

  // No top hairline on the section: the vitals above already draw one, and two
  // rules stacked read as a gap where there is none.
  //
  // `overflow-hidden` here is load-bearing (#151): this section's `min-h-0`
  // lets the outer flex column squeeze it down when ACTIVITY/WHY/TRACE below
  // it are all near their own caps, and without a clip boundary on the
  // section itself the scrollable body's content painted straight through
  // whatever siblings came after it in the flow instead of stopping at the
  // section's own (now-smaller) box.
  return (
    <section data-testid="drawer-conversation" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex items-baseline justify-between px-4 pb-1 pt-2">
        <h3 className="text-inst-dense font-semibold uppercase tracking-[0.2em] text-(--ink-dim)">
          Conversation
        </h3>
        {unreadable ? null : (
          <span data-testid="conversation-tail-state" className="figures text-inst-dense text-(--ink-dim)">
            {stale ? 'stale ▪' : following ? 'tailing ▾' : 'paused ▴'}
          </span>
        )}
      </header>

      {unreadable ? (
        <p role="status" className="px-4 pb-3 font-mono text-inst leading-snug text-(--ink-dim)">
          {tail.reason}
        </p>
      ) : (
        <>
          <div
            ref={bodyRef}
            data-testid="conversation-body"
            onScroll={(event) => setFollowing(isAtTail(event.currentTarget))}
            className="min-h-0 flex-1 overflow-y-auto bg-(--surface-floor) px-4 py-2 [scrollbar-gutter:stable]"
          >
            {stale ? (
              <p
                data-testid="conversation-stale-reason"
                role="status"
                className="mb-2 border-b border-(--line-hair) pb-1.5 text-inst-dense leading-snug text-(--ink-dim)"
              >
                {tail.reason}
              </p>
            ) : null}
            {tail.earliestOffset > 0 ? (
              <button
                type="button"
                onClick={() => void tail.loadEarlier()}
                disabled={tail.loadingEarlier}
                className="mb-2 w-full border-b border-(--line-hair) pb-1.5 text-center text-inst-dense uppercase tracking-wider text-(--ink-dim) hover:bg-(--surface-raised) disabled:opacity-50"
              >
                {tail.loadingEarlier ? 'loading earlier…' : 'load earlier'}
              </button>
            ) : null}
            <HiddenNotice
              result={search}
              noun="turns"
              query={query}
              shown={search.shown.length}
              surface="conversation"
            />
            {tail.entries.length === 0 ? (
              <p role="status" className="text-inst leading-snug text-(--ink-dim)">
                {tail.status === 'loading'
                  ? 'reading the session log…'
                  : 'NOTHING SAID YET — the session log for this lane carries no turn so far, so ' +
                    'there is nothing to show — turns appear here as the agent speaks.'}
              </p>
            ) : (
              <ol>
                {search.shown.map((entry, index) => (
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
              className="border-t border-(--line-hair) px-4 py-1 text-left text-inst-dense uppercase tracking-wider text-notice hover:bg-(--surface-raised)"
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
  // The fold's reading position, never `Date.now()` — in replay the elapsed
  // time on a turn must be measured from the playhead, which is the rule
  // `disclosure/vocabulary.ts` states for every card in the instrument.
  const now = useModeClock()
  return (
    <li
      data-testid="turn"
      data-role={entry.role}
      className={`mt-2 first:mt-0 ${entry.role === 'subagent' ? 'border-l border-(--line-hair) pl-2' : ''}`}
    >
      {/*
        The turn's timestamp was a `title=` on this `<li>` (#220). The trigger
        is `inline` and wraps the turn's own body rather than adding a mark of
        its own: a turn may contain links and controls from `Block`, so a button
        trigger here would nest one (ADR-0040) — and inventing a visible
        timestamp chip to hang a card on would be a design change this sweep has
        no mandate for.
      */}
      <Disclosure disclosure={turnDisclosure(entry, now)} trigger="inline">
      {entry.role === 'subagent' ? (
        <p className="text-inst-floor uppercase tracking-[0.18em] text-(--ink-dim)">subagent</p>
      ) : null}
      {entry.blocks.map((block, index) => (
        <Block key={index} block={block} role={entry.role} />
      ))}
      </Disclosure>
    </li>
  )
}

/**
 * When a turn was recorded (#220).
 *
 * `entry.ts` is an ISO stamp the transcript carries, and the age is the
 * distance from the reader's own position to it — `Date.parse` can return
 * `NaN` on a malformed stamp, and `requireAge` refuses that outright, so the
 * unparseable case is its own honest arm rather than a card that renders
 * "NaN ago".
 */
function turnDisclosure(entry: TranscriptEntry, now: number): DisclosureContent {
  const at = entry.ts === undefined ? Number.NaN : Date.parse(entry.ts)
  if (Number.isNaN(at)) {
    return {
      label: entry.role,
      why: {
        reason: 'this turn carries no readable timestamp',
        evidence: { fact: `the transcript records it as ${entry.ts ?? '(absent)'}`, elapsedMs: 0 },
      },
      remedy: { kind: 'none', because: 'the turn is still shown with everything else the record holds' },
    }
  }
  return {
    label: entry.role,
    why: {
      reason: 'when this turn was recorded',
      evidence: {
        fact: `the transcript stamps it ${entry.ts}`,
        // `Math.max(0, …)` because a replay playhead scrubbed behind the entry
        // would otherwise hand the card a negative age.
        elapsedMs: Math.max(0, now - at),
      },
    },
    remedy: { kind: 'none', because: 'a timestamp is a reading, not a condition' },
  }
}

/**
 * Which of the app's kinds a transcript block is. Only the two tool blocks are
 * kinds at all: a `text` block's look is decided by *role*, and kind dispatches
 * before role (that order is the deliberate one — a session log records tool
 * results on `user` lines, so styling purely by role would dress every result
 * up as something a human typed).
 *
 * The look itself is `theme/kind.ts`'s (prd-31 ruling 1), which is where the
 * sentence this file used to spell inline now lives: a kind is not a status. A
 * call and its answer share the `tool` category, so their tints are the same
 * one and the rule runs unbroken down both — the band *is* the pairing.
 */
const BLOCK_KIND = { tool_use: 'tool', tool_result: 'result' } as const satisfies Record<string, WorkKind>

function Block({ block, role }: { block: TranscriptBlock; role: TranscriptRole }) {
  if (block.kind === 'tool_use') {
    return (
      <p
        data-testid="tool-call"
        className={`flex items-baseline gap-1.5 py-0.5 font-mono text-inst-dense leading-snug text-(--ink-dim) ${kindEdgeClass(BLOCK_KIND.tool_use)}`}
      >
        {/* aria-hidden bullet: decorative line-start mark, no information of its own — legibility.test.ts allowlist */}
        <span aria-hidden className="text-(--ink-dim)">
          ●
        </span>
        <span className={`shrink-0 ${kindInkClass(BLOCK_KIND.tool_use)}`}>{block.name}</span>
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
        className={`whitespace-pre-wrap break-words border-l-2 pl-3.5 font-mono text-inst-dense leading-snug ${kindInkClass(BLOCK_KIND.tool_result)} ${KIND_APPEARANCE[BLOCK_KIND.tool_result].edge}`}
      >
        {/* aria-hidden glyph: decorative line-start mark, no information of its own — legibility.test.ts allowlist */}
        <span aria-hidden className="text-(--ink-dim)">
          ⎿{' '}
        </span>
        {block.text === '' ? '(no output)' : block.text}
        {block.dropped > 0 ? (
          // The cut is stated, never hidden: the server capped the result, and a
          // reader who cannot see that it was capped is being told the tool said
          // less than it did. Abbreviated through the one shared count formatter
          // (law 11) — it is spelled `formatTokens` because tokens were its
          // first caller, but it is an SI count.
          <span className="text-(--ink-dim)"> … +{formatTokens(block.dropped)} more</span>
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
        <span className="min-w-0 whitespace-pre-wrap break-words text-read-floor leading-relaxed text-(--ink-primary)">
          {block.text}
        </span>
      </p>
    )
  }

  if (role === 'system') {
    // Not a voice from the log — the parser reporting a line it could not read.
    return (
      <p data-testid="turn-prose" className="py-0.5 font-mono text-inst-dense leading-snug text-(--ink-dim)">
        {block.text}
      </p>
    )
  }

  return (
    <p
      data-testid="turn-prose"
      className={`whitespace-pre-wrap break-words py-0.5 text-read-floor leading-relaxed ${
        role === 'subagent' ? 'text-(--ink-dim)' : 'text-(--ink-body)'
      }`}
    >
      {block.text}
    </p>
  )
}
