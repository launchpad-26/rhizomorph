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
import { NearestEntry } from './NearestEntry.js'

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
}

export function WhySurface({ state, laneLabel, laneHandle, now, fetchTranscript }: WhySurfaceProps) {
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

  return (
    <section
      data-testid="why-surface"
      className="flex max-h-72 shrink-0 flex-col gap-2 overflow-auto border-t border-ice-850 px-4 py-3 [scrollbar-gutter:stable]"
    >
      <header className="flex items-baseline justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-ice-400">Why</h3>
        <p className="text-[10px] text-ice-400">FILE granularity — hunk attribution is future work</p>
      </header>

      {laneHandle === null ? (
        <p role="status" data-testid="why-multi-handle" className="text-[11px] leading-snug text-ice-400">
          WHY UNAVAILABLE — {laneLabel} spans more than one telemetry handle, so there is no single
          causal chain that is provably its own.
        </p>
      ) : touches.length === 0 ? (
        <p role="status" data-testid="why-empty" className="text-[11px] leading-snug text-ice-400">
          NO FILES TOUCHED YET — no tool call carrying a file path, and no landed commit, has been
          recorded for {laneLabel} so far.
        </p>
      ) : (
        <>
          <FileList touches={touches} activePath={activePath} onSelect={setRequestedPath} now={now} />
          {chain === null ? null : (
            <FileChain chain={chain} now={now} fetchTranscript={fetchTranscript} />
          )}
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
          <button
            type="button"
            data-testid="why-file"
            data-active={touch.path === activePath}
            title={`${touch.toolCallCount} tool call${touch.toolCallCount === 1 ? '' : 's'} · ${touch.commitCount} commit${touch.commitCount === 1 ? '' : 's'} · last touched ${formatSpan(Math.max(0, now - touch.lastTouchedAt))} ago`}
            onClick={() => onSelect(touch.path)}
            className={`rounded border px-2 py-1 font-mono text-[10px] leading-tight ${
              touch.path === activePath
                ? 'border-ice-600 text-ice-100'
                : 'border-ice-850 text-ice-400 hover:border-ice-700 hover:text-ice-200'
            }`}
          >
            <span className="truncate">{touch.path}</span>
            <span className="figures ml-1.5 text-ice-400">
              {touch.toolCallCount}t·{touch.commitCount}c
            </span>
          </button>
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
        <ol className="space-y-1 border-t border-ice-850/60 pt-1">
          {chain.commits.map((commit) => (
            <CommitRow key={commit.sha} commit={commit} now={now} />
          ))}
        </ol>
      )}

      {chain.toolCalls.length === 0 && chain.commits.length === 0 && chain.gap === null ? (
        <p role="status" className="text-[11px] leading-snug text-ice-400">
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
    <p role="status" data-testid="why-gap" className="text-[11px] leading-snug text-ice-400">
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
    <li data-testid="why-tool-call" className="border-t border-ice-850/60 pt-1 first:border-t-0 first:pt-0">
      <div className="flex items-baseline gap-2">
        {call.span === null ? (
          <span
            title="no trace span carries this toolUseId — either none exported, or the call has none"
            className="w-14 shrink-0 text-[10px] uppercase tracking-wider text-ice-400"
          >
            tool
          </span>
        ) : (
          <KindTag kind={call.span.kind} />
        )}
        <span className="figures w-10 shrink-0 text-right text-[10px] text-ice-400">
          {formatSpan(Math.max(0, now - call.ts))}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ice-200">{call.tool}</span>
        <button
          type="button"
          data-testid="why-tool-call-jump"
          onClick={() => setExpanded((value) => !value)}
          title="jumps to the transcript entry nearest this tool call's timestamp — jump-to-nearest, not exact alignment (future work)"
          className="shrink-0 rounded border border-ice-850 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ice-400 hover:border-ice-600 hover:text-ice-200"
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
    <li data-testid="why-commit" className="flex items-baseline gap-2 border-t border-ice-850/60 pt-1 first:border-t-0 first:pt-0">
      <span className="w-14 shrink-0 text-[10px] uppercase tracking-wider text-ice-200">commit</span>
      <span className="figures w-10 shrink-0 text-right text-[10px] text-ice-400">
        {formatSpan(Math.max(0, now - commit.landedAt))}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-snug text-ice-300">
        <span className="text-ice-400">{commit.sha.slice(0, 7)}</span> {commit.message.split('\n')[0]}
        <span className="ml-1 text-ice-400">{commit.branches.join(', ')}</span>
      </span>
    </li>
  )
}
