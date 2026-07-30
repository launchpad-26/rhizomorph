import type { FastifyInstance } from 'fastify'
import type { ServerContext } from '../server/context.js'

export function registerMetaRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/meta', async () => ({
    repoPath: ctx.repoPath,
    repoName: ctx.repoName,
    sessionId: ctx.recorder.sessionId,
    startedAt: Number(ctx.recorder.sessionId),
  }))
}
