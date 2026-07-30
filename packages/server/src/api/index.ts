import type { FastifyInstance } from 'fastify'
import type { ServerContext } from '../server/context.js'
import { registerMetaRoute } from './meta.js'
import { registerSessionsRoutes } from './sessions.js'
import { registerStreamRoute } from './stream.js'

export function registerApiRoutes(app: FastifyInstance, ctx: ServerContext): void {
  registerMetaRoute(app, ctx)
  registerSessionsRoutes(app, ctx)
  registerStreamRoute(app, ctx)
}
