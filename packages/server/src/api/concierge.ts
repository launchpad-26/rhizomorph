import type { FastifyInstance } from 'fastify'
import { discoverRepos } from '../concierge/repos.js'
import type { ServerContext } from '../server/context.js'

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
 */
export function registerConciergeReposRoute(app: FastifyInstance, _ctx: ServerContext): void {
  app.get('/api/concierge/repos', async () => discoverRepos())
}
