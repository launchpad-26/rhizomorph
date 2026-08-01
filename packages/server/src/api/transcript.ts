import { open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ObservatoryEvent } from '@observatory/core'
import type { FastifyInstance } from 'fastify'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/index.js'
import type { ServerContext } from '../server/context.js'

/**
 * THE TRANSCRIPT TAIL (prd3 ruling 17) — `GET /api/transcript/:lane?offset=N`.
 *
 * The read-only constitution is the whole shape of this file. There is exactly
 * one verb (GET), the only thing it ever opens is a session JSONL the
 * `sessionlog` collector is *already* tailing, and it opens it `'r'`. Nothing
 * here sends a key, writes a byte, or starts a process. The drawer can show an
 * operator what an agent said; making the agent say something is the terminal's
 * job, which is what the ATTACH button is for.
 *
 * **Discovery is not re-implemented.** The collector already resolved
 * "which lane is which session log" and wrote the answer onto every telemetry
 * event it emitted (`lane`, `sessionId`, `worktreePath`). This route reads that
 * answer back off the recorded log and maps it to a path with the collector's
 * own {@link worktreePathToProjectSlug}. If the collector could not attribute a
 * lane, neither can this route — and it says so rather than guessing.
 *
 * **Bounded reads, no watchers.** Each request reads at most
 * {@link TRANSCRIPT_CHUNK_BYTES} from `offset` and hands back where to resume.
 * A live tail is therefore the client asking again with `nextOffset` — no
 * `fs.watch`, no long-lived handle, no whole-file slurp. A day-old session log
 * is tens of megabytes; the endpoint that reads it must be the one thing in the
 * server that can never be surprised by its size.
 */

/** Most bytes one request will read. A tail is many small requests, not one big one. */
export const TRANSCRIPT_CHUNK_BYTES = 64 * 1024

const JSONL_SUFFIX = '.jsonl'

/** Telemetry events carry the collector's own lane→session attribution. */
const ATTRIBUTED_TYPES = new Set(['llm.usage', 'tool.activity', 'llm.cost'])

export interface TranscriptChunk {
  available: true
  lane: string
  sessionId: string
  /** Byte offset this chunk actually started at — not necessarily the one asked for. */
  offset: number
  /** Pass this back next time. Equal to `offset` when nothing new has landed. */
  nextOffset: number
  /** Current size of the session log, so a client can show how far behind it is. */
  size: number
  /** True when `nextOffset` has reached the end of the file as of this read. */
  eof: boolean
  /**
   * True when the log was shorter than the requested offset — it was rotated or
   * replaced, so this chunk restarts from zero. The client must reset, not
   * append: silently returning an empty chunk would leave a drawer stuck
   * forever on a session that had in fact begun again.
   */
  restarted: boolean
  /** The rendered transcript for this window, oldest first. */
  text: string
}

export interface TranscriptAbsent {
  available: false
  lane: string
  /** WHAT is missing → WHY → what to do (law 12). Never a bare "not found". */
  reason: string
}

export type TranscriptResult = TranscriptChunk | TranscriptAbsent

export interface TranscriptOptions {
  /**
   * Root of Claude Code's per-project session logs, matching the `sessionlog`
   * collector's own default. Tests point this at a fixture directory so they
   * never depend on (or read) the real one.
   */
  claudeProjectsRoot?: string
  /** Override the read cap. Tests use a tiny one to prove paging really pages. */
  chunkBytes?: number
}

function defaultClaudeProjectsRoot(): string {
  return path.join(homedir(), '.claude', 'projects')
}

// ── locating a lane's session log ────────────────────────────────────────────

interface Attribution {
  sessionId: string
  worktreePath: string | null
}

/**
 * The newest attribution the log carries for `lane`, or null when nothing in
 * the session ever named it. Matches on the payload's `lane` *or* its `branch`,
 * because a lane's id in the derived fleet is its branch when one is known —
 * so a drawer opened from the fleet table asks by branch, and the collector may
 * have recorded the handle.
 */
export function findLaneAttribution(
  events: readonly ObservatoryEvent[],
  lane: string,
): Attribution | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (!event || !ATTRIBUTED_TYPES.has(event.type)) continue

    const payload = event.payload as {
      lane?: unknown
      branch?: unknown
      sessionId?: unknown
      worktreePath?: unknown
    }
    if (payload.lane !== lane && payload.branch !== lane) continue
    if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) continue

    return {
      sessionId: payload.sessionId,
      worktreePath: typeof payload.worktreePath === 'string' ? payload.worktreePath : null,
    }
  }
  return null
}

