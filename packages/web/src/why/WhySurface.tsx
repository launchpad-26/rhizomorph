import { Disclosure, type DisclosureContent } from '../disclosure/index.js'
import { useMemo, useState } from 'react'
import {
  selectFileProvenance,
  selectLaneTouches,
  type FileProvenanceChain,
  type FileProvenanceCommit,
  type FileProvenanceToolCall,
  type LaneFileTouch,
  type SessionState,
} from '@rhizomorph/core'
import { formatSpan } from '../fleet/index.js'
import type { FetchLike } from '../fleet/manifest.js'
import { KindTag } from '../trace/glyphs.js'
import { JUMP_TO_NEAREST, NearestEntry } from './NearestEntry.js'

/**
 * THE WHY SURFACE (prd11 ruling 5) — causality made clickable, shared by the
 * lane drawer and the lane page so an operator learns one reading regardless
 * of where they opened it (the same reasoning `Conversation` and `TraceTree`
 * already get reused for).
 *
 * Pick a file the lane touched (`selectLaneTouches`); see its causal chain
 * (`selectFileProvenance`) — the tool calls that touched it, each one
 * optionally joined to a trace span via `toolUseId` and to the transcript's
 * nearest turn, and the commits that landed it. FILE granularity only
 * (prd11 ruling 1): nothing here claims a commit's hunk belongs to a
 * particular tool call.
 *
 * **A lane spanning more than one telemetry handle has no single chain to
 * show** — the same rule `SpendDetail` already applies to its own thread
 * breakdown, for the same reason: merging two collectors' tool activity under
 * one lane risks double-booking a call neither collector actually shares.
 *
 * **Two layouts, one component (#163).** `fill` is what the drawer's own WHY
 * tab passes: no self max-height, header and the file-chip strip pinned above
 * a `flex-1 overflow-y-auto` chain — the tab body is the drawer's one scroll
 * region and this fills all of it. Without `fill` (the default), this is the
 * bounded, self-scrolling strip `LanePage` still lays out unchanged, since
 * that page is outside this issue's fence.
 *
 * **Causality survives tabbing (#163).** Losing the old side-by-side view of
 * a commit and its WHY chain was the named cost of moving to tabs; `onJumpToActivity`
 * pays it back the other direction — a small affordance beside the active
 * file's chain that switches the drawer to ACTIVITY with this file scrolled
 * to and marked, so the same evidence is one click away instead of gone.
 */
export interface WhySurfaceProps {
  state: SessionState
  /** Display label only. */
  laneLabel: string
  /** The one telemetry handle this lane answers to, or null when it spans more than one. */
  laneHandle: string | null
  /** The clock everything's relative-time reads against — injected, never read live. */
  now: number
  /** Test seam for the conversation deep-link's own `fetch`. */
  fetchTranscript?: FetchLike
  /** True inside the drawer's own WHY tab — fills the tab body instead of a bounded strip. */
  fill?: boolean
  /** The drawer's own navigation to ACTIVITY, scoped to a file (#163). Absent outside the drawer. */
  onJumpToActivity?: (path: string) => void
}

