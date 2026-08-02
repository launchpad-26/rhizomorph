import { useCallback, useEffect, useRef, useState } from 'react'
import type { FetchLike } from '../fleet/manifest.js'

/**
 * The transcript tail (ruling 17), client side.
 *
 * **Only ever a GET.** The endpoint has no other verb and this hook issues no
 * other request. That is the read-only constitution expressed where it can be
 * checked mechanically — `drawer.readonly.test.ts` greps this directory for any
 * other method and fails the build if one appears.
 *
 * **A lane, or nothing.** `lane === null` is the whole of the not-reading case:
 * no selection means no drawer, which means this hook is not mounted and the
 * page issues no transcript request at all. There is no longer a collapsed
 * state to gate on — prd4 ruling 4 makes the conversation the drawer's default
 * and largest section, so an open drawer *is* a reader.
 *
 * Tailing is polling, deliberately: `GET …?offset=N` returning `nextOffset` is
 * the whole protocol. No websocket, no SSE, no watcher on the server holding a
 * file handle open per open drawer. A drawer is open for a minute at a time and
 * a two-second poll is a rounding error beside the stream the page already
 * holds — where SSE is genuinely needed (the event log) the app already has it.
 */

/** How often an open, following transcript asks for what's new. */
export const TRANSCRIPT_POLL_MS = 2_000

export function transcriptUrl(lane: string, offset: number): string {
  return `/api/transcript/${encodeURIComponent(lane)}?offset=${offset}`
}

/**
 * The wire shape of a turn, restated here rather than imported.
 *
 * The web bundle does not depend on the server package — nothing in the browser
 * may reach for a module that opens files — so an API body is a contract the
 * client re-declares and then *checks*, exactly as the lane manifest's body is
 * re-declared and validated in `fleet/fences.ts`. {@link parseEntries} is that
 * check: a
 * body from a server older or newer than this bundle degrades to fewer turns,
 * never to a thrown render.
 */
export type TranscriptRole = 'user' | 'assistant' | 'subagent' | 'system'

export type TranscriptBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; name: string; hint: string }
  | { kind: 'tool_result'; text: string; dropped: number }

export interface TranscriptEntry {
  /** The log's own ISO timestamp, when the line carried one. */
  ts?: string
  role: TranscriptRole
  blocks: TranscriptBlock[]
}

export interface TranscriptState {
  /**
   * `absent` is not an error: a lane with no session log on disk is an ordinary,
   * expected state (an OTel-only lane, a worktree with no agent in it), and it
   * carries the server's reason so the drawer can say what is missing and why.
   */
  status: 'idle' | 'loading' | 'ready' | 'absent' | 'error'
  /** The conversation so far, oldest first — every page folded into one list. */
  entries: TranscriptEntry[]
  /** The gap line for `absent`/`error`, straight from the server. */
  reason: string | null
  /** Where the next poll resumes. */
  offset: number
  eof: boolean
  /** Bytes in the log, so a reader can see the tail is genuinely at the end. */
  size: number
}

export const IDLE_TRANSCRIPT: TranscriptState = {
  status: 'idle',
  entries: [],
  reason: null,
  offset: 0,
  eof: true,
  size: 0,
}

