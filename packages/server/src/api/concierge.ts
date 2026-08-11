import type { FastifyInstance } from 'fastify'
import { type DiscoverReposResult, discoverRepos } from '../concierge/repos.js'
import type { ServerContext } from '../server/context.js'

/**
 * The one thing this route can answer with when it should not run
 * `discoverRepos` at all — see `registerConciergeReposRoute`'s own doc for
 * when that is. Shaped like `KnownProjectsResult`'s own `available` field
 * (an established idiom in this module's family of types) but at the OUTER
 * level: `available: true` carries the real `known`/`scanned` payload,
 * `available: false` means discovery never ran, with a reason.
 */
export type ConciergeReposResponse = ({ available: true } & DiscoverReposResult) | { available: false; reason: string }

/**
 * `GET /api/concierge/repos` — prd-20 ruling 5's read-only repo picker feed:
 * the repos the user's own Claude already knows (`~/.claude/projects`,
 * slug reversed honestly) plus a shallow, bounded scan of common roots. No
 * body, no token — the read-only half of the fourth hand, the same posture
 * as `GET /api/lanes` and `GET /api/doctor`.
 *
 * `discoverRepos` reads the real machine by default; nothing here threads a
 * fixture through, because this route is the ONLY declared importer the
 * concierge namespace law allows (prd-20 ruling 1 / ADR-0014) and
 * `ServerContext` is not this fence's to extend with a test seam.
 *
 * A replay server (`ctx.readOnly`, `rhizomorph replay`) never runs the scan
 * at all — labeled not-applicable, the same posture `api/doctor.ts` takes
 * for its own replay-meaningless checks, not `api/label.ts`'s outright
 * refusal. The two sibling shapes answer different questions: `label.ts`
 * refuses because the write it was asked for has nowhere durable to land in
 * that mode — a real failure. This route asks for nothing durable; the
 * *read* would still succeed and would still be true, since discovery never
 * touches `ctx.repoPath`/`ctx.sessionDir` (the two fields replay repoints) at
 * all — it reads the REAL machine's home directory regardless. The reason to
 * skip it anyway is what it would mean, not whether it would work: replaying
 * a finished, possibly-shared session record is not "set up a new
 * conductor" — the setup wizard this feeds is not shown during a replay —
 * and a replay server quietly fingerprinting whoever's machine happens to be
 * running it, in answer to an unauthenticated GET nothing in that mode ever
 * asked for, is not this route's business to do just because it technically
 * could.
 */
export function registerConciergeReposRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/concierge/repos', async (): Promise<ConciergeReposResponse> => {
    if (ctx.readOnly === true) {
      return {
        available: false,
        reason:
          'not applicable — this server is replaying a finished session record, not watching a live repo, ' +
          'and the setup wizard this feeds is never shown during a replay',
      }
    }
    const result = await discoverRepos()
    return { available: true, ...result }
  })
}
