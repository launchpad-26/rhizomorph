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

/**
 * How many forward pages one {@link useTranscript}'s `refresh` will chase in a
 * single eager burst before yielding to the next poll tick (#134). A backstop
 * against a pathological server that never reaches `eof`, not a number a
 * healthy tail should ever approach — one page is normal, a handful is a slow
 * poll cadence catching up, and the cap exists only so a bug elsewhere cannot
 * turn a single `refresh()` into an unbounded loop.
 */
const MAX_CATCHUP_PAGES = 64

export function transcriptUrl(lane: string, offset: number): string {
  return `/api/transcript/${encodeURIComponent(lane)}?offset=${offset}`
}

/** The tail-first open (#134): the newest page, plus where it started. */
export function transcriptTailUrl(lane: string): string {
  return `/api/transcript/${encodeURIComponent(lane)}?tail=1`
}

/** "Load earlier" — the page immediately before `before`. */
export function transcriptBeforeUrl(lane: string, before: number): string {
  return `/api/transcript/${encodeURIComponent(lane)}?before=${before}`
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
  /**
   * Byte offset the earliest loaded page started at (#134). `0` means the
   * loaded window already reaches the top of the log — there is no earlier
   * history to page into, and "load earlier" has nothing to do.
   */
  earliestOffset: number
  /** A "load earlier" request is in flight. */
  loadingEarlier: boolean
}

export const IDLE_TRANSCRIPT: TranscriptState = {
  status: 'idle',
  entries: [],
  reason: null,
  offset: 0,
  eof: true,
  size: 0,
  earliestOffset: 0,
  loadingEarlier: false,
}

interface ChunkBody {
  available?: unknown
  reason?: unknown
  entries?: unknown
  offset?: unknown
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
  const restarted = chunk.restarted === true
  const base = restarted ? [] : previous.entries
  // The very first page this hook has ever folded in — whether it arrived
  // via `tail=1` or a plain forward read — is where the loaded window's
  // earliest edge starts; a restart is the same thing, a fresh window on a
  // different log. Every later forward page just extends the same window
  // from its far end, so the earliest edge does not move.
  const firstWindow = previous.status !== 'ready' || restarted

  return {
    status: 'ready',
    entries: base.length === 0 ? entries : [...base, ...entries],
    reason: null,
    offset: asNumber(chunk.nextOffset, previous.offset),
    eof: chunk.eof === true,
    size: asNumber(chunk.size, previous.size),
    earliestOffset: firstWindow ? asNumber(chunk.offset, 0) : previous.earliestOffset,
    loadingEarlier: false,
  }
}

/**
 * A "load earlier" page, prepended to what is already loaded (#134) — the
 * mirror of {@link foldChunk}'s append, for history read backward instead of
 * forward. Never touches the forward cursor (`offset`/`eof`/`size`): paging
 * into history does not change where the tail's own follow loop resumes.
 */
export function foldEarlierChunk(previous: TranscriptState, body: unknown): TranscriptState {
  const chunk = (typeof body === 'object' && body !== null ? body : {}) as ChunkBody

  if (chunk.available !== true) return { ...previous, loadingEarlier: false }

  const entries = parseEntries(chunk.entries)
  return {
    ...previous,
    entries: [...entries, ...previous.entries],
    earliestOffset: asNumber(chunk.offset, previous.earliestOffset),
    loadingEarlier: false,
  }
}

export interface UseTranscriptOptions {
  /** Test seam. Defaults to the real `fetch`. */
  fetchImpl?: FetchLike
  /** Milliseconds between polls. `0` disables polling — one read, then still. */
  pollMs?: number
}

export interface TranscriptTail extends TranscriptState {
  /** Ask now, forward from where the tail left off. Returns once folded in. */
  refresh: () => Promise<void>
  /** Fetch the page immediately before what is loaded, and prepend it. */
  loadEarlier: () => Promise<void>
}

