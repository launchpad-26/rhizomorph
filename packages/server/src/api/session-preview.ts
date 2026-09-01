import type { RhizomorphEvent } from '@rhizomorph/core'
import type { FastifyInstance } from 'fastify'
import { defaultClaudeProjectsRoot } from '../log/paths.js'
import {
  candidateTranscriptPaths,
  findSessionAttribution,
  isSafeSessionId,
} from '../log/transcript-attribution.js'
import type { ServerContext } from '../server/context.js'
import { requireCapabilityToken } from './security.js'
import { parseTranscript, readBoundedLines, type TranscriptEntry } from './transcript.js'

/**
 * `GET /api/session-preview/:sessionId` (prd20 w6) — gated (prd-29 ruling 7 /
 * #58): carries `requireCapabilityToken` as a route-local `preHandler`,
 * exactly as the rest of wave 1's reads do. It answers only the capability
 * token's holder, superseding the #216 "untokened, like `/api/doctor`"
 * posture this route carried before `gated-read` existed. A session id off
 * the wire is NEVER built into a path without first passing
 * {@link isSafeSessionId} — the same shape gate `transcript-attribution.ts`
 * applies everywhere a session id meets a filesystem — and the file this
 * route reads is located the same way
 * the transcript tail does: `findSessionAttribution` (this session id's own
 * newest-wins attribution) into `candidateTranscriptPaths` (the two places the
 * collector itself tails).
 *
 * The read itself is deliberately small: one bounded head chunk
 * (`readBoundedLines` from `offset` 0), not a whole-file slurp. A drawer that
 * wants a session's first words does not need the rest of it, and a session
 * log can be tens of megabytes.
 */

/** Most characters of the first user message this route will ever return. */
export const PREVIEW_MAX_CHARS = 280

/** How much of the transcript's head this route reads to find the first user turn. */
export const SESSION_PREVIEW_HEAD_BYTES = 8 * 1024

export interface SessionPreviewFirstMessage {
  /** At most {@link PREVIEW_MAX_CHARS}. */
  text: string
  /** Characters cut from the full first user message. `0` when it all fit. */
  dropped: number
  ts?: string
}

export interface SessionPreviewAvailable {
  available: true
  sessionId: string
  place: { worktreePath: string | null; branch: string | null }
  /** `null` only when the head chunk holds no user turn with text — not proof there never was one. */
  firstUserMessage: SessionPreviewFirstMessage | null
}

export interface SessionPreviewUnavailable {
  available: false
  sessionId: string
  /** WHAT is missing → WHY → what to do (law 12). */
  reason: string
  /**
   * True only when nothing in this session's event log ever attributed this
   * session id — the `/api/lanes` convention: a known identity with nothing
   * to show yet is an honest 200, only a genuinely unknown identifier is a
   * 404. Not sent on the wire.
   */
  unknownSessionId: boolean
}

export type SessionPreviewResult = SessionPreviewAvailable | SessionPreviewUnavailable

export interface SessionPreviewRequest {
  events: readonly RhizomorphEvent[]
  sessionId: string
  claudeProjectsRoot: string
  /** Override the head-read cap. Tests use a tiny one to prove the read is bounded. */
  chunkBytes?: number
}

function unknownSessionGap(sessionId: string): string {
  return (
    `NO SUCH SESSION ${JSON.stringify(sessionId)} — nothing in this session's event log ever ` +
    'attributed it, so there is no place to read a preview from — run: `rhizomorph doctor`'
  )
}

function vanishedGap(sessionId: string, tried: readonly string[]): string {
  const where = tried.length === 0 ? 'no worktree path was recorded for it' : tried.join(' or ')
  return (
    `NO TRANSCRIPT for session ${JSON.stringify(sessionId)} — the file is not on disk where the ` +
    `collector tails it (${where}), so there is no preview to read — run: \`rhizomorph doctor\``
  )
}