export function WhySurface({
  state,
  laneLabel,
  laneHandle,
  now,
  fetchTranscript,
  fill = false,
  onJumpToActivity,
}: WhySurfaceProps) {
  const touches = useMemo(
    () => (laneHandle === null ? [] : selectLaneTouches(state, laneHandle)),
    [state, laneHandle],
  )
  const [requestedPath, setRequestedPath] = useState<string | null>(null)
  const activePath =
    requestedPath !== null && touches.some((touch) => touch.path === requestedPath)
      ? requestedPath
      : (touches[0]?.path ?? null)

  const chain = useMemo(
    () =>
      laneHandle === null || activePath === null
        ? null
        : selectFileProvenance(state, { lane: laneHandle, path: activePath }),
    [state, laneHandle, activePath],
  )

  const header = (
    <>
      <h3 className="heading text-(--ink-dim)">Why</h3>
      <p className="text-read-floor text-(--ink-dim)">FILE granularity — hunk attribution is future work</p>
    </>
  )

  const gapOrEmpty =
    laneHandle === null ? (
      <p role="status" data-testid="why-multi-handle" className="text-read-body leading-snug text-(--ink-dim)">
        WHY UNAVAILABLE — {laneLabel} spans more than one telemetry handle, so there is no single
        causal chain that is provably its own.
      </p>
    ) : touches.length === 0 ? (
      <p role="status" data-testid="why-empty" className="text-read-body leading-snug text-(--ink-dim)">
        NO FILES TOUCHED YET — no tool call carrying a file path, and no landed commit, has been
        recorded for {laneLabel} so far.
      </p>
    ) : null

  const fileList =
    gapOrEmpty === null ? (
      <FileList touches={touches} activePath={activePath} onSelect={setRequestedPath} now={now} />
    ) : null

  const chainBody =
    gapOrEmpty !== null || chain === null ? null : (
      <>
        {onJumpToActivity === undefined || activePath === null ? null : (
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate font-mono text-inst-dense text-(--ink-dim)">{activePath}</p>
            <button
              type="button"
              data-testid="why-open-in-activity"
              onClick={() => onJumpToActivity(activePath)}
              aria-label="jumps to ACTIVITY, scrolled to and marking this file's own entries"
              className="shrink-0 rounded-none border border-(--line-hair) px-1.5 py-0.5 text-inst uppercase tracking-wide text-(--ink-dim) hover:border-(--ink-dim) hover:text-(--ink-primary)"
            >
              activity ↗
            </button>
          </div>
        )}
        <FileChain chain={chain} now={now} fetchTranscript={fetchTranscript} />
      </>
    )

  if (fill) {
    return (
      <section data-testid="why-surface" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <header className="flex items-baseline justify-between px-4 pb-1 pt-2">{header}</header>
        {gapOrEmpty === null ? (
          <>
            <div className="px-4">{fileList}</div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 [scrollbar-gutter:stable]">
              <div className="space-y-2">{chainBody}</div>
            </div>
          </>
        ) : (
          <div className="px-4 pb-3">{gapOrEmpty}</div>
        )}
      </section>
    )
  }

  return (
    <section
      data-testid="why-surface"
      className="flex max-h-72 shrink-0 flex-col gap-2 overflow-auto border-t border-(--line-hair) px-4 py-3 [scrollbar-gutter:stable]"
    >
      <header className="flex items-baseline justify-between">{header}</header>
      {gapOrEmpty ?? (
        <>
          {fileList}
          {chainBody}
        </>
      )}
    </section>
  )
}

interface FileListProps {
  touches: readonly LaneFileTouch[]
  activePath: string | null
  onSelect: (path: string) => void
  now: number
}

function FileList({ touches, activePath, onSelect, now }: FileListProps) {
  return (
    <ol data-testid="why-file-list" className="flex gap-1 overflow-x-auto pb-1 [scrollbar-gutter:stable]">
      {touches.map((touch) => (
        <li key={touch.path} className="shrink-0">
          <Disclosure disclosure={touchDisclosure(touch, now)} trigger="inline">
          <button
            type="button"
            data-testid="why-file"
            data-active={touch.path === activePath}
            onClick={() => onSelect(touch.path)}
            className={`rounded-none border px-2 py-1 font-mono text-inst-dense leading-tight ${
              touch.path === activePath
                ? 'border-(--ink-dim) text-(--ink-primary)'
                : 'border-(--line-hair) text-(--ink-dim) hover:border-(--line-strong) hover:text-(--ink-primary)'
            }`}
          >
            <span className="truncate">{touch.path}</span>
            <span className="figures ml-1.5 text-(--ink-dim)">
              {touch.toolCallCount}t·{touch.commitCount}c
            </span>
          </button>
          </Disclosure>
        </li>
      ))}
    </ol>
  )
}

interface FileChainProps {
  chain: FileProvenanceChain
  now: number
  fetchTranscript?: FetchLike
}

function FileChain({ chain, now, fetchTranscript }: FileChainProps) {
  return (
    <div data-testid="why-chain" className="space-y-2">
      {chain.gap === null ? null : <GapNotice gap={chain.gap} />}

      {chain.toolCalls.length === 0 ? null : (
        <ol className="space-y-1">
          {chain.toolCalls.map((call) => (
            <ToolCallRow key={call.eventId} call={call} now={now} fetchTranscript={fetchTranscript} />
          ))}
        </ol>
      )}

      {chain.commits.length === 0 ? null : (
        <ol className="space-y-1 border-t border-(--line-hair)/60 pt-1">
          {chain.commits.map((commit) => (
            <CommitRow key={commit.sha} commit={commit} now={now} />
          ))}
        </ol>
      )}

      {chain.toolCalls.length === 0 && chain.commits.length === 0 && chain.gap === null ? (
        <p role="status" className="text-read-body leading-snug text-(--ink-dim)">
          NOTHING RECORDED for this file yet.
        </p>
      ) : null}
    </div>
  )
}

