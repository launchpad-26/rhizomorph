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

export interface TranscriptState {
  /**
   * `absent` is not an error: a lane with no session log on disk is an ordinary,
   * expected state (an OTel-only lane, a worktree with no agent in it), and it
   * carries the server's reason so the drawer can say what is missing and why.
   */
  status: 'idle' | 'loading' | 'ready' | 'absent' | 'error'
  text: string
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
  text: '',
  reason: null,
  offset: 0,
  eof: true,
  size: 0,
}

interface ChunkBody {
  available?: unknown
  reason?: unknown
  text?: unknown
  nextOffset?: unknown
  size?: unknown
  eof?: unknown
  restarted?: unknown
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
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
          : 'NO TRANSCRIPT — the server gave no reason, which is itself the bug — run: `observatory doctor`',
    }
  }

  const text = typeof chunk.text === 'string' ? chunk.text : ''
  // A restarted log is a different log: appending to it would splice two
  // sessions into one unreadable transcript.
  const base = chunk.restarted === true ? '' : previous.text

  return {
    status: 'ready',
    text: base + text,
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
  /** False while the transcript is collapsed: a closed panel must not poll. */
  enabled?: boolean
}

export interface TranscriptTail extends TranscriptState {
  /** Ask now. Returns when the request has been folded in. */
  refresh: () => Promise<void>
}

export function useTranscript(lane: string | null, options: UseTranscriptOptions = {}): TranscriptTail {
  const { fetchImpl, pollMs = TRANSCRIPT_POLL_MS, enabled = true } = options
  const [state, setState] = useState<TranscriptState>(IDLE_TRANSCRIPT)

  // The offset lives in a ref as well as in state so a poll can read the latest
  // one without the effect having to restart every time a chunk lands — a
  // resubscribing interval is how a two-second tail becomes a request storm.
  const offsetRef = useRef(0)
  const liveRef = useRef(true)

  useEffect(() => {
    offsetRef.current = 0
    setState(lane === null || !enabled ? IDLE_TRANSCRIPT : { ...IDLE_TRANSCRIPT, status: 'loading' })
  }, [lane, enabled])

  const refresh = useCallback(async () => {
    if (lane === null || !enabled) return
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
        reason: `TRANSCRIPT UNREACHABLE — ${error instanceof Error ? error.message : String(error)} — is the Observatory server still running?`,
      }))
    }
  }, [lane, enabled, fetchImpl])

  useEffect(() => {
    liveRef.current = true
    return () => {
      liveRef.current = false
    }
  }, [])

  useEffect(() => {
    if (lane === null || !enabled) return
    void refresh()
    if (pollMs <= 0) return
    const timer = setInterval(() => void refresh(), pollMs)
    return () => clearInterval(timer)
  }, [lane, enabled, pollMs, refresh])

  return { ...state, refresh }
}