/** The first `role: 'user'` entry carrying text, capped, or `null` if none is in `entries`. */
function firstUserPreview(entries: readonly TranscriptEntry[]): SessionPreviewFirstMessage | null {
  for (const entry of entries) {
    if (entry.role !== 'user') continue
    const text = entry.blocks
      .filter((block) => block.kind === 'text')
      .map((block) => block.text)
      .join('\n')
    if (text.length === 0) continue

    const capped = text.length > PREVIEW_MAX_CHARS ? text.slice(0, PREVIEW_MAX_CHARS) : text
    const dropped = Math.max(0, text.length - PREVIEW_MAX_CHARS)
    return entry.ts === undefined ? { text: capped, dropped } : { text: capped, dropped, ts: entry.ts }
  }
  return null
}

/**
 * `isSafeSessionId` must be checked by the caller before this is reached
 * (`registerSessionPreviewRoute` does, as a request-shape 400 — mirroring
 * `transcript.ts`'s `parseOffset`/`parseBefore`) — the id is otherwise trusted
 * to reach a path only through {@link findSessionAttribution} and
 * {@link candidateTranscriptPaths}, both of which re-check it themselves.
 */
export async function previewSession(request: SessionPreviewRequest): Promise<SessionPreviewResult> {
  const { events, sessionId, claudeProjectsRoot } = request
  const chunkBytes = request.chunkBytes ?? SESSION_PREVIEW_HEAD_BYTES

  const attribution = findSessionAttribution(events, sessionId)
  if (attribution === null) {
    return { available: false, sessionId, reason: unknownSessionGap(sessionId), unknownSessionId: true }
  }

  const candidates = candidateTranscriptPaths(attribution, claudeProjectsRoot)
  for (const filePath of candidates) {
    let lines: string[]
    try {
      lines = (await readBoundedLines(filePath, 0, chunkBytes)).lines
    } catch {
      continue // not this one — try the next candidate location
    }

    return {
      available: true,
      sessionId,
      place: { worktreePath: attribution.worktreePath, branch: attribution.branch },
      firstUserMessage: firstUserPreview(parseTranscript(lines)),
    }
  }

  return {
    available: false,
    sessionId,
    reason: vanishedGap(sessionId, candidates),
    unknownSessionId: false,
  }
}

/**
 * `isSafeSessionId` alone admits `.` and `..` (`path.basename` returns each
 * unchanged) and the empty string (`path.basename('') === ''`) — the same gap
 * `concierge/paths.ts`'s `assertMigrationPaths` names and closes for its own
 * fence (`isSafeSessionId` — the shared shape check — admits both dot ids).
 * This route's request-shape gate closes it the same way, before the id ever
 * reaches `findSessionAttribution` or a path.
 */
export function isValidSessionIdParam(sessionId: string): boolean {
  return sessionId.length > 0 && sessionId !== '.' && sessionId !== '..' && isSafeSessionId(sessionId)
}

export interface SessionPreviewOptions {
  claudeProjectsRoot?: string
  chunkBytes?: number
}

export function registerSessionPreviewRoute(
  app: FastifyInstance,
  ctx: ServerContext,
  options: SessionPreviewOptions = {},
): void {
  const claudeProjectsRoot = options.claudeProjectsRoot ?? defaultClaudeProjectsRoot()

  app.get<{ Params: { sessionId: string } }>(
    '/api/session-preview/:sessionId',
    { preHandler: requireCapabilityToken(ctx.capabilityToken ?? '') },
    async (request, reply) => {
      const { sessionId } = request.params

      // Checked before anything else touches the event log or a filesystem —
      // a traversal-shaped id is refused here and never built into a path.
      if (!isValidSessionIdParam(sessionId)) {
        return reply.code(400).send({ error: `sessionId is not a valid identifier: ${JSON.stringify(sessionId)}` })
      }

      const result = await previewSession({
        events: ctx.recorder.eventsSoFar(),
        sessionId,
        claudeProjectsRoot,
        chunkBytes: options.chunkBytes,
      })

      if (!result.available) {
        const { available, sessionId: id, reason } = result
        return reply.code(result.unknownSessionId ? 404 : 200).send({ available, sessionId: id, reason })
      }
      return result
    },
  )
}