function GapNotice({ gap }: { gap: NonNullable<FileProvenanceChain['gap']> }) {
  const since =
    gap.detailAvailableFromTs === null ? null : new Date(gap.detailAvailableFromTs).toISOString().slice(0, 10)
  return (
    <p role="status" data-testid="why-gap" className="text-read-body leading-snug text-(--ink-dim)">
      TOOL DETAIL UNAVAILABLE — a commit shows this file landed, but no tool call carries a matching
      file path for it —{' '}
      {since === null
        ? 'this session never recorded a file path on any tool call at all.'
        : `tool-level detail is only recorded from ${since} on; this either predates that, or the
           call that touched it (e.g. Bash) never carries a path.`}{' '}
      Hunk-level attribution is not stored either way.
    </p>
  )
}

interface ToolCallRowProps {
  call: FileProvenanceToolCall
  now: number
  fetchTranscript?: FetchLike
}

function ToolCallRow({ call, now, fetchTranscript }: ToolCallRowProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <li data-testid="why-tool-call" className="border-t border-(--line-hair)/60 pt-1 first:border-t-0 first:pt-0">
      <div className="flex items-baseline gap-2">
        {call.span === null ? (
          <span className="w-14 shrink-0 text-inst-dense uppercase tracking-wider text-(--ink-dim)">
            <Disclosure disclosure={NO_SPAN_DISCLOSURE} triggerLabel="no trace span">
              tool
            </Disclosure>
          </span>
        ) : (
          <KindTag kind={call.span.kind} />
        )}
        <span className="figures w-10 shrink-0 text-right text-inst-dense text-(--ink-dim)">
          {formatSpan(Math.max(0, now - call.ts))}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-inst text-(--ink-primary)">{call.tool}</span>
        <button
          type="button"
          data-testid="why-tool-call-jump"
          onClick={() => setExpanded((value) => !value)}
          aria-label={`jumps to ${JUMP_TO_NEAREST}`}
          className="shrink-0 rounded-none border border-(--line-hair) px-1.5 py-0.5 text-inst uppercase tracking-wide text-(--ink-dim) hover:border-(--ink-dim) hover:text-(--ink-primary)"
        >
          {expanded ? 'hide ▴' : 'conversation ↗'}
        </button>
      </div>
      {expanded ? <NearestEntry lane={call.lane} targetTs={call.ts} fetchImpl={fetchTranscript} /> : null}
    </li>
  )
}

function CommitRow({ commit, now }: { commit: FileProvenanceCommit; now: number }) {
  return (
    <li data-testid="why-commit" className="flex items-baseline gap-2 border-t border-(--line-hair)/60 pt-1 first:border-t-0 first:pt-0">
      <span className="w-14 shrink-0 text-inst-dense uppercase tracking-wider text-(--ink-primary)">commit</span>
      <span className="figures w-10 shrink-0 text-right text-inst-dense text-(--ink-dim)">
        {formatSpan(Math.max(0, now - commit.landedAt))}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-inst leading-snug text-(--ink-body)">
        <span className="text-(--ink-dim)">{commit.sha.slice(0, 7)}</span> {commit.message.split('\n')[0]}
        <span className="ml-1 text-(--ink-dim)">{commit.branches.join(', ')}</span>
      </span>
    </li>
  )
}


/**
 * The honest gap when no exported span carries a tool call (prd-30 S1's
 * *unknown*: name what is missing, never improvise).
 *
 * A module constant rather than a function because it takes no arguments and
 * says the same thing every time — and `elapsedMs: 0` because the absence is
 * re-read out of the fold on every render, which is core's own register for a
 * continuously-true fact rather than a claim about when the span went missing.
 */
export const NO_SPAN_DISCLOSURE: DisclosureContent = {
  label: 'tool',
  why: {
    reason: 'no trace span carries this toolUseId',
    evidence: { fact: 'either no span was exported for it, or the call has none', elapsedMs: 0 },
  },
  remedy: {
    kind: 'none',
    because: 'the call is still shown with what is known about it — the missing span is named rather than papered over',
  },
}

/** One touched file's disclosure: what happened to it, and how long ago. */
function touchDisclosure(
  touch: { path: string; toolCallCount: number; commitCount: number; lastTouchedAt: number },
  now: number,
): DisclosureContent {
  return {
    label: touch.path,
    why: {
      reason: 'what this run did to this file',
      evidence: {
        fact: `${touch.toolCallCount} tool call${touch.toolCallCount === 1 ? '' : 's'} · ${touch.commitCount} commit${touch.commitCount === 1 ? '' : 's'}, last touched`,
        // `Math.max(0, …)` for the same reason the surface already used it: a
        // playhead scrubbed behind an event would otherwise hand the card a
        // negative age, and `requireAge` refuses those outright.
        elapsedMs: Math.max(0, now - touch.lastTouchedAt),
      },
    },
    remedy: { kind: 'action', action: 'select it to see the chain of work that touched it' },
  }
}