/** True when the log mentions this lane at all, even without a session id. */
function laneIsKnown(events: readonly ObservatoryEvent[], lane: string): boolean {
  return events.some((event) => {
    const payload = event.payload as { lane?: unknown; branch?: unknown; path?: unknown }
    return payload.lane === lane || payload.branch === lane
  })
}

/**
 * Every place a lane's session file could be, in preference order — the same
 * two the collector itself tails: the slug-inferred project dir under
 * `~/.claude/projects`, and (for an `--extra-sessions` dir passed directly) the
 * declared directory itself.
 */
export function candidateTranscriptPaths(
  attribution: Attribution,
  claudeProjectsRoot: string,
): string[] {
  const fileName = `${attribution.sessionId}${JSONL_SUFFIX}`
  if (attribution.worktreePath === null) return []
  return [
    path.join(claudeProjectsRoot, worktreePathToProjectSlug(attribution.worktreePath), fileName),
    path.join(attribution.worktreePath, fileName),
  ]
}

// ── reading ──────────────────────────────────────────────────────────────────

interface RawChunk {
  offset: number
  nextOffset: number
  size: number
  restarted: boolean
  lines: string[]
}

/**
 * Reads at most `chunkBytes` of whole lines from `offset`.
 *
 * The collector's `readNewLines` is deliberately not reused here: it reads
 * everything from the offset to EOF, which is exactly right for a 2s poll that
 * is never far behind and exactly wrong for an endpoint a browser can call with
 * `offset=0` against a 40MB log. Both stop at the last newline for the same
 * reason — the bytes after it may be a line the agent is still writing.
 */
async function readBoundedLines(
  filePath: string,
  requestedOffset: number,
  chunkBytes: number,
): Promise<RawChunk> {
  const info = await stat(filePath)
  const size = info.size
  const restarted = requestedOffset > size
  const offset = restarted ? 0 : requestedOffset

  if (size <= offset) return { offset, nextOffset: offset, size, restarted, lines: [] }

  const length = Math.min(size - offset, chunkBytes)
  const buffer = Buffer.alloc(length)
  const handle = await open(filePath, 'r')
  try {
    await handle.read(buffer, 0, length, offset)
  } finally {
    await handle.close()
  }

  const text = buffer.toString('utf8')
  const lastNewline = text.lastIndexOf('\n')
  if (lastNewline === -1) {
    // A single line longer than the whole chunk. Advancing past it would be a
    // silent skip and staying put would be an infinite tail, so the window
    // grows for this one read rather than either.
    return readBoundedLines(filePath, offset, chunkBytes * 2)
  }

  const lines = text
    .slice(0, lastNewline)
    .split('\n')
    .filter((line) => line.length > 0)

  return { offset, nextOffset: offset + lastNewline + 1, size, restarted, lines }
}

// ── rendering ────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function blockText(block: Record<string, unknown>): string | null {
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  if (block.type === 'thinking') return null // never rendered: it is not what the agent said
  if (block.type === 'tool_use') {
    const name = typeof block.name === 'string' ? block.name : 'tool'
    return `⟨tool: ${name}⟩${toolHint(block.input)}`
  }
  if (block.type === 'tool_result') {
    const content = block.content
    if (typeof content === 'string') return `⟨result⟩ ${content}`
    if (Array.isArray(content)) {
      const parts = content
        .map((inner) => asRecord(inner))
        .map((inner) => (inner && typeof inner.text === 'string' ? inner.text : null))
        .filter((part): part is string => part !== null)
      return parts.length > 0 ? `⟨result⟩ ${parts.join('\n')}` : '⟨result⟩'
    }
    return '⟨result⟩'
  }
  return null
}

/** The one field of a tool's input worth putting on the same line as its name. */
const TOOL_HINT_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']

function toolHint(input: unknown): string {
  const record = asRecord(input)
  if (!record) return ''
  for (const key of TOOL_HINT_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return ` ${value.split('\n')[0]}`
  }
  return ''
}

function messageText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => asRecord(block))
    .map((block) => (block === null ? null : blockText(block)))
    .filter((part): part is string => part !== null && part.length > 0)
    .join('\n')
}

/**
 * One JSONL line → one rendered transcript block, or null for a line that says
 * nothing a reader wants (a summary record, a meta line, an empty turn).
 *
 * A line that will not parse is rendered rather than dropped. A transcript with
 * a visible `⟨unreadable line⟩` in it is a bug report; a transcript that
 * quietly omits the same line is a lie about what the agent said.
 */
