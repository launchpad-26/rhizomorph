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
 *
 * **Records, not a rendered string (prd4 ruling 4).** The drawer's main view is
 * now the conversation itself, styled the way an agent CLI shows it — so the
 * endpoint hands back turns and blocks and lets the client decide what a tool
 * call *looks* like. Shipping a pre-formatted `▌ assistant\n…` string forced
 * every presentation decision (which face, how quiet, how truncated) into this
 * file, where a stylesheet cannot reach it.
 */

/** Most bytes one request will read. A tail is many small requests, not one big one. */
export const TRANSCRIPT_CHUNK_BYTES = 64 * 1024

/**
 * How much of a tool result travels. A `Read` of a 2,000-line file is a
 * legitimate result and a useless thing to send to a drawer: the reader wants
 * to see *that* the tool answered and roughly what it said. The cut is made
 * here rather than in CSS because the bytes are the cost, and it is always
 * declared — {@link TranscriptToolResult.dropped} says how much was left
 * behind, so the client can show a cut rather than pretend a whole answer.
 */
export const TOOL_RESULT_MAX_CHARS = 400

const JSONL_SUFFIX = '.jsonl'

/** Telemetry events carry the collector's own lane→session attribution. */
const ATTRIBUTED_TYPES = new Set(['llm.usage', 'tool.activity', 'llm.cost'])

/**
 * Whose voice a turn is.
 *
 * `subagent` is the sidechain mapping the flat renderer used to spell
 * `assistant · subagent`: a lane's Task subagents write into the same log, and
 * a reader must be able to tell the lane's own voice from a delegate's without
 * reading the words. `system` is not a voice from the log at all — it is this
 * parser speaking, and the only thing it ever says is that a line was
 * unreadable (see {@link parseTranscriptEntry}).
 */
export type TranscriptRole = 'user' | 'assistant' | 'subagent' | 'system'

/** Prose — what was actually said. Thinking blocks never become one of these. */
export interface TranscriptText {
  kind: 'text'
  text: string
}

/** A tool call, reduced to the two things a reader scanning a session wants. */
export interface TranscriptToolUse {
  kind: 'tool_use'
  name: string
  /** The one input field worth putting on the line, or `''` when none is. */
  hint: string
}

export interface TranscriptToolResult {
  kind: 'tool_result'
  /** At most {@link TOOL_RESULT_MAX_CHARS}. */
  text: string
  /** Characters cut from `text`. `0` when the whole result is here. */
  dropped: number
}

export type TranscriptBlock = TranscriptText | TranscriptToolUse | TranscriptToolResult

export interface TranscriptEntry {
  /** The log's own ISO timestamp, when the line carried one. */
  ts?: string
  role: TranscriptRole
  /** Never empty — an entry with nothing to show is not emitted at all. */
  blocks: TranscriptBlock[]
}

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
  /**
   * The turns in this window, oldest first. Chunk N+1's entries append to
   * chunk N's, so a tail assembled from ten requests is the same array as the
   * whole log read at once — the paging is honest because a turn never straddles
   * a chunk boundary (a read stops at the last newline, and one line is one
   * turn).
   */
  entries: TranscriptEntry[]
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

// ── parsing ──────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/** The unreadable-line marker, in the parser's own voice (`system`). */
const UNREADABLE = '⟨unreadable line⟩'

function unreadable(): TranscriptEntry {
  return { role: 'system', blocks: [{ kind: 'text', text: UNREADABLE }] }
}

function parseBlock(block: Record<string, unknown>): TranscriptBlock | null {
  if (block.type === 'text') {
    return typeof block.text === 'string' && block.text.length > 0
      ? { kind: 'text', text: block.text }
      : null
  }
  // Thinking is never emitted: it is not what the agent said, and a drawer that
  // showed it would be showing the operator a draft as if it were speech.
  if (block.type === 'thinking') return null
  if (block.type === 'tool_use') {
    return {
      kind: 'tool_use',
      name: typeof block.name === 'string' && block.name.length > 0 ? block.name : 'tool',
      hint: toolHint(block.input),
    }
  }
  if (block.type === 'tool_result') return truncateResult(resultText(block.content))
  return null
}

/** Every shape a tool result's content arrives in, flattened to its text. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((inner) => asRecord(inner))
    .map((inner) => (inner !== null && typeof inner.text === 'string' ? inner.text : null))
    .filter((part): part is string => part !== null)
    .join('\n')
}

function truncateResult(text: string): TranscriptToolResult {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return { kind: 'tool_result', text, dropped: 0 }
  return {
    kind: 'tool_result',
    text: text.slice(0, TOOL_RESULT_MAX_CHARS),
    dropped: text.length - TOOL_RESULT_MAX_CHARS,
  }
}

/** The one field of a tool's input worth putting on the same line as its name. */
const TOOL_HINT_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']

function toolHint(input: unknown): string {
  const record = asRecord(input)
  if (!record) return ''
  for (const key of TOOL_HINT_KEYS) {
    const value = record[key]
    // First line only: a heredoc'd shell command is a paragraph, and the hint
    // shares a line with the tool's name.
    if (typeof value === 'string' && value.length > 0) return value.split('\n')[0] ?? ''
  }
  return ''
}

function messageBlocks(message: Record<string, unknown>): TranscriptBlock[] {
  const content = message.content
  // A plain-string content is the ordinary shape of a typed prompt.
  if (typeof content === 'string') {
    return content.length > 0 ? [{ kind: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []
  return content
    .map((block) => asRecord(block))
    .map((block) => (block === null ? null : parseBlock(block)))
    .filter((block): block is TranscriptBlock => block !== null)
}

/**
 * One JSONL line → one turn, or null for a line that says nothing a reader
 * wants (a summary record, a meta line, an empty turn).
 *
 * A line that will not parse becomes a visible `system` entry rather than
 * disappearing. A conversation with `⟨unreadable line⟩` in it is a bug report;
 * a conversation that quietly omits the same line is a lie about what the agent
 * said.
 */
export function parseTranscriptEntry(raw: string): TranscriptEntry | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null

  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return unreadable()
  }

  const line = asRecord(value)
  if (!line) return unreadable()
  if (line.type !== 'user' && line.type !== 'assistant') return null

  const message = asRecord(line.message)
  if (!message) return null

  const blocks = messageBlocks(message)
  if (blocks.length === 0) return null

  const role: TranscriptRole = line.isSidechain === true ? 'subagent' : line.type
  const ts = typeof line.timestamp === 'string' && line.timestamp.length > 0 ? line.timestamp : null
  return ts === null ? { role, blocks } : { ts, role, blocks }
}

/** The window's turns, oldest first. One line in, at most one turn out. */
export function parseTranscript(lines: readonly string[]): TranscriptEntry[] {
  return lines
    .map(parseTranscriptEntry)
    .filter((entry): entry is TranscriptEntry => entry !== null)
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
      entries: parseTranscript(chunk.lines),
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