export function useTranscript(lane: string | null, options: UseTranscriptOptions = {}): TranscriptTail {
  const { fetchImpl, pollMs = TRANSCRIPT_POLL_MS } = options
  const [state, setState] = useState<TranscriptState>(IDLE_TRANSCRIPT)

  // The authoritative copy an in-flight call reads and folds against.
  // `setState`'s own updater is not safe for this: React does not guarantee
  // it runs before the next line, so a catch-up burst deciding "was that
  // `eof`?" from a variable closed over inside the updater can read a stale
  // default instead of the fold it just computed. This ref is written
  // synchronously, in the same statement as the fold, so `refresh`'s loop
  // condition is never guessing.
  const stateRef = useRef<TranscriptState>(IDLE_TRANSCRIPT)
  const liveRef = useRef(true)

  useEffect(() => {
    const next = lane === null ? IDLE_TRANSCRIPT : { ...IDLE_TRANSCRIPT, status: 'loading' as const }
    stateRef.current = next
    setState(next)
  }, [lane])

  const fetchJson = useCallback(
    async (url: string): Promise<unknown> => {
      const impl = fetchImpl ?? defaultFetch()
      if (impl === null) {
        throw new Error('NO FETCH in this environment — the transcript cannot be requested at all.')
      }
      const response = await impl(url)
      return response.json().catch(() => null)
    },
    [fetchImpl],
  )

  const fail = useCallback((error: unknown) => {
    if (!liveRef.current) return
    const next: TranscriptState = {
      ...stateRef.current,
      status: 'error',
      reason: `TRANSCRIPT UNREACHABLE — ${error instanceof Error ? error.message : String(error)} — is the Rhizomorph server still running?`,
    }
    stateRef.current = next
    setState(next)
  }, [])

  // The initial open, and every lane change: land on the newest page in one
  // round trip rather than chasing `nextOffset` up from byte zero (#134).
  const open = useCallback(async () => {
    if (lane === null) return
    try {
      const body = await fetchJson(transcriptTailUrl(lane))
      if (!liveRef.current) return
      const next = foldChunk(stateRef.current, body)
      stateRef.current = next
      setState(next)
    } catch (error) {
      fail(error)
    }
  }, [lane, fetchJson, fail])

  // Forward follow, eager rather than one-page-per-tick (#134): as long as the
  // server says there is more beyond the page just read, this asks again in
  // the same call instead of waiting for the next poll — a bounded, awaited
  // burst, never a multi-tick lag behind a bursty writer.
  const refresh = useCallback(async () => {
    if (lane === null) return
    for (let page = 0; page < MAX_CATCHUP_PAGES; page += 1) {
      let body: unknown
      try {
        body = await fetchJson(transcriptUrl(lane, stateRef.current.offset))
      } catch (error) {
        fail(error)
        return
      }
      if (!liveRef.current) return
      const next = foldChunk(stateRef.current, body)
      stateRef.current = next
      setState(next)
      if (next.eof) return
    }
  }, [lane, fetchJson, fail])

  // "Load earlier": the one page immediately before what is already loaded.
  const loadEarlier = useCallback(async () => {
    if (lane === null || stateRef.current.earliestOffset <= 0) return
    const loading = { ...stateRef.current, loadingEarlier: true }
    stateRef.current = loading
    setState(loading)
    try {
      const body = await fetchJson(transcriptBeforeUrl(lane, loading.earliestOffset))
      if (!liveRef.current) return
      const next = foldEarlierChunk(stateRef.current, body)
      stateRef.current = next
      setState(next)
    } catch (error) {
      fail(error)
    }
  }, [lane, fetchJson, fail])

  useEffect(() => {
    liveRef.current = true
    return () => {
      liveRef.current = false
    }
  }, [])

  useEffect(() => {
    if (lane === null) return
    void open()
    if (pollMs <= 0) return
    const timer = setInterval(() => void refresh(), pollMs)
    return () => clearInterval(timer)
  }, [lane, pollMs, open, refresh])

  return { ...state, refresh, loadEarlier }
}