export function renderTranscriptLine(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null

  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return '⟨unreadable line⟩'
  }

  const line = asRecord(value)
  if (!line) return '⟨unreadable line⟩'
  if (line.type !== 'user' && line.type !== 'assistant') return null

  const message = asRecord(line.message)
  if (!message) return null

  const body = messageText(message)
  if (body.length === 0) return null

  const speaker = line.isSidechain === true ? `${line.type} · subagent` : String(line.type)
  return `▌ ${speaker}\n${body}`
}

/**
 * A blank line *terminates* each block rather than joining pairs of them, which
 * is what makes the paging honest: chunk N+1 is appended to chunk N verbatim,
 * so a tail assembled from ten requests is byte-identical to the same log read
 * in one. A separator-between-blocks would lose exactly one blank line at every
 * chunk boundary.
 */
export function renderTranscript(lines: readonly string[]): string {
  return lines
    .map(renderTranscriptLine)
    .filter((block): block is string => block !== null)
    .map((block) => `${block}\n\n`)
    .join('')
}

// ── the read, end to end ─────────────────────────────────────────────────────

export interface ReadTranscriptRequest {
  events: readonly ObservatoryEvent[]
  lane: string
  offset: number
  claudeProjectsRoot: string
  chunkBytes?: number
}

export async function readTranscript(request: ReadTranscriptRequest): Promise<TranscriptResult> {
  const { events, lane, offset, claudeProjectsRoot } = request
  const chunkBytes = request.chunkBytes ?? TRANSCRIPT_CHUNK_BYTES

  const attribution = findLaneAttribution(events, lane)
  if (attribution === null) {
    return {
      available: false,
      lane,
      reason: laneIsKnown(events, lane)
        ? `NO SESSION LOG for "${lane}" — the log knows this lane but no session id was attributed to it, ` +
          'so its transcript cannot be located — only the sessionlog collector attributes one: ' +
          'run: `observatory doctor`'
        : `NO SUCH LANE "${lane}" — nothing in this session's event log names it, so there is no ` +
          'transcript to tail — run: `observatory doctor`',
    }
  }

  const candidates = candidateTranscriptPaths(attribution, claudeProjectsRoot)
  for (const filePath of candidates) {
    let chunk: RawChunk
    try {
      chunk = await readBoundedLines(filePath, offset, chunkBytes)
    } catch {
      continue // not this one — try the next candidate location
    }

    return {
      available: true,
      lane,
      sessionId: attribution.sessionId,
      offset: chunk.offset,
      nextOffset: chunk.nextOffset,
      size: chunk.size,
      eof: chunk.nextOffset >= chunk.size,
      restarted: chunk.restarted,
      text: renderTranscript(chunk.lines),
    }
  }

  const tried = candidates.length === 0 ? 'no worktree path was recorded for it' : candidates.join(' or ')
  return {
    available: false,
    lane,
    reason:
      `NO SESSION LOG for "${lane}" (session ${attribution.sessionId}) — the transcript is not on ` +
      `disk where the collector tails it (${tried}), so there is nothing to read — ` +
      'run: `observatory doctor`',
  }
}

// ── the route ────────────────────────────────────────────────────────────────

function parseOffset(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return 0
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) return null
  return value
}

/**
 * GET only, and that is load-bearing rather than incidental: an Observatory
 * that cannot be POSTed to cannot be talked through, which is the read-only
 * constitution stated in routing rather than in a comment. Every other verb on
 * this path 404s because it was never registered.
 */
export function registerTranscriptRoute(
  app: FastifyInstance,
  ctx: ServerContext,
  options: TranscriptOptions = {},
): void {
  const claudeProjectsRoot = options.claudeProjectsRoot ?? defaultClaudeProjectsRoot()

  app.get<{ Params: { lane: string }; Querystring: { offset?: string } }>(
    '/api/transcript/:lane',
    async (request, reply) => {
      const offset = parseOffset(request.query.offset)
      if (offset === null) {
        return reply
          .code(400)
          .send({ error: `offset must be a non-negative integer, got "${request.query.offset}"` })
      }

      const result = await readTranscript({
        events: ctx.recorder.eventsSoFar(),
        lane: request.params.lane,
        offset,
        claudeProjectsRoot,
        chunkBytes: options.chunkBytes,
      })

      if (!result.available) return reply.code(404).send(result)
      return result
    },
  )
}
