import type { FastifyInstance } from 'fastify'
import { findLaneInIndex, readLaneIndex, type LaneIndex, type LaneIndexEntry } from '../log/lane-index.js'
import type { ServerContext } from '../server/context.js'
import { requireCapabilityToken } from './security.js'

/**
 * THE LANE INDEX ROUTES (prd-31 ruling 5 · #556) — the read that makes
 * `/lane/:handle` survive the lane.
 *
 * Two routes, and the second one is the reason for the first's shape:
 *
 * - `GET /api/lane-index` — every lane every recording in this repo's session
 *   directory has ever named, with the sessions each spans. The lane axis of
 *   ruling 8's history surface reads this.
 * - `GET /api/lane-index/:handle` — one lane, resolved by handle, branch,
 *   worktree basename or issue number. A handle nothing matches is a **404 that
 *   says what was searched** (S2's *unknown handle* state) rather than a bare
 *   "not found": the reader's next move depends entirely on whether the index
 *   held two lanes or two hundred.
 *
 * **Reads, both of them, and reads of the log alone.** Nothing here opens a
 * worktree — see `log/lane-index.ts`'s own note for why that is structural and
 * not a convention. The read-only constitution is unchanged: `GET` is the only
 * verb either path answers to, and every other verb 404s because it was never
 * registered.
 *
 * **A full parse per recording, deliberately.** Same trade `/api/sessions`
 * already makes and for the same reason (`listSessionListings`' own doc): this
 * is fetched once per run-view open, never on a poll, and a lane's life can
 * begin anywhere in a session's timeline — a head/tail sample would silently
 * drop the middle of it, which is exactly the fact the index exists to hold.
 */

/** WHAT was asked → WHY there is no answer → what the index does hold (law 12). */
export function unknownLaneReason(handle: string, index: LaneIndex): string {
  const count = index.lanes.length
  const held = count === 0 ? 'the index holds no lanes at all' : `the index holds ${count === 1 ? '1 lane' : `${count} lanes`}`
  const unreadable =
    index.unreadableSessionIds.length === 0
      ? ''
      : ` — ${index.unreadableSessionIds.length} recording(s) could not be read (${index.unreadableSessionIds.join(', ')}), so it may have run in one of those`
  return (
    `NO LANE "${handle}" IN ANY RECORDING — searched every lane handle, branch, worktree name and ` +
    `issue number in this repo's session directory and none of them is it; ${held}${unreadable}`
  )
}

export interface LaneIndexEntryResponse {
  lane: LaneIndexEntry
  /** Carried alongside the lane so a reader is told the index itself is partial. */
  unreadableSessionIds: string[]
}

export function registerLaneIndexRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const read = async (): Promise<LaneIndex> =>
    readLaneIndex(ctx.sessionDir, {
      // The still-open session is read from the recorder's buffer, never from
      // the file it is mid-append to — the same rule `/api/sessions` follows.
      liveSessionId: ctx.recorder.sessionId,
      liveEvents: ctx.recorder.eventsSoFar(),
    })

  app.get('/api/lane-index', { preHandler: requireCapabilityToken(ctx.capabilityToken ?? '') }, async () => read())

  app.get<{ Params: { handle: string } }>(
    '/api/lane-index/:handle',
    { preHandler: requireCapabilityToken(ctx.capabilityToken ?? '') },
    async (request, reply) => {
      const index = await read()
      const lane = findLaneInIndex(index, request.params.handle)
      if (lane === null) {
        return reply.code(404).send({ error: unknownLaneReason(request.params.handle, index) })
      }
      const body: LaneIndexEntryResponse = { lane, unreadableSessionIds: index.unreadableSessionIds }
      return body
    },
  )
}
