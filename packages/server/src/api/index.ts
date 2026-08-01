import type { FastifyInstance } from 'fastify'
import type { ServerContext } from '../server/context.js'
import { registerLanesRoute } from './lanes.js'
import { registerMetaRoute } from './meta.js'
import { registerOtelRoutes } from './otel.js'
import { registerSessionsRoutes } from './sessions.js'
import { registerStreamRoute } from './stream.js'
import { registerTranscriptRoute } from './transcript.js'

export function registerApiRoutes(app: FastifyInstance, ctx: ServerContext): void {
  registerMetaRoute(app, ctx)
  registerSessionsRoutes(app, ctx)
  registerStreamRoute(app, ctx)
  registerOtelRoutes(app, ctx)
  registerLanesRoute(app, ctx)
  registerTranscriptRoute(app, ctx)
}