interface ChunkBody {
  available?: unknown
  reason?: unknown
  entries?: unknown
  nextOffset?: unknown
  size?: unknown
  eof?: unknown
  restarted?: unknown
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

const ROLES: readonly TranscriptRole[] = ['user', 'assistant', 'subagent', 'system']

function parseBlock(value: unknown): TranscriptBlock | null {
  const block = asRecord(value)
  if (block === null) return null
  if (block.kind === 'text') {
    return typeof block.text === 'string' ? { kind: 'text', text: block.text } : null
  }
  if (block.kind === 'tool_use') {
    return { kind: 'tool_use', name: asString(block.name, 'tool'), hint: asString(block.hint, '') }
  }
  if (block.kind === 'tool_result') {
    return {
      kind: 'tool_result',
      text: asString(block.text, ''),
      dropped: Math.max(0, asNumber(block.dropped, 0)),
    }
  }
  return null
}

/**
 * The body's turns, keeping only what this bundle knows how to show. A block
 * kind it has never heard of is skipped rather than rendered as `[object
 * Object]`, and an entry left with nothing to show is not a turn.
 */
export function parseEntries(value: unknown): TranscriptEntry[] {
  if (!Array.isArray(value)) return []
  const entries: TranscriptEntry[] = []
  for (const raw of value) {
    const record = asRecord(raw)
    if (record === null) continue
    const role = ROLES.find((candidate) => candidate === record.role) ?? 'system'
    const blocks = (Array.isArray(record.blocks) ? record.blocks : [])
      .map(parseBlock)
      .filter((block): block is TranscriptBlock => block !== null)
    if (blocks.length === 0) continue
    const ts = typeof record.ts === 'string' ? record.ts : null
    entries.push(ts === null ? { role, blocks } : { ts, role, blocks })
  }
  return entries
}

function defaultFetch(): FetchLike | null {
  return typeof globalThis.fetch === 'function'
    ? ((input: string) => globalThis.fetch(input)) as FetchLike
    : null
}

/**
 * One page of the tail, folded onto what we already have. Exported so the fold
 * — which is where restart-vs-append is decided — is tested as a pure function
 * rather than through a component.
 */
export function foldChunk(previous: TranscriptState, body: unknown): TranscriptState {
  const chunk = (typeof body === 'object' && body !== null ? body : {}) as ChunkBody

  if (chunk.available !== true) {
    return {
      ...previous,
      status: 'absent',
      reason:
        typeof chunk.reason === 'string'
          ? chunk.reason
          : 'NO TRANSCRIPT — the server gave no reason, which is itself the bug — run: `rhizomorph doctor`',
    }
  }

  const entries = parseEntries(chunk.entries)
  // A restarted log is a different log: appending to it would splice two
  // sessions into one unreadable conversation.
  const base = chunk.restarted === true ? [] : previous.entries

  return {
    status: 'ready',
    entries: base.length === 0 ? entries : [...base, ...entries],
    reason: null,
    offset: asNumber(chunk.nextOffset, previous.offset),
    eof: chunk.eof === true,
    size: asNumber(chunk.size, previous.size),
  }
}

export interface UseTranscriptOptions {
  /** Test seam. Defaults to the real `fetch`. */
  fetchImpl?: FetchLike
  /** Milliseconds between polls. `0` disables polling — one read, then still. */
  pollMs?: number
}

export interface TranscriptTail extends TranscriptState {
  /** Ask now. Returns when the request has been folded in. */
  refresh: () => Promise<void>
}

export function useTranscript(lane: string | null, options: UseTranscriptOptions = {}): TranscriptTail {
  const { fetchImpl, pollMs = TRANSCRIPT_POLL_MS } = options
  const [state, setState] = useState<TranscriptState>(IDLE_TRANSCRIPT)

  // The offset lives in a ref as well as in state so a poll can read the latest
  // one without the effect having to restart every time a chunk lands — a
  // resubscribing interval is how a two-second tail becomes a request storm.
  const offsetRef = useRef(0)
  const liveRef = useRef(true)

  useEffect(() => {
    offsetRef.current = 0
    setState(lane === null ? IDLE_TRANSCRIPT : { ...IDLE_TRANSCRIPT, status: 'loading' })
  }, [lane])

  const refresh = useCallback(async () => {
    if (lane === null) return
    const impl = fetchImpl ?? defaultFetch()
    if (impl === null) {
      setState((previous) => ({
        ...previous,
        status: 'error',
        reason: 'NO FETCH in this environment — the transcript cannot be requested at all.',
      }))
      return
    }

    try {
      const response = await impl(transcriptUrl(lane, offsetRef.current))
      const body = await response.json().catch(() => null)
      if (!liveRef.current) return
      setState((previous) => {
        const next = foldChunk(previous, body)
        offsetRef.current = next.offset
        return next
      })
    } catch (error) {
      if (!liveRef.current) return
      setState((previous) => ({
        ...previous,
        status: 'error',
        reason: `TRANSCRIPT UNREACHABLE — ${error instanceof Error ? error.message : String(error)} — is the Rhizomorph server still running?`,
      }))
    }
  }, [lane, fetchImpl])

  useEffect(() => {
    liveRef.current = true
    return () => {
      liveRef.current = false
    }
  }, [])

  useEffect(() => {
    if (lane === null) return
    void refresh()
    if (pollMs <= 0) return
    const timer = setInterval(() => void refresh(), pollMs)
    return () => clearInterval(timer)
  }, [lane, pollMs, refresh])

  return { ...state, refresh }
}
